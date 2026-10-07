import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, UNSAFE_PATH: 3, SOURCE_CHANGED: 4, INTEGRITY: 5, UNSUPPORTED: 6, IO: 7, NOT_READY: 8 })
export class DataError extends Error {
  constructor(kind, message, details = {}) { super(message); this.name = 'DataError'; this.kind = kind; this.exitCode = EXIT[kind] ?? EXIT.IO; this.details = details }
}
const fail = (kind, message, details) => { throw new DataError(kind, message, details) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const stable = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $integer: String(v) } : v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
const digest = value => sha(stable(value))
const isWithin = (root, path) => path === root || path.startsWith(root + sep)
const safeRelative = path => typeof path === 'string' && path !== '' && !path.includes('\\') && !path.includes('\0') && !isAbsolute(path) && path.split('/').every(p => p !== '' && p !== '.' && p !== '..')
const versions = Object.freeze({ workspace: 2, pkw: 1, pkw_notes: 3, pkw_attachments: 1, pkw_tasks: 1, pkw_weknora_sync: 3 })
const tableNames = Object.freeze({ workspace: ['workspaces'], pkw: ['commits'], pkw_notes: ['note_index', 'note_paths', 'note_order', 'folder_trash'], pkw_attachments: ['attachments'], pkw_tasks: ['tasks', 'matrices'], pkw_weknora_sync: ['intents', 'mappings', 'dirty', 'reverse', 'processing', 'processing_kb'] })
const metadata = st => ({ size: String(st.size), mode: Number(st.mode & 0o777n), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), dev: String(st.dev), ino: String(st.ino) })

async function fileHash(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = metadata(await file.stat({ bigint: true }))
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    if (stable(before) !== stable(metadata(await file.stat({ bigint: true })))) fail('SOURCE_CHANGED', 'File changed while reading', { path })
    return { ...before, sha256: hash.digest('hex') }
  } finally { await file.close() }
}

// Never follows links, opens databases or invokes a storage backend on the source.
export async function inventory(path) {
  const entries = []
  async function visit(full, rel) {
    const st = await lstat(full, { bigint: true })
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) fail('UNSUPPORTED', 'Symlinks and special files require an explicit preservation adapter', { path: full })
    const entry = { path: rel, type: st.isDirectory() ? 'directory' : 'file', ...metadata(st) }
    if (st.isFile()) Object.assign(entry, await fileHash(full))
    entries.push(entry)
    if (st.isDirectory()) for (const name of (await readdir(full)).sort()) await visit(join(full, name), rel ? `${rel}/${name}` : name)
  }
  await visit(path, '')
  return { entries, fingerprint: digest(entries) }
}

async function absoluteSource(path, kind) {
  if (!path || !isAbsolute(path)) fail('USAGE', `${kind} must be an absolute path`)
  const actual = await realpath(path)
  if (actual !== resolve(path)) fail('UNSAFE_PATH', 'Source path may not traverse symlinks', { path })
  const st = await lstat(actual)
  if (kind === 'workspace' && !st.isDirectory()) fail('USAGE', 'workspace must be a directory')
  return { path: actual, kind: st.isDirectory() ? 'directory' : 'file', basename: basename(actual), ...(kind === 'state' && st.isFile() && await header(actual) === 'SQLite format 3\0' ? { sqliteBundle: true } : {}) }
}
async function sources(options) {
  const workspace = await absoluteSource(options.workspace, 'workspace')
  const state = await absoluteSource(options.state, 'state')
  if (isWithin(workspace.path, state.path) || isWithin(state.path, workspace.path)) fail('UNSUPPORTED', 'workspace and state must not overlap; no files were changed')
  return { workspace, state }
}
async function sqliteBundleInventory(source) {
  // A virtual root deliberately excludes the containing directory metadata:
  // the sibling workspace/output is outside this database bundle.
  const entries = [{ path: '', type: 'directory', size: '0', mode: 0o700, mtimeNs: '0', ctimeNs: '0', dev: '0', ino: '0' }]
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    try {
      const item = await inventory(source.path + suffix)
      if (item.entries.length !== 1 || item.entries[0].type !== 'file') fail('UNSUPPORTED', 'SQLite bundle members must be ordinary files')
      entries.push({ ...item.entries[0], path: source.basename + suffix })
    } catch (error) { if (error.code !== 'ENOENT' || suffix === '') throw error }
  }
  return { entries, fingerprint: digest(entries) }
}
const stateIsSingleFile = source => source.kind === 'file' && source.sqliteBundle !== true
async function scanSources(source) {
  return Object.fromEntries(await Promise.all(Object.entries(source).map(async ([name, root]) => [name, root.sqliteBundle ? await sqliteBundleInventory(root) : await inventory(root.path)])))
}
async function assertUnchanged(source, before) {
  let after
  try { after = await scanSources(source) } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('SOURCE_CHANGED', 'Source disappeared during capture'); throw error }
  const changed = Object.keys(before).filter(name => before[name].fingerprint !== after[name].fingerprint)
  if (changed.length) fail('SOURCE_CHANGED', 'Source changed. Stop every writer and create a fresh backup; this snapshot cannot be used for cutover.', { changed })
}
async function destination(path, forbidden) {
  if (!path || !isAbsolute(path)) fail('USAGE', 'Destination must be an absolute, new directory')
  path = resolve(path)
  const parent = await realpath(dirname(path))
  if (parent !== dirname(path)) fail('UNSAFE_PATH', 'Destination parent may not traverse symlinks')
  if (forbidden.some(root => isWithin(root, path) || isWithin(path, root))) fail('UNSAFE_PATH', 'Destination overlaps a source or backup')
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') fail('UNSAFE_PATH', 'Destination already exists; even empty directories are never overwritten', { path })
    throw error
  }
  return path
}
async function syncFile(path) { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function syncDirs(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await syncDirs(join(root, entry.name))
  await syncFile(root)
}
async function copyTree(source, target, snapshot) {
  for (const entry of snapshot.entries) {
    const from = entry.path ? join(source, entry.path) : source
    const to = entry.path ? join(target, entry.path) : target
    if (entry.type === 'directory') await mkdir(to, { mode: 0o700 })
    else { await copyFile(from, to, constants.COPYFILE_EXCL); await chmod(to, 0o600); await syncFile(to) }
  }

}
const contentEntries = snapshot => snapshot.entries.map(({ path, type, sha256, size }) => ({ path, type, ...(type === 'file' ? { sha256, size } : {}) }))
async function verifyCopied(sourceSnapshot, path) {
  if (stable(contentEntries(sourceSnapshot)) !== stable(contentEntries(await inventory(path)))) fail('INTEGRITY', 'Copied file inventory differs from source snapshot')
}
async function sqliteApi() {
  try {
    const api = await import('node:sqlite')
    if (!api.backup) fail('UNSUPPORTED', 'Node with node:sqlite backup is required (Node 22.16+ or 24+)')
    return api
  } catch (error) { if (error instanceof DataError) throw error; fail('UNSUPPORTED', 'node:sqlite is unavailable (use Node 22.16+ or 24+)') }
}
const quote = name => `"${name.replaceAll('"', '""')}"`
function sqliteRead(db) {
  const check = db.prepare('PRAGMA integrity_check').all()
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') fail('INTEGRITY', 'SQLite integrity_check failed')
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeys.length) fail('INTEGRITY', 'SQLite foreign_key_check failed', { violations: foreignKeys.length })
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
  const tables = []
  const records = new Map()
  for (const item of schema.filter(item => item.type === 'table')) {
    const statement = db.prepare(`SELECT * FROM ${quote(item.name)}`)
    statement.setReadBigInts(true)
    statement.setReturnArrays(true)
    const columns = statement.columns().map(column => column.name)
    const rowHashes = []
    const kv = []
    for (const values of statement.iterate()) {
      rowHashes.push(digest(values))
      if (columns.length === 2 && columns[0] === 'key' && columns[1] === 'value') kv.push(values)
    }
    tables.push({ name: item.name, columns, rows: rowHashes.length, sha256: digest(rowHashes.sort()) })
    if (columns.length === 2 && columns[0] === 'key' && columns[1] === 'value') records.set(item.name, kv)
  }
  const userVersion = Number(Object.values(db.prepare('PRAGMA user_version').get())[0])
  let units = []
  const unitTable = tables.find(table => table.name === 'units')
  if (unitTable?.columns.join(',') === 'name,version') units = db.prepare('SELECT name,version FROM units ORDER BY name').all()
  const summary = { userVersion, schema, tables, units, integrity: 'ok', foreignKeys: 'ok' }
  const globalTable = tables.find(table => table.name === 'unit_globals')
  const globals = globalTable?.columns.join(',') === 'unit,value' ? db.prepare('SELECT unit,value FROM unit_globals ORDER BY unit').all() : []
  return { summary: { ...summary, logicalSha256: digest(summary) }, records, globals }
}
async function readSqlite(path) {
  const { DatabaseSync } = await sqliteApi()
  const db = new DatabaseSync(path, { readOnly: true })
  try { return sqliteRead(db) } catch (error) { if (error instanceof DataError) throw error; fail('INTEGRITY', 'SQLite could not be read or validated', { code: error.code ?? null }) } finally { db.close() }
}
async function sqliteSnapshot(rawPath, output, scratch) {
  const { DatabaseSync, backup } = await sqliteApi()
  const working = join(scratch, 'database.sqlite')
  await copyFile(rawPath, working, constants.COPYFILE_EXCL)
  for (const suffix of ['-wal', '-journal']) {
    try { await copyFile(rawPath + suffix, working + suffix, constants.COPYFILE_EXCL) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const db = new DatabaseSync(working, { readOnly: true })
  let before
  try { before = sqliteRead(db); await backup(db, output) } catch (error) { if (error instanceof DataError) throw error; fail('INTEGRITY', 'SQLite snapshot failed; source was not modified', { code: error.code ?? null }) } finally { db.close() }
  // Make the isolated snapshot self-contained; never change source journal mode.
  const normalized = new DatabaseSync(output)
  try { normalized.exec('PRAGMA journal_mode=DELETE') } finally { normalized.close() }
  await chmod(output, 0o600)
  await syncFile(output)
  const after = await readSqlite(output)
  if (before.summary.logicalSha256 !== after.summary.logicalSha256) fail('INTEGRITY', 'SQLite snapshot changed logical records or schema')
  return after
}
async function header(path) { const file = await open(path, 'r'); try { const bytes = Buffer.alloc(16); const { bytesRead } = await file.read(bytes, 0, 16, 0); return bytes.subarray(0, bytesRead).toString('binary') } finally { await file.close() } }
function unitData(name, version, tables, location, issues, global) {
  const units = []
  if (typeof name !== 'string' || !Number.isInteger(version) || !tables || typeof tables !== 'object' || Array.isArray(tables)) {
    issues.push({ code: 'UNKNOWN_STATE_FORMAT', location }); return units
  }
  const output = { name, version, location, global, tables: Object.create(null) }
  for (const [table, rows] of Object.entries(tables)) {
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) { issues.push({ code: 'INVALID_TABLE_FORMAT', location, table }); continue }
    output.tables[table] = Object.entries(rows)
  }
  units.push(output)
  return units
}
async function stateData(root, stateSource, sourceInventory, sqlite, scratchRoot, makeSnapshots) {
  const units = [], issues = [], databases = []
  const stateRoot = stateIsSingleFile(stateSource) ? join(root, 'raw/state', stateSource.basename) : join(root, 'raw/state')
  const files = sourceInventory.entries.filter(entry => entry.type === 'file').map(entry => ({ ...entry, path: entry.path || stateSource.basename }))
  const sqliteFiles = new Set()
  for (const file of files) {
    const full = stateIsSingleFile(stateSource) ? stateRoot : join(stateRoot, file.path)
    if (await header(full) === 'SQLite format 3\0') sqliteFiles.add(file.path)
  }
  for (const file of files) {
    const full = stateIsSingleFile(stateSource) ? stateRoot : join(stateRoot, file.path)
    if (sqliteFiles.has(file.path)) {
      const normalized = `sqlite/${sha(file.path)}.sqlite`
      let value
      if (makeSnapshots) {
        const scratch = await mkdtemp(join(scratchRoot, 'sqlite-'))
        try { value = await sqliteSnapshot(full, join(root, normalized), scratch) } finally { await rm(scratch, { recursive: true, force: true }) }
      } else {
        const expected = sqlite.find(db => db.path === file.path)
        if (!expected || expected.normalized !== normalized) fail('INTEGRITY', 'SQLite manifest mapping mismatch')
        value = await readSqlite(join(root, normalized))
        if (value.summary.logicalSha256 !== expected.logicalSha256) fail('INTEGRITY', 'SQLite logical digest differs from manifest')
      }
      databases.push({ path: file.path, normalized, ...value.summary })
      if (value.summary.userVersion !== 1 || !value.summary.units.length) issues.push({ code: 'UNKNOWN_SQLITE_LAYOUT', location: file.path, userVersion: value.summary.userVersion })
      else {
        const recognized = new Set(['units', 'unit_globals'])
        for (const unit of value.summary.units) {
          const tables = Object.create(null)
          for (const [physical, rows] of value.records) if (value.summary.units.filter(candidate => physical.startsWith(`u_${candidate.name}_`)).sort((a, b) => b.name.length - a.name.length)[0]?.name === unit.name) {
            recognized.add(physical)
            const table = physical.slice(`u_${unit.name}_`.length)
            tables[table] = []
            for (const [key, encoded] of rows) {
              try { tables[table].push([key, JSON.parse(encoded)]) } catch { issues.push({ code: 'INVALID_RECORD_JSON', location: file.path, table: physical, key }) }
            }
          }
          let global
          const encodedGlobal = value.globals.find(row => row.unit === unit.name)?.value
          if (encodedGlobal !== undefined) { try { global = JSON.parse(encodedGlobal) } catch { issues.push({ code: 'INVALID_GLOBAL_JSON', location: file.path, unit: unit.name }) } }
          units.push({ ...unit, location: file.path, tables, global })
        }
        for (const table of value.summary.tables) if (!recognized.has(table.name) && !table.name.startsWith('sqlite_')) issues.push({ code: 'UNKNOWN_SQLITE_TABLE', location: file.path, table: table.name })
      }
    } else if (['-wal', '-shm', '-journal'].some(suffix => file.path.endsWith(suffix) && sqliteFiles.has(file.path.slice(0, -suffix.length)))) {
      // Every original sidecar remains in raw/. Restore uses the normalized DB.
    } else if (file.path.endsWith('.json')) {
      try {
        const value = JSON.parse(await readFile(full, 'utf8'))
        units.push(...unitData(value?.unit?.name, value?.unit?.version, value?.tables, file.path, issues, value?.global))
      } catch { issues.push({ code: 'UNKNOWN_STATE_FORMAT', location: file.path }) }
    } else issues.push({ code: 'UNKNOWN_STATE_FORMAT', location: file.path })
  }
  if (!files.length) issues.push({ code: 'EMPTY_STATE' })
  return { units, issues, databases }
}

function noteId(markdown) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(markdown.replace(/^\uFEFF/, ''))
  return match && /^id:\s*([^\r\n]+)$/m.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, '')
}
async function reconcile(root, state) {
  const issues = [...state.issues]
  const add = (code, data = {}) => issues.push({ code, ...data })
  const unitReport = [], rows = new Map(), seenUnits = new Set()
  for (const unit of state.units) {
    const expectedVersion = Object.hasOwn(versions, unit.name) ? versions[unit.name] : undefined
    unitReport.push({ name: unit.name, version: unit.version, expectedVersion: expectedVersion ?? null, location: unit.location, tables: Object.fromEntries(Object.entries(unit.tables).map(([name, entries]) => [name, entries.length])) })
    if (seenUnits.has(unit.name)) add('DUPLICATE_UNIT', { unit: unit.name })
    seenUnits.add(unit.name)
    if (expectedVersion === undefined) add('UNKNOWN_UNIT', { unit: unit.name })
    else if (unit.version !== expectedVersion) add('DOMAIN_VERSION_REQUIRES_EXPLICIT_MIGRATION', { unit: unit.name, found: unit.version, expected: expectedVersion })
    if (expectedVersion !== undefined && unit.version === expectedVersion) for (const name of tableNames[unit.name]) if (!(name in unit.tables)) add('MISSING_DOMAIN_TABLE', { unit: unit.name, table: name })
    for (const [name, entries] of Object.entries(unit.tables)) {
      rows.set(`${unit.name}.${name}`, [...(rows.get(`${unit.name}.${name}`) ?? []), ...entries])
      if (expectedVersion !== undefined && !tableNames[unit.name].includes(name)) add('UNKNOWN_DOMAIN_TABLE', { unit: unit.name, table: name })
    }
  }
  const entries = name => rows.get(name) ?? []
  const objects = (name, idField) => {
    const map = new Map()
    for (const [key, value] of entries(name)) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value[idField] !== 'string' || value[idField] !== key || typeof value.workspaceId !== 'string') { add('INVALID_RECORD_IDENTITY', { table: name, key }); continue }
      if (map.has(key)) add('DUPLICATE_RECORD_IDENTITY', { table: name, key })
      map.set(key, value)
    }
    return map
  }
  const notes = objects('pkw_notes.note_index', 'noteId'), attachments = objects('pkw_attachments.attachments', 'id')
  const tasks = objects('pkw_tasks.tasks', 'taskId'), matrices = objects('pkw_tasks.matrices', 'matrixId'), trash = objects('pkw_notes.folder_trash', 'trashEntryId'), commits = objects('pkw.commits', 'operationId')
  const registry = new Map(entries('workspace.workspaces'))
  const workspaces = new Set([...registry.keys(), ...[...notes.values(), ...attachments.values(), ...tasks.values(), ...matrices.values(), ...commits.values()].map(row => row.workspaceId)])
  for (const unit of state.units.filter(unit => unit.name === 'workspace')) {
    const global = unit.global
    if (!global || typeof global.initialized !== 'boolean' || !Array.isArray(global.workspaceIds) || global.workspaceIds.some(id => typeof id !== 'string') || (global.archivedSessionIds !== undefined && (!Array.isArray(global.archivedSessionIds) || global.archivedSessionIds.some(id => typeof id !== 'string')))) add('WORKSPACE_GLOBAL_INVALID')
    else {
      if (global.pendingMutation !== undefined) add('WORKSPACE_PENDING_MUTATION')
      if ((!global.initialized && registry.size) || new Set(global.workspaceIds).size !== global.workspaceIds.length || stable([...global.workspaceIds].sort()) !== stable([...registry.keys()].sort())) add('WORKSPACE_REGISTRY_ORDER_MISMATCH')
    }
    for (const [id, record] of registry) if (!record || typeof record.path !== 'string' || !isAbsolute(record.path) || typeof record.title !== 'string' || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string' || !Array.isArray(record.sessionIds) || record.sessionIds.some(id => typeof id !== 'string')) add('WORKSPACE_RECORD_INVALID', { id })
    for (const id of workspaces) if (!registry.has(id)) add('WORKSPACE_REFERENCE_MISSING', { id })
  }
  if (workspaces.size > 1) add('MULTIPLE_WORKSPACES_REQUIRE_EXPLICIT_IMPORT_MAP', { count: workspaces.size })
  const canonical = await inventory(join(root, 'raw/workspace'))
  const byNoteId = new Map(), markdowns = []
  const files = new Map(canonical.entries.filter(entry => entry.type === 'file').map(entry => [entry.path, entry]))
  for (const file of files.values()) if (/^(notes|archive)\//.test(file.path) && file.path.endsWith('.md') && !file.path.startsWith('archive/attachments/')) {
    const markdown = await readFile(join(root, 'raw/workspace', file.path), 'utf8')
    const id = noteId(markdown)
    if (!id) { add('MARKDOWN_WITHOUT_ID', { path: file.path }); continue }
    const found = byNoteId.get(id) ?? []; found.push({ path: file.path, sha256: file.sha256, contentHash: sha(markdown.replace(/\r\n/g, '\n')) }); byNoteId.set(id, found)
    markdowns.push({ path: file.path, id, markdown })
    if (!notes.has(id)) add('UNINDEXED_NOTE', { id, path: file.path })
  }
  for (const [id, found] of byNoteId) if (found.length > 1) add('DUPLICATE_NOTE_ID', { id, paths: found.map(file => file.path) })
  for (const [id, row] of notes) {
    const found = byNoteId.get(id) ?? []
    const correct = found.find(file => row.deletedAt ? file.path.startsWith('archive/') : file.path === `notes/${row.relativePath}`)
    if (!correct) add('NOTE_FILE_MISSING_OR_MISPLACED', { id, deleted: !!row.deletedAt })
    else if (correct.contentHash !== row.contentHash) add('NOTE_HASH_DIFFERS_FROM_INDEX', { id })
  }
  for (const [path, id] of entries('pkw_notes.note_paths')) if (!notes.has(id) || notes.get(id).relativePath !== path) add('NOTE_PATH_REFERENCE_INVALID', { path, id })
  for (const [id, row] of attachments) {
    const path = row.deletedAt ? `archive/attachments/${id}/${row.filename}` : row.relativePath
    const file = files.get(path)
    if (!file) add('ATTACHMENT_FILE_MISSING', { id, path })
    else if (file.sha256 !== row.sha256 || Number(file.size) !== row.sizeBytes) add('ATTACHMENT_HASH_OR_SIZE_MISMATCH', { id })
    for (const field of ['ownerNoteId', 'companionNoteId']) if (row[field] && !notes.has(row[field])) add('ATTACHMENT_NOTE_REFERENCE_MISSING', { id, field, ref: row[field] })
  }
  for (const file of files.values()) {
    const match = /^(?:archive\/)?attachments\/([^/]+)\//.exec(file.path)
    if (match && !attachments.has(match[1])) add('UNINDEXED_ATTACHMENT', { id: match[1], path: file.path })
  }
  for (const item of markdowns) {
    const body = item.markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const attachment = /(?:^|\/)attachments\/([^/\s]+)\//.exec(match[1])
      if (attachment && !attachments.has(attachment[1])) add('MARKDOWN_ATTACHMENT_REFERENCE_MISSING', { id: item.id, ref: attachment[1] })
    }
  }
  for (const [id, row] of tasks) {
    if (row.matrixId !== null && (!matrices.has(row.matrixId) || matrices.get(row.matrixId).workspaceId !== row.workspaceId)) add('TASK_MATRIX_REFERENCE_INVALID', { id, ref: row.matrixId })
    if (row.parentTaskId !== null && (!tasks.has(row.parentTaskId) || tasks.get(row.parentTaskId).workspaceId !== row.workspaceId || (!row.deletedAt && tasks.get(row.parentTaskId).deletedAt))) add('TASK_PARENT_REFERENCE_INVALID', { id, ref: row.parentTaskId })
    const seen = new Set([id]); let parent = row.parentTaskId
    while (parent && tasks.has(parent)) { if (seen.has(parent)) { add('TASK_PARENT_CYCLE', { id }); break }; seen.add(parent); parent = tasks.get(parent).parentTaskId }
    if (!Array.isArray(row.sourceRefs)) add('TASK_SOURCE_REFS_INVALID', { id })
    else for (const ref of row.sourceRefs) if (!ref || !notes.has(ref.noteId) || notes.get(ref.noteId).workspaceId !== row.workspaceId) add('TASK_NOTE_REFERENCE_MISSING', { id, ref: ref?.noteId ?? null })
  }
  for (const [id, row] of trash) if (!safeRelative(row.archivedPath) || !canonical.entries.some(file => file.path === `archive/${row.archivedPath}` && file.type === 'directory')) add('FOLDER_TRASH_PATH_MISSING', { id })
  const eventIds = [], knowledgeIds = []
  for (const [id, row] of commits) {
    if (!Array.isArray(row.events) || !row.events.length) { add('COMMIT_EVENTS_INVALID', { id }); continue }
    for (const event of row.events) if (typeof event?.eventId === 'string') eventIds.push(event.eventId); else add('EVENT_ID_INVALID', { id })
  }
  if (new Set(eventIds).size !== eventIds.length) add('DUPLICATE_EVENT_ID')
  for (const [key, row] of entries('pkw_weknora_sync.mappings')) {
    if (!row || typeof row !== 'object') { add('SYNC_MAPPING_INVALID', { key }); continue }
    if (row.knowledgeId) knowledgeIds.push(row.knowledgeId)
    const entity = row.entityType === 'note' ? notes.get(row.entityId) : row.entityType === 'attachment' ? attachments.get(row.entityId) : undefined
    if (!entity || entity.workspaceId !== row.workspaceId) add('SYNC_ENTITY_REFERENCE_MISSING', { key, entityType: row.entityType, entityId: row.entityId })
  }
  for (const [key, row] of entries('pkw_weknora_sync.reverse')) {
    if (!entries('pkw_weknora_sync.mappings').some(([, mapping]) => mapping && row && mapping.knowledgeId === row.knowledgeId && mapping.entityId === row.entityId && mapping.entityType === row.entityType && mapping.workspaceId === row.workspaceId)) add('SYNC_REVERSE_REFERENCE_MISSING', { key })
  }
  const identities = { workspaceIds: [...workspaces].sort(), noteIds: [...notes.keys()].sort(), attachmentIds: [...attachments.keys()].sort(), taskIds: [...tasks.keys()].sort(), matrixIds: [...matrices.keys()].sort(), folderTrashIds: [...trash.keys()].sort(), operationIds: [...commits.keys()].sort(), eventIds: eventIds.sort(), knowledgeIds: knowledgeIds.sort() }
  const records = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => ({ table: name, count: values.length, sha256: digest(values.map(([key, value]) => [key, value]).sort(([a], [b]) => String(a).localeCompare(String(b)))) }))
  return { units: unitReport, workspaceIds: [...workspaces].sort(), identities, identitySha256: digest(identities), records, globals: state.units.map(unit => ({ unit: unit.name, sha256: digest(unit.global ?? null) })), recordsSha256: digest({ records, globals: state.units.map(unit => [unit.name, unit.global ?? null]) }), files: { notes: markdowns.length, archivedNotes: markdowns.filter(note => note.path.startsWith('archive/')).length, attachmentFiles: [...files.keys()].filter(path => /^(?:archive\/)?attachments\//.test(path)).length }, issues, readiness: { canStartNewVersion: false, preservationReconciled: true, importReviewRequired: true, preflightChecksPassed: issues.length === 0, blockers: [...new Set(issues.map(issue => issue.code))], runtimeSchemaValidation: 'not_run', runtimeAcceptance: 'not_run', ownership: 'existing-owner-private-space-only' } }
}

async function capture(options, root, source, sourceInventory, hooks = {}) {
  await mkdir(join(root, 'raw'), { mode: 0o700 }); await mkdir(join(root, 'sqlite'), { mode: 0o700 })
  await copyTree(source.workspace.path, join(root, 'raw/workspace'), sourceInventory.workspace)
  if (stateIsSingleFile(source.state)) await mkdir(join(root, 'raw/state'), { mode: 0o700 })
  const stateRaw = stateIsSingleFile(source.state) ? join(root, 'raw/state', source.state.basename) : join(root, 'raw/state')
  await copyTree(source.state.sqliteBundle ? dirname(source.state.path) : source.state.path, stateRaw, sourceInventory.state)
  await hooks.onPhase?.('copied')
  await assertUnchanged(source, sourceInventory)
  await verifyCopied(sourceInventory.workspace, join(root, 'raw/workspace')); await verifyCopied(sourceInventory.state, stateRaw)
  const scratch = await mkdtemp(join(tmpdir(), 'pkw-data-sqlite-'))
  let state
  try { state = await stateData(root, source.state, sourceInventory.state, [], scratch, true) } finally { await rm(scratch, { recursive: true, force: true }) }
  const reconciliation = await reconcile(root, state)
  await hooks.onPhase?.('reconciled')
  await assertUnchanged(source, sourceInventory)
  const payload = contentEntries(await inventory(root)).filter(entry => entry.path !== '')
  return { format: 'pkw-data-preservation', version: 1, status: 'complete', createdAt: new Date().toISOString(), source, sourceInventory, sourceFingerprint: digest(sourceInventory), payload, sqlite: state.databases, reconciliation, offlineConfirmed: options.offlineConfirmed === true, cutover: { sourceMustRemainStopped: true, requireVerifySourceImmediatelyBeforeSwitch: true, targetAcceptance: 'not_run' }, metadataPolicy: 'bytes, modes and mtime recorded; owner, ACL and xattrs are not preserved' }
}
async function saveJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await syncFile(path) }
export async function inspectData(options, hooks = {}) {
  const source = await sources(options), before = await scanSources(source)
  const scratch = await mkdtemp(join(tmpdir(), 'pkw-data-inspect-'))
  try { const manifest = await capture(options, scratch, source, before, hooks); return { operation: 'inspect', sourceFingerprint: manifest.sourceFingerprint, sourceInventory: before, sqlite: manifest.sqlite, reconciliation: manifest.reconciliation, consistentObservation: true, reusableBackup: false } } finally { await rm(scratch, { recursive: true, force: true }) }
}
export async function backupData(options, hooks = {}) {
  if (options.offlineConfirmed !== true) fail('USAGE', 'backup requires --offline-confirmed: stop every writer and keep them stopped until cutover')
  const source = await sources(options), before = await scanSources(source)
  const output = await destination(options.output, Object.values(source).map(root => root.path))
  try {
    const manifest = await capture(options, output, source, before, hooks)
    await syncDirs(output)
    await hooks.onPhase?.('before-complete')
    await assertUnchanged(source, before)
    await saveJson(join(output, 'manifest.json'), manifest)
    await syncFile(output); await syncFile(dirname(output))
    return { operation: 'backup', backup: output, manifestSha256: sha(await readFile(join(output, 'manifest.json'))), sourceFingerprint: manifest.sourceFingerprint, reconciliation: manifest.reconciliation, cutover: manifest.cutover }
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error }
}
async function loadManifest(path, expectedManifestSha256) {
  if (!path || !isAbsolute(path)) fail('USAGE', 'backup must be an absolute path')
  const root = await realpath(path)
  if (root !== resolve(path)) fail('UNSAFE_PATH', 'Backup path may not traverse symlinks')
  const bytes = await readFile(join(root, 'manifest.json'))
  if (expectedManifestSha256 && sha(bytes) !== expectedManifestSha256) fail('INTEGRITY', 'Manifest digest does not match the independently retained value')
  let manifest
  try { manifest = JSON.parse(bytes) } catch { fail('INTEGRITY', 'Invalid manifest JSON') }
  if (manifest.format !== 'pkw-data-preservation' || manifest.version !== 1 || manifest.status !== 'complete' || !Array.isArray(manifest.payload) || !manifest.source?.workspace || !manifest.source?.state || !manifest.sourceInventory?.workspace || !manifest.sourceInventory?.state || !Array.isArray(manifest.sqlite)) fail('INTEGRITY', 'Unsupported or incomplete backup manifest')
  const paths = new Set()
  for (const entry of manifest.payload) {
    if (!safeRelative(entry.path) || paths.has(entry.path) || !['file', 'directory'].includes(entry.type)) fail('INTEGRITY', 'Unsafe or duplicate payload path in manifest')
    paths.add(entry.path)
  }
  if (!safeRelative(manifest.source.state.basename) || !['file', 'directory'].includes(manifest.source.state.kind)) fail('INTEGRITY', 'Invalid state descriptor')
  if (digest(manifest.sourceInventory) !== manifest.sourceFingerprint) fail('INTEGRITY', 'Source fingerprint is inconsistent')
  for (const snapshot of Object.values(manifest.sourceInventory)) {
    if (!Array.isArray(snapshot.entries) || snapshot.fingerprint !== digest(snapshot.entries)) fail('INTEGRITY', 'Source inventory is inconsistent')
    const seen = new Set()
    for (const entry of snapshot.entries) {
      if ((entry.path !== '' && !safeRelative(entry.path)) || seen.has(entry.path) || !['file', 'directory'].includes(entry.type) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !/^\d+$/.test(entry.mtimeNs)) fail('INTEGRITY', 'Unsafe source inventory')
      seen.add(entry.path)
    }
  }
  for (const db of manifest.sqlite) if (!safeRelative(db.path) || db.normalized !== `sqlite/${sha(db.path)}.sqlite`) fail('INTEGRITY', 'Unsafe SQLite mapping')
  return { root, manifest, manifestSha256: sha(bytes) }
}
export async function verifyBackup(options) {
  const loaded = await loadManifest(options.backup, options.manifestSha256)
  const { root, manifest } = loaded
  const actual = contentEntries(await inventory(root)).filter(entry => entry.path !== '' && entry.path !== 'manifest.json')
  if (stable(actual) !== stable(manifest.payload)) fail('INTEGRITY', 'Backup has changed, missing, or unexpected files')
  await verifyCopied(manifest.sourceInventory.workspace, join(root, 'raw/workspace'))
  await verifyCopied(manifest.sourceInventory.state, stateIsSingleFile(manifest.source.state) ? join(root, 'raw/state', manifest.source.state.basename) : join(root, 'raw/state'))
  const state = await stateData(root, manifest.source.state, manifest.sourceInventory.state, manifest.sqlite, null, false)
  const reconciliation = await reconcile(root, state)
  if (stable(reconciliation) !== stable(manifest.reconciliation) || state.databases.length !== manifest.sqlite.length) fail('INTEGRITY', 'Identity, references or records differ from backup manifest')
  if (options.requireReady && !reconciliation.readiness.preflightChecksPassed) fail('NOT_READY', 'Preservation succeeded but schemas or references require review; do not start the new runtime', { blockers: reconciliation.readiness.blockers })
  return { operation: 'verify', backup: root, manifestSha256: loaded.manifestSha256, sourceFingerprint: manifest.sourceFingerprint, byteIntegrity: 'passed', sqliteIntegrity: 'passed', reconciliation, cutover: manifest.cutover }
}
export async function verifySource(options) {
  const verified = await verifyBackup(options)
  const { manifest } = await loadManifest(options.backup, options.manifestSha256)
  // Validate stored source paths again; never follow a replacement symlink.
  const source = await sources({ workspace: manifest.source.workspace.path, state: manifest.source.state.path })
  if (stable(source) !== stable(manifest.source)) fail('SOURCE_CHANGED', 'Source layout differs from the captured layout')
  await assertUnchanged(source, manifest.sourceInventory)
  return { ...verified, operation: 'verify-source', sourceUnchanged: true, checkedAt: new Date().toISOString(), requiresWritersRemainStopped: true }
}
export async function restoreData(options, hooks = {}) {
  const verified = await verifyBackup(options)
  const { root, manifest } = await loadManifest(options.backup, options.manifestSha256)
  const target = await destination(options.target, [root, ...Object.values(manifest.source).map(source => source.path)])
  try {
    await copyTree(join(root, 'raw/workspace'), join(target, 'workspace'), manifest.sourceInventory.workspace)
    if (stateIsSingleFile(manifest.source.state)) await mkdir(join(target, 'state'), { mode: 0o700 })
    const stateTarget = stateIsSingleFile(manifest.source.state) ? join(target, 'state', manifest.source.state.basename) : join(target, 'state')
    const stateRaw = stateIsSingleFile(manifest.source.state) ? join(root, 'raw/state', manifest.source.state.basename) : join(root, 'raw/state')
    await copyTree(stateRaw, stateTarget, manifest.sourceInventory.state)
    await verifyCopied(manifest.sourceInventory.workspace, join(target, 'workspace')); await verifyCopied(manifest.sourceInventory.state, stateTarget)
    for (const db of manifest.sqlite) {
      const path = join(target, 'state', db.path)
      await rm(path)
      await copyFile(join(root, db.normalized), path, constants.COPYFILE_EXCL)
      await chmod(path, 0o600); await syncFile(path)
      for (const suffix of ['-wal', '-shm', '-journal']) await rm(path + suffix, { force: true })
      if ((await readSqlite(path)).summary.logicalSha256 !== db.logicalSha256) fail('INTEGRITY', 'Restored SQLite logical records differ')
    }
    await hooks.onPhase?.('restored')
    // A concurrent change to the backup invalidates the restore before publication.
    await verifyBackup({ backup: root, manifestSha256: verified.manifestSha256 })
    await verifyCopied(manifest.sourceInventory.workspace, join(target, 'workspace'))
    const expectedState = contentEntries(manifest.sourceInventory.state).filter(entry => !manifest.sqlite.some(db => ['-wal', '-shm', '-journal'].some(suffix => entry.path === db.path + suffix)))
    for (const db of manifest.sqlite) {
      const entry = expectedState.find(entry => entry.path === (stateIsSingleFile(manifest.source.state) ? '' : db.path))
      if (!entry) fail('INTEGRITY', 'Database missing from restored inventory')
      const file = manifest.payload.find(item => item.path === db.normalized && item.type === 'file')
      if (!file) fail('INTEGRITY', 'Normalized database missing from backup inventory')
      entry.sha256 = file.sha256; entry.size = file.size
    }
    if (stable(contentEntries(await inventory(stateTarget))) !== stable(expectedState)) fail('INTEGRITY', 'Restored state file inventory differs')
    await syncDirs(target)
    const report = { operation: 'restore', status: 'complete', backup: root, manifestSha256: verified.manifestSha256, target, workspace: join(target, 'workspace'), state: manifest.source.state.kind === 'file' ? join(target, 'state', manifest.source.state.basename) : stateTarget, files: 'passed', sqliteLogicalIntegrity: 'passed', reconciliation: verified.reconciliation, sourceModified: false, targetAcceptance: 'not_run', ownership: 'existing-owner-private-space-only' }
    await saveJson(join(target, 'restore-report.json'), report); await syncFile(target); await syncFile(dirname(target))
    return report
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
}

// For offline import tooling only: callers must pass an isolated copy, never a live source.
export { readSqlite as inspectSqliteCopy }
export { sqliteSnapshot as createSqliteCopy, copyTree as copyInventory, contentEntries as inventoryContent }

// Keep in sync with collaboration IdentityStore's durable v1 column contract.
export const IDENTITY_V1_COLUMNS = Object.freeze({ accounts: ['id', 'username', 'password'], audit: ['sequence', 'at', 'actor', 'spaceId', 'action', 'subject'], invitations: ['hash', 'spaceId', 'role', 'createdBy', 'expires'], members: ['spaceId', 'userId', 'role'], sessions: ['hash', 'userId', 'csrf', 'expires', 'seen'], spaces: ['id', 'name', 'kind', 'ownerId'] })

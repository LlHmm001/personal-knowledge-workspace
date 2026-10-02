import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { backupData, DataError, EXIT, inspectData, inventory, restoreData, verifyBackup, verifySource } from '../data-preservation.mjs'

const execute = promisify(execFile)
const dirs = []
after(async () => { for (const path of dirs) await rm(path, { recursive: true, force: true }) })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const now = '2026-10-01T00:00:00.000Z'
const markdown = (id, text) => `---\nid: ${id}\n---\n${text}\n`
const current = markdown('note_current', '# 保留正文\n[附件](attachments/att_one/数据.bin)')
const archived = markdown('note_archived', '# 回收站正文')
const binary = Buffer.from([0, 1, 2, 255, 128, 13, 10])
const attachment = (id, deletedAt) => ({ id, workspaceId: 'ws-owner', filename: '数据.bin', relativePath: `attachments/${id}/数据.bin`, mimeType: 'application/octet-stream', sizeBytes: binary.length, sha256: hash(binary), observedRevision: 1, createdAt: now, indexedAt: now, ...(deletedAt ? { deletedAt } : {}) })
function units(noteVersion = 3) {
  const note = (noteId, relativePath, bytes, deletedAt) => ({ noteId, workspaceId: 'ws-owner', relativePath, title: noteId, tags: [], contentHash: hash(bytes), observedRevision: 1, fileSize: Buffer.byteLength(bytes), createdAt: now, updatedAt: now, ...(deletedAt ? { deletedAt } : {}) })
  const task = (taskId, deletedAt) => ({ taskId, workspaceId: 'ws-owner', matrixId: 'matrix_one', title: taskId, status: 'open', important: false, urgent: false, tags: [], parentTaskId: null, sourceRefs: [{ kind: 'note', noteId: 'note_current' }], manualOrder: 1, createdAt: now, updatedAt: now, ...(deletedAt ? { deletedAt } : {}) })
  return [
    { unit: { name: 'pkw_notes', version: noteVersion }, global: null, tables: {
      note_index: { note_current: note('note_current', '个人/你好.md', current), note_archived: note('note_archived', '旧目录/旧笔记.md', archived, now) },
      note_paths: { '个人/你好.md': 'note_current', '旧目录/旧笔记.md': 'note_archived' }, note_order: {},
      folder_trash: { ftrash_one: { trashEntryId: 'ftrash_one', workspaceId: 'ws-owner', originalPath: '旧目录', archivedPath: 'folders/ftrash_one', deletedAt: now } },
    } },
    { unit: { name: 'pkw_attachments', version: 1 }, global: null, tables: { attachments: { att_one: attachment('att_one'), att_deleted: attachment('att_deleted', now) } } },
    { unit: { name: 'pkw_tasks', version: 1 }, global: null, tables: {
      matrices: { matrix_one: { matrixId: 'matrix_one', workspaceId: 'ws-owner', name: '私人事务', manualOrder: 1, createdAt: now, updatedAt: now } },
      tasks: { task_one: task('task_one'), task_deleted: task('task_deleted', now) },
    } },
    { unit: { name: 'pkw', version: 1 }, global: null, tables: { commits: { operation_one: { operationId: 'operation_one', workspaceId: 'ws-owner', actor: { type: 'user' }, correlationId: 'corr_one', committedAt: now, events: [{ eventId: 'event_one', type: 'note.created', aggregateType: 'note', aggregateId: 'historical_purged_note', aggregateRevision: 1, createdAt: now, payload: { original: '历史事件保留' } }] } } } },
    { unit: { name: 'pkw_weknora_sync', version: 3 }, global: null, tables: {
      mappings: { 'ws-owner:note:note_current': { workspaceId: 'ws-owner', entityType: 'note', entityId: 'note_current', knowledgeId: 'knowledge_one', localObservedRevision: 1, remoteFingerprint: 'remote_hash', syncState: 'synced', updatedAt: now } },
      reverse: { knowledge_one: { knowledgeId: 'knowledge_one', workspaceId: 'ws-owner', entityType: 'note', entityId: 'note_current' } },
      intents: {}, dirty: {}, processing: {}, processing_kb: {},
    } },
  ]
}
async function fixture({ sqlite = false, noteVersion = 3, unknown = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-preservation-'))); dirs.push(root)
  const workspace = join(root, 'workspace'), state = join(root, 'state'), output = join(root, 'backup')
  for (const path of ['notes/个人', 'notes/空目录', 'archive/folders/ftrash_one', 'attachments/att_one', 'archive/attachments/att_deleted']) await mkdir(join(workspace, path), { recursive: true })
  await mkdir(state)
  await writeFile(join(workspace, 'notes/个人/你好.md'), current)
  await writeFile(join(workspace, 'archive/folders/ftrash_one/旧笔记.md'), archived)
  await writeFile(join(workspace, 'attachments/att_one/数据.bin'), binary)
  await writeFile(join(workspace, 'archive/attachments/att_deleted/数据.bin'), binary)
  const records = units(noteVersion)
  let db
  if (sqlite) {
    db = new DatabaseSync(join(state, 'canonical.sqlite'))
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1; CREATE TABLE units(name TEXT PRIMARY KEY,version INTEGER NOT NULL) STRICT; CREATE TABLE unit_globals(unit TEXT PRIMARY KEY REFERENCES units(name),value TEXT NOT NULL) STRICT;')
    db.exec('BEGIN')
    for (const data of records) {
      db.prepare('INSERT INTO units VALUES(?,?)').run(data.unit.name, data.unit.version)
      for (const [name, entries] of Object.entries(data.tables)) {
        const physical = `u_${data.unit.name}_${name}`
        db.exec(`CREATE TABLE "${physical}"(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT`)
        for (const [key, value] of Object.entries(entries)) db.prepare(`INSERT INTO "${physical}" VALUES(?,?)`).run(key, JSON.stringify(value))
      }
    }
    if (unknown) { db.exec('CREATE TABLE custom_legacy(id INTEGER PRIMARY KEY,bytes BLOB,number INTEGER)'); db.prepare('INSERT INTO custom_legacy VALUES(?,?,?)').run(1, binary, 9007199254740993n) }
    db.exec('COMMIT')
  } else for (const data of records) await writeFile(join(state, `${data.unit.name}.json`), JSON.stringify(data, null, 2))
  return { root, workspace, state, output, records, db, offlineConfirmed: true }
}
const kind = expected => error => error instanceof DataError && error.kind === expected

// Proves canonical files, trash, Task/event history and projection IDs survive.
test('JSON backup, independent verification and isolated restore preserve all canonical data and identities', async () => {
  const f = await fixture(), beforeWorkspace = await inventory(f.workspace), beforeState = await inventory(f.state)
  const observed = await inspectData(f)
  assert.equal(observed.reusableBackup, false)
  assert.equal(observed.reconciliation.readiness.preflightChecksPassed, true)
  const backup = await backupData(f)
  assert.equal(backup.reconciliation.readiness.canStartNewVersion, false)
  assert.equal(backup.reconciliation.readiness.ownership, 'existing-owner-private-space-only')
  assert.deepEqual(backup.reconciliation.identities.taskIds, ['task_deleted', 'task_one'])
  assert.deepEqual(backup.reconciliation.identities.eventIds, ['event_one'])
  assert.deepEqual(backup.reconciliation.identities.knowledgeIds, ['knowledge_one'])
  const verified = await verifyBackup({ backup: f.output, manifestSha256: backup.manifestSha256, requireReady: true })
  assert.equal(verified.reconciliation.recordsSha256, backup.reconciliation.recordsSha256)
  const restored = await restoreData({ backup: f.output, target: join(f.root, 'restored'), manifestSha256: backup.manifestSha256 })
  for (const entry of beforeWorkspace.entries.filter(entry => entry.type === 'file')) assert.deepEqual(await readFile(join(restored.workspace, entry.path)), await readFile(join(f.workspace, entry.path)))
  for (const entry of beforeState.entries.filter(entry => entry.type === 'file')) assert.deepEqual(await readFile(join(restored.state, entry.path)), await readFile(join(f.state, entry.path)))
  assert.equal((await stat(join(restored.workspace, 'notes/空目录'))).isDirectory(), true)
  assert.deepEqual(await inventory(f.workspace), beforeWorkspace)
  assert.deepEqual(await inventory(f.state), beforeState)
  assert.equal((await verifySource({ backup: f.output })).sourceUnchanged, true)
  assert.equal(restored.targetAcceptance, 'not_run')
})

test('real WAL SQLite snapshot includes uncheckpointed commits and preserves every logical table across reopen', async () => {
  const f = await fixture({ sqlite: true })
  try {
    const before = await inventory(f.state)
    assert.ok(before.entries.some(entry => entry.path.endsWith('-wal') && BigInt(entry.size) > 0n))
    await backupData(f)
    assert.deepEqual(await inventory(f.state), before, 'source DB and sidecars were never opened or modified')
    const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'))
    const rawDb = manifest.payload.find(entry => entry.path === 'raw/state/canonical.sqlite')
    const normalized = manifest.payload.find(entry => entry.path === manifest.sqlite[0].normalized)
    assert.notEqual(rawDb.sha256, normalized.sha256, 'byte-level mismatch is expected for normalized SQLite')
    assert.equal(manifest.sqlite[0].integrity, 'ok')
    assert.equal(manifest.sqlite[0].tables.find(table => table.name === 'u_pkw_tasks_tasks').rows, 2)
    await verifyBackup({ backup: f.output, requireReady: true })
    const restored = await restoreData({ backup: f.output, target: join(f.root, 'restored') })
    assert.deepEqual(await readdir(restored.state), ['canonical.sqlite'])
    const reopened = new DatabaseSync(join(restored.state, 'canonical.sqlite'), { readOnly: true })
    try {
      assert.equal(reopened.prepare('SELECT count(*) AS n FROM u_pkw_tasks_tasks').get().n, 2)
      assert.equal(reopened.prepare('SELECT count(*) AS n FROM u_pkw_commits').get().n, 1)
      assert.equal(reopened.prepare('SELECT value FROM u_pkw_weknora_sync_reverse').get().value.includes('knowledge_one'), true)
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1)
    } finally { reopened.close() }
    assert.deepEqual(await inventory(f.state), before)
  } finally { f.db.close() }
})

test('old JSON domain versions remain exact and cannot pass new-runtime readiness', async () => {
  for (const version of [1, 2]) {
    const f = await fixture({ noteVersion: version }), original = await readFile(join(f.state, 'pkw_notes.json'))
    const result = await backupData(f)
    assert.ok(result.reconciliation.readiness.blockers.includes('DOMAIN_VERSION_REQUIRES_EXPLICIT_MIGRATION'))
    assert.equal(result.reconciliation.readiness.preservationReconciled, true)
    await assert.rejects(verifyBackup({ backup: f.output, requireReady: true }), kind('NOT_READY'))
    const restored = await restoreData({ backup: f.output, target: join(f.root, 'legacy-copy') })
    assert.deepEqual(await readFile(join(restored.state, 'pkw_notes.json')), original)
    assert.deepEqual(await readFile(join(f.state, 'pkw_notes.json')), original)
  }
})

test('old SQLite domain version and opaque custom records are retained without schema guesses or integer loss', async () => {
  const f = await fixture({ sqlite: true, noteVersion: 1, unknown: true })
  try {
    const result = await backupData(f)
    assert.ok(result.reconciliation.readiness.blockers.includes('DOMAIN_VERSION_REQUIRES_EXPLICIT_MIGRATION'))
    assert.ok(result.reconciliation.readiness.blockers.includes('UNKNOWN_SQLITE_TABLE'))
    const restored = await restoreData({ backup: f.output, target: join(f.root, 'legacy-copy') })
    const db = new DatabaseSync(join(restored.state, 'canonical.sqlite'), { readOnly: true })
    try {
      assert.equal(db.prepare("SELECT version FROM units WHERE name='pkw_notes'").get().version, 1)
      const statement = db.prepare('SELECT * FROM custom_legacy'); statement.setReadBigInts(true)
      const row = statement.get(); assert.equal(row.number, 9007199254740993n); assert.deepEqual(Buffer.from(row.bytes), binary)
    } finally { db.close() }
  } finally { f.db.close() }
})

test('source changes during each backup phase reject the snapshot and remove incomplete output', async () => {
  for (const phase of ['copied', 'reconciled', 'before-complete']) {
    const f = await fixture()
    await assert.rejects(backupData(f, { onPhase: async currentPhase => { if (phase === currentPhase) await writeFile(join(f.workspace, 'notes/新写入.md'), markdown('note_new', 'cannot drop this')) } }), kind('SOURCE_CHANGED'))
    await assert.rejects(stat(f.output), { code: 'ENOENT' })
    assert.match(await readFile(join(f.workspace, 'notes/新写入.md'), 'utf8'), /cannot drop this/)
  }
})

test('same-byte ABA edits and newly added SQLite WAL commits are rejected', async () => {
  const f = await fixture()
  await assert.rejects(backupData(f, { onPhase: async phase => { if (phase === 'copied') await writeFile(join(f.workspace, 'notes/个人/你好.md'), current) } }), kind('SOURCE_CHANGED'))
  const sql = await fixture({ sqlite: true })
  try {
    await assert.rejects(backupData(sql, { onPhase: phase => { if (phase === 'copied') sql.db.exec("INSERT INTO unit_globals VALUES('pkw','\"new write\"')") } }), kind('SOURCE_CHANGED'))
    assert.equal(sql.db.prepare('SELECT count(*) AS n FROM unit_globals').get().n, 1)
  } finally { sql.db.close() }
})

test('cutover source verification refuses old backup after new canonical or structured writes', async () => {
  for (const scope of ['workspace', 'state']) {
    const f = await fixture(); await backupData(f)
    await writeFile(join(f[scope], 'new-data'), 'new data belongs to user')
    await assert.rejects(verifySource({ backup: f.output }), kind('SOURCE_CHANGED'))
    assert.equal((await verifyBackup({ backup: f.output })).byteIntegrity, 'passed', 'historical backup is still valid, just stale for cutover')
  }
})

test('backup and restore refuse existing, source-overlapping, backup-overlapping and symlink destinations', async () => {
  const f = await fixture(); await backupData(f)
  const empty = join(f.root, 'empty'); await mkdir(empty)
  for (const target of [f.workspace, f.state, f.output, empty, join(f.workspace, 'nested'), join(f.output, 'nested')]) await assert.rejects(restoreData({ backup: f.output, target }), kind('UNSAFE_PATH'))
  await assert.rejects(backupData(f), kind('UNSAFE_PATH'))
  await symlink(f.root, join(f.root, 'link'))
  await assert.rejects(restoreData({ backup: f.output, target: join(f.root, 'link', 'restore') }), kind('UNSAFE_PATH'))
  assert.deepEqual(await readdir(empty), [])
})

test('source symlinks and overlapping roots fail explicitly', async () => {
  const f = await fixture(); await symlink(join(f.workspace, 'notes/个人/你好.md'), join(f.workspace, 'notes/shortcut.md'))
  await assert.rejects(inspectData(f), kind('UNSUPPORTED'))
  await assert.rejects(inspectData({ workspace: f.workspace, state: join(f.workspace, 'notes') }), kind('UNSUPPORTED'))

})

test('backup tampering, missing files and unexpected files cannot be restored', async () => {
  for (const action of ['modify', 'missing', 'extra']) {
    const f = await fixture(); await backupData(f)
    const path = join(f.output, 'raw/workspace/attachments/att_one/数据.bin')
    if (action === 'modify') await writeFile(path, 'changed')
    if (action === 'missing') await rm(path)
    if (action === 'extra') await writeFile(join(f.output, 'unexpected'), 'extra')
    await assert.rejects(restoreData({ backup: f.output, target: join(f.root, 'restored') }), kind('INTEGRITY'))
    await assert.rejects(stat(join(f.root, 'restored')), { code: 'ENOENT' })
  }
})

test('manifest digest is independently bindable and unsafe manifest paths are rejected', async () => {
  const f = await fixture(); const result = await backupData(f)
  const path = join(f.output, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.createdAt = 'modified'
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(verifyBackup({ backup: f.output, manifestSha256: result.manifestSha256 }), kind('INTEGRITY'))
  manifest.payload[0].path = '../escape'; await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(verifyBackup({ backup: f.output }), kind('INTEGRITY'))
})

test('failures clean only newly allocated output and never modify canonical source', async () => {
  const f = await fixture(), before = await inventory(f.workspace)
  await assert.rejects(backupData(f, { onPhase: () => { throw new Error('injected copy failure') } }), /injected copy failure/)
  await assert.rejects(stat(f.output), { code: 'ENOENT' })
  assert.deepEqual(await inventory(f.workspace), before)
  await backupData(f)
  const target = join(f.root, 'restored')
  await assert.rejects(restoreData({ backup: f.output, target }, { onPhase: () => { throw new Error('injected restore failure') } }), /injected restore failure/)
  await assert.rejects(stat(target), { code: 'ENOENT' })
  assert.deepEqual(await inventory(f.workspace), before)
  await restoreData({ backup: f.output, target })
})

test('restore rechecks its input and copied state before reporting success', async () => {
  const f = await fixture(); await backupData(f)
  await assert.rejects(restoreData({ backup: f.output, target: join(f.root, 'restored') }, { onPhase: async () => { await writeFile(join(f.output, 'raw/state/pkw_tasks.json'), '{}') } }), kind('INTEGRITY'))
  await assert.rejects(stat(join(f.root, 'restored')), { code: 'ENOENT' })
})

test('identity, canonical hash, orphan Task references, cycles and projection reverse references are reported without edits', async () => {
  const f = await fixture()
  const taskPath = join(f.state, 'pkw_tasks.json'), value = JSON.parse(await readFile(taskPath, 'utf8'))
  value.tables.tasks.task_one.matrixId = 'missing_matrix'
  value.tables.tasks.task_one.parentTaskId = 'task_one'
  value.tables.tasks.task_one.sourceRefs = [{ noteId: 'missing_note' }]
  await writeFile(taskPath, JSON.stringify(value))
  await writeFile(join(f.workspace, 'notes/duplicate.md'), current)
  await writeFile(join(f.workspace, 'attachments/att_one/数据.bin'), 'tamper existing original')
  const syncPath = join(f.state, 'pkw_weknora_sync.json'), sync = JSON.parse(await readFile(syncPath, 'utf8'))
  sync.tables.reverse.knowledge_one.entityId = 'missing_note'; await writeFile(syncPath, JSON.stringify(sync))
  const before = await inventory(f.state), result = await backupData(f)
  for (const code of ['TASK_MATRIX_REFERENCE_INVALID', 'TASK_PARENT_CYCLE', 'TASK_NOTE_REFERENCE_MISSING', 'DUPLICATE_NOTE_ID', 'ATTACHMENT_HASH_OR_SIZE_MISMATCH', 'SYNC_REVERSE_REFERENCE_MISSING']) assert.ok(result.reconciliation.readiness.blockers.includes(code), code)
  await assert.rejects(verifyBackup({ backup: f.output, requireReady: true }), kind('NOT_READY'))
  assert.deepEqual(await inventory(f.state), before)
  await restoreData({ backup: f.output, target: join(f.root, 'forensic-copy') })
})

test('unknown raw state is kept byte-for-byte and explicitly blocks migration readiness', async () => {
  const f = await fixture(); const unknown = Buffer.from([255, 254, 0, 44, 7]); await writeFile(join(f.state, 'unknown.store'), unknown)
  const result = await backupData(f)
  assert.ok(result.reconciliation.readiness.blockers.includes('UNKNOWN_STATE_FORMAT'))
  const restored = await restoreData({ backup: f.output, target: join(f.root, 'restored') })
  assert.deepEqual(await readFile(join(restored.state, 'unknown.store')), unknown)
})

test('single legacy JSON state file preserves its original basename and content', async () => {
  const f = await fixture(); const sourceFile = join(f.state, 'pkw_notes.json')
  await backupData({ ...f, state: sourceFile })
  const restored = await restoreData({ backup: f.output, target: join(f.root, 'restored') })
  assert.equal(restored.state, join(f.root, 'restored/state/pkw_notes.json'))
  assert.deepEqual(await readFile(restored.state), await readFile(sourceFile))
})

test('CLI emits machine-readable success/failure, documented exit codes and strict argument validation', async () => {
  const cli = resolve('scripts/pkw-data.mjs')
  const help = JSON.parse((await execute(process.execPath, [cli, '--help'])).stdout)
  assert.deepEqual(help.exitCodes, EXIT)
  for (const args of [['backup'], ['inspect', '--wrong'], ['verify', '--backup', '/missing', '--backup', '/twice']]) {
    try { await execute(process.execPath, [cli, ...args]); assert.fail('must exit nonzero') } catch (error) { assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).error.kind, 'USAGE') }
  }
  const f = await fixture({ noteVersion: 1 })
  const result = JSON.parse((await execute(process.execPath, [cli, 'backup', '--workspace', f.workspace, '--state', f.state, '--output', f.output, '--offline-confirmed'])).stdout)
  assert.equal(result.ok, true)
  try { await execute(process.execPath, [cli, 'verify', '--backup', f.output, '--require-ready']); assert.fail('must fail readiness') } catch (error) { assert.equal(error.code, 8); assert.equal(JSON.parse(error.stdout).error.kind, 'NOT_READY') }
})

test('SQLite corruption and foreign-key violations fail closed without a success artifact or source repair', async () => {
  for (const mode of ['corrupt', 'foreign-key']) {
    const f = await fixture({ sqlite: true }); f.db.close()
    if (mode === 'corrupt') {
      const bytes = await readFile(join(f.state, 'canonical.sqlite'))
      bytes.fill(255, 100, 200)
      await writeFile(join(f.state, 'canonical.sqlite'), bytes)
    } else {
      const db = new DatabaseSync(join(f.state, 'canonical.sqlite'))
      db.exec("PRAGMA foreign_keys=OFF; INSERT INTO unit_globals VALUES('missing-unit','null')"); db.close()
    }
    const before = await inventory(f.state)
    await assert.rejects(backupData(f), kind('INTEGRITY'))
    await assert.rejects(stat(f.output), { code: 'ENOENT' })
    assert.deepEqual(await inventory(f.state), before)
  }
})

test('a database changed inside the restored target cannot borrow its own hash to pass verification', async () => {
  const f = await fixture({ sqlite: true })
  try {
    await backupData(f)
    const target = join(f.root, 'restored')
    await assert.rejects(restoreData({ backup: f.output, target }, { onPhase: () => {
      const db = new DatabaseSync(join(target, 'state/canonical.sqlite'))
      db.exec('DELETE FROM u_pkw_tasks_tasks'); db.close()
    } }), kind('INTEGRITY'))
    await assert.rejects(stat(target), { code: 'ENOENT' })
    await verifyBackup({ backup: f.output, requireReady: true })
  } finally { f.db.close() }
})

test('multiple original workspace IDs are preserved but require an explicit private-space import map', async () => {
  const f = await fixture()
  const path = join(f.state, 'pkw_tasks.json'), value = JSON.parse(await readFile(path, 'utf8'))
  value.tables.tasks.task_deleted.workspaceId = 'second-owner'; await writeFile(path, JSON.stringify(value))
  const result = await backupData(f)
  assert.ok(result.reconciliation.readiness.blockers.includes('MULTIPLE_WORKSPACES_REQUIRE_EXPLICIT_IMPORT_MAP'))
  assert.deepEqual(result.reconciliation.workspaceIds, ['second-owner', 'ws-owner'])
  await restoreData({ backup: f.output, target: join(f.root, 'review-copy') })
})

test('Harness workspace v2 registry/global is recognized and retained; pending or orphan registry is blocked', async () => {
  for (const invalid of [false, true]) {
    const f = await fixture({ sqlite: true })
    try {
      f.db.exec("INSERT INTO units VALUES('workspace',2); CREATE TABLE u_workspace_workspaces(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT")
      const global = { initialized: true, workspaceIds: ['ws-owner'], archivedSessionIds: ['archived-session'], ...(invalid ? { pendingMutation: { operation: 'delete', workspaceId: 'ws-owner' } } : {}) }
      f.db.prepare("INSERT INTO unit_globals VALUES('workspace',?)").run(JSON.stringify(global))
      f.db.prepare('INSERT INTO u_workspace_workspaces VALUES(?,?)').run('ws-owner', JSON.stringify({ path: f.workspace, title: '原私人资料', sessionIds: ['original-session'], createdAt: now, updatedAt: now }))
      const result = await backupData(f)
      assert.equal(result.reconciliation.readiness.preflightChecksPassed, !invalid)
      assert.deepEqual(result.reconciliation.workspaceIds, ['ws-owner'])
      assert.ok(result.reconciliation.globals.some(row => row.unit === 'workspace'))
      if (invalid) assert.ok(result.reconciliation.readiness.blockers.includes('WORKSPACE_PENDING_MUTATION'))
      const restored = await restoreData({ backup: f.output, target: join(f.root, 'restored') })
      const db = new DatabaseSync(join(restored.state, 'canonical.sqlite'), { readOnly: true })
      try { assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM unit_globals WHERE unit='workspace'").get().value), global) } finally { db.close() }
    } finally { f.db.close() }
  }
})

test('prototype-shaped unknown JSON units and table keys are retained and explicitly reported', async () => {
  const f = await fixture()
  await writeFile(join(f.state, 'unusual.json'), '{"unit":{"name":"__proto__","version":1},"tables":{"__proto__":{"__proto__":{"data":"kept"}}}}')
  const result = await backupData(f)
  assert.ok(result.reconciliation.readiness.blockers.includes('UNKNOWN_UNIT'))
  assert.ok(result.reconciliation.records.some(row => row.table === '__proto__.__proto__' && row.count === 1))
  await verifyBackup({ backup: f.output })
})

test('single SQLite input captures the entire WAL bundle and can coexist with a sibling workspace', async () => {
  const f = await fixture({ sqlite: true })
  try {
    const sourceFile = join(f.state, 'canonical.sqlite'), before = await inventory(f.state)
    const result = await backupData({ ...f, state: sourceFile })
    const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'))
    assert.equal(manifest.source.state.kind, 'file'); assert.equal(manifest.source.state.sqliteBundle, true)
    assert.ok(manifest.sourceInventory.state.entries.some(entry => entry.path === 'canonical.sqlite-wal'))
    const restored = await restoreData({ backup: f.output, target: join(f.root, 'restored') })
    assert.equal(restored.state, join(f.root, 'restored/state/canonical.sqlite'))
    const db = new DatabaseSync(restored.state, { readOnly: true })
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM u_pkw_tasks_tasks').get().n, 2) } finally { db.close() }
    assert.equal((await verifySource({ backup: f.output, manifestSha256: result.manifestSha256 })).sourceUnchanged, true)
    assert.deepEqual(await inventory(f.state), before)
  } finally { f.db.close() }
})

test('single SQLite bundle detects WAL created after the initial snapshot, including when the main DB bytes stay unchanged', async () => {
  const f = await fixture({ sqlite: true }); f.db.close()
  let writer
  try {
    await assert.rejects(backupData({ ...f, state: join(f.state, 'canonical.sqlite') }, { onPhase: phase => {
      if (phase === 'copied') { writer = new DatabaseSync(join(f.state, 'canonical.sqlite')); writer.exec("PRAGMA journal_mode=WAL; INSERT INTO unit_globals VALUES('pkw','\"late WAL commit\"')") }
    } }), kind('SOURCE_CHANGED'))
    await assert.rejects(stat(f.output), { code: 'ENOENT' })
    assert.equal(writer.prepare('SELECT count(*) AS n FROM unit_globals').get().n, 1)
  } finally { writer?.close() }
})

test('removing a source during capture has the explicit source-changed exit contract', async () => {
  const f = await fixture()
  await assert.rejects(backupData(f, { onPhase: async phase => { if (phase === 'copied') await rm(f.state, { recursive: true }) } }), kind('SOURCE_CHANGED'))
  await assert.rejects(stat(f.output), { code: 'ENOENT' })
})

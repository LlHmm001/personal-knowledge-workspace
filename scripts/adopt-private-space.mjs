#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { DataError, EXIT, IDENTITY_V1_COLUMNS, inspectSqliteCopy, inventory, restoreData, verifyBackup } from './data-preservation.mjs'

const fail = (kind, message, details = {}) => { throw new DataError(kind, message, details) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const within = (root, path) => path === root || path.startsWith(root + sep)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const files = snapshot => snapshot.entries.map(({ path, type, size, sha256 }) => ({ path, type, ...(type === 'file' ? { size, sha256 } : {}) }))
async function sync(path) { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function canonicalDirectory(path) {
  if (!path || !isAbsolute(path)) fail('USAGE', 'data-root must be an absolute path')
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== resolve(path)) fail('UNSAFE_PATH', 'Collaboration data root must be a canonical existing directory')
  return resolve(path)
}
async function mustNotExist(path) {
  try { await lstat(path); fail('UNSAFE_PATH', 'The private space already has a content directory; import never overwrites a used space', { path }) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function identityInventory(root) {
  const snapshots = []
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(root, 'identity.sqlite' + suffix)
    try {
      const snapshot = await inventory(path)
      if (snapshot.entries[0].type !== 'file') fail('UNSUPPORTED', 'Identity database and sidecars must be ordinary files')
      snapshots.push({ name: 'identity.sqlite' + suffix, ...snapshot })
    } catch (error) { if (error.code !== 'ENOENT' || suffix === '') throw error }
  }
  return snapshots
}
async function checkIdentity(root, stage, spaceId, ownerUsername) {
  const before = await identityInventory(root)
  const copied = join(stage, 'identity-copy'); await mkdir(copied, { mode: 0o700 })
  for (const item of before.filter(item => !item.name.endsWith('-shm'))) {
    const target = join(copied, item.name)
    await copyFile(join(root, item.name), target, constants.COPYFILE_EXCL); await chmod(target, 0o600)
    if (!same(files(await inventory(target)), files(item))) fail('INTEGRITY', 'Identity copy differs from the stopped source')
  }
  if (!same(before, await identityInventory(root))) fail('SOURCE_CHANGED', 'Identity database changed during import')
  const path = join(copied, 'identity.sqlite')
  const snapshot = await inspectSqliteCopy(path)
  const tables = snapshot.summary.tables.map(table => table.name).filter(name => !name.startsWith('sqlite_')).sort()
  if (snapshot.summary.userVersion !== 1 || !same(tables, ['accounts', 'audit', 'invitations', 'members', 'sessions', 'spaces'])) fail('UNSUPPORTED', 'Unsupported collaboration identity schema')
  for (const [table, expected] of Object.entries(IDENTITY_V1_COLUMNS)) if (!same(snapshot.summary.tables.find(item => item.name === table)?.columns, expected)) fail('UNSUPPORTED', 'Unsupported collaboration identity schema columns')
  const db = new DatabaseSync(path, { readOnly: true })
  let owner, space
  try {
    owner = db.prepare('SELECT id,username FROM accounts WHERE username=?').get(ownerUsername)
    space = db.prepare('SELECT id,name,kind,ownerId FROM spaces WHERE id=?').get(spaceId)
    if (!owner || !space || space.kind !== 'private' || space.ownerId !== owner.id) fail('NOT_READY', 'Space must be the named existing owner account private space')
    const members = db.prepare('SELECT userId,role FROM members WHERE spaceId=?').all(spaceId)
    if (members.length !== 1 || members[0].userId !== owner.id || members[0].role !== 'owner') fail('NOT_READY', 'Private space membership must contain exactly its owner')
    if (Number(db.prepare('SELECT count(*) AS count FROM invitations WHERE spaceId=?').get(spaceId).count)) fail('NOT_READY', 'Private space must not have outstanding invitations')
  } finally { db.close() }
  return { before, owner: { ...owner }, space: { ...space }, logicalSha256: snapshot.summary.logicalSha256 }
}
function selectDatabase(manifest) {
  if ((manifest.source.state.kind !== 'directory' && manifest.source.state.sqliteBundle !== true) || manifest.sqlite.length !== 1 || manifest.reconciliation.workspaceIds.length !== 1) fail('NOT_READY', 'Import requires exactly one workspace and one SQLite state database')
  const database = manifest.sqlite[0]
  const allowedFiles = new Set(['', '-wal', '-shm', '-journal'].map(suffix => database.path + suffix))
  for (const entry of manifest.sourceInventory.state.entries) {
    if (entry.type === 'file' && !allowedFiles.has(entry.path)) fail('NOT_READY', 'Additional state files require an explicit import adapter; nothing was omitted', { path: entry.path })
    if (entry.type === 'directory' && entry.path !== '' && !database.path.startsWith(entry.path + '/')) fail('NOT_READY', 'Additional state directories require an explicit import adapter', { path: entry.path })
  }
  if (!database.units.some(unit => unit.name === 'workspace' && unit.version === 2)) fail('NOT_READY', 'An identified Harness workspace v2 registry is required')
  return database
}
function registry(db, workspaceId) {
  const rows = db.prepare('SELECT key,value FROM u_workspace_workspaces').all()
  if (rows.length !== 1 || rows[0].key !== workspaceId) fail('NOT_READY', 'Workspace registry must contain exactly the original workspace identity')
  const original = JSON.parse(rows[0].value)
  const global = JSON.parse(db.prepare("SELECT value FROM unit_globals WHERE unit='workspace'").get()?.value ?? 'null')
  if (!global || global.initialized !== true || !same(global.workspaceIds, [workspaceId]) || global.pendingMutation !== undefined || typeof original.path !== 'string' || !isAbsolute(original.path)) fail('NOT_READY', 'Workspace registry has incomplete or ambiguous state')
  return { raw: rows[0].value, original }
}
function assertOnlyRegistryChanged(before, after) {
  if (!same(before.schema, after.schema) || !same(before.units, after.units) || before.userVersion !== after.userVersion || before.tables.length !== after.tables.length) fail('INTEGRITY', 'Import unexpectedly changed storage schema or versions')
  for (const table of before.tables) {
    const current = after.tables.find(item => item.name === table.name)
    if (!current || table.rows !== current.rows || !same(table.columns, current.columns) || (table.name !== 'u_workspace_workspaces' && table.sha256 !== current.sha256)) fail('INTEGRITY', 'Import unexpectedly changed a structured table', { table: table.name })
  }
}

/** Imports only into an unused, existing private space while holding the gateway lock. */
export async function adoptPrivateSpace(options, hooks = {}) {
  if (options.offlineConfirmed !== true) fail('USAGE', 'Import requires --offline-confirmed: the gateway and every old/new content writer must be stopped')
  if (!/^[0-9a-f]{64}$/.test(options.manifestSha256 ?? '')) fail('USAGE', 'An independently retained --manifest-sha256 is required')
  if (!/^sp_[0-9a-f]{32}$/.test(options.spaceId ?? '')) fail('USAGE', 'space-id must be an existing sp_ identity with 32 lowercase hex characters')
  if (typeof options.ownerUsername !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(options.ownerUsername)) fail('USAGE', 'owner-username must match an existing account (3–64 ASCII username characters)')
  const ownerUsername = options.ownerUsername.toLowerCase()
  const verified = await verifyBackup({ backup: options.backup, manifestSha256: options.manifestSha256, requireReady: true })
  const manifestBytes = await readFile(join(verified.backup, 'manifest.json'))
  if (sha(manifestBytes) !== options.manifestSha256) fail('INTEGRITY', 'Backup manifest changed during import')
  const manifest = JSON.parse(manifestBytes), selected = selectDatabase(manifest)
  const root = await canonicalDirectory(options.dataRoot)
  if ([verified.backup, ...Object.values(manifest.source).map(source => source.path)].some(path => within(path, root) || within(root, path))) fail('UNSAFE_PATH', 'Collaboration root must be separate from the backup and original sources')
  const spaces = join(root, 'spaces'), target = join(spaces, options.spaceId), lockPath = join(root, 'gateway.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') fail('UNSAFE_PATH', 'Collaboration root is locked; stop the writer and inspect gateway.lock, never delete a live lock'); throw error })
  const lockBody = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), operation: 'adopt-private-space', nonce: randomUUID() }) + '\n'
  let stage, targetCreated = false, complete = false
  try {
    await lock.writeFile(lockBody); await lock.sync(); await sync(root)
    await hooks.onPhase?.('locked')
    try { await mkdir(spaces, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!(await lstat(spaces)).isDirectory() || await realpath(spaces) !== spaces) fail('UNSAFE_PATH', 'spaces must be a canonical directory')
    await mustNotExist(target)
    stage = await mkdtemp(join(root, '.adopt-private-'))
    const identity = await checkIdentity(root, stage, options.spaceId, ownerUsername)
    await hooks.onPhase?.('identity-checked')
    const restored = await restoreData({ backup: verified.backup, manifestSha256: options.manifestSha256, target: join(stage, 'restored'), requireReady: true })
    const database = manifest.source.state.kind === 'file' ? restored.state : join(restored.state, selected.path), workspaceId = manifest.reconciliation.workspaceIds[0]
    const before = (await inspectSqliteCopy(database)).summary
    if (before.logicalSha256 !== selected.logicalSha256) fail('INTEGRITY', 'Restored database differs from verified source')
    const beforeFileSha256 = sha(await readFile(database))
    const db = new DatabaseSync(database)
    let original, updated
    try {
      db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE')
      original = registry(db, workspaceId)
      updated = JSON.stringify({ ...original.original, path: join(target, 'workspace') })
      const result = db.prepare('UPDATE u_workspace_workspaces SET value=? WHERE key=? AND value=?').run(updated, workspaceId, original.raw)
      if (Number(result.changes) !== 1) fail('INTEGRITY', 'Workspace registry changed during import')
      db.exec('COMMIT')
    } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error } finally { db.close() }
    const after = (await inspectSqliteCopy(database)).summary
    assertOnlyRegistryChanged(before, after)
    const afterFileSha256 = sha(await readFile(database))
    await hooks.onPhase?.('mapped')
    // Validate both immutable backup input and stopped identity source again.
    await verifyBackup({ backup: verified.backup, manifestSha256: options.manifestSha256, requireReady: true })
    if (!same(identity.before, await identityInventory(root))) fail('SOURCE_CHANGED', 'Identity database changed before publishing import')
    if (sha(await readFile(lockPath)) !== sha(lockBody)) fail('UNSAFE_PATH', 'Import no longer owns gateway.lock')
    if (!same(files(await inventory(restored.workspace)), files(manifest.sourceInventory.workspace))) fail('INTEGRITY', 'Restored workspace changed during import')
    if (sha(await readFile(database)) !== afterFileSha256) fail('INTEGRITY', 'Restored database changed after mapping verification')
    await mustNotExist(target)
    // mkdir is an exclusive claim; rename alone could overwrite an empty target.
    await mkdir(target, { mode: 0o700 }); targetCreated = true
    await rename(restored.workspace, join(target, 'workspace'))
    await rename(database, join(target, 'state.sqlite'))
    await hooks.onPhase?.('published-files')
    if (!same(files(await inventory(join(target, 'workspace'))), files(manifest.sourceInventory.workspace)) || sha(await readFile(join(target, 'state.sqlite'))) !== afterFileSha256) fail('INTEGRITY', 'Published import changed before completion')
    if (!same(identity.before, await identityInventory(root))) fail('SOURCE_CHANGED', 'Identity database changed during publication')
    const receipt = {
      format: 'pkw-private-space-adoption', version: 1, status: 'complete', createdAt: new Date().toISOString(),
      operation: 'adopt-private-space', backup: verified.backup, manifestSha256: options.manifestSha256, sourceFingerprint: manifest.sourceFingerprint,
      owner: identity.owner, space: identity.space, target, workspaceId, identityStoreLogicalSha256: identity.logicalSha256,
      workspaceInventorySha256: sha(JSON.stringify(files(manifest.sourceInventory.workspace))), identities: manifest.reconciliation.identities,
      registryUpdate: { table: 'u_workspace_workspaces', key: workspaceId, beforePath: original.original.path, afterPath: join(target, 'workspace'), beforeValueSha256: sha(original.raw), afterValueSha256: sha(updated) },
      sqlite: { originalStatePath: selected.path, targetPath: join(target, 'state.sqlite'), beforeFileSha256, afterFileSha256, beforeLogicalSha256: before.logicalSha256, afterLogicalSha256: after.logicalSha256, preservedTables: before.tables.filter(table => table.name !== 'u_workspace_workspaces'), versions: before.units.map(unit => ({ ...unit })) },
      ownership: 'existing-owner-private-space-only', originalSourcesModified: false, identityStoreModified: false, runtimeAcceptance: 'not_run', canStartNewVersion: false,
      cutover: { sourceFreshness: 'not_checked_on_import_host', verifySourceImmediatelyBeforeSwitch: true, keepOldWritersStopped: true },
    }
    await sync(join(target, 'state.sqlite'))
    await writeFile(join(target, 'adoption-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await sync(join(target, 'adoption-receipt.json')); await sync(join(target, 'workspace')); await sync(target); await sync(spaces)
    complete = true
    return receipt
  } finally {
    try {
      if (!complete && targetCreated) await rm(target, { recursive: true, force: true })
      if (stage) await rm(stage, { recursive: true, force: true })
    } finally {
      const held = await lock.stat()
      await lock.close()
      const current = await lstat(lockPath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (!current || current.ino !== held.ino || sha(await readFile(lockPath)) !== sha(lockBody)) fail('UNSAFE_PATH', 'gateway.lock changed; it was not removed, inspect manually')
      await unlink(lockPath); await sync(root)
    }
  }
}

async function cli() {
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--help') {
      console.log(JSON.stringify({ ok: true, exitCode: 0, usage: 'node scripts/adopt-private-space.mjs --backup ABS --manifest-sha256 HEX --data-root ABS --space-id sp_HEX32 --owner-username NAME --offline-confirmed', exitCodes: EXIT, runtimeAcceptance: 'not_run' }, null, 2)); return
    }
    const options = {}, seen = new Set(), allowed = new Set(['backup', 'manifest-sha256', 'data-root', 'space-id', 'owner-username', 'offline-confirmed'])
    for (let index = 0; index < args.length; index++) {
      const flag = args[index].replace(/^--/, '')
      if (!args[index].startsWith('--') || !allowed.has(flag) || seen.has(flag)) fail('USAGE', 'Unknown or repeated option')
      seen.add(flag)
      const name = flag.replace(/-([a-z])/g, (_, value) => value.toUpperCase())
      if (flag === 'offline-confirmed') options[name] = true
      else { const value = args[++index]; if (!value || value.startsWith('--')) fail('USAGE', 'Missing option value'); options[name] = value }
    }
    console.log(JSON.stringify({ ok: true, exitCode: 0, ...await adoptPrivateSpace(options) }, null, 2))
  } catch (error) {
    const exitCode = error instanceof DataError ? error.exitCode : EXIT.IO
    console.log(JSON.stringify({ ok: false, exitCode, error: { kind: error instanceof DataError ? error.kind : 'IO', message: error.message, ...(error instanceof DataError ? { details: error.details } : { code: error.code ?? null }) } }, null, 2))
    process.exitCode = exitCode
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli()

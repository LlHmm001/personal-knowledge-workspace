#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DataError, EXIT, IDENTITY_V1_COLUMNS, inventory, inventoryContent, copyInventory, createSqliteCopy, inspectSqliteCopy, inspectData } from './data-preservation.mjs'

const fail = (kind, message, details = {}) => { throw new DataError(kind, message, details) }
const sha = data => createHash('sha256').update(data).digest('hex')
const json = value => JSON.stringify(value)
const hash = value => sha(json(value))
const same = (a, b) => json(a) === json(b)
const within = (root, path) => root === path || path.startsWith(root + sep)
const spacePattern = /^sp_[a-f0-9]{32}$/
const safePath = value => typeof value === 'string' && value !== '' && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..')
async function sync(path) { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
async function syncTree(root) { for (const item of await readdir(root, { withFileTypes: true })) { const path = join(root, item.name); if (item.isDirectory()) await syncTree(path); else await sync(path) }; await sync(root) }
async function save(path, value) { await writeFile(path, json(value) + '\n', { mode: 0o600, flag: 'wx' }); await sync(path) }
async function canonical(path) {
  if (!path || !isAbsolute(path)) fail('USAGE', 'An absolute canonical directory is required')
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== resolve(path)) fail('UNSAFE_PATH', 'Directory must not traverse a symlink')
  return resolve(path)
}
async function claim(path, forbidden) {
  if (!path || !isAbsolute(path)) fail('USAGE', 'A new absolute destination is required')
  path = resolve(path)
  if (await realpath(dirname(path)) !== dirname(path) || forbidden.some(root => within(root, path) || within(path, root))) fail('UNSAFE_PATH', 'Destination overlaps input or traverses a symlink')
  try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') fail('UNSAFE_PATH', 'Destination already exists; it will never be overwritten'); throw error }
  return path
}
async function withLock(root, action) {
  const path = join(root, 'gateway.lock'), body = json({ pid: process.pid, operation: 'collaboration-backup', nonce: randomUUID(), createdAt: new Date().toISOString() }) + '\n'
  const lock = await open(path, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') fail('UNSAFE_PATH', 'gateway.lock exists; stop the writer and inspect it, never steal a lock'); throw error })
  try { await lock.writeFile(body); await lock.sync(); await sync(root); return await action() } finally {
    const held = await lock.stat(); await lock.close()
    const current = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!current || current.ino !== held.ino || sha(await readFile(path)) !== sha(body)) fail('UNSAFE_PATH', 'gateway.lock was replaced; it was not removed')
    await unlink(path); await sync(root)
  }
}
async function rootInventory(root) {
  const value = await inventory(root)
  value.entries = value.entries.filter(entry => entry.path !== 'gateway.lock')
  // Maintenance lock creation/removal changes only root directory times/size.
  // Child membership and every canonical file's metadata remain fingerprinted.
  value.fingerprint = hash(value.entries.map(entry => entry.path === '' ? { ...entry, size: '0', mtimeNs: '0', ctimeNs: '0' } : entry))
  return value
}
async function unchanged(root, before) {
  let after
  try { after = await rootInventory(root) } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('SOURCE_CHANGED', 'Source was removed during capture'); throw error }
  if (after.fingerprint !== before.fingerprint) fail('SOURCE_CHANGED', 'Collaboration root changed; stop every writer and create a fresh backup')
}
async function isSqlite(path) { const file = await open(path, 'r'); try { const bytes = Buffer.alloc(16); await file.read(bytes, 0, 16, 0); return bytes.toString('binary') === 'SQLite format 3\0' } finally { await file.close() } }
function readIdentity(database) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    if (version !== 1 || !same(tables, ['accounts', 'audit', 'invitations', 'members', 'sessions', 'spaces'])) return null
    for (const [table, expected] of Object.entries(IDENTITY_V1_COLUMNS)) if (!same(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name), expected)) return null
    const accounts = db.prepare('SELECT id,username FROM accounts ORDER BY id').all().map(row => ({ ...row }))
    const spaces = db.prepare('SELECT id,name,kind,ownerId FROM spaces ORDER BY id').all().map(row => ({ ...row }))
    const members = db.prepare('SELECT spaceId,userId,role FROM members ORDER BY spaceId,userId').all().map(row => ({ ...row }))
    const issues = [], accountIds = new Set(accounts.map(row => row.id))
    for (const space of spaces) {
      const membership = members.filter(row => row.spaceId === space.id), owners = membership.filter(row => row.role === 'owner')
      if (!spacePattern.test(space.id) || !['private', 'team'].includes(space.kind) || !accountIds.has(space.ownerId) || owners.length !== 1 || owners[0].userId !== space.ownerId || (space.kind === 'private' && membership.length !== 1)) issues.push({ code: 'IDENTITY_SPACE_OWNERSHIP_INVALID', spaceId: space.id })
    }
    for (const member of members) if (!spaces.some(space => space.id === member.spaceId) || !accountIds.has(member.userId) || !['owner', 'admin', 'editor', 'viewer'].includes(member.role)) issues.push({ code: 'IDENTITY_MEMBER_REFERENCE_INVALID', spaceId: member.spaceId })
    return { version, accounts, spaces, members, membershipSha256: hash({ accounts, spaces, members }), sessions: Number(db.prepare('SELECT count(*) AS n FROM sessions').get().n), invitations: Number(db.prepare('SELECT count(*) AS n FROM invitations').get().n), auditRows: Number(db.prepare('SELECT count(*) AS n FROM audit').get().n), issues }
  } catch { return null } finally { db.close() }
}
async function analyze(root, databases, sourceEntries) {
  const issues = [], spaces = [], byPath = new Map(databases.map(db => [db.path, db]))
  const identityDb = byPath.get('identity.sqlite'), identity = identityDb ? readIdentity(join(root, identityDb.normalized)) : null
  if (!identity) issues.push({ code: 'UNKNOWN_IDENTITY_SCHEMA' })
  else issues.push(...identity.issues)
  const expected = new Set(['identity.sqlite']), paths = new Set(sourceEntries.map(entry => entry.path))
  if (paths.has('recovery-pending.json')) issues.push({ code: 'SOURCE_RECOVERY_PENDING' })
  if (sourceEntries.some(entry => entry.path.startsWith('.adopt-private-'))) issues.push({ code: 'INCOMPLETE_IMPORT_STAGING' })
  for (const space of identity?.spaces ?? []) {
    if (!spacePattern.test(space.id)) continue
    const directory = `spaces/${space.id}`, database = byPath.get(`${directory}/state.sqlite`)
    expected.add(`${directory}/state.sqlite`)
    if (!paths.has(directory)) { spaces.push({ spaceId: space.id, state: 'uninitialized' }); continue }
    if (!database || !paths.has(`${directory}/workspace`)) { issues.push({ code: 'PARTIAL_SPACE_CONTENT', spaceId: space.id }); spaces.push({ spaceId: space.id, state: 'blocked' }); continue }
    const report = await inspectData({ workspace: join(root, 'raw', directory, 'workspace'), state: join(root, database.normalized) })
    const reconciliation = report.reconciliation
    if (!reconciliation.readiness.preflightChecksPassed) for (const issue of reconciliation.issues) issues.push({ ...issue, spaceId: space.id })
    if (reconciliation.workspaceIds.length !== 1 || !database.units.some(unit => unit.name === 'workspace' && unit.version === 2)) issues.push({ code: 'SPACE_REGISTRY_NOT_UNIQUE_V2', spaceId: space.id })
    spaces.push({ spaceId: space.id, state: reconciliation.readiness.preflightChecksPassed ? 'initialized' : 'blocked', database: database.path, workspaceIds: reconciliation.workspaceIds, reconciliation })
  }
  for (const entry of sourceEntries.filter(entry => entry.type === 'directory' && /^spaces\/[^/]+$/.test(entry.path))) if (!identity?.spaces.some(space => entry.path === `spaces/${space.id}`)) issues.push({ code: 'ORPHAN_SPACE_DIRECTORY', path: entry.path })
  for (const database of databases) if (!expected.has(database.path)) issues.push({ code: 'UNKNOWN_DATABASE', path: database.path })
  return { identity, spaces, issues, readiness: { preflightChecksPassed: issues.length === 0, canStartGateway: false, membershipReviewRequired: true, runtimeAcceptance: 'not_run', blockers: [...new Set(issues.map(issue => issue.code))] } }
}
async function scanDatabases(root, snapshot, create, expected = []) {
  const databases = []
  for (const file of snapshot.entries.filter(entry => entry.type === 'file' && !/^spaces\/[^/]+\/workspace\//.test(entry.path))) if (await isSqlite(join(root, 'raw', file.path))) {
    const normalized = `sqlite/${sha(file.path)}.sqlite`
    let value
    if (create) {
      const scratch = await mkdtemp(join(tmpdir(), 'pkw-collab-sqlite-'))
      try { value = await createSqliteCopy(join(root, 'raw', file.path), join(root, normalized), scratch) } finally { await rm(scratch, { recursive: true, force: true }) }
    } else {
      const previous = expected.find(db => db.path === file.path)
      if (!previous || previous.normalized !== normalized) fail('INTEGRITY', 'Database manifest mapping differs')
      value = await inspectSqliteCopy(join(root, normalized))
      if (value.summary.logicalSha256 !== previous.logicalSha256) fail('INTEGRITY', 'Database logical content differs')
    }
    databases.push({ path: file.path, normalized, ...value.summary })
  }
  if (!create && databases.length !== expected.length) fail('INTEGRITY', 'Database inventory differs')
  return databases
}
async function load(options) {
  const root = await canonical(options.backup), bytes = await readFile(join(root, 'manifest.json'))
  if (options.manifestSha256 && sha(bytes) !== options.manifestSha256) fail('INTEGRITY', 'Manifest does not match the independently retained SHA-256')
  let manifest
  try { manifest = JSON.parse(bytes) } catch { fail('INTEGRITY', 'Invalid manifest JSON') }
  if (manifest.format !== 'pkw-collaboration-backup' || manifest.version !== 1 || manifest.status !== 'complete' || !Array.isArray(manifest.payload) || !Array.isArray(manifest.sourceInventory?.entries) || !Array.isArray(manifest.databases) || !isAbsolute(manifest.sourceRoot ?? '')) fail('INTEGRITY', 'Unsupported or incomplete manifest')
  for (const entries of [manifest.payload, manifest.sourceInventory.entries]) {
    const seen = new Set()
    for (const entry of entries) { if ((entry.path !== '' && !safePath(entry.path)) || seen.has(entry.path) || !['directory', 'file'].includes(entry.type)) fail('INTEGRITY', 'Unsafe manifest paths'); seen.add(entry.path) }
  }
  for (const db of manifest.databases) if (!safePath(db.path) || db.normalized !== `sqlite/${sha(db.path)}.sqlite`) fail('INTEGRITY', 'Unsafe database mapping')
  const sourceFingerprint = hash(manifest.sourceInventory.entries.map(entry => entry.path === '' ? { ...entry, size: '0', mtimeNs: '0', ctimeNs: '0' } : entry))
  if (sourceFingerprint !== manifest.sourceInventory.fingerprint) fail('INTEGRITY', 'Source fingerprint differs')
  return { root, manifest, manifestSha256: sha(bytes) }
}
function requireOffline(options) { if (options.offlineConfirmed !== true) fail('USAGE', '--offline-confirmed is required; stop gateway and all external writers') }
function requireBinding(options) { if (!/^[a-f0-9]{64}$/.test(options.manifestSha256 ?? '')) fail('USAGE', 'An independently retained --manifest-sha256 is required') }
export async function backupCollaboration(options, hooks = {}) {
  requireOffline(options)
  const sourceRoot = await canonical(options.dataRoot)
  return withLock(sourceRoot, async () => {
    const before = await rootInventory(sourceRoot), output = await claim(options.output, [sourceRoot])
    try {
      await copyInventory(sourceRoot, join(output, 'raw'), before)
      await mkdir(join(output, 'sqlite'), { mode: 0o700 })
      await hooks.onPhase?.('copied')
      await unchanged(sourceRoot, before)
      if (!same(inventoryContent(await inventory(join(output, 'raw'))), inventoryContent(before))) fail('INTEGRITY', 'Raw root copy differs')
      const databases = await scanDatabases(output, before, true), analysis = await analyze(output, databases, before.entries)
      await hooks.onPhase?.('analyzed')
      await unchanged(sourceRoot, before)
      const payload = inventoryContent(await inventory(output)).filter(entry => entry.path !== '')
      const manifest = { format: 'pkw-collaboration-backup', version: 1, status: 'complete', createdAt: new Date().toISOString(), sourceRoot, sourceInventory: before, databases, analysis, payload, offlineConfirmed: true, excluded: ['gateway.lock'], metadataPolicy: 'private restored permissions; original mode/mtime recorded, ACL/xattrs/UID/hardlinks not restored' }
      await syncTree(output); await hooks.onPhase?.('before-complete'); await unchanged(sourceRoot, before)
      await save(join(output, 'manifest.json'), manifest); await sync(output); await sync(dirname(output))
      return { operation: 'backup', backup: output, manifestSha256: sha(await readFile(join(output, 'manifest.json'))), sourceFingerprint: before.fingerprint, analysis }
    } catch (error) { await rm(output, { recursive: true, force: true }); throw error }
  })
}
export async function verifyCollaboration(options) {
  const loaded = await load(options), { root, manifest } = loaded
  const actual = inventoryContent(await inventory(root)).filter(entry => entry.path !== '' && entry.path !== 'manifest.json')
  if (!same(actual, manifest.payload) || !same(inventoryContent(await inventory(join(root, 'raw'))), inventoryContent(manifest.sourceInventory))) fail('INTEGRITY', 'Backup bytes, paths or file inventory differ')
  const databases = await scanDatabases(root, manifest.sourceInventory, false, manifest.databases), analysis = await analyze(root, databases, manifest.sourceInventory.entries)
  if (!same(analysis, manifest.analysis)) fail('INTEGRITY', 'Identity, permissions or space records differ from manifest')
  if (options.requireReady && !analysis.readiness.preflightChecksPassed) fail('NOT_READY', 'Backup is preserved but activation is blocked', { blockers: analysis.readiness.blockers })
  return { operation: 'verify', backup: root, manifestSha256: loaded.manifestSha256, sourceFingerprint: manifest.sourceInventory.fingerprint, byteIntegrity: 'passed', sqliteIntegrity: 'passed', analysis }
}
export async function verifyCollaborationSource(options) {
  requireOffline(options)
  const verified = await verifyCollaboration(options), { manifest } = await load(options)
  const root = await canonical(manifest.sourceRoot)
  return withLock(root, async () => { await unchanged(root, manifest.sourceInventory); return { ...verified, operation: 'verify-source', sourceUnchanged: true, checkedAt: new Date().toISOString(), keepWritersStopped: true } })
}
function unchangedTables(before, after, changed) {
  if (!same(before.schema, after.schema) || !same(before.units, after.units) || before.userVersion !== after.userVersion || before.tables.length !== after.tables.length) fail('INTEGRITY', 'Recovery changed schema or versions')
  for (const table of before.tables) if (!changed.has(table.name) && !same(table, after.tables.find(item => item.name === table.name))) fail('INTEGRITY', 'Recovery changed a protected table', { table: table.name })
}
async function relocate(database, workspaceId, newPath) {
  const before = (await inspectSqliteCopy(database)).summary, db = new DatabaseSync(database)
  let original, updated
  try {
    db.exec('BEGIN IMMEDIATE')
    const rows = db.prepare('SELECT key,value FROM u_workspace_workspaces').all()
    const global = JSON.parse(db.prepare("SELECT value FROM unit_globals WHERE unit='workspace'").get()?.value ?? 'null')
    if (rows.length !== 1 || rows[0].key !== workspaceId || global?.initialized !== true || !same(global.workspaceIds, [workspaceId]) || global.pendingMutation !== undefined) fail('NOT_READY', 'Cannot map an ambiguous workspace registry')
    original = JSON.parse(rows[0].value)
    updated = { ...original, path: newPath }
    db.prepare('UPDATE u_workspace_workspaces SET value=? WHERE key=?').run(json(updated), workspaceId)
    db.exec('COMMIT')
  } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error } finally { db.close() }
  const after = (await inspectSqliteCopy(database)).summary
  unchangedTables(before, after, new Set(['u_workspace_workspaces']))
  return { workspaceId, beforePath: original.path, afterPath: newPath, beforeLogicalSha256: before.logicalSha256, afterLogicalSha256: after.logicalSha256 }
}
async function invalidateCredentials(path) {
  const before = (await inspectSqliteCopy(path)).summary, identityBefore = readIdentity(path), db = new DatabaseSync(path)
  try { db.exec('BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM invitations; COMMIT') } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error } finally { db.close() }
  const after = (await inspectSqliteCopy(path)).summary, identityAfter = readIdentity(path)
  unchangedTables(before, after, new Set(['sessions', 'invitations']))
  if (!identityAfter || identityAfter.sessions !== 0 || identityAfter.invitations !== 0 || identityBefore.membershipSha256 !== identityAfter.membershipSha256) fail('INTEGRITY', 'Recovery changed membership or failed to revoke credentials')
  return { sessionsRevoked: identityBefore.sessions, invitationsRevoked: identityBefore.invitations, membershipSha256: identityAfter.membershipSha256, beforeLogicalSha256: before.logicalSha256, afterLogicalSha256: after.logicalSha256 }
}
export async function restoreCollaboration(options, hooks = {}) {
  requireOffline(options); requireBinding(options)
  const verified = await verifyCollaboration(options), { root: backup, manifest } = await load(options)
  const target = await claim(options.target, [backup, manifest.sourceRoot])
  let complete = false
  try {
    return await withLock(target, async () => {
      const operationId = randomUUID(), gatePath = join(target, 'recovery-pending.json')
      await save(gatePath, { format: 'pkw-recovery-pending', version: 1, status: 'incomplete', operationId })
      const scratch = await mkdtemp(join(dirname(target), '.pkw-root-recovery-'))
      try {
        const recovered = join(scratch, 'root'); await copyInventory(join(backup, 'raw'), recovered, manifest.sourceInventory)
        for (const database of manifest.databases) {
          const path = join(recovered, database.path)
          await rm(path); await copyFile(join(backup, database.normalized), path, constants.COPYFILE_EXCL); await chmod(path, 0o600)
          for (const suffix of ['-wal', '-shm', '-journal']) await rm(path + suffix, { force: true })
          if ((await inspectSqliteCopy(path)).summary.logicalSha256 !== database.logicalSha256) fail('INTEGRITY', 'Restored database differs from the normalized backup')
        }
        const mappings = []
        if (manifest.analysis.readiness.preflightChecksPassed) for (const space of manifest.analysis.spaces.filter(space => space.state === 'initialized')) mappings.push({ spaceId: space.spaceId, ...await relocate(join(recovered, space.database), space.workspaceIds[0], join(target, 'spaces', space.spaceId, 'workspace')) })
        const credentials = manifest.analysis.identity ? await invalidateCredentials(join(recovered, 'identity.sqlite')) : null
        const recoveryDir = join(recovered, '.recovery', operationId); await mkdir(recoveryDir, { recursive: true, mode: 0o700 })
        try { await rename(join(recovered, 'recovery-pending.json'), join(recoveryDir, 'previous-recovery-pending.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
        await hooks.onPhase?.('mapped')
        await verifyCollaboration({ backup, manifestSha256: options.manifestSha256 })
        // Compare every unaffected file directly with raw source bytes.
        const changedPaths = new Set(manifest.databases.flatMap(db => [db.path, ...['-wal', '-shm', '-journal'].map(suffix => db.path + suffix)]))
        changedPaths.add('recovery-pending.json')
        const recoveredEntries = (await inventory(recovered)).entries
        const expectedPaths = new Set(manifest.sourceInventory.entries.map(entry => entry.path))
        for (const entry of recoveredEntries) if (!expectedPaths.has(entry.path) && !['.recovery', `.recovery/${operationId}`, `.recovery/${operationId}/previous-recovery-pending.json`].includes(entry.path)) fail('INTEGRITY', 'Recovery has unexpected files or directories', { path: entry.path })
        const actualFiles = new Map(recoveredEntries.filter(entry => entry.type === 'file').map(entry => [entry.path, entry]))
        for (const file of manifest.sourceInventory.entries.filter(entry => entry.type === 'file' && !changedPaths.has(entry.path))) if (actualFiles.get(file.path)?.sha256 !== file.sha256) fail('INTEGRITY', 'Recovery changed a protected canonical file', { path: file.path })
        for (const database of manifest.databases) {
          const current = (await inspectSqliteCopy(join(recovered, database.path))).summary
          const expected = database.path === 'identity.sqlite' && credentials ? credentials.afterLogicalSha256 : mappings.find(mapping => database.path === `spaces/${mapping.spaceId}/state.sqlite`)?.afterLogicalSha256 ?? database.logicalSha256
          if (current.logicalSha256 !== expected) fail('INTEGRITY', 'Recovered database changed after validation')
        }
        await syncTree(recovered)
        const expectedPublication = inventoryContent(await inventory(recovered))
        for (const name of await readdir(recovered)) await rename(join(recovered, name), join(target, name))
        await hooks.onPhase?.('published')
        if (!same(inventoryContent(await rootInventory(target)).filter(entry => entry.path !== 'recovery-pending.json'), expectedPublication)) fail('INTEGRITY', 'Published root changed before the recovery receipt')
        const receiptPath = `.recovery/${operationId}/receipt.json`
        const restoredInventory = inventoryContent(await rootInventory(target)).filter(entry => entry.path !== 'recovery-pending.json')
        const receipt = { format: 'pkw-collaboration-recovery', version: 1, status: 'complete', createdAt: new Date().toISOString(), operationId, backup, manifestSha256: options.manifestSha256, sourceRoot: manifest.sourceRoot, target, mappings, credentials, analysis: manifest.analysis, restoredInventory, activationBlocked: true, membershipsReviewed: false, canApprove: manifest.analysis.readiness.preflightChecksPassed && credentials !== null, runtimeAcceptance: 'not_run', oldSourceModified: false }
        await save(join(target, receiptPath), receipt)
        const receiptSha256 = sha(await readFile(join(target, receiptPath)))
        const nextGate = join(target, `.recovery-pending-${operationId}.tmp`)
        await save(nextGate, { format: 'pkw-recovery-pending', version: 1, status: 'complete', operationId, receiptPath, receiptSha256, canApprove: receipt.canApprove, membershipSha256: credentials?.membershipSha256 ?? null })
        await hooks.onPhase?.('gate-ready')
        await rename(nextGate, gatePath); await sync(target)
        await syncTree(target); await sync(dirname(target)); complete = true
        return { operation: 'restore', target, recoveryReceipt: join(target, receiptPath), receiptSha256, activationBlocked: true, canApprove: receipt.canApprove, credentials, mappings, runtimeAcceptance: 'not_run' }
      } finally { await rm(scratch, { recursive: true, force: true }) }
    })
  } finally { if (!complete) await rm(target, { recursive: true, force: true }) }
}
export async function approveRecovery(options) {
  requireOffline(options)
  if (options.reviewedMemberships !== true) fail('USAGE', '--reviewed-memberships is required: review restored owners and member roles first')
  const root = await canonical(options.dataRoot)
  return withLock(root, async () => {
    let gate
    try { gate = JSON.parse(await readFile(join(root, 'recovery-pending.json'), 'utf8')) } catch { fail('NOT_READY', 'No complete recovery gate exists') }
    if (gate.format !== 'pkw-recovery-pending' || gate.version !== 1 || gate.status !== 'complete' || !safePath(gate.receiptPath) || gate.canApprove !== true) fail('NOT_READY', 'Recovery is incomplete or has schema/reference blockers; approval cannot override them')
    const bytes = await readFile(join(root, gate.receiptPath))
    if (sha(bytes) !== gate.receiptSha256) fail('INTEGRITY', 'Recovery receipt changed')
    const receipt = JSON.parse(bytes)
    if (receipt.target !== root || receipt.operationId !== gate.operationId || receipt.canApprove !== true) fail('INTEGRITY', 'Recovery receipt does not match this root')
    const approvalRelative = gate.receiptPath.replace(/receipt\.json$/, 'approval.json')
    let priorApproval
    try { priorApproval = JSON.parse(await readFile(join(root, approvalRelative), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') fail('INTEGRITY', 'Incomplete approval receipt requires review') }
    if (priorApproval && (priorApproval.format !== 'pkw-recovery-approval' || priorApproval.operationId !== gate.operationId || priorApproval.reviewedMemberships !== true || priorApproval.recoveryReceiptSha256 !== gate.receiptSha256 || priorApproval.membershipSha256 !== gate.membershipSha256)) fail('INTEGRITY', 'Previous approval does not match recovery')
    const expected = receipt.restoredInventory
    const actual = inventoryContent(await rootInventory(root)).filter(entry => entry.path !== 'recovery-pending.json' && entry.path !== gate.receiptPath && (!priorApproval || entry.path !== approvalRelative))
    if (!same(actual, expected)) fail('SOURCE_CHANGED', 'Restored files changed after recovery; do not approve an unverified root')
    const identity = readIdentity(join(root, 'identity.sqlite'))
    if (!identity || identity.issues.length || identity.membershipSha256 !== gate.membershipSha256 || identity.sessions || identity.invitations) fail('NOT_READY', 'Restored permissions or revoked credentials differ; review/recover again')
    const approval = { format: 'pkw-recovery-approval', version: 1, operationId: gate.operationId, approvedAt: new Date().toISOString(), reviewedMemberships: true, reviewedIdentity: { accounts: identity.accounts, spaces: identity.spaces, members: identity.members }, membershipSha256: identity.membershipSha256, recoveryReceiptSha256: gate.receiptSha256, runtimeAcceptance: 'not_run' }
    const approvalPath = join(dirname(join(root, gate.receiptPath)), 'approval.json')
    if (!priorApproval) await save(approvalPath, approval); await sync(dirname(approvalPath))
    await unlink(join(root, 'recovery-pending.json')); await sync(root)
    return { operation: 'approve-recovery', dataRoot: root, approvalReceipt: approvalPath, activationBlocked: false, runtimeAcceptance: 'not_run' }
  })
}
const commands = { backup: backupCollaboration, verify: verifyCollaboration, 'verify-source': verifyCollaborationSource, restore: restoreCollaboration, 'approve-recovery': approveRecovery }
async function cli() {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === '--help') { console.log(json({ ok: true, exitCode: 0, commands: { backup: '--data-root ABS --output NEW --offline-confirmed', verify: '--backup ABS [--manifest-sha256 HEX] [--require-ready]', 'verify-source': '--backup ABS --offline-confirmed [--manifest-sha256 HEX]', restore: '--backup ABS --manifest-sha256 HEX --target NEW --offline-confirmed', 'approve-recovery': '--data-root ABS --offline-confirmed --reviewed-memberships' }, exitCodes: EXIT })); return }
    if (!commands[command]) fail('USAGE', 'Unknown command; use --help')
    const allowed = { backup: ['data-root', 'output', 'offline-confirmed'], verify: ['backup', 'manifest-sha256', 'require-ready'], 'verify-source': ['backup', 'manifest-sha256', 'offline-confirmed', 'require-ready'], restore: ['backup', 'manifest-sha256', 'target', 'offline-confirmed'], 'approve-recovery': ['data-root', 'offline-confirmed', 'reviewed-memberships'] }
    const options = {}, seen = new Set()
    for (let index = 0; index < args.length; index++) {
      const flag = args[index].replace(/^--/, '')
      if (!args[index].startsWith('--') || !allowed[command].includes(flag) || seen.has(flag)) fail('USAGE', 'Unknown or repeated option')
      seen.add(flag); const key = flag.replace(/-([a-z])/g, (_, character) => character.toUpperCase())
      if (['offline-confirmed', 'reviewed-memberships', 'require-ready'].includes(flag)) options[key] = true
      else { const value = args[++index]; if (!value || value.startsWith('--')) fail('USAGE', 'Missing option value'); options[key] = value }
    }
    console.log(json({ ok: true, exitCode: 0, ...await commands[command](options) }))
  } catch (error) { const exitCode = error instanceof DataError ? error.exitCode : EXIT.IO; console.log(json({ ok: false, exitCode, error: { kind: error instanceof DataError ? error.kind : 'IO', message: error.message, ...(error instanceof DataError ? { details: error.details } : { code: error.code ?? null }) } })); process.exitCode = exitCode }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli()

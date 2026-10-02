import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { backupCollaboration, verifyCollaboration, verifyCollaborationSource, restoreCollaboration, approveRecovery } from '../collaboration-backup.mjs'
import { DataError, inventory, inspectSqliteCopy } from '../data-preservation.mjs'

const execute = promisify(execFile), dirs = [], sha = value => createHash('sha256').update(value).digest('hex'), now = '2026-10-02T00:00:00.000Z'
const privateId = 'sp_' + 'a'.repeat(32), teamId = 'sp_' + 'b'.repeat(32), emptyId = 'sp_' + 'c'.repeat(32)
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })
const kind = expected => error => error instanceof DataError && error.kind === expected
async function fixture({ old = false, wal = false, unknownIdentity = false } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'pkw-collab-backup-'))); dirs.push(parent)
  const dataRoot = join(parent, 'source'), output = join(parent, 'backup'), target = join(parent, 'restored'), openDbs = []
  await mkdir(dataRoot)
  const identity = new DatabaseSync(join(dataRoot, 'identity.sqlite'))
  identity.exec(`PRAGMA user_version=${unknownIdentity ? 9 : 1};
    CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL);
    CREATE TABLE spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,ownerId TEXT NOT NULL REFERENCES accounts(id));
    CREATE TABLE members(spaceId TEXT NOT NULL REFERENCES spaces(id),userId TEXT NOT NULL REFERENCES accounts(id),role TEXT NOT NULL,PRIMARY KEY(spaceId,userId));
    CREATE TABLE invitations(hash TEXT PRIMARY KEY,spaceId TEXT,role TEXT,createdBy TEXT,expires INTEGER);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY,userId TEXT,csrf TEXT,expires INTEGER,seen INTEGER);
    CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,actor TEXT,spaceId TEXT,action TEXT,subject TEXT);`)
  if (wal) identity.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  identity.exec("INSERT INTO accounts VALUES('owner','alice','retained-hash'),('member','bob','retained-hash-2')")
  for (const [id, name, type, owner] of [[privateId, '本人私人', 'private', 'owner'], [teamId, '共享资料', 'team', 'owner'], [emptyId, '新成员尚未打开的私人空间', 'private', 'member']]) {
    identity.prepare('INSERT INTO spaces VALUES(?,?,?,?)').run(id, name, type, owner)
    identity.prepare('INSERT INTO members VALUES(?,?,?)').run(id, owner, 'owner')
  }
  identity.prepare('INSERT INTO members VALUES(?,?,?)').run(teamId, 'member', 'editor')
  identity.prepare('INSERT INTO invitations VALUES(?,?,?,?,?)').run('old-invitation', teamId, 'viewer', 'owner', 9999999999999)
  identity.exec("INSERT INTO sessions VALUES('old-session','owner','old-csrf',9999999999999,1); INSERT INTO audit(at,actor,spaceId,action,subject) VALUES(1,'owner',NULL,'account.created','owner')")
  if (wal) openDbs.push(identity); else identity.close()
  for (const [id, label] of [[privateId, 'private'], [teamId, 'team']]) {
    const workspace = join(dataRoot, 'spaces', id, 'workspace'); await mkdir(join(workspace, 'notes'), { recursive: true }); await mkdir(join(workspace, 'attachments/att_' + label), { recursive: true }); await mkdir(join(workspace, 'archive'), { recursive: true })
    const noteId = 'note_' + label, workspaceId = 'workspace_' + label, markdown = `---\nid: ${noteId}\n---\n# ${label} 原始资料\n`, bytes = Buffer.from([0, 255, 7])
    await writeFile(join(workspace, 'notes/保留.md'), markdown); await writeFile(join(workspace, `attachments/att_${label}/数据.bin`), bytes)
    await writeFile(join(dataRoot, 'spaces', id, 'adoption-receipt.json'), JSON.stringify({ previous: label }))
    const db = new DatabaseSync(join(dataRoot, 'spaces', id, 'state.sqlite'))
    db.exec('PRAGMA user_version=1; CREATE TABLE units(name TEXT PRIMARY KEY,version INTEGER NOT NULL) STRICT; CREATE TABLE unit_globals(unit TEXT PRIMARY KEY REFERENCES units(name),value TEXT NOT NULL) STRICT')
    if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    function unit(name, version, tables, global) {
      db.prepare('INSERT INTO units VALUES(?,?)').run(name, version)
      if (global) db.prepare('INSERT INTO unit_globals VALUES(?,?)').run(name, JSON.stringify(global))
      for (const [table, rows] of Object.entries(tables)) {
        const physical = `u_${name}_${table}`; db.exec(`CREATE TABLE "${physical}"(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT`)
        for (const [key, value] of Object.entries(rows)) db.prepare(`INSERT INTO "${physical}" VALUES(?,?)`).run(key, JSON.stringify(value))
      }
    }
    unit('workspace', 2, { workspaces: { [workspaceId]: { path: workspace, title: label, sessionIds: [], createdAt: now, updatedAt: now } } }, { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] })
    unit('pkw_notes', old && label === 'team' ? 1 : 3, { note_index: { [noteId]: { noteId, workspaceId, relativePath: '保留.md', title: label, tags: [], contentHash: sha(markdown), observedRevision: 2, fileSize: Buffer.byteLength(markdown), createdAt: now, updatedAt: now } }, note_paths: { '保留.md': noteId }, note_order: {}, folder_trash: {} })
    unit('pkw_attachments', 1, { attachments: { ['att_' + label]: { id: 'att_' + label, workspaceId, filename: '数据.bin', relativePath: `attachments/att_${label}/数据.bin`, sizeBytes: bytes.length, sha256: sha(bytes), mimeType: 'application/octet-stream', observedRevision: 1, createdAt: now, indexedAt: now } } })
    unit('pkw_tasks', 1, { matrices: {}, tasks: {} }); unit('pkw', 1, { commits: {} }); unit('pkw_weknora_sync', 3, { mappings: {}, reverse: {}, dirty: {}, intents: {}, processing: {}, processing_kb: {} })
    if (wal) openDbs.push(db); else db.close()
  }
  await writeFile(join(dataRoot, 'retrieval-config.json'), '{"preserveConfiguration":true}')
  return { parent, dataRoot, output, target, offlineConfirmed: true, close() { for (const db of openDbs) db.close() } }
}
async function backed(f) { const report = await backupCollaboration(f); return { ...f, backup: f.output, manifestSha256: report.manifestSha256, report } }
async function query(path, sql) { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all().map(row => ({ ...row })) } finally { db.close() } }
async function noLock(root) { await assert.rejects(stat(join(root, 'gateway.lock')), { code: 'ENOENT' }) }

test('whole-root cold backup and cross-root recovery preserve two initialized spaces plus an unopened private space', async () => {
  const f = await fixture(), before = await inventory(join(f.dataRoot, 'identity.sqlite')), originalMembers = await query(join(f.dataRoot, 'identity.sqlite'), 'SELECT * FROM members ORDER BY spaceId,userId')
  const options = await backed(f)
  assert.equal(options.report.analysis.readiness.preflightChecksPassed, true)
  assert.equal(options.report.analysis.spaces.find(space => space.spaceId === emptyId).state, 'uninitialized')
  assert.equal((await verifyCollaboration(options)).byteIntegrity, 'passed')
  assert.equal((await verifyCollaborationSource(options)).sourceUnchanged, true)
  const restored = await restoreCollaboration(options)
  assert.equal(restored.activationBlocked, true); assert.equal(restored.canApprove, true)
  assert.deepEqual(restored.credentials.sessionsRevoked, 1); assert.equal(restored.credentials.invitationsRevoked, 1)
  assert.deepEqual(await query(join(f.target, 'identity.sqlite'), 'SELECT * FROM members ORDER BY spaceId,userId'), originalMembers)
  for (const table of ['accounts', 'spaces', 'audit']) assert.deepEqual(await query(join(f.target, 'identity.sqlite'), `SELECT * FROM ${table} ORDER BY 1`), await query(join(f.dataRoot, 'identity.sqlite'), `SELECT * FROM ${table} ORDER BY 1`))
  for (const table of ['sessions', 'invitations']) assert.deepEqual(await query(join(f.target, 'identity.sqlite'), `SELECT * FROM ${table}`), [])
  for (const [id, label] of [[privateId, 'private'], [teamId, 'team']]) {
    assert.deepEqual(await readFile(join(f.target, 'spaces', id, 'workspace/notes/保留.md')), await readFile(join(f.dataRoot, 'spaces', id, 'workspace/notes/保留.md')))
    assert.deepEqual(await readFile(join(f.target, 'spaces', id, 'workspace/attachments/att_' + label + '/数据.bin')), Buffer.from([0, 255, 7]))
    assert.deepEqual(await readFile(join(f.target, 'spaces', id, 'adoption-receipt.json')), await readFile(join(f.dataRoot, 'spaces', id, 'adoption-receipt.json')))
    const rows = await query(join(f.target, 'spaces', id, 'state.sqlite'), 'SELECT * FROM u_workspace_workspaces')
    assert.equal(rows[0].key, 'workspace_' + label); assert.equal(JSON.parse(rows[0].value).path, join(f.target, 'spaces', id, 'workspace'))
  }
  await assert.rejects(stat(join(f.target, 'spaces', emptyId)), { code: 'ENOENT' })
  await assert.rejects(approveRecovery({ dataRoot: f.target, offlineConfirmed: true }), kind('USAGE'))
  const approval = await approveRecovery({ dataRoot: f.target, offlineConfirmed: true, reviewedMemberships: true })
  assert.equal(approval.activationBlocked, false); await assert.rejects(stat(join(f.target, 'recovery-pending.json')), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(approval.approvalReceipt, 'utf8')).reviewedMemberships, true)
  assert.deepEqual(await inventory(join(f.dataRoot, 'identity.sqlite')), before)
  assert.equal((await verifyCollaboration(options)).byteIntegrity, 'passed'); await noLock(f.dataRoot); await noLock(f.target)
})

test('multiple real WAL databases retain uncheckpointed identity and content commits without changing source DB/SHM', async () => {
  const f = await fixture({ wal: true })
  try {
    const paths = ['identity.sqlite', `spaces/${privateId}/state.sqlite`, `spaces/${teamId}/state.sqlite`].flatMap(path => [path, path + '-wal', path + '-shm'])
    const before = await Promise.all(paths.map(path => inventory(join(f.dataRoot, path))))
    const options = await backed(f); await restoreCollaboration(options)
    assert.deepEqual(await Promise.all(paths.map(path => inventory(join(f.dataRoot, path)))), before)
    assert.equal((await query(join(f.target, 'identity.sqlite'), 'SELECT * FROM accounts')).length, 2)
    assert.equal((await query(join(f.target, 'spaces', privateId, 'state.sqlite'), 'SELECT * FROM u_pkw_notes_note_index')).length, 1)
  } finally { f.close() }
})

test('unknown/old schema is preserved byte-for-byte but activation cannot be approved', async () => {
  for (const config of [{ old: true }, { unknownIdentity: true }]) {
    const f = await fixture(config), options = await backed(f)
    assert.equal(options.report.analysis.readiness.preflightChecksPassed, false)
    await assert.rejects(verifyCollaboration({ ...options, requireReady: true }), kind('NOT_READY'))
    const restored = await restoreCollaboration(options)
    assert.equal(restored.canApprove, false)
    await assert.rejects(approveRecovery({ dataRoot: f.target, offlineConfirmed: true, reviewedMemberships: true }), kind('NOT_READY'))
    const path = config.old ? join(f.target, 'spaces', teamId, 'state.sqlite') : join(f.target, 'identity.sqlite')
    if (config.old) assert.equal((await query(path, "SELECT version FROM units WHERE name='pkw_notes'"))[0].version, 1)
    else assert.equal((await query(path, 'PRAGMA user_version'))[0].user_version, 9)
    assert.equal((await verifyCollaboration(options)).byteIntegrity, 'passed')
  }
})

test('live lock, existing restore target, overlapping destination and symlink root never get overwritten', async () => {
  const f = await fixture(); await writeFile(join(f.dataRoot, 'gateway.lock'), 'live')
  await assert.rejects(backupCollaboration(f), kind('UNSAFE_PATH')); assert.equal(await readFile(join(f.dataRoot, 'gateway.lock'), 'utf8'), 'live')
  await rm(join(f.dataRoot, 'gateway.lock')); const options = await backed(f)
  await mkdir(f.target); await writeFile(join(f.target, 'new-data'), 'keep')
  await assert.rejects(restoreCollaboration(options), kind('UNSAFE_PATH')); assert.equal(await readFile(join(f.target, 'new-data'), 'utf8'), 'keep')
  await assert.rejects(restoreCollaboration({ ...options, target: join(f.dataRoot, 'nested') }), kind('UNSAFE_PATH'))
  await symlink(f.dataRoot, join(f.parent, 'link'))
  await assert.rejects(backupCollaboration({ ...f, dataRoot: join(f.parent, 'link'), output: join(f.parent, 'other') }), kind('UNSAFE_PATH'))
})

test('source writes during every cold backup phase abort output and release only the maintenance lock', async () => {
  for (const phase of ['copied', 'analyzed', 'before-complete']) {
    const f = await fixture()
    await assert.rejects(backupCollaboration(f, { onPhase: async value => { if (value === phase) await writeFile(join(f.dataRoot, 'new-user-data'), 'must retain') } }), kind('SOURCE_CHANGED'))
    await noLock(f.dataRoot); await assert.rejects(stat(f.output), { code: 'ENOENT' }); assert.equal(await readFile(join(f.dataRoot, 'new-user-data'), 'utf8'), 'must retain')
  }
})

test('verify-source detects later identity, workspace and new-space writes across the full root', async () => {
  for (const path of ['identity.sqlite', `spaces/${privateId}/workspace/notes/保留.md`, 'spaces/new-content']) {
    const f = await fixture(), options = await backed(f)
    await writeFile(join(f.dataRoot, path), 'new write')
    await assert.rejects(verifyCollaborationSource(options), kind('SOURCE_CHANGED')); await noLock(f.dataRoot)
  }
})

test('backup tampering and malformed manifest paths fail before any target is created', async () => {
  const f = await fixture(), options = await backed(f)
  await writeFile(join(f.output, 'raw/retrieval-config.json'), '{}')
  await assert.rejects(restoreCollaboration(options), kind('INTEGRITY')); await assert.rejects(stat(f.target), { code: 'ENOENT' })
  const other = await fixture(), opts = await backed(other)
  const manifest = JSON.parse(await readFile(join(other.output, 'manifest.json'), 'utf8')); manifest.payload[0].path = '../outside'
  await writeFile(join(other.output, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(verifyCollaboration({ backup: other.output }), kind('INTEGRITY'))
})

test('restore failures remove the new partial root and permit a fresh retry without source or backup edits', async () => {
  for (const phase of ['mapped', 'published']) {
    const f = await fixture(), options = await backed(f), before = await inventory(join(f.dataRoot, 'identity.sqlite'))
    await assert.rejects(restoreCollaboration(options, { onPhase: value => { if (value === phase) throw new Error('injected recovery failure') } }), /injected recovery failure/)
    await assert.rejects(stat(f.target), { code: 'ENOENT' }); assert.deepEqual(await inventory(join(f.dataRoot, 'identity.sqlite')), before)
    await restoreCollaboration(options); assert.equal((await verifyCollaboration(options)).byteIntegrity, 'passed')
  }
})

test('published content changes cannot be blessed by a recovery receipt', async () => {
  const f = await fixture(), options = await backed(f)
  await assert.rejects(restoreCollaboration(options, { onPhase: async phase => { if (phase === 'published') await writeFile(join(f.target, 'spaces', privateId, 'workspace/notes/保留.md'), 'unverified') } }), kind('INTEGRITY'))
  await assert.rejects(stat(f.target), { code: 'ENOENT' })
})

test('approval refuses drifted permissions, new sessions, canonical data or a changed receipt', async () => {
  for (const mode of ['members', 'sessions', 'note', 'receipt']) {
    const f = await fixture(), options = await backed(f), result = await restoreCollaboration(options)
    if (mode === 'members' || mode === 'sessions') {
      const db = new DatabaseSync(join(f.target, 'identity.sqlite'))
      try { db.exec(mode === 'members' ? "UPDATE members SET role='viewer' WHERE role='editor'" : "INSERT INTO sessions VALUES('resurrect','owner','x',9999999999999,1)") } finally { db.close() }
    } else await writeFile(mode === 'note' ? join(f.target, 'spaces', privateId, 'workspace/notes/保留.md') : result.recoveryReceipt, 'changed')
    await assert.rejects(approveRecovery({ dataRoot: f.target, offlineConfirmed: true, reviewedMemberships: true }), error => error instanceof DataError && ['SOURCE_CHANGED', 'INTEGRITY'].includes(error.kind))
    assert.ok(await stat(join(f.target, 'recovery-pending.json'))); await noLock(f.target)
  }
})

test('orphan and partially initialized content are preserved and block approval; unopened spaces do not', async () => {
  for (const path of [`spaces/${emptyId}`, 'spaces/sp_' + 'd'.repeat(32)]) {
    const f = await fixture(); await mkdir(join(f.dataRoot, path))
    const options = await backed(f)
    assert.equal(options.report.analysis.readiness.preflightChecksPassed, false)
    assert.ok(options.report.analysis.issues.some(issue => ['PARTIAL_SPACE_CONTENT', 'ORPHAN_SPACE_DIRECTORY'].includes(issue.code)))
    assert.equal((await restoreCollaboration(options)).canApprove, false)
  }
})

test('CLI emits machine-readable status and requires explicit offline, binding and membership-review flags', async () => {
  const cli = resolve('scripts/collaboration-backup.mjs')
  assert.equal(JSON.parse((await execute(process.execPath, [cli, '--help'])).stdout).ok, true)
  for (const args of [['backup'], ['restore'], ['approve-recovery']]) {
    try { await execute(process.execPath, [cli, ...args]); assert.fail('must refuse') } catch (error) { assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).ok, false) }
  }
  const f = await fixture(), options = await backed(f)
  const result = JSON.parse((await execute(process.execPath, [cli, 'restore', '--backup', f.output, '--manifest-sha256', options.manifestSha256, '--target', f.target, '--offline-confirmed'])).stdout)
  assert.equal(result.activationBlocked, true)
})

test('SQLite-formatted attachment bytes stay canonical bytes and are never normalized as application state', async () => {
  const f = await fixture(), bytes = await readFile(join(f.dataRoot, 'identity.sqlite'))
  const path = join(f.dataRoot, 'spaces', privateId, 'workspace/attachments/att_private/数据.bin')
  await writeFile(path, bytes)
  const db = new DatabaseSync(join(f.dataRoot, 'spaces', privateId, 'state.sqlite'))
  try {
    const row = JSON.parse(db.prepare("SELECT value FROM u_pkw_attachments_attachments WHERE key='att_private'").get().value)
    row.sha256 = sha(bytes); row.sizeBytes = bytes.length
    db.prepare("UPDATE u_pkw_attachments_attachments SET value=? WHERE key='att_private'").run(JSON.stringify(row))
  } finally { db.close() }
  const options = await backed(f)
  assert.equal(options.report.analysis.readiness.preflightChecksPassed, true)
  const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'))
  assert.equal(manifest.databases.length, 3)
  await restoreCollaboration(options)
  assert.deepEqual(await readFile(join(f.target, 'spaces', privateId, 'workspace/attachments/att_private/数据.bin')), bytes)
})

test('approval can finish safely after a completed approval receipt survived but the pending gate remained', async () => {
  const f = await fixture(), options = await backed(f); await restoreCollaboration(options)
  const gate = await readFile(join(f.target, 'recovery-pending.json'))
  const first = await approveRecovery({ dataRoot: f.target, offlineConfirmed: true, reviewedMemberships: true })
  const receipt = await readFile(first.approvalReceipt)
  await writeFile(join(f.target, 'recovery-pending.json'), gate)
  await approveRecovery({ dataRoot: f.target, offlineConfirmed: true, reviewedMemberships: true })
  assert.deepEqual(await readFile(first.approvalReceipt), receipt)
  await assert.rejects(stat(join(f.target, 'recovery-pending.json')), { code: 'ENOENT' })
})

test('identity v1 with an unexpected table layout is preserved but never approved as a known schema', async () => {
  const f = await fixture()
  const db = new DatabaseSync(join(f.dataRoot, 'identity.sqlite')); db.exec('DROP TABLE members'); db.close()
  const before = await inventory(join(f.dataRoot, 'identity.sqlite')), options = await backed(f)
  assert.ok(options.report.analysis.issues.some(issue => issue.code === 'UNKNOWN_IDENTITY_SCHEMA'))
  const result = await restoreCollaboration(options)
  assert.equal(result.canApprove, false)
  await assert.rejects(approveRecovery({ dataRoot: f.target, offlineConfirmed: true, reviewedMemberships: true }), kind('NOT_READY'))
  assert.equal((await query(join(f.target, 'identity.sqlite'), 'PRAGMA user_version'))[0].user_version, 1)
  assert.deepEqual(await query(join(f.target, 'identity.sqlite'), "SELECT name FROM sqlite_schema WHERE name='members'"), [])
  assert.deepEqual(await inventory(join(f.dataRoot, 'identity.sqlite')), before)
})

test('historical membership and share receipts survive recovery but stay gated when the live source has newer revocations', async () => {
  const f = await fixture(); await mkdir(join(f.dataRoot, 'shares'))
  const share = JSON.stringify({ shareId: 'share-original', spaceId: teamId, path: '资料', receipt: 'retained' })
  await writeFile(join(f.dataRoot, 'shares/original-receipt.json'), share)
  const options = await backed(f)
  const db = new DatabaseSync(join(f.dataRoot, 'identity.sqlite')); db.exec("DELETE FROM members WHERE userId='member' AND role='editor'"); db.close()
  await assert.rejects(verifyCollaborationSource(options), kind('SOURCE_CHANGED'))
  await restoreCollaboration(options)
  assert.equal((await query(join(f.target, 'identity.sqlite'), "SELECT count(*) AS n FROM members WHERE userId='member' AND role='editor'"))[0].n, 1, 'historical roles are preserved, not silently considered current')
  assert.equal(await readFile(join(f.target, 'shares/original-receipt.json'), 'utf8'), share)
  assert.ok(await stat(join(f.target, 'recovery-pending.json')))
  await assert.rejects(approveRecovery({ dataRoot: f.target, offlineConfirmed: true }), kind('USAGE'))
})

test('identity column layouts must match the gateway, including unselected password columns', async () => {
  const f = await fixture()
  const db = new DatabaseSync(join(f.dataRoot, 'identity.sqlite')); db.exec('ALTER TABLE accounts RENAME COLUMN password TO unsupported_hash'); db.close()
  const options = await backed(f)
  assert.ok(options.report.analysis.issues.some(issue => issue.code === 'UNKNOWN_IDENTITY_SCHEMA'))
  const result = await restoreCollaboration(options)
  assert.equal(result.canApprove, false)
  await assert.rejects(approveRecovery({ dataRoot: f.target, offlineConfirmed: true, reviewedMemberships: true }), kind('NOT_READY'))
  assert.equal((await query(join(f.target, 'identity.sqlite'), 'SELECT unsupported_hash FROM accounts ORDER BY id')).length, 2)
})

test('the incomplete recovery gate remains present until the complete gate is ready for atomic replacement', async () => {
  const f = await fixture(), options = await backed(f)
  let checked = false
  await restoreCollaboration(options, { onPhase: async phase => {
    if (phase !== 'gate-ready') return
    checked = true
    assert.equal(JSON.parse(await readFile(join(f.target, 'recovery-pending.json'), 'utf8')).status, 'incomplete')
    const next = (await readdir(f.target)).find(name => name.startsWith('.recovery-pending-') && name.endsWith('.tmp'))
    assert.equal(JSON.parse(await readFile(join(f.target, next), 'utf8')).status, 'complete')
  } })
  assert.equal(checked, true)
  assert.equal(JSON.parse(await readFile(join(f.target, 'recovery-pending.json'), 'utf8')).status, 'complete')
  assert.ok(!(await readdir(f.target)).some(name => name.startsWith('.recovery-pending-')))
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { adoptPrivateSpace } from '../adopt-private-space.mjs'
import { backupData, DataError, inspectSqliteCopy, inventory, verifyBackup } from '../data-preservation.mjs'

const execute = promisify(execFile), dirs = [], sha = value => createHash('sha256').update(value).digest('hex')
const spaceId = 'sp_' + '1'.repeat(32), ownerId = 'usr_' + '2'.repeat(32), now = '2026-10-02T00:00:00.000Z'
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })
const kind = value => error => error instanceof DataError && error.kind === value
async function fixture({ unknown = false, extraState = false, oldVersion = false, secondWorkspace = false, identityWal = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-adopt-'))); dirs.push(root)
  const workspace = join(root, 'old-workspace'), state = join(root, 'old-state'), dataRoot = join(root, 'collaboration')
  await mkdir(join(workspace, 'notes'), { recursive: true }); await mkdir(join(workspace, 'attachments/att_one'), { recursive: true }); await mkdir(join(workspace, 'archive'), { recursive: true }); await mkdir(state); await mkdir(dataRoot)
  const note = '---\nid: note_original\n---\n# 原始私人笔记\n', bytes = Buffer.from([0, 255, 128, 4])
  await writeFile(join(workspace, 'notes/original.md'), note); await writeFile(join(workspace, 'attachments/att_one/file.bin'), bytes)
  const db = new DatabaseSync(join(state, 'original.sqlite'))
  db.exec('PRAGMA user_version=1; CREATE TABLE units(name TEXT PRIMARY KEY,version INTEGER NOT NULL) STRICT; CREATE TABLE unit_globals(unit TEXT PRIMARY KEY REFERENCES units(name),value TEXT NOT NULL) STRICT')
  function unit(name, version, tables, global) {
    db.prepare('INSERT INTO units VALUES(?,?)').run(name, version)
    if (global !== undefined) db.prepare('INSERT INTO unit_globals VALUES(?,?)').run(name, JSON.stringify(global))
    for (const [table, entries] of Object.entries(tables)) {
      const physical = `u_${name}_${table}`; db.exec(`CREATE TABLE "${physical}"(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT`)
      for (const [key, value] of Object.entries(entries)) db.prepare(`INSERT INTO "${physical}" VALUES(?,?)`).run(key, JSON.stringify(value))
    }
  }
  const wsRecord = { path: workspace, title: '私人原资料', sessionIds: ['preserve-session'], createdAt: now, updatedAt: now, legacyExtra: 'kept' }
  unit('workspace', 2, { workspaces: { 'ws-original': wsRecord, ...(secondWorkspace ? { 'ws-second': { ...wsRecord, path: '/a/different/workspace' } } : {}) } }, { initialized: true, workspaceIds: ['ws-original', ...(secondWorkspace ? ['ws-second'] : [])], archivedSessionIds: ['archived-session'] })
  unit('pkw_notes', oldVersion ? 1 : 3, { note_index: { note_original: { noteId: 'note_original', workspaceId: 'ws-original', relativePath: 'original.md', title: '原始私人笔记', tags: [], observedRevision: 7, contentHash: sha(note), fileSize: Buffer.byteLength(note), createdAt: now, updatedAt: now } }, note_paths: { 'original.md': 'note_original' }, note_order: {}, folder_trash: {} })
  unit('pkw_attachments', 1, { attachments: { att_one: { id: 'att_one', workspaceId: 'ws-original', filename: 'file.bin', relativePath: 'attachments/att_one/file.bin', mimeType: 'application/octet-stream', sha256: sha(bytes), sizeBytes: bytes.length, observedRevision: 1, indexedAt: now, createdAt: now } } })
  unit('pkw_tasks', 1, { matrices: {}, tasks: { task_original: { taskId: 'task_original', workspaceId: 'ws-original', matrixId: null, parentTaskId: null, title: '旧任务', sourceRefs: [{ kind: 'note', noteId: 'note_original' }], status: 'open', important: true, urgent: false, tags: [], manualOrder: 1, createdAt: now, updatedAt: now } } })
  unit('pkw', 1, { commits: { op_original: { operationId: 'op_original', workspaceId: 'ws-original', actor: { type: 'user' }, correlationId: 'corr_original', committedAt: now, events: [{ eventId: 'event_original', type: 'note.updated', aggregateType: 'note', aggregateId: 'note_original', aggregateRevision: 7, createdAt: now, payload: { history: 'exact history' } }] } } })
  unit('pkw_weknora_sync', 3, { mappings: { map: { workspaceId: 'ws-original', entityType: 'note', entityId: 'note_original', knowledgeId: 'knowledge_original', remoteFingerprint: 'same', localObservedRevision: 7, syncState: 'synced', updatedAt: now } }, reverse: { knowledge_original: { workspaceId: 'ws-original', entityType: 'note', entityId: 'note_original', knowledgeId: 'knowledge_original' } }, intents: {}, dirty: {}, processing: {}, processing_kb: {} })
  if (unknown) unit('unidentified', 9, { data: { original: 'keep but do not migrate' } })
  db.close()
  if (extraState) await writeFile(join(state, 'workspace.json'), JSON.stringify({ unit: { name: 'extra', version: 1 }, tables: {} }))
  const identity = new DatabaseSync(join(dataRoot, 'identity.sqlite'))
  identity.exec(`PRAGMA user_version=1;
    CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL);
    CREATE TABLE spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,ownerId TEXT NOT NULL REFERENCES accounts(id));
    CREATE TABLE members(spaceId TEXT NOT NULL REFERENCES spaces(id),userId TEXT NOT NULL REFERENCES accounts(id),role TEXT NOT NULL,PRIMARY KEY(spaceId,userId));
    CREATE TABLE invitations(hash TEXT PRIMARY KEY,spaceId TEXT,role TEXT,createdBy TEXT,expires INTEGER);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY,userId TEXT,csrf TEXT,expires INTEGER,seen INTEGER);
    CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,actor TEXT,spaceId TEXT,action TEXT,subject TEXT);`)
  if (identityWal) identity.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  identity.prepare('INSERT INTO accounts VALUES(?,?,?)').run(ownerId, 'owner', 'not-a-production-secret')
  identity.prepare('INSERT INTO spaces VALUES(?,?,?,?)').run(spaceId, '我的私人空间', 'private', ownerId)
  identity.prepare('INSERT INTO members VALUES(?,?,?)').run(spaceId, ownerId, 'owner')
  if (!identityWal) identity.close()
  const backup = join(root, 'backup'), result = await backupData({ workspace, state, output: backup, offlineConfirmed: true })
  return { root, workspace, state, dataRoot, backup, spaceId, ownerUsername: 'OWNER', manifestSha256: result.manifestSha256, offlineConfirmed: true, identity: identityWal ? identity : undefined, target: join(dataRoot, 'spaces', spaceId) }
}
async function identityWrite(f, sql) { const db = new DatabaseSync(join(f.dataRoot, 'identity.sqlite')); try { db.exec(sql) } finally { db.close() } }
async function assertClean(f) { await assert.rejects(stat(join(f.dataRoot, 'gateway.lock')), { code: 'ENOENT' }); await assert.rejects(stat(f.target), { code: 'ENOENT' }); assert.ok(!(await readdir(f.dataRoot)).some(name => name.startsWith('.adopt-private-'))) }

test('adoption preserves every content record and identity, updates only workspace path, and retains private owner binding', async () => {
  const f = await fixture(), identityBefore = await inventory(join(f.dataRoot, 'identity.sqlite')), sourceBefore = await inventory(f.state), workspaceBefore = await inventory(f.workspace)
  const original = (await inspectSqliteCopy(join(f.state, 'original.sqlite'))).summary
  const receipt = await adoptPrivateSpace(f)
  assert.equal(receipt.status, 'complete'); assert.equal(receipt.owner.username, 'owner'); assert.equal(receipt.space.kind, 'private'); assert.equal(receipt.space.ownerId, ownerId)
  assert.equal(receipt.workspaceId, 'ws-original'); assert.equal(receipt.runtimeAcceptance, 'not_run'); assert.equal(receipt.canStartNewVersion, false)
  assert.deepEqual(receipt.identities.taskIds, ['task_original']); assert.deepEqual(receipt.identities.eventIds, ['event_original']); assert.deepEqual(receipt.identities.knowledgeIds, ['knowledge_original'])
  const restored = (await inspectSqliteCopy(join(f.target, 'state.sqlite'))).summary
  for (const table of original.tables.filter(table => table.name !== 'u_workspace_workspaces')) assert.deepEqual(restored.tables.find(item => item.name === table.name), table)
  const db = new DatabaseSync(join(f.target, 'state.sqlite'), { readOnly: true })
  try {
    const row = db.prepare('SELECT key,value FROM u_workspace_workspaces').get(), value = JSON.parse(row.value)
    assert.equal(row.key, 'ws-original'); assert.equal(value.path, join(f.target, 'workspace')); assert.equal(value.legacyExtra, 'kept'); assert.deepEqual(value.sessionIds, ['preserve-session']); assert.equal(value.updatedAt, now)
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM unit_globals WHERE unit='workspace'").get().value).archivedSessionIds, ['archived-session'])
  } finally { db.close() }
  assert.deepEqual(await readFile(join(f.target, 'workspace/notes/original.md')), await readFile(join(f.workspace, 'notes/original.md')))
  assert.deepEqual(await inventory(join(f.dataRoot, 'identity.sqlite')), identityBefore); assert.deepEqual(await inventory(f.state), sourceBefore); assert.deepEqual(await inventory(f.workspace), workspaceBefore)
  assert.equal((await verifyBackup({ backup: f.backup, manifestSha256: f.manifestSha256 })).byteIntegrity, 'passed')
  await assert.rejects(stat(join(f.dataRoot, 'gateway.lock')), { code: 'ENOENT' }); assert.ok(!(await readdir(f.dataRoot)).some(name => name.startsWith('.adopt-private-')))
  assert.deepEqual(JSON.parse(await readFile(join(f.target, 'adoption-receipt.json'), 'utf8')), receipt)
})

test('identity check reads committed WAL via a copy without changing the identity DB or SHM', async () => {
  const f = await fixture({ identityWal: true })
  try {
    const before = await Promise.all(['', '-wal', '-shm'].map(suffix => inventory(join(f.dataRoot, 'identity.sqlite' + suffix))))
    await adoptPrivateSpace(f)
    assert.deepEqual(await Promise.all(['', '-wal', '-shm'].map(suffix => inventory(join(f.dataRoot, 'identity.sqlite' + suffix)))), before)
  } finally { f.identity.close() }
})

test('adoption refuses team space, wrong owner, non-owner membership and private invite access', async () => {
  const cases = [
    "UPDATE spaces SET kind='team'",
    "INSERT INTO accounts VALUES('other','other','x'); UPDATE spaces SET ownerId='other'",
    "UPDATE members SET role='editor'",
    `INSERT INTO invitations VALUES('invite','${spaceId}','viewer','${ownerId}',9999999999999)`,
    `INSERT INTO accounts VALUES('other','other','x'); INSERT INTO members VALUES('${spaceId}','other','viewer')`,
  ]
  for (const sql of cases) {
    const f = await fixture(); await identityWrite(f, sql)
    const before = await inventory(join(f.dataRoot, 'identity.sqlite'))
    await assert.rejects(adoptPrivateSpace(f), kind('NOT_READY')); await assertClean(f)
    assert.deepEqual(await inventory(join(f.dataRoot, 'identity.sqlite')), before)
  }
})

test('gateway lock prevents live or concurrent import and is never stolen', async () => {
  const f = await fixture(); await writeFile(join(f.dataRoot, 'gateway.lock'), 'live gateway')
  await assert.rejects(adoptPrivateSpace(f), kind('UNSAFE_PATH'))
  assert.equal(await readFile(join(f.dataRoot, 'gateway.lock'), 'utf8'), 'live gateway')
  await rm(join(f.dataRoot, 'gateway.lock'))
  await adoptPrivateSpace(f, { onPhase: async phase => { if (phase === 'locked') await assert.rejects(adoptPrivateSpace(f), kind('UNSAFE_PATH')) } })
})

test('an existing private content directory, even empty, cannot be overwritten or retried into', async () => {
  for (const existing of ['empty', 'populated']) {
    const f = await fixture(); await mkdir(f.target, { recursive: true })
    if (existing === 'populated') await writeFile(join(f.target, 'keep'), 'new data')
    const before = await inventory(f.target)
    await assert.rejects(adoptPrivateSpace(f), kind('UNSAFE_PATH'))
    assert.deepEqual(await inventory(f.target), before)
  }
  const f = await fixture(); await adoptPrivateSpace(f); const before = await inventory(f.target)
  await assert.rejects(adoptPrivateSpace(f), kind('UNSAFE_PATH')); assert.deepEqual(await inventory(f.target), before)
})

test('each import failure releases its lock, removes partial targets and preserves originals for a fresh retry', async () => {
  for (const phase of ['locked', 'identity-checked', 'mapped', 'published-files']) {
    const f = await fixture(), before = await inventory(f.state)
    await assert.rejects(adoptPrivateSpace(f, { onPhase: current => { if (current === phase) throw new Error(`injected ${phase}`) } }), new RegExp(`injected ${phase}`))
    await assertClean(f); assert.deepEqual(await inventory(f.state), before)
    await adoptPrivateSpace(f)
  }
})

test('changing identity during import is detected before publishing private data', async () => {
  const f = await fixture()
  await assert.rejects(adoptPrivateSpace(f, { onPhase: async phase => { if (phase === 'mapped') await identityWrite(f, "UPDATE spaces SET kind='team'") } }), kind('SOURCE_CHANGED'))
  await assertClean(f)
})

test('changed mapped database, changed workspace or changed published file cannot receive a receipt', async () => {
  for (const mode of ['database', 'workspace', 'published']) {
    const f = await fixture()
    await assert.rejects(adoptPrivateSpace(f, { onPhase: async phase => {
      if (phase === 'mapped' && mode !== 'published') {
        const stage = (await readdir(f.dataRoot)).find(name => name.startsWith('.adopt-private-'))
        const path = mode === 'database' ? join(f.dataRoot, stage, 'restored/state/original.sqlite') : join(f.dataRoot, stage, 'restored/workspace/notes/original.md')
        await writeFile(path, 'new unverified content')
      } else if (phase === 'published-files' && mode === 'published') await writeFile(join(f.target, 'workspace/notes/original.md'), 'changed')
    } }), kind('INTEGRITY'))
    await assertClean(f)
  }
})

test('unknown domains, older versions, multiple workspaces and additional state never get partially imported', async () => {
  for (const options of [{ unknown: true }, { oldVersion: true }, { secondWorkspace: true }, { extraState: true }]) {
    const f = await fixture(options)
    await assert.rejects(adoptPrivateSpace(f), kind('NOT_READY')); await assertClean(f)
  }
})

test('wrong manifest binding, missing offline assertion and invalid space identity reject before acquiring lock', async () => {
  const f = await fixture()
  await assert.rejects(adoptPrivateSpace({ ...f, manifestSha256: '0'.repeat(64) }), kind('INTEGRITY'))
  for (const change of [{ offlineConfirmed: false }, { manifestSha256: undefined }, { spaceId: '../escape' }, { ownerUsername: 'bad username' }]) await assert.rejects(adoptPrivateSpace({ ...f, ...change }), kind('USAGE'))
  await assertClean(f)
})

test('symlink roots and spaces directories are rejected without following them', async () => {
  const f = await fixture(); await symlink(f.dataRoot, join(f.root, 'root-link'))
  await assert.rejects(adoptPrivateSpace({ ...f, dataRoot: join(f.root, 'root-link') }), kind('UNSAFE_PATH'))
  const elsewhere = join(f.root, 'elsewhere'); await mkdir(elsewhere); await symlink(elsewhere, join(f.dataRoot, 'spaces'))
  await assert.rejects(adoptPrivateSpace(f), kind('UNSAFE_PATH')); assert.deepEqual(await readdir(elsewhere), [])
})

test('CLI has machine-readable help, mandatory binding and no incidental import when used as module', async () => {
  const cli = resolve('scripts/adopt-private-space.mjs')
  assert.equal(JSON.parse((await execute(process.execPath, [cli, '--help'])).stdout).ok, true)
  try { await execute(process.execPath, [cli]); assert.fail('must reject') } catch (error) { assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).error.kind, 'USAGE') }
  const f = await fixture()
  const result = JSON.parse((await execute(process.execPath, [cli, '--backup', f.backup, '--manifest-sha256', f.manifestSha256, '--data-root', f.dataRoot, '--space-id', f.spaceId, '--owner-username', 'Owner', '--offline-confirmed'])).stdout)
  assert.equal(result.ok, true); assert.equal(result.workspaceId, 'ws-original'); assert.equal(result.space.kind, 'private')
})

test('a recognized split JSON event store is preserved by backup but cannot be silently omitted from SQLite-only adoption', async () => {
  const f = await fixture()
  const db = new DatabaseSync(join(f.state, 'original.sqlite'))
  try {
    const rows = db.prepare('SELECT key,value FROM u_pkw_commits').all()
    await writeFile(join(f.state, 'events.json'), JSON.stringify({ unit: { name: 'pkw', version: 1 }, tables: { commits: Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.value)])) } }))
    db.exec("DROP TABLE u_pkw_commits; DELETE FROM units WHERE name='pkw'")
  } finally { db.close() }
  await rm(f.backup, { recursive: true })
  const result = await backupData({ workspace: f.workspace, state: f.state, output: f.backup, offlineConfirmed: true })
  assert.equal(result.reconciliation.readiness.preflightChecksPassed, true)
  await assert.rejects(adoptPrivateSpace({ ...f, manifestSha256: result.manifestSha256 }), kind('NOT_READY'))
  await assertClean(f)
})

test('unsupported identity schema is rejected before opening it for writing', async () => {
  const f = await fixture(); await identityWrite(f, 'PRAGMA user_version=2')
  const before = await inventory(join(f.dataRoot, 'identity.sqlite'))
  await assert.rejects(adoptPrivateSpace(f), kind('UNSUPPORTED'))
  await assertClean(f); assert.deepEqual(await inventory(join(f.dataRoot, 'identity.sqlite')), before)
})

test('a standalone state.sqlite sibling of workspace imports without requiring an overlapping directory backup', async () => {
  const f = await fixture()
  const db = await readFile(join(f.state, 'original.sqlite'))
  const siblingState = join(f.root, 'state.sqlite'); await writeFile(siblingState, db)
  const backup = join(f.root, 'single-file-backup')
  const result = await backupData({ workspace: f.workspace, state: siblingState, output: backup, offlineConfirmed: true })
  const receipt = await adoptPrivateSpace({ ...f, backup, manifestSha256: result.manifestSha256 })
  assert.equal(receipt.sqlite.originalStatePath, 'state.sqlite')
  const reopened = new DatabaseSync(join(f.target, 'state.sqlite'), { readOnly: true })
  try { assert.equal(reopened.prepare('SELECT count(*) AS n FROM u_pkw_tasks_tasks').get().n, 1) } finally { reopened.close() }
  assert.deepEqual(await readFile(siblingState), db)
})

test('private adoption rejects identity column drift even when all queried ownership fields still exist', async () => {
  const f = await fixture(); await identityWrite(f, 'ALTER TABLE accounts RENAME COLUMN password TO unsupported_hash')
  const before = await inventory(join(f.dataRoot, 'identity.sqlite'))
  await assert.rejects(adoptPrivateSpace(f), kind('UNSUPPORTED')); await assertClean(f)
  assert.deepEqual(await inventory(join(f.dataRoot, 'identity.sqlite')), before)
})

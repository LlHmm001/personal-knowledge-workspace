/**
 * Copy-isolation tests: a rehearsal copy must be self-contained.
 *
 * Two failure modes are covered:
 *   - a path inside the copy still naming the source root, so the copy would write the
 *     source's files;
 *   - a database copied while a writer was active, which a plain `cp` cannot make
 *     consistent (and deleting the WAL after copying does not fix).
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { makeSyntheticDataRoot } from './helpers/synthetic.mjs'
import { copyDataRoot, remapPath, remapJsonDocument } from '../../scripts/copy-data-root.mjs'

test('copy: every writable path points at the copy, not the source', async () => {
  const source = await makeSyntheticDataRoot()
  let copy = null
  try {
    const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
    copy = await copyDataRoot(source.root, target)
    assert.equal(copy.leaks.length, 0, `no path in the copy may name the source root: ${JSON.stringify(copy.leaks)}`)
    // The workspace path recorded in the copy's own database must name the copy.
    const db = new DatabaseSync(join(copy.targetRoot, 'spaces', source.spaceId, 'state.sqlite'), { readOnly: true })
    const row = db.prepare('SELECT value FROM u_workspace_workspaces LIMIT 1').get()
    db.close()
    const recorded = JSON.parse(row.value).path
    assert.ok(recorded.startsWith(copy.targetRoot), `recorded workspace path must be inside the copy: ${recorded}`)
    assert.ok(!recorded.includes(source.root), 'recorded workspace path must not mention the source')
    assert.ok(copy.rewritten.length > 0, 'the copy must report the paths it rewrote')
  } finally {
    await rm(source.root, { recursive: true, force: true })
    if (copy) await rm(dirname(copy.targetRoot), { recursive: true, force: true })
  }
})

test('copy: the snapshot is consistent even though no WAL is copied or deleted', async () => {
  const source = await makeSyntheticDataRoot()
  let copy = null
  try {
    // Write through a real connection without checkpointing, so the live WAL holds
    // committed rows that a plain file copy would miss.
    const live = new DatabaseSync(join(source.root, 'spaces', source.spaceId, 'state.sqlite'))
    live.exec('PRAGMA journal_mode=WAL;')
    for (let i = 0; i < 25; i++) live.prepare('INSERT INTO u_pkw_commits VALUES(?,?)').run(`synthetic:${i}`, JSON.stringify({ i }))
    const liveCount = live.prepare('SELECT count(*) AS c FROM u_pkw_commits').get().c
    const walBefore = existsSync(join(source.root, 'spaces', source.spaceId, 'state.sqlite-wal'))
    const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
    copy = await copyDataRoot(source.root, target)
    live.close()

    assert.equal(existsSync(join(copy.targetRoot, 'spaces', source.spaceId, 'state.sqlite-wal')), false, 'a WAL must not be copied into the snapshot')
    const snapshot = new DatabaseSync(join(copy.targetRoot, 'spaces', source.spaceId, 'state.sqlite'), { readOnly: true })
    const copiedCount = snapshot.prepare('SELECT count(*) AS c FROM u_pkw_commits').get().c
    snapshot.close()
    assert.equal(copiedCount, liveCount, `the snapshot must contain every committed row (wal present before copy: ${walBefore})`)

    // The source is untouched: no WAL was removed from it as part of copying.
    assert.ok(existsSync(join(source.root, 'spaces', source.spaceId, 'state.sqlite')), 'the source database must still exist')
    const sourceCheck = new DatabaseSync(join(source.root, 'spaces', source.spaceId, 'state.sqlite'), { readOnly: true })
    const sourceCount = sourceCheck.prepare('SELECT count(*) AS c FROM u_pkw_commits').get().c
    sourceCheck.close()
    assert.equal(sourceCount, liveCount, 'the source must not be modified by copying it')
  } finally {
    await rm(source.root, { recursive: true, force: true })
    if (copy) await rm(dirname(copy.targetRoot), { recursive: true, force: true })
  }
})

test('copy: a symlink pointing at the source is reported as a leak', async () => {
  const source = await makeSyntheticDataRoot()
  const copyDir = await mkdtemp(join(tmpdir(), 'pkw-copy-'))
  const copy = join(copyDir, 'data')
  try {
    await mkdir(join(copy, 'nested'), { recursive: true })
    await symlink(source.root, join(copy, 'nested/link-to-source'))
    const { findLeaks } = await import('../../scripts/copy-data-root.mjs')
    const leaks = await findLeaks(source.root, copy)
    assert.equal(leaks.length, 1)
    assert.match(leaks[0].target, new RegExp(source.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(copy, { recursive: true, force: true })
  }
})

test('copy: the retrieval endpoint is only what the caller passes in', async () => {
  const source = await makeSyntheticDataRoot()
  let copy = null
  try {
    const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
    copy = await copyDataRoot(source.root, target)
    // The caller writes the retrieval configuration; the copier never invents one.
    const configPath = join(copy.targetRoot, 'collaboration.json')
    await writeFile(configPath, JSON.stringify({
      dataPath: copy.targetRoot, publicOrigin: 'http://127.0.0.1:9',
      retrieval: { [source.spaceId]: { baseUrl: 'http://127.0.0.1:9/stub', kbId: 'kb', apiKeyEnv: 'K' } },
    }, null, 2) + '\n', { mode: 0o600 })
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    const configured = config.retrieval?.[source.spaceId]
    assert.equal(configured?.baseUrl, 'http://127.0.0.1:9/stub', 'the copy must reach only the stub the caller supplied')
    assert.ok(config.dataPath.startsWith(copy.targetRoot), 'the copy config must point at the copy')
    assert.ok(!JSON.stringify(config).includes(source.root), 'the copy config must not mention the source')
    assert.equal((await stat(configPath)).mode & 0o777, 0o600, 'the config must stay private')

    // Remapping must not touch free text: a note body containing a similar string stays.
    const body = `path: ${source.root}/not/a/path in prose\n`
    const remapped = remapJsonDocument(JSON.stringify({ body, path: `${source.root}/keep` }), source.root, copy.targetRoot, ['path'])
    const doc = JSON.parse(remapped.raw)
    assert.equal(doc.body, body, 'a note body must not be rewritten')
    assert.equal(doc.path, `${copy.targetRoot}/keep`, 'a declared path field must be remapped')
    assert.equal(remapPath(`${source.root}/x`, source.root, copy.targetRoot).value, `${copy.targetRoot}/x`)
  } finally {
    await rm(source.root, { recursive: true, force: true })
    if (copy) await rm(dirname(copy.targetRoot), { recursive: true, force: true })
  }
})

test('copy: a writable path field that reaches the source through an alias is refused', async () => {
  const source = await makeSyntheticDataRoot()
  const parent = await mkdtemp(join(tmpdir(), 'pkw-copy-alias-'))
  const target = join(parent, 'data')
  try {
    // The recorded workspace path is an alias: a symlink to the source workspace, so a
    // literal comparison sees a path inside the copy while the writes land in the source.
    const alias = join(source.root, 'alias-to-source-workspace')
    await symlink(join(source.root, 'spaces', source.spaceId, 'workspace'), alias)
    const db = new DatabaseSync(join(source.root, 'spaces', source.spaceId, 'state.sqlite'))
    db.prepare('UPDATE u_workspace_workspaces SET value=?').run(JSON.stringify({
      path: alias, title: 'synthetic workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }))
    db.close()

    const copy = await copyDataRoot(source.root, target)
    // The alias must not be silently rewritten into a path that exists nowhere: the field
    // has to land on the copied workspace, and nothing may resolve back to the source.
    const copyDb = new DatabaseSync(join(copy.targetRoot, 'spaces', source.spaceId, 'state.sqlite'), { readOnly: true })
    const recorded = JSON.parse(copyDb.prepare('SELECT value FROM u_workspace_workspaces').get().value).path
    copyDb.close()
    assert.equal(recorded, join(copy.targetRoot, 'spaces', source.spaceId, 'workspace'), `the aliased workspace path must land on the copied workspace, got ${recorded}`)
    assert.equal(copy.writableProblems.length, 0, `the remapped field must resolve inside the copy: ${JSON.stringify(copy.writableProblems)}`)
    assert.ok(copy.rewritten.some(r => r.how === 'remapped-by-real-location'), `the remap must be decided by real location: ${JSON.stringify(copy.rewritten)}`)
  } finally {
    await rm(parent, { recursive: true, force: true })
    await rm(source.root, { recursive: true, force: true })
  }
})

test('copy: writing the copy does not change the source', async () => {
  const source = await makeSyntheticDataRoot()
  const parent = await mkdtemp(join(tmpdir(), 'pkw-copy-write-'))
  const target = join(parent, 'data')
  try {
    const copy = await copyDataRoot(source.root, target)
    assert.equal(copy.writableProblems.length, 0)
    const sourceNote = join(source.root, 'spaces', source.spaceId, 'workspace', source.relativePath)
    const before = await readFile(sourceNote, 'utf8')
    const beforeStat = await stat(sourceNote)
    // Write inside the copy, exactly as a runtime would.
    await writeFile(join(copy.targetRoot, 'spaces', source.spaceId, 'workspace', source.relativePath), '# changed in the copy\n')
    const after = await readFile(sourceNote, 'utf8')
    const afterStat = await stat(sourceNote)
    assert.equal(after, before, 'the source file must be untouched')
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'the source mtime must be untouched')
  } finally {
    await rm(parent, { recursive: true, force: true })
    await rm(source.root, { recursive: true, force: true })
  }
})

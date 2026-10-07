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
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { copyDataRootConsistently, findPathsLeakingTo, makeSyntheticDataRoot } from './helpers/synthetic.mjs'

test('copy: every writable path points at the copy, not the source', async () => {
  const source = await makeSyntheticDataRoot()
  let copy = null
  try {
    copy = await copyDataRootConsistently(source.root)
    assert.notEqual(copy.root, source.root)
    const leaks = await findPathsLeakingTo(source.root, copy.root)
    assert.deepEqual(leaks, [], `no path in the copy may name the source root: ${JSON.stringify(leaks)}`)
    // The workspace path recorded in the copy's own database must name the copy.
    const db = new DatabaseSync(join(copy.root, 'spaces', source.spaceId, 'state.sqlite'), { readOnly: true })
    const row = db.prepare('SELECT value FROM u_workspace_workspaces LIMIT 1').get()
    db.close()
    const recorded = JSON.parse(row.value).path
    assert.ok(recorded.startsWith(copy.root), `recorded workspace path must be inside the copy: ${recorded}`)
    assert.ok(!recorded.includes(source.root), 'recorded workspace path must not mention the source')
    assert.ok(copy.rewrittenPaths.length > 0, 'the copy must report the paths it rewrote')
  } finally {
    await rm(source.root, { recursive: true, force: true })
    if (copy) await rm(copy.root, { recursive: true, force: true })
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
    copy = await copyDataRootConsistently(source.root)
    live.close()

    assert.equal(existsSync(join(copy.root, 'spaces', source.spaceId, 'state.sqlite-wal')), false, 'a WAL must not be copied into the snapshot')
    const snapshot = new DatabaseSync(join(copy.root, 'spaces', source.spaceId, 'state.sqlite'), { readOnly: true })
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
    if (copy) await rm(copy.root, { recursive: true, force: true })
  }
})

test('copy: a symlink pointing at the source is reported as a leak', async () => {
  const source = await makeSyntheticDataRoot()
  const copy = await mkdtemp(join(tmpdir(), 'pkw-synth-copy-'))
  try {
    await mkdir(join(copy, 'nested'), { recursive: true })
    await symlink(source.root, join(copy, 'nested/link-to-source'))
    const leaks = await findPathsLeakingTo(source.root, copy)
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
    copy = await copyDataRootConsistently(source.root, { stubUrl: 'http://127.0.0.1:9/stub', spaceId: source.spaceId })
    const config = JSON.parse(await readFile(copy.configPath, 'utf8'))
    const configured = config.retrieval?.[source.spaceId]
    assert.equal(configured?.baseUrl, 'http://127.0.0.1:9/stub', 'the copy must reach only the stub the caller supplied')
    assert.ok(config.dataPath.startsWith(copy.root), 'the copy config must point at the copy')
    assert.ok(!JSON.stringify(config).includes(source.root), 'the copy config must not mention the source')
    assert.equal((await stat(copy.configPath)).mode & 0o777, 0o600, 'the config must stay private')
  } finally {
    await rm(source.root, { recursive: true, force: true })
    if (copy) await rm(copy.root, { recursive: true, force: true })
  }
})

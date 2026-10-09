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
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

// ── the isolation gate lives in the library, so no caller can skip it ─────────────────────────

test('copy: a copy that leaks is refused by the library itself, and the scene is kept', async () => {
  const source = await makeSyntheticDataRoot()
  const outside = await mkdtemp(join(tmpdir(), 'pkw-outside-'))
  const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
  try {
    // A link inside the space points outside the tree being copied. Whatever a runtime does with
    // it, a write through it lands outside the copy, so the copy is not isolated from its source.
    await symlink(outside, join(source.root, 'spaces', source.spaceId, 'link-to-outside'))
    let thrown = null
    try {
      await copyDataRoot(source.root, target)
    } catch (error) { thrown = error }
    assert.ok(thrown, 'the library must refuse a copy that is not isolated from its source')
    assert.equal(thrown.code, 'PKW_COPY_NOT_ISOLATED')
    assert.match(thrown.message, /is not isolated from/)
    // The findings are on the error, so a caller reports them instead of re-deriving them.
    assert.equal(thrown.leaks.length, 1)
    assert.equal(thrown.leaks[0].reason, 'escapes-the-copy')
    assert.equal(thrown.leaks[0].resolved, await realpath(outside))
    assert.equal(thrown.writableProblems.length, 0)
    assert.equal(thrown.targetRoot, await realpath(target))
    // The scene is preserved: the copy and the link in it are still on disk for inspection.
    assert.equal(await realpath(join(target, 'spaces', source.spaceId, 'link-to-outside')), await realpath(outside))
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(dirname(target), { recursive: true, force: true })
  }
})

test('copy: a declared write path that escapes the copy is refused by the library', async () => {
  const source = await makeSyntheticDataRoot()
  const outside = await mkdtemp(join(tmpdir(), 'pkw-outside-'))
  const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
  try {
    // The workspace path names a directory outside the tree, reached through a link that is itself
    // inside the copy. A literal check cannot see it; resolving the deepest existing ancestor can.
    const workspacePath = join(outside, 'workspace')
    await mkdir(workspacePath, { recursive: true })
    await pointWorkspaceAt(join(source.root, 'spaces', source.spaceId, 'state.sqlite'), workspacePath)
    await symlink(outside, join(source.root, 'spaces', source.spaceId, 'alias-to-outside'))

    let thrown = null
    try {
      await copyDataRoot(source.root, target)
    } catch (error) { thrown = error }
    assert.ok(thrown, 'a declared write path outside the copy must be refused')
    assert.equal(thrown.code, 'PKW_COPY_NOT_ISOLATED')
    // Both findings are reported: the escaping link and the field that still names it.
    assert.ok(thrown.leaks.some(leak => leak.reason === 'escapes-the-copy'), `expected an escaping leak: ${JSON.stringify(thrown.leaks)}`)
    assert.ok(thrown.writableProblems.length >= 1, `expected writable problems: ${JSON.stringify({ writable: thrown.writableProblems, leaks: thrown.leaks })}`)
    // The copy is left exactly as it was produced, including the field that caused the refusal.
    const held = JSON.parse(new DatabaseSync(join(target, 'spaces', source.spaceId, 'state.sqlite'), { readOnly: true }).prepare('SELECT value FROM u_workspace_workspaces').get().value)
    assert.ok(held.path === workspacePath || held.path.startsWith(await realpath(source.root)), `the recorded path must be reported as it is: ${held.path}`)
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(dirname(target), { recursive: true, force: true })
  }
})

/** Point the synthetic workspace record at another directory, as a misconfigured copy would. */
async function pointWorkspaceAt(statePath, workspacePath) {
  const db = new DatabaseSync(statePath)
  try {
    const row = db.prepare('SELECT key, value FROM u_workspace_workspaces').get()
    const doc = JSON.parse(row.value)
    doc.path = workspacePath
    db.prepare('UPDATE u_workspace_workspaces SET value=? WHERE key=?').run(JSON.stringify(doc), row.key)
  } finally { db.close() }
}

test('copy: the roots it reports are the real ones, so a runtime configured from them agrees', async () => {
  const source = await makeSyntheticDataRoot()
  const parent = await mkdtemp(join(tmpdir(), 'pkw-copy-'))
  const realParent = await mkdtemp(join(tmpdir(), 'pkw-copy-real-'))
  try {
    // The source is reached through a symlink, and the target's parent is a symlink too: this is
    // how a data disk is usually mounted, and both spellings must lead to one answer.
    const linkedSource = join(parent, 'source-link')
    await symlink(source.root, linkedSource)
    const linkedTargetDir = join(parent, 'data-link')
    await symlink(realParent, linkedTargetDir)
    const target = join(linkedTargetDir, 'data')

    const copy = await copyDataRoot(linkedSource, target)
    // What the caller is told is what the isolation decisions were made with, so a runtime
    // configured from `targetRoot` is configured with the directory the gate actually checked.
    assert.equal(copy.sourceRoot, await realpath(source.root))
    assert.equal(copy.targetRoot, await realpath(target))
    assert.ok(copy.targetRoot.startsWith(await realpath(realParent)), `${copy.targetRoot} must be inside ${await realpath(realParent)}`)
    assert.ok(!copy.targetRoot.includes('data-link'), 'the reported target must be the real path, not the link')
    const { findLeaks } = await import('../../scripts/copy-data-root.mjs')
    assert.deepEqual(await findLeaks(copy.sourceRoot, copy.targetRoot), [])
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
    await rm(realParent, { recursive: true, force: true })
  }
})

test('copy: a failed copy cannot be turned into a running service by the caller', async () => {
  const source = await makeSyntheticDataRoot()
  const outside = await mkdtemp(join(tmpdir(), 'pkw-outside-'))
  const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
  try {
    await symlink(outside, join(source.root, 'spaces', source.spaceId, 'link-to-outside'))
    // A caller that forgets to check the result gets a thrown refusal, not a copy value it can
    // start a runtime on. `isNotIsolated` is how a caller recognises its own failure to report.
    const { isNotIsolated } = await import('../../scripts/copy-data-root.mjs')
    let started = false
    let copy = null
    try {
      copy = await copyDataRoot(source.root, target)
      started = true
    } catch (error) {
      assert.equal(isNotIsolated(error), true)
    }
    assert.equal(started, false, 'no copy value may be produced for a copy that failed the gate')
    assert.equal(copy, null)
    // The refusal happened before anything could be configured against the copy, so no runtime
    // configuration naming it exists.
    assert.equal(existsSync(join(target, 'collaboration.json')), false, 'nothing may be configured on a refused copy')
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(dirname(target), { recursive: true, force: true })
  }
})

// ── a preserved failure is never reused blindly ──────────────────────────────────────────────

test('copy: an existing data root is re-verified, and one that is not isolated is refused again', async () => {
  const source = await makeSyntheticDataRoot()
  const outside = await mkdtemp(join(tmpdir(), 'pkw-outside-'))
  const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
  try {
    // The first attempt fails and its copy is left on disk, as the library promises. It carries
    // what every real copy carries: databases that make a later run believe the copy is finished.
    await symlink(outside, join(source.root, 'spaces', source.spaceId, 'link-to-outside'))
    const { verifyExistingCopy } = await import('../../scripts/copy-data-root.mjs')
    await assert.rejects(() => copyDataRoot(source.root, target), error => error.code === 'PKW_COPY_NOT_ISOLATED')
    assert.equal(existsSync(join(target, 'identity.sqlite')), true, 'the preserved copy must still hold its identity store')

    // The link that leaked is gone, but the copy is still not isolated: its declared workspace path
    // names a directory outside it. A run that trusted `identity.sqlite` would now proceed.
    await rm(join(target, 'spaces', source.spaceId, 'link-to-outside'))
    await pointWorkspaceAt(join(target, 'spaces', source.spaceId, 'state.sqlite'), join(outside, 'workspace'))

    let thrown = null
    try {
      await verifyExistingCopy(source.root, target)
    } catch (error) { thrown = error }
    assert.ok(thrown, 'an existing directory must be verified again, not trusted because it is there')
    assert.equal(thrown.code, 'PKW_COPY_NOT_ISOLATED')
    assert.ok(thrown.writableProblems.length >= 1, `expected writable problems: ${JSON.stringify(thrown.writableProblems)}`)
    assert.equal(thrown.targetRoot, await realpath(target))
    // The scene is still there: the refusal did not clean anything up.
    assert.equal(existsSync(join(target, 'identity.sqlite')), true)
    assert.equal(existsSync(join(target, 'spaces', source.spaceId, 'state.sqlite')), true)
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(dirname(target), { recursive: true, force: true })
  }
})

test('copy: an existing data root whose source is unknown may not be reused at all', async () => {
  const source = await makeSyntheticDataRoot()
  const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
  try {
    await copyDataRoot(source.root, target)
    const { verifyExistingCopy } = await import('../../scripts/copy-data-root.mjs')
    let thrown = null
    try {
      await verifyExistingCopy(null, target)
    } catch (error) { thrown = error }
    assert.ok(thrown, 'without the source there is nothing to verify against')
    assert.equal(thrown.code, 'PKW_COPY_SOURCE_UNKNOWN')
    assert.match(thrown.message, /the source it was copied from is unknown/)
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(dirname(target), { recursive: true, force: true })
  }
})

test('copy: a clean existing root passes re-verification, so reuse is allowed on evidence', async () => {
  const source = await makeSyntheticDataRoot()
  const target = join(await mkdtemp(join(tmpdir(), 'pkw-copy-')), 'data')
  try {
    const copy = await copyDataRoot(source.root, target)
    const { verifyExistingCopy } = await import('../../scripts/copy-data-root.mjs')
    const verified = await verifyExistingCopy(source.root, target)
    assert.equal(verified.reused, true)
    assert.equal(verified.targetRoot, copy.targetRoot)
    assert.deepEqual(verified.leaks, [])
    assert.deepEqual(verified.writableProblems, [])
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(dirname(target), { recursive: true, force: true })
  }
})

test('rehearsal: isolated-copy refusal is preserved and an existing work directory cannot be adopted', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const source = await makeSyntheticDataRoot()
  const outside = await mkdtemp(join(tmpdir(), 'pkw-outside-'))
  const workDir = await mkdtemp(join(tmpdir(), 'pkw-rehearse-'))
  const driver = join(process.cwd(), 'deploy/rehearse-release.mjs')
  try {
    // A link inside the space escapes the copy, so the first run must refuse the copy.
    await symlink(outside, join(source.root, 'spaces', source.spaceId, 'link-to-outside'))
    // The driver seeds its old release from a profile before it copies data, so it is given a
    // synthetic one: the refusal under test happens in the copy phase, which follows.
    const profileSource = join(workDir, 'profile-source')
    const webPackage = join(profileSource, 'node_modules/@deepseek-ai/dsh-pkw-web')
    await mkdir(webPackage, { recursive: true })
    await writeFile(join(profileSource, 'package.json'), '{}')
    await writeFile(join(webPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '0.9.8-rehearsal' }))
    const runDirectory = join(workDir, 'fresh-run')
    const args = [
      '--work-dir', runDirectory, '--data-source', source.root, '--profile-source', profileSource,
      '--artifact-dir', join(workDir, 'artifacts-that-do-not-exist'),
      '--version', '0.9.9-rehearsal', '--old-version', '0.9.8-rehearsal', '--port', '42777',
    ]
    const first = await run(process.execPath, [driver, ...args], { encoding: 'utf8' }).then(() => null, error => error)
    assert.ok(first, 'the first rehearsal must refuse a copy that is not isolated')
    assert.equal(first.code, 1, `unexpected exit ${first.code}: ${first.stdout}`)
    assert.match(first.stderr, /copy-not-self-contained/)
    assert.match(first.stderr, /"preserved": true/)
    // The refusal is recorded, and the copy is still there: this is the scene the second run finds.
    const dataRoot = join(runDirectory, 'data')
    assert.equal(existsSync(join(dataRoot, 'identity.sqlite')), true)
    assert.equal(existsSync(join(runDirectory, 'collaboration.json')), false, 'nothing may be configured on a refused copy')
    assert.equal(existsSync(join(runDirectory, 'listener.pid')), false, 'no listener may be started')
    const originalReport = await readFile(join(runDirectory, 'report.json'), 'utf8')

    // A repeated CLI invocation refuses the existing work directory before it can adopt any
    // former pid record or overwrite the preserved refusal. Library reuse is tested separately.
    const second = await run(process.execPath, [driver, ...args], { encoding: 'utf8' }).then(() => null, error => error)
    assert.ok(second, 'the second rehearsal must refuse the preserved copy too')
    assert.equal(second.code, 1, `unexpected exit ${second.code}: ${second.stdout}`)
    assert.match(second.stderr, /EEXIST/)
    assert.equal(existsSync(join(runDirectory, 'collaboration.json')), false, 'the second run must not configure the refused copy')
    assert.equal(existsSync(join(runDirectory, 'listener.pid')), false)
    assert.equal(await readFile(join(runDirectory, 'report.json'), 'utf8'), originalReport, 'the second run must not overwrite the first refusal evidence')
    // The scene and original isolation report survive both runs unchanged.
    assert.equal(existsSync(join(dataRoot, 'identity.sqlite')), true)
    assert.equal(existsSync(join(dataRoot, 'spaces', source.spaceId, 'link-to-outside')), true, 'the failure scene must not be cleaned up')
    const report = JSON.parse(originalReport)
    assert.equal(report.status, 'copy-not-self-contained')
    assert.equal(report.phases.copyData.reused, false)
    assert.ok(report.phases.copyData.leaks.length >= 1)
  } finally {
    await rm(source.root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  }
})

/**
 * Release-switch orchestration tests on synthetic data only.
 *
 * These exercise the rules the review asked for: a candidate must be brand new, the
 * release in service is never the install target, a drifted candidate is refused
 * before the switch, a rollback restores the actual previous version, and the data
 * that was added before the rollback is still there afterwards (body, attachment,
 * permissions), not merely a health check.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { switchRelease, currentRelease, profileVersion, assertNewCandidate, assertNotInService, pointCurrentAtomically } from '../../deploy/switch-release.mjs'
import { makeSyntheticProfile } from './helpers/synthetic.mjs'

const OLD_VERSION = '0.1.2-pkw.4'
const NEW_VERSION = '0.1.8-pkw.9'

/**
 * The inputs a real PKW release declares. They are what a rollback snapshot captures and what a
 * restore has to put back, so a release without them would not exercise that path at all.
 */
const RELEASE_INPUTS = {
  'package.json': `{\n  "name": "dsh-pkw-profile",\n  "private": true,\n  "version": "${OLD_VERSION}"\n}\n`,
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  '.npmrc': 'registry=https://registry.npmjs.org/\n',
}

/** Build the release layout: releases/<old>/profile plus a current symlink. */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pkw-root-'))
  const oldProfile = join(root, 'releases', OLD_VERSION, 'profile')
  await makeSyntheticProfile({ version: OLD_VERSION, root: oldProfile })
  for (const [name, content] of Object.entries(RELEASE_INPUTS)) await writeFile(join(oldProfile, name), content)
  await mkdir(join(root, 'releases'), { recursive: true })
  await symlink(join('releases', OLD_VERSION), join(root, 'current'))
  return { root, oldProfile }
}

/** A fake install that writes the new version into the candidate, like pnpm would. */
function fakeInstall(newVersion = NEW_VERSION) {
  return async ({ profile }) => {
    const scope = join(profile, 'node_modules/@deepseek-ai')
    for (const entry of await readdir(scope)) {
      const manifestPath = join(scope, entry, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.version = newVersion
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
      await writeFile(join(scope, entry, 'lib/index.js'), `export const pkg = '${entry}'\nexport const version = '${newVersion}'\n`)
    }
  }
}

/** A service stub: counts stop/start, and verifies through an injectable check. */
function serviceStub(verifyImpl, reachableImpl = async () => ({ reachable: true, status: 200 })) {
  const calls = { stop: 0, start: 0, verify: [], reachable: 0 }
  return {
    calls,
    hooks: {
      stop: async () => { calls.stop += 1 },
      start: async () => { calls.start += 1 },
      verify: async context => { calls.verify.push(context.expectedVersion); return verifyImpl(context) },
      reachable: async context => { calls.reachable += 1; return reachableImpl(context) },
    },
  }
}

/**
 * An acceptance result in the shape an enforcing verifier produces. The switch validates
 * this shape, so a stub that omits `ok`, `enforcing` or the authenticated check must be
 * rejected — which the tests below assert separately.
 */
const verifyOk = async ({ expectedVersion, expectedRelease }) => {
  const version = await profileVersion(join(expectedRelease, 'profile'))
  if (version !== expectedVersion) throw new Error(`serving ${version}, expected ${expectedVersion}`)
  return { ok: true, enforcing: true, checks: { authenticated: 'verified', servingVersion: version } }
}

test('switch: a non-empty candidate directory is refused and never cleaned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-candidate-'))
  await writeFile(join(dir, 'someone-elses-file'), 'keep me\n')
  await assert.rejects(() => assertNewCandidate(dir), /not empty/)
  assert.equal((await readdir(dir)).includes('someone-elses-file'), true, 'the existing file must survive')
})

test('switch: the release in service may not be the install target', async () => {
  const { root, oldProfile } = await makeRoot()
  try {
    await assert.rejects(() => assertNotInService(oldProfile, root), /release in service/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: install goes to the candidate, the old release keeps serving until promotion', async () => {
  const { root, oldProfile } = await makeRoot()
  const service = serviceStub(verifyOk)
  let observedDuringInstall = null
  try {
    const report = await switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION),
      deps: { prepareInstall: async options => { observedDuringInstall = await currentRelease(root); return fakeInstall()(options) } },
    })
    assert.equal(report.status, 'activated')
    assert.equal(report.previousVersion, OLD_VERSION)
    assert.equal(report.candidateVersion, NEW_VERSION)
    assert.equal(observedDuringInstall, join(root, 'releases', OLD_VERSION), 'the install must run while the old release is in service')
    assert.equal(await currentRelease(root), join(root, 'releases', NEW_VERSION))
    assert.equal(await profileVersion(oldProfile), OLD_VERSION, 'the old release tree must still be intact')
    assert.deepEqual(service.calls.verify, [NEW_VERSION])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a candidate that drifted after install is refused before the switch', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION),
      deps: {
        prepareInstall: fakeInstall(),
        // Someone writes the candidate behind the deployment's back, after the install
        // digest was taken and while the service is stopped.
        afterStopBeforeDriftCheck: async ({ candidate }) => {
          await writeFile(join(candidate, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/index.js'), 'export const version = "tampered"\n')
        },
      },
    }), error => {
      assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `unexpected code ${error.code}: ${error.message}`)
      assert.match(error.message, /drifted/, `the original cause must be preserved: ${error.message}`)
      return true
    })
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'current must point back at the old release')
    assert.equal(service.calls.verify.length, 0, 'a drifted candidate must never reach verification')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a failing verification rolls back to the actual previous version', async () => {
  const { root, oldProfile } = await makeRoot()
  let failNext = true
  const service = serviceStub(async context => {
    if (failNext && context.expectedVersion === NEW_VERSION) { failNext = false; throw new Error('synthetic verification failure') }
    return verifyOk(context)
  })
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION),
      deps: { prepareInstall: fakeInstall() },
    }), error => error.code === 'PKW_DEPLOYMENT_ROLLED_BACK')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'current must point back at the old release')
    assert.equal(await profileVersion(oldProfile), OLD_VERSION, 'the restored release must declare the old version')
    assert.ok(service.calls.reachable >= 1, 'the rollback must confirm the restored release came back up')
    assert.deepEqual(service.calls.verify, [NEW_VERSION], 'acceptance runs for the release being deployed, not silently for the rollback')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: an existing snapshot directory is refused and never overwritten', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  const snapshotDir = join(root, 'snapshots', NEW_VERSION)
  try {
    await mkdir(snapshotDir, { recursive: true })
    const keep = join(snapshotDir, 'existing-recovery-material')
    await writeFile(keep, 'do not overwrite me\n')
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir, deps: { prepareInstall: fakeInstall() },
    }), /snapshot directory already exists/)
    assert.equal(await readFile(keep, 'utf8'), 'do not overwrite me\n', 'existing recovery material must survive')
    assert.equal(service.calls.stop, 0, 'the refusal happens before anything is stopped')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a failure inside the transaction restores the old release and reports both errors', async () => {
  const { root } = await makeRoot()
  let startCalls = 0
  const service = {
    calls: { stop: 0, start: 0, verify: [] },
    hooks: {
      stop: async () => { service.calls.stop += 1 },
      start: async () => {
        startCalls += 1
        service.calls.start += 1
        // The first start is the new release; make it fail so the transaction has to
        // recover, then let the recovery start succeed the second time.
        if (startCalls === 1) throw new Error('synthetic failure while starting the new release')
      },
      verify: async context => verifyOk(context),
      reachable: async () => ({ reachable: true, status: 200 }),
    },
  }
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), error => {
      assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `unexpected code ${error.code}: ${error.message}`)
      // Both errors must be present: the original one and the recovery outcome.
      assert.match(error.message, /synthetic failure while starting the new release/, 'the original error must be preserved')
      assert.equal(error.cause?.message, 'synthetic failure while starting the new release')
      return true
    })
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'current must point back at the old release')
    assert.equal(service.calls.stop, 1, 'the stop runs once for the whole switch; recovery never repeats it')
    assert.equal(service.calls.start, 2, 'the recovery must start the restored release')
    assert.equal(await profileVersion(join(root, 'releases', OLD_VERSION, 'profile')), OLD_VERSION)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a rollback whose previous release does not come back up is reported as failed', async () => {
  const { root } = await makeRoot()
  let failNext = true
  const service = serviceStub(
    async context => {
      if (failNext && context.expectedVersion === NEW_VERSION) { failNext = false; throw new Error('synthetic verification failure') }
      return verifyOk(context)
    },
    async () => ({ reachable: false, error: 'listener never answered' }),
  )
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION),
      deps: { prepareInstall: fakeInstall() },
    }), error => ['PKW_ROLLBACK_FAILED', 'PKW_STOP_NOT_CONFIRMED', 'PKW_STOP_FAILED'].includes(error.code))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: reachability is never treated as acceptance', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(async () => { throw new Error('the service cannot confirm the serving version') })
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION),
      deps: { prepareInstall: fakeInstall() },
    }), error => error.code === 'PKW_DEPLOYMENT_ROLLED_BACK')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'a reachable but unaccepted release must not stay in service')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: data added before a rollback survives it, including attachments and permissions', async () => {
  const { root } = await makeRoot()
  // A synthetic data root, not a production one.
  const dataRoot = join(root, 'data')
  const spaceId = `sp_${'a'.repeat(32)}`
  const workspaceDir = join(dataRoot, 'spaces', spaceId, 'workspace')
  await mkdir(join(workspaceDir, 'notes'), { recursive: true, mode: 0o750 })
  const bodyPath = join(workspaceDir, 'notes/added-before-rollback.md')
  const body = '# added before rollback\n\nthis text must survive\n'
  await writeFile(bodyPath, body, { mode: 0o640 })
  const attachmentPath = join(workspaceDir, 'attachments/att_new/payload.bin')
  await mkdir(join(workspaceDir, 'attachments/att_new'), { recursive: true, mode: 0o750 })
  const attachmentBytes = Buffer.from('attachment added before rollback\n')
  await writeFile(attachmentPath, attachmentBytes, { mode: 0o640 })
  const state = new DatabaseSync(join(dataRoot, 'spaces', spaceId, 'state.sqlite'))
  state.exec('CREATE TABLE u_pkw_notes_note_index (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;')
  state.prepare('INSERT INTO u_pkw_notes_note_index VALUES(?,?)').run('note_new', JSON.stringify({
    noteId: 'note_new', relativePath: 'notes/added-before-rollback.md', contentHash: createHash('sha256').update(body).digest('hex'),
  }))
  state.close()

  let failNext = true
  const service = serviceStub(async context => {
    if (failNext && context.expectedVersion === NEW_VERSION) { failNext = false; throw new Error('synthetic verification failure') }
    return verifyOk(context)
  })
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION),
      deps: { prepareInstall: fakeInstall() },
    }), error => error.code === 'PKW_DEPLOYMENT_ROLLED_BACK')

    assert.equal(await readFile(bodyPath, 'utf8'), body, 'the note body must survive the rollback')
    assert.deepEqual(await readFile(attachmentPath), attachmentBytes, 'the attachment bytes must survive the rollback')
    assert.equal((await stat(bodyPath)).mode & 0o777, 0o640, 'file permissions must survive the rollback')
    assert.equal((await stat(join(workspaceDir, 'notes'))).mode & 0o777, 0o750, 'directory permissions must survive the rollback')
    const check = new DatabaseSync(join(dataRoot, 'spaces', spaceId, 'state.sqlite'), { readOnly: true })
    const row = check.prepare('SELECT value FROM u_pkw_notes_note_index WHERE key=?').get('note_new')
    check.close()
    assert.equal(JSON.parse(row.value).contentHash, createHash('sha256').update(body).digest('hex'), 'the added note must still be indexed after the rollback')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a promoted release is never reused as a candidate', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  try {
    await switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    })
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), /already has a promoted profile/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a verifier result that is not acceptance is refused', async () => {
  const cases = [
    ['ok:false', async () => ({ ok: false, enforcing: true, checks: { authenticated: 'verified', servingVersion: NEW_VERSION } })],
    ['diagnostics', async () => ({ ok: true, enforcing: false, checks: { authenticated: 'not_verified_no_credentials', servingVersion: NEW_VERSION } })],
    ['unauthenticated', async () => ({ ok: true, enforcing: true, checks: { authenticated: 'failed_credentials_rejected', servingVersion: NEW_VERSION } })],
    ['no serving version', async () => ({ ok: true, enforcing: true, checks: { authenticated: 'verified' } })],
    ['wrong serving version', async () => ({ ok: true, enforcing: true, checks: { authenticated: 'verified', servingVersion: '0.0.0-other' } })],
    // The shapes below used to slip through: a result with no `enforcing` field at all, and
    // one that reports only a version without any authentication evidence.
    ['no enforcing field', async () => ({ ok: true, checks: { authenticated: 'verified', servingVersion: NEW_VERSION } })],
    ['no checks object', async () => ({ ok: true, enforcing: true, servingVersion: NEW_VERSION })],
  ]
  for (const [label, verify] of cases) {
    // Each case needs its own release root: a rejected switch still promotes, so the
    // version directory must not be reused between cases.
    const { root } = await makeRoot()
    const service = serviceStub(verify)
    try {
      await assert.rejects(() => switchRelease({
        root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
        snapshotDir: join(root, 'snapshots', NEW_VERSION),
        deps: { prepareInstall: fakeInstall() },
      }), error => {
        assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `${label}: unexpected code ${error.code}: ${error.message}`)
        const evidence = error.rollbackEvidence ?? error.report?.rollbackEvidence
        assert.notEqual(evidence?.acceptance, 'verified', `${label}: acceptance must not be recorded as verified`)
        assert.equal(error.rollbackVerified, false, `${label}: acceptance must not be claimed`)
        assert.match(error.message, /NOT verified/, `${label}: the unverified state must be stated`)
        return true
      })
      assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), `${label}: current must point back at the old release`)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

test('switch: a rollback with no acceptance evidence is reported as unverified', async () => {
  const { root } = await makeRoot()
  let failOnce = true
  const service = serviceStub(async context => {
    if (failOnce) { failOnce = false; throw new Error('synthetic verification failure') }
    return verifyOk(context)
  })
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
      // hooks.verifyPrevious is deliberately absent, so acceptance cannot be claimed.
    }), error => {
      assert.ok(['PKW_DEPLOYMENT_ROLLED_BACK', 'PKW_STOP_NOT_CONFIRMED', 'PKW_STOP_FAILED'].includes(error.code), `unexpected code ${error.code}`)
      assert.notEqual(error.report.status, 'rolled-back', `a rollback must not be claimed: ${error.report.status}`)
      assert.equal(error.report.rollbackEvidence.acceptance, 'not_verified')
      assert.match(error.message, /NOT verified/)
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a stop that fails while the writer is still alive is refused, not rolled back', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  let stopAttempts = 0
  const hooks = {
    ...service.hooks,
    stop: async () => {
      stopAttempts += 1
      if (stopAttempts === 1) throw new Error('synthetic stop failure')
    },
    isStopped: async () => ({ known: true, stopped: false }),
  }
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), error => {
      // The stop hook failed AND the probe observes a live writer. Nothing was stopped, so the
      // deployment is refused at the stop and no rollback is claimed. The code is the stop
      // failure itself, naming the original cause; recovery is not attempted at all because it
      // would have to start a second instance beside a writer that is demonstrably alive.
      assert.equal(error.code, 'PKW_STOP_FAILED', `unexpected code ${error.code}: ${error.message}`)
      assert.equal(error.report.status, 'failed-before-promotion')
      assert.equal(error.report.previousRestore.required, false)
      assert.match(error.report.previousRestore.reason, /was not stopped \(still-running\)/)
      assert.deepEqual(error.report.actions, {
        stopConfirmed: false, renamedCandidateToProfile: false, pointerSwitched: false,
        candidateStarted: false, startFailed: false, verificationFailed: false,
      })
      assert.equal(error.report.stopState.known, false)
      assert.equal(error.report.stopState.stopped, false)
      assert.equal(error.report.stopState.probeOutcome, 'still-running')
      assert.equal(error.stopError, 'synthetic stop failure')
      assert.match(error.message, /the probe reports the service is still running/)
      assert.match(error.message, /the stop hook also failed: synthetic stop failure/)
      return true
    })
    assert.equal(service.calls.start, 0, 'no start may be attempted while a writer is alive')
    assert.equal(service.calls.verify.length, 0, 'nothing may be verified when nothing was promoted')
    assert.equal(stopAttempts, 1, 'a failed stop is never retried')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'the entry point must be untouched')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a live instance whose stop state cannot be observed blocks the switch', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  let stopAttempts = 0
  const hooks = {
    ...service.hooks,
    stop: async () => { stopAttempts += 1; throw new Error('synthetic stop failure') },
    // The previous writer is in fact still alive, but the probe cannot confirm it.
    isStopped: async () => ({ known: false }),
  }
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), error => {
      // An unobservable stop state is not evidence of a stop. Starting the old release beside a
      // possibly live instance would create a second writer, so nothing is started and the scene
      // is kept exactly as it is.
      assert.equal(error.code, 'PKW_STOP_FAILED', `unexpected code ${error.code}: ${error.message}`)
      assert.equal(error.report.status, 'failed-before-promotion')
      assert.equal(error.report.previousRestore.required, false)
      assert.match(error.report.previousRestore.reason, /was not stopped \(unknown\)/)
      assert.equal(error.report.stopState.probeOutcome, 'unknown')
      assert.equal(error.report.stopState.stopped, false)
      assert.match(error.message, /the stop state could not be established/)
      return true
    })
    assert.equal(service.calls.start, 0, 'no start may be attempted without stop evidence')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'the release pointer must be left as it was')
    assert.equal(stopAttempts, 1, 'a failed stop is never retried')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: an unknown stop state is never reported as stopped', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  let stopAttempts = 0
  const hooks = {
    ...service.hooks,
    // The stop hook claims success; the probe cannot establish whether the writer is still running.
    stop: async () => { stopAttempts += 1; if (stopAttempts === 1) throw new Error('synthetic stop failure') },
    isStopped: async () => ({ known: false }),
  }
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), error => {
      assert.equal(error.code, 'PKW_STOP_FAILED', `unexpected code ${error.code}: ${error.message}`)
      assert.equal(error.report.status, 'failed-before-promotion')
      assert.equal(error.report.previousRestore.required, false)
      // Nothing may claim the service stopped when that could not be established.
      assert.deepEqual(error.report.stopState, {
        known: false, stopped: false, probeOutcome: 'unknown',
        reason: 'the stop state could not be established ({"known":false})',
        stage: 'before promotion',
      })
      assert.equal(service.calls.start, 0, 'no start may be attempted without stop evidence')
      assert.match(error.message, /the stop state could not be established/)
      return true
    })
    assert.equal(stopAttempts, 1, 'the stop must be attempted once')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a stop with no state callback is unknown, not stopped', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  let stopAttempts = 0
  let startAttempts = 0
  const hooks = {
    // No isStopped callback at all: the site cannot be asked whether the service is stopped, and
    // a stop hook that threw is the only information there is.
    stop: async () => { stopAttempts += 1; throw new Error('synthetic stop failure') },
    start: async () => { startAttempts += 1 },
    verify: service.hooks.verify,
  }
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), error => {
      assert.equal(error.code, 'PKW_STOP_FAILED', `unexpected code ${error.code}: ${error.message}`)
      assert.equal(error.report.status, 'failed-before-promotion')
      assert.deepEqual(error.report.stopState, {
        known: false, stopped: false, probeOutcome: 'unknown',
        reason: 'the stop did not succeed and no stop state probe was supplied',
        stage: 'before promotion',
      })
      assert.equal(error.report.previousRestore.required, false)
      assert.equal(error.stopError, 'synthetic stop failure')
      assert.match(error.message, /no stop state probe was supplied/)
      return true
    })
    // No second instance may be started and the release pointer must be untouched.
    assert.equal(startAttempts, 0, 'a start without stop evidence would create a second writer')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION))
    assert.equal(stopAttempts, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a probe reporting "still running" overrides a successful stop', async () => {
  const { root } = await makeRoot()
  const service = serviceStub(verifyOk)
  let startAttempts = 0
  let stopAttempts = 0
  let probeCalls = 0
  const order = []
  const hooks = {
    // The stop hook claims success, but the probe shows the writer is still alive.
    stop: async () => { stopAttempts += 1; order.push('stop') }, // reports success
    start: async () => { startAttempts += 1; order.push('start') },
    isStopped: async () => { probeCalls += 1; order.push('probe'); return { known: true, stopped: false, source: 'synthetic-probe' } },
    verify: async () => { order.push('verify'); throw new Error('synthetic verification failure') },
    reachable: async () => ({ reachable: true, status: 200 }),
  }
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), error => {
      // A successful stop hook is not evidence. The probe overrides it, and because promotion
      // never happened there is nothing to roll back: the switch is refused at the stop, no
      // candidate is ever started, and no rollback may be claimed.
      assert.equal(error.code, 'PKW_STOP_NOT_CONFIRMED', `unexpected code ${error.code}: ${error.message}`)
      assert.equal(error.report.status, 'failed-before-promotion')
      assert.equal(error.report.stopAttempts.length, 1, 'the stop is attempted exactly once')
      assert.equal(error.report.stopAttempts[0].stopSucceeded, true, 'the hook did report success')
      assert.equal(error.report.stopAttempts[0].probeOutcome, 'still-running')
      assert.equal(error.report.stopState.stopped, false, 'the probe answer must win')
      assert.equal(error.report.previousRestore.required, false)
      assert.equal(error.rollbackVerified, undefined, 'no rollback may be claimed')
      assert.equal(error.report.rollbackEvidence, undefined, 'no rollback evidence may be claimed')
      assert.match(error.message, /the probe reports the service is still running/)
      return true
    })
    // The probe is consulted after the stop hook and before anything else, and once it reports a
    // live writer nothing may be started or verified.
    assert.deepEqual(order, ['stop', 'probe'], `unexpected order ${order.join(',')}`)
    assert.equal(probeCalls, 1, 'the probe must be consulted exactly once')
    assert.equal(startAttempts, 0, 'no start may follow a probe that reports a live writer')
    assert.equal(stopAttempts, 1, 'the stop must not be retried')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'current must not be repointed')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ── recovery after the release in service was already stopped ────────────────────────────────

test('switch: a failure after the stop restores the stopped release and leaves the tree complete', async () => {
  const { root, oldProfile } = await makeRoot()
  const service = serviceStub(verifyOk)
  // A file that belongs to the release and to no snapshot: a rollback that copies a snapshot over
  // the release tree would lose it.
  const extraFile = join(oldProfile, 'release-own-file.txt')
  await writeFile(extraFile, 'this file belongs to the release, not to any snapshot\n')
  // The release's declared inputs are modified while the service is stopped, so the restore has
  // real work to do: the same values have to come back.
  const tamperedInputs = { 'package.json': '{"name":"tampered"}\n', 'pnpm-lock.yaml': 'tampered: true\n' }
  const install = fakeInstall()
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION),
      deps: {
        // The release's declared inputs are replaced with wrong values while the service is
        // running. The release in service is never an install target, so nothing else looks at
        // them until the rollback snapshot captures them.
        prepareInstall: install,
        afterStopBeforeDriftCheck: async ({ candidate }) => {
          // The snapshot has already been taken at this point. The release's declared inputs are
          // replaced with wrong values, so the restore has real work to do, …
          for (const [name, content] of Object.entries(tamperedInputs)) await writeFile(join(oldProfile, name), content)
          // … and the candidate drifts, which refuses the promotion.
          await writeFile(join(candidate, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/index.js'), 'export const version = "tampered"\n')
        },
      },
    }), error => {
      // The deployment fails with the reason it actually failed for. Restoring the previous
      // release does not turn a refused deployment into a successful one.
      assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `unexpected code ${error.code}: ${error.message}`)
      assert.equal(error.rollbackVerified, false, 'acceptance was not observed, so it may not be claimed')
      assert.equal(error.cause.code, 'PKW_CANDIDATE_DRIFT')
      assert.equal(error.report.activationError.code, 'PKW_CANDIDATE_DRIFT')
      assert.equal(error.report.status, 'rolled-back-unverified')
      assert.equal(error.report.promoted, undefined, 'nothing may be reported as promoted')
      // The snapshot is complete and is the thing the restore used.
      assert.deepEqual(error.report.snapshot, {
        dir: join(root, 'snapshots', NEW_VERSION),
        expected: ['package.json', 'pnpm-lock.yaml', '.npmrc'],
        written: ['package.json', 'pnpm-lock.yaml', '.npmrc'],
        complete: true,
      })
      assert.equal(error.report.snapshotWritten, join(root, 'snapshots', NEW_VERSION))
      // The restore outcome is reported item by item, separately from the deployment failure.
      assert.equal(error.report.previousRestore.required, true)
      assert.deepEqual(error.report.previousRestore.steps, {
        stop: 'already-confirmed-before-promotion', stopEvidence: null, inputsRestored: true,
        inputsUnchanged: false, currentRepointed: true, started: true, versionConfirmed: true,
      })
      assert.equal(error.report.rollback.restoredRelease, join(root, 'releases', OLD_VERSION))
      assert.equal(error.report.rollback.restoredVersion, OLD_VERSION)
      assert.deepEqual(error.report.actions, {
        stopConfirmed: true, renamedCandidateToProfile: false, pointerSwitched: false,
        candidateStarted: false, startFailed: false, verificationFailed: false,
      })
      return true
    })
    // The old release is running again with exactly the inputs it declared, and the file that only
    // exists in the release tree survived.
    assert.equal(service.calls.start, 1, 'the old release must be started again')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION), 'current must point back at the old release')
    assert.equal(await profileVersion(oldProfile), OLD_VERSION)
    for (const [name, content] of Object.entries(RELEASE_INPUTS)) {
      assert.equal(await readFile(join(oldProfile, name), 'utf8'), content, `${name} must be restored to what the release declared`)
    }
    assert.equal(await readFile(extraFile, 'utf8'), 'this file belongs to the release, not to any snapshot\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('switch: a failure inside the snapshot loop leaves the snapshot incomplete and unused', async () => {
  const { root, oldProfile } = await makeRoot()
  const service = serviceStub(verifyOk)
  // The second staged input cannot be copied, so the snapshot directory ends up holding the first
  // one and none of the others.
  await rm(join(oldProfile, 'pnpm-lock.yaml'))
  await mkdir(join(oldProfile, 'pnpm-lock.yaml'))
  try {
    await assert.rejects(() => switchRelease({
      root, version: NEW_VERSION, artifacts: [], registry: 'http://127.0.0.1:1', hooks: service.hooks,
      snapshotDir: join(root, 'snapshots', NEW_VERSION), deps: { prepareInstall: fakeInstall() },
    }), error => {
      assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `unexpected code ${error.code}: ${error.message}`)
      assert.equal(error.cause.code, 'PKW_SNAPSHOT_INCOMPLETE', 'the phase that failed must be named')
      assert.match(error.cause.message, /pnpm-lock\.yaml/)
      assert.equal(error.report.snapshotWritten, undefined, 'an incomplete snapshot is never reported as written')
      assert.equal(error.report.snapshot.complete, false)
      // The progress record stops where the failure happened: the inputs reached are named, and
      // the ones never attempted are not.
      assert.deepEqual(error.report.snapshot.expected, ['package.json', 'pnpm-lock.yaml'])
      assert.deepEqual(error.report.snapshot.written, ['package.json'], 'only the inputs actually staged may be claimed')
      // Nothing may be written back from a partial snapshot, so the tree is untouched.
      assert.equal(error.report.previousRestore.required, true)
      assert.equal(error.report.previousRestore.steps.inputsUnchanged, true, 'nothing may be copied back from a partial snapshot')
      assert.equal(error.report.previousRestore.steps.inputsRestored, false)
      assert.equal(error.report.previousRestore.steps.currentRepointed, true)
      assert.equal(error.report.previousRestore.steps.versionConfirmed, true)
      return true
    })
    assert.equal(service.calls.start, 1, 'the stopped release must be started again')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION))
    // The untouched input is exactly as it was, and the staging directory stays for inspection.
    assert.equal(await readFile(join(oldProfile, 'package.json'), 'utf8'), RELEASE_INPUTS['package.json'])
    assert.deepEqual((await readdir(join(root, 'snapshots', NEW_VERSION))).sort(), ['package.json'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

// ── the entry point is replaced atomically ───────────────────────────────────────────────────

test('switch: replacing the entry point never leaves the installation without one', async () => {
  const { root } = await makeRoot()
  const entry = join(root, 'current')
  const oldTarget = join('releases', OLD_VERSION)
  const newTarget = join('releases', NEW_VERSION)
  try {
    // A failure while the new link is being created must not disturb the entry point at all:
    // this is the step that would remove it if the replacement were a remove-then-create pair.
    await assert.rejects(
      () => pointCurrentAtomically(root, newTarget, { createLink: async () => { throw new Error('synthetic link creation failure') } }),
      /synthetic link creation failure/)
    assert.equal(await readlink(entry), oldTarget, 'the entry point must still lead to the release in service')
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION))
    assert.equal(await profileVersion(join(root, 'releases', OLD_VERSION, 'profile')), OLD_VERSION, 'the release in service must stay readable')
    assert.deepEqual((await readdir(root)).sort(), ['current', 'releases'], 'no staging link may be left behind')

    // A failure while the staged link is being moved onto the entry point leaves it untouched,
    // and the staging link is cleaned up rather than left in the installation root.
    await assert.rejects(
      () => pointCurrentAtomically(root, newTarget, { rename: async () => { throw new Error('synthetic replacement failure') } }),
      /synthetic replacement failure/)
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION))
    assert.deepEqual((await readdir(root)).sort(), ['current', 'releases'], 'no staging link may be left behind')

    // With both steps working the replacement succeeds and the pointer moves.
    assert.equal(await pointCurrentAtomically(root, newTarget), true)
    assert.equal(await currentRelease(root), join(root, 'releases', NEW_VERSION))
    assert.deepEqual((await readdir(root)).sort(), ['current', 'releases'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

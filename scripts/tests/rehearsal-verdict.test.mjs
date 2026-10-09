import assert from 'node:assert/strict'
import test from 'node:test'
import { assertRehearsalVerdict } from '../../deploy/site/rehearsal-verdict.mjs'

const oldVersion = '0.1.8-pkw.1', version = '0.1.9-pkw.1'
function fixture(kind = 'positive') {
  const baseline = { file: 'attachment.bin', bytes: 20, sha256: 'a'.repeat(64), mode: '600' }
  const wrote = { noteId: 'note-1', spaceId: 'space-1', attachmentId: 'attachment-1', marker: 'written-marker', linked: true, attachmentBytes: 20, attachmentSha256: baseline.sha256, attachmentBaseline: baseline }
  const report = {
    version, oldVersion, status: 'PKW_DEPLOYMENT_ROLLED_BACK',
    error: { code: 'PKW_DEPLOYMENT_ROLLED_BACK' },
    result: {
      status: 'rolled-back', previousVersion: oldVersion, candidateVersion: version,
      installedRelease: '/fixture/releases/old',
      actions: { stopConfirmed: true, renamedCandidateToProfile: true, pointerSwitched: true, candidateStarted: true, verificationFailed: true },
      snapshot: { complete: true },
      rollback: { restoredRelease: '/fixture/releases/old', restoredVersion: oldVersion },
      previousRestore: { required: true, steps: { stop: 'confirmed', currentRepointed: true, started: true, versionConfirmed: true } },
      rollbackEvidence: { reachability: 'verified', acceptance: 'verified' },
      rollbackReachable: { reachable: true, status: 200 },
      rollbackAcceptance: { ok: true, enforcing: true, mode: 'rollback', requestedVersion: oldVersion, installedVersion: oldVersion, checks: {
        servingVersion: oldVersion, authenticated: 'verified', noteReadable: true,
        gatewayHealthzStatus: 200, loginStatus: 200, spacePageStatus: 200, listNotesStatus: 200, getNoteStatus: 200,
      } },
      activationError: { message: 'rehearsal: injected post-activation verification failure' },
    },
    phases: {
      writtenDuringServe: wrote,
      injectedFault: { kind: 'post-activation verification', reason: 'rehearsal: injected post-activation verification failure', afterWrite: { noteId: 'note-1', attachmentId: 'attachment-1', linked: true } },
      readBackAfterRollback: { label: 'restored-release', login: 200, read: 200, ok: true, marker: wrote.marker, attachmentId: wrote.attachmentId, attachmentSha256: baseline.sha256, attachmentBytes: 20, reason: null,
        attachment: { ok: true, ...baseline, baseline: { ...baseline }, expectedMode: null },
      },
    },
    writeAcceptance: { requested: true, problems: [], ok: true },
    exit: { code: 0, faultInjected: true, activated: false, rollbackVerified: true, readBackOk: true },
  }
  const args = { kind, exitCode: 0, report, oldVersion }
  if (kind === 'breakwrite') {
    args.exitCode = report.exit.code = 1
    report.exit.faultInjected = false
    report.phases = { writeFault: { kind: 'counterexample', brokenPath: 'rehearsal/broken.md', blocker: '/fixture/data/notes/rehearsal', status: 400, body: { ok: false, code: 'PKW_REQUEST_FAILED', error: '操作未完成' } } }
    report.result.activationError.message = 'writing during serve: the release refused a real write (HTTP 400): {"ok":false}'
    report.writeAcceptance = { requested: true, ok: false, problems: ['the release was asked to write while it served and no write was recorded', 'no read-back after the rollback was recorded'] }
  }
  if (kind === 'mode') {
    args.exitCode = report.exit.code = 1
    args.expectedMode = '640'
    report.status = 'rollback-data-not-readable'
    report.exit.readBackOk = false
    report.phases.readBackAfterRollback.ok = false
    Object.assign(report.phases.readBackAfterRollback.attachment, { ok: false, expectedMode: '640', reason: 'the restored attachment differs from the write baseline: mode 600 is not the configured 640' })
    report.writeAcceptance = { requested: true, ok: false, problems: ['the read-back after the rollback did not pass: no reason recorded'] }
  }
  return args
}

function refuses(args, mutate) {
  mutate(args.report, args)
  assert.throws(() => assertRehearsalVerdict(args), error => error.code === 'PKW_REHEARSAL_VERDICT_FAILED' && error.problems.length > 0)
}

for (const kind of ['positive', 'breakwrite', 'mode']) {
  test(`rehearsal ${kind} accepts only its expected completed outcome`, () => {
    assert.deepEqual(assertRehearsalVerdict(fixture(kind)), { ok: true, kind, exitCode: kind === 'positive' ? 0 : 1, oldVersion, version })
  })
  test(`rehearsal ${kind} rejects an exit-code-only or incomplete rollback claim`, () => {
    for (const mutate of [
      (_r, a) => { a.report = { exit: { code: a.exitCode } } },
      (_r, a) => { a.exitCode = null },
      r => { r.result.candidateVersion = oldVersion },
      r => { r.result.rollback.restoredRelease = '/fixture/releases/new' },
      r => { r.result.rollback.restoredVersion = version },
      r => { r.result.actions.candidateStarted = false },
      r => { r.result.previousRestore.steps.started = false },
      r => { r.result.rollbackEvidence.acceptance = 'not_verified' },
      r => { r.result.rollbackAcceptance.enforcing = false },
      r => { r.result.rollbackAcceptance.checks.servingVersion = version },
      r => { r.result.rollbackAcceptance.checks.noteReadable = false },
      r => { r.result.rollbackAcceptance.checks.getNoteStatus = 400 },
    ]) refuses(fixture(kind), mutate)
  })
}

test('positive requires its own completed linked write, note marker and every attachment field', () => {
  for (const mutate of [
    r => { delete r.phases.writtenDuringServe },
    r => { r.phases.writtenDuringServe.linked = false },
    r => { r.phases.injectedFault.afterWrite.noteId = 'stale-note' },
    r => { delete r.phases.readBackAfterRollback },
    r => { r.phases.readBackAfterRollback.reason = 'marker missing' },
    r => { r.phases.readBackAfterRollback.marker = 'stale-marker' },
    r => { r.phases.readBackAfterRollback.read = 400 },
    r => { r.phases.readBackAfterRollback.attachment.mode = '640' },
    r => { r.phases.readBackAfterRollback.attachment.sha256 = 'b'.repeat(64) },
    r => { delete r.phases.writtenDuringServe.attachmentBaseline },
    r => { r.writeAcceptance.problems.push('unexpected problem') },
  ]) refuses(fixture(), mutate)
})

test('breakwrite requires the real HTTP 400 before any injected-fault or stale-write evidence', () => {
  for (const mutate of [
    r => { r.phases.writeFault.status = 500 },
    r => { r.phases.writeFault.status = 401 },
    r => { r.phases.writeFault.body = { ok: false, code: 'PKW_AUTH_REQUIRED', error: 'login' } },
    r => { r.result.activationError.message = 'node exited 1' },
    r => { r.phases.injectedFault = { kind: 'post-activation verification' } },
    r => { r.exit.faultInjected = true },
    r => { r.phases.writtenDuringServe = fixture().report.phases.writtenDuringServe },
    r => { r.phases.readBackAfterRollback = fixture().report.phases.readBackAfterRollback },
  ]) refuses(fixture('breakwrite'), mutate)
})

test('mode counterexample permits only an extra expectation mismatch, never changed data or mode', () => {
  for (const key of ['file', 'bytes', 'sha256', 'mode']) {
    refuses(fixture('mode'), r => { r.phases.readBackAfterRollback.attachment[key] = key === 'bytes' ? 19 : 'different' })
    refuses(fixture('mode'), r => { r.phases.readBackAfterRollback.attachment.baseline[key] = key === 'bytes' ? 19 : 'different' })
  }
  for (const mutate of [
    (_r, a) => { a.expectedMode = '0640' },
    (_r, a) => { a.expectedMode = '600' },
    r => { r.phases.readBackAfterRollback.reason = 'marker missing' },
    r => { r.phases.readBackAfterRollback.attachment.reason += '; bytes changed' },
    r => { r.phases.readBackAfterRollback.attachment.ok = true },
    r => { r.writeAcceptance.problems.push('no read-back') },
  ]) refuses(fixture('mode'), mutate)
})

test('unknown case and absent reports produce a structured refusal', () => {
  refuses(fixture(), (_r, a) => { a.kind = 'any-exit-one' })
  refuses(fixture('breakwrite'), r => { r.writeAcceptance.problems = { length: 2 } })
  refuses(fixture('breakwrite'), r => { r.result.activationError.message = 400 })
  refuses(fixture('mode'), r => { r.writeAcceptance.problems = [42] })
  assert.throws(() => assertRehearsalVerdict({ kind: 'positive', exitCode: 0, oldVersion }), { code: 'PKW_REHEARSAL_VERDICT_FAILED' })
})

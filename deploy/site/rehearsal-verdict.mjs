/**
 * Judge the three serial rehearsal cases from their recorded observations, not
 * merely from an exit code. Cleanup is checked separately by the caller.
 * The current read-back proves note marker readability and stored attachment
 * integrity; it does not claim an HTTP attachment download or a full note hash.
 */
export function assertRehearsalVerdict({ kind, exitCode, report, oldVersion, expectedMode }) {
  const problems = []
  const need = (condition, message) => { if (!condition) problems.push(message) }
  const text = value => typeof value === 'string' && value.length > 0
  const absent = (object, key) => !Object.hasOwn(object, key)
  const r = report ?? {}, result = r.result ?? {}, phases = r.phases ?? {}
  const exit = r.exit ?? {}, acceptance = result.rollbackAcceptance ?? {}, checks = acceptance.checks ?? {}
  const write = phases.writtenDuringServe, back = phases.readBackAfterRollback
  const writeProblems = Array.isArray(r.writeAcceptance?.problems) ? r.writeAcceptance.problems : []
  const actions = result.actions ?? {}, restore = result.previousRestore ?? {}, steps = restore.steps ?? {}
  const requestedExit = kind === 'positive' ? 0 : 1

  need(['positive', 'breakwrite', 'mode'].includes(kind), 'kind must be positive, breakwrite or mode')
  need(text(oldVersion) && r.oldVersion === oldVersion, 'old version must match the requested predecessor')
  need(text(r.version) && r.version !== oldVersion, 'candidate and predecessor versions must differ')
  need(exitCode === requestedExit && exit.code === exitCode, 'observed and reported exit codes must match the case')
  need(exit.activated === false, 'the case must roll back, not remain activated')
  need(r.error?.code === 'PKW_DEPLOYMENT_ROLLED_BACK' && result.status === 'rolled-back', 'a completed deployment rollback must be reported')
  need(result.previousVersion === oldVersion && result.candidateVersion === r.version, 'the transaction must identify both installed versions')
  for (const key of ['stopConfirmed', 'renamedCandidateToProfile', 'pointerSwitched', 'candidateStarted', 'verificationFailed']) {
    need(actions[key] === true, `transaction did not establish ${key}`)
  }
  need(result.snapshot?.complete === true, 'the rollback snapshot must be complete')
  need(text(result.installedRelease) && result.rollback?.restoredRelease === result.installedRelease && result.rollback?.restoredVersion === oldVersion, 'rollback must restore the actual predecessor release')
  need(restore.required === true && absent(restore, 'error'), 'previous-release restoration must succeed')
  need(steps.stop === 'confirmed' && steps.currentRepointed === true && steps.started === true && steps.versionConfirmed === true, 'the predecessor must be stopped, repointed, started and version confirmed')
  need(exit.rollbackVerified === true && result.rollbackEvidence?.reachability === 'verified' && result.rollbackEvidence?.acceptance === 'verified', 'rollback reachability and acceptance must both be verified')
  need(result.rollbackReachable?.reachable === true && result.rollbackReachable?.status === 200, 'restored release must answer HTTP 200')
  need(acceptance.ok === true && acceptance.enforcing === true && acceptance.mode === 'rollback', 'rollback must pass the enforcing verifier')
  need(acceptance.requestedVersion === oldVersion && acceptance.installedVersion === oldVersion && checks.servingVersion === oldVersion, 'requested, installed and serving predecessor versions must agree')
  need(checks.authenticated === 'verified' && checks.noteReadable === true, 'authenticated predecessor note read must pass')
  for (const key of ['gatewayHealthzStatus', 'loginStatus', 'spacePageStatus', 'listNotesStatus', 'getNoteStatus']) {
    need(checks[key] === 200, `rollback verifier ${key} must be HTTP 200`)
  }
  need(r.writeAcceptance?.requested === true && Array.isArray(r.writeAcceptance?.problems), 'write acceptance must be explicitly requested and reported')

  if (kind === 'breakwrite') {
    const fault = phases.writeFault ?? {}
    need(r.status === 'PKW_DEPLOYMENT_ROLLED_BACK', 'real write refusal must retain the rollback status')
    need(exit.faultInjected === false && absent(phases, 'injectedFault'), 'a real write failure must not be relabelled as the injected verification fault')
    need(fault.kind === 'counterexample' && text(fault.brokenPath) && text(fault.blocker), 'the note-parent blocker must be recorded')
    need(fault.status === 400 && fault.body?.ok === false && fault.body?.code === 'PKW_REQUEST_FAILED' && text(fault.body?.error), 'the real createNote request must return HTTP 400 / PKW_REQUEST_FAILED')
    need(text(result.activationError?.message) && result.activationError.message.startsWith('writing during serve: the release refused a real write (HTTP 400): '), 'activation must fail at the real HTTP 400 write, not installation or another phase')
    need(absent(phases, 'writtenDuringServe') && absent(phases, 'readBackAfterRollback'), 'the refused write must not carry a completed write or stale read-back')
    need(r.writeAcceptance?.ok === false && writeProblems.length === 2
      && writeProblems.includes('the release was asked to write while it served and no write was recorded')
      && writeProblems.includes('no read-back after the rollback was recorded'), 'write acceptance must refuse the missing write and read-back')
    // No read-back was requested successfully; this flag is permissive in the driver.
    need(exit.readBackOk === true, 'driver readBackOk must match its absent-readback branch')
  } else if (kind === 'positive' || kind === 'mode') {
    const fault = phases.injectedFault ?? {}, baseline = write?.attachmentBaseline ?? {}, attachment = back?.attachment ?? {}
    need(absent(phases, 'writeFault'), 'a write counterexample must not contaminate this case')
    need(exit.faultInjected === true && fault.kind === 'post-activation verification'
      && fault.reason === 'rehearsal: injected post-activation verification failure'
      && result.activationError?.message === fault.reason, 'only the requested post-write verification fault may trigger rollback')
    need(text(write?.noteId) && text(write?.spaceId) && text(write?.attachmentId) && text(write?.marker) && write?.linked === true, 'the real note, attachment and observed link must be recorded')
    need(fault.afterWrite?.noteId === write?.noteId && fault.afterWrite?.attachmentId === write?.attachmentId && fault.afterWrite?.linked === true, 'fault must be recorded after this particular write')
    need(text(baseline.file) && Number.isSafeInteger(baseline.bytes) && baseline.bytes > 0
      && /^[a-f0-9]{64}$/.test(baseline.sha256 ?? '') && /^(?:0|[1-7][0-7]{0,3})$/.test(baseline.mode ?? ''), 'write must contain a complete attachment baseline')
    need(write?.attachmentSha256 === baseline.sha256 && write?.attachmentBytes === baseline.bytes, 'uploaded attachment summary must agree with the baseline')
    need(back?.label === 'restored-release' && back?.login === 200 && back?.read === 200 && back?.reason === null, 'restored release must read the note marker without an API error')
    need(back?.marker === write?.marker && back?.attachmentId === write?.attachmentId
      && back?.attachmentSha256 === baseline.sha256 && back?.attachmentBytes === baseline.bytes, 'read-back must refer to this write and attachment')
    for (const key of ['file', 'bytes', 'sha256', 'mode']) {
      need(attachment[key] === baseline[key] && attachment.baseline?.[key] === baseline[key], `restored attachment ${key} must equal the write baseline`)
    }
    if (kind === 'positive') {
      need(r.status === 'PKW_DEPLOYMENT_ROLLED_BACK', 'positive case must report completed rollback')
      need(exit.readBackOk === true && back?.ok === true && attachment.ok === true, 'positive read-back and attachment checks must all pass')
      need(expectedMode == null && attachment.expectedMode === null && absent(attachment, 'reason'), 'positive case must not impose or fail an extra mode expectation')
      need(r.writeAcceptance?.ok === true && writeProblems.length === 0, 'positive write acceptance must have no problems')
    } else {
      need(r.status === 'rollback-data-not-readable', 'mode case must fail the read-back gate after successful rollback')
      need(/^(?:0|[1-7][0-7]{0,3})$/.test(expectedMode ?? '') && attachment.expectedMode === expectedMode && attachment.mode !== expectedMode, 'mode case must impose a canonical, different expected mode')
      need(exit.readBackOk === false && back?.ok === false && attachment.ok === false, 'mode mismatch must fail all read-back gates')
      need(attachment.reason === `the restored attachment differs from the write baseline: mode ${attachment.mode} is not the configured ${expectedMode}`, 'the only attachment failure must be the extra expected mode')
      need(r.writeAcceptance?.ok === false && writeProblems.length === 1 && text(writeProblems[0])
        && writeProblems[0].startsWith('the read-back after the rollback did not pass: '), 'the only write-acceptance failure must be read-back')
    }
  }
  if (problems.length) {
    throw Object.assign(new Error(`Rehearsal ${kind} refused: ${problems.join('; ')}`), { code: 'PKW_REHEARSAL_VERDICT_FAILED', problems })
  }
  return { ok: true, kind, exitCode, oldVersion, version: r.version }
}

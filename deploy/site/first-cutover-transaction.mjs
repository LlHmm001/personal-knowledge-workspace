/** First legacy-unit conversion. Code rollback only: never restore an older database. */
const fail = (code, message) => Object.assign(new Error(message), { code })
export const errorRecord = error => ({ code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'PKW_FIRST_CUTOVER_ERROR', message: String(error?.message ?? 'Operation failed').slice(0, 600) })
const stopped = evidence => evidence?.known === true && evidence.stopped === true
export function assertFirstAcceptance(result, version, capture = false) {
  const keys = ['authenticated', 'instanceConfirmed', 'accountConfirmed', 'spaceConfirmed', 'noteReadable', 'fullBodyVerified', 'fullMarkdownVerified', 'fullAttachmentVerified', capture ? 'baselineCaptured' : 'baselineMatched']
  if (result?.ok !== true || result.enforcing !== true || result.servingVersion !== version || keys.some(key => result.checks?.[key] !== true) || (capture && !result.baseline)) throw fail('PKW_FIRST_ACCEPTANCE_FAILED', 'Authenticated instance, version, complete existing note and attachment evidence is required')
  return result
}

export async function firstCutoverTransaction({ hooks, report, save, signal, oldVersion = '0.1.2-pkw.4', newVersion = '0.1.9-pkw.1', rollbackOnly = false }) {
  report.actions ??= []; report.status = 'preflight'
  let stopAttempted = false, candidateStartAttempted = false, baseline
  const record = async (name, action) => {
    const entry = { action: name, state: 'intent', at: new Date().toISOString() }
    report.actions.push(entry); await save()
    try { const value = await action(); entry.state = 'done'; entry.result = value; await save(); return value }
    catch (error) { entry.state = 'failed'; entry.error = errorRecord(error); await save(); throw error }
  }
  const notInterrupted = () => { if (signal?.aborted) throw fail('PKW_FIRST_INTERRUPTED', 'Operation interrupted; preservation/recovery follows current stop evidence') }
  const confirm = async stage => {
    const value = await record(`confirm-stop:${stage}`, () => hooks.probeStopped())
    if (!stopped(value)) throw fail('PKW_FIRST_STOP_UNCONFIRMED', 'Current writer disappearance was not confirmed; unit/data/code references retained')
    return value
  }
  try {
    await record('preflight', () => hooks.preflight(rollbackOnly ? 'rollback' : 'activate'))
    notInterrupted()
    const initial = await record('capture-existing-content', () => hooks.capture(rollbackOnly ? newVersion : oldVersion))
    assertFirstAcceptance(initial, rollbackOnly ? newVersion : oldVersion, true)
    baseline = initial.baseline; report.baseline = baseline
    notInterrupted(); stopAttempted = true
    const stop = await record('stop-current', () => hooks.stop())
    await confirm('before-backup-or-restoration')
    if (stop?.ok !== true) throw fail('PKW_FIRST_STOP_FAILED', 'Stop command failed even though disappearance was separately observed')
    notInterrupted()
    if (rollbackOnly) {
      await record('restore-original-references', () => hooks.restore())
      await record('start-original', () => hooks.start(oldVersion))
      const verified = await record('accept-original', () => hooks.verify(baseline, oldVersion, 'rollback'))
      assertFirstAcceptance(verified, oldVersion)
      await record('dsh-unchanged', () => hooks.checkDsh())
      report.status = 'ROLLED_BACK_VERIFIED'; await save(); return report
    }
    const backup = await record('cold-backup', () => hooks.backup())
    if (backup?.ok !== true || backup.sourceVerified !== true || backup.cleanupConfirmed !== true || !/^[a-f0-9]{64}$/.test(backup.manifestSha256 ?? '')) throw fail('PKW_FIRST_BACKUP_FAILED', 'Complete verified offline backup and cleanup are required')
    report.backup = backup
    notInterrupted(); await confirm('before-reference-change')
    await record('install-independent-references', () => hooks.install())
    notInterrupted(); await confirm('before-candidate-start')
    candidateStartAttempted = true
    await record('start-candidate', () => hooks.start(newVersion))
    notInterrupted()
    const verified = await record('accept-candidate', () => hooks.verify(baseline, newVersion, 'activate'))
    assertFirstAcceptance(verified, newVersion)
    await record('dsh-unchanged', () => hooks.checkDsh()); notInterrupted()
    report.status = 'ACTIVATED_VERIFIED'; report.verification = verified
    await save(); return report
  } catch (original) {
    report.error = errorRecord(original)
    if (!stopAttempted) { report.status = 'STOPPED_BEFORE_SERVICE_ACTION'; await save(); throw Object.assign(original, { report }) }
    try {
      // A candidate start can fail after creating a process: old stop evidence is expired.
      if (candidateStartAttempted || rollbackOnly) await record('recovery-stop-current', () => hooks.stop())
      await confirm('before-recovery')
      if (!baseline) throw fail('PKW_FIRST_BASELINE_MISSING', 'No pre-stop acceptance baseline exists')
      await record('recovery-original-references', () => hooks.restore())
      await record('recovery-start-original', () => hooks.start(oldVersion))
      const restored = await record('recovery-accept-original', () => hooks.verify(baseline, oldVersion, 'rollback'))
      assertFirstAcceptance(restored, oldVersion)
      await record('recovery-dsh-unchanged', () => hooks.checkDsh())
      report.rollbackAcceptance = restored; report.status = 'FAILED_ORIGINAL_RESTORED_VERIFIED'
    } catch (recoveryError) {
      report.recoveryError = errorRecord(recoveryError); report.status = 'RECOVERY_BLOCKED_OR_UNVERIFIED'
    }
    await save()
    throw Object.assign(fail(report.status === 'FAILED_ORIGINAL_RESTORED_VERIFIED' ? 'PKW_FIRST_ROLLED_BACK' : 'PKW_FIRST_RECOVERY_BLOCKED', 'First cutover failed; consult the preserved transaction status and original error'), { cause: original, report })
  }
}

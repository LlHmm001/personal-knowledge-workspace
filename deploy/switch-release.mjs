#!/usr/bin/env node
/**
 * The single supported release switch for a PKW installation.
 *
 * There is exactly one execution path for installing a release, and it never installs
 * into the profile a service is currently using:
 *
 *   releases/<old>/profile      the release in service
 *   releases/<new>/candidate    a brand-new directory: the install target
 *   releases/<new>/profile      the candidate after promotion
 *   current -> releases/<new>   repointed only inside the switch transaction
 *
 * Transaction shape
 * -----------------
 * Everything after the first `stop` is one recoverable block. If any of it fails —
 * snapshot, drift re-check, promotion, repointing, starting the new release, or
 * verification — the previous release is restored, `current` is repointed back, the
 * service is started again, and BOTH errors are reported: the original one and any
 * error raised while recovering. A failed recovery is never reported as a successful
 * rollback, and a failure before the first stop does not stop anything at all.
 *
 * Reachability and acceptance stay separate: a rollback only has to prove the previous
 * release came back up; whether the deployment is acceptable is the verifier's decision.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { prepareInstall, profileInputDigest, deploymentErrorDetails } from '../scripts/deployment.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const PROFILE_INPUTS = ['package.json', 'pnpm-lock.yaml', '.npmrc']

/** Absolute path of the release a `current` symlink points at. */
export async function currentRelease(root) {
  const { readlink } = await import('node:fs/promises')
  const target = await readlink(join(root, 'current')).catch(() => null)
  if (!target) return null
  return resolve(dirname(join(root, 'current')), target)
}

/** Version declared by a profile, or null when it cannot be read. */
export async function profileVersion(profileDir) {
  try {
    return JSON.parse(await readFile(join(profileDir, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json'), 'utf8')).version
  } catch { return null }
}

/**
 * Refuse a candidate that is not brand new.
 * A non-empty directory is never cleaned here: it may be a release in service.
 */
export async function assertNewCandidate(candidateDir) {
  try {
    const info = await stat(candidateDir)
    if (!info.isDirectory()) throw new Error(`candidate path exists and is not a directory: ${candidateDir}`)
    const entries = await readdir(candidateDir)
    if (entries.length > 0) throw new Error(`candidate directory is not empty (${entries.length} entries): ${candidateDir}`)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
}

/** Refuse to install into the release in service, or into any part of it. */
export async function assertNotInService(candidateDir, root) {
  const target = await currentRelease(root)
  if (!target) return
  if (candidateDir === target || candidateDir.startsWith(target + sep) || target.startsWith(candidateDir + sep)) {
    throw new Error(`refusing to install into the release in service (${target})`)
  }
}

/** An existing snapshot directory is recovery material and is never overwritten. */
export async function assertSnapshotFree(snapshotDir) {
  if (existsSync(snapshotDir)) {
    const entries = await readdir(snapshotDir).catch(() => [])
    throw new Error(`snapshot directory already exists (${entries.length} entries): ${snapshotDir}. Snapshots are recovery material and are never overwritten; choose another --snapshot-dir or inspect and remove it yourself.`)
  }
}

/**
 * A verifier result is only acceptance when it says so explicitly.
 *
 * A report that is `ok: false`, that declares itself non-enforcing, or that omits the
 * fields acceptance depends on, is a refusal — never a pass. Reporting reachability is
 * not acceptance either, so a diagnostics result can never gate a deployment.
 */
export function assertAcceptance(result, { expectedVersion, label = 'verification' }) {
  const refuse = message => {
    const error = new Error(message)
    error.code = 'PKW_ACCEPTANCE_INVALID'
    throw error
  }
  if (!result || typeof result !== 'object') refuse(`${label} returned no structured result`)
  if (result.ok !== true) refuse(`${label} did not report ok:true (got ${JSON.stringify(result.ok)})`)
  // `enforcing` must be present *and* true. A verifier that omits the field has not said
  // it was enforcing, and a diagnostics run must never gate a deployment.
  if (result.enforcing !== true) refuse(`${label} did not report enforcing:true (got ${JSON.stringify(result.enforcing)})`)
  // The evidence acceptance rests on must be present, not merely absent-when-wrong.
  if (!result.checks || typeof result.checks !== 'object') refuse(`${label} reported no checks object`)
  if (result.checks.authenticated !== 'verified') {
    refuse(`${label} did not verify an authenticated session (authenticated=${JSON.stringify(result.checks.authenticated)})`)
  }
  const serving = result.checks.servingVersion ?? result.servingVersion
  if (!serving) refuse(`${label} did not report which release is serving`)
  if (expectedVersion && serving !== expectedVersion) refuse(`${label} reports ${serving} serving, expected ${expectedVersion}`)
  return result
}

/** Reachability only — deliberately NOT acceptance. */
export async function checkReachable({ origin, timeoutMs = 20_000 }) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt made'
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (health.status === 200) return { reachable: true, status: health.status }
      lastError = `healthz returned ${health.status}`
    } catch (error) { lastError = error.message }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  return { reachable: false, error: lastError }
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
  })
}

function releaseName(releasePath, root) {
  const releasesDir = join(root, 'releases')
  return releasePath.startsWith(releasesDir + sep) ? releasePath.slice(releasesDir.length + 1) : releasePath
}

/** Restore the previous release and start it again; report step-by-step progress. */
/**
 * Stop the service and establish that it really stopped.
 *
 * Stage boundary: a stop hook reporting success is not evidence by itself, and evidence from
 * an earlier stage is worthless once a different instance has been started. Callers run this
 * again for the instance they are about to replace, and a probe that reports a live process,
 * an unknown state or a failure blocks whatever the caller intended.
 *
 * `stop: 'run'` executes the stop hook; `stop: 'skip'` does not, because the caller already
 * did it, and the outcome is passed in. Skipping never implies "stopped": the probe is still
 * consulted, and without one a skipped stop with no success is unknown.
 */
async function stopAndConfirm({ hooks, report, label, stop = 'run', stopSucceeded = null }) {
  let succeeded = stopSucceeded === true
  let stopError = null
  if (stop === 'run') {
    try {
      await hooks.stop()
      succeeded = true
    } catch (error) {
      stopError = error
    }
  }
  let evidence = null
  let reason = null
  if (hooks.isStopped) {
    let probed
    try { probed = await hooks.isStopped() } catch (error) { probed = { known: false, error: error.message } }
    if (probed?.known === true && probed?.stopped === true) {
      evidence = { ...probed, stopHookSucceeded: succeeded, stage: label }
    } else {
      reason = `the probe reports the service is not stopped (${JSON.stringify(probed)})`
    }
  } else if (succeeded) {
    evidence = { known: true, stopped: true, source: 'stop-hook-succeeded', stage: label }
  } else {
    reason = 'the stop did not succeed and no stop state probe was supplied'
  }
  const record = { label, stop: stop === 'run' ? 'executed' : 'skipped', stopSucceeded: succeeded, evidence, reason, stopError: stopError ? stopError.message : null }
  report.stopAttempts = [...(report.stopAttempts ?? []), record]
  report.stopState = evidence ?? { known: false, stopped: false, reason, stage: label }
  if (!evidence) {
    const failure = new Error(`${label}: ${reason}${stopError ? `; the stop hook also failed: ${stopError.message}` : ''}`)
    failure.code = stopError ? 'PKW_STOP_FAILED' : 'PKW_STOP_NOT_CONFIRMED'
    failure.stopError = stopError ? stopError.message : null
    throw failure
  }
  return { stopSucceeded: succeeded, evidence }
}

async function recoverPreviousRelease({ root, installed, snapshotDir, hooks, report, stop = 'run', stopSucceeded = null }) {
  const steps = { stop: stop === 'run' ? 'executed' : 'skipped', evidence: null, inputsRestored: false, currentRepointed: false, started: false }
  try {
    // Evidence is established for the instance being replaced, before restoring inputs,
    // repointing `current` or starting anything.
    let confirmation
    try {
      confirmation = await stopAndConfirm({ hooks, report, label: 'before restoring the previous release', stop, stopSucceeded })
    } catch (error) {
      report.recoverySteps = steps
      report.status = 'recovery-blocked-unverified-stop'
      return { recovered: false, error: { message: error.message, stopError: error.stopError ?? null } }
    }
    steps.evidence = confirmation.evidence
    for (const name of PROFILE_INPUTS) {
      const from = join(snapshotDir, name)
      if (!existsSync(from)) continue
      await rm(join(installed, 'profile', name), { recursive: true, force: true })
      await cp(from, join(installed, 'profile', name))
    }
    steps.inputsRestored = true
    await rm(join(root, 'current'), { force: true })
    await symlink(join('releases', releaseName(installed, root)), join(root, 'current'))
    steps.currentRepointed = true
    await hooks.start()
    steps.started = true
    report.recoverySteps = steps
    return { recovered: true }
  } catch (error) {
    report.recoverySteps = steps
    return { recovered: false, error: { message: error.message, details: deploymentErrorDetails?.(error) } }
  }
}

/**
 * Perform one release switch.
 * `hooks` supplies what a site owns: { stop, start, verify, reachable? }.
 */
export async function switchRelease({
  root, version, artifacts, registry, storeDir, hooks, allowFreshRelease = false, packageNames,
  snapshotDir, deps = {},
}) {
  // A stop hook that has already reported failure must not be called again: retrying a
  // stop that reported "not stopped" can take a healthy service down and then fail again.
  let stopAlreadyFailed = false
  // Whether the candidate became the release in service. Stage 2 recovery only applies after
  // that point: before it, nothing has to be undone.
  let promoted = false
  const install = deps.prepareInstall ?? prepareInstall
  const digest = deps.profileInputDigest ?? profileInputDigest
  const releaseDir = join(root, 'releases', version)
  const candidate = join(releaseDir, 'candidate')
  const profilePath = join(releaseDir, 'profile')
  const installed = await currentRelease(root)
  if (!installed) throw new Error(`no release is currently in service under ${root}`)
  const previousVersion = await profileVersion(join(installed, 'profile'))
  const report = { version, previousVersion, releaseDir, candidate, installedRelease: installed, snapshotDir }

  if (existsSync(profilePath)) throw new Error(`release ${version} already has a promoted profile: ${profilePath}`)
  await assertNotInService(candidate, root)
  await assertNewCandidate(candidate)
  await assertSnapshotFree(snapshotDir)
  await mkdir(candidate, { recursive: true, mode: 0o700 })

  // Seed the candidate from the release in service so the install extends a complete tree.
  await cp(join(installed, 'profile'), candidate, { recursive: true, dereference: false, verbatimSymlinks: true })
  report.seededFrom = join(installed, 'profile')

  // Install into the candidate only. The service keeps serving throughout.
  report.install = await install({ profile: candidate, artifacts, registry, storeDir, packageNames, allowFreshRelease })
  report.candidateVersion = await profileVersion(candidate)
  if (report.candidateVersion !== version) {
    const mismatch = new Error(`candidate declares ${report.candidateVersion}, expected ${version}`)
    mismatch.code = 'PKW_CANDIDATE_VERSION_MISMATCH'
    mismatch.report = report
    throw mismatch
  }
  const digestAfterInstall = await digest(candidate, packageNames)
  report.candidateDigestAfterInstall = digestAfterInstall

  // ── transaction: everything below runs while the service is stopped ───────────
  // ── Stage 1: the predecessor must be provably stopped before the candidate is promoted ──
  // The probe is consulted here even when the stop hook reports success, and a live or unknown
  // answer refuses the switch: promoting the candidate or repointing `current` while an old
  // writer may still be running is exactly the outcome this design prevents. The original stop
  // error is preserved in the report either way.
  let stopSucceeded = false
  try {
    const firstStop = await stopAndConfirm({ hooks, report, label: 'before promotion' })
    stopSucceeded = firstStop.stopSucceeded
  } catch (error) {
    report.status = 'failed-before-promotion'
    report.stopError = error.stopError ? { message: error.stopError } : report.stopError ?? null
    const failure = new Error(`Deployment refused before promoting the candidate: ${error.message}`)
    failure.code = error.code ?? 'PKW_STOP_NOT_CONFIRMED'
    failure.report = report
    throw failure
  }
  try {
    if (deps.afterStopBeforeDriftCheck) await deps.afterStopBeforeDriftCheck({ candidate, releaseDir })

    const digestBeforePromotion = await digest(candidate, packageNames)
    report.candidateDigestBeforePromotion = digestBeforePromotion
    if (digestBeforePromotion !== digestAfterInstall) {
      const drift = new Error('candidate drifted between install and promotion; refusing to switch')
      drift.code = 'PKW_CANDIDATE_DRIFT'
      throw drift
    }

    // Snapshot the inputs a rollback needs; the old release tree itself is never deleted.
    await mkdir(snapshotDir, { recursive: true, mode: 0o700 })
    for (const name of PROFILE_INPUTS) {
      const from = join(installed, 'profile', name)
      if (existsSync(from)) await cp(from, join(snapshotDir, name))
    }
    report.snapshotWritten = snapshotDir

    await rename(candidate, profilePath)
    await rm(join(root, 'current'), { force: true })
    await symlink(join('releases', version), join(root, 'current'))
    report.promoted = profilePath
    promoted = true

    await hooks.start()
    const verdict = await hooks.verify({ expectedVersion: version, expectedRelease: releaseDir })
    report.verification = assertAcceptance(verdict, { expectedVersion: version, label: 'activation verification' })
    report.status = 'activated'
    return report
  } catch (error) {
    report.activationError = { message: error.message, code: error.code ?? null, details: deploymentErrorDetails?.(error) }
    // A failure before anything was promoted has nothing to recover.
    if (!promoted) {
      report.status = 'failed-before-promotion'
      const failure = new Error(`Deployment failed before the candidate was promoted: ${error.message}`)
      failure.code = error.code ?? 'PKW_DEPLOYMENT_FAILED'
      failure.report = report
      failure.cause = error
      throw failure
    }

    // ── Stage 2: the candidate was promoted, so the stage 1 evidence is stale by definition ──
    // Verification failed or `start` threw, and a thrown `start` does not prove that no process
    // appeared. The instance to stop is now the candidate, so a fresh probe decides whether the
    // previous release may be restored at all.
    const recovery = await recoverPreviousRelease({
      root, installed, snapshotDir, hooks, report,
      stop: 'run', stopSucceeded: null,
    })
    const restoredVersion = await profileVersion(join(installed, 'profile'))
    report.rollback = { restoredRelease: installed, restoredVersion }
    if (!recovery.recovered || restoredVersion !== previousVersion) {
      report.status = 'rollback-failed'
      const reasons = [error, ...(recovery.error ? [new Error(`recovery failed: ${recovery.error.message}`)] : []),
        ...(restoredVersion !== previousVersion ? [new Error(`restored release declares ${restoredVersion}, expected ${previousVersion}`)] : [])]
      const failure = new AggregateError(reasons, `Deployment failed and the rollback did not restore the previous release`)
      failure.code = 'PKW_ROLLBACK_FAILED'
      failure.report = report
      throw failure
    }
    // Rollback evidence is graded. Reachability is infrastructure; acceptance is
    // business. Claiming success without either would be a claim we cannot support.
    report.rollbackEvidence = { reachability: 'not_verified', acceptance: 'not_verified' }
    if (hooks.reachable) {
      report.rollbackReachable = await hooks.reachable({ previousVersion })
      report.rollbackEvidence.reachability = report.rollbackReachable.reachable ? 'verified' : 'failed'
      if (!report.rollbackReachable.reachable) {
        report.status = 'rollback-failed'
        const failure = new Error(`Deployment failed and the restored release is not reachable: ${report.rollbackReachable.error ?? 'unknown'}`)
        failure.code = 'PKW_ROLLBACK_FAILED'
        failure.report = report
        failure.cause = error
        throw failure
      }
    } else {
      report.rollbackEvidence.reachability = 'not_observed_no_check'
    }
    if (hooks.verifyPrevious) {
      try {
        report.rollbackAcceptance = assertAcceptance(await hooks.verifyPrevious({ expectedVersion: previousVersion }), {
          expectedVersion: previousVersion, label: 'rollback acceptance',
        })
        report.rollbackEvidence.acceptance = 'verified'
      } catch (acceptanceError) {
        report.rollbackEvidence.acceptance = 'failed'
        report.rollbackAcceptanceError = { message: acceptanceError.message }
      }
    }
    report.status = report.rollbackEvidence.acceptance === 'verified' ? 'rolled-back' : 'rolled-back-unverified'
    const detail = report.rollbackEvidence.acceptance === 'verified'
      ? 'previous release restored; rollback acceptance verified'
      : `previous release restored; rollback acceptance NOT verified (reachability ${report.rollbackEvidence.reachability})`
    const failure = new Error(`Deployment failed; ${detail}. Original error: ${error.message}`)
    failure.code = 'PKW_DEPLOYMENT_ROLLED_BACK'
    failure.rollbackVerified = report.rollbackEvidence.acceptance === 'verified'
    failure.report = report
    failure.cause = error
    throw failure
  }
}

// ------------------------------------------------------------------ CLI entry
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, version: { type: 'string' }, 'artifact-dir': { type: 'string' },
    'store-dir': { type: 'string' }, 'stop-hook': { type: 'string' }, 'start-hook': { type: 'string' },
    'verify-hook': { type: 'string' }, 'reachable-url': { type: 'string' }, 'snapshot-dir': { type: 'string' },
    // Same parameter name the official verifier uses, so a site passes one convention.
    'expected-version': { type: 'string' },
    'state-hook': { type: 'string' }, 'managed-unit': { type: 'string' },
    'allow-fresh-release': { type: 'boolean', default: false },
  } })
  if (!values.root || !values.version || !values['artifact-dir'] || !values['stop-hook'] || !values['start-hook'] || !values['verify-hook']) {
    process.stderr.write(`Usage: node deploy/switch-release.mjs --root DIR --version V --artifact-dir DIR \
  --stop-hook F --start-hook F --verify-hook F \
  [--state-hook F | --managed-unit NAME] [--reachable-url URL] [--snapshot-dir DIR] [--expected-version V]

A stop hook that cannot be asked whether the service is stopped makes the stop state
unknown, and an unknown stop state is never treated as stopped. Supply one of:
  --state-hook F      an executable that exits 0 when the service is stopped
  --managed-unit NAME a systemd unit whose ActiveState is the evidence (systemctl is-active)
`)
    process.exit(2)
  }
  if (!values['state-hook'] && !values['managed-unit']) {
    process.stderr.write('refusing to run: a stop state probe is required (--state-hook or --managed-unit); without it the stop state would be unknown and recovery must not start a second instance\n')
    process.exit(2)
  }
  const { startLoopbackRegistry } = await import('./site/loopback-registry.mjs')
  const registry = await startLoopbackRegistry()
  try {
    const artifacts = []
    for (const entry of (await readdir(values['artifact-dir'], { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const dir = join(values['artifact-dir'], entry.name)
      for (const file of await readdir(dir)) {
        if (!file.endsWith('.tgz')) continue
        const tarball = join(dir, file)
        const manifest = JSON.parse((await import('node:child_process')).execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
        if (manifest.version !== values.version) continue
        artifacts.push({ name: manifest.name, version: manifest.version, dir, tarball, sha256: sha256(await readFile(tarball)) })
      }
    }
    const expectedVersion = values['expected-version'] ?? values.version
    if (expectedVersion !== values.version) {
      throw new Error(`--expected-version ${expectedVersion} does not match the release being installed (${values.version}); the verifier and the switch must agree on one version`)
    }
    if (artifacts.length !== 10) throw new Error(`expected 10 artifacts for ${values.version} in ${values['artifact-dir']}, found ${artifacts.length}`)
    for (const artifact of artifacts) await registry.add(artifact.tarball)
    const report = await switchRelease({
      root: resolve(values.root), version: values.version, artifacts, registry: registry.url,
      storeDir: values['store-dir'], allowFreshRelease: values['allow-fresh-release'],
      snapshotDir: resolve(values['snapshot-dir'] ?? join(values.root, 'snapshots', values.version)),
      hooks: {
        stop: () => run(values['stop-hook'], [], undefined),
        start: () => run(values['start-hook'], [], undefined),
        // The state probe is the evidence the recovery path needs. A systemd unit that
        // reports inactive is not by itself proof that every process it started is gone, so
        // the unit's whole cgroup is inspected: the unit must be inactive AND its cgroup
        // must hold no processes. Anything that cannot be established stays unknown, and the
        // shared cgroup is never stopped to satisfy this check.
        isStopped: async () => {
          if (values['state-hook']) {
            try { await run(values['state-hook'], [], undefined); return { known: true, stopped: true, source: 'state-hook' } } catch { return { known: true, stopped: false, source: 'state-hook' } }
          }
          const unit = values['managed-unit']
          const { spawn: spawnChild } = await import('node:child_process')
          const exec = args => new Promise(resolvePromise => {
            const child = spawnChild('systemctl', args, { stdio: ['ignore', 'pipe', 'ignore'] })
            let out = ''
            child.stdout.on('data', c => { out += c })
            child.once('error', () => resolvePromise(null))
            child.once('exit', () => resolvePromise(out.trim()))
          })
          const active = await exec(['is-active', unit])
          if (active === null) return { known: false, stopped: false, reason: 'systemctl-unavailable', unit }
          if (active !== 'inactive' && active !== 'failed') {
            return { known: true, stopped: false, state: active, unit, source: 'systemctl-is-active' }
          }
          // The unit is down. Verify nothing it started is still running in its cgroup.
          const pids = await exec(['show', '-p', 'MainPID', '--value', unit])
          const controlGroup = await exec(['show', '-p', 'ControlGroup', '--value', unit])
          const members = []
          if (controlGroup) {
            const { readdir, readFile } = await import('node:fs/promises')
            const cgroupPath = join('/sys/fs/cgroup', controlGroup.replace(/^\//, ''))
            const walk = async dir => {
              for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
                const full = join(dir, entry.name)
                if (entry.isDirectory()) { await walk(full); continue }
                if (entry.name === 'cgroup.procs') {
                  const text = await readFile(full, 'utf8').catch(() => '')
                  for (const line of text.split('\n')) if (line.trim()) members.push(Number(line.trim()))
                }
              }
            }
            await walk(cgroupPath)
          }
          const live = members.filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
          if (live.length > 0) {
            return { known: true, stopped: false, state: active, leftoverPids: live.slice(0, 5), unit, source: 'cgroup-members' }
          }
          return { known: true, stopped: true, state: active, mainPid: pids ?? null, cgroupMembers: members.length, unit, source: 'systemctl-is-active+cgroup-members' }
        },
        verify: async ({ expectedVersion }) => {
          const output = await new Promise((resolvePromise, reject) => {
            // The verifier receives the version under the same flag name the switch uses.
            const child = spawn(values['verify-hook'], ['--expected-version', expectedVersion, '--mode', 'activate'], { stdio: ['ignore', 'pipe', 'pipe'] })
            let out = ''
            child.stdout.on('data', c => { out += c })
            child.stderr.on('data', c => { out += c })
            child.once('exit', code => code === 0 ? resolvePromise(out) : reject(new Error(out.trim() || `verifier exited ${code}`)))
          })
          return JSON.parse(output.trim().split('\n').filter(Boolean).slice(-1)[0])
        },
      },
    })
    console.log(JSON.stringify({ status: report.status, version: report.version, previousVersion: report.previousVersion }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ status: error.code ?? 'failed', message: error.message, original: error.cause?.message ?? null }, null, 2))
    process.exit(1)
  } finally { await registry.close() }
}

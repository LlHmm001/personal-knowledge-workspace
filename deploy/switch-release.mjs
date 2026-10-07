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
  if (result.enforcing === false) refuse(`${label} is a diagnostics run, which cannot accept a deployment`)
  if (result.checks && result.checks.authenticated !== 'verified') {
    refuse(`${label} did not verify an authenticated session (authenticated=${JSON.stringify(result.checks.authenticated)})`)
  }
  const serving = result.checks?.servingVersion ?? result.servingVersion
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
async function recoverPreviousRelease({ root, installed, snapshotDir, hooks, report }) {
  const steps = { stopped: false, inputsRestored: false, currentRepointed: false, started: false }
  try {
    // A stop that fails here cannot be ignored: if the old writer is still up, restoring
    // its inputs and starting again would be reported as a recovery that did not happen.
    await hooks.stop()
    steps.stopped = true
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
  let stopped = false
  let stopError = null
  try {
    await hooks.stop()
    stopped = true
  } catch (error) {
    // A stop that reports failure may still have stopped the service. Ask the site
    // rather than assuming, because the recovery path depends on the real state.
    stopError = { message: error.message }
    report.stopError = stopError
    report.stopErrorHandled = true
    if (hooks.isStopped) {
      const state = await hooks.isStopped().catch(() => ({ known: false }))
      report.stopState = state
      if (state.known === true && state.stopped === true) {
        // It reported failure but the service is down, so the transaction can proceed.
        stopped = true
      } else if (state.known === true) {
        // Still running: nothing is stopped, so there is nothing to recover, and the
        // caller must not be told that a rollback happened.
        report.status = 'failed-before-stop'
        const failure = new Error(`the service is still running after the stop failed: ${error.message}`)
        failure.code = 'PKW_STOP_FAILED'
        failure.report = report
        failure.cause = error
        throw failure
      } else {
        // Unknown: the safe reading is "assume it did stop" and let recovery try again.
        // Refusing here would leave a service that may be down with the new release
        // installed and no attempt to bring the old one back.
        stopped = true
        report.stopState = { ...state, assumed: 'stopped' }
        report.stopFailureProceeded = true
      }
    } else {
      // No way to observe the state: assume the stop happened, because refusing to
      // attempt recovery would leave a stopped service with the new release installed.
      stopped = true
      report.stopState = { known: false, assumed: 'stopped' }
    }
  }
  try {
    // A stop that reported failure is never swallowed. The site's own answer above
    // decided whether the transaction may continue, but the deployment still ends as a
    // failure, because pretending it succeeded would hide a service that did not stop
    // when it was told to.
    if (stopError) {
      const failure = new Error(`the stop command reported failure: ${stopError.message}`)
      failure.code = 'PKW_STOP_FAILED'
      throw failure
    }
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

    await hooks.start()
    const verdict = await hooks.verify({ expectedVersion: version, expectedRelease: releaseDir })
    report.verification = assertAcceptance(verdict, { expectedVersion: version, label: 'activation verification' })
    report.status = 'activated'
    return report
  } catch (error) {
    report.activationError = { message: error.message, code: error.code ?? null, details: deploymentErrorDetails?.(error) }
    if (!stopped) {
      // Nothing was stopped, so there is nothing to recover.
      report.status = 'failed-before-stop'
      const failure = new Error(`Deployment failed before the service was stopped: ${error.message}`)
      failure.code = error.code ?? 'PKW_DEPLOYMENT_FAILED'
      failure.report = report
      failure.cause = error
      throw failure
    }

    const recovery = await recoverPreviousRelease({ root, installed, snapshotDir, hooks, report })
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
    'allow-fresh-release': { type: 'boolean', default: false },
  } })
  if (!values.root || !values.version || !values['artifact-dir'] || !values['stop-hook'] || !values['start-hook'] || !values['verify-hook']) {
    process.stderr.write('Usage: node deploy/switch-release.mjs --root DIR --version V --artifact-dir DIR --stop-hook F --start-hook F --verify-hook F [--reachable-url URL] [--snapshot-dir DIR]\n')
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
    if (artifacts.length !== 10) throw new Error(`expected 10 artifacts for ${values.version} in ${values['artifact-dir']}, found ${artifacts.length}`)
    for (const artifact of artifacts) await registry.add(artifact.tarball)
    const report = await switchRelease({
      root: resolve(values.root), version: values.version, artifacts, registry: registry.url,
      storeDir: values['store-dir'], allowFreshRelease: values['allow-fresh-release'],
      snapshotDir: resolve(values['snapshot-dir'] ?? join(values.root, 'snapshots', values.version)),
      hooks: {
        stop: () => run(values['stop-hook'], [], undefined),
        start: () => run(values['start-hook'], [], undefined),
        reachable: values['reachable-url'] ? () => checkReachable({ origin: values['reachable-url'] }) : undefined,
        verify: async ({ expectedVersion }) => {
          const output = await new Promise((resolvePromise, reject) => {
            const child = spawn(values['verify-hook'], ['--expected-version', expectedVersion], { stdio: ['ignore', 'pipe', 'pipe'] })
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

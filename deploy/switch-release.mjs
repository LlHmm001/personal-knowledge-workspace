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
 * Everything after the first `stop` is one recoverable block, and its order is fixed:
 *
 *   1. stop the release in service and prove it stopped
 *   2. snapshot its declared inputs — the rollback material, taken before anything else can fail
 *   3. re-check that the candidate did not drift since the install digest
 *   4. promote the candidate and replace `current` by an atomic rename
 *   5. start the new release and verify it
 *
 * Any failure from step 1 onwards is recovered: the release that was in service is started again,
 * `current` is pointed back at it by an atomic rename, and the snapshot is applied only when it is
 * complete. The release tree is never copied over, so it keeps every file it already had. Without
 * a complete snapshot nothing is written back at all, and a fresh stop must be proven first,
 * because starting the old release beside a possibly live writer would create a second writer.
 *
 * Both errors are reported: the original one as the cause and any error raised while recovering.
 * A failed recovery is never reported as a successful rollback, a deployment that failed is never
 * reported as activated, and a failure before the stop does not stop anything at all.
 *
 * Reachability and acceptance stay separate: a rollback only has to prove the previous
 * release came back up; whether the deployment is acceptable is the verifier's decision.
 */
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { prepareInstall, profileInputDigest, deploymentErrorDetails } from '../scripts/deployment.mjs'
import { probeSystemdStopState, readCgroupMembers } from './site/systemd-stop-state.mjs'
import { probeAcceptance, observeReachability } from './site/collaboration-acceptance.mjs'

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
 * Point `current` at one release without ever leaving it missing.
 *
 * Removing the link and creating a new one opens a window in which the installation has no
 * entry point at all: a reader arriving inside it sees a broken installation rather than the
 * release that is still in service. The link is therefore built beside the entry point and
 * moved onto it by rename, which is atomic within the installation root. The temporary name is
 * unique per call so two switches cannot fight over it, and it is removed on every failure path.
 */
export async function pointCurrentAtomically(root, releaseRelativePath, ops = {}) {
  const entry = join(root, 'current')
  const staged = join(root, `.current.switch-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const createLink = ops.createLink ?? symlink
  const replaceLink = ops.rename ?? rename
  try {
    // The staged link is created first, while the entry point is untouched: whatever happens to
    // this step cannot take the installation's entry point away.
    await createLink(releaseRelativePath, staged)
    // Only this rename replaces the entry point, and it either happens or it does not.
    await replaceLink(staged, entry)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {})
    throw error
  }
  return true
}

/**
 * Capture one declared input into `to`, and describe it by everything a restore has to put back.
 * The copy is verified against its source description: a capture that does not reproduce what it
 * read is not a capture of anything.
 */
async function captureInput({ from, to, name }) {
  const description = await describeInput(from)
  await cp(from, to)
  if (!(await matchesInput(to, description))) throw new Error(`the snapshot of ${name} does not reproduce its source`)
  return description
}

/**
 * Describe one declared input by everything a restore has to put back: its bytes, its permissions,
 * whether it is a symlink and where that symlink points.
 *
 * Content alone is not enough. An input whose bytes match but whose mode changed is not the input
 * the release was built from, and a symlink whose target changed has different content even when
 * the file it currently resolves to has not changed yet.
 */
export async function describeInput(path) {
  const info = await lstat(path).catch(() => null)
  if (!info) return null
  if (info.isSymbolicLink()) return { kind: 'symlink', target: await readlink(path) }
  if (!info.isFile()) return { kind: 'unsupported', note: info.isDirectory() ? 'a directory' : 'not a regular file' }
  return { kind: 'file', mode: info.mode & 0o7777, sha256: sha256(await readFile(path)), size: info.size }
}

/** Whether a captured description still describes what is on disk at `path`. */
export async function matchesInput(path, description) {
  if (!description) return false
  const current = await describeInput(path)
  if (!current || current.kind !== description.kind) return false
  if (current.kind !== 'file') return current.target === description.target
  return current.sha256 === description.sha256 && current.mode === description.mode
}

/** Where the manifest of a snapshot lives, and what it records. */
const SNAPSHOT_MANIFEST = 'inputs.json'

/** Read the manifest of a snapshot, or null when the snapshot has none. */
async function readSnapshotManifest(snapshotDir) {
  try {
    const parsed = JSON.parse(await readFile(join(snapshotDir, SNAPSHOT_MANIFEST), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.inputs ? parsed : null
  } catch { return null }
}

/**
 * Whether two paths hold the same thing: the same bytes, the same permissions and the same kind.
 *
 * A symlink is never followed here. Symlinks are compared by the link itself, because following
 * one would compare the target instead of the input, and an input whose target moved is not the
 * input the release declared.
 */
export async function sameTree(from, to) {
  const FROM = await lstat(from).catch(() => null)
  const TO = await lstat(to).catch(() => null)
  if (!FROM || !TO) return false
  if (FROM.isSymbolicLink() || TO.isSymbolicLink()) {
    if (!FROM.isSymbolicLink() || !TO.isSymbolicLink()) return false
    return (await readlink(from)) === (await readlink(to))
  }
  if (!FROM.isFile() || !TO.isFile()) return false
  if ((FROM.mode & 0o7777) !== (TO.mode & 0o7777)) return false
  return sha256(await readFile(from)) === sha256(await readFile(to))
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
    // The result is attached, so a caller can say *why* acceptance was refused instead of only
    // that it was: the report carries the observations, the verifier's own output and any run error.
    error.result = result
    error.verifierRun = result?.run ?? null
    throw error
  }
  if (!result || typeof result !== 'object') refuse(`${label} returned no structured result`)
  // Every unmet requirement is collected and reported together. Stopping at `ok:false` would hide
  // which observation actually failed, and the two are not interchangeable evidence.
  const unmet = []
  if (result.ok !== true) unmet.push(`did not report ok:true (got ${JSON.stringify(result.ok)})`)
  // `enforcing` must be present *and* true. A verifier that omits the field has not said it was
  // enforcing, and a diagnostics run must never gate a deployment.
  if (result.enforcing !== true) unmet.push(`did not report enforcing:true (got ${JSON.stringify(result.enforcing)})`)
  // The evidence acceptance rests on must be present, not merely absent-when-wrong.
  const checks = result.checks && typeof result.checks === 'object' ? result.checks : null
  if (!checks) unmet.push('reported no checks object')
  if (checks && checks.authenticated !== 'verified') {
    unmet.push(`did not verify an authenticated session (authenticated=${JSON.stringify(checks.authenticated)})`)
  }
  const serving = checks ? (checks.servingVersion ?? result.servingVersion) : null
  if (!serving) unmet.push('did not report which release is serving')
  else if (expectedVersion && serving !== expectedVersion) unmet.push(`reports ${serving} serving, expected ${expectedVersion}`)
  if (unmet.length > 0) {
    refuse(`${label} is not acceptance: ${unmet.join('; ')}`)
  }
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

/**
 * The origin of a URL, or null when the value is not a URL at all.
 *
 * Two URLs are the same service when their origins match: scheme, host and port. A path never
 * changes which service is being probed, so a health endpoint on the same host as the portal is
 * accepted, while a different port, host or scheme is not.
 */
export function parseOrigin(value) {
  try {
    return new URL(value).origin
  } catch { return null }
}

/**
 * Run a command and keep everything it produced: stdout, stderr and the exit code.
 *
 * A command that ran and failed resolves with its code; only a command that could not be started
 * at all carries `code: null`. The distinction matters, because "systemctl reports the unit is
 * inactive" and "systemctl could not be run" are different findings, and only the first is
 * evidence about the service.
 */
function runCapture(command, args, { timeoutMs = 10000 } = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ stdout, stderr: `${stderr}\n${command} did not finish within ${timeoutMs}ms`.trim(), code: null })
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => finish({ stdout, stderr: `${stderr}${error.message}`, code: null }))
    child.once('exit', code => finish({ stdout, stderr, code }))
  })
}

/**
 * The value `current` has to hold so it resolves to `releasePath`.
 *
 * `current` lives in the installation root and its target is resolved against that root, so the
 * answer is the path relative to the root — `releases/<version>` — not the release directory's
 * own base name. For a release outside the installation the absolute path is the only honest
 * answer, and it is returned unchanged.
 */
function currentLinkTarget(releasePath, root) {
  const releasesDir = join(root, 'releases')
  return releasePath.startsWith(releasesDir + sep) ? join('releases', releasePath.slice(releasesDir.length + 1)) : releasePath
}

/**
 * Stage the inputs a rollback needs into `snapshotDir`.
 *
 * Every input is copied into the snapshot before any of them is considered usable, and the copy
 * is verified against its source. A run that fails halfway leaves a snapshot directory holding
 * some inputs and none of the others; that state is reported as such so the caller can tell
 * "nothing usable was captured" from "a complete snapshot is available". The tree being
 * snapshotted is only read here, never written.
 */
async function stageSnapshot({ snapshotDir, installed, staged, capture = captureInput }) {
  // The progress object is owned by the caller, so a failure halfway through still leaves a
  // faithful description of what was staged and what was not.
  staged.dir = snapshotDir
  staged.inputs = {}
  await rm(join(snapshotDir, SNAPSHOT_MANIFEST), { force: true })
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 })
  for (const name of PROFILE_INPUTS) {
    const from = join(installed, 'profile', name)
    if (!existsSync(from)) continue
    // The entry is recorded before it is captured, so a failure during the capture still names
    // the input it was working on.
    staged.expected.push(name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) {
      // A symlinked input cannot be captured faithfully: copying the link would make the snapshot
      // follow whatever the target does afterwards, and copying the target would freeze content
      // that the release does not actually own. This is refused before anything is captured,
      // written back or started. Capturing the link target and the resolved content separately is
      // a deliberate future extension, not something this snapshot pretends to do.
      const refusal = new Error(`the declared input ${name} is a symlink (${await readlink(from)}); a rollback cannot capture a symlinked input faithfully`)
      refusal.code = 'PKW_UNSUPPORTED_INPUT'
      throw refusal
    }
    if (!info.isFile()) {
      const refusal = new Error(`the declared input ${name} is not a regular file`)
      refusal.code = 'PKW_UNSUPPORTED_INPUT'
      throw refusal
    }
    const description = await capture({ from, to: join(snapshotDir, name), name })
    staged.inputs[name] = description
    staged.written.push(name)
  }
  // The manifest is what ties a staged copy to the exact bytes, permissions and link targets the
  // release declared. A snapshot without it is not usable for a restore.
  await writeFile(join(snapshotDir, SNAPSHOT_MANIFEST), JSON.stringify({ version: 1, inputs: staged.inputs }, null, 2) + '\n', { mode: 0o600 })
  staged.complete = true
  return staged
}

/**
 * The failure raised when a stop could not be confirmed. The original stop error is preserved as
 * the message and as `stopError`, and the code says which of the two happened: the stop hook
 * itself failed, or it did not establish that nothing is running any more.
 */
function stopNotConfirmed(confirmation, label) {
  const { reason, stopError, evidence } = confirmation
  const detail = reason ?? `the probe proves the service stopped (${JSON.stringify(evidence)})`
  const failure = new Error(`${label}: ${detail}${stopError ? `; the stop hook also failed: ${stopError.message}` : ''}`)
  failure.code = stopError ? 'PKW_STOP_FAILED' : 'PKW_STOP_NOT_CONFIRMED'
  failure.stopError = stopError ? stopError.message : null
  return failure
}

/**
 * Stop the service and establish that it really stopped.
 *
 * Stage boundary: a stop hook reporting success is not evidence by itself, and evidence from
 * an earlier stage is worthless once a different instance has been started. Callers run this
 * again for the instance they are about to replace, and a probe that reports a live process,
 * an unknown state or a failure blocks whatever the caller intended.
 *
 * The stop hook always runs: a stop that reported failure is never retried here, because
 * retrying a stop that reported "not stopped" can take a healthy service down and then fail
 * again. A hook that returns without throwing is still not evidence by itself, and a probe that
 * reports a live writer or an unknown state yields no evidence at all.
 */
async function stopAndConfirm({ hooks, report, label }) {
  let succeeded = false
  let stopError = null
  try {
    await hooks.stop()
    succeeded = true
  } catch (error) {
    stopError = error
  }
  let evidence = null
  let reason = null
  // What the probe established, when a probe was supplied and did not confirm the stop.
  // `still-running` is a positive observation that a writer is alive; `unknown` means the state
  // could not be established at all. Neither is ever treated as "stopped".
  let probeOutcome = null
  if (hooks.isStopped) {
    let probed
    try { probed = await hooks.isStopped() } catch (error) { probed = { known: false, error: error.message } }
    if (probed?.known === true && probed?.stopped === true) {
      evidence = { ...probed, stopHookSucceeded: succeeded, stage: label }
    } else if (probed?.known === true && probed?.stopped === false) {
      probeOutcome = 'still-running'
      reason = `the probe reports the service is still running (${JSON.stringify(probed)})`
    } else {
      probeOutcome = 'unknown'
      reason = `the stop state could not be established (${JSON.stringify(probed)})`
    }
  } else if (succeeded) {
    evidence = { known: true, stopped: true, source: 'stop-hook-succeeded', stage: label }
  } else {
    probeOutcome = 'unknown'
    reason = 'the stop did not succeed and no stop state probe was supplied'
  }
  const record = { label, stop: 'executed', stopSucceeded: succeeded, evidence, probeOutcome, reason, stopError: stopError ? stopError.message : null }
  report.stopAttempts = [...(report.stopAttempts ?? []), record]
  report.stopState = evidence ?? { known: false, stopped: false, probeOutcome, reason, stage: label }
  return { stopSucceeded: succeeded, evidence, probeOutcome, reason, stopError }
}

/**
 * Restore the release in service after a failure.
 *
 * Three independent questions, never conflated:
 *
 *   may the inputs be written back?   only when the snapshot is complete and still intact
 *   may anything be touched at all?   only with fresh evidence that no writer is alive now
 *   did the restore finish?           only then may the release be started and called recovered
 *
 * Evidence gathered before the promotion describes the instance that was replaced, not the one
 * that may be running after it. So a stop is requested again for whatever is live now, and it is
 * confirmed before anything is touched. A complete snapshot only makes it a candidate for being
 * applied: without a confirmed stop, recovery refuses and reports why.
 *
 * The snapshot is then verified as a whole — every registered entry present, of the recorded kind,
 * with the recorded bytes, size and permissions — before the first byte is written. Missing or
 * damaged material stops the restore there: nothing is written back, the entry point is left where
 * it is, the release is not started, and neither `inputsUnchanged` nor a recovered restore is
 * claimed. A restore that fails halfway is reported as written-but-unfinished rather than undone.
 */
async function recoverPreviousRelease({ root, installed, snapshotDir, hooks, report, restore }) {
  const applySnapshot = typeof snapshotDir === 'string'
  const steps = {
    stop: 'refused-without-evidence', stopEvidence: null,
    inputsRestored: false, inputsUnchanged: false,
    currentRepointed: false, started: false, versionConfirmed: false,
  }
  report.recoverySteps = steps
  const confirmation = await stopAndConfirm({ hooks, report, label: 'before restoring the previous release' })
  if (!confirmation.evidence) {
    const failure = stopNotConfirmed(confirmation, 'before restoring the previous release')
    steps.inputsUnchanged = true
    report.status = 'recovery-blocked-unverified-stop'
    return { recovered: false, failureReason: failure.message, error: { message: failure.message, code: failure.code, stopError: failure.stopError } }
  }
  steps.stop = 'confirmed'
  steps.stopEvidence = confirmation.evidence
  if (!applySnapshot) {
    // No usable snapshot: nothing may be written back, but the release was stopped by this run and
    // has to be brought back up.
    steps.inputsUnchanged = true
  }
  const restored = await startPreviousReleaseSteps({ root, previousRelease: installed, snapshotDir, report, hooks, steps, applySnapshot, restore })
  report.recoverySteps = steps
  return restored
}

/**
 * Read the manifest of a snapshot and check every entry against the material actually on disk,
 * before anything is written back.
 *
 * Each registered entry must be present, of the recorded kind, and hold the recorded bytes,
 * size and permissions. An entry that is missing is a failure, never a skip: a snapshot that
 * silently drops one of its inputs is not the snapshot the release was built from, and writing
 * back the rest would leave a release that runs with inputs nobody chose.
 */
async function snapshotUsable(snapshotDir) {
  const manifest = await readSnapshotManifest(snapshotDir)
  if (!manifest) {
    const broken = new Error(`the snapshot in ${snapshotDir} has no usable manifest, so nothing may be written back from it`)
    broken.code = 'PKW_SNAPSHOT_UNUSABLE'
    throw broken
  }
  const names = Object.keys(manifest.inputs)
  if (names.length === 0) {
    const empty = new Error(`the snapshot in ${snapshotDir} registers no inputs, so it is not a snapshot of anything`)
    empty.code = 'PKW_SNAPSHOT_UNUSABLE'
    throw empty
  }
  for (const [name, description] of Object.entries(manifest.inputs)) {
    if (!description || description.kind !== 'file') {
      const refusal = new Error(`the snapshot entry ${name} is a ${description?.kind ?? 'missing kind'}, which this restore cannot put back`)
      refusal.code = 'PKW_UNSUPPORTED_INPUT'
      throw refusal
    }
    const material = await describeInput(join(snapshotDir, name))
    if (!material) {
      const missing = new Error(`the snapshot material ${name} is missing, so nothing may be written back from this snapshot`)
      missing.code = 'PKW_SNAPSHOT_UNUSABLE'
      throw missing
    }
    if (material.kind !== 'file') {
      const wrongKind = new Error(`the snapshot material ${name} is a ${material.kind}, but the manifest registered a file`)
      wrongKind.code = 'PKW_SNAPSHOT_UNUSABLE'
      throw wrongKind
    }
    if (material.sha256 !== description.sha256) {
      const corrupted = new Error(`the snapshot material ${name} does not hold the captured bytes`)
      corrupted.code = 'PKW_SNAPSHOT_UNUSABLE'
      throw corrupted
    }
    if (material.size !== description.size) {
      const wrongSize = new Error(`the snapshot material ${name} is ${material.size} bytes, but ${description.size} were captured`)
      wrongSize.code = 'PKW_SNAPSHOT_UNUSABLE'
      throw wrongSize
    }
    if (material.mode !== description.mode) {
      const wrongMode = new Error(`the snapshot material ${name} has mode ${material.mode.toString(8)}, but ${description.mode.toString(8)} was captured`)
      wrongMode.code = 'PKW_SNAPSHOT_UNUSABLE'
      throw wrongMode
    }
  }
  return manifest
}

/** Put one captured input back, with the permissions the release declared. */
async function restoreInput({ from, to, name, description }) {
  await rm(to, { recursive: true, force: true })
  await cp(from, to)
  await chmod(to, description.mode)
  if (!(await matchesInput(to, description))) throw new Error(`the restored input ${name} does not match the snapshot`)
}

/** Write the captured inputs back. The snapshot is verified as a whole before the first write. */
async function restoreInputs({ snapshotDir, previousRelease, steps, restore }) {
  const manifest = await snapshotUsable(snapshotDir)
  for (const [name, description] of Object.entries(manifest.inputs)) {
    const from = join(snapshotDir, name)
    const to = join(previousRelease, 'profile', name)
    // An input that still matches the capture — bytes, permissions and, for a link, the link
    // itself — is left alone: rewriting it could only lose something.
    if (await matchesInput(to, description)) continue
    await restore({ from, to, name, description })
    steps.inputsRestored = true
  }
  if (!steps.inputsRestored) steps.inputsUnchanged = true
}

/**
 * The shared tail of both recovery modes: apply the inputs, replace the entry point atomically,
 * start the release, and read its version back.
 *
 * The inputs are verified and written before the entry point is touched or anything is started.
 * A snapshot that is missing material, corrupted, or already registered as unusable stops the
 * restore there: nothing is written back, the entry point is left where it is, the old release is
 * not started, and neither `inputsUnchanged` nor a recovered restore is claimed.
 */
async function startPreviousReleaseSteps({ root, previousRelease, snapshotDir, report, hooks, steps, applySnapshot, restore = restoreInput }) {
  try {
    if (applySnapshot) await restoreInputs({ snapshotDir, previousRelease, steps, restore })
    steps.currentRepointed = await pointCurrentAtomically(root, currentLinkTarget(previousRelease, root))
    await hooks.start()
    steps.started = true
    steps.versionConfirmed = (await profileVersion(join(previousRelease, 'profile'))) !== null
    report.previousRestore = { required: true, steps }
    return { recovered: true }
  } catch (error) {
    report.previousRestore = { required: true, steps, error: { message: error.message } }
    return { recovered: false, failureReason: error.message, error: { message: error.message, code: error.code ?? null, details: deploymentErrorDetails?.(error) } }
  }
}

/**
 * The uniform refusal for a failure that happened before the candidate was promoted.
 * `previousRestore` is attached by the caller before this runs, so the caller can say separately
 * whether the predecessor had to be brought back and whether it was.
 */
function refusedBeforePromotion(error, report) {
  if (!report.status || report.status === 'activated') report.status = 'failed-before-promotion'
  const failure = new Error(`Deployment failed before the candidate was promoted: ${error.message}`)
  failure.code = error.code ?? 'PKW_DEPLOYMENT_FAILED'
  failure.report = report
  failure.cause = error
  return failure
}

/**
 * Whether the entry point no longer leads to the release that was in service.
 *
 * A partial promotion can leave `current` pointing at the candidate, or absent entirely when the
 * replacement failed midway. Both have to be undone, so the answer is read from the filesystem
 * rather than remembered from the recorded actions; an unreadable entry point counts as needing
 * restoration because a broken installation is worse than an unnecessary one.
 */
async function pointerNeedsRestoring(root, installed) {
  let target
  try {
    target = await currentRelease(root)
  } catch { return true }
  return target !== installed
}

/**
 * Perform one release switch.
 * `hooks` supplies what a site owns: { stop, start, verify, reachable? }.
 */
export async function switchRelease({
  root, version, artifacts, registry, storeDir, hooks, allowFreshRelease = false, packageNames,
  snapshotDir, deps = {},
}) {
  // Whether the candidate became the release in service. Recovery applies from the confirmed
  // stop onwards; this flag records how far the promotion itself got.
  let promoted = false
  // Whether the rollback snapshot is complete. Until the whole loop has finished, the snapshot
  // directory holds a partial copy that must never be applied over the old release.
  let snapshotTaken = false
  // What this run actually did on disk, recorded item by item as it happens. Recovery reads this
  // instead of inferring the state of the installation from the error that ended the run.
  const actions = {
    stopConfirmed: false, renamedCandidateToProfile: false, pointerSwitched: false,
    candidateStarted: false, startFailed: false, verificationFailed: false,
  }
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
  // writer may still be running is exactly the outcome this design prevents. A refusal here
  // leaves the release in service running and its entry point untouched, and the original stop
  // error is preserved in the report.
  // The stop is confirmed inside the transaction, not before it. A stop that reports failure
  // while the probe proves the service is down is a failed deployment that still has a stopped
  // release to bring back: it must travel through the recovery path, not be thrown past it.
  const firstStop = await stopAndConfirm({ hooks, report, label: 'before promotion' })
  if (!firstStop.evidence) {
    // Nothing is known to have stopped, so nothing is restored. The refusal is reported as such by
    // the recovery decision below, which sees a run that confirmed no stop and changed no pointer.
    report.status = 'failed-before-promotion'
    report.stopError = firstStop.stopError ? firstStop.stopError.message : null
  } else {
    actions.stopConfirmed = true
    if (firstStop.stopError) {
      // Stopping safely is not the same as stopping successfully: proceeding would activate the
      // candidate on the strength of an operation that failed. The evidence that the service is
      // down is still used to bring the release in service back up.
      report.stopError = firstStop.stopError.message
    }
  }
  try {
    if (!firstStop.evidence) throw stopNotConfirmed(firstStop, 'Deployment refused before promoting the candidate')
    if (firstStop.stopError) throw stopNotConfirmed(firstStop, 'The stop of the release in service failed')
    // The snapshot is taken first, immediately after the stop is confirmed. Every later failure in
    // this block has a complete rollback snapshot available to it, and no later check can fail
    // before the recovery material exists.
    report.snapshot = { dir: snapshotDir, expected: [], written: [], complete: false }
    try {
      await stageSnapshot({
        snapshotDir, installed, staged: report.snapshot,
        capture: deps.captureInput ? ({ from, to, name }) => deps.captureInput({ from, to, name, describe: describeInput, copy: cp }) : undefined,
      })
      report.snapshotWritten = snapshotDir
    } catch (snapshotError) {
      // Nothing may be restored from a snapshot that was never completed: staging some of the
      // inputs and copying them back would replace a complete release with an incomplete one.
      // A refusal keeps its own code, because "this input cannot be captured" is a different
      // finding from "the capture ran out of road"; every other failure is named as the phase it
      // happened in, with the underlying errno left in the message.
      snapshotError.code = snapshotError.code ?? 'PKW_SNAPSHOT_INCOMPLETE'
      throw snapshotError
    }
    // Only now is the snapshot complete enough to restore from.
    snapshotTaken = true

    // Then the candidate is re-checked: it must not have changed since the install digest.
    if (deps.afterStopBeforeDriftCheck) await deps.afterStopBeforeDriftCheck({ candidate, releaseDir })
    const digestBeforePromotion = await digest(candidate, packageNames)
    report.candidateDigestBeforePromotion = digestBeforePromotion
    if (digestBeforePromotion !== digestAfterInstall) {
      const drift = new Error('candidate drifted between install and promotion; refusing to switch')
      drift.code = 'PKW_CANDIDATE_DRIFT'
      throw drift
    }

    // Each step that changes the installation on disk is recorded as it completes, so the
    // recovery knows exactly how much has to be undone instead of guessing from the error.
    await rename(candidate, profilePath)
    actions.renamedCandidateToProfile = true
    actions.pointerSwitched = await pointCurrentAtomically(root, join('releases', version))
    report.promoted = profilePath
    promoted = true

    try {
      await hooks.start()
      actions.candidateStarted = true
    } catch (startError) {
      actions.startFailed = true
      throw startError
    }
    try {
      const verdict = await hooks.verify({ expectedVersion: version, expectedRelease: releaseDir })
      report.verification = assertAcceptance(verdict, { expectedVersion: version, label: 'activation verification' })
    } catch (verificationError) {
      actions.verificationFailed = true
      throw verificationError
    }
    report.status = 'activated'
    return report
  } catch (error) {
    report.activationError = { message: error.message, code: error.code ?? null, details: deploymentErrorDetails?.(error) }
    report.actions = { ...actions }
    // A failure before promotion may still have stopped the release in service and may still have
    // taken its entry point apart. "Not promoted yet" is never treated as "no side effects": the
    // entry point is always inspected, and the snapshot is applied only when it is complete.
    // A confirmed stop is on its own a reason to restore: the release in service is down whether
    // or not a snapshot was ever completed, and leaving it down is not an acceptable outcome.
    const needsRecovery = promoted || actions.renamedCandidateToProfile
      || actions.startFailed || actions.verificationFailed
      || actions.stopConfirmed
      || await pointerNeedsRestoring(root, installed)
    if (!needsRecovery) {
      const stopRefused = !actions.stopConfirmed
      report.previousRestore = {
        required: false,
        reason: stopRefused
          ? `the release in service was not stopped (${report.stopState?.probeOutcome ?? 'no evidence'}) and its entry point still leads to it, so nothing was written back`
          : 'the release in service was never stopped and its entry point still points at it, so nothing was written back',
        stopEvidenceAtFailure: actions.stopConfirmed,
      }
      const refusal = refusedBeforePromotion(error, report)
      // The original stop failure stays on the error as well as on the report: a caller that only
      // catches the error must still be able to see why the stop did not succeed.
      refusal.stopError = error.stopError ?? null
      throw refusal
    }
    report.previousRestore = { required: true, stopEvidenceAtFailure: actions.stopConfirmed }

    // The release to restore is the one this run found in service, and that is decided by the
    // reading taken before anything was touched. `current` deliberately leads elsewhere after a
    // promotion, so consulting it here would restore the candidate instead of the predecessor.
    const releaseToRestore = installed
    // A complete snapshot is applied; without one nothing is written back and a fresh stop must be
    // confirmed first, because restarting the old release beside a possibly live writer would
    // create the second writer this whole transaction exists to prevent.
    const recovery = await recoverPreviousRelease({
      root, installed: releaseToRestore, snapshotDir: snapshotTaken ? snapshotDir : null, hooks, report,
      restore: deps.restoreInput
        ? ({ from, to, name, description }) => deps.restoreInput({ from, to, name, description, copy: cp, setMode: chmod })
        : undefined,
    })

    const restoredVersion = await profileVersion(join(releaseToRestore, 'profile'))
    report.rollback = { restoredRelease: releaseToRestore, restoredVersion }
    if (!recovery.recovered || restoredVersion !== previousVersion) {
      if (report.status !== 'recovery-blocked-unverified-stop') report.status = 'rollback-failed'
      const reasons = [error, ...(recovery.error ? [new Error(`recovery failed: ${recovery.error.message}`)] : []),
        ...(restoredVersion !== previousVersion ? [new Error(`restored release declares ${restoredVersion}, expected ${previousVersion}`)] : [])]
      const failure = new AggregateError(reasons, `Deployment failed and the previous release was not restored`)
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

// The acceptance observations the CLI's own hooks produced. Declared here because both the try and
// the catch use them: a refusal has to be able to say what the verifier actually reported.
const acceptanceObserved = {}

// ------------------------------------------------------------------ CLI entry
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, version: { type: 'string' }, 'artifact-dir': { type: 'string' },
    'store-dir': { type: 'string' }, 'stop-hook': { type: 'string' }, 'start-hook': { type: 'string' },
    'verify-hook': { type: 'string' }, 'reachable-url': { type: 'string' }, 'snapshot-dir': { type: 'string' },
    // Same parameter name the official verifier uses, so a site passes one convention.
    'expected-version': { type: 'string' },
    'state-hook': { type: 'string' }, 'managed-unit': { type: 'string' },
    'public-origin': { type: 'string' },
    // The Harness peers the release resolves against, as a directory tree of tarballs
    // (`@scope/name/*.tgz`). They are not part of the release, but an offline install has to be
    // able to resolve them, and the registry this CLI serves is the only one it can offer.
    'support-dir': { type: 'string' },
    'allow-fresh-release': { type: 'boolean', default: false },
  } })
  if (!values.root || !values.version || !values['artifact-dir'] || !values['stop-hook'] || !values['start-hook'] || !values['verify-hook']) {
    process.stderr.write(`Usage: node deploy/switch-release.mjs --root DIR --version V --artifact-dir DIR \
  --stop-hook F --start-hook F --verify-hook F \
  [--state-hook F | --managed-unit NAME] --reachable-url URL \
  [--public-origin URL] [--snapshot-dir DIR] [--expected-version V] [--support-dir DIR]

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
  if (!values['reachable-url']) {
    process.stderr.write('refusing to run: --reachable-url is required; without it reachability, authentication, the serving version and the note read-back cannot be observed, and a rollback could not be accepted on evidence\n')
    process.exit(2)
  }
  // Same origin, by URL semantics rather than by string equality: a health endpoint
  // (`http://127.0.0.1:3081/healthz`) and the origin users reach (`http://127.0.0.1:3081`) describe
  // one service, and refusing that pair would refuse the ordinary configuration.
  const reachableOrigin = parseOrigin(values['reachable-url'])
  if (!reachableOrigin) {
    process.stderr.write(`refusing to run: --reachable-url ${values['reachable-url']} is not a URL this deployment can probe\n`)
    process.exit(2)
  }
  if (values['public-origin']) {
    const publicOrigin = parseOrigin(values['public-origin'])
    if (!publicOrigin) {
      process.stderr.write(`refusing to run: --public-origin ${values['public-origin']} is not a URL\n`)
      process.exit(2)
    }
    if (reachableOrigin !== publicOrigin) {
      process.stderr.write(`refusing to run: --reachable-url ${values['reachable-url']} and --public-origin ${values['public-origin']} must name the same origin (${reachableOrigin} vs ${publicOrigin}), so that the reachability observation and the acceptance probe describe one service\n`)
      process.exit(2)
    }
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
    // The peer closure: every tarball under the support directory is served, so an offline install
    // in an isolated environment resolves the same packages the release declares.
    const support = []
    const supportRoot = values['support-dir'] ? resolve(values['support-dir']) : null
    if (supportRoot) {
      if (!existsSync(supportRoot)) throw new Error(`--support-dir does not exist: ${supportRoot}`)
      const walk = async dir => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) { await walk(full); continue }
          if (!entry.name.endsWith('.tgz')) continue
          support.push(full)
        }
      }
      await walk(supportRoot)
      if (support.length === 0) throw new Error(`--support-dir holds no tarballs: ${supportRoot}`)
      for (const tarball of support) await registry.add(tarball)
    }
    const report = await switchRelease({
      root: resolve(values.root), version: values.version, artifacts, registry: registry.url,
      storeDir: values['store-dir'], allowFreshRelease: values['allow-fresh-release'],
      snapshotDir: resolve(values['snapshot-dir'] ?? join(values.root, 'snapshots', values.version)),
      hooks: {
        stop: () => run(values['stop-hook'], [], undefined),
        start: () => run(values['start-hook'], [], undefined),
        // Stop evidence. With --state-hook the site owns the question; with --managed-unit the
        // unit's whole identity is read: its ActiveState, its main process, its control process
        // and the processes in its cgroup. Every command's exit code and error text are kept.
        // Anything that could not be run, could not be read, was denied, or reports an identity
        // that still points at a process is not evidence that the service stopped, and an unknown
        // stop state never lets the transaction write back, repoint or start anything.
        isStopped: async () => {
          if (values['state-hook']) {
            try {
              await run(values['state-hook'], [], undefined)
              return { known: true, stopped: true, source: 'state-hook' }
            } catch (error) {
              return { known: true, stopped: false, source: 'state-hook', reason: error.message }
            }
          }
          return probeSystemdStopState({
            unit: values['managed-unit'],
            runCommand: args => runCapture('systemctl', args),
            readMembers: controlGroup => readCgroupMembers(controlGroup),
          })
        },
        // Reachability on its own: the endpoint answered, and nothing about what it serves.
        reachable: async ({ previousVersion }) => {
          const observation = await observeReachability({ url: values['reachable-url'] })
          return {
            reachable: observation.reachable, status: observation.status, url: observation.url,
            expectedVersion: previousVersion ?? null, error: observation.error ?? null,
          }
        },
        // Activation acceptance: reachability, authentication, the serving version and the note
        // read-back, observed separately and all four required.
        verify: async ({ expectedVersion }) => {
          const acceptance = await probeAcceptance({
            url: values['reachable-url'], hook: values['verify-hook'], expectedVersion, mode: 'activate',
          })
          acceptanceObserved.activation = acceptance
          return acceptance
        },
        // Rollback acceptance: the same four observations, made of the release that came back. A
        // restore that only answered on the socket is reported as unverified, never as accepted.
        verifyPrevious: async ({ expectedVersion }) => {
          const acceptance = await probeAcceptance({
            url: values['reachable-url'], hook: values['verify-hook'], expectedVersion, mode: 'rollback',
          })
          acceptanceObserved.rollback = acceptance
          return acceptance
        },
      },
    })
    report.activationAcceptance = acceptanceObserved.activation ?? null
    report.rollbackAcceptanceProbe = acceptanceObserved.rollback ?? null
    console.log(JSON.stringify({
      status: report.status, version: report.version, previousVersion: report.previousVersion,
      artifacts: artifacts.length, supportArtifacts: support.length,
      acceptance: report.activationAcceptance ? { ok: report.activationAcceptance.ok, reach: report.activationAcceptance.reach, auth: report.activationAcceptance.auth, run: report.activationAcceptance.run } : null,
    }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({
      status: error.code ?? 'failed', message: error.message, original: error.cause?.message ?? null,
      acceptance: acceptanceObserved.activation ?? null, rollbackAcceptance: acceptanceObserved.rollback ?? null,
    }, null, 2))
    process.exit(1)
  } finally { await registry.close() }
}

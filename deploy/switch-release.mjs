#!/usr/bin/env node
/**
 * Release orchestration for a PKW installation, directory-switch based.
 *
 * The pipeline never installs into the profile a service is currently using:
 *
 *   current -> releases/<old>/profile      the release in service
 *   releases/<new>/candidate               a brand-new directory: the install target
 *   releases/<new>/profile                 the candidate after it is promoted
 *
 * Order of operations:
 *
 *   1. assert the candidate is brand new and empty (nothing to overwrite);
 *   2. copy the release in service into the candidate (so the install adds to a
 *      complete tree rather than resolving from an empty one);
 *   3. install there and run the strict import check — the service keeps serving;
 *   4. record the candidate's digest;
 *   5. stop, re-verify the candidate has not drifted, snapshot, promote the candidate
 *      to `profile`, repoint `current`, start;
 *   6. verify. On failure: restore the snapshot of the release in service, repoint
 *      `current` back, start, and verify the *old version* is serving again.
 *
 * The old release tree is never deleted, so a rollback restores the actual previous
 * version rather than a re-derivation of it.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { prepareInstall, profileInputDigest, hostFingerprint, deploymentErrorDetails } from '../scripts/deployment.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Absolute path of the release a `current` symlink points at. */
export async function currentRelease(root) {
  const link = join(root, 'current')
  const target = await (await import('node:fs/promises')).readlink(link).catch(() => null)
  if (!target) return null
  return resolve(dirname(link), target)
}

/** Version declared by a profile, or null when it cannot be read. */
export async function profileVersion(profileDir) {
  try {
    return JSON.parse(await readFile(join(profileDir, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json'), 'utf8')).version
  } catch { return null }
}

/**
 * Refuse to use a direction that is not a brand-new candidate.
 * A non-empty directory is never cleaned here: it may be the release in service.
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

/** Refuse to install into a directory that is a release in service. */
export async function assertNotInService(candidateDir, root) {
  const link = join(root, 'current')
  const target = await (await import('node:fs/promises')).readlink(link).catch(() => null)
  if (!target) return
  const inService = resolve(dirname(link), target)
  if (candidateDir === inService || candidateDir.startsWith(inService + sep) || inService.startsWith(candidateDir + sep)) {
    throw new Error(`refusing to install into the release in service (${inService})`)
  }
}

/**
 * Reachability only — deliberately NOT acceptance.
 *
 * A rollback has to prove the previous release came back up; whether the deployment
 * may be accepted is the verifier's job, and conflating the two is how a healthy
 * process gets mistaken for a working service.
 */
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
 * Perform one release switch.
 * `hooks` supplies the service control a site owns: { stop, start, verify }.
 */
export async function switchRelease({
  root, version, artifacts, registry, storeDir, hooks, allowFreshRelease = false, packageNames,
  snapshotDir, beforeHost, deps = {},
}) {
  // Injectable for tests: the orchestration is what is under test here, not pnpm.
  const install = deps.prepareInstall ?? prepareInstall
  const digest = deps.profileInputDigest ?? profileInputDigest
  const releaseDir = join(root, 'releases', version)
  const candidate = join(releaseDir, 'candidate')
  const profilePath = join(releaseDir, 'profile')
  const installed = await currentRelease(root)
  if (!installed) throw new Error(`no release is currently in service under ${root}`)
  const previousVersion = await profileVersion(join(installed, 'profile'))
  const report = { version, previousVersion, releaseDir, candidate, installedRelease: installed }

  if (existsSync(join(releaseDir, 'profile'))) throw new Error(`release ${version} already has a promoted profile: ${profilePath}`)
  await assertNotInService(candidate, root)
  await assertNewCandidate(candidate)
  await mkdir(candidate, { recursive: true, mode: 0o700 })

  // 2. seed the candidate from the release in service so the install extends a complete tree.
  await cp(join(installed, 'profile'), candidate, { recursive: true, dereference: false, verbatimSymlinks: true })
  report.seededFrom = join(installed, 'profile')

  // 3. install into the candidate only.
  report.install = await install({
    profile: candidate, artifacts, registry, storeDir, packageNames, allowFreshRelease,
  })
  report.candidateVersion = await profileVersion(candidate)
  if (report.candidateVersion !== version) {
    throw Object.assign(new Error(`candidate declares ${report.candidateVersion}, expected ${version}`), { code: 'PKW_CANDIDATE_VERSION_MISMATCH' })
  }
  const afterInstallDigest = await digest(candidate, packageNames)
  report.candidateDigestAfterInstall = afterInstallDigest

  // 5. stop, then prove the candidate has not drifted since the install.
  await hooks.stop()
  // Test seam: runs after the stop and before the drift check, so a test can act as
  // an external writer without weakening the guard itself.
  if (deps.afterStopBeforeDriftCheck) await deps.afterStopBeforeDriftCheck({ candidate, releaseDir })
  const digestBeforePromotion = await digest(candidate, packageNames)
  report.candidateDigestBeforePromotion = digestBeforePromotion
  if (digestBeforePromotion !== afterInstallDigest) {
    await hooks.start()
    throw Object.assign(new Error('candidate drifted between install and promotion; refusing to switch'), { code: 'PKW_CANDIDATE_DRIFT' })
  }

  // Snapshot only the inputs a rollback needs, and keep the old release tree intact.
  await rm(snapshotDir, { recursive: true, force: true })
  await mkdir(snapshotDir, { recursive: true, mode: 0o700 })
  for (const name of ['package.json', 'pnpm-lock.yaml', '.npmrc']) {
    const from = join(installed, 'profile', name)
    if (existsSync(from)) await cp(from, join(snapshotDir, name))
  }
  report.snapshot = snapshotDir

  // Promote: candidate becomes the release's profile, then current points at it.
  await rename(candidate, profilePath)
  await rm(join(root, 'current'), { force: true })
  await symlink(join('releases', version), join(root, 'current'))
  await hooks.start()
  report.promoted = profilePath

  try {
    report.verification = await hooks.verify({ expectedVersion: version, expectedRelease: releaseDir })
    report.status = 'activated'
    return report
  } catch (error) {
    report.activationError = deploymentErrorDetails ? deploymentErrorDetails(error) : { message: error.message }
    // Roll back to the preserved release: repoint current at the old tree, restore the
    // snapshot into it, and start again.
    await hooks.stop().catch(() => {})
    for (const name of ['package.json', 'pnpm-lock.yaml', '.npmrc']) {
      const from = join(snapshotDir, name)
      if (!existsSync(from)) continue
      await rm(join(installed, 'profile', name), { recursive: true, force: true })
      await cp(from, join(installed, 'profile', name))
    }
    await rm(join(root, 'current'), { force: true })
    await symlink(join('releases', basenameOfRelease(installed, root)), join(root, 'current'))
    await hooks.start()
    const restoredVersion = await profileVersion(join(installed, 'profile'))
    if (restoredVersion !== previousVersion) {
      const failure = new Error(`restored release declares ${restoredVersion}, expected ${previousVersion}`)
      failure.code = 'PKW_ROLLBACK_FAILED'
      failure.report = report
      throw failure
    }
    report.rollback = { restoredRelease: installed, restoredVersion }
    try {
      // The previous release must be *reachable again*; acceptance is the verifier's
      // decision and is reported separately, never inferred from reachability.
      if (hooks.reachable) {
        report.rollbackReachable = await hooks.reachable({ previousVersion })
        if (!report.rollbackReachable.reachable) throw new Error(`the restored release is not reachable: ${report.rollbackReachable.error}`)
      }
      report.status = 'rolled-back'
    } catch (rollbackError) {
      report.rollbackError = { message: rollbackError.message }
      report.status = 'rollback-failed'
      const failure = new Error(`Deployment failed and the rollback did not come back up: ${rollbackError.message}`)
      failure.code = 'PKW_ROLLBACK_FAILED'
      failure.report = report
      throw failure
    }
    const failure = new Error(`Deployment failed; previous release ${previousVersion} restored and verified`)
    failure.code = 'PKW_DEPLOYMENT_ROLLED_BACK'
    failure.report = report
    throw failure
  }
}

function basenameOfRelease(releasePath, root) {
  const releasesDir = join(root, 'releases')
  return releasePath.startsWith(releasesDir + sep) ? releasePath.slice(releasesDir.length + 1) : releasePath
}

// ------------------------------------------------------------------ CLI entry
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, version: { type: 'string' }, 'artifact-dir': { type: 'string' },
    'store-dir': { type: 'string' }, 'stop-hook': { type: 'string' }, 'start-hook': { type: 'string' },
    'verify-hook': { type: 'string' }, 'snapshot-dir': { type: 'string' }, 'allow-fresh-release': { type: 'boolean', default: false },
  } })
  if (!values.root || !values.version || !values['artifact-dir']) {
    process.stderr.write('Usage: node deploy/switch-release.mjs --root DIR --version V --artifact-dir DIR --stop-hook F --start-hook F --verify-hook F\n')
    process.exit(2)
  }
  const { startLoopbackRegistry } = await import('./site/loopback-registry.mjs')
  const registry = await startLoopbackRegistry()
  const artifacts = []
  try {
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
    if (artifacts.length !== 10) throw new Error(`expected 10 artifacts for ${values.version}, found ${artifacts.length}`)
    for (const artifact of artifacts) await registry.add(artifact.tarball)
    const hook = path => () => run(path, [], undefined)
    const report = await switchRelease({
      root: resolve(values.root), version: values.version, artifacts, registry: registry.url,
      storeDir: values['store-dir'], allowFreshRelease: values['allow-fresh-release'],
      snapshotDir: resolve(values['snapshot-dir'] ?? join(values.root, 'snapshots', values.version)),
      hooks: {
        stop: hook(values['stop-hook']), start: hook(values['start-hook']),
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
    console.error(JSON.stringify({ status: error.code ?? 'failed', message: error.message }, null, 2))
    process.exit(1)
  } finally { await registry.close() }
}

#!/usr/bin/env node
/**
 * Rehearsal driver: runs the ONE supported switch transaction against copies.
 *
 * There is no second pipeline here. `deploy/switch-release.mjs` owns install,
 * promotion, rollback and recovery; this file only supplies isolated inputs and
 * injectable failures, so a rehearsal exercises the same code a real deployment runs:
 *
 *   - the release root, the profile copies and the data copy are created by this
 *     driver, and the data copy comes from `scripts/copy-data-root.mjs`, which snapshots
 *     the databases and writes straight to the final destination;
 *   - stop/start manage this driver's own listener on its own port, never a real unit;
 *   - injectable failures: a failing install, a candidate modified after the install
 *     while the service is stopped, and a failing verification.
 *
 * Every phase is written to `report.json` so a caller asserts on facts.
 */
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { switchRelease, profileVersion, currentRelease, checkReachable } from './switch-release.mjs'
import { copyDataRoot, verifyExistingCopy, isNotIsolated } from '../scripts/copy-data-root.mjs'
import { startLoopbackRegistry } from './site/loopback-registry.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  'work-dir': { type: 'string' }, 'data-source': { type: 'string' }, 'profile-source': { type: 'string' },
  'artifact-dir': { type: 'string' }, version: { type: 'string' }, port: { type: 'string' },
  'old-version': { type: 'string' }, 'store-dir': { type: 'string' }, 'bootstrap-username': { type: 'string' },
  'force-verify-failure': { type: 'boolean', default: false },
  'bootstrap-password': { type: 'string' },
  'fail-install': { type: 'boolean', default: false },
  'modify-candidate-after-install': { type: 'boolean', default: false },
} })
if (!values['work-dir'] || !values['data-source'] || !values['profile-source'] || !values['artifact-dir'] || !values.version || !values.port) {
  process.stderr.write('Usage: node deploy/rehearse-release.mjs --work-dir DIR --data-source DIR --profile-source DIR --artifact-dir DIR --version V --port N [--old-version V] [--fail-install] [--modify-candidate-after-install] [--force-verify-failure]\n')
  process.exit(2)
}
const workDir = resolve(values['work-dir'])
const version = values.version
const port = Number(values.port)
const oldVersion = values['old-version'] ?? '0.0.0-rehearsal-old'
const report = { version, oldVersion, workDir, port, phases: {}, startedAt: new Date().toISOString() }

await mkdir(workDir, { recursive: true, mode: 0o700 })
const root = join(workDir, 'root')
const logDir = join(workDir, 'logs')
await mkdir(logDir, { recursive: true, mode: 0o700 })

// ── the release in service: a copy of the supplied profile, labelled with the old version
const oldRelease = join(root, 'releases', oldVersion, 'profile')
if (!existsSync(join(oldRelease, 'package.json'))) {
  await mkdir(join(root, 'releases'), { recursive: true })
  await cp(resolve(values['profile-source']), oldRelease, { recursive: true, dereference: false, verbatimSymlinks: true })
  await writeFile(join(oldRelease, 'pnpm-workspace.yaml'), 'packages: []\n')
  // The seed carries the profile's own `.npmrc`, which pins the registry the profile was built
  // from — a one-off loopback registry that is gone by the time a rehearsal runs. Left in place it
  // makes every install hang against a dead port. The transaction passes its own registry
  // explicitly, so the seed's pinned one is removed here and the rehearsal uses the live one.
  await rm(join(oldRelease, '.npmrc'), { force: true })
  for (const entry of await readdir(join(oldRelease, 'node_modules/@deepseek-ai'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-pkw-')) continue
    const manifestPath = join(oldRelease, 'node_modules/@deepseek-ai', entry.name, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.version = oldVersion
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  await symlink(join('releases', oldVersion), join(root, 'current'))
  report.phases.seedRelease = { from: resolve(values['profile-source']), to: oldRelease, oldVersion }
}

// ── the data copy: the shared copier writes straight to the final destination, and the library
// itself refuses a copy that is not isolated from its source. The refusal is reported here with
// the findings the library attached, and the rehearsal stops: nothing is configured and no
// listener is started on a copy that failed the gate. The copy is left in place for inspection.
const dataRoot = join(workDir, 'data')
/**
 * Report a refused data copy and stop the rehearsal. Nothing is configured and no listener is
 * started, and the directory is left exactly as it is: a failure that is cleaned up cannot be
 * inspected, and a failure that is reused silently is worse than either.
 */
async function refuseDataRoot(error, phase) {
  report.status = 'copy-not-self-contained'
  report.phases.copyData = {
    to: dataRoot, preserved: true, reused: phase === 're-verified',
    leaks: error.leaks ?? [], writableProblems: error.writableProblems ?? [],
    databases: error.databases ?? [], rewritten: error.rewritten ?? [],
  }
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.error(JSON.stringify({
    status: report.status, phase, message: error.message, target: dataRoot, preserved: true,
    leaks: (error.leaks ?? []).slice(0, 3), writableProblems: (error.writableProblems ?? []).slice(0, 3),
  }, null, 2))
  process.exit(1)
}
// An existing data directory is re-verified in full, never trusted because it is there. A copy
// that failed the gate is deliberately kept on disk, so the next run of the same work directory
// finds exactly the copy that was refused; and a directory that was left by an interrupted run is
// not known to be complete either. `identity.sqlite` existing says only that something wrote here.
if (existsSync(join(dataRoot, 'identity.sqlite'))) {
  let verified
  try {
    verified = await verifyExistingCopy(resolve(values['data-source']), dataRoot)
  } catch (error) {
    if (!isNotIsolated(error)) throw error
    await refuseDataRoot(error, 're-verified')
  }
  report.phases.copyData = {
    to: dataRoot, reloaded: true,
    leaks: verified.leaks.length, writableProblems: verified.writableProblems.length,
  }
} else {
  let copy
  try {
    copy = await copyDataRoot(resolve(values['data-source']), dataRoot)
  } catch (error) {
    if (!isNotIsolated(error)) throw error
    await refuseDataRoot(error, 'copied')
  }
  report.phases.copyData = {
    to: dataRoot, databases: copy.databases.length, rewritten: copy.rewritten.length,
    leaks: 0, writableProblems: 0,
  }
}

// ── hooks: one listener on this driver's port, resolved through `current`
const configPath = join(workDir, 'collaboration.json')
await writeFile(configPath, JSON.stringify({
  dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: values['bootstrap-username'] ?? 'owner',
  bootstrapPasswordEnv: 'PKW_REHEARSAL_BOOTSTRAP',
}, null, 2) + '\n', { mode: 0o600 })
const pidFile = join(workDir, 'listener.pid')
let listener = null
/**
 * Stop this driver's listener and report what actually happened. A stop that times out is
 * not graceful: the pid file is kept (it still names a live process) and the failure is
 * raised so the transaction's recovery path runs.
 */
const stopHook = async () => {
  if (!existsSync(pidFile)) { report.phases.stop = { alreadyStopped: true }; return }
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  let alive = false
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); alive = true } catch { alive = false; break }
    await new Promise(r => setTimeout(r, 100))
  }
  if (alive) {
    report.phases.stop = { pid, graceful: false, alive: true }
    throw new Error(`listener ${pid} did not stop within the drain budget`)
  }
  await rm(pidFile, { force: true })
  report.phases.stop = { pid, graceful: true }
}
/** The site's own answer to "is it stopped?", used when a stop reports failure. */
const isStopped = async () => {
  if (!existsSync(pidFile)) return { known: true, stopped: true }
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  try { process.kill(pid, 0); return { known: true, stopped: false } } catch { return { known: true, stopped: true } }
}

/**
 * Run the official collaboration verifier in enforcing mode, passing the release version
 * through the same parameter name the official CLI uses, so the parameter combination is
 * exercised rather than assumed.
 */
async function runVerifier(expectedVersion, mode) {
  const credentialsFile = join(workDir, 'owner-password')
  if (!existsSync(credentialsFile)) await writeFile(credentialsFile, `${values['bootstrap-password'] ?? 'rehearsal-password'}\n`, { mode: 0o600 })
  const args = [
    join(repoRoot, 'deploy/site/verify-collaboration.mjs'),
    '--mode', mode, '--profile', join(await currentRelease(root), 'profile'),
    '--public-origin', `http://127.0.0.1:${port}`, '--gateway-url', `http://127.0.0.1:${port}`,
    '--credentials-file', credentialsFile, '--username', values['bootstrap-username'] ?? 'owner',
    '--expected-version', expectedVersion,
  ]
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise(out) : reject(new Error(out.trim().split('\n').slice(-3).join(' | ') || `verifier exited ${code}`)))
  })
  return JSON.parse(output.trim().split('\n').filter(Boolean).slice(-1)[0])
}
const startHook = async () => {
  const release = await currentRelease(root)
  listener = spawn(process.execPath, [
    join(repoRoot, 'scripts/serve-collaboration.mjs'),
    '--profile', join(release, 'profile'), '--config', configPath, '--port', String(port),
  ], { env: { ...process.env, PKW_REHEARSAL_BOOTSTRAP: 'synthetic' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let output = ''
  listener.stdout.on('data', c => { output += c })
  listener.stderr.on('data', c => { output += c })
  listener.unref()
  await writeFile(pidFile, String(listener.pid))
  const reachable = await checkReachable({ origin: `http://127.0.0.1:${port}`, timeoutMs: 30_000 })
  if (!reachable.reachable) throw new Error(`${release} did not start: ${reachable.error}; ${output.slice(-300)}`)
  report.phases.start = { release, pid: listener.pid }
}

// ── artifacts: the release under test, served from a staged directory
const registry = await startLoopbackRegistry()
const artifacts = []
const support = []
try {
  for (const entry of (await readdir(resolve(values['artifact-dir']), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = join(resolve(values['artifact-dir']), entry.name)
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.tgz')) continue
      const tarball = join(dir, file)
      const manifest = JSON.parse((await import('node:child_process')).execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
      const record = { name: manifest.name, version: manifest.version, tarball }
      if (manifest.version === version) artifacts.push(record)
      else support.push(record)
    }
  }
  if (artifacts.length === 0) throw new Error(`no artifacts for ${version} in ${values['artifact-dir']}`)
  // Everything else the profile already carries is served too, so the install only has to
  // fetch this release rather than re-resolving the world.
  const supportRoot = join(oldRelease, 'node_modules/@deepseek-ai')
  for (const entry of await readdir(supportRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('dsh-pkw-')) continue
    const dir = join(supportRoot, entry.name)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const staging = join(workDir, 'support', entry.name)
    await mkdir(staging, { recursive: true })
    await cp(dir, staging, { recursive: true, dereference: true }).catch(() => {})
    try { (await import('node:child_process')).execFileSync('npm', ['pack', '--ignore-scripts', '--quiet'], { cwd: staging, stdio: 'ignore' }) } catch { continue }
    const produced = (await readdir(staging)).find(f => f.endsWith('.tgz'))
    if (produced) support.push({ name: manifest.name, version: manifest.version, tarball: join(staging, produced) })
  }
  for (const record of [...artifacts, ...support]) await registry.add(record.tarball)
  report.artifacts = artifacts.map(a => ({ name: a.name, version: a.version }))
  report.supportArtifacts = support.length

  try {
    report.result = await switchRelease({
      root, version, artifacts, registry: registry.url, storeDir: values['store-dir'],
      allowFreshRelease: true, snapshotDir: join(workDir, 'snapshots', version),
      deps: {
        prepareInstall: values['fail-install']
          ? async () => { throw new Error('rehearsal: injected install failure') }
          : async (options, ...rest) => {
            const { prepareInstall: real } = await import('../scripts/deployment.mjs')
            return real({ ...options, artifacts: [...options.artifacts, ...support] }, ...rest)
          },
        afterStopBeforeDriftCheck: values['modify-candidate-after-install']
          ? async ({ candidate }) => {
            await writeFile(join(candidate, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/index.js'), 'export const tampered = true\n')
            report.phases.driftProbe = { candidate, tampered: true }
          }
          : undefined,
      },
      hooks: {
        stop: stopHook,
        start: startHook,
        isStopped,
        // Observed, never assumed: the probe reports what it actually saw.
        reachable: async ({ previousVersion }) => {
          const state = await checkReachable({ origin: `http://127.0.0.1:${port}`, timeoutMs: 20_000 })
          report.phases.reachability = { previousVersion, ...state }
          return state
        },
        // Acceptance for the release under test: the official verifier, in its enforcing
        // mode, with the same parameter name the official CLI uses.
        verify: async ({ expectedVersion }) => {
          if (values['force-verify-failure'] && expectedVersion === version) {
            report.phases.injectedFault = 'post-activation verification'
            throw new Error('rehearsal: injected post-activation verification failure')
          }
          return await runVerifier(expectedVersion, 'activate')
        },
        // A rollback is only accepted when the restored release passes the same verifier.
        verifyPrevious: async ({ expectedVersion }) => runVerifier(expectedVersion, 'rollback'),
      },
    })
    report.status = report.result.status
  } catch (error) {
    report.status = error.code ?? 'failed'
    report.error = { message: error.message, code: error.code ?? null }
    report.result = error.report ?? null
  }
} finally {
  await registry.close()
  try { await stopHook() } catch { /* already stopped */ }
}
await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })

// Exit code policy:
//   0  the release was activated and accepted, or the injected fault produced a
//      *verified* rollback (original release restored and accepted again)
//   1  anything else: a normal failure, an unverified rollback, or a fault run whose
//      rollback did not verify
const faultInjected = Boolean(report.phases.injectedFault)
const activated = report.status === 'activated'
const rollbackVerified = report.result?.rollbackEvidence?.acceptance === 'verified'
const exitCode = activated || (faultInjected && rollbackVerified) ? 0 : 1
console.log(JSON.stringify({
  status: report.status, version, oldVersion, faultInjected, rollbackVerified, exitCode,
  phases: Object.keys(report.phases), report: join(workDir, 'report.json'),
}, null, 2))
process.exit(exitCode)

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
import { copyDataRoot } from '../scripts/copy-data-root.mjs'
import { startLoopbackRegistry } from './site/loopback-registry.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  'work-dir': { type: 'string' }, 'data-source': { type: 'string' }, 'profile-source': { type: 'string' },
  'artifact-dir': { type: 'string' }, version: { type: 'string' }, port: { type: 'string' },
  'old-version': { type: 'string' }, 'store-dir': { type: 'string' }, 'bootstrap-username': { type: 'string' },
  'force-verify-failure': { type: 'boolean', default: false },
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

// ── the data copy: the shared copier writes straight to the final destination
const dataRoot = join(workDir, 'data')
if (!existsSync(join(dataRoot, 'identity.sqlite'))) {
  const copy = await copyDataRoot(resolve(values['data-source']), dataRoot)
  report.phases.copyData = { to: dataRoot, databases: copy.databases.length, rewritten: copy.rewritten.length, leaks: copy.leaks.length }
  if (copy.leaks.length) {
    // A copy that still names its source can write the source's files.
    report.status = 'copy-not-self-contained'
    await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.error(JSON.stringify({ status: report.status, leaks: copy.leaks.slice(0, 3) }, null, 2))
    process.exit(1)
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
const stopHook = async () => {
  if (!existsSync(pidFile)) return
  const pid = Number((await readFile(pidFile, 'utf8')).trim())
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(r => setTimeout(r, 100)) }
  await rm(pidFile, { force: true })
  report.phases.stop = { pid, graceful: true }
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
        reachable: async () => ({ reachable: true, status: 200 }),
        verify: async ({ expectedVersion }) => {
          if (values['force-verify-failure'] && expectedVersion === version) {
            throw new Error('rehearsal: injected post-activation verification failure')
          }
          const installed = await profileVersion(join(await currentRelease(root), 'profile'))
          if (installed !== expectedVersion) throw new Error(`installed ${installed}, expected ${expectedVersion}`)
          const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) })
          if (health.status !== 200) throw new Error(`listener is not ready (HTTP ${health.status})`)
          return { installedVersion: installed, served: true }
        },
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
console.log(JSON.stringify({
  status: report.status, version, oldVersion,
  phases: Object.keys(report.phases), report: join(workDir, 'report.json'),
}, null, 2))
process.exit(0)

#!/usr/bin/env node
/**
 * Rehearsal runner for the release pipeline: prepare -> activate -> verify, with
 * failure injection, against an isolated copy of a profile and its data.
 *
 * It exists so the real `prepareInstall()` / `activate()` code paths can be
 * exercised without touching a serving installation:
 *
 *   - the profile is a copy, so the install writes the copy;
 *   - the data root is a copy, and its retrieval configuration is replaced with a
 *     loopback stub (or removed), so no production endpoint is written to;
 *   - stop/start are this runner's own hooks and only ever manage the rehearsal
 *     listener on the runner's port;
 *   - every phase writes its outcome to a JSON report, so the caller can assert on
 *     facts instead of trusting the exit status.
 *
 * Injected failures (never silent):
 *   --force-verify-failure   verify refuses the newly started release, which is the
 *                            deterministic way to exercise the rollback path.
 *   --fail-prepare           make the preparation install fail, to show that the
 *                            service under test is left running.
 *   --modify-profile-before-activate
 *                            touch a profile input between prepare and activate, to
 *                            show the adoption guard refuses the switch.
 */
import { createHash } from 'node:crypto'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { appendFileSync } from 'node:fs'
import {
  activate, deploymentErrorDetails, hostFingerprint, prepareInstall, profileInputDigest,
} from '../scripts/deployment.mjs'
import { DatabaseSync } from 'node:sqlite'
import { startLoopbackRegistry } from '../deploy/site/loopback-registry.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  'work-dir': { type: 'string' }, 'data-source': { type: 'string' },
  'profile-source': { type: 'string' }, version: { type: 'string' }, port: { type: 'string' },
  'force-verify-failure': { type: 'boolean', default: false },
  'fail-prepare': { type: 'boolean', default: false },
  'modify-profile-before-activate': { type: 'boolean', default: false },
  'bootstrap-username': { type: 'string' }, 'bootstrap-env': { type: 'string', default: 'PKW_REHEARSAL_BOOTSTRAP' },
  'artifact-dir': { type: 'string' }, 'store-dir': { type: 'string' },
} })
if (!values['work-dir'] || !values['data-source'] || !values['profile-source'] || !values.version) {
  process.stderr.write('Usage: node deploy/rehearse-release.mjs --work-dir DIR --data-source DIR --profile-source DIR --version V --port N [--force-verify-failure] [--fail-prepare] [--modify-profile-before-activate]\n')
  process.exit(2)
}
const workDir = resolve(values['work-dir'])
const version = values.version
const port = Number(values.port ?? 0)
const report = { version, workDir, port, phases: {}, startedAt: new Date().toISOString() }

/** Read-only summary of the copied data root: writers, spaces, notes, commits. */
async function inspectDataRoot(root) {
  const summary = { root, lock: null, writers: [], spaces: [] }
  if (existsSync(join(root, 'gateway.lock'))) summary.lock = JSON.parse(await readFile(join(root, 'gateway.lock'), 'utf8'))
  for (const entry of await readdir(join(root, 'spaces'), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const dbPath = join(root, 'spaces', entry.name, 'state.sqlite')
    if (!existsSync(dbPath)) continue
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const notes = db.prepare('SELECT count(*) AS c FROM u_pkw_notes_note_index').get().c
      const commits = db.prepare('SELECT count(*) AS c FROM u_pkw_commits').get().c
      const attachments = db.prepare('SELECT count(*) AS c FROM u_pkw_attachments_attachments').get().c
      summary.spaces.push({ id: entry.name, notes, commits, attachments })
    } catch (error) { summary.spaces.push({ id: entry.name, error: error.message }) } finally { db.close() }
  }
  return summary
}

await mkdir(workDir, { recursive: true, mode: 0o700 })
const profile = join(workDir, 'profile')
const backup = join(workDir, 'backup')
const dataRoot = join(workDir, 'data')
const hooks = join(workDir, 'hooks')
const logDir = join(workDir, 'logs')
for (const dir of [hooks, logDir]) await mkdir(dir, { recursive: true, mode: 0o700 })

// ---------------------------------------------------------------- isolated copies
if (!existsSync(join(profile, 'package.json'))) {
  await cp(resolve(values['profile-source']), profile, { recursive: true, dereference: false })
  report.phases.copyProfile = { from: resolve(values['profile-source']), to: profile }
}
if (!existsSync(join(dataRoot, 'identity.sqlite'))) {
  await cp(resolve(values['data-source']), dataRoot, { recursive: true, dereference: false })
  for (const name of ['gateway.lock', 'identity.sqlite-wal', 'identity.sqlite-shm']) await rm(join(dataRoot, name), { force: true })
  report.phases.copyData = { from: resolve(values['data-source']), to: dataRoot }
}
// Point the copy at nothing remote: no production retrieval endpoint may be written.
const configPath = join(workDir, 'collaboration.json')
await writeFile(configPath, JSON.stringify({
  dataPath: dataRoot,
  publicOrigin: `http://127.0.0.1:${port}`,
  bootstrapUsername: values['bootstrap-username'] ?? 'owner',
  bootstrapPasswordEnv: values['bootstrap-env'],
}, null, 2) + '\n', { mode: 0o600 })

// ------------------------------------------------------------------ site hooks
const stopHook = join(hooks, 'stop.sh')
const startHook = join(hooks, 'start.sh')
const pidFile = join(hooks, 'gateway.pid')
const gatewayLog = join(logDir, 'gateway.log')
await writeFile(stopHook, `#!/bin/bash
set -u
if [ -f ${pidFile} ]; then
  pid=$(cat ${pidFile})
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
  fi
  rm -f ${pidFile}
fi
exit 0
`, { mode: 0o700 })
await writeFile(startHook, `#!/bin/bash
set -u
nohup /usr/local/bin/node ${join(repoRoot, 'scripts/serve-collaboration.mjs')} \
  --profile ${profile} --config ${configPath} --port ${port} \
  >> ${gatewayLog} 2>&1 &
echo $! > ${pidFile}
for i in $(seq 1 60); do curl -sf --max-time 2 http://127.0.0.1:${port}/healthz >/dev/null 2>&1 && exit 0; sleep 0.5; done
echo "rehearsal listener did not become healthy" >&2
exit 1
`, { mode: 0o700 })

// ------------------------------------------------------------------- the run
const releasePackageNamesForDigest = (await readdir(join(profile, 'node_modules/@deepseek-ai')))
  .filter(n => n.startsWith('dsh-pkw-'))
const before = {
  inputDigest: await profileInputDigest(profile, releasePackageNamesForDigest),
  installedVersion: JSON.parse(await readFile(join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json'), 'utf8')).version,
  hostPeers: await hostFingerprint(profile),
}
report.before = before

// The artifacts under test are served from an existing staging directory so the
// published digests of a release are never regenerated by a rehearsal.
const artifactDir = resolve(values['artifact-dir'] ?? join(workDir, 'packages'))
const registry = await startLoopbackRegistry()
const artifacts = []
const supportArtifacts = []
try {
  for (const entry of (await readdir(artifactDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = join(artifactDir, entry.name)
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.tgz')) continue
      const tarball = join(dir, file)
      const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
      if (manifest.version !== version) continue
      artifacts.push({ name: manifest.name, version: manifest.version, dir, tarball, sha256: sha256(await readFile(tarball)) })
    }
  }
  if (artifacts.length !== 10) throw new Error(`expected 10 artifacts for ${version} in ${artifactDir}, found ${artifacts.length}`)
  // Serve the profile's own Harness closure too. A release install re-resolves the
  // graph, and asking a registry for packages that already sit on disk is what turns
  // a small install into a large download (optional cross-platform binaries included).
  // Publishing the on-disk copies removes that dependency without changing them.
  for (const entry of (await readdir(join(profile, 'node_modules/@deepseek-ai'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || /^dsh-pkw-/.test(entry.name)) continue
    const dir = join(profile, 'node_modules/@deepseek-ai', entry.name)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const staging = join(workDir, 'support', entry.name.replace('@', '').replace('/', '__'))
    await mkdir(staging, { recursive: true, mode: 0o700 })
    await cp(dir, staging, { recursive: true, dereference: true })
    execFileSync('npm', ['pack', '--ignore-scripts', '--quiet'], { cwd: staging, stdio: 'ignore' })
    const produced = (await readdir(staging)).find(f => f.endsWith('.tgz'))
    if (!produced) throw new Error(`could not pack support package ${manifest.name}`)
    const tarball = join(staging, produced)
    supportArtifacts.push({ name: manifest.name, version: manifest.version, tarball, sha256: sha256(await readFile(tarball)) })
  }
  for (const artifact of [...artifacts, ...supportArtifacts]) await registry.add(artifact.tarball)
  report.artifacts = artifacts.map(a => ({ name: a.name, version: a.version, sha256: a.sha256 }))
  report.supportArtifacts = supportArtifacts.length
} catch (error) {
  report.phases.stage = { ok: false, error: error.message }
  await registry.close()
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.error(error.message)
  process.exit(1)
}
// sha256 is needed above without importing the deployment helper's copy again.


// The store the copied profile is actually linked from. pnpm refuses to relink a
// node_modules tree that was created from a different store, and the copy carries the
// storeDir recorded at install time, so honour it instead of guessing from HOME.
async function resolveStoreDir() {
  if (values['store-dir']) return resolve(values['store-dir'])
  try {
    const modules = await readFile(join(profile, 'node_modules/.modules.yaml'), 'utf8')
    const recorded = /"?storeDir"?\s*:\s*"?([^",\s]+)"?/.exec(modules)?.[1]
    if (recorded && existsSync(recorded)) return recorded
  } catch { /* fall through */ }
  return undefined
}
const storeDir = await resolveStoreDir()
report.storeDir = storeDir ?? null

// Phase 1: prepare (install while the previous release keeps serving).
const serviceWasRunningBefore = existsSync(pidFile) && Number(execFileSync('bash', ['-lc', `cat ${pidFile} 2>/dev/null || echo 0`], { encoding: 'utf8' }).trim()) > 0
try {
  if (values['fail-prepare']) {
    // Start the listener first so "a failed preparation must not stop it" is a real
    // assertion rather than a statement about a service that was never running.
    execFileSync(startHook, [], { stdio: 'ignore' })
    const { spawn: spawnChild } = await import('node:child_process')
    await new Promise((_, reject) => {
      const child = spawnChild('pnpm', ['add', '--save-exact', '--registry=' + registry.url, 'this-package-does-not-exist@0.0.0-absent'], { cwd: profile, stdio: 'ignore' })
      child.once('exit', code => code === 0 ? reject(new Error('expected the simulated prepare to fail')) : reject(new Error(`simulated prepare failure (pnpm exited ${code})`)))
    })
  }
  const releasePackageNames = artifacts.map(a => a.name.replace('@deepseek-ai/', ''))
  const prepareLog = join(logDir, 'prepare.log')
  const capture = async (command, args, cwd) => {
    const { spawn: spawnChild } = await import('node:child_process')
    await new Promise((resolvePromise, reject) => {
      const child = spawnChild(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', c => { out += c })
      child.stderr.on('data', c => { out += c })
      child.once('error', reject)
      child.once('exit', code => {
        appendFileSync(prepareLog, `\n$ ${command} ${args.join(' ')}\n${out}\n[exit ${code}]\n`)
        code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))
      })
    })
  }
  report.phases.prepare = await prepareInstall({
    profile, artifacts: [...artifacts, ...supportArtifacts], registry: registry.url, storeDir, packageNames: releasePackageNames,
    allowFreshRelease: true,
  }, capture)
  report.phases.prepare.ok = true
} catch (error) {
  report.phases.prepare = { ok: false, error: error.message }
}
report.afterPrepare = {
  inputDigest: await profileInputDigest(profile),
  installedVersion: JSON.parse(await readFile(join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json'), 'utf8')).version,
}

if (values['modify-profile-before-activate']) {
  // The guard fingerprints package *content*, so the probe has to touch content:
  // an external writer that swaps a package behind the deployment's back is exactly
  // the case that must be refused.
  const target = join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/collaboration/index.js')
  const original = await readFile(target, 'utf8')
  await writeFile(target, `${original}\n// rehearsal guard probe ${new Date().toISOString()}\n`)
  report.phases.guardProbe = { modified: target, bytesAdded: 60 }
}

if (!report.phases.prepare?.ok) {
  // A failed preparation must not have stopped anything: assert the listener that
  // was up before is still up and still owned by the same pid.
  const pidText = existsSync(pidFile) ? execFileSync('bash', ['-lc', `cat ${pidFile}`], { encoding: 'utf8' }).trim() : ''
  report.prepareFailure = {
    serviceStillRunning: Boolean(pidText) && Number(pidText) > 0,
    pid: pidText || null,
    listenerWasRunningBefore: serviceWasRunningBefore,
  }
  await registry.close()
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: 'prepare-failed', report: join(workDir, 'report.json'), detail: report.prepareFailure }, null, 2))
  process.exit(0)
}

// Phase 2: activate.
const verify = async (url, attempts, expectedVersion) => {
  const expectedPid = existsSync(pidFile) ? execFileSync('bash', ['-lc', `cat ${pidFile}`], { encoding: 'utf8' }).trim() : ''
  const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) }).catch(error => ({ status: 0, error: error.message }))
  const body = await health.text?.().catch(() => '') ?? ''
  if (health.status !== 200 || !body.includes('ready')) throw new Error(`rehearsal listener is not ready (HTTP ${health.status})`)
  const portal = await fetch(`http://127.0.0.1:${port}/pkw`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const html = await portal.text()
  if (portal.status !== 200 || !html.includes('PKW · 我的空间')) throw new Error(`portal not served (HTTP ${portal.status})`)
  const installed = JSON.parse(await readFile(join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json'), 'utf8')).version
  if (expectedVersion && installed !== expectedVersion) throw new Error(`installed ${installed}, expected ${expectedVersion}`)
  // Prove the serving process is the one this rehearsal started.
  const lock = existsSync(join(dataRoot, 'gateway.lock')) ? JSON.parse(await readFile(join(dataRoot, 'gateway.lock'), 'utf8')) : null
  if (!lock || String(lock.pid) !== String(expectedPid)) throw new Error(`unexpected writer: lock=${JSON.stringify(lock)} startHookPid=${expectedPid}`)
  if (values['force-verify-failure'] && expectedVersion === version) throw new Error('rehearsal: injected post-activation verification failure')
  return { listener: 'ready', portal: 'served', installedVersion: installed, writerPid: lock.pid }
}

try {
  report.phases.activate = await activate({
    profile, backup, artifacts, registry: registry.url,
    stop: stopHook, start: startHook, url: `http://127.0.0.1:${port}`, beforeHost: before.hostPeers,
    prepared: report.phases.prepare,
  }, undefined, verify)
  report.phases.activate.ok = true
} catch (error) {
  report.phases.activate = { ok: false, code: error?.code, recovery: error?.recovery, errorDetails: deploymentErrorDetails(error) }
}
report.afterActivate = {
  inputDigest: await profileInputDigest(profile),
  installedVersion: JSON.parse(await readFile(join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json'), 'utf8')).version,
  hostPeers: await hostFingerprint(profile),
}

// The harness peers the profile resolves must be the same before and after, which is
// what proves the release install did not swap the runtime underneath the data.
report.hostPeersUnchanged = JSON.stringify(before.hostPeers) === JSON.stringify(report.afterActivate.hostPeers)
report.dataRoot = await inspectDataRoot(dataRoot)

await registry.close()
try { execFileSync(stopHook, [], { stdio: 'ignore' }) } catch { /* already stopped */ }
await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({
  status: report.phases.activate?.ok ? 'activated' : 'failed',
  code: report.phases.activate?.code ?? null,
  recovery: report.phases.activate?.recovery ?? null,
  installedAfter: report.afterActivate.installedVersion,
  hostPeersUnchanged: report.hostPeersUnchanged,
  report: join(workDir, 'report.json'),
}, null, 2))

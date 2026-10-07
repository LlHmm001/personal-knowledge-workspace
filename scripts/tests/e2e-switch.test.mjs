/**
 * Isolated end-to-end switch and rollback on synthetic data.
 *
 * This is the "real thing" in miniature: a real listener process, the real
 * `switchRelease` orchestration, the real exact-version install from published
 * tarballs, and an enforcing verifier that refuses anything but a working login, the
 * expected serving version, and a readable note.
 *
 * Nothing here touches a production profile or data root: the release root, the data
 * root and the listener port are all created by the test, and the retrieval endpoint
 * is a loopback stub.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { switchRelease, profileVersion } from '../../deploy/switch-release.mjs'
import { copyDataRootConsistently, makeSyntheticDataRoot, SYNTHETIC_PASSWORD, hashPassword } from './helpers/synthetic.mjs'
import { startLoopbackRegistry } from '../../deploy/site/loopback-registry.mjs'
import { stagePackages } from '../../scripts/deployment.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OLD_VERSION = '0.1.2-pkw.4'
const NEW_VERSION = '0.1.9-pkw.1'

function freePort() {
  return new Promise(resolvePromise => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePromise(port)) })
  })
}

test('e2e: switch to a new release and roll back to the old one with data intact', { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-e2e-'))
  const port = await freePort()
  const dataSource = await makeSyntheticDataRoot()
  // The candidate inherits the store its seeded node_modules came from.
  const seededStore = /"?storeDir"?\s*:\s*"?([^",\s]+)"?/.exec(
    await readFile(join(process.env.PKW_E2E_SOURCE_PROFILE, 'node_modules/.modules.yaml'), 'utf8'),
  )?.[1]
  const registry = await startLoopbackRegistry()
  let listener = null
  try {
    // 1. the release in service: a snapshot of the checked-out build's independent
    //    profile (complete peer closure), relabelled as the old version.
    const sourceProfile = process.env.PKW_E2E_SOURCE_PROFILE
    assert.ok(sourceProfile && existsSync(sourceProfile), 'PKW_E2E_SOURCE_PROFILE must name a built independent profile')
    const artifacts = await stagePackages(join(root, 'packages'), NEW_VERSION, registry.url)
    for (const artifact of artifacts) await registry.add(artifact.tarball)
    // Serve the seed profile's own peer closure too: an install re-resolves the graph,
    // and the point of the test is the release switch, not a registry round trip.
    const supportArtifacts = []
    const seedScope = join(sourceProfile, 'node_modules/@deepseek-ai')
    for (const entry of (await readdir(seedScope, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('dsh-pkw-')) continue
      const dir = join(seedScope, entry.name)
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      const staging = join(root, 'support', entry.name)
      await mkdir(staging, { recursive: true })
      await cp(dir, staging, { recursive: true, dereference: true })
      execFileSync('npm', ['pack', '--ignore-scripts', '--quiet'], { cwd: staging, stdio: 'ignore' })
      const produced = (await readdir(staging)).find(f => f.endsWith('.tgz'))
      if (!produced) continue
      const tarball = join(staging, produced)
      const support = { name: manifest.name, version: manifest.version, tarball }
      supportArtifacts.push(support)
      await registry.add(tarball)
    }
    const oldRelease = join(root, 'releases', OLD_VERSION, 'profile')
    await mkdir(join(root, 'releases'), { recursive: true })
    await cp(sourceProfile, oldRelease, { recursive: true, dereference: false, verbatimSymlinks: true })
    for (const entry of await readdir(join(oldRelease, 'node_modules/@deepseek-ai'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('dsh-pkw-')) continue
      const manifestPath = join(oldRelease, 'node_modules/@deepseek-ai', entry.name, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.version = OLD_VERSION
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    }
    await symlink(join('releases', OLD_VERSION), join(root, 'current'))

    // 2. a synthetic data root copy, with the owner password replaced
    const dataCopy = await copyDataRootConsistently(dataSource.root)
    const identity = new DatabaseSync(join(dataCopy.root, 'identity.sqlite'))
    identity.prepare('UPDATE accounts SET password=?').run(await hashPassword(SYNTHETIC_PASSWORD))
    identity.close()
    await writeFile(join(dataCopy.root, 'collaboration.json'), JSON.stringify({
      dataPath: dataCopy.root, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_E2E_BOOTSTRAP',
    }, null, 2) + '\n', { mode: 0o600 })

    // 3. a real listener the hooks control, plus an enforcing verifier
    const pidFile = join(root, 'listener.pid')
    const stopHook = async () => {
      if (!existsSync(pidFile)) return
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      for (let i = 0; i < 60; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(r => setTimeout(r, 100)) }
      await rm(pidFile, { force: true })
    }
    const startHook = async () => {
      // The hook resolves the profile exactly as the service unit would: through the
      // `current` symlink, which the switch has already repointed.
      listener = spawn(process.execPath, [
        join(repoRoot, 'scripts/serve-collaboration.mjs'),
        '--profile', join(await currentReleaseDir(root), 'profile'),
        '--config', join(dataCopy.root, 'collaboration.json'),
        '--port', String(port),
      ], { env: { ...process.env, PKW_E2E_BOOTSTRAP: SYNTHETIC_PASSWORD }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      let listenerOut = ''
      listener.stdout.on('data', c => { listenerOut += c })
      listener.stderr.on('data', c => { listenerOut += c })
      listener.unref()
      await writeFile(pidFile, String(listener.pid))
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.status === 200) return } catch { /* not up yet */ }
        if (listener.exitCode !== null) throw new Error(`listener exited with ${listener.exitCode}: ${listenerOut.trim().split("\n").slice(-6).join(" | ")}`)
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error(`listener did not become healthy: ${listenerOut.trim().split("\n").slice(-6).join(" | ")}`)
    }
    let listenerLog = ''
    const verifyViaHttp = async ({ expectedVersion }) => {
      const origin = `http://127.0.0.1:${port}`
      const jar = new Map()
      const call = async (path, { method = 'GET', body, csrf } = {}) => {
        const headers = { Origin: origin }
        if (body) headers['Content-Type'] = 'application/json'
        if (csrf) headers['X-PKW-CSRF'] = csrf
        if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
        const response = await fetch(origin + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
        for (const raw of response.headers.getSetCookie?.() ?? []) { const [pair] = raw.split(';'); const at = pair.indexOf('='); if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1)) }
        const text = await response.text(); let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
        return { status: response.status, body: parsed, headers: response.headers }
      }
      const login = await call('/pkw/login', { method: 'POST', body: { username: 'owner', password: SYNTHETIC_PASSWORD } })
      if (login.status !== 200) throw new Error(`login refused with HTTP ${login.status}`)
      const session = await call('/pkw/session')
      const value = session.body?.value ?? {}
      const space = (value.spaces ?? [])[0]
      if (!space) throw new Error('no space in the authenticated session')
      const page = await call(`/pkw/spaces/${space.id}`)
      const serving = page.headers.get('x-pkw-version') ?? null
      if (serving !== expectedVersion) throw new Error(`serving ${serving}, expected ${expectedVersion}`)
      const summary = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: { method: 'summary', args: {} }, csrf: value.csrf })
      if (summary.status !== 200) throw new Error(`summary failed with HTTP ${summary.status}`)
      return { serving, notes: summary.body?.value?.notes ?? null }
    }

    // 4. run the switch, with verification failing the first time to force a rollback
    // Capture install/verify output so a failure is diagnosable.
    const { prepareInstall: realPrepare } = await import('../../scripts/deployment.mjs')
    const loggedPrepare = async (options, ...rest) => realPrepare(options, async (command, args, cwd) => {
      const { spawn: spawnChild } = await import('node:child_process')
      await new Promise((resolvePromise, reject) => {
        const child = spawnChild(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
        let out = ''
        child.stdout.on('data', c => { out += c })
        child.stderr.on('data', c => { out += c })
        child.once('error', reject)
        child.once('exit', code => {
          if (code !== 0) { console.error(`[e2e] \$ ${command} ${args.join(' ')}\n${out}`) ; reject(new Error(`${command} exited ${code}`)) }
          else resolvePromise()
        })
      })
    }, ...rest)
    let failFirst = true
    let switched = null
    try {
      switched = await switchRelease({
        root, version: NEW_VERSION, artifacts, registry: registry.url, storeDir: seededStore, hooks: {
          stop: stopHook, start: startHook,
          verify: async context => {
            if (failFirst && context.expectedVersion === NEW_VERSION) { failFirst = false; throw new Error('synthetic post-activation verification failure') }
            return await verifyViaHttp(context)
          },
          reachable: async () => ({ reachable: true, status: 200 }),
        },
        snapshotDir: join(root, 'snapshots', NEW_VERSION),
        deps: {
          prepareInstall: async (options, ...rest) => loggedPrepare({ ...options, artifacts: [...options.artifacts, ...supportArtifacts] }, ...rest),
        },
      })
    } catch (error) {
      assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `unexpected failure: ${error.code ?? error.message}\n${JSON.stringify({ rollback: error.report?.rollback, rollbackError: error.report?.rollbackError, activationError: error.report?.activationError }, null, 1)}`)
      assert.equal(error.report?.status, 'rolled-back', 'the rollback must end in a restored, reachable state')
      assert.equal(error.report.rollback?.restoredVersion, OLD_VERSION, 'the restored release must declare the old version')
      // Data added before the rollback is still there, verified through the service.
      const bodyPath = join(dataCopy.root, 'spaces', dataSource.spaceId, 'workspace', dataSource.relativePath)
      assert.equal(await readFile(bodyPath, 'utf8'), '# synthetic note\n\nbody\n', 'the note body must survive')
      const attachmentDir = join(dataCopy.root, 'spaces', dataSource.spaceId, 'workspace/attachments')
      assert.ok((await readdir(attachmentDir)).length > 0, 'the attachment must survive')
      assert.equal((await stat(bodyPath)).mode & 0o777, 0o644, 'file mode must be preserved')
      return
    }
    // If verification succeeded first time, the switch stands and the old release stays.
    assert.equal(switched.status, 'activated')
    assert.equal(await profileVersion(join(root, 'releases', OLD_VERSION, 'profile')), OLD_VERSION, 'the old release must be preserved')
    assert.equal(await profileVersion(join(root, 'releases', NEW_VERSION, 'profile')), NEW_VERSION, 'the new release must be promoted')
  } finally {
    try { await rm(join(root, 'listener.pid'), { force: true }) } catch { /* ignore */ }
    for (const child of [listener]) if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
    await registry.close()
    await rm(root, { recursive: true, force: true })
    await rm(dataSource.root, { recursive: true, force: true })
  }
})

async function currentReleaseDir(root) {
  const { readlink } = await import('node:fs/promises')
  const target = await readlink(join(root, 'current'))
  return resolve(join(root, target))
}

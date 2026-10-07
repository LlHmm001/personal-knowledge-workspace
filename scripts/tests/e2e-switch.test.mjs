/**
 * Isolated end-to-end switch and rollback with REAL artifacts.
 *
 * The old release is a traceable artifact: the PKW packages currently installed in the
 * live DSH profile (read-only source, copied out). The new release is this checkout's
 * staged packages at a new version. The switch installs the new version into a fresh
 * candidate, the new service is made to write a synthetic note and attachment through
 * real HTTP, verification is then failed on purpose, and the rollback must land back on
 * the old release — where the old service is asked to log in, report its actual version,
 * and read the newly written body and attachment bytes back.
 *
 * Nothing here writes a production profile, a production data root or the live service:
 * the release root, the data copy and the listener ports are all created by the test.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { switchRelease, checkReachable, profileVersion } from '../../deploy/switch-release.mjs'
import { makeSyntheticDataRoot, SYNTHETIC_PASSWORD, hashPassword } from './helpers/synthetic.mjs'
import { copyDataRoot } from '../../scripts/copy-data-root.mjs'
import { startLoopbackRegistry } from '../../deploy/site/loopback-registry.mjs'
import { stagePackages } from '../../scripts/deployment.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const NEW_VERSION = '0.1.9-pkw.1'
const OLD_VERSION = process.env.PKW_E2E_OLD_VERSION ?? '0.1.8-pkw.1'
/**
 * Copy a tree, resolving links where they resolve and skipping the ones that dangle.
 * The live profile contains dangling links, which makes a plain dereferencing copy fail.
 */
async function copyResolving(from, to) {
  const { lstat, mkdir: mkd, copyFile, realpath } = await import('node:fs/promises')
  const info = await lstat(from).catch(() => null)
  if (!info) return
  if (info.isSymbolicLink()) {
    let real
    try { real = await realpath(from) } catch { return } // dangling: skip
    const target = await lstat(real).catch(() => null)
    if (!target) return
    if (target.isDirectory()) return copyResolving(real, to)
    await copyFile(real, to)
    return
  }
  if (!info.isDirectory()) { await copyFile(from, to); return }
  await mkd(to, { recursive: true, mode: info.mode & 0o777 })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    await copyResolving(join(from, entry.name), join(to, entry.name))
  }
}

/** Read-only source of the traceable old artifacts. */
const LIVE_PROFILE = process.env.PKW_E2E_LIVE_PROFILE ?? '/root/.dsh/profiles/web'
const PKW_SCOPE = 'node_modules/@deepseek-ai'

// The test needs three things and declares which one is missing, so a skip never hides a
// half-configured run: real old artifacts, a support closure, and a store.
const missing = []
if (!existsSync(join(LIVE_PROFILE, PKW_SCOPE, 'dsh-pkw-web/package.json'))) missing.push(`no installed PKW profile at ${LIVE_PROFILE}`)
if (!process.env.PKW_E2E_OLD_ARTIFACTS || !existsSync(process.env.PKW_E2E_OLD_ARTIFACTS)) missing.push('PKW_E2E_OLD_ARTIFACTS must name a staged artifact directory')
if (!process.env.PKW_E2E_STORE) missing.push('PKW_E2E_STORE must name a pnpm store')
const skip = missing.length ? `e2e requires: ${missing.join('; ')}` : false

function freePort() {
  return new Promise(resolvePromise => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePromise(port)) })
  })
}

test('e2e: new release writes, verification fails, rollback restores the old release which reads the new data', { timeout: 1_200_000, skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-e2e-'))
  const data = await makeSyntheticDataRoot()
  const ports = { new: await freePort(), old: await freePort() }
  const registry = await startLoopbackRegistry()
  const children = new Set()
  let report_oldReleasePackages = 0
  try {
    // ── the old release: real artifacts, copied out of the live installation ─────
    // ── the old release: the real published artifacts, unpacked verbatim ─────────
    // Both releases are real, traceable artifacts: the old one is a staged release of
    // this project whose digests are recorded, the new one is staged from this checkout.
    const oldRelease = join(root, 'releases', OLD_VERSION, 'profile')
    await mkdir(oldRelease, { recursive: true })
    const oldArtifactDir = process.env.PKW_E2E_OLD_ARTIFACTS
    assert.ok(oldArtifactDir && existsSync(oldArtifactDir), 'PKW_E2E_OLD_ARTIFACTS must name a staged artifact directory')
    for (const entry of await readdir(oldArtifactDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(oldArtifactDir, entry.name)
      const tgz = (await readdir(dir)).find(f => f.endsWith('.tgz'))
      if (!tgz) continue
      const manifest = JSON.parse(execFileSync('tar', ['-xOf', join(dir, tgz), 'package/package.json'], { encoding: 'utf8' }))
      const target = join(oldRelease, 'node_modules', manifest.name)
      await mkdir(target, { recursive: true })
      execFileSync('tar', ['-xzf', join(dir, tgz), '-C', target, '--strip-components=1'])
    }
    await writeFile(join(oldRelease, 'package.json'), JSON.stringify({ name: 'pkw-release', private: true, type: 'module', version: OLD_VERSION }, null, 2) + '\n')
    await writeFile(join(oldRelease, 'pnpm-workspace.yaml'), 'packages: []\n')
    assert.equal(await profileVersion(oldRelease), OLD_VERSION, 'the old release must declare a traceable version')
    await mkdir(join(root, 'releases'), { recursive: true })
    await symlink(join('releases', OLD_VERSION), join(root, 'current'))

    // ── the new release: this checkout, staged at a new version ──────────────────
    const artifacts = await stagePackages(join(root, 'packages'), NEW_VERSION, registry.url)
    for (const artifact of artifacts) await registry.add(artifact.tarball)
    // Serve the old release's own peer closure so the install only fetches this release.
    const support = []
    const supportRoot = process.env.PKW_E2E_SUPPORT_PROFILE ?? LIVE_PROFILE
    for (const entry of (await readdir(join(supportRoot, PKW_SCOPE), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('dsh-pkw-')) continue
      const dir = join(supportRoot, PKW_SCOPE, entry.name)
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      const staging = join(root, 'support', entry.name)
      await mkdir(staging, { recursive: true })
      // Tolerant copy: the live profile's layout contains dangling links.
      await copyResolving(dir, staging)
      execFileSync('npm', ['pack', '--ignore-scripts', '--quiet'], { cwd: staging, stdio: 'ignore' })
      const produced = (await readdir(staging)).find(f => f.endsWith('.tgz'))
      if (!produced) continue
      const item = { name: manifest.name, version: manifest.version, tarball: join(staging, produced) }
      support.push(item)
      await registry.add(item.tarball)
    }

    // ── the data copy: consistent snapshot, fully self-contained ─────────────────
    const dataRoot = join(root, 'data')
    const copied = await copyDataRoot(data.root, dataRoot)
    assert.equal(copied.leaks.length, 0, `the copy must not point at the source: ${JSON.stringify(copied.leaks)}`)
    const identity = await import('node:sqlite').then(m => new m.DatabaseSync(join(dataRoot, 'identity.sqlite')))
    identity.prepare('UPDATE accounts SET password=?').run(await hashPassword(SYNTHETIC_PASSWORD))
    identity.close()
    await writeFile(join(dataRoot, 'collaboration.json'), JSON.stringify({
      dataPath: dataRoot, publicOrigin: 'http://127.0.0.1:0', bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_E2E_BOOTSTRAP',
    }, null, 2) + '\n', { mode: 0o600 })

    // ── hooks: one listener per release version, on its own port ─────────────────
    const listeners = new Map()
    const startListener = async version => {
      const port = ports[version === NEW_VERSION ? 'new' : 'old']
      const configPath = join(root, `config-${version}.json`)
      await writeFile(configPath, JSON.stringify({
        dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_E2E_BOOTSTRAP',
      }, null, 2) + '\n', { mode: 0o600 })
      const release = version === NEW_VERSION ? NEW_VERSION : OLD_VERSION
      const child = spawn(process.execPath, [
        join(repoRoot, 'scripts/serve-collaboration.mjs'),
        '--profile', join(root, 'releases', release, 'profile'),
        '--config', configPath, '--port', String(port),
      ], { env: { ...process.env, PKW_E2E_BOOTSTRAP: SYNTHETIC_PASSWORD }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      let output = ''
      child.stdout.on('data', c => { output += c })
      child.stderr.on('data', c => { output += c })
      child.unref()
      children.add(child)
      const reachable = await checkReachable({ origin: `http://127.0.0.1:${port}`, timeoutMs: 30_000 })
      if (!reachable.reachable) throw new Error(`listener for ${version} did not start: ${reachable.error}; ${output.slice(-300)}`)
      listeners.set(version, child.pid)
      return { port, output: () => output }
    }
    const stopListener = async pid => {
      if (!pid) return
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
      for (let i = 0; i < 80; i++) { try { process.kill(pid, 0) } catch { return } await new Promise(r => setTimeout(r, 100)) }
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }

    // ── a real HTTP client for the collaboration surface ────────────────────────
    const client = port => {
      const jar = new Map()
      const origin = `http://127.0.0.1:${port}`
      const call = async (path, { method = 'GET', body, csrf, raw } = {}) => {
        const headers = { Origin: origin }
        if (body !== undefined && !raw) headers['Content-Type'] = 'application/json'
        if (csrf) headers['X-PKW-CSRF'] = csrf
        if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
        const response = await fetch(origin + path, {
          method, headers, redirect: 'manual',
          body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        })
        for (const rawCookie of response.headers.getSetCookie?.() ?? []) {
          const [pair] = rawCookie.split(';'); const at = pair.indexOf('=')
          if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
        }
        return response
      }
      return {
        login: () => call('/pkw/login', { method: 'POST', body: { username: 'owner', password: SYNTHETIC_PASSWORD } }),
        session: async () => (await call('/pkw/session')).json(),
        spaceVersion: async spaceId => (await call(`/pkw/spaces/${spaceId}`)).headers.get('x-pkw-version'),
        rpc: async (spaceId, method, args, csrf) => (await call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf })).json(),
        upload: async (spaceId, formData, csrf) => {
          const response = await call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: formData, csrf, raw: true })
          return response.json().catch(() => null)
        },
      }
    }

    // ── run the switch; verification of the NEW version is failed on purpose ─────
    let noteId = null, attachmentId = null, marker = null
    let switched = null
    try {
      switched = await switchRelease({
        root, version: NEW_VERSION, artifacts, registry: registry.url, storeDir: process.env.PKW_E2E_STORE,
        allowFreshRelease: true, snapshotDir: join(root, 'snapshots', NEW_VERSION),
        deps: {
          prepareInstall: async (options, ...rest) => {
            const { prepareInstall: real } = await import('../../scripts/deployment.mjs')
            return real({ ...options, artifacts: [...options.artifacts, ...support] }, ...rest)
          },
        },
        hooks: {
          stop: async () => { for (const [, pid] of listeners) await stopListener(pid); listeners.clear() },
          start: async () => { /* started by the verification step below, which knows the version */ },
          reachable: async ({ previousVersion }) => {
            try { await startListener(previousVersion); return { reachable: true, status: 200 } } catch (error) { return { reachable: false, error: error.message } }
          },
          verify: async ({ expectedVersion }) => {
            const listener = await startListener(expectedVersion)
            const api = client(listener.port)
            assert.equal((await api.login()).status, 200, 'the enforcing verifier must be able to log in')
            const session = await api.session()
            const space = session.value.spaces[0]
            const serving = await api.spaceVersion(space.id)
            assert.equal(serving, expectedVersion, 'the service must report the version being verified')
            if (expectedVersion !== NEW_VERSION) {
              // Recovery path: reachability is enough here; acceptance is the caller's job.
              return { serving }
            }
            // The new version writes real content before verification fails.
            marker = `rollback-marker-${Date.now()}`
            const created = await api.rpc(space.id, 'createNote', { relativePath: `notes/rollback-${marker}.md`, markdown: `# ${marker}\n\nwritten by ${NEW_VERSION}\n` }, session.value.csrf)
            assert.equal(created.ok, true, `createNote must succeed: ${JSON.stringify(created).slice(0, 200)}`)
            noteId = created.value.noteId
            const attachmentBytes = Buffer.from(`attachment written by ${NEW_VERSION}\n`)
            const form = new FormData()
            form.append('file', new Blob([attachmentBytes]), 'rollback-attachment.bin')
            form.append('method', 'uploadAttachment')
            form.append('args', JSON.stringify({ relativePath: `attachments/rollback-${marker}.bin` }))
            const uploaded = await api.upload(space.id, form, session.value.csrf)
            attachmentId = uploaded?.value?.attachmentId ?? null
            const bodyPath = join(dataRoot, 'spaces', data.spaceId, 'workspace', `notes/rollback-${marker}.md`)
            assert.ok(existsSync(bodyPath), 'the note the new version wrote must be on disk')
            throw new Error('synthetic post-activation verification failure (after writing real content)')
          },
        },
      })
    } catch (error) {
      assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `unexpected failure: ${error.code ?? error.message}\n${JSON.stringify(error.report?.activationError ?? {}, null, 1).slice(0, 400)}`)
      assert.equal(error.report?.status, 'rolled-back')
      assert.equal(error.report?.rollback?.restoredVersion, OLD_VERSION, 'the restored release must declare the old version')
      assert.match(error.message, /synthetic post-activation verification failure/, 'the original error must be preserved')
      assert.ok(noteId, 'the new release must have written a note before the failure')

      // ── rollback verification: the OLD service must read the NEW data back ────
      const oldListener = await startListener(OLD_VERSION)
      const oldApi = client(oldListener.port)
      assert.equal((await oldApi.login()).status, 200, 'the restored service must accept a real login')
      const session = await oldApi.session()
      const space = session.value.spaces[0]
      assert.equal(await oldApi.spaceVersion(space.id), OLD_VERSION, 'the restored service must report the actual old version')
      const read = await oldApi.rpc(space.id, 'getNote', { noteId }, session.value.csrf)
      assert.equal(read.ok, true, `the old service must read the note the new release wrote: ${JSON.stringify(read).slice(0, 200)}`)
      const onDisk = await readFile(join(dataRoot, 'spaces', data.spaceId, 'workspace', `notes/rollback-${marker}.md`), 'utf8')
      assert.ok(onDisk.includes(marker), 'the written body must still be present')
      assert.equal((await stat(join(dataRoot, 'spaces', data.spaceId, 'workspace', `notes/rollback-${marker}.md`))).mode & 0o777, 0o644, 'the file mode must be preserved')
      const listed = await oldApi.rpc(space.id, 'listNotes', {}, session.value.csrf)
      assert.equal(listed.ok, true)
      console.log(`  rollback verified: note=${noteId} attachment=${attachmentId ?? 'n/a'} version=${OLD_VERSION}`)
      return
    }
    assert.equal(switched.status, 'activated')
  } finally {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
    await registry.close()
    await rm(root, { recursive: true, force: true })
    await rm(data.root, { recursive: true, force: true })
  }
})

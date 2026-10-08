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
  let failedRun = false
  const root = await mkdtemp(join(tmpdir(), 'pkw-e2e-'))
  const data = await makeSyntheticDataRoot()
  const ports = { new: await freePort(), old: await freePort() }
  const registry = await startLoopbackRegistry()
  const children = new Set()
  let report_oldReleasePackages = 0
  try {
    // ── the new release: this checkout, staged at a new version ──────────────────
    const artifacts = await stagePackages(join(root, 'packages'), NEW_VERSION, registry.url)
    for (const artifact of artifacts) await registry.add(artifact.tarball)

    // ── the peer closure both releases resolve against ───────────────────────────
    // A release profile is its packages *and* the Harness peers they declare, pinned by that
    // profile. Staging the peers first is what lets the old release be assembled into a profile
    // that can actually run — a release whose peers are missing cannot serve, and a rollback to
    // one that cannot serve is not a rollback. The same tarballs feed the new release's install
    // through the loopback registry.
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
    // The peer closure laid out as an installed tree, so the release the switch never installs can
    // still resolve the peers it declares. What goes in is each peer's own packed contents, not a
    // stub: a profile that resolves a placeholder is a profile that proves nothing.
    const supportTree = join(root, 'support-tree')
    const supportScope = join(supportTree, PKW_SCOPE)
    await mkdir(supportScope, { recursive: true })
    await writeFile(join(supportTree, 'package.json'), JSON.stringify({ name: 'pkw-support', private: true, type: 'module', version: '0.0.0' }, null, 2) + '\n')
    const scope = PKW_SCOPE.slice('node_modules/'.length)
    for (const item of support) {
      const target = join(supportScope, item.name.slice(scope.length + 1))
      await mkdir(target, { recursive: true })
      execFileSync('tar', ['-xzf', item.tarball, '-C', target, '--strip-components=1'])
    }
    assert.equal((await readdir(supportScope)).length, support.length, 'every staged peer must be laid out in the peer tree')

    // ── the old release: the real published artifacts, unpacked verbatim, with its peers ─
    // Both releases are real, traceable artifacts: the old one is a staged release of this project
    // whose digests are recorded, the new one is staged from this checkout. The old profile is
    // assembled exactly like the new one is installed — its own packages, plus the peer closure —
    // so that "the old release still runs" is something the test can observe rather than assume.
    const oldRelease = join(root, 'releases', OLD_VERSION, 'profile')
    const oldModules = join(oldRelease, 'node_modules')
    await mkdir(oldModules, { recursive: true })
    const oldArtifactDir = process.env.PKW_E2E_OLD_ARTIFACTS
    assert.ok(oldArtifactDir && existsSync(oldArtifactDir), 'PKW_E2E_OLD_ARTIFACTS must name a staged artifact directory')
    for (const entry of await readdir(oldArtifactDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(oldArtifactDir, entry.name)
      const tgz = (await readdir(dir)).find(f => f.endsWith('.tgz'))
      if (!tgz) continue
      const manifest = JSON.parse(execFileSync('tar', ['-xOf', join(dir, tgz), 'package/package.json'], { encoding: 'utf8' }))
      const target = join(oldModules, manifest.name)
      await mkdir(target, { recursive: true })
      execFileSync('tar', ['-xzf', join(dir, tgz), '-C', target, '--strip-components=1'])
    }
    // The peers are laid in beside the release's own packages. Only the peers move: a scope entry
    // that is one of the release's own packages must never overwrite the artifact just unpacked.
    const oldScope = join(oldRelease, PKW_SCOPE)
    for (const entry of await readdir(supportScope, { withFileTypes: true })) {
      if (entry.name.startsWith('dsh-pkw-')) continue
      await cp(join(supportScope, entry.name), join(oldScope, entry.name), { recursive: true, dereference: false })
    }
    const flatRoot = join(supportRoot, 'node_modules')
    for (const entry of await readdir(flatRoot, { withFileTypes: true })) {
      if (entry.name.startsWith('@') || entry.name.startsWith('.')) continue
      await cp(join(flatRoot, entry.name), join(oldModules, entry.name), { recursive: true, dereference: false })
    }
    assert.ok(existsSync(join(oldScope, 'cordis/package.json')), 'the old release profile must resolve the Harness peers it declares')
    const oldWebManifest = JSON.parse(await readFile(join(oldScope, 'dsh-pkw-web', 'package.json'), 'utf8'))
    assert.equal(oldWebManifest.version, OLD_VERSION, 'the old profile must resolve the old release own packages, never the peers copies of them')
    await writeFile(join(oldRelease, 'package.json'), JSON.stringify({ name: 'pkw-release', private: true, type: 'module', version: OLD_VERSION }, null, 2) + '\n')
    await writeFile(join(oldRelease, 'pnpm-workspace.yaml'), 'packages: []\n')
    assert.equal(await profileVersion(oldRelease), OLD_VERSION, 'the old release must declare a traceable version')
    await mkdir(join(root, 'releases'), { recursive: true })
    await symlink(join('releases', OLD_VERSION), join(root, 'current'))

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
      if (!reachable.reachable) throw new Error(`listener for ${version} did not start: ${reachable.error}; ${output.slice(-1400)}`)
      listeners.set(version, child.pid)
      return { port, output: () => output }
    }
    const stopListener = async pid => {
      if (!pid) return
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
      for (let i = 0; i < 80; i++) { try { process.kill(pid, 0) } catch { return } await new Promise(r => setTimeout(r, 100)) }
      try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }

    // Where a note body actually lives. A note's `relativePath` is workspace-relative and the
    // runtime resolves it as `<workspace>/notes/<relativePath>`, so the `relativePath` handed to
    // createNote is passed through whole — asserting on a path built any other way reports a
    // missing file for a note the product just wrote.
    const noteBodyFile = (spaceId, relativePath) => join(dataRoot, 'spaces', spaceId, 'workspace', 'notes', relativePath)
    const writtenNotePath = () => noteBodyFile(data.spaceId, `notes/rollback-${marker}.md`)

    /** Whether anything still holds a local port. A stopped listener must leave its port free. */
    const portHeld = async port => {
      const server = createServer()
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', resolve)
        })
        return false
      } catch {
        return true
      } finally {
        await new Promise(resolve => server.close(resolve))
      }
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
        spacePage: async spaceId => {
          const response = await call(`/pkw/spaces/${spaceId}`)
          return { status: response.status, location: response.headers.get('location'), contentType: response.headers.get('content-type'), bodyHead: (await response.text()).slice(0, 160) }
        },
        rpc: async (spaceId, method, args, csrf) => (await call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf })).json(),
        download: async (spaceId, attachmentId) => {
          const response = await call(`/pkw/spaces/${spaceId}/attachment/${attachmentId}`)
          return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) }
        },
      }
    }

    // ── run the switch; verification of the NEW version is failed on purpose ─────
    let noteId = null, attachmentId = null, marker = null
    let switched = null
    /** Whether the candidate really served before the transaction stopped it, and where. */
    const candidate = { observed: null, port: null, stoppedAt: null }
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
          // The transaction owns the candidate's life: it stops it here and then proves the stop
          // with the state hook. This hook records the process it was handed, so the check below can
          // say the candidate was serving and is gone, rather than only that the port is free.
          stop: async () => {
            candidate.stoppedAt = [...listeners.keys()].sort()
            for (const [, pid] of listeners) await stopListener(pid)
            listeners.clear()
          },
          start: async () => { /* started by the verification step below, which knows the version */ },
          reachable: async ({ previousVersion }) => {
            try { await startListener(previousVersion); return { reachable: true, status: 200 } } catch (error) { return { reachable: false, error: error.message } }
          },
          // The verifier only observes: it starts the release under test and reports what it saw.
          // It never promotes, never repoints `current`, and never writes to the data root.
          // The rollback has its own acceptance. Reachability alone says the old port answers;
          // acceptance says an authenticated session on the restored release reports the restored
          // version. Without this hook the transaction is right to record `rolled-back-unverified`,
          // so the test supplies the observation rather than letting the status be weaker than the
          // evidence it actually has.
          verifyPrevious: async ({ expectedVersion }) => {
            const listener = await startListener(expectedVersion)
            const api = client(listener.port)
            const login = await api.login()
            if (login.status !== 200) return { ok: false, enforcing: true, checks: { authenticated: 'refused', servingVersion: null }, note: `login answered HTTP ${login.status}` }
            const session = await api.session()
            const space = session.value.spaces[0]
            const serving = await api.spaceVersion(space.id)
            return { ok: serving === expectedVersion, enforcing: true, checks: { authenticated: 'verified', servingVersion: serving } }
          },
          verify: async ({ expectedVersion }) => {
            const listener = await startListener(expectedVersion)
            const api = client(listener.port)
            assert.equal((await api.login()).status, 200, 'the enforcing verifier must be able to log in')
            const session = await api.session()
            const space = session.value.spaces[0]
            const serving = await api.spaceVersion(space.id)
            if (serving !== expectedVersion) {
              // Record what the store says about the workspace the note belongs to, so a page that
              // cannot resolve it is distinguishable from a page that fails for another reason.
              try {
                const { DatabaseSync } = await import('node:sqlite')
                const db = new DatabaseSync(join(dataRoot, 'spaces', space.id, 'state.sqlite'), { readOnly: true })
                const globals = db.prepare('SELECT value FROM unit_globals WHERE unit=?').get('workspace')
                const ws = db.prepare('SELECT key FROM u_workspace_workspaces LIMIT 1').get()
                db.close()
                console.error(JSON.stringify({ e2e: 'workspace-registry', workspaceKey: ws?.key ?? null, globals: globals ? JSON.parse(globals.value) : null }))
              } catch (error) { console.error(JSON.stringify({ e2e: 'workspace-registry', error: error.message })) }
              // The page did not carry the version header. Record what it did answer, so the reason
              // is visible instead of being reported as "null".
              const probe = await api.spacePage(space.id)
              console.error(JSON.stringify({ e2e: 'space-page', expectedVersion, serving, status: probe.status, location: probe.location, contentType: probe.contentType, bodyHead: probe.bodyHead }))
            }
            assert.equal(serving, expectedVersion, 'the service must report the version being verified')
            if (expectedVersion === NEW_VERSION) {
              candidate.observed = serving
              candidate.port = listener.port
            }
            if (expectedVersion !== NEW_VERSION) {
              // Recovery path: reachability is enough here; acceptance is the caller's job.
              return { serving }
            }
            // The new version writes real content before verification fails.
            marker = `rollback-marker-${Date.now()}`
            const created = await api.rpc(space.id, 'createNote', { relativePath: `notes/rollback-${marker}.md`, markdown: `# ${marker}\n\nwritten by ${NEW_VERSION}\n` }, session.value.csrf)
            assert.equal(created.ok, true, `createNote must succeed: ${JSON.stringify(created).slice(0, 200)}`)
            noteId = created.value.noteId
            // The attachment is uploaded first, then linked from the note body. `getNote` reports
            // the attachments a note *references* — it scans the markdown for managed link targets,
            // it does not list what happens to share an owner id — so an upload that is never
            // referenced is an attachment no reader would ever see.
            const attachmentBytes = Buffer.from(`attachment written by ${NEW_VERSION}\n`)
            const attachmentName = `rollback-${marker}.bin`
            // The RPC takes the bytes inline, base64, as JSON. This test previously sent multipart
            // form data, which the gateway does not accept for `/api`: the upload was refused and
            // the attachment silently stayed null, so the rollback was never proven to carry one.
            const uploaded = await api.rpc(space.id, 'uploadAttachment', {
              filename: attachmentName, mimeType: 'application/octet-stream',
              contentBase64: attachmentBytes.toString('base64'), ownerNoteId: noteId,
            }, session.value.csrf)
            attachmentId = uploaded?.value?.attachmentId ?? null
            assert.ok(attachmentId, `the new release must have uploaded an attachment: ${JSON.stringify(uploaded).slice(0, 200)}`)
            const current = await api.rpc(space.id, 'getNote', { noteId }, session.value.csrf)
            assert.equal(current.ok, true, `the note must be readable before it is linked: ${JSON.stringify(current).slice(0, 200)}`)
            const linked = await api.rpc(space.id, 'saveNoteBody', {
              noteId,
              body: `${current.value.body}\n![${attachmentName}](attachments/${attachmentId}/${attachmentName})\n`,
              expectedContentHash: current.value.note.contentHash,
            }, session.value.csrf)
            assert.equal(linked.ok, true, `the note must link the attachment it owns: ${JSON.stringify(linked).slice(0, 200)}`)
            const relinked = await api.rpc(space.id, 'getNote', { noteId }, session.value.csrf)
            assert.equal(relinked.value.attachments.some(a => a.attachmentId === attachmentId), true,
              `the new release must report the attachment it linked: ${JSON.stringify(relinked.value.attachments)}`)
            const bodyPath = writtenNotePath()
            assert.ok(existsSync(bodyPath), 'the note the new version wrote must be on disk')
            throw new Error('synthetic post-activation verification failure (after writing real content)')
          },
        },
      })
    } catch (error) {
      if (error.code !== 'PKW_DEPLOYMENT_ROLLED_BACK') failedRun = true
      // A rollback that did not complete has to say what stopped it: the reasons the transaction
      // collected, the status it reached and the release it left behind, in one place.
      assert.equal(error.code, 'PKW_DEPLOYMENT_ROLLED_BACK', `unexpected failure: ${error.code ?? error.message}\n${JSON.stringify({
        reasons: (error.errors ?? []).map(e => e.message), status: error.report?.status ?? null,
        rollback: error.report?.rollback ?? null, reachable: error.report?.rollbackReachable ?? null,
        acceptanceError: error.report?.rollbackAcceptanceError ?? null,
        activationError: error.report?.activationError ?? null,
      }, null, 1).slice(0, 1200)}`)
      assert.equal(error.report?.status, 'rolled-back')
      assert.equal(error.report?.rollback?.restoredVersion, OLD_VERSION, 'the restored release must declare the old version')
      assert.match(error.message, /synthetic post-activation verification failure/, 'the original error must be preserved')
      assert.ok(noteId, 'the new release must have written a note before the failure')
      failedRun = false

      // ── the stop was confirmed by evidence, and nothing else owned the root while it was down ──
      // `stopEvidenceAtFailure` is the transaction's own record that it proved the candidate stopped
      // before it touched anything. That proof is the single-writer guarantee for the promotion: a
      // writer still holding the root would have failed the probe, and the run would never have
      // reached the candidate's writes.
      const steps = error.report?.recoverySteps ?? null
      assert.equal(steps?.stop, 'confirmed', `the rollback must run against a confirmed stop: ${JSON.stringify(steps)}`)
      assert.equal(steps?.stopEvidence?.stopped, true,
        `the confirmed stop must carry evidence that the candidate is gone: ${JSON.stringify(steps?.stopEvidence ?? null)}`)
      assert.equal(steps?.stopEvidence?.known, true,
        `the stop evidence must be knowledge, not an assumption: ${JSON.stringify(steps?.stopEvidence ?? null)}`)
      assert.equal(steps?.currentRepointed, true, `the rollback must repoint \`current\`: ${JSON.stringify(steps)}`)
      assert.equal(steps?.started, true, `the rollback must start the restored release: ${JSON.stringify(steps)}`)
      assert.equal(steps?.versionConfirmed, true, `the restored release must confirm its own version: ${JSON.stringify(steps)}`)

      // ── the candidate was stopped, and the stop is confirmed before anything replaces it ──
      // "The candidate was serving" and "the candidate is gone" are two observations, and the
      // rollback is only meaningful if both hold: a second listener still holding the port would
      // make the restored release's start hook fail to bind, which is a stopped service, not a
      // rolled-back one.
      assert.equal(candidate.observed, NEW_VERSION, 'the candidate must have served before the transaction stopped it')
      assert.deepEqual(candidate.stoppedAt, [NEW_VERSION], `the transaction must stop the release it started, not another one: ${JSON.stringify(candidate.stoppedAt)}`)
      assert.ok(candidate.port, 'the candidate must have been serving on a port')
      assert.equal(await portHeld(candidate.port), false, `the stopped candidate must leave its port free (${candidate.port})`)
      // Only the candidate is checked here. The transaction starts the previous release itself, both
      // to observe reachability and to run the rollback acceptance, so a listener for that version
      // may still be in service at this point — and it is stopped in the `finally` block below.
      assert.equal(listeners.has(NEW_VERSION), false, 'the candidate this test started must not survive the rollback')

      // ── rollback verification: the OLD service must read the NEW data back ────
      const oldListener = await startListener(OLD_VERSION)
      const oldApi = client(oldListener.port)
      assert.equal((await oldApi.login()).status, 200, 'the restored service must accept a real login')
      const session = await oldApi.session()
      const space = session.value.spaces[0]
      assert.equal(await oldApi.spaceVersion(space.id), OLD_VERSION, 'the restored service must report the actual old version')
      const read = await oldApi.rpc(space.id, 'getNote', { noteId }, session.value.csrf)
      assert.equal(read.ok, true, `the old service must read the note the new release wrote: ${JSON.stringify(read).slice(0, 200)}`)
      // The attachment the new release uploaded has to survive the rollback as well: the restored
      // service must still resolve it by id, not merely still hold a row for it.
      assert.ok(attachmentId, 'the new release must have uploaded an attachment before the failure')
      assert.equal(read.value.attachments.some(a => a.attachmentId === attachmentId), true,
        `the restored service must resolve the attachment the new release uploaded: ${JSON.stringify(read.value.attachments)}`)
      const fetched = await oldApi.download(space.id, attachmentId)
      assert.equal(fetched.status, 200, `the restored service must serve the attachment bytes (HTTP ${fetched.status})`)
      assert.deepEqual(fetched.bytes, Buffer.from(`attachment written by ${NEW_VERSION}\n`), 'the attachment bytes must be preserved')
      // The bytes are compared through the restored service above and on disk here, together with
      // the file mode: an attachment that comes back with different bytes, or with a mode the
      // product never sets, is not the same attachment.
      const attachmentPath = join(dataRoot, 'spaces', data.spaceId, 'workspace', 'attachments', attachmentId, `rollback-${marker}.bin`)
      const stored = await readFile(attachmentPath)
      assert.deepEqual(stored, Buffer.from(`attachment written by ${NEW_VERSION}\n`), 'the attachment on disk must hold the bytes the new release uploaded')
      // The two paths differ on purpose and the difference is asserted rather than smoothed over:
      // a note body is written `0o600` by the notes service, while attachment bytes go through
      // `writeBytes` without a mode and take the process umask. Both are the product's own modes —
      // the rehearsal report for the release in service records `attachment.mode = "644"` from the
      // same upload path — so this asserts what the product does, not what one might prefer.
      assert.equal((await stat(attachmentPath)).mode & 0o777, 0o644, 'the attachment mode must be the one the product writes through its upload path')
      const onDisk = await readFile(writtenNotePath(), 'utf8')
      assert.ok(onDisk.includes(marker), 'the written body must still be present')
      // The product writes note bodies `0o600`, and the store the product's own site serves from
      // carries that same mode on every note. Asserting `0o644` here would be asserting a
      // permission the product never sets, and it would pass only on a root-owned rehearsal tree.
      assert.equal((await stat(writtenNotePath())).mode & 0o777, 0o600, 'the file mode must be the one the product writes')
      const listed = await oldApi.rpc(space.id, 'listNotes', {}, session.value.csrf)
      assert.equal(listed.ok, true)
      console.log(`  rollback verified: note=${noteId} attachment=${attachmentId} version=${OLD_VERSION}`)
      return
    }
    assert.equal(switched.status, 'activated')
  } finally {
    // Kill the whole process group *and* the process itself: a listener spawned as a group leader
    // dies with its group, and one whose group call fails would otherwise be left holding its port
    // and the data root's lock after the test has gone.
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* no group of its own */ }
      try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    await registry.close()
    // A failing run keeps its scene (the staged releases, the copied data root and the listener
    // logs) unless it succeeded or the caller asked for cleanup: deleting the evidence is what
    // makes a failure expensive to diagnose.
    if (process.env.PKW_E2E_KEEP) {
      console.error(JSON.stringify({ e2e: 'kept', root, dataRoot: data.root, failed: failedRun }))
    } else if (!failedRun) {
      await rm(root, { recursive: true, force: true })
      await rm(data.root, { recursive: true, force: true })
    } else {
      console.error(JSON.stringify({ e2e: 'kept-on-failure', root, dataRoot: data.root }))
    }
  }
})

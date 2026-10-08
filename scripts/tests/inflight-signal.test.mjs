#!/usr/bin/env node
/**
 * Explicit in-flight signal: the deterministic form of the drain test.
 *
 * The two drain tests in `pkw-shutdown.test.mjs` decide "in flight" with a fixed sleep, which only
 * makes it likely. This file does it with a signal that cannot be missed:
 *
 *   arm      the listener is told which request to watch (path, method, ordinal)
 *   entered  the listener records that the request is inside the handler, and holds it there
 *   signalled  SIGTERM is sent while the request is provably unfinished (no `released` record)
 *   released the test lets the request continue; the drain has to finish it
 *   stopped  the listener exits; the run says with which code
 *   restart  a fresh process must read back what was committed
 *
 * It checks both halves separately: the write that was committed before the signal, and the write
 * that was in flight across it. A failure names the stage that failed and keeps the directory.
 *
 * Usage:
 *   PKW_TEST_PROFILE=... PKW_TEST_DATA_ROOT=... node inflight-signal.test.mjs
 * Without PKW_TEST_PROFILE the test declares the skip and names the missing input.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, randomUUID, scrypt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { copyDataRoot } from '../../scripts/copy-data-root.mjs'

const scryptAsync = promisify(scrypt)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptsDir = join(repoRoot, 'scripts')
const PASSWORD = 'inflight-signal-passphrase-only'
const profile = () => process.env.PKW_TEST_PROFILE ?? ''
const sourceRoot = () => process.env.PKW_TEST_DATA_ROOT ?? ''
const skipReason = profile()
  ? (sourceRoot() && existsSync(join(sourceRoot(), 'identity.sqlite')) ? false : 'no PKW test data root available (set PKW_TEST_DATA_ROOT to a generated fixture)')
  : 'no PKW profile available (set PKW_TEST_PROFILE)'

/** A port nothing is listening on, chosen by the kernel. */
function freePort() {
  const server = createServer()
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolvePromise(port))
  }))
}

/** A working directory plus a data copy, its password rewritten for this run. */
async function makeWorkdir({ withStub = false } = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'pkw-inflight-'))
  const root = join(workDir, 'data')
  const copy = await copyDataRoot(sourceRoot(), root)
  assert.deepEqual(copy.leaks, [], 'the copy must be isolated from its source')
  const identityPath = join(root, 'identity.sqlite')
  const salt = randomBytes(16).toString('hex')
  const derived = await scryptAsync(PASSWORD, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  const identity = new DatabaseSync(identityPath)
  identity.prepare('UPDATE accounts SET password=? WHERE username=?').run(`scrypt-v1:${salt}:${derived.toString('hex')}`, 'owner')
  const spaceId = identity.prepare('SELECT id FROM spaces LIMIT 1').get().id
  identity.close()

  let stub = null
  if (withStub) {
    const calls = []
    const server = createServer((req, res) => {
      calls.push({ method: req.method, url: req.url })
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') }, 1500)
    })
    await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
    stub = { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(resolvePromise => server.close(resolvePromise)) }
  }
  return { workDir, root, identityPath, spaceId, stub }
}

/** Arm the observation gate: the listener reports and holds one chosen request. */
async function armGate({ workDir, path, method = 'POST', holdCount }) {
  const log = join(workDir, 'gate.log')
  const release = join(workDir, 'gate.release')
  const configPath = join(workDir, 'gate.json')
  await writeFile(configPath, JSON.stringify({ path, method, holdCount, holdMs: 0, log, release }), { mode: 0o600 })
  const entries = async () => String(await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return {
    configPath,
    async entered(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = (await entries()).find(entry => entry.event === 'entered')
        if (found) return found
        if (Date.now() > deadline) return null
        await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      }
    },
    async releasedCount() { return (await entries()).filter(entry => entry.event === 'released').length },
    async release() { await writeFile(release, 'go\n', { mode: 0o600 }) },
  }
}

/** Start a listener whose life this test owns. */
function startListener({ configPath, port, gate, workDir, tag }) {
  const stages = []
  const stage = (name, detail = {}) => {
    const entry = { at: new Date().toISOString(), tag, stage: name, ...detail }
    stages.push(entry)
    appendFileSync(join(workDir, `${tag}.log`), `${JSON.stringify(entry)}\n`)
    return entry
  }
  const child = spawn(process.execPath, [
    join(scriptsDir, 'serve-collaboration.mjs'), '--profile', profile(), '--config', configPath, '--port', String(port),
  ], {
    env: {
      ...process.env, PW: PASSWORD, PKW_TEST_WEKNORA_KEY: 'stub-key',
      ...(gate ? { PKW_TEST_GATE_FILE: gate.configPath } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return {
    child, stages, stage,
    get stdout() { return stdout },
    get stderr() { return stderr },
    exited: new Promise(resolvePromise => child.once('exit', (code, signal) => {
      const outcome = { code, signal }
      stage('stopped', { ...outcome, graceful: stdout.includes('"status":"graceful-shutdown"'), forced: stderr.includes('"status":"forced-exit"') })
      resolvePromise(outcome)
    })),
    async ready(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (stdout.includes('"status":"listening"')) return true
        if (child.exitCode !== null) throw new Error(`the listener exited with ${child.exitCode}: ${stderr.slice(-300)}`)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
      throw new Error(`the listener never reported listening: ${stderr.slice(-300)}`)
    },
  }
}

/** A cookie-keeping client for one origin. */
function client(port, { stage }) {
  const jar = new Map()
  const origin = `http://127.0.0.1:${port}`
  return {
    async call(path, { method = 'GET', body, csrf } = {}) {
      const headers = { Origin: origin }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (csrf) headers['X-PKW-CSRF'] = csrf
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      let response
      try {
        response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
      } catch (error) {
        stage(`http-${method}-${path}-failed`, { message: error.message, cause: error.cause?.message ?? null })
        return { status: 0, transport: error.message, cause: error.cause?.message ?? null }
      }
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';'); const at = pair.indexOf('=')
        if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
      }
      const text = await response.text()
      let parsed; try { parsed = JSON.parse(text) } catch { parsed = parsed = text }
      stage(`http-${method}-${path}`, { status: response.status, ok: response.status === 200 })
      return { status: response.status, body: parsed }
    },
  }
}

test('lifecycle: an explicit signal proves a request was in flight, and the drain commits it', { skip: skipReason }, async () => {
  const port = await freePort()
  const { workDir, root, spaceId, stub } = await makeWorkdir({ withStub: true })
  const configPath = join(root, 'collaboration.json')
  await writeFile(configPath, JSON.stringify({
    dataPath: root, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PW',
    retrieval: { [spaceId]: { baseUrl: stub.url, kbId: 'kb-inflight', apiKeyEnv: 'PKW_TEST_WEKNORA_KEY' } },
  }, null, 2), { mode: 0o600 })
  // The fifth request to this path is the write that must be in flight across the signal.
  const gate = await armGate({ workDir, path: `/pkw/spaces/${spaceId}/api`, holdCount: 5 })
  const listener = startListener({ configPath, port, gate, workDir, tag: 'first' })
  let second = null
  try {
    await listener.ready()
    const api = client(port, { stage: listener.stage })
    const login = await api.call('/pkw/login', { method: 'POST', body: { username: process.env.PKW_TEST_USERNAME ?? 'owner', password: PASSWORD } })
    assert.equal(login.status, 200, `login must work: ${JSON.stringify(login.body)}`)
    const session = await api.call('/pkw/session')
    const csrf = session.body.value.csrf
    const rpc = (method, args) => api.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf })

    const created = await rpc('createNote', { relativePath: `inflight-${randomUUID().slice(0, 8)}.md`, markdown: '# inflight\n\nfirst\n' })
    assert.equal(created.status, 200, `createNote must work: ${JSON.stringify(created.body)}`)
    const noteId = created.body.value.noteId
    const read = await rpc('getNote', { noteId })
    assert.equal(read.status, 200, `getNote must work: ${JSON.stringify(read.body)}`)

    // (1) the write that is committed before the signal — the control
    const controlMarker = `control-${randomUUID().slice(0, 8)}`
    const control = await rpc('saveNoteBody', {
      noteId, body: `# inflight\n\n${controlMarker}\n`,
      expectedContentHash: read.body.value.note.contentHash, expectedRevision: read.body.value.note.observedRevision,
    })
    assert.equal(control.status, 200, `the control write must be committed: ${JSON.stringify(control.body)}`)

    // (2) the write that is in flight across the signal
    const current = await rpc('getNote', { noteId })
    const inFlightMarker = `inflight-${randomUUID().slice(0, 8)}`
    let settled = false
    const inFlight = rpc('saveNoteBody', {
      noteId, body: `# inflight\n\n${controlMarker}\n${inFlightMarker}\n`,
      expectedContentHash: current.body.value.note.contentHash, expectedRevision: current.body.value.note.observedRevision,
    }).then(value => { settled = true; return value }, error => { settled = true; throw error })

    const entered = await gate.entered()
    assert.ok(entered, 'the write must be observed entering the handler')
    assert.equal(entered.ordinal, 5, `the watched request must be the write: ${JSON.stringify(entered)}`)
    assert.equal(settled, false, 'the write must be unfinished when the signal arrives')
    assert.equal(await gate.releasedCount(), 0, 'the write must still be held when the signal arrives')
    listener.stage('signalled', { settled, releasedCount: 0 })
    listener.child.kill('SIGTERM')
    assert.equal(settled, false, 'the write must still be unfinished after the signal')
    assert.equal(await gate.releasedCount(), 0, 'the write must still be held after the signal')
    await gate.release()
    const inFlightResult = await inFlight.then(value => value, error => ({ status: 0, transport: error.message, cause: error.cause?.message ?? null }))
    assert.equal(inFlightResult.status, 200, `the drained write must be committed: ${JSON.stringify(inFlightResult)}`)
    const stopped = await listener.exited
    assert.equal(stopped.code, 0, `the listener must shut down gracefully: ${listener.stderr.slice(-400)}`)

    // The commit is on disk and in the index, and a fresh process reads both writes back.
    const store = new DatabaseSync(join(root, 'spaces', spaceId, 'state.sqlite'), { readOnly: true })
    let indexed
    try { indexed = JSON.parse(store.prepare('SELECT value FROM u_pkw_notes_note_index WHERE key=?').get(noteId).value) } finally { store.close() }
    listener.stage('indexed', { revision: indexed.observedRevision, hash: indexed.contentHash.slice(0, 12) })

    second = startListener({ configPath, port, workDir, tag: 'second' })
    await second.ready()
    const api2 = client(port, { stage: second.stage })
    const login2 = await api2.call('/pkw/login', { method: 'POST', body: { username: process.env.PKW_TEST_USERNAME ?? 'owner', password: PASSWORD } })
    assert.equal(login2.status, 200, `the restarted listener must accept the login: ${JSON.stringify(login2.body)}`)
    const session2 = await api2.call('/pkw/session')
    const reloaded = await api2.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method: 'getNote', args: { noteId } }, csrf: session2.body.value.csrf })
    assert.equal(reloaded.status, 200, `the restarted listener must read the note: ${JSON.stringify(reloaded.body)}`)
    const body = JSON.stringify(reloaded.body.value)
    assert.equal(reloaded.body.value.note.contentHash, indexed.contentHash, 'the fresh reader must see the committed revision')
    assert.ok(body.includes(controlMarker), 'the write committed before the signal must survive')
    assert.ok(body.includes(inFlightMarker), 'the write in flight across the signal must survive')
    second.stage('restart-read', { revision: reloaded.body.value.note.observedRevision, control: true, inFlight: true })
    second.child.kill('SIGTERM')
    assert.equal((await second.exited).code, 0, 'the restarted listener must shut down gracefully')
  } finally {
    listener.child.kill('SIGKILL')
    if (second) second.child.kill('SIGKILL')
    await stub.close()
    if (process.env.PKW_KEEP_WORKDIR) {
      const summary = [...listener.stages, ...(second?.stages ?? [])]
      console.error(`kept ${workDir}; ${summary.length} stages recorded; log: ${join(workDir, 'first.log')}`)
    } else {
      await rm(workDir, { recursive: true, force: true })
    }
  }
})

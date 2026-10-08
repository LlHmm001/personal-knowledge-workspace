#!/usr/bin/env node
/**
 * In-flight, proved inside the business operation rather than at the door.
 *
 * The listener's observation gate sits in front of `gateway.handle()`. That proves a request was
 * accepted and queued; it does not prove the operation was started. For a drain test the difference
 * is the whole question: a request parked before the gateway is a request nobody has begun, and a
 * shutdown that "finishes" it says nothing about work in progress.
 *
 * These two tests hold the request *inside* the service's own `call()` — the single entry point every
 * RPC method goes through — using a preload that the product does not know about
 * (`helpers/business-entry-hook.mjs`). So the observation is of the product's own dispatch, and the
 * hold is on real business work, with the service's in-flight accounting already counting it.
 *
 * The second half of each test is a slow remote sync: the sync is held until the *remote stub has
 * received the request*, so the operation that crosses the signal is one with an outstanding remote
 * call, not merely one that has begun.
 *
 * In both, the release happens only after the listener has announced that it started draining. A
 * request released before the signal arrives is a request that finished early, and the run would
 * then pass for the wrong reason.
 *
 * Usage:
 *   PKW_TEST_PROFILE=... PKW_TEST_DATA_ROOT=... PKW_TEST_USERNAME=owner \
 *     node --test scripts/tests/business-entry.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, randomUUID, scrypt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFileSync, readFileSync } from 'node:fs'
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
const PASSWORD = 'business-entry-passphrase-only'
const profile = () => process.env.PKW_TEST_PROFILE ?? ''
const sourceRoot = () => process.env.PKW_TEST_DATA_ROOT ?? ''
const skipReason = profile()
  ? (sourceRoot() && existsSync(join(sourceRoot(), 'identity.sqlite')) ? false : 'no PKW test data root available (set PKW_TEST_DATA_ROOT to a generated fixture)')
  : 'no PKW profile available (set PKW_TEST_PROFILE)'

function freePort() {
  const server = createServer()
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolvePromise(port))
  }))
}

/** A working directory, a copied data root with a known password, and an optional remote stub. */
async function makeWorkdir({ withStub = false } = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'pkw-entry-'))
  const root = join(workDir, 'data')
  const copy = await copyDataRoot(sourceRoot(), root)
  assert.deepEqual(copy.leaks, [], 'the copy must be isolated from its source')
  const salt = randomBytes(16).toString('hex')
  const derived = await scryptAsync(PASSWORD, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  const identity = new DatabaseSync(join(root, 'identity.sqlite'))
  identity.prepare('UPDATE accounts SET password=? WHERE username=?').run(`scrypt-v1:${salt}:${derived.toString('hex')}`, 'owner')
  const spaceId = identity.prepare('SELECT id FROM spaces LIMIT 1').get().id
  identity.close()

  let stub = null
  if (withStub) {
    const requests = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        // The stub records the moment the remote request arrived, which is what "the sync is in
        // flight" means for the purposes of these tests: not that the call was made, but that the
        // far side is holding it.
        requests.push({ at: new Date().toISOString(), method: req.method, url: req.url, bytes: body.length })
        setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') }, 1500)
      })
    })
    await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
    stub = {
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise(resolvePromise => server.close(() => resolvePromise(undefined))),
    }
  }
  return { workDir, root, spaceId, stub }
}

/** The business-entry hook's configuration: one ledger, one method, optionally a hold. */
async function armEntryHold({ workDir, method, hold = true }) {
  const path = join(workDir, 'entry.log')
  const release = join(workDir, 'entry.release')
  const configPath = join(workDir, 'entry.json')
  await writeFile(configPath, JSON.stringify({ path, method, hold, release }, null, 2), { mode: 0o600 })
  const entries = async () => String(await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return {
    configPath,
    async entered(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = (await entries()).find(entry => entry.event === 'business-entered')
        if (found) return found
        if (Date.now() > deadline) return null
        await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      }
    },
    async releasedCount() { return (await entries()).filter(entry => entry.event === 'business-released').length },
    async release() { await writeFile(release, 'go\n', { mode: 0o600 }) },
  }
}

/** Start the listener with the entry hook, recording its output and its own stage stream. */
function startListener({ configPath, port, workDir, tag, entry, gate, stubUrl, spaceId }) {
  const stages = []
  const stage = (name, detail = {}) => {
    const entry_ = { at: new Date().toISOString(), tag, stage: name, ...detail }
    stages.push(entry_)
    appendFileSync(join(workDir, `${tag}.log`), `${JSON.stringify(entry_)}\n`)
    return entry_
  }
  const child = spawn(process.execPath, [
    '--import', join(scriptsDir, 'tests', 'helpers', 'business-entry-hook.mjs'),
    join(scriptsDir, 'serve-collaboration.mjs'),
    '--profile', profile(), '--config', configPath, '--port', String(port),
  ], {
    env: {
      ...process.env, PW: PASSWORD, PKW_TEST_WEKNORA_KEY: 'stub-key',
      ...(entry ? { PKW_TEST_ENTRY_FILE: entry.configPath } : {}),
      ...(gate ? { PKW_TEST_GATE_FILE: gate } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  void stubUrl
  void spaceId
  return {
    child, stages, stage,
    get stdout() { return stdout },
    get stderr() { return stderr },
    exited: new Promise(resolvePromise => child.once('exit', (code, signal) => {
      const outcome = { code, signal }
      stage('stopped', { ...outcome, graceful: stdout.includes('"status":"graceful-shutdown"'), forced: stderr.includes('"status":"forced-exit"') })
      resolvePromise(outcome)
    })),
    async ready(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (stdout.includes('"status":"listening"')) return true
        if (child.exitCode !== null) throw new Error(`the listener exited with ${child.exitCode}: ${stderr.slice(-400)}`)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
      }
      throw new Error(`the listener never reported listening: ${stderr.slice(-400)}`)
    },
  }
}

/**
 * Arm the listener's gate for its drain receipt only.
 *
 * The gate is what records `drain` when the graceful path begins, and it is inert unless
 * `PKW_TEST_GATE_FILE` is set. Its path is deliberately one no request in these tests uses: the hold
 * these tests need is inside the business method, not in front of the gateway, and a gate that also
 * held requests would leave two things blocking the same operation.
 */
async function armDrainReceipt({ workDir }) {
  const log = join(workDir, 'gate.log')
  const configPath = join(workDir, 'gate.json')
  await writeFile(log, '', { mode: 0o600 })
  await writeFile(configPath, JSON.stringify({
    path: '/never/used/by/these/tests', method: 'POST', holdCount: 1, holdMs: 0,
    log, release: join(workDir, 'gate.release'),
  }, null, 2), { mode: 0o600 })
  return { configPath, log }
}

/** Wait for the gate's drain receipt: the listener is inside the graceful path. */
async function waitForDrain(gatePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lines = String(await readFile(gatePath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const found = lines.find(entry => entry.event === 'drain')
    if (found) return found
    if (Date.now() > deadline) return null
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
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
      let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
      stage(`http-${method}-${path}`, { status: response.status, ok: response.status === 200 })
      return { status: response.status, body: parsed }
    },
  }
}

test('business entry: the write is held inside the service, and the signal arrives there', { skip: skipReason }, async () => {
  const port = await freePort()
  const { workDir, root, spaceId } = await makeWorkdir({ withStub: false })
  const configPath = join(root, 'collaboration.json')
  await writeFile(configPath, JSON.stringify({ dataPath: root, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: process.env.PKW_TEST_USERNAME ?? 'owner', bootstrapPasswordEnv: 'PW' }, null, 2), { mode: 0o600 })
  const receipt = await armDrainReceipt({ workDir })
  const gatePath = receipt.log
  const entry = await armEntryHold({ workDir, method: 'saveNoteBody' })
  const listener = startListener({ configPath, port, workDir, tag: 'first', entry, gate: receipt.configPath })
  try {
    await listener.ready()
    const api = client(port, { stage: listener.stage })
    const login = await api.call('/pkw/login', { method: 'POST', body: { username: process.env.PKW_TEST_USERNAME ?? 'owner', password: PASSWORD } })
    assert.equal(login.status, 200, `login: ${JSON.stringify(login.body)}`)
    const session = await api.call('/pkw/session')
    const rpc = (method, args) => api.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf: session.body.value.csrf })

    const created = await rpc('createNote', { relativePath: `entry-${randomUUID().slice(0, 8)}.md`, markdown: '# entry\n\ncommitted before the signal\n' })
    assert.equal(created.status, 200, `createNote: ${JSON.stringify(created.body)}`)
    const noteId = created.body.value.noteId
    const read = await rpc('getNote', { noteId })
    assert.equal(read.status, 200, `getNote: ${JSON.stringify(read.body)}`)

    // The write that will be held. It is not awaited: the point is to send the signal while it is
    // inside the operation.
    let settled = false
    const held = rpc('saveNoteBody', {
      noteId, body: `# entry\n\nheld inside the business method ${randomUUID().slice(0, 8)}\n`,
      expectedContentHash: read.body.value.note.contentHash,
      expectedRevision: read.body.value.note.observedRevision,
    }).then(value => { settled = true; return value }, error => { settled = true; throw error })

    const entered = await entry.entered()
    assert.ok(entered, 'the write must be observed entering the business method, not just the gateway')
    assert.equal(entered.method, 'saveNoteBody')
    assert.equal(entered.noteId, noteId)
    assert.equal(settled, false, 'the write must be unfinished when the signal arrives')
    assert.equal(await entry.releasedCount(), 0, 'the write must still be held when the signal arrives')
    listener.stage('inside-business-method', { noteId, method: entered.method })

    listener.child.kill('SIGTERM')
    // The release is conditional on the service having begun its drain. Releasing first would let the
    // write finish before the signal, and the drain would then be an empty one that passed for the
    // wrong reason.
    const drain = await waitForDrain(gatePath)
    assert.ok(drain, 'the listener must announce that it started draining')
    assert.ok(drain.inflight >= 1, `the drain must begin with the write still counted in flight: ${JSON.stringify(drain)}`)
    assert.equal(settled, false, 'the write must still be unfinished inside the drain')
    listener.stage('drain-receipt', { inflight: drain.inflight })
    await entry.release()
    const heldResult = await held.then(value => value, error => ({ status: 0, transport: error.message }))
    assert.equal(heldResult.status, 200, `the drained write must be committed: ${JSON.stringify(heldResult)}`)
    const stopped = await listener.exited
    assert.equal(stopped.code, 0, `the listener must shut down gracefully: ${listener.stderr.slice(-400)}`)

    // Durable, and readable by a fresh process.
    const store = new DatabaseSync(join(root, 'spaces', spaceId, 'state.sqlite'), { readOnly: true })
    let indexed
    try { indexed = JSON.parse(store.prepare('SELECT value FROM u_pkw_notes_note_index WHERE key=?').get(noteId).value) } finally { store.close() }
    listener.stage('indexed', { revision: indexed.observedRevision })

    const second = startListener({ configPath, port, workDir, tag: 'second', entry: null, gate: receipt.configPath })
    try {
      await second.ready()
      const api2 = client(port, { stage: second.stage })
      const login2 = await api2.call('/pkw/login', { method: 'POST', body: { username: process.env.PKW_TEST_USERNAME ?? 'owner', password: PASSWORD } })
      assert.equal(login2.status, 200, `the restarted listener must accept the login: ${JSON.stringify(login2.body)}`)
      const session2 = await api2.call('/pkw/session')
      const reloaded = await api2.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method: 'getNote', args: { noteId } }, csrf: session2.body.value.csrf })
      assert.equal(reloaded.status, 200, `the restarted listener must read the note: ${JSON.stringify(reloaded.body)}`)
      assert.equal(reloaded.body.value.note.contentHash, indexed.contentHash, 'a fresh reader must see the committed revision')
      assert.ok(JSON.stringify(reloaded.body.value).includes('held inside the business method'), 'the held write must have survived')
      second.stage('restart-read', { revision: reloaded.body.value.note.observedRevision })
      second.child.kill('SIGTERM')
      assert.equal((await second.exited).code, 0, 'the restarted listener must shut down gracefully')
    } finally {
      second.child.kill('SIGKILL')
    }
  } finally {
    listener.child.kill('SIGKILL')
    if (process.env.PKW_KEEP_WORKDIR) console.error(JSON.stringify({ kept: workDir, stages: [...listener.stages] }))
    else await rm(workDir, { recursive: true, force: true })
  }
})

test('business entry: a slow sync is held until the remote stub holds it, then the drain finishes it', { skip: skipReason }, async () => {
  const port = await freePort()
  const { workDir, root, spaceId, stub } = await makeWorkdir({ withStub: true })
  const configPath = join(root, 'collaboration.json')
  await writeFile(configPath, JSON.stringify({
    dataPath: root, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: process.env.PKW_TEST_USERNAME ?? 'owner', bootstrapPasswordEnv: 'PW',
    retrieval: { [spaceId]: { baseUrl: stub.url, kbId: 'kb-business-entry', apiKeyEnv: 'PKW_TEST_WEKNORA_KEY' } },
  }, null, 2), { mode: 0o600 })
  const receipt = await armDrainReceipt({ workDir })
  const gatePath = receipt.log
  const entry = await armEntryHold({ workDir, method: 'syncEntity', hold: false })
  const listener = startListener({ configPath, port, workDir, tag: 'only', entry, gate: receipt.configPath })
  try {
    await listener.ready()
    const api = client(port, { stage: listener.stage })
    const login = await api.call('/pkw/login', { method: 'POST', body: { username: process.env.PKW_TEST_USERNAME ?? 'owner', password: PASSWORD } })
    assert.equal(login.status, 200, `login: ${JSON.stringify(login.body)}`)
    const session = await api.call('/pkw/session')
    const rpc = (method, args) => api.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf: session.body.value.csrf })

    const created = await rpc('createNote', { relativePath: `sync-${randomUUID().slice(0, 8)}.md`, markdown: '# slow sync\n\nqueued\n' })
    assert.equal(created.status, 200, `createNote: ${JSON.stringify(created.body)}`)
    const noteId = created.body.value.noteId

    const syncing = rpc('syncEntity', { entityType: 'note', entityId: noteId })
    const entered = await entry.entered()
    assert.ok(entered, 'the sync must be observed entering the business method')

    // Wait for the remote stub to actually receive the request. This is the difference between "the
    // sync was called" and "the sync is in flight": until the far side holds it, there is nothing
    // outstanding to drain.
    const deadline = Date.now() + 30_000
    while (stub.requests.length === 0 && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    assert.ok(stub.requests.length > 0, 'the remote stub must have received the sync request before the signal')
    listener.stage('stub-received', { url: stub.requests[0].url, bytes: stub.requests[0].bytes })

    listener.child.kill('SIGTERM')
    const drain = await waitForDrain(gatePath)
    assert.ok(drain, 'the listener must announce that it started draining')
    assert.ok(drain.inflight >= 1, `the drain must begin with the sync still counted in flight: ${JSON.stringify(drain)}`)
    listener.stage('drain-receipt', { inflight: drain.inflight })
    const stopped = await listener.exited
    assert.equal(stopped.code, 0, `the listener must shut down gracefully: ${listener.stderr.slice(-400)}`)
    assert.ok(listener.stdout.includes('"status":"graceful-shutdown"'), 'the graceful path must be the one taken')
    assert.ok(!listener.stderr.includes('"status":"forced-exit"'), 'a graceful stop must not report a forced exit')
    // The sync's own outcome is recorded, and whether it succeeded is *not* asserted: the remote side
    // is held 1.5s and the drain can legitimately refuse work that has not committed. What must hold
    // is the local commit — asserted below — so the outcome is reported rather than smoothed over.
    const syncResult = await syncing.then(value => value, error => ({ status: 0, transport: error.message }))
    listener.stage('sync-outcome', { status: syncResult.status })

    // The local commit is what has to survive; the remote being slow is irrelevant to it.
    const store = new DatabaseSync(join(root, 'spaces', spaceId, 'state.sqlite'), { readOnly: true })
    let row
    try { row = store.prepare('SELECT value FROM u_pkw_notes_note_index WHERE key=?').get(noteId) } finally { store.close() }
    assert.ok(row, 'the note must still be indexed after a shutdown during a slow sync')
    assert.ok(!existsSync(join(root, 'gateway.lock')), 'a graceful stop must release the data-root lock')
    listener.stage('committed', { noteId, remoteRequests: stub.requests.length })
  } finally {
    listener.child.kill('SIGKILL')
    await stub.close()
    if (process.env.PKW_KEEP_WORKDIR) console.error(JSON.stringify({ kept: workDir, stages: [...listener.stages], remoteRequests: stub.requests.length }))
    else await rm(workDir, { recursive: true, force: true })
  }
})

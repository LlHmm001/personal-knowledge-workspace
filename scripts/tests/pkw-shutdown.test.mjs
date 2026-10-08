/**
 * Shutdown behaviour tests for the dedicated collaboration listener.
 *
 * These tests drive a real gateway process against a *copy* of collaboration
 * data, log in over real HTTP, commit real note content through the authenticated
 * RPC surface, and then assert on how the process terminates. Nothing here talks
 * to production data or a production retrieval endpoint: the copy's WeKnora
 * configuration points at a loopback stub.
 *
 * The three required outcomes are asserted separately and never conflated:
 *   - graceful close while idle                      -> exit 0
 *   - graceful close with a run in flight            -> exit 0, committed data intact
 *   - drain budget exceeded / second signal          -> exit 1, reported as forced
 * plus: after an abnormal exit, a restart must succeed without manual repair and
 * the previously committed content must still be readable.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes, scrypt as scryptCallback, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { portHolder } from '../../deploy/site/process-stop-state.mjs'

const scrypt = promisify(scryptCallback)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptsDir = join(repoRoot, 'scripts')

/** Profile under test. Required: tests never guess a site path. */
function profileUnderTest() {
  return process.env.PKW_TEST_PROFILE
}
/** Source collaboration data root, copied per test. Never written in place. */
function sourceDataRoot() {
  return process.env.PKW_TEST_DATA_ROOT ?? ''
}
/** Account to log in with inside the copy; its password is rewritten per run. */
function testUsername() {
  return process.env.PKW_TEST_USERNAME ?? 'owner'
}

const TEST_PASSWORD = 'shutdown-test-passphrase-only'

/** Re-hash the copied owner account so the test can log in without the real secret. */
async function setCopyPassword(identityPath, username, password) {
  const salt = randomBytes(16).toString('hex')
  const derived = await scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  const hash = `scrypt-v1:${salt}:${derived.toString('hex')}`
  const db = new DatabaseSync(identityPath)
  try { db.prepare('UPDATE accounts SET password=? WHERE username=?').run(hash, username) } finally { db.close() }
}

/** Loopback WeKnora stub: records calls, answers slowly, never reaches a real host. */
async function startStub({ delayMs = 0, status = 200, body = { data: [], success: true } } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url })
    const respond = () => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (delayMs > 0) setTimeout(respond, delayMs); else respond()
  })
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok) })
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => server.close(r)) }
}

/**
 * Build an isolated data root with the shared copier: SQLite snapshots written straight
 * to the final destination, declared path fields remapped, and a leak check. Nothing is
 * copied and then patched afterwards, and no WAL is deleted from a plain copy.
 */
async function makeDataRoot({ stubUrl, spaceId }) {
  const root = join(await mkdtemp(join(tmpdir(), 'pkw-shutdown-')), 'data')
  const { copyDataRoot } = await import('../../scripts/copy-data-root.mjs')
  const copy = await copyDataRoot(sourceDataRoot(), root)
  assert.equal(copy.leaks.length, 0, `the copy must be self-contained: ${JSON.stringify(copy.leaks.slice(0, 2))}`)
  await setCopyPassword(join(root, 'identity.sqlite'), testUsername(), TEST_PASSWORD)
  const configPath = join(root, 'collaboration.json')
  await writeFile(configPath, JSON.stringify({
    dataPath: root,
    publicOrigin: 'http://127.0.0.1:0',
    bootstrapUsername: testUsername(),
    bootstrapPasswordEnv: 'PW',
    ...(stubUrl ? { retrieval: { [spaceId]: { baseUrl: stubUrl, kbId: 'kb-shutdown-test', apiKeyEnv: 'PKW_TEST_WEKNORA_KEY' } } } : {}),
  }, null, 2), { mode: 0o600 })
  return { root, configPath, rewritten: copy.rewritten }
}

/**
 * Run the listener as a child process and hand the caller control over its life.
 *
 * The port is passed explicitly: the listener's default is a production port, and a test
 * must never depend on — or collide with — whatever is running there.
 */
function startGateway({ profile, configPath, port, drainTimeoutMs, gate }) {
  const child = spawn(process.execPath, [
    join(scriptsDir, 'serve-collaboration.mjs'), '--profile', profile, '--config', configPath, '--port', String(port),
    ...(drainTimeoutMs === undefined ? [] : ['--drain-timeout-ms', String(drainTimeoutMs)]),
  ], {
    env: {
      ...process.env, PW: TEST_PASSWORD, PKW_TEST_WEKNORA_KEY: 'stub-key',
      // Only a test that armed a gate sets this; an unarmed listener runs no gate code.
      ...(gate ? { PKW_TEST_GATE_FILE: gate.configPath } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk; lines.push(...String(chunk).split('\n').filter(Boolean)) })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolvePromise => child.once('exit', (code, signal) => resolvePromise({ code, signal })))
  return {
    child, lines, exited,
    get stdout() { return stdout }, get stderr() { return stderr },
    async ready(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (lines.some(l => l.includes('"status":"listening"'))) return true
        if (child.exitCode !== null) throw new Error(`listener exited with ${child.exitCode}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`)
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error(`gateway did not report listening; stdout=${stdout.slice(-200)} stderr=${stderr.slice(-300)}`)
    },
  }
}

/** The first space id in the source data, so tests follow the data, not a fixture. */
async function firstSpaceId() {
  const identity = new DatabaseSync(join(sourceDataRoot(), 'identity.sqlite'), { readOnly: true })
  try { return identity.prepare('SELECT id FROM spaces LIMIT 1').get().id } finally { identity.close() }
}

/** Minimal cookie-jar HTTP client for the collaboration surface. */
function client(port) {
  const jar = new Map()
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    async call(path, { method = 'GET', body, csrf } = {}) {
      const headers = { Origin: origin }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      if (csrf) headers['X-PKW-CSRF'] = csrf
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      let response
      try {
        response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
      } catch (error) {
        // Name the call that failed: an unhandled "fetch failed" otherwise says nothing about
        // which step of the test lost its connection.
        throw new Error(`${method} ${path} failed: ${error.message}${error.cause ? ` (${error.cause.message})` : ''}`)
      }
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';'); const at = pair.indexOf('=')
        if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
      }
      const text = await response.text()
      let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
      return { status: response.status, body: parsed }
    },
  }
}


/** Boot one gateway against the copied root and return a logged-in RPC caller. */
/**
 * A gate that reports and parks one chosen request, so "in flight" is a fact, not a guess.
 *
 * A fixed sleep only makes it likely that an operation is still running when the signal arrives:
 * on a slow machine it may not have started, and on a fast one it may already have finished. The
 * gate numbers the requests matching a path and method, records the moment the chosen one enters
 * the handler, and holds that one until the test writes the release file. The request is passed to
 * the product untouched and is counted by the service's own in-flight registration, so what is
 * held is an ordinary request that has not finished — never a request taken out of band.
 */
async function armGate({ root, path, method = 'POST', holdCount = 1 }) {
  const log = join(root, 'gate.log')
  const release = join(root, 'gate.release')
  const configPath = join(root, 'gate.json')
  await writeFile(configPath, JSON.stringify({ path, method, holdCount, holdMs: 0, log, release }), { mode: 0o600 })
  const entries = async () => String(await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  return {
    configPath,
    /** The request the gate reported entering, waiting for it to arrive. */
    async entered(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = (await entries()).find(entry => entry.event === 'entered')
        if (found) return found
        if (Date.now() > deadline) return null
        await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
      }
    },
    /** Zero means the held request is still unfinished. */
    async releasedCount() { return (await entries()).filter(entry => entry.event === 'released').length },
    /** Let the held request continue. Written after the signal, so the drain is real. */
    async release() { await writeFile(release, 'go\n', { mode: 0o600 }) },
  }
}

async function bootAndLogin({ profile, configPath, port, drainTimeoutMs, gate }) {
  const gateway = startGateway({ profile, configPath, port, drainTimeoutMs, gate })
  await gateway.ready()
  const api = client(port)
  const session = await loginWith(api)
  const spaceId = session.spaces[0].id
  return {
    gateway,
    session,
    spaceId,
    rpc: (method, args) => api.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf: session.csrf }),
  }
}

async function loginWith(clientInstance, username = testUsername()) {
  const login = await clientInstance.call('/pkw/login', { method: 'POST', body: { username, password: TEST_PASSWORD } })
  assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.body)}`)
  const session = await clientInstance.call('/pkw/session')
  assert.equal(session.status, 200)
  return session.body.value
}

function sha256(text) { return createHash('sha256').update(text).digest('hex') }

function freePort() {
  const server = createServer()
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolvePromise(port))
  }))
}

const skipReason = profileUnderTest() ? false : 'no PKW profile available (set PKW_TEST_PROFILE)'
const dataRootAvailable = sourceDataRoot() !== '' && existsSync(join(sourceDataRoot(), 'identity.sqlite'))

test('S3/T-EXIT graceful shutdown while idle exits 0', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  const gateway = startGateway({ profile, configPath, port })
  try {
    await gateway.ready()
    const started = Date.now()
    gateway.child.kill('SIGTERM')
    const { code } = await gateway.exited
    const elapsed = Date.now() - started
    assert.equal(code, 0, `expected graceful exit 0, got ${code}; stderr=${gateway.stderr}`)
    assert.ok(elapsed < 10_000, `graceful exit took ${elapsed}ms`)
    assert.ok(gateway.stdout.includes('"status":"graceful-shutdown"'), `missing graceful marker: ${gateway.stdout}`)
    assert.ok(!existsSync(join(root, 'gateway.lock')), 'lock must be released by gateway.close()')
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/T-EXIT graceful shutdown with a request in flight commits data and exits 0', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const stub = await startStub({ delayMs: 1500, body: { ok: true } })
  // The space id is read from the copied identity store so the test follows data.
  const sourceIdentity = join(sourceDataRoot(), 'identity.sqlite')
  const identity = new DatabaseSync(sourceIdentity, { readOnly: true })
  const spaceId = identity.prepare('SELECT id FROM spaces LIMIT 1').get().id
  identity.close()
  const { root, configPath, rewritten } = await makeDataRoot({ stubUrl: stub.url, spaceId })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // The fifth request to this path is the write under test; the gate reports when it enters the
  // handler and holds it there until this test releases it.
  const gate = await armGate({ root, path: `/pkw/spaces/${spaceId}/api`, method: 'POST', holdCount: 5 })
  const gateway = startGateway({ profile, configPath, port, gate })
  try {
    await gateway.ready()
    const api = client(port)
    const session = await loginWith(api)
    const space = (session.spaces ?? []).find(s => s.id === spaceId) ?? { id: spaceId }
    const rpc = (method, args) => api.call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: { method, args }, csrf: session.csrf })
    const created = await rpc('createNote', { relativePath: `shutdown-${randomUUID().slice(0, 8)}.md`, markdown: '# shutdown test\n\nfirst body\n' })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const noteId = created.body.value.noteId
    const read = await rpc('getNote', { noteId })
    const marker = `committed-before-shutdown-${randomUUID().slice(0, 8)}`
    const saved = await rpc('saveNoteBody', {
      noteId, body: `# shutdown test\n\n${marker}
`,
      expectedContentHash: read.body.value.note.contentHash,
      expectedRevision: read.body.value.note.observedRevision,
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    // The in-flight write is held inside the listener and released only after the signal.
    const current = await rpc('getNote', { noteId })
    const inFlight = rpc('saveNoteBody', {
      noteId, body: `# shutdown test\n\n${marker}
in-flight\n`,
      expectedContentHash: current.body.value.note.contentHash,
      expectedRevision: current.body.value.note.observedRevision,
    })
    const entered = await gate.entered()
    assert.ok(entered, 'the in-flight write must be observed entering the listener')
    assert.equal(entered.ordinal, 5, `the watched request must be the write: ${JSON.stringify(entered)}`)
    assert.equal(await gate.releasedCount(), 0, 'the write must be unfinished when the signal arrives')
    const started = Date.now()
    gateway.child.kill('SIGTERM')
    assert.equal(await gate.releasedCount(), 0, 'the write must still be held after the signal, so the drain is real')
    await gate.release()
    const inFlightResult = await inFlight.catch(error => ({ status: 0, body: String(error) }))
    const { code } = await gateway.exited
    assert.equal(code, 0, `expected graceful exit 0, got ${code}; stderr=${gateway.stderr}`)
    assert.ok(Date.now() - started < 20_000, 'graceful shutdown must respect the drain budget')
    // Committed content must be durable: note bodies live in the space workspace,
    // and the index row records the hash and the revision the runtime observed.
    const store = new DatabaseSync(join(root, 'spaces', spaceId, 'state.sqlite'), { readOnly: true })
    let row, commitCount = 0
    try {
      row = store.prepare('SELECT value FROM u_pkw_notes_note_index WHERE key=?').get(noteId)
      commitCount = store.prepare("SELECT count(*) AS c FROM u_pkw_commits WHERE key LIKE ?").get(`%${noteId}%`).c
    } finally { store.close() }
    assert.ok(row, 'the note index entry must exist after the write')
    const indexed = JSON.parse(row.value)
    assert.equal(typeof indexed.contentHash, 'string', 'the index entry must carry a content hash')
    assert.ok(commitCount > 0, 'the committed write must be recorded in the commit log')
    console.log(`  in-flight write HTTP status: ${inFlightResult.status}; rewritten paths: ${rewritten.length}; indexed revision: ${indexed.observedRevision}; commits: ${commitCount}`)
    // Prove durability through the product: a fresh process must return the same revision.
    const second_ = await bootAndLogin({ profile, configPath, port })
    try {
      const reloaded = await second_.rpc('getNote', { noteId })
      assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body))
      assert.equal(reloaded.body.value.note.contentHash, indexed.contentHash, 'a fresh reader must see the committed revision')
      assert.ok(JSON.stringify(reloaded.body.value).includes(marker), 'the committed body must survive the restart')
      second_.gateway.child.kill('SIGTERM')
      assert.equal((await second_.gateway.exited).code, 0, 'the post-restart shutdown must be graceful')
    } finally { second_.gateway.child.kill('SIGKILL') }
  } finally {
    gateway.child.kill('SIGKILL')
    await stub.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/T-EXIT exceeded drain budget is a forced exit (1) and never reported graceful', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // 1ms budget: the close cannot possibly finish, so the forced path must run.
  const gateway = startGateway({ profile, configPath, port, drainTimeoutMs: 1 })
  try {
    await gateway.ready()
    gateway.child.kill('SIGTERM')
    const { code } = await gateway.exited
    assert.equal(code, 1, `forced exit must be non-zero, got ${code}`)
    assert.ok(gateway.stderr.includes('"status":"forced-exit"'), `missing forced marker: ${gateway.stderr}`)
    assert.ok(!gateway.stdout.includes('"status":"graceful-shutdown"'), 'a forced exit must never be reported as graceful')
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/T-EXIT restart after a forced exit needs no manual repair and keeps committed data', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  const first = startGateway({ profile, configPath, port, drainTimeoutMs: 1 })
  let spaceId, noteId, marker = `survives-forced-exit-${randomUUID().slice(0, 8)}`
  try {
    await first.ready()
    const api = client(port)
    const session = await loginWith(api)
    spaceId = session.spaces[0].id
    const rpc = (method, args) => api.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf: session.csrf })
    const created = await rpc('createNote', { relativePath: `persist-${randomUUID().slice(0, 8)}.md`, markdown: `# persist\n\n${marker}
` })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    noteId = created.body.value.noteId
    first.child.kill('SIGTERM')
    const { code } = await first.exited
    assert.equal(code, 1, 'the forced path must be exercised')
  } finally {
    first.child.kill('SIGKILL')
  }
  // A forced exit leaves the lock behind. The restart must recover it by itself:
  // the recorded writer is gone, so no human intervention is allowed to be needed,
  // and the test must not delete the lock on the product's behalf.
  const lockPath = join(root, 'gateway.lock')
  const lockLeftBehind = existsSync(lockPath)
  const lockBefore = lockLeftBehind ? JSON.parse(await readFile(lockPath, 'utf8')) : null
  const second = startGateway({ profile, configPath, port })
  try {
    await second.ready()
    const api = client(port)
    await loginWith(api)
    const session = await api.call('/pkw/session')
    const rpc = (method, args) => api.call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf: session.body.value.csrf })
    const read = await rpc('getNote', { noteId })
    assert.equal(read.status, 200, `committed note lost after forced exit: ${JSON.stringify(read.body)}`)
    assert.ok(JSON.stringify(read.body).includes(marker), 'committed marker must survive a forced exit')
    second.child.kill('SIGTERM')
    const { code } = await second.exited
    assert.equal(code, 0, 'the restart must shut down gracefully')
    assert.ok(second.stdout.includes('"status":"stale-lock-recovered"'), `the stale lock must be reported as recovered: ${second.stdout}`)
  } finally {
    second.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/T-EXIT graceful shutdown during a slow remote sync keeps committed data', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  // 8s remote latency: the sync pass is still running when the signal arrives, so
  // the drain budget genuinely has to be respected rather than bypassed.
  const stub = await startStub({ delayMs: 8000 })
  const spaceId = await firstSpaceId()
  const { root, configPath } = await makeDataRoot({ stubUrl: stub.url, spaceId })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // The second request to this path is the sync under test; the gate holds it in the handler and
  // the stub holds the remote call, so the sync is provably in flight across the signal.
  const gate = await armGate({ root, path: `/pkw/spaces/${spaceId}/api`, method: 'POST', holdCount: 2 })
  const boot = await bootAndLogin({ profile, configPath, port, drainTimeoutMs: 25_000, gate })
  try {
    const created = await boot.rpc('createNote', { relativePath: `sync-${randomUUID().slice(0, 8)}.md`, markdown: '# sync drain\n\nqueued\n' })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const noteId = created.body.value.noteId
    // Kick a real sync against the slow stub and do not await it: the signal must
    // arrive while the runtime still has work in flight.
    const syncing = boot.rpc('syncEntity', { entityType: 'note', entityId: noteId })
    const entered = await gate.entered()
    assert.ok(entered, 'the sync must be observed entering the listener')
    assert.equal(entered.ordinal, 2, `the watched request must be the sync: ${JSON.stringify(entered)}`)
    assert.equal(await gate.releasedCount(), 0, 'the sync must be unfinished when the signal arrives')
    const started = Date.now()
    boot.gateway.child.kill('SIGTERM')
    assert.equal(await gate.releasedCount(), 0, 'the sync must still be held after the signal, so the drain is real')
    await gate.release()
    const { code } = await boot.gateway.exited
    const elapsed = Date.now() - started
    assert.equal(code, 0, `expected graceful exit 0, got ${code}; stderr=${boot.gateway.stderr}`)
    assert.ok(elapsed <= 26_000, `shutdown must stay inside the drain budget (took ${elapsed}ms)`)
    assert.ok(boot.gateway.stdout.includes('"status":"graceful-shutdown"'), `missing graceful marker: ${boot.gateway.stdout}`)
    assert.ok(!boot.gateway.stderr.includes('"status":"forced-exit"'), 'a graceful stop must not report a forced exit')
    // The local commit is what must survive; the remote being slow is irrelevant.
    const store = new DatabaseSync(join(root, 'spaces', spaceId, 'state.sqlite'), { readOnly: true })
    let row, commits = 0
    try {
      row = store.prepare('SELECT value FROM u_pkw_notes_note_index WHERE key=?').get(noteId)
      commits = store.prepare('SELECT count(*) AS c FROM u_pkw_commits WHERE key LIKE ?').get(`%${noteId}%`).c
    } finally { store.close() }
    assert.ok(row, 'the note must still be indexed after shutdown during sync')
    assert.ok(commits > 0, 'the commit must be recorded even though the remote was slow')
    assert.ok(!existsSync(join(root, 'gateway.lock')), 'a graceful stop must release the data-root lock')
    console.log(`  slow-sync shutdown: ${elapsed}ms, commits=${commits}, remote calls=${stub.calls.length}`)
    await syncing.catch(() => undefined)
  } finally {
    boot.gateway.child.kill('SIGKILL')
    await stub.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('S3/lock an empty lock is undecided: the starter refuses with 4 and leaves it in place', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // An empty lockfile is what a writer leaves between creating the lock and writing its record. It
  // names no writer, so no writer was ruled out: the answer is *not knowledge*, and a starter that
  // read it as "free" would race the process that is in the middle of claiming the root. The
  // conservative answer is a refusal with its own exit code, and the file left exactly as found so a
  // human can see what was there.
  const lockPath = join(root, 'gateway.lock')
  await writeFile(lockPath, '', { mode: 0o600 })
  const gateway = startGateway({ profile, configPath, port })
  try {
    const { code } = await gateway.exited
    assert.equal(code, 4, `an empty lock must be refused as unreadable (UNREADABLE), not as anything else: stdout=${gateway.stdout} stderr=${gateway.stderr}`)
    assert.ok(gateway.stderr.includes('"status":"lock-refused"'), `the refusal must be reported: ${gateway.stderr}`)
    assert.ok(gateway.stderr.includes('"reason":"empty-lock"'), `the refusal must name the rule it hit: ${gateway.stderr}`)
    // Untouched: the file is evidence, and a starter that deleted it would destroy the only record
    // of the window it was in.
    assert.equal(await readFile(lockPath, 'utf8'), '', 'the lock must be left exactly as it was found')
    // And nothing was started: no second writer, and the port was never bound.
    const heldAfterRefusal = await portHolder(port)
    assert.equal(heldAfterRefusal.known, true, `the port probe must answer: ${JSON.stringify(heldAfterRefusal)}`)
    assert.equal(heldAfterRefusal.held, false, 'a refused starter must not leave a listener behind')
    assert.ok(!gateway.stdout.includes('"status":"listening"'), `a refused starter must never report listening: ${gateway.stdout}`)
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/lock a lock that names no writer is undecided: the starter refuses with 4', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // Valid JSON, no pid: the record cannot say who holds the root, so nobody was ruled out.
  const lockPath = join(root, 'gateway.lock')
  const ownerless = JSON.stringify({ note: 'no pid here', createdAt: new Date().toISOString() }) + '\n'
  await writeFile(lockPath, ownerless, { mode: 0o600 })
  const gateway = startGateway({ profile, configPath, port })
  try {
    const { code } = await gateway.exited
    assert.equal(code, 4, `a lock naming no writer must be refused as unreadable: stdout=${gateway.stdout} stderr=${gateway.stderr}`)
    assert.ok(gateway.stderr.includes('"reason":"lock-without-owner"'), `the refusal must name the rule it hit: ${gateway.stderr}`)
    assert.equal(await readFile(lockPath, 'utf8'), ownerless, 'the lock must be left as evidence')
    const held = await portHolder(port)
    assert.equal(held.held, false, 'a refused starter must not leave a listener behind')
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/lock a malformed lock is undecided: the starter refuses with 4 and does not race it', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  const lockPath = join(root, 'gateway.lock')
  const garbage = 'this is not a lock record\n'
  await writeFile(lockPath, garbage, { mode: 0o600 })
  const gateway = startGateway({ profile, configPath, port })
  try {
    const { code } = await gateway.exited
    assert.equal(code, 4, `a malformed lock must be refused as unreadable: stdout=${gateway.stdout} stderr=${gateway.stderr}`)
    assert.ok(gateway.stderr.includes('malformed-lock'), `the refusal must name the rule it hit: ${gateway.stderr}`)
    assert.equal(await readFile(lockPath, 'utf8'), garbage, 'the malformed lock must be left as evidence')
    const heldAfterRefusal = await portHolder(port)
    assert.equal(heldAfterRefusal.known, true, `the port probe must answer: ${JSON.stringify(heldAfterRefusal)}`)
    assert.equal(heldAfterRefusal.held, false, 'a refused starter must not leave a listener behind')
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/lock a stale lock from a dead writer is recovered automatically', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // A lock whose writer is provably gone: start a throwaway process, let it exit,
  // and record its pid. Nothing else is done on the product's behalf.
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const deadPid = dead.pid
  await new Promise(r => dead.once('exit', r))
  const lockPath = join(root, 'gateway.lock')
  await writeFile(lockPath, JSON.stringify({ pid: deadPid, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
  const gateway = startGateway({ profile, configPath, port })
  try {
    await gateway.ready()
    assert.ok(gateway.stdout.includes('"status":"stale-lock-recovered"'), `expected recovery report: ${gateway.stdout}`)
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, gateway.child.pid, 'the lock must now belong to the new process')
    gateway.child.kill('SIGTERM')
    assert.equal((await gateway.exited).code, 0)
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/lock a lock held by a live writer is refused, not stolen', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  const lockPath = join(root, 'gateway.lock')
  // A live process (this test) with a matching start time is a live writer.
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
  const gateway = startGateway({ profile, configPath, port })
  try {
    const { code } = await gateway.exited
    assert.equal(code, 3, `a live writer must be refused with exit 3, got ${code}; stderr=${gateway.stderr}`)
    assert.ok(gateway.stderr.includes('"reason":"live-writer"'), `expected a live-writer refusal: ${gateway.stderr}`)
    const still = JSON.parse(await readFile(lockPath, 'utf8'))
    assert.equal(still.pid, process.pid, 'the live writer must keep its lock')
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/lock a malformed lock is refused rather than deleted', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  const lockPath = join(root, 'gateway.lock')
  await writeFile(lockPath, 'not-json-at-all\n', { mode: 0o600 })
  const gateway = startGateway({ profile, configPath, port })
  try {
    const { code } = await gateway.exited
    assert.equal(code, 4, `an uninterpretable lock must be refused with exit 4, got ${code}`)
    assert.ok(existsSync(lockPath), 'an uninterpretable lock must be left in place as evidence')
  } finally {
    gateway.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

test('S3/lock two concurrent starters against one root leave exactly one writer', { skip: skipReason || !dataRootAvailable }, async () => {
  const profile = profileUnderTest()
  const port = await freePort()
  const { root, configPath } = await makeDataRoot({ stubUrl: null, spaceId: 'sp-none' })
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.publicOrigin = `http://127.0.0.1:${port}`
  await writeFile(configPath, JSON.stringify(config, null, 2))
  // Two processes, same root, same port: exactly one may end up owning the root.
  const a = startGateway({ profile, configPath, port })
  const b = startGateway({ profile, configPath, port })
  try {
    // The winner never exits, so waiting on both would wait forever: each race has a *bound* that
    // only a process that is still serving can reach. The loser refuses on its own — that is what is
    // being measured — so the bound is generous and says nothing about how long the refusal took.
    const results = await Promise.all([
      Promise.race([a.exited, new Promise(r => setTimeout(() => r({ code: 'running' }), 20_000))]),
      Promise.race([b.exited, new Promise(r => setTimeout(() => r({ code: 'running' }), 20_000))]),
    ])
    const running = results.filter(r => r.code === 'running').length
    const refused = results.filter(r => r.code === 3).length
    assert.equal(running, 1, `exactly one starter may run: ${JSON.stringify(results)}`)
    assert.ok(refused >= 1, `the other starter must be refused: ${JSON.stringify(results)}`)
    const lock = JSON.parse(await readFile(join(root, 'gateway.lock'), 'utf8'))
    assert.ok([a.child.pid, b.child.pid].includes(lock.pid), 'the lock must belong to the surviving starter')
    const winner = results[0].code === 'running' ? a : b
    winner.child.kill('SIGTERM')
    assert.equal((await winner.exited).code, 0, 'the winner must shut down gracefully')
    // The refusal code itself is recorded, not only that a refusal happened: these two errors mean
    // different things (a live writer versus an unreadable lockfile), and a run that cannot say which
    // one it got cannot say what was proved.
    const refusalCodes = results.filter(r => r.code !== 'running').map(r => r.code)
    console.log(`  concurrent starters: running=${running}, refused=${refused}, codes=${JSON.stringify(refusalCodes)}`)
  } finally {
    a.child.kill('SIGKILL')
    b.child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
})

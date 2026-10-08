#!/usr/bin/env node
/**
 * Minimal reproduction for the two lifecycle behaviours under investigation.
 *
 * It is deliberately outside the test suite: it is an experiment, and its job is to produce
 * evidence, not a pass.
 *
 *   A: a request parked across SIGTERM loses its response (ECONNRESET / other-side-closed).
 *   B: after a graceful shutdown that drained an in-flight write, a restarted process sometimes
 *      answers `getNote` with a 400 PKW_REQUEST_FAILED.
 *
 * Every stage is logged, so the run says which of these happened:
 *
 *   accepted        the listener took the connection and dispatched the request
 *   write-entered   the test's gate saw the request inside the handler
 *   committed       the response body says the write was committed (HTTP 200 + revision)
 *   response-ended  the client received the response, by status or by transport failure
 *   stopped         the listener exited, with code or signal
 *   restart-read    what a fresh process answered for the same note
 *
 * Usage: node repro.mjs [--target DIR] [--port N] [--hold-ms N] [--mode parked|observed|baseline]
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { randomBytes, randomUUID, scrypt } from 'node:crypto'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

const scryptAsync = promisify(scrypt)
const { values } = parseArgs({ options: {
  target: { type: 'string' }, port: { type: 'string' }, 'hold-ms': { type: 'string' },
  mode: { type: 'string', default: 'parked' }, fixture: { type: 'string' }, profile: { type: 'string' },
  keep: { type: 'boolean', default: false }, log: { type: 'string' },
  'stub-delay': { type: 'string', default: '0' },
} })

const repo = '/LlHmm9527/pkw-independent/repo'
const profile = values.profile ?? '/LlHmm9527/pkw-independent/profile'
const fixture = values.fixture ?? '/LlHmm9527/pkw-independent/fixtures/lifecycle-1'
const port = Number(values.port ?? 43111)
const holdMs = Number(values['hold-ms'] ?? 250)
const mode = values.mode
const workDir = values.target ?? await mkdtemp(join(tmpdir(), 'pkw-repro-'))
const logPath = values.log ?? join(workDir, 'repro.log')
const stages = []
const stage = (name, detail = {}) => {
  const entry = { at: new Date().toISOString(), stage: name, ...detail }
  stages.push(entry)
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
  console.log(`[${entry.at}] ${name} ${JSON.stringify(detail)}`)
}

const { copyDataRoot } = await import(join(repo, 'scripts/copy-data-root.mjs'))
const dataRoot = join(workDir, 'data')
await mkdir(workDir, { recursive: true, mode: 0o700 })
if (!existsSync(join(dataRoot, 'identity.sqlite'))) {
  const copy = await copyDataRoot(fixture, dataRoot)
  stage('copy', { target: copy.targetRoot, databases: copy.databases.length, rewritten: copy.rewritten.length })
}
// The test password is ours; the fixture's own is replaced here, exactly as the suite does.
const PASSWORD = 'repro-passphrase-only'
const identityPath = join(dataRoot, 'identity.sqlite')
{
  const salt = randomBytes(16).toString('hex')
  const derived = await scryptAsync(PASSWORD, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  const db = new DatabaseSync(identityPath)
  db.prepare('UPDATE accounts SET password=? WHERE username=?').run(`scrypt-v1:${salt}:${derived.toString('hex')}`, 'owner')
  db.close()
}
// A loopback retrieval stub whose latency is chosen by the run: a slow remote is what makes a
// commit and a shutdown overlap in production, so the experiment has to be able to produce it.
const stubDelay = Number(values['stub-delay'] ?? 0)
const stubCalls = []
const { createServer } = await import('node:http')
const stub = createServer((req, res) => {
  stubCalls.push({ method: req.method, url: req.url, at: new Date().toISOString() })
  setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') }, stubDelay)
})
await new Promise(resolvePromise => stub.listen(0, '127.0.0.1', resolvePromise))
const stubUrl = `http://127.0.0.1:${stub.address().port}`

const configPath = join(dataRoot, 'collaboration.json')
{
  const db = new DatabaseSync(identityPath, { readOnly: true })
  var spaceId = db.prepare('SELECT id FROM spaces LIMIT 1').get().id
  db.close()
}
await writeFile(configPath, JSON.stringify({
  dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PW',
  ...(stubDelay > 0 ? { retrieval: { [spaceId]: { baseUrl: stubUrl, kbId: 'kb-repro', apiKeyEnv: 'PKW_TEST_WEKNORA_KEY' } } } : {}),
}, null, 2), { mode: 0o600 })

// ── the observation gate: test-only, path+method+ordinal, holds for `holdMs` ────────
const gateLog = join(workDir, 'gate.log')
const gateConfig = join(workDir, 'gate.json')
await writeFile(gateConfig, JSON.stringify({
  path: `/pkw/spaces/${spaceId}/api`, method: 'POST', holdCount: 5, holdMs, log: gateLog, release: join(workDir, 'gate.release'),
}), { mode: 0o600 })
await writeFile(join(workDir, 'gate.release'), 'go\n', { mode: 0o600 })

function startListener(extraEnv = {}) {
  const child = spawn(process.execPath, [join(repo, 'scripts/serve-collaboration.mjs'), '--profile', profile, '--config', configPath, '--port', String(port)], {
    env: { ...process.env, PW: PASSWORD, PKW_TEST_WEKNORA_KEY: 'stub-key', PKW_TEST_GATE_FILE: gateConfig, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise(resolvePromise => child.once('exit', (code, signal) => resolvePromise({ code, signal })))
  return { child, exited, get stdout() { return stdout }, get stderr() { return stderr } }
}
const waitListening = async listener => {
  for (let i = 0; i < 200; i += 1) {
    if (listener.stdout.includes('"status":"listening"')) return true
    if (listener.child.exitCode !== null) return false
    await new Promise(r => setTimeout(r, 50))
  }
  return false
}

const jar = new Map()
const origin = `http://127.0.0.1:${port}`
const call = async (path, { method = 'GET', body, csrf } = {}) => {
  const headers = { Origin: origin }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (csrf) headers['X-PKW-CSRF'] = csrf
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  try {
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';'); const at = pair.indexOf('=')
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const text = await response.text()
    let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed }
  } catch (error) {
    return { status: 0, transport: error.message, cause: error.cause?.message ?? null }
  }
}

const listener = startListener()
if (!(await waitListening(listener))) {
  stage('listener-failed', { stderr: listener.stderr.slice(-300) })
  process.exit(1)
}
stage('listening', { port })

const login = await call('/pkw/login', { method: 'POST', body: { username: 'owner', password: PASSWORD } })
stage('login', { status: login.status })
const session = await call('/pkw/session')
const csrf = session.body?.value?.csrf
stage('session', { status: session.status, csrf: Boolean(csrf) })
const rpc = (method, args) => call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method, args }, csrf })

// ── the pre-existing committed write (the control) ─────────────────────────────────
const marker = `control-${randomUUID().slice(0, 8)}`
const created = await rpc('createNote', { relativePath: `repro-${randomUUID().slice(0, 8)}.md`, markdown: '# repro\n\nfirst\n' })
stage('createNote', { status: created.status })
const noteId = created.body?.value?.noteId
const read = await rpc('getNote', { noteId })
stage('getNote', { status: read.status, revision: read.body?.value?.note?.observedRevision })
const controlSave = await rpc('saveNoteBody', {
  noteId, body: `# repro\n\n${marker}\n`,
  expectedContentHash: read.body.value.note.contentHash, expectedRevision: read.body.value.note.observedRevision,
})
stage('control-save', { status: controlSave.status, committed: controlSave.status === 200, revision: controlSave.body?.value?.observedRevision, body: controlSave.status === 200 ? null : controlSave.body })

// ── the in-flight write ────────────────────────────────────────────────────────────
const current = await rpc('getNote', { noteId })
stage('getNote-before-flight', { status: current.status, revision: current.body?.value?.note?.observedRevision })
const inFlightMarker = `inflight-${randomUUID().slice(0, 8)}`
const inFlight = rpc('saveNoteBody', {
  noteId, body: `# repro\n\n${marker}\n${inFlightMarker}\n`,
  expectedContentHash: current.body.value.note.contentHash, expectedRevision: current.body.value.note.observedRevision,
})
let settled = false
void inFlight.then(() => { settled = true }, () => { settled = true })
for (let i = 0; i < 600 && !existsSync(gateLog); i += 1) await new Promise(r => setTimeout(r, 5))
const gateEntries = existsSync(gateLog) ? readFileSync(gateLog, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
stage('write-entered', { gate: gateEntries.map(e => ({ event: e.event, ordinal: e.ordinal })), settled })
const started = Date.now()
listener.child.kill('SIGTERM')
stage('signal', { settled })
const inFlightResult = await inFlight
stage('response-ended', {
  status: inFlightResult.status, transport: inFlightResult.transport ?? null, cause: inFlightResult.cause ?? null,
  committed: inFlightResult.status === 200, elapsedMs: Date.now() - started,
  body: inFlightResult.status === 200 ? null : inFlightResult.body,
})
const stopped = await listener.exited
stage('stopped', { code: stopped.code, signal: stopped.signal, elapsedMs: Date.now() - started, graceful: listener.stdout.includes('"status":"graceful-shutdown"'), forced: listener.stderr.includes('"status":"forced-exit"') })

// ── what is on disk, and what a fresh process answers ──────────────────────────────
const storePath = join(dataRoot, 'spaces', spaceId, 'state.sqlite')
const indexed = (() => {
  const db = new DatabaseSync(storePath, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM u_pkw_notes_note_index WHERE key=?').get(noteId)
    return row ? JSON.parse(row.value) : null
  } finally { db.close() }
})()
stage('indexed', { revision: indexed?.observedRevision ?? null, hash: indexed?.contentHash?.slice(0, 12) ?? null })
const spaceDir = join(dataRoot, 'spaces', spaceId, 'workspace', 'notes')
const noteFiles = existsSync(spaceDir) ? readFileSync('/dev/null') : null
void noteFiles

const second = startListener()
if (!(await waitListening(second))) {
  stage('restart-failed', { stderr: second.stderr.slice(-300) })
} else {
  const login2 = await call('/pkw/login', { method: 'POST', body: { username: 'owner', password: PASSWORD } })
  const session2 = await call('/pkw/session')
  const csrf2 = session2.body?.value?.csrf
  const reloaded = await call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method: 'getNote', args: { noteId } }, csrf: csrf2 })
  if (reloaded.status !== 200) {
    stage('restart-read-failed', { listenerStderr: second.stderr.slice(-1500), listenerStdout: second.stdout.slice(-400).replace(/\n/g, ' ') })
  }
  stage('restart-read', {
    login: login2.status, status: reloaded.status, code: reloaded.body?.code ?? null,
    revision: reloaded.body?.value?.note?.observedRevision ?? null,
    hasControl: JSON.stringify(reloaded.body ?? '').includes(marker),
    hasInFlight: JSON.stringify(reloaded.body ?? '').includes(inFlightMarker),
  })
  second.child.kill('SIGTERM')
  stage('restart-stopped', await second.exited)
}
second.child.kill('SIGKILL')

stage('stub', { delayMs: stubDelay, calls: stubCalls.length })
await new Promise(resolvePromise => stub.close(resolvePromise))
writeFileSync(join(workDir, 'stages.json'), JSON.stringify(stages, null, 2))
console.log(`\nstages: ${join(workDir, 'stages.json')}`)
if (!values.keep) await rm(workDir, { recursive: true, force: true })

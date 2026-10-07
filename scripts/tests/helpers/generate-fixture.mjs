#!/usr/bin/env node
/**
 * Generate a test data root with the product's own API.
 *
 * A hand-written fixture cannot be trusted: the runtime validates its own storage, so a
 * fixture built by inserting rows is a fixture that may not describe what the product
 * actually writes. This starts the real listener against an empty directory, creates the
 * owner through the product's bootstrap, logs in, creates a note and an attachment through
 * the real RPC surface, stops the listener and leaves the directory as the fixture.
 *
 * Usage: node generate-fixture.mjs --target DIR --profile DIR --port N
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, lstat, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { trackLifetime, describeOutcome } from './child-lifetime.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const { values } = parseArgs({ options: {
  target: { type: 'string' }, profile: { type: 'string' }, port: { type: 'string' },
  password: { type: 'string' }, username: { type: 'string' }, 'note-body': { type: 'string' },
  'remove-on-failure': { type: 'boolean', default: false },
} })
if (!values.target || !values.profile || !values.port) {
  process.stderr.write('Usage: node generate-fixture.mjs --target DIR --profile DIR --port N [--password P] [--username U]\n')
  process.exit(2)
}
const target = resolve(values.target)
let createdTarget = false
const password = values.password ?? 'fixture-password'
const username = values.username ?? 'owner'
const port = Number(values.port)
// The generator owns the directory it writes, so it will only use one that does not exist
// yet and is not a symlink. An existing directory may hold someone's data, and the previous
// version deleted the whole thing on failure if it lacked identity.sqlite.
const existing = await lstat(target).catch(() => null)
if (existing) {
  console.error(JSON.stringify({
    error: 'refusing to generate into an existing path',
    target,
    kind: existing.isSymbolicLink() ? 'symlink' : existing.isDirectory() ? 'directory' : 'file',
    hint: 'the generator creates its own directory; pass a path that does not exist yet',
  }, null, 2))
  process.exit(3)
}
await mkdir(target, { recursive: true, mode: 0o700 })
createdTarget = true
const configPath = join(await mkdtemp(join(tmpdir(), 'fixture-cfg-')), 'collaboration.json')
await writeFile(configPath, JSON.stringify({
  dataPath: target, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: username, bootstrapPasswordEnv: 'PKW_FIXTURE_BOOTSTRAP',
}, null, 2) + '\n', { mode: 0o600 })

const child = spawn(process.execPath, [
  join(repoRoot, 'scripts/serve-collaboration.mjs'), '--profile', resolve(values.profile),
  '--config', configPath, '--port', String(port),
], { env: { ...process.env, PKW_FIXTURE_BOOTSTRAP: password }, stdio: ['ignore', 'pipe', 'pipe'] })
const lifetime = trackLifetime(child)
const log = lifetime.log

const stop = async () => {
  if (lifetime.settled) return lifetime.outcome
  child.kill('SIGTERM')
  // Wait for the exit event that was registered when the child was spawned, rather than polling
  // `exitCode` and racing a listener that may already have fired. A timeout here is not an answer:
  // it means the child ignored SIGTERM, so it is killed and the same promise is awaited again.
  let outcome = await lifetime.race(12000)
  if (outcome === null) {
    child.kill('SIGKILL')
    outcome = await lifetime.race(10000)
  }
  if (outcome === null) {
    // The child could not be observed to exit. Reporting "generated" here would leave a second
    // writer on the fixture, so this is a failure of the run, not a detail.
    const stuck = new Error('the listener did not exit after SIGTERM and SIGKILL')
    stuck.code = 'PKW_FIXTURE_LISTENER_STUCK'
    throw stuck
  }
  return outcome
}

const jar = new Map()
const origin = `http://127.0.0.1:${port}`
let csrf = null
const call = async (path, { method = 'GET', body, raw } = {}) => {
  const headers = { Origin: origin }
  if (body && !raw) headers['Content-Type'] = 'application/json'
  if (csrf) headers['X-PKW-CSRF'] = csrf
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'manual' })
  for (const rawCookie of response.headers.getSetCookie?.() ?? []) {
    const [pair] = rawCookie.split(';'); const at = pair.indexOf('=')
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
  }
  const text = await response.text()
  let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed, headers: response.headers }
}

try {
  // Readiness must be evidence that *this* child bound the port: its own startup line,
  // followed by a health answer. A health answer alone could come from a service that was
  // already listening, and logging in to that would write to the wrong data root.
  let listening = false
  let healthOk = false
  for (let i = 0; i < 150; i++) {
    if (lifetime.settled) {
      throw new Error(`the listener ${describeOutcome(lifetime.outcome)} before binding the port: ${log.slice(-400)}`)
    }
    if (!listening && log.includes('"status":"listening"')) listening = true
    if (listening && !healthOk) {
      try { healthOk = (await call('/healthz')).status === 200 } catch { healthOk = false }
    }
    if (listening && healthOk) break
    await new Promise(r => setTimeout(r, 200))
  }
  if (!listening) throw new Error(`this process never reported listening (the port may be held by another service): ${log.slice(-400)}`)
  if (!healthOk) throw new Error(`this process reported listening but is not answering health checks: ${log.slice(-400)}`)

  const login = await call('/pkw/login', { method: 'POST', body: { username, password } })
  if (login.status !== 200) throw new Error(`fixture login failed (${login.status}): ${JSON.stringify(login.body).slice(0, 200)}`)
  const session = await call('/pkw/session')
  const value = session.body?.value
  if (!value?.csrf) throw new Error(`fixture session exposes no CSRF: ${JSON.stringify(session.body).slice(0, 200)}`)
  csrf = value.csrf
  const space = (value.spaces ?? []).find(s => s.kind === 'private') ?? (value.spaces ?? [])[0]
  if (!space) throw new Error('fixture session exposes no space')

  const body = values['note-body'] ?? '# fixture note\n\ncreated through the product API\n'
  const created = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: { method: 'createNote', args: { relativePath: 'fixture/note.md', markdown: body } } })
  if (created.status !== 200 || !created.body?.value?.noteId) throw new Error(`fixture createNote failed (${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`)

  // The attachment goes through the same JSON RPC method the UI uses.
  const bytes = Buffer.from('fixture attachment payload\n')
  const uploaded = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: {
    method: 'uploadAttachment',
    args: { relativePath: 'fixture/attachment.bin', contentBase64: bytes.toString('base64') },
  } })
  if (uploaded.status !== 200) throw new Error(`fixture uploadAttachment failed (${uploaded.status}): ${JSON.stringify(uploaded.body).slice(0, 300)}`)

  await call('/pkw/manage', { method: 'POST', body: { action: 'logout' } })
  const stopped = await stop()
  console.log(JSON.stringify({
    stopped,
    target, spaceId: space.id, noteId: created.body.value.noteId,
    attachment: uploaded.body?.value ?? null, noteBody: body, attachmentBytes: bytes.length,
  }, null, 2))
} catch (error) {
  // A stop failure must not replace the error that caused it: the original reason is what the
  // caller needs, and the stop outcome is reported beside it.
  let stopped = null
  let stopError = null
  try { stopped = await stop() } catch (failure) { stopError = { message: failure.message, code: failure.code ?? null } }
  // The scene is preserved: only a directory this run created is removed, and even then
  // only when asked, so a failure can be inspected.
  console.error(JSON.stringify({
    error: error.message, stopped, stopError, target, createdTarget,
    preserved: true, log: log.slice(-400),
  }, null, 2))
  if (values['remove-on-failure'] && createdTarget) await rm(target, { recursive: true, force: true })
  process.exit(1)
}

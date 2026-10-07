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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const { values } = parseArgs({ options: {
  target: { type: 'string' }, profile: { type: 'string' }, port: { type: 'string' },
  password: { type: 'string' }, username: { type: 'string' }, 'note-body': { type: 'string' },
} })
if (!values.target || !values.profile || !values.port) {
  process.stderr.write('Usage: node generate-fixture.mjs --target DIR --profile DIR --port N [--password P] [--username U]\n')
  process.exit(2)
}
const target = resolve(values.target)
const password = values.password ?? 'fixture-password'
const username = values.username ?? 'owner'
const port = Number(values.port)
if (existsSync(join(target, 'identity.sqlite'))) {
  console.error(`${target} already contains data; refusing to overwrite a fixture`)
  process.exit(3)
}
await mkdir(target, { recursive: true, mode: 0o700 })
const configPath = join(await mkdtemp(join(tmpdir(), 'fixture-cfg-')), 'collaboration.json')
await writeFile(configPath, JSON.stringify({
  dataPath: target, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: username, bootstrapPasswordEnv: 'PKW_FIXTURE_BOOTSTRAP',
}, null, 2) + '\n', { mode: 0o600 })

const child = spawn(process.execPath, [
  join(repoRoot, 'scripts/serve-collaboration.mjs'), '--profile', resolve(values.profile),
  '--config', configPath, '--port', String(port),
], { env: { ...process.env, PKW_FIXTURE_BOOTSTRAP: password }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', c => { log += c })
child.stderr.on('data', c => { log += c })

const stop = async () => {
  child.kill('SIGTERM')
  for (let i = 0; i < 80; i++) { if (child.exitCode !== null) return; await new Promise(r => setTimeout(r, 100)) }
  child.kill('SIGKILL')
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
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { if ((await call('/healthz')).status === 200) { ready = true; break } } catch { /* not up yet */ }
    if (child.exitCode !== null) break
    await new Promise(r => setTimeout(r, 200))
  }
  if (!ready) throw new Error(`the listener did not become ready: ${log.slice(-400)}`)

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
  await stop()
  console.log(JSON.stringify({
    target, spaceId: space.id, noteId: created.body.value.noteId,
    attachment: uploaded.body?.value ?? null, noteBody: body, attachmentBytes: bytes.length,
  }, null, 2))
} catch (error) {
  await stop()
  console.error(JSON.stringify({ error: error.message, log: log.slice(-400) }, null, 2))
  await rm(target, { recursive: true, force: true })
  process.exit(1)
}

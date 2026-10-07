/**
 * Deployment-gate tests: an enforcing verifier must fail, and a diagnostics run must
 * never be able to pass itself off as verification.
 *
 * A synthetic HTTP surface stands in for a real service so each refusal can be
 * produced deliberately: no credentials, a refused login, a wrong serving version,
 * and a healthy-looking service whose version header disagrees with what is installed.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { makeSyntheticProfile } from './helpers/synthetic.mjs'

const run = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const verifier = join(repoRoot, 'deploy/site/verify-collaboration.mjs')
const VERSION = '0.1.8-pkw.9'

/** A synthetic collaboration surface with switchable behaviour. */
async function startSurface({ servingVersion = VERSION, acceptLogin = true, noteReadable = true } = {}) {
  const origin = { url: '' }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://local')
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
    if (url.pathname === '/legacy-pkw' || (url.pathname === '/pkw' && req.method === 'GET' && !acceptLogin && servingVersion === 'legacy')) {
      res.writeHead(404); res.end('gone'); return
    }
    if (url.pathname === '/dsh/pkw') { res.writeHead(404); res.end('gone'); return }
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ready":true}'); return }
    if (url.pathname === '/pkw' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>PKW · 我的空间</title>'); return
    }
    // Anonymous surfaces refuse only when no session cookie is presented, exactly as
    // the product's gateway behaves.
    const authenticated = Boolean(req.headers.cookie)
    if (!authenticated && url.pathname === '/pkw/session' && req.method === 'GET') { send(401, { ok: false, code: 'PKW_AUTH_REQUIRED' }); return }
    if (!authenticated && url.pathname === '/pkw/api' && req.method === 'POST') { send(401, { ok: false, code: 'PKW_AUTH_REQUIRED' }); return }
    if (url.pathname === '/pkw/login' && req.method === 'POST') {
      if (!acceptLogin) { send(401, { ok: false, error: '账号或密码不正确' }); return }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'pkw_session=synthetic; Path=/pkw' }); res.end(JSON.stringify({ ok: true })); return
    }
    if (url.pathname === '/pkw/session') {
      send(200, { ok: true, value: { csrf: 'synthetic-csrf', spaces: [{ id: 'sp_' + 'a'.repeat(32), kind: 'private', role: 'owner' }] } }); return
    }
    const spaceMatch = /^\/pkw\/spaces\/(sp_[a-f0-9]{32})$/.exec(url.pathname)
    if (spaceMatch) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'x-pkw-version': servingVersion }); res.end('<html>space</html>'); return
    }
    if (/^\/pkw\/spaces\/.+\/api$/.test(url.pathname)) {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        if (parsed.method === 'summary') { send(200, { ok: true, value: { notes: 1, attachments: 1, mappings: 0 } }); return }
        if (parsed.method === 'listNotes') { send(200, { ok: true, value: [{ noteId: 'note_synthetic' }] }); return }
        if (parsed.method === 'getNote') {
          if (!noteReadable) { send(500, { ok: false, error: 'unreadable' }); return }
          send(200, { ok: true, value: { note: { contentHash: 'deadbeef' } } }); return
        }
        send(200, { ok: true, value: {} })
      })
      return
    }
    if (url.pathname === '/pkw/manage') { send(200, { ok: true, value: {} }); return }
    res.writeHead(404); res.end('not found')
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  origin.url = `http://127.0.0.1:${server.address().port}`
  origin.close = () => new Promise(ok => server.close(ok))
  return origin
}

async function callVerifier(args) {
  try {
    const { stdout } = await run(process.execPath, [verifier, ...args], { encoding: 'utf8' })
    return { code: 0, report: JSON.parse(stdout.trim().split('\n').filter(Boolean).slice(-1)[0]) }
  } catch (error) {
    const line = (error.stdout ?? '').trim().split('\n').filter(Boolean).slice(-1)[0]
    let report = null
    try { report = JSON.parse(line) } catch { report = null }
    return { code: error.code ?? 1, report, stderr: error.stderr }
  }
}

async function fixtures({ servingVersion = VERSION, acceptLogin = true, noteReadable = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pkw-verify-'))
  const profile = join(root, 'profile')
  await makeSyntheticProfile({ version: VERSION, root: profile })
  const credentialFile = join(root, 'owner-password')
  await writeFile(credentialFile, 'synthetic-password\n', { mode: 0o600 })
  const surface = await startSurface({ servingVersion, acceptLogin, noteReadable })
  return { root, profile, credentialFile, surface, cleanup: async () => { await surface.close(); await rm(root, { recursive: true, force: true }) } }
}

test('gate: enforcing mode fails without a credential file', async () => {
  const f = await fixtures()
  try {
    const { code, report } = await callVerifier(['--mode', 'activate', '--profile', f.profile, '--public-origin', f.surface.url, '--gateway-url', f.surface.url, '--version', VERSION])
    assert.notEqual(code, 0, 'a missing credential file must fail an enforcement run')
    assert.equal(report.ok, false)
    assert.match(String(report.error), /credential/)
  } finally { await f.cleanup() }
})

test('gate: enforcing mode fails when the login is refused', async () => {
  const f = await fixtures({ acceptLogin: false })
  try {
    const { code, report } = await callVerifier(['--mode', 'activate', '--profile', f.profile, '--public-origin', f.surface.url, '--gateway-url', f.surface.url, '--version', VERSION, '--credentials-file', f.credentialFile])
    assert.notEqual(code, 0, 'a refused login must fail an enforcement run')
    assert.equal(report.checks.authenticated, 'failed_credentials_rejected')
  } finally { await f.cleanup() }
})

test('gate: enforcing mode fails when the serving version is not the expected one', async () => {
  const f = await fixtures({ servingVersion: '0.1.2-pkw.4' })
  try {
    const { code, report } = await callVerifier(['--mode', 'rollback', '--profile', f.profile, '--public-origin', f.surface.url, '--gateway-url', f.surface.url, '--version', VERSION, '--credentials-file', f.credentialFile])
    assert.notEqual(code, 0, 'a version mismatch must fail even though the service is healthy')
    assert.match(String(report.error), /running 0\.1\.2-pkw\.4/)
  } finally { await f.cleanup() }
})

test('gate: enforcing mode passes only with credentials, login, version and a readable note', async () => {
  const f = await fixtures()
  try {
    const { code, report } = await callVerifier(['--mode', 'activate', '--profile', f.profile, '--public-origin', f.surface.url, '--gateway-url', f.surface.url, '--version', VERSION, '--credentials-file', f.credentialFile])
    assert.equal(code, 0, `expected acceptance: ${JSON.stringify(report)}`)
    assert.equal(report.ok, true)
    assert.equal(report.checks.authenticated, 'verified')
    assert.equal(report.checks.servingVersion, VERSION)
    assert.equal(report.checks.noteReadable, true)
  } finally { await f.cleanup() }
})

test('gate: enforcing mode fails when a listed note cannot be read back', async () => {
  const f = await fixtures({ noteReadable: false })
  try {
    const { code, report } = await callVerifier(['--mode', 'activate', '--profile', f.profile, '--public-origin', f.surface.url, '--gateway-url', f.surface.url, '--version', VERSION, '--credentials-file', f.credentialFile])
    assert.notEqual(code, 0, 'a count without a readable note is not acceptance')
    assert.match(String(report.error), /could not be read/)
  } finally { await f.cleanup() }
})

test('gate: diagnostics mode reports observations without claiming verification', async () => {
  const f = await fixtures()
  try {
    const { code, report } = await callVerifier(['--mode', 'activate', '--diagnostics', '--profile', f.profile, '--public-origin', f.surface.url, '--gateway-url', f.surface.url, '--version', VERSION])
    assert.equal(code, 0, 'diagnostics must not fail the run; it also must not gate it')
    assert.equal(report.enforcing, false)
    assert.equal(report.checks.authenticated, 'not_verified_no_credentials')
    assert.match(String(report.note), /NOT verified/)
  } finally { await f.cleanup() }
})

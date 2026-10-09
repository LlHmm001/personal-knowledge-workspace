import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLegacyCompatClient } from '../../deploy/site/legacy-compat-client.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const spaceId = `sp_${'a'.repeat(32)}`
const password = 'private-password-MUST-NOT-BE-REPORTED'
const csrf = 'private-csrf-MUST-NOT-BE-REPORTED'
const cookie = 'private-cookie-MUST-NOT-BE-REPORTED'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-legacy-api-test-')))
  const dataRoot = join(root, 'synthetic-data')
  await mkdir(dataRoot)
  const notes = new Map()
  const attachments = new Map()
  const calls = []
  const state = { version: '0.1.2-pkw.4', failMethod: null, bodyDrift: false, downloadDrift: false, hang: false, overLimit: false, username: 'owner' }
  const send = (response, value, status = 200, headers = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers })
    response.end(JSON.stringify(value))
  }
  const noteFile = note => join(dataRoot, 'spaces', spaceId, 'workspace', 'notes', note.relativePath)
  const materialize = async note => {
    const filename = noteFile(note)
    await mkdir(join(filename, '..'), { recursive: true })
    const text = `---\nid: ${note.id}\n---\n${note.body}`
    await writeFile(filename, text, { mode: 0o600 })
    note.contentHash = hash(text)
  }
  const server = createServer(async (request, response) => {
    try {
      const buffers = []
      for await (const chunk of request) buffers.push(chunk)
      const raw = Buffer.concat(buffers).toString()
      const payload = raw ? JSON.parse(raw) : null
      calls.push({ path: request.url, headers: request.headers, payload })
      if (request.url === '/pkw/login') {
        assert.equal(payload.username, 'owner')
        assert.equal(payload.password, password)
        return send(response, { ok: true, value: { loggedIn: true } }, 200, { 'set-cookie': `pkw=${cookie}; Path=/; HttpOnly` })
      }
      assert.equal(request.headers.cookie, `pkw=${cookie}`)
      if (request.url === '/pkw/session') return send(response, { ok: true, value: { username: state.username, csrf, spaces: [{ id: spaceId, kind: 'private', role: 'owner' }] } })
      if (request.url === `/pkw/spaces/${spaceId}`) {
        response.writeHead(200, { 'x-pkw-version': state.version, 'content-type': 'text/html' })
        return response.end('<html>synthetic private workspace</html>')
      }
      if (request.url.startsWith(`/pkw/spaces/${spaceId}/attachment/`)) {
        const id = request.url.split('/').at(-1)
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        return response.end(state.downloadDrift ? Buffer.from('wrong bytes') : attachments.get(id).bytes)
      }
      assert.equal(request.url, `/pkw/spaces/${spaceId}/api`)
      assert.equal(request.headers['x-pkw-csrf'], csrf)
      const { method, args } = payload
      if (state.failMethod === method) return send(response, { error: `${password} ${csrf} ${cookie}` }, 400)
      if (state.hang) return undefined
      if (state.overLimit) {
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end('a'.repeat(2 * 1024 * 1024 + 1))
      }
      if (method === 'createNote') {
        assert.match(args.markdown, /^---\nid: __placeholder__\n---\n/)
        const normalizedBody = args.markdown.replace(/^---\nid: __placeholder__\n---\n/, '')
        const note = { id: `note_${notes.size + 1}`, relativePath: args.relativePath, body: normalizedBody, attachmentIds: [] }
        await materialize(note)
        notes.set(note.id, note)
        return send(response, { ok: true, value: { noteId: note.id } })
      }
      if (method === 'getNote') {
        const note = notes.get(args.noteId)
        return send(response, { ok: true, value: { body: note.body + (state.bodyDrift ? '\nmodified' : ''), note: { noteId: note.id, relativePath: note.relativePath, contentHash: note.contentHash }, attachments: note.attachmentIds.map(id => ({ attachmentId: id })) } })
      }
      if (method === 'uploadAttachment') {
        assert.equal(typeof args.filename, 'string')
        assert.equal(args.mimeType, 'application/octet-stream')
        assert.equal(args.relativePath, undefined)
        const id = `att_${attachments.size + 1}`
        const filename = `saved ${args.filename}`
        const bytes = Buffer.from(args.contentBase64, 'base64')
        const path = join(dataRoot, 'spaces', spaceId, 'workspace', 'attachments', id, filename)
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, bytes, { mode: 0o640 })
        attachments.set(id, { bytes, filename, path })
        return send(response, { ok: true, value: { attachmentId: id, filename } })
      }
      if (method === 'saveNoteBody') {
        const note = notes.get(args.noteId)
        assert.equal(args.expectedContentHash, note.contentHash)
        assert.match(args.body, /saved%20/)
        note.body = args.body
        note.attachmentIds = [...attachments.keys()].filter(id => args.body.includes(`attachments/${id}/`))
        await materialize(note)
        return send(response, { ok: true, value: { noteId: note.id } })
      }
      throw new Error(`unknown synthetic API method: ${method}`)
    } catch (error) {
      send(response, { error: error.message }, 500)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const options = { origin: `http://127.0.0.1:${server.address().port}`, username: 'owner', password, dataRoot }
  const client = await createLegacyCompatClient(options)
  await client.authenticate(state.version)
  return { root, dataRoot, client, options, state, calls, notes, attachments, noteFile }
}

test('legacy compatibility uses real JSON RPC, CSRF, persisted filename and HTTP byte readback across releases', async t => {
  const f = await fixture(t)
  const old = await f.client.writeFixture({ label: 'old', body: '# Full old body\n\nfirst and final bytes 中文\n', attachmentBytes: Buffer.from([0, 1, 255, 32]) })
  assert.equal(old.disk.note.mode, '0600')
  assert.equal(old.disk.attachment.mode, '0640')
  assert.equal(old.attachment.bytes, 4)
  assert.equal(old.attachment.sha256, hash(Buffer.from([0, 1, 255, 32])))
  assert.equal(typeof old.body.sha256, 'string')
  const serialized = JSON.stringify(old)
  for (const secret of [password, csrf, cookie, 'Full old body']) assert.equal(serialized.includes(secret), false)
  f.state.version = '0.1.9-pkw.1'
  const next = await createLegacyCompatClient(f.options)
  await next.authenticate(f.state.version, old.spaceId)
  assert.equal((await next.verifyFixture(old)).ok, true)
  const fresh = await next.writeFixture({ label: 'new' })
  f.state.version = '0.1.2-pkw.4'
  const restored = await createLegacyCompatClient(f.options)
  await restored.authenticate(f.state.version, old.spaceId)
  assert.equal((await restored.verifyFixture(old)).ok, true)
  assert.equal((await restored.verifyFixture(fresh)).ok, true)
  assert.equal(f.calls.filter(item => item.payload?.method === 'uploadAttachment').length, 2)
  assert.ok(f.calls.some(item => item.path === `/pkw/spaces/${spaceId}/attachment/${fresh.attachmentId}`))
})

test('legacy compatibility rejects the wrong serving version before writes', async t => {
  const f = await fixture(t)
  const client = await createLegacyCompatClient(f.options)
  await assert.rejects(client.authenticate('0.1.9-pkw.1'), error => error.code === 'PKW_LEGACY_COMPAT_API' && error.details.stage === 'space-page')
  await assert.rejects(client.writeFixture(), /authenticate must succeed/)
  assert.equal(f.notes.size, 0)
})

test('legacy compatibility compares complete bodies and HTTP attachment bytes, not markers', async t => {
  const f = await fixture(t)
  const baseline = await f.client.writeFixture({ label: 'hash' })
  f.state.bodyDrift = true
  await assert.rejects(f.client.verifyFixture(baseline), /complete note body differs/)
  f.state.bodyDrift = false
  f.state.downloadDrift = true
  await assert.rejects(f.client.verifyFixture(baseline), /HTTP attachment bytes differ/)
})

test('legacy compatibility compares disk bytes and captured modes instead of invented permissions', async t => {
  const f = await fixture(t)
  const baseline = await f.client.writeFixture({ label: 'mode' })
  const path = f.attachments.get(baseline.attachmentId).path
  await chmod(path, 0o600)
  await assert.rejects(f.client.verifyFixture(baseline), /attachment file bytes or permissions differ/)
  await chmod(path, 0o640)
  const note = f.notes.get(baseline.noteId)
  const file = f.noteFile(note)
  await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('extra')]))
  await assert.rejects(f.client.verifyFixture(baseline), /note file bytes or permissions differ/)
})

test('legacy compatibility rejects failing HTTP status without echoing response bodies or credentials', async t => {
  const f = await fixture(t)
  const baseline = await f.client.writeFixture({ label: 'redaction' })
  f.state.failMethod = 'getNote'
  await assert.rejects(f.client.verifyFixture(baseline), error => {
    assert.equal(error.details.status, 400)
    assert.equal(error.details.stage, 'getNote')
    for (const secret of [password, csrf, cookie]) assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(secret), false)
    return true
  })
})

test('legacy compatibility enforces request duration and response size limits', async t => {
  const f = await fixture(t)
  const baseline = await f.client.writeFixture({ label: 'bounded' })
  const client = await createLegacyCompatClient({ ...f.options, timeoutMs: 60 })
  await client.authenticate(f.state.version)
  f.state.hang = true
  await assert.rejects(client.verifyFixture(baseline), /interrupted or timed out/)
  f.state.hang = false
  f.state.overLimit = true
  await assert.rejects(f.client.verifyFixture(baseline), /response exceeded the bounded size/)
})

test('legacy compatibility refuses remote origins and invalid baseline paths', async t => {
  const f = await fixture(t)
  await assert.rejects(createLegacyCompatClient({ ...f.options, origin: 'https://ddmind.duckdns.org' }), /loopback HTTP/)
  const baseline = await f.client.writeFixture({ label: 'path' })
  await assert.rejects(f.client.verifyFixture({ ...baseline, noteRelativePath: '../../secret' }), /baseline identity is invalid/)
})

test('legacy compatibility refuses a session from a different account', async t => {
  const f = await fixture(t)
  f.state.username = 'different-owner'
  const client = await createLegacyCompatClient(f.options)
  await assert.rejects(client.authenticate(f.state.version), /belongs to another account/)
  assert.equal(f.notes.size, 0)
})

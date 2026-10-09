import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  captureFirstCutoverBaseline, verifyFirstCutoverBaseline, checkFirstCutoverCredentials,
  FIRST_CUTOVER_GATEWAY, FIRST_CUTOVER_PUBLIC_ORIGIN,
} from '../../deploy/site/first-cutover-acceptance.mjs'

const privateBody = '# Original private note\n\nEntire body including final bytes 中文\n'
const privateFilename = 'Private attachment name.pdf'
const password = 'private-existing-password-no-reset'
const cookie = 'private-cookie-value'
const csrf = 'private-csrf-value'
const spaceId = `sp_${'a'.repeat(32)}`

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-first-accept-test-')))
  const credentialsFile = join(root, 'credentials.json')
  await writeFile(credentialsFile, JSON.stringify({ username: 'existing-owner', password }), { mode: 0o600 })
  const trace = []
  const calls = []
  const state = {
    version: '0.1.2-pkw.4', username: 'existing-owner', body: privateBody,
    attachment: Buffer.from([0, 1, 2, 127, 128, 254, 255]), filename: privateFilename,
    privateSpace: spaceId, noteId: 'note_existing', attachmentId: 'att_existing',
    noNotes: false, noAttachments: false, failPath: null, redirect: false, hang: false, oversized: false,
    noteCalls: 0, changeDuringRead: false, proofChanged: false, pid: 1001,
  }
  const success = (response, value, headers = {}) => {
    response.writeHead(200, { 'content-type': 'application/json', ...headers })
    response.end(JSON.stringify({ ok: true, value }))
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const payload = bytes.length ? JSON.parse(bytes.toString()) : null
      trace.push(request.url)
      calls.push({ path: request.url, method: request.method, headers: request.headers, payload })
      assert.equal(request.headers.host, 'ddmind.duckdns.org')
      assert.equal(request.headers.origin, FIRST_CUTOVER_PUBLIC_ORIGIN)
      if (state.failPath === request.url) {
        response.writeHead(state.redirect ? 302 : 400, { location: 'https://elsewhere.invalid/private', 'content-type': 'application/json' })
        return response.end(JSON.stringify({ error: `${password} ${cookie} ${csrf} ${privateBody}` }))
      }
      if (state.hang) return undefined
      if (request.url === '/pkw/login') {
        assert.deepEqual(payload, { username: 'existing-owner', password })
        return success(response, { loggedIn: true }, { 'set-cookie': `pkw=${cookie}; Secure; HttpOnly; Path=/` })
      }
      assert.equal(request.headers.cookie, `pkw=${cookie}`)
      if (request.url === '/pkw/session') return success(response, { username: state.username, csrf, spaces: [{ id: state.privateSpace, kind: 'private', role: 'owner' }] })
      if (request.url === `/pkw/spaces/${state.privateSpace}`) {
        response.writeHead(200, { 'x-pkw-version': state.version, 'content-type': 'text/html' })
        return response.end('<html>private space</html>')
      }
      if (request.url === `/pkw/spaces/${state.privateSpace}/attachment/${state.attachmentId}`) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        // Multiple chunks exercise the streamed hash rather than a JSON/base64 surrogate.
        response.write(state.attachment.subarray(0, 3))
        return response.end(state.attachment.subarray(3))
      }
      assert.equal(request.url, `/pkw/spaces/${state.privateSpace}/api`)
      assert.equal(request.headers['x-pkw-csrf'], csrf)
      if (state.oversized) {
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end('x'.repeat(3 * 1024 * 1024 + 1))
      }
      if (payload.method === 'listNotes') return success(response, state.noNotes
        ? [{ noteId: 'note_deleted', deleted: true }] : [{ noteId: 'note_deleted', deleted: true }, { noteId: state.noteId, deleted: false }])
      if (payload.method === 'getNote') {
        assert.equal(payload.args.noteId, state.noteId)
        state.noteCalls++
        const body = state.body + (state.changeDuringRead && state.noteCalls % 2 === 0 ? 'changed during read' : '')
        return success(response, { body, markdown: `---\nid: ${state.noteId}\n---\n${body}`,
          note: { noteId: state.noteId }, attachments: [{ attachmentId: state.attachmentId }] })
      }
      if (payload.method === 'listAttachments') return success(response, state.noAttachments ? []
        : [{ attachmentId: state.attachmentId, filename: state.filename, sizeBytes: state.attachment.length, deleted: false }])
      throw new Error('a non-read API was requested')
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error.message }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const confirmInstance = async ({ stage, expectedVersion }) => {
    trace.push(stage)
    return { ok: true, listenerOwned: true, port: 3081, version: expectedVersion,
      pid: state.pid + (state.proofChanged && stage === 'instance-after-read' ? 1 : 0),
      identity: { bootId: '12345678-1234-1234-1234-123456789abc', startTicks: '100000' },
      mustNotLeak: password }
  }
  const requestImpl = (options, callback) => {
    assert.equal(`${options.protocol}//${options.hostname}:${options.port}`, FIRST_CUTOVER_GATEWAY)
    return httpRequest({ ...options, port: server.address().port }, callback)
  }
  const options = { credentialsFile, expectedVersion: state.version, confirmInstance, requestImpl }
  return { root, credentialsFile, state, trace, calls, options }
}

test('first cutover captures real existing content and compares the same account and IDs on activation and rollback', async t => {
  const f = await fixture(t)
  const originalCredentials = await readFile(f.credentialsFile)
  const baselineRun = await captureFirstCutoverBaseline(f.options)
  assert.equal(baselineRun.ok, true)
  assert.equal(baselineRun.privacy.authSessionCreated, true)
  assert.equal(baselineRun.privacy.businessWrites, false)
  const baseline = baselineRun.baseline
  assert.equal(baseline.noteId, 'note_existing')
  assert.equal(baseline.attachmentId, 'att_existing')
  assert.equal(baseline.attachment.bytes, 7)
  assert.equal(baseline.attachmentLinkedToNote, true)
  assert.equal(f.trace[0], 'instance-before-login')
  assert.equal(f.trace.at(-1), 'instance-after-read')
  f.state.version = '0.1.9-pkw.1'
  f.state.pid = 2002
  const active = await verifyFirstCutoverBaseline({ ...f.options, expectedVersion: f.state.version, baseline, mode: 'activate' })
  assert.equal(active.checks.baselineMatched, true)
  f.state.version = '0.1.2-pkw.4'
  f.state.pid = 3003
  const reverted = await verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'rollback' })
  assert.equal(reverted.checks.baselineMatched, true)
  assert.equal(reverted.instance.pid, 3003)
  assert.deepEqual(await readFile(f.credentialsFile), originalCredentials)
  const reported = JSON.stringify([baselineRun, active, reverted])
  for (const privateValue of [password, cookie, csrf, privateBody, privateFilename, 'existing-owner']) assert.equal(reported.includes(privateValue), false)
  const methods = new Set(f.calls.filter(call => call.path.endsWith('/api')).map(call => call.payload.method))
  assert.deepEqual([...methods].sort(), ['getNote', 'listAttachments', 'listNotes'])
  assert.equal(f.calls.filter(call => call.path === '/pkw/login').length, 3)
})

test('first cutover does not send credentials without confirmed instance identity and listener ownership', async t => {
  const f = await fixture(t)
  await assert.rejects(captureFirstCutoverBaseline({ ...f.options, confirmInstance: async () => ({ ok: true }) }), /instance identity and listener ownership/)
  await assert.rejects(captureFirstCutoverBaseline({ ...f.options, confirmInstance: undefined }), /confirmation callback/)
  assert.equal(f.calls.length, 0)
})

test('first cutover requires a canonical owner-only credential file and preserves all supplied files', async t => {
  const f = await fixture(t)
  const before = await readFile(f.credentialsFile)
  assert.deepEqual(await checkFirstCutoverCredentials(f.credentialsFile), { ok: true, mode: '0600', accountSha256: (await captureFirstCutoverBaseline(f.options)).baseline.accountSha256 })
  await chmod(f.credentialsFile, 0o644)
  await assert.rejects(checkFirstCutoverCredentials(f.credentialsFile), /mode 0600/)
  await chmod(f.credentialsFile, 0o600)
  const link = join(f.root, 'credential-link')
  await symlink(f.credentialsFile, link)
  await assert.rejects(checkFirstCutoverCredentials(link), /canonical regular file/)
  await writeFile(f.credentialsFile, `${password} invalid JSON`)
  await assert.rejects(checkFirstCutoverCredentials(f.credentialsFile), error => {
    assert.equal(error.message.includes(password), false)
    return /not valid JSON/.test(error.message)
  })
  await writeFile(f.credentialsFile, before)
  assert.deepEqual(await readFile(f.credentialsFile), before)
})

test('first cutover rejects content, complete download and persisted attachment name drift', async t => {
  const f = await fixture(t)
  const { baseline } = await captureFirstCutoverBaseline(f.options)
  f.state.body += '\nchanged final bytes'
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'activate' }), /complete existing note differs/)
  f.state.body = privateBody
  f.state.attachment = Buffer.from([0, 1, 2, 127, 128, 254, 0])
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'rollback' }), /attachment bytes, identity metadata or note linkage differ/)
  f.state.attachment = Buffer.from([0, 1, 2, 127, 128, 254, 255])
  f.state.filename = 'another-name.pdf'
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'activate' }), /attachment bytes, identity metadata or note linkage differ/)
})

test('first cutover rejects stale process evidence, in-read content changes and a wrong serving version', async t => {
  const f = await fixture(t)
  f.state.proofChanged = true
  await assert.rejects(captureFirstCutoverBaseline(f.options), /managed instance changed/)
  f.state.proofChanged = false
  f.state.changeDuringRead = true
  await assert.rejects(captureFirstCutoverBaseline(f.options), /note changed while acceptance/)
  f.state.changeDuringRead = false
  f.state.version = '0.1.9-pkw.1'
  await assert.rejects(captureFirstCutoverBaseline(f.options), /serving version differs/)
})

test('first cutover never substitutes another account, note, attachment or space for baseline identities', async t => {
  const f = await fixture(t)
  const { baseline } = await captureFirstCutoverBaseline(f.options)
  f.state.username = 'other-user'
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'activate' }), /authenticated account/)
  f.state.username = 'existing-owner'
  f.state.noteId = 'note_substitute'
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'activate' }), /selected existing note/)
  f.state.noteId = 'note_existing'
  f.state.attachmentId = 'att_substitute'
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'activate' }), /selected existing attachment/)
  f.state.attachmentId = 'att_existing'
  f.state.privateSpace = `sp_${'b'.repeat(32)}`
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'activate' }), /same owned private space/)
})

test('first cutover refuses empty/deleted-only data and invalid baseline instead of claiming acceptance', async t => {
  const f = await fixture(t)
  f.state.noNotes = true
  await assert.rejects(captureFirstCutoverBaseline(f.options), /selected existing note/)
  f.state.noNotes = false
  f.state.noAttachments = true
  await assert.rejects(captureFirstCutoverBaseline(f.options), /selected existing attachment/)
  await assert.rejects(async () => verifyFirstCutoverBaseline({ ...f.options, baseline: {}, mode: 'activate' }), /complete existing-content baseline/)
})

test('first cutover rejects HTTP errors and redirects without reporting bodies or secret data', async t => {
  const f = await fixture(t)
  f.state.failPath = '/pkw/login'
  await assert.rejects(captureFirstCutoverBaseline(f.options), error => {
    assert.equal(error.details.status, 400)
    for (const secret of [password, cookie, csrf, privateBody]) assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(secret), false)
    return true
  })
  f.state.redirect = true
  await assert.rejects(captureFirstCutoverBaseline(f.options), error => error.details.status === 302)
  assert.equal(f.calls.length, 2)
})

test('first cutover bounds identity callbacks, HTTP duration and JSON response size', async t => {
  const f = await fixture(t)
  await assert.rejects(captureFirstCutoverBaseline({ ...f.options, timeoutMs: 40, totalTimeoutMs: 50, confirmInstance: () => new Promise(() => {}) }), /instance confirmation could not/)
  assert.equal(f.calls.length, 0)
  f.state.hang = true
  await assert.rejects(captureFirstCutoverBaseline({ ...f.options, timeoutMs: 50, totalTimeoutMs: 100 }), /interrupted or timed out/)
  f.state.hang = false
  f.state.oversized = true
  await assert.rejects(captureFirstCutoverBaseline(f.options), /response exceeded its byte limit/)
})

test('first cutover uses the real case-insensitive account contract without changing password bytes', async t => {
  const f = await fixture(t)
  await writeFile(f.credentialsFile, JSON.stringify({ username: 'EXISTING-OWNER', password }))
  const report = await captureFirstCutoverBaseline(f.options)
  assert.equal(report.ok, true)
  assert.equal(f.calls.find(call => call.path === '/pkw/login').payload.password, password)
})

test('manual rollback accepts old release reading a fresh candidate baseline, but rejects a wrong serving version', async t => {
  const f = await fixture(t)
  f.state.version = '0.1.9-pkw.1'
  f.state.body += '\nData committed after activation\n'
  const { baseline } = await captureFirstCutoverBaseline({ ...f.options, expectedVersion: f.state.version })
  assert.equal(baseline.capturedVersion, '0.1.9-pkw.1')
  await assert.rejects(verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'rollback' }), /serving version differs/)
  f.state.version = '0.1.2-pkw.4'
  f.state.pid = 3003
  const restored = await verifyFirstCutoverBaseline({ ...f.options, baseline, mode: 'rollback' })
  assert.equal(restored.ok, true)
  assert.equal(restored.servingVersion, '0.1.2-pkw.4')
  assert.equal(restored.checks.baselineMatched, true)
})

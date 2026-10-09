/**
 * Bounded business-API checks for a caller-owned, synthetic compatibility data root.
 * The caller must prove that its listener owns this loopback endpoint before calling us.
 * No service, configuration, database, or file is changed here except synthetic content
 * created by the real HTTP API. Returned evidence contains identities and hashes only.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const maxBytes = 2 * 1024 * 1024
const validId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,100}$`).test(value)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeName = value => typeof value === 'string' && value.length > 0 && value.length < 240 && value === value.trim()
  && value !== '.' && value !== '..' && !/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value)

function fail(stage, reason, details = {}) {
  const error = new Error(`${stage}: ${reason}`)
  error.code = 'PKW_LEGACY_COMPAT_API'
  error.details = { stage, reason, ...details }
  return error
}

function check(condition, stage, reason, details) {
  if (!condition) throw fail(stage, reason, details)
}

function fingerprint(bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes) }
}

/**
 * Async factory. authenticate(expectedVersion, spaceId?) establishes a fresh session;
 * writeFixture({label}) creates and completely verifies synthetic content, returning
 * a portable baseline; verifyFixture(baseline) checks that baseline on the currently
 * authenticated release. Each process/release gets a separate client and login.
 */
export async function createLegacyCompatClient({
  origin, username, password, dataRoot, signal, timeoutMs = 15_000, fetchImpl = fetch,
} = {}) {
  let url
  try { url = new URL(origin) } catch { throw fail('options', 'a loopback HTTP origin is required') }
  check(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && url.port !== '' && url.username === '' && url.password === '' && url.pathname === '/' && !url.search && !url.hash,
  'options', 'only an explicit loopback HTTP origin is allowed')
  check(typeof username === 'string' && username.length > 0 && typeof password === 'string' && password.length > 0,
    'options', 'synthetic login credentials are required')
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'options', 'the request deadline is invalid')
  check(typeof dataRoot === 'string' && isAbsolute(dataRoot), 'options', 'an absolute synthetic data root is required')
  const root = resolve(dataRoot)
  try {
    check((await lstat(root)).isDirectory() && await realpath(root) === root, 'options', 'the synthetic data root must be canonical')
  } catch (error) {
    if (error.code === 'PKW_LEGACY_COMPAT_API') throw error
    throw fail('options', 'the synthetic data root cannot be inspected')
  }
  const base = url.origin
  const jar = new Map()
  let session = null

  async function request(path, { method = 'GET', body, stage, binary = false } = {}) {
    const headers = { Origin: base }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (session?.csrf) headers['X-PKW-CSRF'] = session.csrf
    if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    try {
      const response = await fetchImpl(base + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: combined,
      })
      // Status precedes body, version and JSON checks. Failure bodies may contain secrets.
      check(response.status === 200, stage, 'the endpoint refused the request', { method, status: response.status })
      const chunks = []
      let length = 0
      if (response.body) {
        for await (const chunk of response.body) {
          length += chunk.length
          check(length <= maxBytes, stage, 'the response exceeded the bounded size', { method, status: response.status })
          chunks.push(Buffer.from(chunk))
        }
      }
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const pair = raw.split(';', 1)[0]
        const index = pair.indexOf('=')
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1))
      }
      const bytes = Buffer.concat(chunks)
      if (binary) return { bytes, headers: response.headers }
      let json
      try { json = JSON.parse(bytes.toString('utf8')) } catch { throw fail(stage, 'the endpoint did not return JSON', { method, status: 200 }) }
      check(isRecord(json) && json.ok === true && isRecord(json.value), stage, 'the endpoint did not report a successful value', { method, status: 200 })
      return json.value
    } catch (error) {
      if (error.code === 'PKW_LEGACY_COMPAT_API') throw error
      throw fail(stage, combined.aborted ? 'the bounded request was interrupted or timed out' : 'the request transport failed', { method })
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  function requireSession(stage) {
    check(session !== null, stage, 'authenticate must succeed before accessing a space')
  }

  async function authenticate(expectedVersion, expectedSpaceId) {
    check(typeof expectedVersion === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(expectedVersion),
      'authenticate', 'an explicit expected package version is required')
    session = null
    jar.clear()
    await request('/pkw/login', { method: 'POST', body: { username, password }, stage: 'login' })
    const value = await request('/pkw/session', { stage: 'session' })
    check(value.username === username && typeof value.csrf === 'string' && value.csrf.length > 0 && Array.isArray(value.spaces), 'session', 'the session identity is incomplete or belongs to another account')
    const space = expectedSpaceId ? value.spaces.find(item => item.id === expectedSpaceId)
      : value.spaces.find(item => item.kind === 'private' && item.role === 'owner')
    check(isRecord(space) && validId(space.id, 'sp') && space.kind === 'private' && space.role === 'owner', 'session', 'the owned synthetic private space is missing')
    const page = await request(`/pkw/spaces/${space.id}`, { stage: 'space-page', binary: true })
    const version = page.headers.get('x-pkw-version')
    check(version === expectedVersion, 'space-page', 'the serving version does not match the expected release', {
      expectedVersion, observedVersion: typeof version === 'string' && /^[a-zA-Z0-9.+-]{1,100}$/.test(version) ? version : null,
    })
    session = { csrf: value.csrf, spaceId: space.id, version }
    return { login: 200, session: 200, page: 200, authenticated: true, spaceId: space.id, servingVersion: version }
  }

  async function rpc(method, args) {
    requireSession(method)
    return request(`/pkw/spaces/${session.spaceId}/api`, { method: 'POST', body: { method, args }, stage: method })
  }

  async function inspectFile(parts, stage) {
    const target = join(root, ...parts)
    const rel = relative(root, target)
    check(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), stage, 'the file escapes the synthetic data root')
    let walk = root
    for (const part of parts) {
      walk = join(walk, part)
      const item = await lstat(walk)
      check(!item.isSymbolicLink(), stage, 'a synthetic file path contains a symbolic link')
    }
    check(await realpath(target) === target, stage, 'the synthetic file is not canonical')
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat()
      check(before.isFile() && before.size <= maxBytes, stage, 'the synthetic file is not a bounded regular file')
      const buffer = Buffer.alloc(maxBytes + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      const after = await handle.stat()
      check(length <= maxBytes && before.size === after.size && before.mtimeMs === after.mtimeMs && length === after.size,
        stage, 'the synthetic file changed while being read')
      return { ...fingerprint(buffer.subarray(0, length)), mode: (after.mode & 0o7777).toString(8).padStart(4, '0') }
    } finally { await handle.close() }
  }

  async function diskEvidence({ spaceId, noteRelativePath, attachmentId, attachmentFilename }) {
    try {
      return {
        note: await inspectFile(['spaces', spaceId, 'workspace', 'notes', ...noteRelativePath.split('/')], 'note-file'),
        attachment: await inspectFile(['spaces', spaceId, 'workspace', 'attachments', attachmentId, attachmentFilename], 'attachment-file'),
      }
    } catch (error) {
      if (error.code === 'PKW_LEGACY_COMPAT_API') throw error
      throw fail('disk-readback', 'the synthetic file evidence could not be read')
    }
  }

  function noteValue(value, stage) {
    check(isRecord(value) && typeof value.body === 'string' && isRecord(value.note)
      && /^[a-f0-9]{64}$/.test(value.note.contentHash) && Array.isArray(value.attachments), stage, 'the note readback is incomplete')
    return value
  }

  async function writeFixture({ label = 'compatibility', body, attachmentBytes } = {}) {
    requireSession('write-fixture')
    check(typeof label === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(label), 'write-fixture', 'the synthetic label is invalid')
    const marker = `${label}-${randomUUID()}`
    const noteRelativePath = `compatibility/${marker}.md`
    const noteBody = body ?? `# Compatibility ${marker}\n\nSynthetic full-body comparison: 中文, punctuation & spaces.\n`
    const bytes = attachmentBytes === undefined ? Buffer.concat([Buffer.from(`Synthetic attachment ${marker}\n`), Buffer.from([0, 1, 127, 128, 255])]) : Buffer.from(attachmentBytes)
    check(typeof noteBody === 'string' && Buffer.byteLength(noteBody) > 0 && Buffer.byteLength(noteBody) < maxBytes / 4 && bytes.length > 0 && bytes.length < maxBytes / 4,
      'write-fixture', 'the synthetic payload exceeds its bounds')
    // Product createNote mints this placeholder identity while preserving the supplied
    // body exactly. Without frontmatter it inserts an extra blank line into the body.
    const created = await rpc('createNote', { relativePath: noteRelativePath, markdown: `---\nid: __placeholder__\n---\n${noteBody}` })
    check(validId(created.noteId, 'note'), 'createNote', 'the note identity is invalid')
    const noteId = created.noteId
    const before = noteValue(await rpc('getNote', { noteId }), 'getNote')
    check(before.body === noteBody, 'getNote', 'the complete created body differs from the submitted body')
    const uploaded = await rpc('uploadAttachment', {
      filename: `${marker}.bin`, mimeType: 'application/octet-stream', contentBase64: bytes.toString('base64'), indexable: false,
    })
    check(validId(uploaded.attachmentId, 'att') && safeName(uploaded.filename), 'uploadAttachment', 'the persisted attachment identity is invalid')
    const attachmentId = uploaded.attachmentId
    const attachmentFilename = uploaded.filename
    const escaped = encodeURIComponent(attachmentFilename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    const linkedBody = `${before.body}\n![compatibility attachment](attachments/${attachmentId}/${escaped})\n`
    await rpc('saveNoteBody', { noteId, body: linkedBody, expectedContentHash: before.note.contentHash })
    const baseline = {
      spaceId: session.spaceId, noteId, noteRelativePath, attachmentId, attachmentFilename,
      body: fingerprint(Buffer.from(linkedBody)), attachment: fingerprint(bytes),
      writtenByVersion: session.version,
    }
    const read = noteValue(await rpc('getNote', { noteId }), 'getNote')
    check(read.body === linkedBody && read.attachments.some(item => item.attachmentId === attachmentId), 'write-fixture', 'the complete linked note was not persisted')
    baseline.disk = await diskEvidence(baseline)
    check(baseline.disk.attachment.sha256 === baseline.attachment.sha256 && baseline.disk.attachment.bytes === baseline.attachment.bytes,
      'write-fixture', 'the stored attachment differs from the submitted bytes')
    await verifyFixture(baseline)
    return baseline
  }

  async function verifyFixture(baseline) {
    requireSession('verify-fixture')
    check(isRecord(baseline) && baseline.spaceId === session.spaceId && validId(baseline.noteId, 'note')
      && validId(baseline.attachmentId, 'att') && safeName(baseline.attachmentFilename)
      && typeof baseline.noteRelativePath === 'string' && /^compatibility\/[a-zA-Z0-9_-]+\.md$/.test(baseline.noteRelativePath),
    'verify-fixture', 'the baseline identity is invalid')
    for (const item of [baseline.body, baseline.attachment, baseline.disk?.note, baseline.disk?.attachment]) {
      check(isRecord(item) && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isInteger(item.bytes) && item.bytes >= 0 && item.bytes <= maxBytes,
        'verify-fixture', 'the baseline byte evidence is invalid')
    }
    const read = noteValue(await rpc('getNote', { noteId: baseline.noteId }), 'getNote')
    const bodyFingerprint = fingerprint(Buffer.from(read.body))
    check(bodyFingerprint.sha256 === baseline.body.sha256 && bodyFingerprint.bytes === baseline.body.bytes,
      'verify-fixture', 'the complete note body differs from its write baseline')
    check(read.attachments.some(item => item.attachmentId === baseline.attachmentId), 'verify-fixture', 'the note no longer resolves its attachment')
    const download = await request(`/pkw/spaces/${session.spaceId}/attachment/${baseline.attachmentId}`, { stage: 'attachment-download', binary: true })
    const downloaded = fingerprint(download.bytes)
    check(downloaded.sha256 === baseline.attachment.sha256 && downloaded.bytes === baseline.attachment.bytes,
      'attachment-download', 'the HTTP attachment bytes differ from their write baseline')
    const disk = await diskEvidence(baseline)
    for (const name of ['note', 'attachment']) {
      check(disk[name].sha256 === baseline.disk[name].sha256 && disk[name].bytes === baseline.disk[name].bytes && disk[name].mode === baseline.disk[name].mode,
        'verify-fixture', `the ${name} file bytes or permissions differ from their write baseline`)
    }
    return {
      ok: true, servingVersion: session.version, spaceId: baseline.spaceId, noteId: baseline.noteId, attachmentId: baseline.attachmentId,
      body: bodyFingerprint, attachment: downloaded, disk, downloadStatus: 200, linked: true,
    }
  }

  return { authenticate, writeFixture, verifyFixture }
}

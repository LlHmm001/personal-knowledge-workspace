/**
 * Existing-account acceptance for the first independent PKW cutover.
 * Network requests are pinned to the local gateway; a caller-supplied, fresh process
 * identity/port proof must pass before login and after all reads. Only existing note
 * and attachment reads are exposed. Login creates normal authentication metadata;
 * no business mutation API, bootstrap, database access or password reset is present.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export const FIRST_CUTOVER_GATEWAY = 'http://127.0.0.1:3081'
export const FIRST_CUTOVER_PUBLIC_ORIGIN = 'https://ddmind.duckdns.org'
const MAX_JSON = 3 * 1024 * 1024
const MAX_ATTACHMENT = 50 * 1024 * 1024
const MAX_CREDENTIALS = 16 * 1024
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => ({ sha256: hash(value), bytes: Buffer.byteLength(value) })
const versionOk = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)
const idOk = (value, kind) => typeof value === 'string' && new RegExp(`^${kind}_[A-Za-z0-9_-]{1,100}$`).test(value)
const shaOk = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function refusal(stage, reason, details = {}) {
  const error = new Error(`${stage}: ${reason}`)
  error.code = 'PKW_FIRST_CUTOVER_ACCEPTANCE'
  error.details = { stage, reason, ...details }
  return error
}
function requireThat(condition, stage, reason, details) {
  if (!condition) throw refusal(stage, reason, details)
}

async function loadCredentials(path) {
  requireThat(typeof path === 'string' && isAbsolute(path), 'credentials', 'an absolute owner-only JSON credential file is required')
  let handle
  try {
    const filename = resolve(path)
    const stat = await lstat(filename)
    requireThat(stat.isFile() && !stat.isSymbolicLink() && await realpath(filename) === filename,
      'credentials', 'the credential file must be a canonical regular file')
    handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const uid = process.getuid?.()
    requireThat(Number.isInteger(uid) && before.uid === uid && (before.mode & 0o7777) === 0o600
      && before.isFile() && before.size > 0 && before.size <= MAX_CREDENTIALS
      && before.dev === stat.dev && before.ino === stat.ino,
    'credentials', 'the credential file must belong to this user, have mode 0600 and fit the size limit')
    const bytes = Buffer.alloc(MAX_CREDENTIALS + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    requireThat(length <= MAX_CREDENTIALS && length === after.size && before.size === after.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && after.uid === uid && (after.mode & 0o7777) === 0o600,
    'credentials', 'the credential file changed while being read')
    let value
    try { value = JSON.parse(bytes.subarray(0, length).toString('utf8')) } catch { throw refusal('credentials', 'the credential file is not valid JSON') }
    requireThat(record(value) && Object.keys(value).length === 2
      && typeof value.username === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value.username)
      && typeof value.password === 'string' && value.password.length > 0 && value.password.length <= 8192,
    'credentials', 'the credential file must contain only an existing username and password')
    // Both existing and candidate identity stores use this same case-insensitive
    // ASCII account contract; preserve password bytes exactly.
    return { username: value.username.toLowerCase(), password: value.password }
  } catch (error) {
    if (error.code === 'PKW_FIRST_CUTOVER_ACCEPTANCE') throw error
    throw refusal('credentials', 'the credential file could not be read safely')
  } finally { await handle?.close() }
}

/** Validate the user-created file without exposing either credential value. */
export async function checkFirstCutoverCredentials(credentialsFile) {
  const credentials = await loadCredentials(credentialsFile)
  return { ok: true, mode: '0600', accountSha256: hash(credentials.username) }
}

function proofValue(value, expectedVersion, stage) {
  requireThat(record(value) && value.ok === true && value.listenerOwned === true && value.port === 3081
    && value.version === expectedVersion && Number.isSafeInteger(value.pid) && value.pid > 0
    && record(value.identity) && typeof value.identity.bootId === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.identity.bootId)
    && typeof value.identity.startTicks === 'string' && /^[0-9]+$/.test(value.identity.startTicks),
  stage, 'the managed instance identity and listener ownership were not established')
  // Whitelist the report: a callback may also hold command lines or configuration.
  return { pid: value.pid, identity: { bootId: value.identity.bootId, startTicks: value.identity.startTicks }, port: 3081, version: expectedVersion }
}

function fingerprintOk(value, limit) {
  return record(value) && shaOk(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= limit
}
function validateBaseline(baseline) {
  requireThat(record(baseline) && baseline.schema === 1 && baseline.kind === 'first-cutover-existing-content'
    && versionOk(baseline.capturedVersion) && shaOk(baseline.accountSha256)
    && idOk(baseline.spaceId, 'sp') && idOk(baseline.noteId, 'note') && idOk(baseline.attachmentId, 'att')
    && fingerprintOk(baseline.body, MAX_JSON) && fingerprintOk(baseline.markdown, MAX_JSON)
    && fingerprintOk(baseline.attachment, MAX_ATTACHMENT) && shaOk(baseline.attachmentFilenameSha256)
    && typeof baseline.attachmentLinkedToNote === 'boolean',
  'baseline', 'a complete existing-content baseline is required')
}
function sameFingerprint(actual, expected) {
  return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes
}

async function accept({ credentialsFile, expectedVersion, confirmInstance, signal, timeoutMs = 15_000,
  totalTimeoutMs = 120_000, requestImpl = httpRequest, baseline = null, mode }) {
  requireThat(versionOk(expectedVersion), 'options', 'an expected installed release version is required')
  requireThat(typeof confirmInstance === 'function', 'instance-before-login', 'the orchestrator must supply an instance confirmation callback')
  requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000
    && Number.isInteger(totalTimeoutMs) && totalTimeoutMs >= timeoutMs && totalTimeoutMs <= 180_000,
  'options', 'bounded request and overall deadlines are required')
  if (baseline !== null) validateBaseline(baseline)
  const overall = new AbortController()
  const overallTimer = setTimeout(() => overall.abort(), totalTimeoutMs)
  const outerSignal = signal ? AbortSignal.any([signal, overall.signal]) : overall.signal
  let account, csrf
  const jar = new Map()

  async function prove(stage) {
    if (outerSignal.aborted) throw refusal(stage, 'the acceptance deadline was reached or cancelled')
    let result
    // The callback must itself have bounded OS probes. Its result cannot substitute
    // reachability for proof of PID/start identity, expected profile and port ownership.
    let abort
    try {
      result = await Promise.race([
        Promise.resolve().then(() => confirmInstance({ expectedVersion, stage, signal: outerSignal })),
        new Promise((_, reject) => {
          abort = () => reject(refusal(stage, 'the instance confirmation was interrupted or timed out'))
          outerSignal.addEventListener('abort', abort, { once: true })
          if (outerSignal.aborted) abort()
        }),
      ])
    } catch { throw refusal(stage, 'the instance confirmation could not be completed') }
    finally { if (abort) outerSignal.removeEventListener('abort', abort) }
    if (outerSignal.aborted) throw refusal(stage, 'the acceptance deadline was reached or cancelled')
    return proofValue(result, expectedVersion, stage)
  }

  async function request(path, { stage, body, binary = false, page = false } = {}) {
    const method = body === undefined ? 'GET' : 'POST'
    const headers = { Origin: FIRST_CUTOVER_PUBLIC_ORIGIN, Host: 'ddmind.duckdns.org' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (csrf) headers['X-PKW-CSRF'] = csrf
    if (jar.size) headers.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const requestSignal = AbortSignal.any([outerSignal, controller.signal])
    try {
      // Node 22 fetch replaces Host with the loopback URL's host. Native HTTP
      // preserves the configured virtual host while connecting only to this IP.
      // http.request never follows redirects. No DNS/public-origin request occurs.
      const response = await new Promise((resolveResponse, rejectResponse) => {
        const outgoing = requestImpl({
          protocol: 'http:', hostname: '127.0.0.1', port: 3081, path, method, headers, signal: requestSignal,
        }, resolveResponse)
        outgoing.once('error', rejectResponse)
        outgoing.end(body === undefined ? undefined : JSON.stringify(body))
      })
      requireThat(response.statusCode === 200, stage, 'the endpoint refused the request', { status: response.statusCode, method })
      const hasher = createHash('sha256')
      const chunks = []
      const limit = binary && !page ? MAX_ATTACHMENT : MAX_JSON
      let bytes = 0
      for await (const chunk of response) {
        bytes += chunk.length
        requireThat(bytes <= limit, stage, 'the response exceeded its byte limit', { method })
        hasher.update(chunk)
        if (!binary) chunks.push(Buffer.from(chunk))
      }
      for (const raw of response.headers['set-cookie'] ?? []) {
        const pair = raw.split(';', 1)[0]
        const index = pair.indexOf('=')
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1))
      }
      if (binary) return { bytes, sha256: hasher.digest('hex'), version: response.headers['x-pkw-version'] }
      let parsed
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw refusal(stage, 'the endpoint did not return valid JSON', { method }) }
      requireThat(record(parsed) && parsed.ok === true && Object.hasOwn(parsed, 'value'), stage, 'the endpoint did not report a successful result', { method })
      return parsed.value
    } catch (error) {
      if (error.code === 'PKW_FIRST_CUTOVER_ACCEPTANCE') throw error
      throw refusal(stage, requestSignal.aborted ? 'the request was interrupted or timed out' : 'the request transport failed', { method })
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  async function rpc(spaceId, method, args = {}) {
    // This allowlist deliberately has no mutation method, including reconciliation.
    requireThat(['listNotes', 'getNote', 'listAttachments'].includes(method), 'rpc', 'a business mutation is not allowed')
    return request(`/pkw/spaces/${spaceId}/api`, { stage: method, body: { method, args } })
  }
  function inspectNote(value, noteId) {
    requireThat(record(value) && record(value.note) && value.note.noteId === noteId
      && typeof value.body === 'string' && typeof value.markdown === 'string'
      && Array.isArray(value.attachments), 'getNote', 'the complete existing note could not be read')
    const body = digest(value.body), markdown = digest(value.markdown)
    requireThat(body.bytes <= MAX_JSON && markdown.bytes <= MAX_JSON, 'getNote', 'the note exceeded the read limit')
    return { body, markdown, attachmentIds: value.attachments.filter(item => record(item) && idOk(item.attachmentId, 'att')).map(item => item.attachmentId) }
  }

  try {
    // Checking the credential file does not contact the service. The proof must pass
    // before any credential is placed into a network request.
    account = await loadCredentials(credentialsFile)
    if (baseline) requireThat(hash(account.username) === baseline.accountSha256, 'credentials', 'the acceptance account differs from the baseline account')
    const before = await prove('instance-before-login')
    await request('/pkw/login', { stage: 'login', body: account })
    const session = await request('/pkw/session', { stage: 'session' })
    requireThat(record(session) && session.username === account.username && typeof session.csrf === 'string'
      && session.csrf.length > 0 && Array.isArray(session.spaces), 'session', 'the authenticated account or session is not confirmed')
    csrf = session.csrf
    const candidates = session.spaces.filter(space => record(space) && idOk(space.id, 'sp') && space.kind === 'private' && space.role === 'owner')
    const space = baseline ? candidates.find(item => item.id === baseline.spaceId) : candidates.sort((a, b) => a.id.localeCompare(b.id))[0]
    requireThat(Boolean(space), 'session', 'the same owned private space is not available')
    const page = await request(`/pkw/spaces/${space.id}`, { stage: 'space-page', binary: true, page: true })
    requireThat(page.version === expectedVersion, 'space-page', 'the serving version differs from the expected release', {
      expectedVersion, observedVersion: versionOk(page.version) ? page.version : null,
    })
    const list = await rpc(space.id, 'listNotes')
    requireThat(Array.isArray(list), 'listNotes', 'the note list is not valid')
    const notes = list.filter(note => record(note) && note.deleted !== true && idOk(note.noteId, 'note'))
    const selected = baseline ? notes.find(note => note.noteId === baseline.noteId) : notes.sort((a, b) => a.noteId.localeCompare(b.noteId))[0]
    requireThat(Boolean(selected), 'listNotes', 'the selected existing note is not available')
    const first = inspectNote(await rpc(space.id, 'getNote', { noteId: selected.noteId }), selected.noteId)
    const attachmentList = await rpc(space.id, 'listAttachments')
    requireThat(Array.isArray(attachmentList), 'listAttachments', 'the attachment list is not valid')
    const attachments = attachmentList.filter(item => record(item) && item.deleted !== true && idOk(item.attachmentId, 'att')).sort((a, b) => a.attachmentId.localeCompare(b.attachmentId))
    const selectedAttachment = baseline ? attachments.find(item => item.attachmentId === baseline.attachmentId)
      : attachments.find(item => first.attachmentIds.includes(item.attachmentId)) ?? attachments[0]
    requireThat(Boolean(selectedAttachment) && typeof selectedAttachment.filename === 'string'
      && selectedAttachment.filename.length > 0 && Number.isSafeInteger(selectedAttachment.sizeBytes)
      && selectedAttachment.sizeBytes >= 0 && selectedAttachment.sizeBytes <= MAX_ATTACHMENT,
    'listAttachments', 'the selected existing attachment is not available within the read limit')
    const downloaded = await request(`/pkw/spaces/${space.id}/attachment/${selectedAttachment.attachmentId}`, { stage: 'attachment-download', binary: true })
    requireThat(downloaded.bytes === selectedAttachment.sizeBytes, 'attachment-download', 'the complete download size differs from the attachment record')
    const afterRead = inspectNote(await rpc(space.id, 'getNote', { noteId: selected.noteId }), selected.noteId)
    requireThat(sameFingerprint(first.body, afterRead.body) && sameFingerprint(first.markdown, afterRead.markdown)
      && first.attachmentIds.join('\0') === afterRead.attachmentIds.join('\0'),
    'content-stability', 'the selected note changed while acceptance was reading it')
    const captured = {
      schema: 1, kind: 'first-cutover-existing-content', capturedVersion: expectedVersion,
      accountSha256: hash(account.username), spaceId: space.id, noteId: selected.noteId,
      body: first.body, markdown: first.markdown, attachmentId: selectedAttachment.attachmentId,
      attachment: { sha256: downloaded.sha256, bytes: downloaded.bytes },
      attachmentFilenameSha256: hash(selectedAttachment.filename),
      attachmentLinkedToNote: first.attachmentIds.includes(selectedAttachment.attachmentId),
    }
    if (baseline) {
      requireThat(sameFingerprint(captured.body, baseline.body) && sameFingerprint(captured.markdown, baseline.markdown),
        'content-compare', 'the complete existing note differs from its pre-cutover baseline')
      requireThat(sameFingerprint(captured.attachment, baseline.attachment)
        && captured.attachmentFilenameSha256 === baseline.attachmentFilenameSha256
        && captured.attachmentLinkedToNote === baseline.attachmentLinkedToNote,
      'content-compare', 'the existing attachment bytes, identity metadata or note linkage differ from the baseline')
    }
    const after = await prove('instance-after-read')
    requireThat(before.pid === after.pid && before.identity.bootId === after.identity.bootId
      && before.identity.startTicks === after.identity.startTicks,
    'instance-after-read', 'the managed instance changed during authenticated acceptance')
    return {
      ok: true, enforcing: true, mode, servingVersion: expectedVersion,
      checks: { authenticated: true, instanceConfirmed: true, accountConfirmed: true, spaceConfirmed: true,
        noteReadable: true, fullBodyVerified: true, fullMarkdownVerified: true, fullAttachmentVerified: true,
        noteId: captured.noteId, attachmentId: captured.attachmentId, downloadStatus: 200,
        ...(baseline ? { baselineMatched: true } : { baselineCaptured: true }) },
      privacy: { authSessionCreated: true, businessWrites: false, contentReported: false, credentialsReported: false },
      instance: after, ...(baseline ? { observed: captured } : { baseline: captured }),
    }
  } finally {
    clearTimeout(overallTimer)
    overall.abort()
    jar.clear()
    csrf = undefined
    account = undefined
  }
}

/** Capture existing-content hashes before stopping the live PKW writer. */
export function captureFirstCutoverBaseline(options) {
  return accept({ ...options, baseline: null, mode: 'baseline' })
}

/** Read the very same existing objects after activation or rollback; never recapture. */
export function verifyFirstCutoverBaseline(options) {
  requireThat(record(options) && ['activate', 'rollback'].includes(options.mode), 'options', 'verification mode must be activate or rollback')
  validateBaseline(options.baseline)
  // The baseline may be freshly captured from the candidate before a manual
  // rollback, so capturedVersion is provenance rather than the target version.
  // The caller's expectedVersion is checked against both process proof and HTTP.
  return accept(options)
}

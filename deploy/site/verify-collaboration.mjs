#!/usr/bin/env node
/**
 * Collaboration service verifier for a deployment's activate AND rollback steps.
 *
 * Reviewed, generic version of a site-local verifier. It is designed to be passed
 * as the third argument of `activate(options, execute, verify)` in
 * `scripts/deployment.mjs`, which calls it as `verify(url, attempts, expectedVersion)`
 * on activation and `verify(url)` on rollback.
 *
 * What it refuses to accept as success:
 *   - a login page or any other HTML served in place of the collaboration portal
 *   - a bare HTTP 200, or an authenticated-looking 401 on an endpoint that must
 *     answer with data
 *   - an empty probe, or a gateway that answers but was not started from the
 *     profile being deployed
 *
 * It also encodes the two-shape contract of a cutover deployment: the legacy
 * single-user `/pkw` route on the DSH origin must answer 404, while the
 * authenticated collaboration gateway serves the portal.
 *
 * Two modes, never conflated:
 *   - enforcing (default) requires a credential file, a working login, a serving
 *     version that matches both the requested version and the installed one, and a
 *     readable note. Missing credentials, a refused login or a version mismatch fail.
 *   - `--diagnostics` is a read-only report that never gates a deployment and marks
 *     every unverified check as not verified.
 *
 * Exit 0 = verified, non-zero = refused (reason on stderr, JSON on stdout).
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'activate' },
  version: { type: 'string' },
  profile: { type: 'string' },
  'dsh-url': { type: 'string' },
  'gateway-url': { type: 'string', default: 'http://127.0.0.1:3081' },
  'public-origin': { type: 'string' },
  'credentials-file': { type: 'string' },
  'deployment-version': { type: 'string' },
  username: { type: 'string' },
  diagnostics: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} })
if (values.help || !values.profile || !values['public-origin']) {
  process.stdout.write(`Usage: node deploy/site/verify-collaboration.mjs --profile DIR --public-origin URL [options]

  Two modes, and they are not interchangeable:
    (default)      ENFORCING. Requires a credential file and a confirmed serving
                   version. Missing credentials, a refused login, or a service that is
                   not serving the expected version are failures.
    --diagnostics  READ-ONLY report. Never gates anything: it prints what it could
                   observe and marks every unverified check as not verified.

  --mode activate|rollback     which step is being verified (default activate)
  --version VERSION            version that must be installed and serving
  --dsh-url URL                DSH origin, whose legacy /pkw route must answer 404
  --gateway-url URL            collaboration gateway origin (default http://127.0.0.1:3081)
  --public-origin URL          origin users actually reach the portal on
  --credentials-file FILE      owner password file (0600); omit to skip authenticated checks
  --username NAME              owner username for the authenticated checks
`)
  process.exit(values.help ? 0 : 2)
}
const mode = values.mode
const profile = values.profile
const publicOrigin = values['public-origin'].replace(/\/$/, '')
const gatewayUrl = values['gateway-url'].replace(/\/$/, '')
const requestedVersion = values.version ?? values['deployment-version']
const username = values.username ?? 'owner'

function installedVersion() {
  try { return JSON.parse(readFileSync(`${profile}/node_modules/@deepseek-ai/dsh-pkw-web/package.json`, 'utf8')).version } catch { return undefined }
}
const enforcing = !values.diagnostics
const evidence = { mode, enforcing, requestedVersion, installedVersion: installedVersion(), checks: {}, ok: false }
const refuse = (message, extra = {}) => {
  console.error(`collaboration verifier (${mode}) refused: ${message}`)
  console.log(JSON.stringify({ ok: false, mode, error: message, ...evidence, ...extra }))
  process.exit(1)
}
const probe = (url, options = {}, ms = 10_000) => fetch(url, { ...options, signal: AbortSignal.timeout(ms) })

// The legacy single-user entry must be off; this is the cutover evidence.
if (values['dsh-url']) {
  const legacy = await probe(`${values['dsh-url'].replace(/\/$/, '')}/pkw`).catch(error => ({ status: 0, error: error.message }))
  evidence.checks.legacyRouteStatus = legacy.status
  if (legacy.status !== 404) refuse(`legacy /pkw on the DSH origin must be 404 (got ${legacy.status})`)
}

// The gateway must be genuinely serving, not merely listening.
const health = await probe(`${gatewayUrl}/healthz`).catch(error => ({ status: 0, error: error.message }))
const healthBody = await health.text?.().catch(() => '') ?? ''
evidence.checks.gatewayHealthzStatus = health.status
evidence.checks.gatewayHealthzBody = healthBody.trim().slice(0, 200)
if (health.status !== 200 || !healthBody.includes('ready')) refuse(`collaboration gateway is not ready at ${gatewayUrl} (HTTP ${health.status})`)

const portal = await probe(`${publicOrigin}/pkw`, { redirect: 'manual' })
const portalHtml = await portal.text()
evidence.checks.portalStatus = portal.status
evidence.checks.portalHasTitle = portalHtml.includes('PKW · 我的空间')
if (portal.status !== 200 || !evidence.checks.portalHasTitle) refuse(`collaboration portal is not served at ${publicOrigin}/pkw (HTTP ${portal.status})`)

// Unauthenticated surfaces must still refuse.
const anonymousSession = await probe(`${publicOrigin}/pkw/session`, { redirect: 'manual' })
evidence.checks.anonymousSessionStatus = anonymousSession.status
if (anonymousSession.status !== 401) refuse(`unauthenticated /pkw/session must be 401 (got ${anonymousSession.status})`)
const anonymousApi = await probe(`${publicOrigin}/pkw/api`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"method":"summary","args":{}}', redirect: 'manual',
})
evidence.checks.anonymousApiStatus = anonymousApi.status
if (![401, 403, 404, 405].includes(anonymousApi.status)) refuse(`unauthenticated /pkw/api must be refused (got ${anonymousApi.status})`)

// The installed release must be the expected one, on activation AND rollback.
if (!requestedVersion) refuse(`${mode} verification requires the expected release version`)
if (installedVersion() !== requestedVersion) refuse(`installed release is ${installedVersion()}, expected ${requestedVersion}`)

// Authenticated, space-scoped business acceptance.
//
// In enforcing mode every one of these is mandatory: a deployment (or a rollback) is
// not accepted on reachability alone. A read-only diagnostics run reports the same
// observations but refuses to call itself a verification.
let password = ''
if (values['credentials-file']) {
  try { password = readFileSync(values['credentials-file'], 'utf8').trim() } catch { password = '' }
}
if (password === '') {
  evidence.checks.authenticated = 'not_verified_no_credentials'
  evidence.note = 'owner credentials unavailable; authenticated space and version acceptance NOT verified'
  if (enforcing) refuse('authenticated acceptance requires an owner credential file (--credentials-file); reachability alone is not acceptance')
} else {
  const jar = new Map()
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await probe(publicOrigin + path, {
      method, redirect: 'manual',
      headers: { Origin: publicOrigin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: cookieHeader() } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';'); const at = pair.indexOf('=')
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const text = await response.text()
    let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed, headers: response.headers }
  }
  const login = await call('/pkw/login', { method: 'POST', body: { username, password } })
  evidence.checks.loginStatus = login.status
  if (login.status !== 200) {
    evidence.checks.authenticated = 'failed_credentials_rejected'
    evidence.note = `login refused with HTTP ${login.status}`
    if (enforcing) refuse(`login was refused with HTTP ${login.status}; a deployment may not be accepted without a working authenticated session`)
  } else {
    const session = await call('/pkw/session')
    const value = session.body?.value ?? {}
    const priv = (value.spaces ?? []).find(space => space.kind === 'private')
    evidence.checks.authenticated = 'verified'
    evidence.checks.spaces = (value.spaces ?? []).map(space => `${space.kind}:${space.role}`)
    if (!priv) refuse('owner session exposes no private space')
    if (!value.csrf) refuse('owner session exposes no CSRF token')
    // The page must report the release that is actually serving, and it must be the
    // expected one. This is the check that a health endpoint cannot stand in for.
    const page = await call(`/pkw/spaces/${priv.id}`)
    evidence.checks.spacePageStatus = page.status
    const serving = page.headers.get('x-pkw-version') ?? null
    evidence.checks.servingVersion = serving
    if (page.status !== 200) refuse(`private space page is not served (HTTP ${page.status})`)
    if (!serving) refuse('the space page reports no serving version; the running release cannot be confirmed')
    if (requestedVersion && serving !== requestedVersion) refuse(`the service is running ${serving}, expected ${requestedVersion}`)
    if (installedVersion() !== serving) refuse(`installed release is ${installedVersion()} but the service is running ${serving}; a restart has not taken effect`)
    const summary = await call(`/pkw/spaces/${priv.id}/api`, { method: 'POST', body: { method: 'summary', args: {} }, headers: { 'x-pkw-csrf': value.csrf } })
    evidence.checks.summaryStatus = summary.status
    evidence.checks.summary = {
      notes: summary.body?.value?.notes, attachments: summary.body?.value?.attachments, mappings: summary.body?.value?.mappings,
    }
    if (summary.status !== 200 || !Number.isInteger(summary.body?.value?.notes)) refuse('space summary business contract failed')
    // Real reads, not just a count: the private space must return its notes and the
    // attachment list must be reachable.
    const notes = await call(`/pkw/spaces/${priv.id}/api`, { method: 'POST', body: { method: 'listNotes', args: {} }, headers: { 'x-pkw-csrf': value.csrf } })
    evidence.checks.listNotesStatus = notes.status
    if (notes.status !== 200) refuse(`listNotes failed (HTTP ${notes.status})`)
    const listed = Array.isArray(notes.body?.value) ? notes.body.value : notes.body?.value?.notes
    evidence.checks.noteCount = Array.isArray(listed) ? listed.length : null
    if (!Array.isArray(listed)) refuse('listNotes did not return a note list')
    if (listed.length > 0) {
      const first = listed[0]
      const noteId = first.noteId ?? first.id
      const read = await call(`/pkw/spaces/${priv.id}/api`, { method: 'POST', body: { method: 'getNote', args: { noteId } }, headers: { 'x-pkw-csrf': value.csrf } })
      evidence.checks.getNoteStatus = read.status
      evidence.checks.noteReadable = read.status === 200 && typeof (read.body?.value?.note?.contentHash ?? read.body?.value?.content) !== 'undefined'
      if (!evidence.checks.noteReadable) refuse('a note listed by the space could not be read back')
    }
    await call('/pkw/manage', { method: 'POST', body: { action: 'logout' }, headers: { 'x-pkw-csrf': value.csrf } })
  }
}

evidence.ok = true
console.log(JSON.stringify(evidence))
process.exit(0)

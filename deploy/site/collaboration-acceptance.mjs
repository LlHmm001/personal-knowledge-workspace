/**
 * Activation and rollback acceptance for the collaboration service, as the deployment CLI
 * actually uses it.
 *
 * The deployment calls this twice, for two different questions:
 *
 *   activate   is the release that was just promoted serving what it claims?
 *   rollback   did the release that was brought back actually come back, and is it acceptable?
 *
 * Four observations, never substituted for one another, and reported separately so a failure can
 * be read without guessing which one it was:
 *
 *   reach     the endpoint answered at all (a status and, on failure, a transport error)
 *   auth      the owner session was established
 *   version   the version actually served equals the expected one
 *   content   a note could be read back through the authenticated API
 *
 * `ok` is true only when all four hold. The verifier's own report is kept under `verifier` so the
 * detail behind a refusal is not lost, and `checks` carries the two fields the switch's
 * acceptance contract requires.
 *
 * Transport is bounded: every probe has a deadline, and a timeout is a refusal, never a hang.
 */
const DEFAULT_TIMEOUT_MS = 4000

/** The bounded HTTP probe used for the reachability observation. */
async function defaultFetch(url, options = {}) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: options.headers })
    return { status: response.status }
  } catch (error) {
    return { status: null, error: error.name === 'AbortError' ? `timed out after ${timeout}ms` : (error.message ?? String(error)) }
  } finally { clearTimeout(timer) }
}

/**
 * Observe reachability on its own. This is infrastructure: it says the endpoint answered, and
 * nothing about whether what it serves is acceptable.
 */
export async function observeReachability({ url, fetchImpl = defaultFetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!url) return { checked: false, reachable: false, status: null, url: null, error: 'no reachable URL was configured' }
  const result = await fetchImpl(url, { timeoutMs })
  if (result && Number.isInteger(result.status)) {
    return { checked: true, reachable: result.status >= 200 && result.status < 400, status: result.status, url }
  }
  return { checked: true, reachable: false, status: null, url, error: result?.error ?? 'the probe produced no status' }
}

/** Run the enforcing verifier as a subprocess, under a deadline. */
export async function defaultRunVerifier({ hook, expectedVersion, mode, timeoutMs = 30000, spawnImpl = null }) {
  const { spawn } = spawnImpl ? { spawn: spawnImpl } : await import('node:child_process')
  return new Promise((resolvePromise) => {
    const child = spawn(hook, ['--expected-version', expectedVersion, '--mode', mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(value) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ code: null, stdout: out, stderr: err, error: `the verifier did not finish within ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.once('error', error => finish({ code: null, stdout: out, stderr: err, error: error.message }))
    child.once('exit', code => finish({ code, stdout: out, stderr: err, error: null }))
  })
}

/** The last JSON object the verifier printed, or null when it printed none. */
export function parseVerifierReport(stdout) {
  const lines = String(stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* not the JSON line */ }
  }
  return null
}

/**
 * The whole acceptance question, reported in four parts.
 *
 * `expectedVersion` is required: an acceptance that does not know which version it is accepting
 * cannot accept anything, and saying so is more useful than a version check that passes by
 * accident.
 */
export async function probeAcceptance({ url, hook, expectedVersion, mode = 'activate', fetchImpl = defaultFetch, runVerifier = defaultRunVerifier, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const reported = {
    mode,
    expectedVersion: expectedVersion ?? null,
    ok: false, enforcing: true,
    // What the probe was asked to do, kept apart from what it observed: a missing configuration
    // is not an observation about the service.
    config: { url: url ?? null, hook: hook ?? null, complete: true },
    reach: { checked: false, reachable: false, status: null, error: null },
    auth: { verified: false, detail: 'not attempted' },
    version: { expected: expectedVersion ?? null, served: null, matches: false, detail: 'not attempted' },
    content: { readable: false, detail: 'not attempted' },
    checks: {},
    verifier: null,
  }
  const incomplete = !url ? 'no reachable URL was configured'
    : !hook ? 'no acceptance hook was configured'
      : !expectedVersion ? 'no expected version was configured' : null
  if (incomplete) { reported.config.complete = false; reported.config.error = incomplete; return reported }

  // 1. Reachability, on its own and bounded.
  const reach = await observeReachability({ url, fetchImpl, timeoutMs })
  reported.reach = { checked: reach.checked, reachable: reach.reachable, status: reach.status, error: reach.error ?? null }
  if (!reach.reachable) return reported

  // 2. The enforcing verifier, which answers authentication, version and content.
  const run = await runVerifier({ hook, expectedVersion, mode })
  const verdict = parseVerifierReport(run.stdout)
  reported.verifier = verdict
  if (!verdict) {
    reported.auth.detail = 'the verifier produced no report'
    reported.auth.detail = run.error ?? (String(run.stderr ?? '').trim() || `the verifier exited ${run.code}`)
    return reported
  }

  const checks = verdict.checks ?? {}
  reported.auth = {
    verified: checks.authenticated === 'verified',
    detail: checks.authenticated ?? 'not reported',
  }
  const served = checks.servingVersion ?? null
  reported.version = {
    expected: expectedVersion,
    served,
    matches: served === expectedVersion,
    detail: served === null ? 'the verifier reported no serving version' : `serving ${served}`,
  }
  reported.content = {
    readable: checks.noteReadable === true,
    detail: checks.noteReadable === true ? 'a note was read back' : (checks.noteReadable === false ? 'a note could not be read back' : 'not reported'),
  }

  // The switch's contract: report the two fields acceptance depends on, and let it decide.
  reported.checks = {
    authenticated: reported.auth.verified ? 'verified' : (checks.authenticated ?? 'not_verified'),
    ...(served === null ? {} : { servingVersion: served }),
  }
  reported.ok = reported.enforcing === true && reported.auth.verified && reported.version.matches && reported.content.readable
    && verdict.ok === true && verdict.enforcing === true
  return reported
}

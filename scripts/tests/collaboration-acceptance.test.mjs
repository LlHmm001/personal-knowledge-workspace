/**
 * Acceptance for the deployment CLI, on synthetic observations only.
 *
 * The four observations are separate on purpose, and these cases are the ways they could be
 * confused for one another:
 *
 *   - an endpoint that answers but serves nothing acceptable is reachable, not accepted;
 *   - a verifier that authenticated correctly but serves the wrong version is authenticated, not
 *     accepted;
 *   - a verifier that reports ok without enforcing, or without a note read-back, is not accepted;
 *   - a verifier that produces no report at all is a refusal.
 *
 * Nothing here contacts a real service: the reachability probe and the verifier runner are both
 * injected, and the verifier's report is given as text, exactly as the CLI would read it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { probeAcceptance, observeReachability, parseVerifierReport, defaultRunVerifier } from '../../deploy/site/collaboration-acceptance.mjs'
import { assertAcceptance } from '../../deploy/switch-release.mjs'

const VERSION = '0.1.8-pkw.9'
const PREVIOUS = '0.1.2-pkw.4'
const URL = 'http://127.0.0.1:3081/pkw'

/**
 * A verifier report in the shape the enforcing verifier prints. `ok` defaults to what the checks
 * imply, so a case that means to test one observation can state that observation alone; the
 * explicit `ok: false` cases are the ones where the verifier disagrees with its own checks.
 */
const report = ({ ok, enforcing = true, authenticated = 'verified', servingVersion = VERSION, noteReadable = true } = {}) => {
  const complete = enforcing && authenticated === 'verified' && servingVersion !== null && noteReadable === true
  return JSON.stringify({
    ok: ok ?? complete, enforcing, requestedVersion: VERSION, mode: 'activate',
    checks: { authenticated, servingVersion, noteReadable },
  })
}

const verifyRunner = ({ stdout, stderr = '', code = 0, error = null } = {}) => async () => ({ stdout, stderr, code, error })

/** A reachability probe that answers with one status, or fails. */
const fetchFor = result => async () => result

test('acceptance: an unreachable service is reported as unreachable, and nothing else is claimed', async () => {
  const result = await probeAcceptance({
    url: URL, hook: '/nonexistent/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: null, error: 'connect ECONNREFUSED' }),
    runVerifier: async () => { throw new Error('the verifier must not run when the service is unreachable') },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.reach, { checked: true, reachable: false, status: null, error: 'connect ECONNREFUSED' })
  // Authentication, version and content were never observed, and each says so.
  assert.equal(result.auth.verified, false)
  assert.equal(result.auth.detail, 'not attempted')
  assert.equal(result.version.matches, false)
  assert.equal(result.version.detail, 'not attempted')
  assert.equal(result.content.readable, false)
  assert.equal(result.content.detail, 'not attempted')
  assert.equal(result.verifier, null)
})

test('acceptance: reachable but not acceptable is refused, and the two are reported separately', async () => {
  // The service answers on the socket with a 404: reachable in the transport sense, serving
  // nothing this deployment may accept.
  const result = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 404 }),
    runVerifier: verifyRunner({ stdout: report({ authenticated: 'failed_credentials_rejected' }) }),
  })
  assert.deepEqual(result.reach, { checked: true, reachable: false, status: 404, error: null })
  assert.equal(result.ok, false, 'a 404 is not reachability, let alone acceptance')
  assert.ok(!('authenticated' in result.checks) || result.checks.authenticated !== 'verified')

  // Now the endpoint answers 200 but the verifier's checks do not hold. Reachability is verified;
  // acceptance is not, and the report says which observation failed.
  const answered = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    runVerifier: verifyRunner({ stdout: report({ authenticated: 'failed_credentials_rejected' }) }),
  })
  assert.deepEqual(answered.reach, { checked: true, reachable: true, status: 200, error: null })
  assert.equal(answered.ok, false)
  assert.equal(answered.auth.verified, false)
  assert.equal(answered.auth.detail, 'failed_credentials_rejected')
  assert.equal(answered.version.matches, true, 'the version really was served')
  assert.equal(answered.content.readable, true)
  assert.equal(answered.checks.authenticated, 'failed_credentials_rejected')
  // The switch's acceptance contract refuses it, with the reason it was given.
  assert.throws(() => assertAcceptance(answered, { expectedVersion: VERSION, label: 'activation verification' }), /authenticated/)
})

test('acceptance: a success report followed by a non-zero exit is refused', async () => {
  // The report every check would accept, printed by a process that then failed. The payload may
  // not cover the failure of the run that produced it.
  for (const mode of ['activate', 'rollback']) {
    const result = await probeAcceptance({
      url: URL, hook: '/verifier', expectedVersion: VERSION, mode,
      fetchImpl: fetchFor({ status: 200 }),
      runVerifier: verifyRunner({ stdout: report({ ok: true }), code: 1 }),
    })
    assert.equal(result.ok, false, `${mode}: a non-zero exit must refuse`)
    assert.deepEqual(result.run, { code: 1, error: null, stderr: null, failure: 'the verifier exited 1' })
    assert.equal(result.failure.stage, 'verifier-run')
    assert.throws(() => assertAcceptance(result, { expectedVersion: VERSION, label: `${mode} verification` }))
  }
  // A report that says the checks failed, printed by a process that exited 1, is refused for the
  // process: the two findings are reported, not merged into one.
  const both = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    runVerifier: verifyRunner({ stdout: report({ authenticated: 'failed_credentials_rejected' }), stderr: 'login refused\n', code: 1 }),
  })
  assert.equal(both.ok, false)
  assert.deepEqual(both.run, { code: 1, error: null, stderr: 'login refused', failure: 'the verifier exited 1' })
})

test('acceptance: a success report followed by a timeout is refused', async () => {
  for (const mode of ['activate', 'rollback']) {
    const result = await probeAcceptance({
      url: URL, hook: '/verifier', expectedVersion: VERSION, mode,
      fetchImpl: fetchFor({ status: 200 }),
      // The runner killed the verifier on its deadline: it printed a success report first, which is
      // exactly the case where the payload must not be believed.
      runVerifier: verifyRunner({ stdout: report({ ok: true }), code: null, error: 'the verifier did not finish within 30000ms' }),
    })
    assert.equal(result.ok, false, `${mode}: a timeout must refuse`)
    assert.equal(result.run.code, null)
    assert.equal(result.run.failure, 'the verifier did not finish within 30000ms')
    assert.equal(result.failure.stage, 'verifier-run')
    assert.throws(() => assertAcceptance(result, { expectedVersion: VERSION, label: `${mode} verification` }))
  }
})

test('acceptance: a verifier that could not be started is refused', async () => {
  const result = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    runVerifier: verifyRunner({ stdout: report({ ok: true }), code: null, error: 'spawn /verifier ENOENT' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.run.failure, 'spawn /verifier ENOENT')
  assert.equal(result.checks.authenticated, undefined, 'nothing may be published from a run that did not happen')
})

test('acceptance: a wrong serving version is refused even with a working session', async () => {
  const result = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    runVerifier: verifyRunner({ stdout: report({ servingVersion: PREVIOUS }) }),
  })
  assert.deepEqual(result.reach, { checked: true, reachable: true, status: 200, error: null })
  assert.equal(result.auth.verified, true, 'the session was established')
  assert.equal(result.version.served, PREVIOUS)
  assert.equal(result.version.matches, false)
  assert.equal(result.version.detail, `serving ${PREVIOUS}`)
  assert.equal(result.ok, false, 'authentication is not acceptance')
  assert.throws(() => assertAcceptance(result, { expectedVersion: VERSION, label: 'activation verification' }), /serving/)
})

test('acceptance: a note that cannot be read back is a refusal', async () => {
  const result = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    runVerifier: verifyRunner({ stdout: report({ noteReadable: false }) }),
  })
  assert.equal(result.auth.verified, true)
  assert.equal(result.version.matches, true)
  assert.deepEqual(result.content, { readable: false, detail: 'a note could not be read back' })
  assert.equal(result.ok, false)
})

test('acceptance: a verifier that does not enforce is never accepted', async () => {
  const result = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    // A diagnostics-style report: everything looks verified, but the run never enforced anything.
    runVerifier: verifyRunner({ stdout: JSON.stringify({ ok: true, enforcing: false, checks: { authenticated: 'verified', servingVersion: VERSION, noteReadable: true } }) }),
  })
  assert.equal(result.ok, false, 'a non-enforcing report may never gate a deployment')
  assert.throws(() => assertAcceptance(result, { expectedVersion: VERSION, label: 'activation verification' }))
})

test('acceptance: a verifier that produces no report is refused without hanging', async () => {
  const result = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    runVerifier: verifyRunner({ stderr: 'TypeError: fetch failed', code: 0 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.verifier, null)
  assert.equal(result.auth.detail, 'TypeError: fetch failed')
  assert.equal(result.checks.authenticated, undefined)
  assert.throws(() => assertAcceptance(result, { expectedVersion: VERSION, label: 'rollback acceptance' }))
})

test('acceptance: only all four observations together are accepted', async () => {
  const result = await probeAcceptance({
    url: URL, hook: '/verifier', expectedVersion: VERSION,
    fetchImpl: fetchFor({ status: 200 }),
    runVerifier: verifyRunner({ stdout: report({ ok: true, servingVersion: VERSION }) }),
  })
  assert.deepEqual(result.reach, { checked: true, reachable: true, status: 200, error: null })
  assert.equal(result.auth.verified, true)
  assert.equal(result.version.matches, true)
  assert.equal(result.content.readable, true)
  assert.equal(result.ok, true)
  // The switch accepts exactly this shape, and reports the serving version it accepted.
  const accepted = assertAcceptance(result, { expectedVersion: VERSION, label: 'activation verification' })
  assert.equal(accepted.checks.servingVersion, VERSION)
})

test('acceptance: a missing URL, hook or expected version refuses before probing', async () => {
  let probed = 0
  const fetchImpl = async () => { probed += 1; return { status: 200 } }
  const noUrl = await probeAcceptance({ url: null, hook: '/verifier', expectedVersion: VERSION, fetchImpl })
  assert.equal(noUrl.ok, false)
  assert.deepEqual(noUrl.config, { url: null, hook: '/verifier', complete: false, error: 'no reachable URL was configured' })
  const noHook = await probeAcceptance({ url: URL, hook: null, expectedVersion: VERSION, fetchImpl })
  assert.equal(noHook.ok, false)
  assert.equal(noHook.config.error, 'no acceptance hook was configured')
  const noVersion = await probeAcceptance({ url: URL, hook: '/verifier', expectedVersion: null, fetchImpl })
  assert.equal(noVersion.ok, false)
  assert.equal(noVersion.config.error, 'no expected version was configured')
  // An incomplete configuration is refused without probing anything.
  assert.equal(probed, 0, 'nothing may be probed with an incomplete configuration')
})

test('acceptance: observeReachability treats a 3xx as reachable and a transport failure as not', async () => {
  assert.equal((await observeReachability({ url: URL, fetchImpl: fetchFor({ status: 302 }) })).reachable, true)
  assert.equal((await observeReachability({ url: URL, fetchImpl: fetchFor({ status: 500 }) })).reachable, false)
  const failed = await observeReachability({ url: URL, fetchImpl: fetchFor({ status: null, error: 'boom' }) })
  assert.deepEqual(failed, { checked: true, reachable: false, status: null, url: URL, error: 'boom' })
  const observed = await observeReachability({ url: URL, fetchImpl: async () => ({ status: 200 }) })
  assert.equal(observed.reachable, true)
})

test('acceptance: the verifier report is read from the last JSON line only', () => {
  assert.deepEqual(parseVerifierReport('noise\n{"ok":true,"checks":{}}\n'), { ok: true, checks: {} })
  assert.equal(parseVerifierReport('noise only\n'), null)
  assert.equal(parseVerifierReport(''), null)
})

test('acceptance: a verifier that never finishes is refused by the deadline', async () => {
  // A child that cannot exit stands in for a hung verifier. The runner kills it and reports a
  // refusal rather than waiting forever.
  const { spawn } = await import('node:child_process')
  const result = await defaultRunVerifier({
    hook: process.execPath, expectedVersion: VERSION, mode: 'activate', timeoutMs: 300,
    spawnImpl: (command, args, options) => spawn(command, ['-e', 'setInterval(() => {}, 1000)'], options),
  })
  assert.equal(result.code, null)
  assert.match(result.error, /did not finish within 300ms/)
})

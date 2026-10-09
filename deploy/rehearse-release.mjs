#!/usr/bin/env node
/**
 * Rehearsal driver: runs the ONE supported switch transaction against copies.
 *
 * There is no second pipeline here. `deploy/switch-release.mjs` owns install,
 * promotion, rollback and recovery; this file only supplies isolated inputs and
 * injectable failures, so a rehearsal exercises the same code a real deployment runs:
 *
 *   - the release root, the profile copies and the data copy are created by this
 *     driver, and the data copy comes from `scripts/copy-data-root.mjs`, which snapshots
 *     the databases and writes straight to the final destination;
 *   - stop/start manage this driver's own listener on its own port, never a real unit;
 *   - injectable failures: a failing install, a candidate modified after the install
 *     while the service is stopped, and a failing verification.
 *
 * Every phase is written to `report.json` so a caller asserts on facts.
 */
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { copyDataRoot, verifyExistingCopy, isNotIsolated } from '../scripts/copy-data-root.mjs'
import { startLoopbackRegistry } from './site/loopback-registry.mjs'
import { listenerManager } from './site/process-stop-state.mjs'

/** A declared old version is a check, never permission to relabel copied code. */
export async function assertRehearsalProfileVersion(profile, expectedVersion) {
  const scope = join(profile, 'node_modules/@deepseek-ai')
  const names = (await readdir(scope)).filter(name => name.startsWith('dsh-pkw-')).sort()
  if (!names.includes('dsh-pkw-web')) throw new Error('the source profile contains no PKW web package')
  const packages = []
  for (const name of names) {
    const manifest = JSON.parse(await readFile(join(scope, name, 'package.json'), 'utf8'))
    if (manifest.name !== `@deepseek-ai/${name}` || manifest.version !== expectedVersion) {
      const error = new Error(`source package ${name} declares ${manifest.version}, expected ${expectedVersion}; old releases must not be relabelled`)
      error.code = 'PKW_REHEARSAL_SOURCE_VERSION_MISMATCH'
      throw error
    }
    packages.push({ name: manifest.name, version: manifest.version })
  }
  return packages
}

/** Preserve both the stop outcome and its independent observation, including failures. */
export async function stopRehearsalListener(manager) {
  const result = { ok: false, stop: null, evidence: null, errors: [] }
  try { result.stop = await manager.stop() } catch (error) { result.errors.push({ phase: 'stop', message: error.message }) }
  try { result.evidence = await manager.isStopped() } catch (error) { result.errors.push({ phase: 'probe', message: error.message }) }
  result.ok = result.errors.length === 0 && result.evidence?.known === true && result.evidence.stopped === true
    && (result.stop?.requested === false || result.stop?.graceful === true)
  result.confirmed = result.evidence?.known === true && result.evidence.stopped === true
  result.error = result.ok ? null : { code: 'PKW_REHEARSAL_CLEANUP_FAILED', message: 'owned listener cleanup was not graceful and independently confirmed' }
  return result
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function runRehearsal(args = process.argv.slice(2)) {
const { values } = parseArgs({ args, options: {
  'work-dir': { type: 'string' }, 'data-source': { type: 'string' }, 'profile-source': { type: 'string' },
  'artifact-dir': { type: 'string' }, version: { type: 'string' }, port: { type: 'string' },
  'old-version': { type: 'string' }, 'store-dir': { type: 'string' }, 'bootstrap-username': { type: 'string' },
  'force-verify-failure': { type: 'boolean', default: false },
  'bootstrap-password': { type: 'string' },
  // The account the data root already carries, which is what a verifier has to log in with. The
  // bootstrap password only exists to create a fresh owner, so the two are not the same secret.
  'owner-password': { type: 'string' },
  // Set the copy's own account password to `--owner-password` before anything is started. A
  // rehearsal owns its copy, and the copy's account is the one a verifier has to log in with;
  // without this the rehearsal depends on a secret it was never given.
  'set-owner-password': { type: 'boolean', default: false },
  'fail-install': { type: 'boolean', default: false },
  'modify-candidate-after-install': { type: 'boolean', default: false },
  // Write a note and an attachment through the real API while the new release serves, so the
  // rollback can be asked whether the restored release reads data the new release committed.
  'write-during-serve': { type: 'boolean', default: false },
  // Optional: pin the attachment mode a site expects. Without it the read-back compares against the
  // mode the write itself produced, which is what a restore actually has to preserve.
  'expect-mode': { type: 'string' },
  // Rehearsal counterexample: make the *real* write fail (a genuine API failure) while the injected
  // fault is requested. This exists to prove the run refuses instead of relabelling a broken release
  // as the expected fault, so it is a flag of the rehearsal and never part of a deployment path.
  'break-write': { type: 'string' },
} })
if (!values['work-dir'] || !values['data-source'] || !values['profile-source'] || !values['artifact-dir'] || !values.version || !values.port || !values['old-version']) {
  process.stderr.write('Usage: node deploy/rehearse-release.mjs --work-dir NEW_DIR --data-source DIR --profile-source DIR --artifact-dir DIR --version V --old-version V --port N [--fail-install] [--modify-candidate-after-install] [--force-verify-failure]\n  [--write-during-serve] [--expect-mode OCTAL] [--store-dir DIR] [--owner-password P] [--set-owner-password]\n')
  return 2
}
const workDir = resolve(values['work-dir'])
const version = values.version
const port = Number(values.port)
const oldVersion = values['old-version']
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer from 1 to 65535')
if (oldVersion === version) throw new Error('the new and old release versions must differ')
const sourcePackages = await assertRehearsalProfileVersion(resolve(values['profile-source']), oldVersion)
const report = { version, oldVersion, workDir, port, phases: {}, startedAt: new Date().toISOString() }

// A prior pid file is not ownership evidence. Never adopt or signal a previous run's process.
await mkdir(workDir, { mode: 0o700 })
const root = join(workDir, 'root')
const logDir = join(workDir, 'logs')
await mkdir(logDir, { recursive: true, mode: 0o700 })

// ── the release in service: a copy of the verified old profile, without changing its version
const oldRelease = join(root, 'releases', oldVersion, 'profile')
if (!existsSync(join(oldRelease, 'package.json'))) {
  await mkdir(join(root, 'releases'), { recursive: true })
  await cp(resolve(values['profile-source']), oldRelease, { recursive: true, dereference: false, verbatimSymlinks: true })
  await writeFile(join(oldRelease, 'pnpm-workspace.yaml'), 'packages: []\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  // The seed carries the profile's own `.npmrc`, which pins the registry the profile was built
  // from — a one-off loopback registry that is gone by the time a rehearsal runs. Left in place it
  // makes every install hang against a dead port. The transaction passes its own registry
  // explicitly, so the seed's pinned one is removed here and the rehearsal uses the live one.
  await rm(join(oldRelease, '.npmrc'), { force: true })
  await assertRehearsalProfileVersion(oldRelease, oldVersion)
  await symlink(join('releases', oldVersion), join(root, 'current'))
  report.phases.seedRelease = { from: resolve(values['profile-source']), to: oldRelease, oldVersion, packages: sourcePackages }
}

// ── the data copy: the shared copier writes straight to the final destination, and the library
// itself refuses a copy that is not isolated from its source. The refusal is reported here with
// the findings the library attached, and the rehearsal stops: nothing is configured and no
// listener is started on a copy that failed the gate. The copy is left in place for inspection.
const dataRoot = join(workDir, 'data')
/**
 * Report a refused data copy and stop the rehearsal. Nothing is configured and no listener is
 * started, and the directory is left exactly as it is: a failure that is cleaned up cannot be
 * inspected, and a failure that is reused silently is worse than either.
 */
async function refuseDataRoot(error, phase) {
  report.status = 'copy-not-self-contained'
  report.phases.copyData = {
    to: dataRoot, preserved: true, reused: phase === 're-verified',
    leaks: error.leaks ?? [], writableProblems: error.writableProblems ?? [],
    databases: error.databases ?? [], rewritten: error.rewritten ?? [],
  }
  await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.error(JSON.stringify({
    status: report.status, phase, message: error.message, target: dataRoot, preserved: true,
    leaks: (error.leaks ?? []).slice(0, 3), writableProblems: (error.writableProblems ?? []).slice(0, 3),
  }, null, 2))
  const refusal = new Error('the rehearsal data copy is not isolated')
  refusal.code = 'PKW_REHEARSAL_COPY_NOT_ISOLATED'
  throw refusal
}
// An existing data directory is re-verified in full, never trusted because it is there. A copy
// that failed the gate is deliberately kept on disk, so the next run of the same work directory
// finds exactly the copy that was refused; and a directory that was left by an interrupted run is
// not known to be complete either. `identity.sqlite` existing says only that something wrote here.
if (existsSync(join(dataRoot, 'identity.sqlite'))) {
  let verified
  try {
    verified = await verifyExistingCopy(resolve(values['data-source']), dataRoot)
  } catch (error) {
    if (!isNotIsolated(error)) throw error
    await refuseDataRoot(error, 're-verified')
  }
  report.phases.copyData = {
    to: dataRoot, reloaded: true,
    leaks: verified.leaks.length, writableProblems: verified.writableProblems.length,
  }
} else {
  let copy
  try {
    copy = await copyDataRoot(resolve(values['data-source']), dataRoot)
  } catch (error) {
    if (!isNotIsolated(error)) throw error
    await refuseDataRoot(error, 'copied')
  }
  report.phases.copyData = {
    to: dataRoot, databases: copy.databases.length, rewritten: copy.rewritten.length,
    leaks: 0, writableProblems: 0,
  }
}

const { switchRelease, currentRelease, checkReachable } = await import('./switch-release.mjs')

// The copy's account is what every later step logs in with, so it is set explicitly rather than
// assumed. The hash format is the one the runtime validates; the salt is fresh per run.
if (values['set-owner-password'] || values['owner-password']) {
  const { scrypt, randomBytes } = await import('node:crypto')
  const { promisify } = await import('node:util')
  const { DatabaseSync } = await import('node:sqlite')
  const username = values['bootstrap-username'] ?? 'owner'
  const password = values['owner-password'] ?? values['bootstrap-password'] ?? 'rehearsal-password'
  const salt = randomBytes(16).toString('hex')
  const derived = await promisify(scrypt)(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  const identity = new DatabaseSync(join(dataRoot, 'identity.sqlite'))
  try {
    const changed = identity.prepare('UPDATE accounts SET password=? WHERE username=?').run(`scrypt-v1:${salt}:${derived.toString('hex')}`, username)
    if (changed.changes !== 1) throw new Error(`the data copy has no account named ${username}: ${changed.changes} rows changed`)
  } finally { identity.close() }
  report.phases.setOwnerPassword = { username, changed: 1 }
}

// ── hooks: one listener on this driver's port, resolved through `current`
const configPath = join(workDir, 'collaboration.json')
await writeFile(configPath, JSON.stringify({
  dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: values['bootstrap-username'] ?? 'owner',
  bootstrapPasswordEnv: 'PKW_REHEARSAL_BOOTSTRAP',
}, null, 2) + '\n', { mode: 0o600 })
const pidFile = join(workDir, 'listener.pid')
const manager = listenerManager({
  root, port, dataRoot, configPath, pidFile, logDir, repoRoot, scriptsDir: join(repoRoot, 'scripts'),
  password: 'synthetic', bootstrapEnv: 'PKW_REHEARSAL_BOOTSTRAP',
})
report.listenerHistory = []
const interruption = new AbortController()
let startingListener = null
let interruptedCleanup = null
const onSignal = signal => {
  if (interruption.signal.aborted) return
  const error = new Error(`rehearsal interrupted by ${signal}`)
  error.code = 'PKW_REHEARSAL_INTERRUPTED'
  report.interruption = { signal, code: error.code }
  interruption.abort(error)
  // A startup already underway must finish recording its child before cleanup claims absence.
  interruptedCleanup = (async () => {
    await startingListener?.catch(() => {})
    report.cleanup = await stopRehearsalListener(manager)
    report.status = error.code
    report.exit = { code: 1, cleanupConfirmed: report.cleanup.confirmed }
    await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  })().catch(failure => {
    report.cleanup = { ok: false, confirmed: false, error: { code: 'PKW_REHEARSAL_CLEANUP_FAILED', message: failure.message } }
    console.error(JSON.stringify({ status: 'interrupted-cleanup-failed', message: failure.message }))
  })
}
const onTerm = () => onSignal('SIGTERM'), onInt = () => onSignal('SIGINT')
process.on('SIGTERM', onTerm); process.on('SIGINT', onInt)
const stopHook = async () => {
  const outcome = await stopRehearsalListener(manager)
  report.phases.stop = outcome
  report.listenerHistory.push({ action: 'stop', ...outcome })
  if (!outcome.ok) throw new Error('the owned listener did not stop gracefully with independently confirmed absence')
  return outcome
}
/** The site's own answer to "is it stopped?", used when a stop reports failure. */
const isStopped = () => manager.isStopped()

/**
 * Run the official collaboration verifier in enforcing mode, passing the release version
 * through the same parameter name the official CLI uses, so the parameter combination is
 * exercised rather than assumed.
 */
async function runVerifier(expectedVersion, mode) {
  const credentialsFile = join(workDir, 'owner-password')
  const ownerPassword = values['owner-password'] ?? values['bootstrap-password'] ?? 'rehearsal-password'
  // Rewritten every run: a rehearsal that reused a stale file would report a credential failure
  // for a password that is no longer the one it was given.
  await writeFile(credentialsFile, `${ownerPassword}\n`, { mode: 0o600 })
  const args = [
    join(repoRoot, 'deploy/site/verify-collaboration.mjs'),
    '--mode', mode, '--profile', join(await currentRelease(root), 'profile'),
    '--public-origin', `http://127.0.0.1:${port}`, '--gateway-url', `http://127.0.0.1:${port}`,
    '--credentials-file', credentialsFile, '--username', values['bootstrap-username'] ?? 'owner',
    '--expected-version', expectedVersion,
  ]
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], signal: interruption.signal, timeout: 60_000 })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolvePromise(out) : reject(new Error(out.trim().split('\n').slice(-3).join(' | ') || `verifier exited ${code}`)))
  })
  return JSON.parse(output.trim().split('\n').filter(Boolean).slice(-1)[0])
}
/**
 * Write through the real collaboration API, as a deployment's own smoke test would.
 *
 * The note and the attachment are created through the same JSON-RPC surface the UI uses, and the
 * bytes and the markers are kept so a later step can ask the restored release to read them back.
 */
/**
 * Compare the stored attachment with the bytes that were uploaded, and read its permissions.
 *
 * The product stores attachments under the space's workspace; the comparison is made on that copy,
 * which is the one a future reader will be served from, and the sha256 is what the upload recorded.
 */
/**
 * Compare the stored attachment with the state the write itself left behind.
 *
 * The comparison is against the baseline recorded at write time — the file, its bytes, its sha256
 * and its mode — not against a constant written here. A restore has to preserve what the write
 * produced; an expectation invented in this script would only ever test this script, and it could
 * disagree with the product in either direction without anyone noticing. `--expect-mode` exists for
 * a site that also wants to pin the mode, and says so in the report when it does.
 */
async function compareAttachment(served) {
  const baseline = served.attachmentBaseline ?? null
  if (!baseline) return { ok: false, reason: 'the write recorded no attachment baseline, so there is nothing to compare against' }
  const current = await inspectStoredAttachment(served.spaceId, served.attachmentId)
  if (!current.ok) return { ok: false, reason: current.reason, baseline, stored: current.stored ?? null }
  const differs = []
  if (current.file !== baseline.file) differs.push(`file ${baseline.file} -> ${current.file}`)
  if (current.bytes !== baseline.bytes) differs.push(`bytes ${baseline.bytes} -> ${current.bytes}`)
  if (current.sha256 !== baseline.sha256) differs.push(`sha256 ${baseline.sha256.slice(0, 12)} -> ${current.sha256.slice(0, 12)}`)
  if (current.mode !== baseline.mode) differs.push(`mode ${baseline.mode} -> ${current.mode}`)
  const expectedMode = values['expect-mode'] ?? null
  if (expectedMode && current.mode !== expectedMode) differs.push(`mode ${current.mode} is not the configured ${expectedMode}`)
  return {
    ok: differs.length === 0,
    file: current.file, bytes: current.bytes, sha256: current.sha256, mode: current.mode,
    baseline, expectedMode,
    ...(differs.length > 0 ? { reason: `the restored attachment differs from the write baseline: ${differs.join('; ')}` } : {}),
  }
}

function apiClient() {
  const origin = `http://127.0.0.1:${port}`
  const jar = new Map()
  const call = async (path, { method = 'GET', body, csrf } = {}) => {
    const headers = { Origin: origin }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (csrf) headers['X-PKW-CSRF'] = csrf
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.any([interruption.signal, AbortSignal.timeout(30_000)]) })
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';'); const at = pair.indexOf('=')
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    const text = await response.text()
    let parsed; try { parsed = JSON.parse(text) } catch { parsed = text }
    return { status: response.status, body: parsed }
  }
  return { call }
}

/**
 * Ask the release that is serving now to read back what an earlier release wrote.
 *
 * This is the question a rollback has to answer: not "something answers on the socket" but "the
 * release that came back can log in and read the data the release being replaced committed".
 */
async function readServedWriteBack(label) {
  const served = JSON.parse(await readFile(join(workDir, 'served-write.json'), 'utf8'))
  const { call } = apiClient()
  const login = await call('/pkw/login', { method: 'POST', body: { username: values['bootstrap-username'] ?? 'owner', password: values['owner-password'] ?? values['bootstrap-password'] ?? 'rehearsal-password' } })
  if (login.status !== 200) return { label, login: login.status, ok: false, reason: `login was refused with HTTP ${login.status}` }
  const session = await call('/pkw/session')
  const read = await call(`/pkw/spaces/${served.spaceId}/api`, { method: 'POST', body: { method: 'getNote', args: { noteId: served.noteId } }, csrf: session.body.value.csrf })
  if (read.status !== 200) return { label, login: 200, read: read.status, ok: false, reason: `getNote answered HTTP ${read.status}: ${JSON.stringify(read.body).slice(0, 200)}` }
  const text = JSON.stringify(read.body.value)
  // The attachment the replaced release uploaded is compared byte for byte against what was sent,
  // and its permissions are read as well: a restore that loses the bytes or the mode is not a
  // restore of the same data.
  const attachment = await compareAttachment(served)
  return {
    label, login: 200, read: 200, ok: text.includes(served.marker) && attachment.ok,
    attachment,
    revision: read.body.value.note?.observedRevision ?? null,
    marker: served.marker, attachmentId: served.attachmentId,
    attachmentSha256: served.attachmentSha256, attachmentBytes: served.attachmentBytes,
    reason: text.includes(served.marker) ? null : 'the note the previous release wrote was not found in the body',
  }
}

async function writeThroughApi() {
  const { call } = apiClient()
  if (values['break-write']) {
    // A real failure on the real endpoint: a plain file is placed where the note's parent directory
    // belongs, so the product's own mkdir fails and the API answers an error. Nothing is faked and
    // no product rule is bypassed — this only makes the write impossible.
    const brokenPath = `rehearsal/broken-${randomUUID().slice(0, 8)}.md`
    const spaceId = await onlySpaceId()
    const blocker = join(dataRoot, 'spaces', spaceId, 'workspace', 'notes', 'rehearsal')
    await writeFile(blocker, 'this file stands where the note directory belongs\n', { mode: 0o600 })
    report.phases.writeFault = { kind: 'counterexample', brokenPath, blocker }
    const login0 = await call('/pkw/login', { method: 'POST', body: { username: values['bootstrap-username'] ?? 'owner', password: values['owner-password'] ?? values['bootstrap-password'] ?? 'rehearsal-password' } })
    if (login0.status !== 200) throw new Error(`the counterexample could not even log in (${login0.status})`)
    const session0 = await call('/pkw/session')
    const attempt = await call(`/pkw/spaces/${spaceId}/api`, { method: 'POST', body: { method: 'createNote', args: { relativePath: brokenPath, markdown: '# counterexample\n' } }, csrf: session0.body.value.csrf })
    report.phases.writeFault.status = attempt.status
    report.phases.writeFault.body = attempt.body
    if (attempt.status === 200) {
      // The write succeeded, so this counterexample has nothing to say: say that, instead of
      // reporting a failure that did not happen.
      throw new Error('the counterexample did not manage to make the write fail; the write succeeded')
    }
    throw new Error(`writing during serve: the release refused a real write (HTTP ${attempt.status}): ${JSON.stringify(attempt.body).slice(0, 300)}`)
  }
  const login = await call('/pkw/login', { method: 'POST', body: { username: values['bootstrap-username'] ?? 'owner', password: values['owner-password'] ?? values['bootstrap-password'] ?? 'rehearsal-password' } })
  if (login.status !== 200) throw new Error(`writing during serve: login was refused with HTTP ${login.status}`)
  const session = await call('/pkw/session')
  const value = session.body.value
  const space = (value.spaces ?? []).find(entry => entry.kind === 'private') ?? (value.spaces ?? [])[0]
  if (!space) throw new Error('writing during serve: the session exposes no space')
  const marker = `written-during-serve-${randomUUID().slice(0, 8)}`
  const noteBody = `# ${marker}\n\ncreated by the new release while it served\n`
  const created = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: { method: 'createNote', args: { relativePath: `rehearsal/${marker}.md`, markdown: noteBody } }, csrf: value.csrf })
  if (created.status !== 200 || !created.body?.value?.noteId) throw new Error(`writing during serve: createNote failed (${created.status}): ${JSON.stringify(created.body).slice(0, 200)}`)
  const attachmentBytes = Buffer.from(`rehearsal attachment ${marker}\n`)
  const uploaded = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: { method: 'uploadAttachment', args: { relativePath: `rehearsal/${marker}.bin`, contentBase64: attachmentBytes.toString('base64') } }, csrf: value.csrf })
  if (uploaded.status !== 200) throw new Error(`writing during serve: uploadAttachment failed (${uploaded.status}): ${JSON.stringify(uploaded.body).slice(0, 200)}`)
  const noteId = created.body.value.noteId
  const attachmentId = uploaded.body?.value?.attachmentId ?? null
  if (!attachmentId) throw new Error(`writing during serve: the upload reported no attachment id: ${JSON.stringify(uploaded.body).slice(0, 200)}`)

  // ── linkage: the attachment has to be reachable *through the note* ───────────────
  // An upload that is never referenced is an attachment no reader would ever see: `getNote`
  // reports the attachments a note cites, by scanning the markdown for managed link targets. So
  // the write is only complete once the note cites it and the product itself reports it back.
  const before = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: { method: 'getNote', args: { noteId } }, csrf: value.csrf })
  if (before.status !== 200) throw new Error(`writing during serve: the note must be readable before linking: ${before.status} ${JSON.stringify(before.body).slice(0, 200)}`)
  const attachmentName = `rehearsal-${marker}.bin`
  const linked = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: {
    method: 'saveNoteBody', args: {
      noteId, body: `${before.body.value.body}\n![${attachmentName}](attachments/${attachmentId}/${attachmentName})\n`,
      expectedContentHash: before.body.value.note.contentHash,
    },
  }, csrf: value.csrf })
  if (linked.status !== 200) throw new Error(`writing during serve: linking the attachment failed (${linked.status}): ${JSON.stringify(linked.body).slice(0, 200)}`)
  const verified = await call(`/pkw/spaces/${space.id}/api`, { method: 'POST', body: { method: 'getNote', args: { noteId } }, csrf: value.csrf })
  const cited = (verified.body?.value?.attachments ?? []).some(entry => entry.attachmentId === attachmentId)
  if (verified.status !== 200 || !cited) throw new Error(`writing during serve: the release does not report the attachment it linked (${verified.status}, cited=${cited})`)

  // ── the baseline: the bytes and the mode as the release that wrote them left them ──
  // The mode is captured here, from the file this very write produced, and the read-back compares
  // against *this* rather than against a constant: what a restore has to preserve is the state the
  // write created, and an expected value invented here would only ever test this script.
  const baseline = await inspectStoredAttachment(space.id, attachmentId)
  if (!baseline.ok) throw new Error(`writing during serve: the stored attachment is unreadable: ${baseline.reason}`)
  if (baseline.sha256 !== createHash('sha256').update(attachmentBytes).digest('hex')) {
    throw new Error('writing during serve: the stored attachment does not match the bytes that were uploaded')
  }

  const persisted = {
    marker, noteBody, spaceId: space.id, noteId, attachmentId, linked: true,
    attachmentSha256: baseline.sha256,
    attachmentBytes: baseline.bytes,
    attachmentBaseline: { file: baseline.file, bytes: baseline.bytes, sha256: baseline.sha256, mode: baseline.mode },
  }
  await writeFile(join(workDir, 'served-write.json'), JSON.stringify(persisted, null, 2) + '\n', { mode: 0o600 })
  return persisted
}

/** The stored attachment as it is on disk: every file under its directory, with bytes and mode. */
async function inspectStoredAttachment(spaceId, attachmentId) {
  const { createHash } = await import('node:crypto')
  const { stat, readFile: readBytes, readdir } = await import('node:fs/promises')
  if (!attachmentId) return { ok: false, reason: 'no attachment id was given' }
  const base = join(dataRoot, 'spaces', spaceId, 'workspace', 'attachments', attachmentId)
  const entries = await readdir(base).catch(() => null)
  if (!entries) return { ok: false, reason: `no stored attachment at ${base}` }
  const stored = []
  for (const name of entries) {
    const full = join(base, name)
    const info = await stat(full).catch(() => null)
    if (!info?.isFile()) continue
    const bytes = await readBytes(full)
    stored.push({ file: name, bytes: info.size, sha256: createHash('sha256').update(bytes).digest('hex'), mode: (info.mode & 0o7777).toString(8) })
  }
  if (stored.length === 0) return { ok: false, reason: `no file under ${base}`, stored }
  // Named explicitly rather than spread first: spreading `stored` afterwards would put the array
  // itself under the `stored` key and leave `file` reading from the array, which is how it came to
  // be reported as `undefined` while the comparison it fed still passed.
  return { ok: true, file: stored[0].file, bytes: stored[0].bytes, sha256: stored[0].sha256, mode: stored[0].mode, stored }
}

/** The single space the copied identity store carries. */
async function onlySpaceId() {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dataRoot, 'identity.sqlite'), { readOnly: true })
  try { return db.prepare('SELECT id FROM spaces LIMIT 1').get().id } finally { db.close() }
}

const startHook = () => {
  interruption.signal.throwIfAborted()
  startingListener = (async () => {
  const release = await currentRelease(root)
  const started = await manager.start()
  interruption.signal.throwIfAborted()
  const reachable = await checkReachable({ origin: `http://127.0.0.1:${port}`, timeoutMs: 30_000 })
  const observed = await manager.isStopped()
  if (!reachable.reachable || observed.observations?.process?.state !== 'alive') throw new Error(`${release} did not remain serving in its owned process`)
  report.phases.start = { release, ...started }
  report.listenerHistory.push({ action: 'start', ...report.phases.start })
  })()
  return startingListener.finally(() => { startingListener = null })
}

// ── artifacts: the release under test, served from a staged directory
let registry
const artifacts = []
const support = []
try {
  registry = await startLoopbackRegistry()
  for (const entry of (await readdir(resolve(values['artifact-dir']), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = join(resolve(values['artifact-dir']), entry.name)
    for (const file of await readdir(dir)) {
      if (!file.endsWith('.tgz')) continue
      const tarball = join(dir, file)
      const manifest = JSON.parse((await import('node:child_process')).execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
      const record = { name: manifest.name, version: manifest.version, tarball }
      if (manifest.version === version) artifacts.push(record)
      else support.push(record)
    }
  }
  if (artifacts.length === 0) throw new Error(`no artifacts for ${version} in ${values['artifact-dir']}`)
  // Everything else the profile already carries is served too, so the install only has to
  // fetch this release rather than re-resolving the world.
  const supportRoot = join(oldRelease, 'node_modules/@deepseek-ai')
  for (const entry of await readdir(supportRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('dsh-pkw-')) continue
    const dir = join(supportRoot, entry.name)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const staging = join(workDir, 'support', entry.name)
    await mkdir(staging, { recursive: true })
    await cp(dir, staging, { recursive: true, dereference: true }).catch(() => {})
    try { (await import('node:child_process')).execFileSync('npm', ['pack', '--ignore-scripts', '--quiet'], { cwd: staging, stdio: 'ignore' }) } catch { continue }
    const produced = (await readdir(staging)).find(f => f.endsWith('.tgz'))
    if (produced) support.push({ name: manifest.name, version: manifest.version, tarball: join(staging, produced) })
  }
  for (const record of [...artifacts, ...support]) await registry.add(record.tarball)
  report.artifacts = artifacts.map(a => ({ name: a.name, version: a.version }))
  report.supportArtifacts = support.length

  try {
    await startHook()
    report.result = await switchRelease({
      root, version, artifacts, registry: registry.url, storeDir: values['store-dir'],
      allowFreshRelease: true, snapshotDir: join(workDir, 'snapshots', version),
      deps: {
        prepareInstall: values['fail-install']
          ? async () => { throw new Error('rehearsal: injected install failure') }
          : async (options, ...rest) => {
            const { prepareInstall: real } = await import('../scripts/deployment.mjs')
            return real({ ...options, artifacts: [...options.artifacts, ...support] }, ...rest)
          },
        afterStopBeforeDriftCheck: values['modify-candidate-after-install']
          ? async ({ candidate }) => {
            await writeFile(join(candidate, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/index.js'), 'export const tampered = true\n')
            report.phases.driftProbe = { candidate, tampered: true }
          }
          : undefined,
      },
      hooks: {
        stop: stopHook,
        start: startHook,
        isStopped,
        // Observed, never assumed: the probe reports what it actually saw.
        reachable: async ({ previousVersion }) => {
          const state = await checkReachable({ origin: `http://127.0.0.1:${port}`, timeoutMs: 20_000 })
          report.phases.reachability = { previousVersion, ...state }
          return state
        },
        // Acceptance for the release under test: the official verifier, in its enforcing
        // mode, with the same parameter name the official CLI uses.
        verify: async ({ expectedVersion }) => {
          if (values['force-verify-failure'] && expectedVersion === version) {
            // The fault is only *this* fault after the real work succeeded. Marking it first and
            // then writing would label a genuine API failure — a release that cannot create a note,
            // or cannot link what it uploaded — as the expected injection, and the run would exit 0
            // on evidence that the release is broken. So the write is attempted first, and any
            // failure here propagates as a real failure with no fault recorded.
            if (values['write-during-serve']) {
              report.phases.writtenDuringServe = await writeThroughApi()
            }
            report.phases.injectedFault = {
              kind: 'post-activation verification',
              // What makes the fault legitimate: the release really wrote, and the write is really
              // in the data the rollback has to preserve.
              afterWrite: report.phases.writtenDuringServe
                ? { noteId: report.phases.writtenDuringServe.noteId, attachmentId: report.phases.writtenDuringServe.attachmentId, linked: report.phases.writtenDuringServe.linked === true }
                : null,
              reason: 'rehearsal: injected post-activation verification failure',
            }
            throw new Error('rehearsal: injected post-activation verification failure')
          }
          return await runVerifier(expectedVersion, 'activate')
        },
        // A rollback is only accepted when the restored release passes the same verifier.
        verifyPrevious: async ({ expectedVersion }) => runVerifier(expectedVersion, 'rollback'),
      },
    })
    report.status = report.result.status
  } catch (error) {
    report.status = error.code ?? 'failed'
    report.error = { message: error.message, code: error.code ?? null, exitCode: error.exitCode ?? null, signal: error.signal ?? null }
    report.result = error.report ?? null
  }
  // The read-back belongs to the report, not to the transaction's success path: a rolled-back
  // deployment throws, and the question "can the restored release read what the replaced release
  // wrote" still has to be answered and recorded. It is asked here, after the transaction has
  // settled and while the restored release is serving — the same process the rollback started,
  // never a second one.
  if (existsSync(join(workDir, 'served-write.json'))) {
    let restored
    try {
      restored = await readServedWriteBack('restored-release')
    } catch (readError) {
      restored = { label: 'restored-release', ok: false, reason: `the read-back could not be made: ${readError.message}` }
    }
    report.phases.readBackAfterRollback = restored
    if (!restored.ok) report.status = 'rollback-data-not-readable'
  }
} catch (error) {
  report.status = error.code ?? 'failed'
  report.error = { message: error.message, code: error.code ?? null, exitCode: error.exitCode ?? null, signal: error.signal ?? null }
} finally {
  // Cleanup runs even if the registry or transaction fails. Its evidence gates the verdict.
  await interruptedCleanup
  report.cleanup = await stopRehearsalListener(manager)
  try { await registry?.close() } catch (error) {
    report.cleanup.ok = false
    report.cleanup.error = { code: 'PKW_REHEARSAL_CLEANUP_FAILED', message: error.message }
    report.cleanup.errors.push({ phase: 'registry-close', message: error.message })
  }
  await interruptedCleanup
  process.off('SIGTERM', onTerm); process.off('SIGINT', onInt)
}
// Exit code policy:
//   0  the release was activated and accepted, or the injected fault produced a
//      *verified* rollback (original release restored and accepted again)
//   1  anything else: a normal failure, an unverified rollback, or a fault run whose
//      rollback did not verify
const faultInjected = Boolean(report.phases.injectedFault)
const activated = report.status === 'activated'
const rollbackVerified = report.result?.rollbackEvidence?.acceptance === 'verified'
const readBackOk = report.phases.readBackAfterRollback ? report.phases.readBackAfterRollback.ok === true : true

// When write acceptance is on, the run is making three claims and each one needs evidence:
//   1. the release really wrote through its own API while it served,
//   2. that write really cited the attachment it uploaded,
//   3. the restored release really read both back.
// A missing write, a missing read-back, or a linkage that was never observed is a failure of the
// run — not a weaker pass. `readBackOk` above is deliberately permissive for a run that never asked
// for a write; these three checks are what stops it from also being permissive for a run that did.
const writeAcceptance = Boolean(values['write-during-serve'])
const wrote = report.phases.writtenDuringServe ?? null
const writeAcceptanceProblems = []
if (writeAcceptance) {
  if (!wrote) writeAcceptanceProblems.push('the release was asked to write while it served and no write was recorded')
  else {
    if (!wrote.noteId) writeAcceptanceProblems.push('the write recorded no note id')
    if (!wrote.attachmentId) writeAcceptanceProblems.push('the upload recorded no attachment id')
    if (wrote.linked !== true) writeAcceptanceProblems.push('the attachment was never observed to be cited by the note')
    if (!wrote.attachmentBaseline) writeAcceptanceProblems.push('the write recorded no attachment baseline')
  }
  if (!report.phases.readBackAfterRollback) writeAcceptanceProblems.push('no read-back after the rollback was recorded')
  else if (report.phases.readBackAfterRollback.ok !== true) writeAcceptanceProblems.push(`the read-back after the rollback did not pass: ${report.phases.readBackAfterRollback.reason ?? 'no reason recorded'}`)
}
report.writeAcceptance = { requested: writeAcceptance, problems: writeAcceptanceProblems, ok: writeAcceptanceProblems.length === 0 }
const lifecycleOk = report.listenerHistory.every(entry => entry.action !== 'stop' || entry.ok === true)
const exitCode = !interruption.signal.aborted && lifecycleOk && report.cleanup?.ok === true && (activated || (faultInjected && rollbackVerified)) && readBackOk && writeAcceptanceProblems.length === 0 ? 0 : 1
// The report is written after the verdict is computed, so the verdict it records is the verdict the
// process exits with: a report written before the write-acceptance gate would be missing the very
// field that explains a non-zero exit.
report.exit = { code: exitCode, faultInjected, activated, rollbackVerified, readBackOk, lifecycleOk, cleanupConfirmed: report.cleanup?.ok === true }
await writeFile(join(workDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({
  status: report.status, version, oldVersion, faultInjected, rollbackVerified, exitCode,
  writeAcceptance: report.writeAcceptance, readBack: report.phases.readBackAfterRollback?.ok ?? null,
  phases: Object.keys(report.phases), report: join(workDir, 'report.json'),
}, null, 2))
return exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runRehearsal() }
  catch (error) { console.error(JSON.stringify({ status: error.code ?? 'failed', message: error.message })); process.exitCode = 1 }
}

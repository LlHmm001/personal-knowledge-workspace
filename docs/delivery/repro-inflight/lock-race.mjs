#!/usr/bin/env node
/**
 * Race two owned listeners against one private fixture copy, one round at a time.
 * Success needs the winner's listening receipt, HTTP 200, its root-lock PID, and
 * the other child's exit 3 with a live-writer refusal naming that winner.
 * A deadline is a failure, never "running".
 *
 * node docs/delivery/repro-inflight/lock-race.mjs \
 *   --profile DIR --data-root SYNTHETIC_FIXTURE --rounds 16
 * PKW_TEST_PROFILE / PKW_TEST_DATA_ROOT are explicit alternatives to the paths.
 * Failed rounds and bounded logs are kept. Successful rounds are removed only
 * after both child processes have exited and their output streams closed.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, scrypt } from 'node:crypto'
import { mkdtemp, readFile, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { copyDataRoot } from '../../../scripts/copy-data-root.mjs'
import { LOCK_EXIT } from '../../../scripts/root-lock.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const listenerPath = join(repoRoot, 'scripts/serve-collaboration.mjs')
const PASSWORD = 'synthetic-lock-race-pass'
const MAX_LOG_BYTES = 16 * 1024
const delay = ms => new Promise(done => setTimeout(done, ms))
const fail = (code, message) => Object.assign(new Error(message), { code })

function positiveInteger(value, label, max) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new TypeError(`${label} must be an integer between 1 and ${max}`)
  }
  return Number(value)
}

export function raceOptions(args = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    profile: { type: 'string' }, 'data-root': { type: 'string' }, rounds: { type: 'string' },
    'deadline-ms': { type: 'string' }, 'term-ms': { type: 'string' }, 'kill-ms': { type: 'string' },
  } })
  if (positionals.length > 2 || (values.profile && positionals[0]) || (values.rounds && positionals[1])) {
    throw new TypeError('Use --profile/--rounds or positional profile/rounds, not both')
  }
  const profile = values.profile ?? positionals[0] ?? env.PKW_TEST_PROFILE
  const fixture = values['data-root'] ?? env.PKW_TEST_DATA_ROOT
  if (!profile || !fixture) throw new TypeError('Explicit --profile and --data-root (or PKW_TEST_PROFILE and PKW_TEST_DATA_ROOT) are required')
  return {
    profile: resolve(profile), fixture: resolve(fixture),
    rounds: positiveInteger(values.rounds ?? positionals[1] ?? 16, 'rounds', 1000),
    deadlineMs: positiveInteger(values['deadline-ms'] ?? 20000, 'deadline-ms', 300000),
    termMs: positiveInteger(values['term-ms'] ?? 15000, 'term-ms', 60000),
    killMs: positiveInteger(values['kill-ms'] ?? 3000, 'kill-ms', 60000),
  }
}

/** Register lifecycle observers immediately after spawn; drain both streams always. */
export function trackChild(child, label, port) {
  const state = { label, child, pid: child.pid ?? null, exit: null, spawnError: null, closed: false, listening: false, refusal: null, log: Buffer.alloc(0) }
  let closeResolve
  state.whenClosed = new Promise(done => { closeResolve = done })
  child.once('error', error => { state.spawnError = { code: error.code ?? null, message: error.message } })
  child.once('exit', (code, signal) => { state.exit = { code, signal } })
  child.once('close', (code, signal) => { state.closed = true; state.close = { code, signal }; closeResolve() })
  const pending = { stdout: '', stderr: '' }
  const capture = (chunk, stream) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    state.log = Buffer.concat([state.log, bytes]).subarray(-MAX_LOG_BYTES)
    pending[stream] += bytes.toString('utf8')
    for (;;) {
      const newline = pending[stream].indexOf('\n')
      if (newline < 0) break
      const line = pending[stream].slice(0, newline)
      pending[stream] = pending[stream].slice(newline + 1)
      try {
        const receipt = JSON.parse(line)
        if (stream === 'stdout' && receipt.status === 'listening' && receipt.bind === `127.0.0.1:${port}`) state.listening = true
        if (stream === 'stderr' && ['lock-refused', 'bind-refused'].includes(receipt.status)) {
          state.refusal = { status: receipt.status, reason: receipt.reason, pid: receipt.pid ?? null }
        }
      } catch { /* ordinary log line */ }
    }
    if (pending[stream].length > MAX_LOG_BYTES) pending[stream] = pending[stream].slice(-MAX_LOG_BYTES)
  }
  child.stdout?.on('data', chunk => capture(chunk, 'stdout'))
  child.stderr?.on('data', chunk => capture(chunk, 'stderr'))
  return state
}

const exited = state => state.exit !== null || state.child.exitCode != null || state.child.signalCode != null
const stopped = state => state.closed && (exited(state) || (state.spawnError !== null && state.pid === null))
const childReport = state => ({ label: state.label, pid: state.pid, listening: state.listening, refusal: state.refusal, exit: state.exit, close: state.close ?? null, spawnError: state.spawnError })

async function waitClosed(state, milliseconds) {
  if (state.closed) return
  let timer
  try { await Promise.race([state.whenClosed, new Promise(done => { timer = setTimeout(done, milliseconds) })]) }
  finally { clearTimeout(timer) }
}

/** Never look up a PID from disk or signal a child after its exit was observed. */
export async function stopOwnedChild(state, { termMs, killMs }) {
  const signals = [], errors = []
  const signal = name => {
    if (exited(state) || state.pid === null || state.closed) return
    try { signals.push({ signal: name, delivered: state.child.kill(name) }) }
    catch (error) { errors.push({ signal: name, code: error.code ?? null, message: error.message }) }
  }
  signal('SIGTERM')
  await waitClosed(state, termMs)
  if (!state.closed) { signal('SIGKILL'); await waitClosed(state, killMs) }
  return { ...childReport(state), confirmed: stopped(state), signals, errors }
}

async function healthStatus(port, milliseconds, signal) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(milliseconds)))
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout, redirect: 'manual',
  })
  await response.body?.cancel().catch(() => {})
  return response.status
}

/** Return as soon as evidence is complete; elapsed time can only refuse a round. */
export async function observeRace(children, {
  port, root, deadlineMs, signal, progress = () => {},
  health = healthStatus, lock = async () => JSON.parse(await readFile(join(root, 'gateway.lock'), 'utf8')),
  pollMs = 25,
}) {
  const begun = Date.now(), deadline = begun + deadlineMs
  let lastProgress = begun, lastProbe = null
  for (;;) {
    if (signal?.aborted) throw fail('LOCK_RACE_INTERRUPTED', String(signal.reason ?? 'interrupted'))
    for (const state of children) {
      if (state.spawnError) throw fail('LOCK_RACE_SPAWN_FAILED', `${state.label}: ${state.spawnError.code ?? ''} ${state.spawnError.message}`)
      if (state.exit && (state.exit.code !== LOCK_EXIT.LIVE_WRITER || state.exit.signal !== null)) {
        throw fail('LOCK_RACE_UNEXPECTED_EXIT', `${state.label}: ${JSON.stringify(state.exit)}`)
      }
    }
    if (children.every(exited)) throw fail('LOCK_RACE_NO_WINNER', 'Both listeners exited')
    const loser = children.find(state => stopped(state) && state.exit?.code === LOCK_EXIT.LIVE_WRITER && state.exit.signal === null)
    const winner = loser && children.find(state => state !== loser)
    if (loser && (loser.refusal?.status !== 'lock-refused' || loser.refusal.reason !== 'live-writer' || loser.refusal.pid !== winner?.pid)) {
      throw fail('LOCK_RACE_REFUSAL_INVALID', `Exit 3 did not prove refusal of this winner: ${JSON.stringify(loser.refusal)}`)
    }
    if (winner?.listening && !exited(winner)) {
      try {
        const before = await lock()
        if (before.pid === winner.pid && Number.isSafeInteger(winner.pid) && winner.pid > 0) {
          const status = await health(port, Math.min(1000, Math.max(1, deadline - Date.now())), signal)
          const after = await lock()
          lastProbe = { status, lockPid: after.pid }
          if (status === 200 && after.pid === winner.pid && !exited(winner) && !winner.spawnError && Date.now() < deadline && !signal?.aborted) {
            return { winner: winner.pid, loser: loser.pid, refusalExit: loser.exit.code, refusal: loser.refusal, health: status, lockPid: after.pid, elapsedMs: Date.now() - begun }
          }
        } else lastProbe = { lockPid: before.pid ?? null, expectedPid: winner.pid }
      } catch (error) { lastProbe = { error: error.code ?? error.message } }
    }
    if (Date.now() >= deadline) throw fail('LOCK_RACE_DEADLINE', `Required listening/health/lock/refusal evidence was not obtained: ${JSON.stringify(lastProbe)}`)
    if (Date.now() - lastProgress >= 1000) {
      progress({ phase: 'waiting', elapsedMs: Date.now() - begun, children: children.map(childReport), lastProbe })
      lastProgress = Date.now()
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

const freePort = () => new Promise((done, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(error => error ? reject(error) : done(port))
  })
})

async function prepareFixture(fixture, root) {
  await copyDataRoot(fixture, root)
  const { DatabaseSync } = await import('node:sqlite')
  const salt = randomBytes(16).toString('hex')
  const derived = await promisify(scrypt)(PASSWORD, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  const identity = new DatabaseSync(join(root, 'identity.sqlite'))
  try {
    const changed = identity.prepare('UPDATE accounts SET password=? WHERE username=?').run(`scrypt-v1:${salt}:${derived.toString('hex')}`, 'owner')
    if (changed.changes !== 1) throw fail('LOCK_RACE_FIXTURE_OWNER', 'Synthetic fixture must have exactly one owner account named owner')
  } finally { identity.close() }
}

/** Dependencies are injectable for tests; defaults use only explicit fixture inputs. */
export async function runRaceRound(options, dependencies = {}) {
  const { round = 1, signal } = options
  const work = await realpath(await (dependencies.createWork ?? (() => mkdtemp(join(tmpdir(), 'pkw-lock-race-'))))())
  const root = join(work, 'data'), children = []
  let evidence = null, error = null, cleanup = [], port = null
  const progressErrors = []
  const progress = item => {
    try { options.progress?.(item) }
    catch (failure) { progressErrors.push({ code: failure.code ?? null, message: failure.message }) }
  }
  progress({ round, phase: 'preparing', work })
  try {
    if (signal?.aborted) throw fail('LOCK_RACE_INTERRUPTED', String(signal.reason))
    await (dependencies.prepare ?? prepareFixture)(options.fixture, root)
    if (signal?.aborted) throw fail('LOCK_RACE_INTERRUPTED', String(signal.reason))
    port = await (dependencies.freePort ?? freePort)()
    const config = join(work, 'collaboration.json')
    await writeFile(config, JSON.stringify({ dataPath: root, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_LOCK_RACE_PASSWORD' }) + '\n', { mode: 0o600 })
    for (const label of ['a', 'b']) {
      if (signal?.aborted) throw fail('LOCK_RACE_INTERRUPTED', String(signal.reason))
      const child = (dependencies.spawn ?? spawn)(process.execPath, [listenerPath, '--profile', options.profile, '--config', config, '--port', String(port)], {
        env: { ...process.env, PKW_LOCK_RACE_PASSWORD: PASSWORD }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(trackChild(child, label, port))
    }
    progress({ round, phase: 'observing', work, children: children.map(childReport) })
    evidence = await observeRace(children, { ...options, ...(dependencies.observe ?? {}), port, root, progress: item => progress({ round, ...item }) })
  } catch (failure) { error = { code: failure.code ?? null, message: failure.message } }
  finally {
    progress({ round, phase: 'cleanup', work, children: children.map(childReport) })
    cleanup = await Promise.all(children.map(child => stopOwnedChild(child, options)))
    // An unconfirmed cleanup must not erase the scene or trap this runner forever.
    for (const child of children.filter(child => !stopped(child))) {
      child.child.unref?.()
      child.child.stdout?.destroy()
      child.child.stderr?.destroy()
    }
  }
  if (signal?.aborted) error ??= { code: 'LOCK_RACE_INTERRUPTED', message: String(signal.reason) }
  const cleanupConfirmed = cleanup.every(item => item.confirmed)
  if (!cleanupConfirmed) error ??= { code: 'LOCK_RACE_CLEANUP_UNKNOWN', message: 'Child exit/stream closure was not confirmed; directory retained' }
  if (cleanup.some(item => item.signals.some(sent => sent.signal === 'SIGKILL'))) {
    error ??= { code: 'LOCK_RACE_FORCED_CLEANUP', message: 'Cleanup required SIGKILL; directory retained for inspection' }
  }
  if (evidence) {
    const winner = children.find(child => child.pid === evidence.winner)
    const loser = children.find(child => child.pid === evidence.loser)
    if (winner?.exit?.code !== 0 || winner.exit.signal !== null || winner.spawnError || loser?.exit?.code !== LOCK_EXIT.LIVE_WRITER || loser.exit.signal !== null || loser.spawnError) {
      error ??= { code: 'LOCK_RACE_CLEANUP_EXIT', message: 'Winner must exit 0 without a signal and loser must retain exit 3; directory retained' }
    }
  }
  const report = { round, ok: !!evidence && !error, work, port, evidence, error, cleanupConfirmed, cleanup, children: children.map(childReport), progressErrors }
  for (const child of children) await writeFile(join(work, `${child.label}.log`), child.log, { mode: 0o600 })
  await writeFile(join(work, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  if (report.ok && cleanupConfirmed) await (dependencies.remove ?? (path => rm(path, { recursive: true, force: true })))(work)
  progress({ round, phase: report.ok ? 'passed' : 'failed', ...report, preserved: !report.ok })
  return report
}

export async function runLockRace(options, dependencies = {}) {
  const results = []
  for (let round = 1; round <= options.rounds; round++) {
    const result = await runRaceRound({ ...options, round }, dependencies)
    results.push(result)
    if (!result.ok || options.signal?.aborted) break
  }
  return { requestedRounds: options.rounds, completedRounds: results.length, passed: results.filter(item => item.ok).length, ok: results.length === options.rounds && results.every(item => item.ok), results }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  let interrupted = null
  const onInt = () => { interrupted ??= 'SIGINT'; controller.abort(interrupted) }
  const onTerm = () => { interrupted ??= 'SIGTERM'; controller.abort(interrupted) }
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  try {
    const report = await runLockRace({ ...raceOptions(), signal: controller.signal, progress: item => console.log(JSON.stringify(item)) })
    console.log(JSON.stringify({ phase: 'summary', requestedRounds: report.requestedRounds, completedRounds: report.completedRounds, passed: report.passed, ok: report.ok }))
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : report.ok ? 0 : 1
  } catch (error) {
    console.error(JSON.stringify({ phase: 'failed', code: error.code ?? null, message: error.message }))
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}

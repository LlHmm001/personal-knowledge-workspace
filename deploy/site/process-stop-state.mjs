#!/usr/bin/env node
/**
 * Stop evidence for a listener this repository started itself, with no systemd in the picture.
 *
 * A deployment may only write back, repoint or start anything once it has *confirmed* that the
 * previous writer stopped. `deploy/site/systemd-stop-state.mjs` answers that question for a unit; a
 * rehearsal or an end-to-end test starts a plain process instead, and needs the same discipline:
 *
 *   a pid that is gone is not enough on its own - a listener can be gone while its port is still
 *   held, and the next start would then fail to bind;
 *   a port that answers is not enough either - something else may have been answering all along;
 *   and an answer that could not be obtained is never "stopped".
 *
 * So three independent observations are made, and each one can only ever *refuse* a stop:
 *
 *   process  the recorded pid is gone (ESRCH), alive, or unknown (anything else)
 *   port     the port is free, held, or unknown (the probe itself failed)
 *   lock     the data root's own lock is absent, held by a live writer, or unreadable
 *
 * `known && stopped` requires all three to say so. An unreadable lock, an unanswerable liveness
 * check or a probe that could not run all leave `known: false`, and a caller that sees `known:
 * false` must refuse rather than guess.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { processState } from './systemd-stop-state.mjs'

/**
 * The version a release profile declares, read from its own PKW packages.
 *
 * Every installed package under the scope carries the release version, because the install is what
 * put them there. One of them is enough, and the answer is the same for all of them; the profile's
 * own `package.json` is deliberately not consulted (see `start`).
 */
export async function releaseVersion(profileDir) {
  const scopeDir = join(profileDir, 'node_modules', '@deepseek-ai')
  const entries = await readdir(scopeDir).catch(() => null)
  if (!entries) return null
  const candidates = entries.filter(name => name.startsWith('dsh-pkw-')).sort()
  for (const name of candidates) {
    try {
      const manifest = JSON.parse(await readFile(join(scopeDir, name, 'package.json'), 'utf8'))
      if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
    } catch { /* try the next package */ }
  }
  return null
}

/** Whether anything is listening on a loopback port, by trying to take it. */
export async function portHolder(port, { listen = null } = {}) {
  const make = listen ?? (() => createServer())
  const server = make()
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(port, '127.0.0.1', resolvePromise)
    })
    return { known: true, held: false }
  } catch (error) {
    // EADDRINUSE is the port being held. Anything else is a probe that did not answer the question,
    // and "the probe broke" must never be read as "the port is free".
    if (error?.code === 'EADDRINUSE') return { known: true, held: true }
    return { known: false, held: null, reason: `${error?.code ?? 'error'}: ${error?.message ?? error}` }
  } finally {
    await new Promise(resolvePromise => server.close(() => resolvePromise(undefined)))
  }
}

/** The data root's own lock: absent, held by a writer, or unreadable. */
async function readRootLock(lockPath) {
  let text
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { known: true, present: false, pid: null }
    return { known: false, present: null, reason: `cannot read ${lockPath}: ${error?.code ?? error.message}` }
  }
  const trimmed = text.trim()
  // The lock is created and then written: a lockfile that exists but is still empty is a writer in
  // the middle of claiming it, not an unreadable file.
  if (trimmed === '') return { known: true, present: true, pid: null, empty: true }
  let parsed
  try { parsed = JSON.parse(trimmed) } catch {
    return { known: false, present: true, reason: `the lock at ${lockPath} is not JSON: ${trimmed.slice(0, 80)}` }
  }
  const pid = Number(parsed?.pid)
  return { known: true, present: true, pid: Number.isInteger(pid) && pid > 0 ? pid : null }
}

/**
 * The evidence that the writer owning `pid` has stopped, as three separate observations.
 *
 * Every field is reported whether or not it agreed, so a refusal can say which observation refused
 * it instead of only that the stop was not confirmed.
 */
export async function probeListenerStop({ pid, port, lockPath, kill = process.kill.bind(process), holdPort = portHolder } = {}) {
  const observations = {}
  let known = true
  const reasons = []

  if (!Number.isInteger(pid) || pid <= 0) {
    observations.process = { state: 'unknown', reason: 'no pid was recorded' }
    known = false
    reasons.push('no pid was recorded, so no process was ruled out')
  } else {
    const state = processState(pid, { kill })
    observations.process = { pid, state }
    if (state === 'alive') { reasons.push(`pid ${pid} is still running`) }
    else if (state === 'unknown') { known = false; reasons.push(`could not establish whether pid ${pid} is running`) }
  }

  const held = await holdPort(port)
  observations.port = { port, ...held }
  if (held.known !== true) { known = false; reasons.push(`the port probe for ${port} did not answer: ${held.reason}`) }
  else if (held.held) { reasons.push(`port ${port} is still held`) }

  if (lockPath) {
    const lock = await readRootLock(lockPath)
    observations.lock = { path: lockPath, ...lock }
    if (lock.known !== true) { known = false; reasons.push(`the data root's lock could not be read: ${lock.reason}`) }
    else if (lock.present) {
      if (lock.empty || lock.pid === null) { known = false; reasons.push('the lock is present but names no writer, so no writer was ruled out') }
      else {
        const state = processState(lock.pid, { kill })
        observations.lock.state = state
        if (state === 'alive') reasons.push(`the data root's lock is held by live pid ${lock.pid}`)
        else if (state === 'unknown') { known = false; reasons.push(`could not establish whether the lock's writer ${lock.pid} is running`) }
      }
    }
  }

  const stopped = known && reasons.length === 0
  return {
    known, stopped, pid: pid ?? null, port,
    source: 'process+port+lock',
    observations,
    ...(stopped ? {} : { reason: reasons.join('; ') }),
  }
}

// ── a listener this repository started, with the stop evidence above ─────────────────────────────

/**
 * Manage exactly one listener process for one data root and port.
 *
 * The saved ChildProcess is the authority for signals; the pid file is diagnostic evidence only.
 * Stop observes that handle's exit and close, and the independent probe observes the owned pid,
 * port and lock. Nothing in here ever decides that
 * a listener is up because a port answered — the recorded process has to be alive *and* the port
 * has to be answering, and a child that died is reported as a failure to start rather than papered
 * over by whatever else happens to be listening.
 */
export function listenerManager({
  root, port, dataRoot, password, scriptsDir = null, repoRoot = null,
  configPath = join(root, 'collaboration.json'),
  pidFile = join(root, 'listener.pid'),
  logDir = join(root, 'logs'),
  bootstrapEnv = 'PKW_E2E_BOOTSTRAP',
  extraEnv = {},
  spawnChild = spawn, startupTimeoutMs = 30_000, stopTimeoutMs = 30_000, killTimeoutMs = 5_000,
} = {}) {
  if (!root || !port || !scriptsDir || !repoRoot) throw new Error('listenerManager needs root, port, scriptsDir and repoRoot')
  const state = { current: null }
  let owned = null
  let starting = null

  const readPidFile = async () => {
    if (!existsSync(pidFile)) return null
    const text = (await readFile(pidFile, 'utf8')).trim()
    if (text === '') return null
    try { return JSON.parse(text) } catch { return { pid: Number(text) || null, version: null } }
  }

  /** Start the release at `<root>/current`, record its pid, and prove *that* process is serving. */
  const startOnce = async () => {
    if (owned && !owned.closed) throw new Error('the previously owned listener has not closed')
    await mkdir(logDir, { recursive: true })
    const link = join(root, 'current')
    const releaseDir = await realpath(link)
    const profileDir = join(releaseDir, 'profile')
    // The version is the one the release's own packages declare, read out of the profile that will
    // actually run. The profile root's `package.json` is *not* the release version: a release is
    // installed into a profile that already exists, and that file keeps whatever version it was
    // seeded with, so reading it names a release by the wrong version — which is how a start hook
    // comes to report having started the previous release.
    const version = await releaseVersion(profileDir)
    if (!version) throw new Error(`the release at ${releaseDir} declares no version in its own packages`)
    const logged = join(logDir, `listener-${version}-${Date.now()}.log`)
    const child = spawnChild(process.execPath, [
      join(scriptsDir, 'serve-collaboration.mjs'),
      '--profile', profileDir, '--config', configPath, '--port', String(port),
    ], {
      env: { ...process.env, [bootstrapEnv]: password, ...extraEnv },
      // Keep the owned listener inside a rehearsal driver's process group, so a bounded
      // outer runner can clean up its entire group if the driver itself cannot finish.
      stdio: ['ignore', 'pipe', 'pipe'], detached: false,
    })
    // Register the lifetime before any await. The saved handle, never a pid read from disk,
    // authorizes signals. Exit is recorded separately from close so piped diagnostics drain.
    const frames = []
    const current = { child, pid: child.pid, version, frames, logged, ended: false, closed: false, outcome: null, stopPromise: null }
    owned = current
    let resolveClosed
    current.closePromise = new Promise(done => { resolveClosed = done })
    child.on('error', error => {
      current.outcome = { exitCode: child.exitCode ?? null, signal: child.signalCode ?? null, spawnError: error.message }
      if (!child.pid) current.ended = true
    })
    child.once('exit', (exitCode, signal) => {
      current.ended = true
      current.outcome = { exitCode, signal: signal ?? null, spawnError: current.outcome?.spawnError ?? null }
    })
    child.once('close', (exitCode, signal) => {
      current.ended = true; current.closed = true
      current.outcome ??= { exitCode, signal: signal ?? null, spawnError: null }
      resolveClosed(current.outcome)
    })
    const capture = chunk => { frames[0] = ((frames[0] ?? '') + String(chunk)).slice(-65536) }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    await writeFile(pidFile, JSON.stringify({ pid: child.pid, version, port, startedAt: new Date().toISOString(), log: logged }, null, 2) + '\n', { mode: 0o600 })
    state.current = { pid: child.pid, version, port, log: logged, frames }

    // The child has to be *this* process serving, not a port that happened to answer. A child that
    // exited is a failed start even if something else is listening on the port, so liveness is
    // checked first and reported with the child's own output.
    const deadline = Date.now() + startupTimeoutMs
    let listening = false
    while (Date.now() < deadline) {
      if (current.ended || current.outcome?.spawnError) {
        await writeFile(logged, frames.join(''))
        throw new Error(`the listener for ${version} exited before it served (pid ${child.pid}): ${frames.join('').slice(-600)}`)
      }
      if (frames.join('').includes('"status":"listening"')) { listening = true; break }
      if (!existsSync(configPath)) throw new Error(`no configuration at ${configPath}`)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    await writeFile(logged, frames.join(''))
    if (!listening) throw new Error(`the listener for ${version} never reported listening (pid ${child.pid}): ${frames.join('').slice(-600)}`)
    return { pid: child.pid, version, port, log: logged }
  }
  const start = () => {
    if (starting) return starting
    starting = startOnce().finally(() => { starting = null })
    return starting
  }

  const waitClosed = (current, timeoutMs) => {
    if (current.closed) return Promise.resolve(current.outcome)
    return new Promise(done => {
      const timer = setTimeout(() => done(null), timeoutMs)
      current.closePromise.then(outcome => { clearTimeout(timer); done(outcome) })
    })
  }

  /** Stop only the owned handle and report its actual outcome, without rewriting the pid file. */
  const stop = () => {
    const current = owned
    if (!current) return Promise.resolve({ requested: false, reason: 'this manager has not spawned a listener' })
    if (current.stopPromise) return current.stopPromise
    current.stopPromise = (async () => {
      const observed = { requested: true, pid: current.pid ?? null, version: current.version, signalled: false, exited: false, exit: null, alreadyExited: current.ended }
      const signal = name => {
        if (current.ended) return
        try { if (current.child.kill(name)) observed.signalled = true }
        catch (error) { observed.signalError = error?.code ?? error.message }
      }
      signal('SIGTERM')
      let outcome = await waitClosed(current, stopTimeoutMs)
      if (!outcome && !current.ended) {
        observed.killed = true
        signal('SIGKILL')
        outcome = await waitClosed(current, killTimeoutMs)
      }
      observed.exited = current.ended
      observed.closed = current.closed
      observed.exit = outcome ?? current.outcome
      observed.graceful = current.closed && !observed.killed && !observed.signalError && !observed.alreadyExited && observed.exit?.exitCode === 0 && !observed.exit?.signal && !observed.exit?.spawnError
      // A descendant can retain a pipe after the child exits. Bound diagnostic draining too.
      if (!current.closed) { current.child.stdout?.destroy(); current.child.stderr?.destroy() }
      await writeFile(current.logged, current.frames.join(''), { mode: 0o600 })
      if (owned === current) state.current = null
      return observed
    })()
    return current.stopPromise
  }

  /** The independent stop probe the transaction asks. Separate from `stop`, on purpose. */
  const isStopped = async () => {
    const recorded = owned ? { pid: owned.pid } : await readPidFile()
    // No record at all is knowledge, not an unanswerable question: this manager starts the only
    // listener that could hold this root, and it writes the record before the child can bind. A
    // missing record therefore says no listener of ours was ever started — the state the first
    // stop probe legitimately runs in, before anything has been promoted.
    if (!recorded) {
      const held = await portHolder(port)
      if (held.known !== true) return { known: false, stopped: false, pid: null, port, source: 'no-record+port', observations: { port: { port, ...held } }, reason: `no listener was recorded and the port probe did not answer: ${held.reason}` }
      if (held.held) return { known: true, stopped: false, pid: null, port, source: 'no-record+port', observations: { port: { port, ...held } }, reason: `no listener was recorded, but port ${port} is held` }
      return { known: true, stopped: true, pid: null, port, source: 'no-record+free-port', observations: { port: { port, ...held } } }
    }
    return probeListenerStop({
      pid: recorded.pid ?? null, port,
      lockPath: join(dataRoot, 'gateway.lock'),
    })
  }

  const recorded = () => state.current

  return { start, stop, isStopped, recorded, readPidFile, pidFile, configPath, logDir }
}

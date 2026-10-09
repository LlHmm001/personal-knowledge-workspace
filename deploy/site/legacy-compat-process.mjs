/** Own one isolated legacy listener; authentication belongs to the caller after start proves ownership. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, constants, openSync, writeSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portHolder, probeListenerStop } from './process-stop-state.mjs'

const proofPath = fileURLToPath(new URL('./legacy-compat-bind-proof.mjs', import.meta.url))
const fail = (code, message) => Object.assign(new Error(message), { code })
const inside = (root, path) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const groupState = pid => {
  if (!Number.isInteger(pid) || pid < 1) return 'absent'
  try { process.kill(-pid, 0); return 'alive' } catch (e) { return e.code === 'ESRCH' ? 'gone' : 'unknown' }
}
async function lockOwner(path) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const st = await handle.stat()
    if (!st.isFile() || st.size > 8192) return null
    const buffer = Buffer.alloc(8193), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 8192) return null
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    return Number.isInteger(value?.pid) && value.pid > 0 ? value.pid : null
  } catch { return null } finally { await handle?.close() }
}

async function absent(path) {
  try { await lstat(path); return false } catch (e) { return e.code === 'ENOENT' }
}

export function createCompatProcess({ runner, profile, config, dataRoot, work, port,
  node = process.execPath, password, bootstrapEnv = 'PKW_COMPAT_BOOTSTRAP', signal,
  startupTimeoutMs = 30_000, stopTimeoutMs = 15_000, killTimeoutMs = 5_000,
} = {}) {
  for (const path of [runner, profile, config, dataRoot, work, node]) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw fail('PKW_COMPAT_ARGUMENT', 'All listener paths must be absolute')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof password !== 'string' || !password || !/^PKW_[A-Z0-9_]+$/.test(bootstrapEnv)) {
    throw fail('PKW_COMPAT_ARGUMENT', 'A loopback port, private password and PKW bootstrap variable are required')
  }
  for (const ms of [startupTimeoutMs, stopTimeoutMs, killTimeoutMs]) if (!Number.isFinite(ms) || ms < 1 || ms > 120_000) throw fail('PKW_COMPAT_ARGUMENT', 'Invalid listener deadline')
  const lockPath = join(dataRoot, 'gateway.lock')
  const log = join(work, `listener-${randomBytes(8).toString('hex')}.log`)
  let child, ended = false, closed = false, outcome = null, proof = null, started = false
  let starting, stopping, resolveClose, closePromise, fd, written = 0, lines = '', logError = false
  let abortHandler
  const state = () => ({ pid: child?.pid ?? null, port, started, ended, closed, log })
  const waitClose = ms => closed ? Promise.resolve(outcome) : new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    closePromise.then(result => { clearTimeout(timer); resolve(result) })
  })
  const assertAlive = () => {
    if (signal?.aborted) throw fail('PKW_COMPAT_ABORTED', 'Compatibility listener was interrupted')
    if (ended || outcome?.spawnError) throw fail('PKW_COMPAT_START_FAILED', 'Owned listener exited before readiness; inspect its private log')
  }
  const capture = (chunk, stdout = false) => {
    const bytes = Buffer.from(chunk)
    if (written < 1_048_576 && fd !== undefined) {
      try { written += writeSync(fd, bytes.subarray(0, 1_048_576 - written)) } catch { logError = true }
    }
    if (!stdout) return
    lines += bytes.toString('utf8')
    for (let at; (at = lines.indexOf('\n')) !== -1;) {
      const line = lines.slice(0, at); lines = lines.slice(at + 1)
      if (line.length > 16384) continue
      try {
        const value = JSON.parse(line)
        if (value?.status === 'PKW_COMPAT_OWNED_BIND' && value.nonce === nonce && value.pid === child.pid && value.port === port && value.address === '127.0.0.1') proof = value
      } catch { /* ordinary listener diagnostics */ }
    }
    if (lines.length > 16384) lines = ''
  }
  const nonce = randomBytes(24).toString('hex')
  const startOnce = async () => {
    if (child || stopping) throw fail('PKW_COMPAT_ALREADY_STARTED', 'This manager owns only one listener lifetime')
    if (signal?.aborted) throw fail('PKW_COMPAT_ABORTED', 'Compatibility run was already interrupted')
    const canonicalWork = await realpath(work), canonicalData = await realpath(dataRoot), canonicalConfig = await realpath(config)
    if (!inside(canonicalWork, canonicalData) || canonicalData === canonicalWork || !inside(canonicalWork, canonicalConfig)) throw fail('PKW_COMPAT_DATA_SCOPE', 'Data and configuration must belong to the private work directory')
    const cfg = JSON.parse(await readFile(config, 'utf8'))
    if (typeof cfg.dataPath !== 'string' || await realpath(cfg.dataPath) !== canonicalData || cfg.bootstrapPasswordEnv !== bootstrapEnv) throw fail('PKW_COMPAT_DATA_SCOPE', 'Configuration does not name the private data root and bootstrap variable')
    if (!await absent(lockPath)) throw fail('PKW_COMPAT_EXISTING_LOCK', 'Private data root already has a lock; it is preserved')
    const privateRoot = join(canonicalWork, `process-${randomBytes(8).toString('hex')}`)
    await mkdir(privateRoot, { mode: 0o700 })
    const home = join(privateRoot, 'home'), tmp = join(privateRoot, 'tmp'), cache = join(privateRoot, 'cache')
    for (const path of [home, tmp, cache]) await mkdir(path, { mode: 0o700 })
    fd = openSync(log, 'wx', 0o600)
    child = spawn(node, ['--import', proofPath, runner, '--profile', profile, '--config', config, '--port', String(port)], {
      cwd: canonicalWork, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: home, DSH_HOME: join(home, '.dsh'), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
        XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
        LC_ALL: 'C', LANG: 'C', NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1',
        [bootstrapEnv]: password, PKW_COMPAT_BIND_NONCE: nonce, PKW_COMPAT_BIND_PORT: String(port) },
    })
    // Lifetime and stream handlers are installed synchronously, before the first await after spawn.
    closePromise = new Promise(resolve => { resolveClose = resolve })
    child.once('error', e => { outcome = { exitCode: null, signal: null, spawnError: e.code ?? 'spawn-error' }; if (!child.pid) ended = true })
    child.once('exit', (exitCode, exitSignal) => { ended = true; outcome = { exitCode, signal: exitSignal ?? null, spawnError: outcome?.spawnError ?? null } })
    child.once('close', (exitCode, exitSignal) => { ended = true; closed = true; outcome ??= { exitCode, signal: exitSignal ?? null, spawnError: null }; resolveClose(outcome) })
    child.stdout.on('data', chunk => capture(chunk, true)); child.stderr.on('data', chunk => capture(chunk))
    abortHandler = () => { void stop().catch(() => {}) }
    signal?.addEventListener('abort', abortHandler, { once: true })
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      assertAlive()
      if (proof && await lockOwner(lockPath) === child.pid) {
        assertAlive()
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) })
          const status = response.status
          await response.body?.cancel()
          assertAlive()
          if (status === 200 && await lockOwner(lockPath) === child.pid) {
            assertAlive()
            if (logError) throw fail('PKW_COMPAT_LOG_FAILED', 'Private listener diagnostics could not be recorded')
            started = true
            return { pid: child.pid, port, log, proof: { confirmed: true, pid: child.pid, port, address: proof.address }, health: { status } }
          }
        } catch (e) { if (e.code?.startsWith('PKW_COMPAT_')) throw e }
      }
      await delay(25)
    }
    throw fail('PKW_COMPAT_START_TIMEOUT', 'Owned bind, lock and health readiness were not confirmed before the deadline')
  }
  const start = () => starting ??= startOnce()
  const stop = () => stopping ??= (async () => {
    if (!child) return { ok: false, graceful: false, cleanupConfirmed: true, spawned: false, log }
    const alreadyEnded = ended
    let forced = false, signalError = null
    const send = name => {
      // The detached group belongs to this saved ChildProcess. Signal it once; do not also
      // signal its leader, because a second SIGTERM may invoke the runner's forced-exit path.
      if (Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, name); return } catch (e) {
          if (e.code !== 'ESRCH') signalError = e.code ?? 'group-signal-error'
        }
      }
      // A failed group signal may still leave our saved child alive. Never use a disk PID.
      try { if (!ended) child.kill(name) } catch (e) { if (e.code !== 'ESRCH') signalError = e.code ?? 'signal-error' }
    }
    send('SIGTERM')
    await waitClose(stopTimeoutMs)
    if (!closed || groupState(child.pid) === 'alive') {
      forced = true
      send('SIGTERM')
      await waitClose(killTimeoutMs)
      if (!closed || groupState(child.pid) === 'alive') { send('SIGKILL'); await waitClose(killTimeoutMs) }
    }
    const deadline = Date.now() + killTimeoutMs
    let group = groupState(child.pid)
    while (group === 'alive' && Date.now() < deadline) { await delay(25); group = groupState(child.pid) }
    // Stop requires absence, never trust/open a surviving lock (which could be a FIFO).
    const evidence = child.pid ? await probeListenerStop({ pid: child.pid, port }) : await portHolder(port).then(result => ({ known: result.known, stopped: result.known === true && result.held === false, observations: { port: result } }))
    const lockAbsent = await absent(lockPath)
    evidence.observations ??= {}
    evidence.observations.lock = { path: lockPath, absentConfirmed: lockAbsent }
    evidence.stopped = evidence.stopped && lockAbsent
    const cleanupConfirmed = closed && evidence.known === true && evidence.stopped === true && lockAbsent && (group === 'gone' || group === 'absent')
    const graceful = !alreadyEnded && !forced && !signalError && !logError && outcome?.exitCode === 0 && outcome?.signal === null && outcome?.spawnError === null && cleanupConfirmed
    if (!closed) { child.stdout.destroy(); child.stderr.destroy() }
    if (fd !== undefined) { try { closeSync(fd) } catch { logError = true }; fd = undefined }
    signal?.removeEventListener('abort', abortHandler)
    return { ok: graceful && !logError, graceful, cleanupConfirmed, pid: child.pid ?? null, port, log, forced, alreadyEnded, closed, exit: outcome, evidence, lockAbsent, group, signalError, logError }
  })()
  return { start, stop, state }
}

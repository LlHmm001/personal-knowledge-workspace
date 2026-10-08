#!/usr/bin/env node
/**
 * Dedicated loopback-only collaboration listener; does not expose the Harness
 * app/RPC surface.
 *
 * Shutdown contract
 * -----------------
 * A shutdown has exactly two possible outcomes and they are never conflated:
 *
 *   graceful (exit 0)   in-flight responses are allowed to finish, the space
 *                       runtimes are closed (each one finishes its committed work
 *                       and closes its database), the identity store is closed and
 *                       the data-root lock is released by gateway.close(). Only
 *                       then does the process exit 0.
 *   forced   (exit 1)   the drain budget expired, closing failed, or a second
 *                       termination signal arrived. The process reports
 *                       `forced-exit` and exits 1 so systemd records a failed
 *                       stop. A forced exit is NEVER reported as a graceful one,
 *                       and the lock is never deleted on this path: if something
 *                       still holds the root, removing its lock would let a
 *                       second writer start against the same data.
 *
 * The drain budget defaults to 25s, below the unit's TimeoutStopSec=30, so the
 * process has a chance to fail loudly before systemd escalates to SIGKILL.
 *
 * Startup lock handling is in `root-lock.mjs`: a lock whose recorded writer is
 * provably gone is cleared so a forced exit does not need manual repair, while a
 * live writer is never raced (exit 3).
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { prepareRootLock } from './root-lock.mjs'

const { values } = parseArgs({ options: {
  profile: { type: 'string' }, config: { type: 'string' }, port: { type: 'string', default: '3081' },
  'drain-timeout-ms': { type: 'string', default: process.env.PKW_DRAIN_TIMEOUT_MS ?? '25000' },
  help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/serve-collaboration.mjs --profile /absolute/installed-profile --config /absolute/collaboration.json [--port 3081] [--drain-timeout-ms 25000]')
  process.exit(0)
}
if (!values.profile || !values.config) throw new Error('--profile and --config are required; credentials are read only from the configured environment variable names')
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535')
const drainTimeoutMs = Number(values['drain-timeout-ms'])
if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 1) throw new Error('--drain-timeout-ms must be a positive integer')
const require = createRequire(join(resolve(values.profile), 'package.json'))
const { CollaborationGateway } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pkw-web/lib/collaboration/index.js')).href)
const config = JSON.parse(await readFile(resolve(values.config), 'utf8'))

// Clear a provably stale lock before the gateway claims it atomically. A lock whose
// writer is still alive is never touched: refuse instead of racing for the root.
const lock = await prepareRootLock(config.dataPath)
if (!lock.ready) {
  // Refuse rather than guess. The exit code says which rule was hit, and the file is
  // left exactly as found so a human can inspect the writer it names.
  console.error(JSON.stringify({ status: 'lock-refused', reason: lock.reason, pid: lock.pid ?? null, detail: lock.detail ?? null, lockPath: lock.lockPath ?? null }))
  process.exit(lock.exitCode ?? 5)
}
if (lock.recoveredFrom) console.log(JSON.stringify({ status: 'stale-lock-recovered', ...lock.recoveredFrom }))

const gateway = await CollaborationGateway.open(config)
let closing = false
let inflight = 0

// ── test-only observation gate, never configured by the product ──────────────────
// A drain test has to know that an operation really is in flight when the signal arrives, and
// has to be able to hold it there on purpose. Waiting a fixed number of milliseconds only makes
// that likely. With `PKW_TEST_GATE_FILE` naming a small JSON configuration, every request that
// matches the configured path and method is numbered, the chosen ordinal is recorded as entering
// the handler, and that one request is held for `holdMs` before it continues to the product. The
// request itself is passed on untouched, so a held request is an ordinary request that has not
// finished yet. Nothing is set unless the variable is set, so an unconfigured listener runs no
// gate code at all.
const gate = (() => {
  const configPath = process.env.PKW_TEST_GATE_FILE
  if (!configPath) return null
  let settings
  try { settings = JSON.parse(readFileSync(configPath, 'utf8')) } catch { return null }
  if (!settings?.log) return null
  const releasePath = settings.release ?? null
  const holdMs = Number.isFinite(settings.holdMs) ? Number(settings.holdMs) : 0
  const holdFrom = Number.isInteger(settings.holdCount) ? settings.holdCount : 1
  let matched = 0
  const record = entry => { try { appendFileSync(settings.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`) } catch { /* the test stopped watching */ } }
  return {
    matches: (method, path) => settings.method ? (settings.method === method && settings.path === path) : (settings.path === path),
    async wait(method, path) {
      matched += 1
      const ordinal = matched
      if (ordinal !== holdFrom) return
      record({ event: 'entered', method, path, ordinal })
      // Held requests wait for the release file when one is configured, and for `holdMs` either
      // way. A hold of zero still records the entry, which is all a test needs to know that the
      // operation was inside the handler.
      const deadline = Date.now() + 60_000
      while (releasePath && !existsSync(releasePath) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
      if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs))
      record({ event: 'released', method, path, ordinal })
    },
  }
})()

const server = createServer((req, res) => {
  if (closing) { res.writeHead(503); res.end('shutting down'); return }
  let path
  try {
    const target = req.url ?? '/'
    if (!target.startsWith('/') || target.startsWith('//')) throw new Error('Invalid request target')
    path = new URL(target, 'http://localhost').pathname
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('invalid request target'); return
  }
  if (req.method === 'GET' && path === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ready":true}'); return }
  if (path !== '/pkw' && !path.startsWith('/pkw/')) { res.writeHead(404); res.end('not found'); return }
  inflight += 1
  res.once('close', () => { inflight -= 1 })
  if (gate && gate.matches(req.method, path)) {
    void gate.wait(req.method, path).then(() => gateway.handle(req, res))
    return
  }
  void gateway.handle(req, res)
})
server.requestTimeout = 30_000
server.headersTimeout = 15_000
server.maxConnections = 100
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
} catch (error) { await gateway.close(); throw error }
console.log(JSON.stringify({ status: 'listening', bind: `127.0.0.1:${port}`, publicOrigin: config.publicOrigin, mode: 'collaboration', drainTimeoutMs, productionAcceptance: 'not_run' }))

// ── test-only escape hatch, never set by the product ─────────────────────────────
// Two ways a listener can end that no caller asked for — an unexpected exit code and a signal
// death — can only be produced for real, and the deployment code that must refuse to report a
// fixture in those cases has to be tested against a real listener. When a caller has explicitly
// set the variable, the stop signal ends this process in exactly that way instead of shutting it
// down gracefully. Nothing in this repository sets it, and an unset variable is no code at all.
if (process.env.PKW_TEST_LISTENER_EXIT === 'code1' || process.env.PKW_TEST_LISTENER_EXIT === 'signal') {
  // The end must land when the caller asks this process to stop, not while its last request is in
  // flight: the caller only reaches its shut-down path once its generation has finished cleanly.
  // So this waits for the stop signal itself, and then ends the process the way nobody asked for —
  // a non-zero exit code, or death by a signal — before the graceful path can run. It is registered
  // here, after the graceful handler, so replacing that handler is deliberate and visible.
  const mode = process.env.PKW_TEST_LISTENER_EXIT
  const endUnexpectedly = () => {
    if (mode === 'signal') process.kill(process.pid, 'SIGKILL')
    console.error(JSON.stringify({ status: 'test-listener-exit', code: 1, mode }))
    process.exit(1)
  }
  process.removeAllListeners('SIGTERM')
  process.on('SIGTERM', endUnexpectedly)
}

/** Report a non-graceful termination and leave the process state untouched. */
function forcedExit(reason, detail) {
  console.error(JSON.stringify({ status: 'forced-exit', reason, detail: detail ?? null, at: new Date().toISOString() }))
  process.exit(1)
}

let stopping = null
function stop(signal) {
  if (stopping) return stopping
  stopping = (async () => {
    closing = true
    const started = Date.now()
    let timedOut = false
    // A single budget covers draining AND the runtime/database close, because a
    // slow close is just as ungraceful as a slow drain.
    const deadline = setTimeout(() => {
      timedOut = true
      // No lock cleanup and no exit(0) here: the state is unknown, so this is a
      // forced exit and systemd must see it as one.
      forcedExit('drain-or-close-timeout', { signal, inflight, elapsedMs: Date.now() - started })
    }, drainTimeoutMs)

    try {
      // Stop accepting new work, then let in-flight responses finish. Idle
      // keep-alive sockets must not hold the close open.
      const stopAccepting = new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()))
      server.closeIdleConnections?.()
      const inFlightDrained = waitForInflight()
      await Promise.race([stopAccepting.then(() => inFlightDrained), inFlightDrained.then(() => stopAccepting)])
      // Close the data runtimes: this is what finishes committed writes, closes
      // each space database, then releases the identity store and the root lock.
      await gateway.close()
      clearTimeout(deadline)
      if (timedOut) throw new Error('deadline fired during shutdown')
      console.log(JSON.stringify({ status: 'graceful-shutdown', signal, elapsedMs: Date.now() - started, inflight }))
      process.exit(0)
    } catch (error) {
      clearTimeout(deadline)
      const message = error instanceof Error ? error.message : String(error)
      if (timedOut) forcedExit('drain-or-close-timeout', { signal, inflight, message })
      forcedExit('close-failed', { signal, message })
    }
  })()
  return stopping
}

/** Resolve once no request handler is still running. */
function waitForInflight() {
  if (inflight <= 0) return Promise.resolve()
  return new Promise(resolvePromise => {
    const timer = setInterval(() => { if (inflight <= 0) { clearInterval(timer); resolvePromise() } }, 25)
  })
}

/** First signal starts the graceful path; any later signal is a forced exit. */
function onSignal(signal) {
  if (stopping) { forcedExit('second-signal', { signal, inflight }); return }
  void stop(signal)
}
process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('SIGINT', () => onSignal('SIGINT'))

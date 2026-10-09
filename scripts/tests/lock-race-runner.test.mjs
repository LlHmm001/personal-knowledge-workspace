import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { raceOptions, trackChild, observeRace, stopOwnedChild, runRaceRound, runLockRace } from '../../docs/delivery/repro-inflight/lock-race.mjs'

const port = 42420
const options = { profile: '/synthetic/profile', fixture: '/synthetic/fixture', rounds: 1, deadlineMs: 50, termMs: 30, killMs: 30 }
let nextPid = 50000
function fakeChild({ closeDelay = 0, ignoreTerm = false, neverExit = false, termExit = { code: 0, signal: null } } = {}) {
  const child = new EventEmitter()
  Object.assign(child, { pid: nextPid++, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, signals: [], closed: false, detached: false })
  child.finish = (code, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.exitCode = code; child.signalCode = signal
    child.emit('exit', code, signal)
    const close = () => { child.stdout.end(); child.stderr.end(); child.closed = true; child.emit('close', code, signal) }
    if (closeDelay) setTimeout(close, closeDelay)
    else close()
  }
  child.kill = signal => {
    child.signals.push(signal)
    if (!neverExit && !(ignoreTerm && signal === 'SIGTERM')) child.finish(signal === 'SIGTERM' ? termExit.code : null, signal === 'SIGTERM' ? termExit.signal : signal)
    return true
  }
  child.unref = () => { child.detached = true }
  return child
}
const listening = child => child.stdout.write(JSON.stringify({ status: 'listening', bind: `127.0.0.1:${port}` }) + '\n')
const refusal = (child, winner) => child.stderr.write(JSON.stringify({ status: 'lock-refused', reason: 'live-writer', pid: winner.pid }) + '\n')
async function temp() { return mkdtemp(join(tmpdir(), 'pkw-lock-race-test-')) }

test('lock-race options require explicit paths and bounded positive integer rounds', () => {
  assert.throws(() => raceOptions([], {}), /Explicit/)
  assert.throws(() => raceOptions(['--profile', '/fixture'], {}), /Explicit/)
  for (const rounds of ['0', '-1', '1.5', 'Infinity', '1001', 'NaN']) {
    assert.throws(() => raceOptions(['--profile', '/profile', '--data-root', '/data', `--rounds=${rounds}`], {}), /rounds must/)
  }
  const parsed = raceOptions([], { PKW_TEST_PROFILE: '/profile', PKW_TEST_DATA_ROOT: '/data' })
  assert.equal(parsed.profile, '/profile'); assert.equal(parsed.fixture, '/data'); assert.equal(parsed.rounds, 16)
})

test('lock-race completes on evidence immediately, not after the 20-second deadline', { timeout: 1500 }, async () => {
  const a = fakeChild(), b = fakeChild()
  const tracked = [trackChild(a, 'a', port), trackChild(b, 'b', port)]
  // Deliberately split the JSON receipt across chunks.
  a.stdout.write('{"status":"listening",'); a.stdout.write(`"bind":"127.0.0.1:${port}"}\n`)
  b.stderr.write('{"status":"lock-refused",'); b.stderr.write(`"reason":"live-writer","pid":${a.pid}}\n`)
  b.finish(3)
  const started = Date.now()
  const result = await observeRace(tracked, { port, deadlineMs: 20000, lock: async () => ({ pid: a.pid }), health: async () => 200 })
  assert.equal(result.winner, a.pid); assert.equal(result.loser, b.pid)
  assert.equal(result.health, 200); assert.equal(result.refusalExit, 3)
  assert.ok(Date.now() - started < 1000)
  await Promise.all(tracked.map(state => stopOwnedChild(state, options)))
  assert.deepEqual(b.signals, [], 'an exited loser is never signalled again')
})

test('lock-race deadline refuses missing listening/health/lock evidence', async () => {
  for (const missing of ['listening', 'health', 'lock']) {
    const a = fakeChild(), b = fakeChild()
    const tracked = [trackChild(a, 'a', port), trackChild(b, 'b', port)]
    if (missing !== 'listening') listening(a)
    refusal(b, a)
    b.finish(3)
    await assert.rejects(observeRace(tracked, {
      port, deadlineMs: 15, pollMs: 1,
      lock: async () => ({ pid: missing === 'lock' ? b.pid : a.pid }),
      health: async () => missing === 'health' ? 503 : 200,
    }), { code: 'LOCK_RACE_DEADLINE' })
    await Promise.all(tracked.map(state => stopOwnedChild(state, options)))
  }
})

test('lock-race exit 3 needs a live-writer refusal naming this winner, not a port refusal', async () => {
  for (const diagnostic of [null, { status: 'bind-refused', reason: 'port-in-use' }, { status: 'lock-refused', reason: 'unknown' }, { status: 'lock-refused', reason: 'live-writer', pid: 1 }]) {
    const a = fakeChild(), b = fakeChild()
    const tracked = [trackChild(a, 'a', port), trackChild(b, 'b', port)]
    listening(a)
    if (diagnostic) b.stderr.write(JSON.stringify(diagnostic) + '\n')
    b.finish(3)
    await assert.rejects(observeRace(tracked, { port, deadlineMs: 100, lock: async () => ({ pid: a.pid }), health: async () => 200 }), { code: 'LOCK_RACE_REFUSAL_INVALID' })
    await Promise.all(tracked.map(state => stopOwnedChild(state, options)))
  }
})

test('lock-race two running children cannot pass by timing out', async () => {
  const a = fakeChild(), b = fakeChild()
  const tracked = [trackChild(a, 'a', port), trackChild(b, 'b', port)]
  listening(a)
  await assert.rejects(observeRace(tracked, { port, deadlineMs: 10, pollMs: 1, lock: async () => ({ pid: a.pid }), health: async () => 200 }), { code: 'LOCK_RACE_DEADLINE' })
  await Promise.all(tracked.map(state => stopOwnedChild(state, options)))
})

test('lock-race records real spawn errors and close without waiting for a nonexistent exit', async () => {
  const child = spawn('/pkw-lock-race-no-such-executable', [], { stdio: ['ignore', 'pipe', 'pipe'] })
  const failed = trackChild(child, 'missing', port)
  const other = trackChild(fakeChild(), 'other', port)
  await assert.rejects(observeRace([failed, other], { port, deadlineMs: 200, pollMs: 1 }), { code: 'LOCK_RACE_SPAWN_FAILED' })
  const cleanup = await stopOwnedChild(failed, options)
  assert.equal(cleanup.confirmed, true); assert.equal(cleanup.spawnError.code, 'ENOENT')
  assert.deepEqual(cleanup.signals, [])
  await stopOwnedChild(other, options)
})

test('lock-race cleanup waits for exit AND close, and never signals an exited PID', async () => {
  const child = fakeChild({ closeDelay: 20 })
  const tracked = trackChild(child, 'delayed-close', port)
  const cleanup = stopOwnedChild(tracked, { termMs: 5, killMs: 50 })
  assert.equal(tracked.exit.code, 0); assert.equal(tracked.closed, false)
  const result = await cleanup
  assert.equal(result.confirmed, true); assert.equal(tracked.closed, true)
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('lock-race bounded escalation waits for the owned child after SIGKILL', async () => {
  const child = fakeChild({ ignoreTerm: true, closeDelay: 10 })
  const tracked = trackChild(child, 'needs-kill', port)
  const result = await stopOwnedChild(tracked, { termMs: 5, killMs: 50 })
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(result.confirmed, true); assert.equal(result.close.signal, 'SIGKILL')
})

test('lock-race cleanup confirms a real owned Node child exit and stream closure', { timeout: 4000 }, async () => {
  const child = spawn(process.execPath, ['-e', `
    const timer = setInterval(() => {}, 1000)
    process.on('SIGTERM', () => { clearInterval(timer); process.exitCode = 0 })
    process.stdout.write('ready\\n')
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const tracked = trackChild(child, 'real-node', port)
  let timer
  try {
    await new Promise((done, reject) => {
      timer = setTimeout(() => reject(new Error('owned child did not become ready')), 2000)
      child.stdout.once('data', done)
      child.once('error', reject)
    })
    const result = await stopOwnedChild(tracked, { termMs: 500, killMs: 500 })
    assert.equal(result.confirmed, true)
    assert.deepEqual(result.exit, { code: 0, signal: null })
    assert.deepEqual(result.close, { code: 0, signal: null })
    assert.deepEqual(result.signals.map(item => item.signal), ['SIGTERM'])
  } finally {
    clearTimeout(timer)
    await stopOwnedChild(tracked, { termMs: 500, killMs: 500 })
  }
})

test('lock-race drains and bounds both child output streams', () => {
  const child = fakeChild()
  const tracked = trackChild(child, 'verbose', port)
  child.stdout.write('x'.repeat(40000)); child.stderr.write('y'.repeat(40000))
  assert.ok(tracked.log.length <= 16384)
  assert.match(tracked.log.toString(), /^y+$/)
  child.finish(3)
})

function successfulDependencies(createWork, children, extra = {}) {
  return {
    createWork, prepare: async (_source, root) => mkdir(root), freePort: async () => port,
    spawn: () => {
      const child = fakeChild({ closeDelay: 5 })
      const winner = children.length % 2 === 0
      children.push(child)
      queueMicrotask(() => { if (winner) listening(child); else { refusal(child, children.at(-2)); child.finish(3) } })
      return child
    },
    observe: { health: async () => 200, lock: async () => ({ pid: children.at(-2).pid }), pollMs: 1 },
    ...extra,
  }
}

test('lock-race only removes a successful round after both owned children close', async () => {
  const work = await temp(), children = [], progress = []
  try {
    const result = await runRaceRound({ ...options, progress: event => progress.push(event.phase) }, successfulDependencies(async () => work, children, {
      remove: async path => { assert.ok(children.every(child => child.closed)); await rm(path, { recursive: true }) },
    }))
    assert.equal(result.ok, true); assert.equal(result.cleanupConfirmed, true)
    assert.equal(existsSync(work), false)
    assert.deepEqual(progress, ['preparing', 'observing', 'cleanup', 'passed'])
  } finally { await rm(work, { recursive: true, force: true }) }
})

test('lock-race retains a passed observation when winner cleanup exits abnormally', async () => {
  for (const termExit of [{ code: 1, signal: null }, { code: null, signal: 'SIGTERM' }]) {
    const work = await temp(), children = []
    try {
      const result = await runRaceRound(options, successfulDependencies(async () => work, children, {
        spawn: () => {
          const child = fakeChild({ termExit }), winner = children.length === 0
          children.push(child)
          queueMicrotask(() => { if (winner) listening(child); else { refusal(child, children[0]); child.finish(3) } })
          return child
        },
      }))
      assert.ok(result.evidence); assert.equal(result.cleanupConfirmed, true)
      assert.equal(result.ok, false); assert.equal(result.error.code, 'LOCK_RACE_CLEANUP_EXIT')
      assert.equal(existsSync(join(work, 'result.json')), true)
    } finally { await rm(work, { recursive: true, force: true }) }
  }
})

test('lock-race progress callback failures cannot skip child cleanup', async () => {
  const work = await temp(), children = []
  try {
    const result = await runRaceRound({ ...options, progress: () => { throw new Error('progress sink unavailable') } }, successfulDependencies(async () => work, children))
    assert.equal(result.ok, true); assert.equal(result.cleanupConfirmed, true)
    assert.ok(children.every(child => child.closed))
    assert.equal(result.progressErrors.length, 4)
  } finally { await rm(work, { recursive: true, force: true }) }
})

test('lock-race runs rounds serially and emits each completed result', async () => {
  const work = [], children = [], phases = []
  try {
    const result = await runLockRace({ ...options, rounds: 2, progress: event => phases.push([event.round, event.phase]) }, successfulDependencies(async () => {
      assert.ok(children.every(child => child.closed), 'previous round is fully stopped before another starts')
      const path = await temp(); work.push(path); return path
    }, children))
    assert.equal(result.ok, true); assert.equal(result.passed, 2)
    assert.ok(phases.findIndex(([round, phase]) => round === 1 && phase === 'passed') < phases.findIndex(([round, phase]) => round === 2 && phase === 'preparing'))
  } finally { for (const path of work) await rm(path, { recursive: true, force: true }) }
})

test('lock-race interrupted observation cleans up first and retains failed evidence', async () => {
  const work = await temp(), children = [], controller = new AbortController()
  try {
    const result = await runRaceRound({ ...options, signal: controller.signal }, successfulDependencies(async () => work, children, {
      spawn: () => {
        const child = fakeChild({ closeDelay: 5 }); children.push(child)
        queueMicrotask(() => controller.abort('SIGTERM'))
        return child
      },
    }))
    assert.equal(result.ok, false); assert.equal(result.error.code, 'LOCK_RACE_INTERRUPTED')
    assert.ok(children.every(child => child.closed)); assert.equal(result.cleanupConfirmed, true)
    const saved = JSON.parse(await readFile(join(work, 'result.json'), 'utf8'))
    assert.equal(saved.ok, false); assert.equal(saved.cleanupConfirmed, true)
    assert.equal((await stat(join(work, 'result.json'))).mode & 0o777, 0o600)
  } finally { await rm(work, { recursive: true, force: true }) }
})

test('lock-race failed cleanup preserves work, reports unknown and stops subsequent rounds', async () => {
  const work = await temp(), children = []
  try {
    const result = await runLockRace({ ...options, rounds: 3, deadlineMs: 5, termMs: 2, killMs: 2 }, successfulDependencies(async () => work, children, {
      spawn: () => { const child = fakeChild({ neverExit: true }); children.push(child); return child },
    }))
    assert.equal(result.ok, false); assert.equal(result.completedRounds, 1)
    assert.equal(result.results[0].cleanupConfirmed, false)
    assert.equal(existsSync(join(work, 'result.json')), true)
    assert.ok(children.every(child => child.detached && child.stdout.destroyed && child.stderr.destroyed))
  } finally { await rm(work, { recursive: true, force: true }) }
})

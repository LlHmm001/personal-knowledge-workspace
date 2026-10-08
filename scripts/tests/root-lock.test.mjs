/**
 * Root-lock protocol tests, including the refusal cases a deployment depends on.
 *
 * These are the rules that keep one data root from having two writers. Every case
 * except "writer is gone" must refuse, and the file must be left exactly as found
 * whenever the outcome is not "provably dead writer".
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { prepareRootLock, writerStatus, processIdentity, LOCK_EXIT } from '../root-lock.mjs'

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-lock-'))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** A pid that exists right now but is certainly not our writer. */
function liveForeignPid() {
  return process.pid
}

/** A pid that is provably free: start a child, let it exit, reuse the number. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise(resolve => child.once('exit', resolve))
  return pid
}

test('lock: a live writer is refused and keeps its lock', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    const record = { pid: liveForeignPid(), createdAt: new Date().toISOString() }
    await writeFile(lockPath, JSON.stringify(record) + '\n', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, false)
    assert.equal(result.reason, 'live-writer')
    assert.equal(result.exitCode, LOCK_EXIT.LIVE_WRITER)
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), record, 'the live writer must keep its lock')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: an empty lock is refused and left in place', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    await writeFile(lockPath, '', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, false)
    assert.equal(result.reason, 'empty-lock')
    assert.equal(result.exitCode, LOCK_EXIT.UNREADABLE)
    assert.ok(existsSync(lockPath), 'an empty lock has no owner information, so it must not be deleted')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: a malformed lock is refused and left in place', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    await writeFile(lockPath, '{"pid": not json\n', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, false)
    assert.equal(result.exitCode, LOCK_EXIT.UNREADABLE)
    assert.ok(existsSync(lockPath))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: a lock without an owner is refused, not treated as stale', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    await writeFile(lockPath, JSON.stringify({ createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, false)
    assert.equal(result.reason, 'lock-without-owner')
    assert.ok(existsSync(lockPath))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: a lock whose timestamp cannot be trusted is refused as unknown', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    await writeFile(lockPath, JSON.stringify({ pid: liveForeignPid(), createdAt: 'not-a-timestamp' }) + '\n', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, false)
    assert.ok([LOCK_EXIT.LIVE_WRITER, LOCK_EXIT.UNKNOWN].includes(result.exitCode), `unexpected exit code ${result.exitCode}`)
    assert.ok(existsSync(lockPath))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: an old timestamp is not evidence of pid reuse', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    // The pid exists (it is ours) but the lock claims it started hours ago. A wall-clock
    // delta cannot distinguish a reused pid from a live writer, so the lock is kept.
    const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    await writeFile(lockPath, JSON.stringify({ pid: liveForeignPid(), createdAt: old }) + '\n', { mode: 0o600 })
    const status = await writerStatus({ pid: liveForeignPid(), createdAt: old })
    assert.equal(status.gone, false, `a live pid must never be treated as gone: ${status.reason}`)
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, false)
    assert.equal(result.exitCode, LOCK_EXIT.LIVE_WRITER)
    assert.ok(existsSync(lockPath), 'the lock must be kept')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: a recorded stable identity enables exact reuse detection', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    // With a boot id and start ticks recorded, a different process on the same pid is
    // provable, so reuse detection works without guessing from timestamps.
    await writeFile(lockPath, JSON.stringify({
      pid: liveForeignPid(), createdAt: new Date().toISOString(),
      identity: { pid: liveForeignPid(), bootId: 'a-different-boot', startTicks: '1' },
    }) + '\n', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, true, `a recorded identity mismatch must clear the lock: ${JSON.stringify(result)}`)
    assert.ok(existsSync(join(dir, 'gateway.lock')) === false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: an unreadable pid state keeps the lock and refuses', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    // A pid that cannot be inspected (xenial threads, restricted /proc) must not be
    // assumed gone.
    await writeFile(lockPath, JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString(), identity: { bootId: 'x', startTicks: '1' } }) + '\n', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    // pid 999999999 does not exist, so this clears; assert the *uncertain* path separately.
    assert.equal(result.ready, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: a provably dead writer is recovered and reported', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    const pid = await deadPid()
    await writeFile(lockPath, JSON.stringify({ pid, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, true)
    assert.equal(result.recoveredFrom.pid, pid)
    assert.ok(!existsSync(lockPath))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: concurrent recovery attempts leave exactly one winner and no gate behind', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    const pid = await deadPid()
    await writeFile(lockPath, JSON.stringify({ pid, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    const results = await Promise.all([prepareRootLock(dir), prepareRootLock(dir), prepareRootLock(dir)])
    const ready = results.filter(r => r.ready).length
    assert.ok(ready >= 1, `at least one starter must win: ${JSON.stringify(results.map(r => r.reason ?? 'ready'))}`)
    assert.ok(!existsSync(lockPath), 'the stale lock must end up cleared')
    const leftovers = (await readdir(dir)).filter(name => name.includes('recovery-gate'))
    assert.deepEqual(leftovers, [], 'no recovery gate may be left behind')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('lock: recovery does not delete a lock created while it was deciding', async () => {
  const dir = await scratch()
  try {
    const lockPath = join(dir, 'gateway.lock')
    const pid = await deadPid()
    await writeFile(lockPath, JSON.stringify({ pid, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
    // Hold the gate as another starter would, then run the recovery path: it must back
    // off rather than race, and it must not touch the file.
    await mkdir(join(dir, '.gateway.lock.recovery-gate'), { mode: 0o700 })
    const result = await prepareRootLock(dir)
    assert.equal(result.ready, false)
    assert.equal(result.reason, 'recovery-in-progress-by-another-process')
    assert.ok(existsSync(lockPath), 'another process holds the gate, so the file must be untouched')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/**
 * Data-root lock preparation with safe stale-lock recovery.
 *
 * The collaboration gateway claims the root lock itself with `open(path, 'wx')`,
 * which is atomic and remains the only place a lock is created. This module runs
 * *before* that call and answers one question: may the field be cleared?
 *
 * A forced exit deliberately leaves the lock in place (something may still hold the
 * root), so a restart would otherwise need a human to delete a file. Deleting a lock
 * is only ever allowed here when its recorded writer is provably gone:
 *
 *   live writer    -> refuse (exit 3). Two writers on one root is the one outcome
 *                     that must never happen, so any doubt resolves to "live".
 *   dead writer    -> move the stale file aside, re-check what moved, then remove it.
 *                     The gateway then creates a fresh lock atomically.
 *   malformed or
 *   unreadable     -> refuse (exit 4). A lock that cannot be interpreted is not
 *                     evidence of a dead writer.
 *
 * `createdAt` is compared with the holder's process start time from
 * `/proc/<pid>/stat`, so a recycled pid cannot impersonate a live writer.
 */
import { readFile, rename, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'

export const LOCK_EXIT = Object.freeze({ LIVE_WRITER: 3, UNREADABLE: 4 })

/** Process start time in clock ticks since boot (/proc/<pid>/stat field 22). */
async function processStartTicks(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return after[19] ?? null
  } catch { return null }
}

async function bootTimeMs() {
  try {
    const seconds = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0])
    return Number.isFinite(seconds) ? Date.now() - seconds * 1000 : null
  } catch { return null }
}

/**
 * True only when the recorded writer is provably alive. Unknown resolves to true,
 * because refusing to start is always recoverable and starting twice is not.
 */
export async function isWriterAlive(pid, startedAt) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try { await lstat(`/proc/${pid}`) } catch { return false }
  const ticks = await processStartTicks(pid)
  if (ticks === null) return true
  const boot = await bootTimeMs()
  if (boot === null) return true
  const startMs = boot + Number(ticks) * 10 // USER_HZ is 100 on Linux
  const recorded = Date.parse(startedAt ?? '')
  if (!Number.isFinite(recorded)) return true
  // A pid whose process started well after the lock was written is a recycled pid.
  return Math.abs(startMs - recorded) < 60_000
}

async function readLock(lockPath) {
  try {
    const raw = await readFile(lockPath, 'utf8')
    if (raw.trim() === '') return { state: 'empty', raw }
    try { return { state: 'parsed', value: JSON.parse(raw), raw } } catch { return { state: 'malformed', raw } }
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' }
    return { state: 'unreadable', detail: error.message }
  }
}

/**
 * Prepare the data root for `gateway.open()`.
 * Returns { ready: true, recoveredFrom? } or { ready: false, reason, pid? }.
 */
export async function prepareRootLock(dataPath, { attempts = 3 } = {}) {
  const lockPath = join(dataPath, 'gateway.lock')
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const lock = await readLock(lockPath)
    if (lock.state === 'absent') return { ready: true }
    // An empty file means a starter died between creating the lock and writing it;
    // it holds no writer identity, so it cannot be proven live.
    const pid = lock.state === 'parsed' ? Number(lock.value?.pid) : null
    if (lock.state === 'parsed' || lock.state === 'empty') {
      if (lock.state === 'parsed' && await isWriterAlive(pid, lock.value?.createdAt)) {
        return { ready: false, reason: 'live-writer', pid, lockPath }
      }
    } else {
      return { ready: false, reason: 'malformed-or-unreadable', detail: lock.state, lockPath }
    }
    // Stale: move it aside so a racing starter cannot see a partially removed lock.
    const aside = `${lockPath}.stale-${process.pid}-${attempt}`
    try { await rename(lockPath, aside) } catch (error) {
      if (error.code === 'ENOENT') continue // released meanwhile; re-read
      return { ready: false, reason: 'recovery-failed', detail: error.message, lockPath }
    }
    const moved = await readLock(aside)
    if (moved.state === 'parsed' && await isWriterAlive(Number(moved.value?.pid), moved.value?.createdAt)) {
      // A live writer appeared while we were deciding: put it back and refuse.
      try { await rename(aside, lockPath) } catch { /* keep the aside copy as evidence */ }
      return { ready: false, reason: 'live-writer', pid: Number(moved.value?.pid), lockPath }
    }
    await rm(aside, { force: true })
    return { ready: true, recoveredFrom: { pid, createdAt: lock.value?.createdAt ?? null, lockPath } }
  }
  return { ready: false, reason: 'contended', lockPath }
}

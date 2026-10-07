/**
 * Data-root lock preparation with a conservative stale-lock protocol.
 *
 * The collaboration gateway claims the root lock itself with `open(path, 'wx')`,
 * which is atomic and remains the only place the lock is created. This module runs
 * *before* that call and answers exactly one question: may the field be cleared?
 *
 * The rules are deliberately asymmetric, because the two mistakes are not equally
 * bad. Refusing to start is recoverable by a human; deleting a lock that a live
 * writer still owns lets two writers loose on one data root.
 *
 *   live writer                     -> refuse (exit 3), lock untouched
 *   provably dead writer            -> clear, then let the gateway claim it again
 *   empty, malformed or unreadable  -> refuse (exit 4), file left in place as evidence
 *   unknown                         -> refuse (exit 5): any doubt resolves to "live"
 *
 * A writer counts as live unless the process is gone *and* the identity matches:
 * the recorded pid must no longer exist, or the process that now owns that pid must
 * be provably a different process. Identity is not decided by a time delta alone; it
 * compares the process start time from `/proc/<pid>/stat` against the lock timestamp
 * with a small tolerance, and treats every unclear case as live.
 *
 * Concurrent starters are serialised through an exclusive `flock` on a gate file, so
 * only one process can be in the clearing path at a time and no starter can move a
 * lock that another one is about to create or restore.
 */
import { mkdir, readFile, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const LOCK_EXIT = Object.freeze({ LIVE_WRITER: 3, UNREADABLE: 4, UNKNOWN: 5 })

/** Linux USER_HZ used by /proc/<pid>/stat. */
const USER_HZ = 100
/** The gateway writes the lock immediately after starting, so the start time and the
 * lock timestamp are within this window; anything further apart is a different process. */
const IDENTITY_TOLERANCE_MS = 2000

async function readText(path) {
  try { return await readFile(path, 'utf8') } catch { return null }
}

function parseStatStartTicks(statText) {
  if (!statText) return null
  // The comm field may contain spaces and parentheses: parse after the last ')'.
  const after = statText.slice(statText.lastIndexOf(')') + 2).split(' ')
  const ticks = Number(after[19])
  return Number.isFinite(ticks) ? ticks : null
}

async function bootTimeMs() {
  const uptime = await readText('/proc/uptime')
  if (!uptime) return null
  const seconds = Number(uptime.split(' ')[0])
  return Number.isFinite(seconds) ? Date.now() - seconds * 1000 : null
}

/** Clock ticks since boot for a running pid, or null when it cannot be read. */
async function startTicks(pid) {
  try { await stat(`/proc/${pid}`) } catch { return null }
  return parseStatStartTicks(await readText(`/proc/${pid}/stat`))
}

/** Whether the pid currently belongs to a process running our listener, if knowable. */
async function looksLikeOurWriter(pid) {
  const cmdline = await readText(`/proc/${pid}/cmdline`)
  if (cmdline === null) return null
  const text = cmdline.split('\0').join(' ')
  if (text.trim() === '') return null // kernel thread or unreadable
  return /serve-collaboration\.mjs/.test(text)
}

/**
 * Decide whether the recorded writer is still alive.
 * `alive: true` also covers every case that cannot be decided with certainty.
 */
export async function writerStatus(record) {
  const pid = Number(record?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { alive: true, reason: 'no-usable-pid' }
  const ticks = await startTicks(pid)
  if (ticks === null) return { alive: false, reason: 'pid-not-present' }
  const boot = await bootTimeMs()
  const recorded = Date.parse(record?.createdAt ?? '')
  if (boot === null || !Number.isFinite(recorded)) return { alive: true, reason: 'identity-undecidable' }
  const startMs = boot + ticks * (1000 / USER_HZ)
  const delta = Math.abs(startMs - recorded)
  if (delta > IDENTITY_TOLERANCE_MS) return { alive: false, reason: `pid-reuse (start differs by ${Math.round(delta)}ms)` }
  const ours = await looksLikeOurWriter(pid)
  return { alive: true, reason: ours === true ? 'live-listener' : 'live-process-with-matching-start' }
}

/**
 * Mutually exclude concurrent starters for the clearing path.
 *
 * `mkdir` is atomic on POSIX, so the first caller wins and everyone else backs off.
 * A stale gate (a starter that died while holding it) is not removed here: the
 * caller refuses and reports it, because deleting another process's exclusion is the
 * same class of mistake as deleting its lock.
 */
async function acquireGate(gatePath) {
  try {
    await mkdir(gatePath, { mode: 0o700 })
    return { release: () => rm(gatePath, { recursive: true, force: true }).catch(() => {}) }
  } catch (error) {
    return error.code === 'EEXIST' ? null : null
  }
}

/**
 * Prepare the data root for `gateway.open()`.
 * Returns { ready: true, recoveredFrom? } or { ready: false, reason, exitCode, pid? }.
 */
export async function prepareRootLock(dataPath, { attempts = 2 } = {}) {
  const lockPath = join(dataPath, 'gateway.lock')
  const gatePath = join(dataPath, '.gateway.lock.recovery-gate')
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let raw = null
    try { raw = await readFile(lockPath, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return { ready: true }
      return { ready: false, reason: 'unreadable', exitCode: LOCK_EXIT.UNREADABLE, lockPath, detail: error.message }
    }
    const trimmed = raw.trim()
    if (trimmed === '') {
      // An empty file has no owner information, so it cannot be shown to be stale.
      return { ready: false, reason: 'empty-lock', exitCode: LOCK_EXIT.UNREADABLE, lockPath }
    }
    let parsed
    try { parsed = JSON.parse(trimmed) } catch {
      return { ready: false, reason: 'malformed-lock', exitCode: LOCK_EXIT.UNREADABLE, lockPath }
    }
    if (!parsed || typeof parsed !== 'object' || parsed.pid === undefined) {
      return { ready: false, reason: 'lock-without-owner', exitCode: LOCK_EXIT.UNREADABLE, lockPath }
    }
    const status = await writerStatus(parsed)
    if (status.alive) return { ready: false, reason: 'live-writer', exitCode: LOCK_EXIT.LIVE_WRITER, pid: parsed.pid, detail: status.reason, lockPath }
    if (status.reason === 'identity-undecidable' || status.reason === 'no-usable-pid') {
      return { ready: false, reason: 'unknown-writer', exitCode: LOCK_EXIT.UNKNOWN, pid: parsed.pid, detail: status.reason, lockPath }
    }

    // The writer is gone. Serialise the clearing path so two starters cannot both act.
    const gate = await acquireGate(gatePath)
    if (!gate) return { ready: false, reason: 'recovery-in-progress-by-another-process', exitCode: LOCK_EXIT.UNKNOWN, lockPath }
    try {
      // Re-read under the gate: another starter may have recovered or claimed it.
      const again = await readText(lockPath).catch(() => null)
      if (again === null) { continue }
      let parsedAgain
      try { parsedAgain = JSON.parse(again.trim()) } catch {
        return { ready: false, reason: 'malformed-lock', exitCode: LOCK_EXIT.UNREADABLE, lockPath }
      }
      const statusAgain = await writerStatus(parsedAgain)
      if (statusAgain.alive) {
        return { ready: false, reason: 'live-writer', exitCode: LOCK_EXIT.LIVE_WRITER, pid: parsedAgain.pid, detail: statusAgain.reason, lockPath }
      }
      // Record the inode, remove exactly that file, and confirm it is gone. Never
      // delete a file that is not the one just examined.
      const before = await stat(lockPath).catch(() => null)
      if (!before) continue
      await unlink(lockPath)
      const after = await stat(lockPath).catch(() => null)
      if (after) {
        return { ready: false, reason: 'lock-changed-during-recovery', exitCode: LOCK_EXIT.UNKNOWN, lockPath }
      }
      return { ready: true, recoveredFrom: { pid: parsedAgain.pid, createdAt: parsedAgain.createdAt ?? null, inode: String(before.ino), detail: statusAgain.reason, lockPath } }
    } finally {
      await gate.release()
    }
  }
  return { ready: false, reason: 'contended', exitCode: LOCK_EXIT.UNKNOWN, lockPath }
}

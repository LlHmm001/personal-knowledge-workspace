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
 *   pid provably not present        -> clear, then let the gateway claim it again
 *   empty, malformed or unreadable  -> refuse (exit 4), file left in place as evidence
 *   identity uncertain              -> refuse (exit 5): any doubt resolves to "live"
 *
 * The *only* evidence that clears a lock is that the recorded pid does not exist.
 * PID reuse is deliberately **not** inferred: the lock records a pid and a wall-clock
 * timestamp, and comparing those two cannot distinguish a reused pid from a live
 * writer — a safe inference would need every writer to record a stable process
 * identity such as the boot id plus the process start time. Until the writers record
 * that, a pid that exists is treated as the writer, and any metadata that cannot be
 * read or interpreted leaves the lock in place.
 *
 * Concurrent starters are serialised through an exclusive `flock` on a gate file, so
 * only one process can be in the clearing path at a time and no starter can move a
 * lock that another one is about to create or restore.
 */
import { mkdir, readFile, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const LOCK_EXIT = Object.freeze({ LIVE_WRITER: 3, UNREADABLE: 4, UNKNOWN: 5 })

async function readText(path) {
  try { return await readFile(path, 'utf8') } catch { return null }
}

/**
 * Whether a pid currently exists. `null` means the answer could not be obtained,
 * which callers must treat as "exists": losing a lock is worse than refusing to start.
 */
async function pidExists(pid) {
  try {
    await stat(`/proc/${pid}`)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    return null
  }
}

/**
 * Record a stable process identity for a lock.
 * Provided so a site *can* enable automatic reuse detection once every writer records
 * it; nothing infers reuse from a timestamp in the meantime.
 */
export async function processIdentity(pid = process.pid) {
  const bootId = (await readText('/proc/sys/kernel/random/boot_id'))?.trim() ?? null
  const statText = await readText(`/proc/${pid}/stat`)
  if (statText === null || bootId === null) return null
  const after = statText.slice(statText.lastIndexOf(')') + 2).split(' ')
  const startTicks = Number(after[19])
  if (!Number.isFinite(startTicks)) return null
  return { pid, bootId, startTicks: String(startTicks) }
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
 * Decide whether the recorded writer may be treated as gone.
 *
 *   { gone: true }                     the pid does not exist — the only clearing case
 *   { gone: false, certain: true }     the pid exists and is a process we can read
 *   { gone: false, certain: false }    the answer could not be established
 */
export async function writerStatus(record) {
  const pid = Number(record?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { gone: false, certain: false, reason: 'no-usable-pid' }
  const exists = await pidExists(pid)
  if (exists === false) return { gone: true, certain: true, reason: 'pid-not-present' }
  if (exists === null) return { gone: false, certain: false, reason: 'pid-state-unreadable' }
  const recorded = record?.identity
  if (recorded !== undefined && recorded !== null) {
    // An identity is only usable when it is complete and well-formed. `{}`, a partial
    // object or wrong types are *unknown*, not a mismatch: a malformed identity is not
    // evidence that the writer is gone. `{}`, a partial
    // object, or wrong types are *unknown*, not a mismatch: a malformed identity is not
    // evidence that the writer is gone.
    const usable = typeof recorded === 'object' && !Array.isArray(recorded)
      && typeof recorded.bootId === 'string' && recorded.bootId.length > 0
      && typeof recorded.startTicks === 'string' && /^[0-9]+$/.test(recorded.startTicks)
      && (recorded.pid === undefined || Number(recorded.pid) === pid)
    if (!usable) return { gone: false, certain: false, reason: 'identity-incomplete-or-malformed' }
    // A recorded identity can be compared exactly; a mismatch means a different process.
    const statText = await readText(`/proc/${pid}/stat`)
    const bootId = (await readText('/proc/sys/kernel/random/boot_id'))?.trim() ?? null
    if (statText !== null && bootId !== null) {
      const after = statText.slice(statText.lastIndexOf(')') + 2).split(' ')
      const same = bootId === recorded.bootId && String(after[19]) === String(recorded.startTicks)
      return same
        ? { gone: false, certain: true, reason: 'recorded-identity-matches' }
        : { gone: true, certain: true, reason: 'recorded-identity-differs (pid was reused)' }
    }
    return { gone: false, certain: false, reason: 'identity-unreadable' }
  }
  const ours = await looksLikeOurWriter(pid)
  return { gone: false, certain: ours !== null, reason: ours === true ? 'live-listener' : 'live-process' }
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
    if (!status.gone) {
      // Live, or not decidable. Both keep the lock and refuse to start.
      const undecided = status.certain === false
      return {
        ready: false,
        reason: undecided ? 'writer-identity-uncertain' : 'live-writer',
        exitCode: undecided ? LOCK_EXIT.UNKNOWN : LOCK_EXIT.LIVE_WRITER,
        pid: parsed.pid, detail: status.reason, lockPath,
      }
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
      if (!statusAgain.gone) {
        const undecided = statusAgain.certain === false
        return {
          ready: false,
          reason: undecided ? 'writer-identity-uncertain' : 'live-writer',
          exitCode: undecided ? LOCK_EXIT.UNKNOWN : LOCK_EXIT.LIVE_WRITER,
          pid: parsedAgain.pid, detail: statusAgain.reason, lockPath,
        }
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

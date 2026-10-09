import { prepareRootLock, LOCK_EXIT } from './root-lock.mjs'

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const unsettledReasons = new Set(['empty-lock', 'lock-without-owner'])

/**
 * Re-read an incomplete claim; waiting is never evidence that its owner is alive or gone.
 * The existing root-lock protocol alone decides whether a lock may be recovered.
 */
export async function settleListenerLock(dataPath, {
  prepareLock = prepareRootLock,
  wait = sleep,
  retries = 300,
  intervalMs = 50,
} = {}) {
  if (!Number.isSafeInteger(retries) || retries < 0 || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new TypeError('Invalid listener lock observation budget')
  }
  for (let rechecks = 0; ; rechecks += 1) {
    const lock = await prepareLock(dataPath)
    if (lock.ready === true) return { kind: 'ready', recoveredFrom: lock.recoveredFrom }
    const unsettled = unsettledReasons.has(lock.reason)
    if (!unsettled || rechecks === retries) {
      return {
        kind: 'refused',
        exitCode: lock.exitCode ?? LOCK_EXIT.UNKNOWN,
        diagnostic: {
          status: 'lock-refused', reason: lock.reason, pid: lock.pid ?? null,
          detail: lock.detail ?? null, lockPath: lock.lockPath ?? null,
          ...(rechecks ? { rechecks } : {}),
          ...(unsettled ? { settlementTimedOut: true } : {}),
        },
      }
    }
    await wait(intervalMs)
  }
}

/** Preflight and a lost atomic claim use the same refusal result. Never return a null gateway. */
export async function openListenerGateway(config, {
  openGateway,
  onRecovered = () => {},
  ...observation
}) {
  const initial = await settleListenerLock(config.dataPath, observation)
  if (initial.kind === 'refused') return initial
  if (initial.recoveredFrom) onRecovered(initial.recoveredFrom)

  let gateway
  try {
    gateway = await openGateway(config)
  } catch (error) {
    // A failed open is not necessarily lock contention (configuration, schema or IO may fail).
    // Do not repeat initialization when no competing claim can be observed, or replace its error.
    let latest
    try { latest = await settleListenerLock(config.dataPath, observation) } catch { throw error }
    if (latest.kind === 'refused') return latest
    throw error
  }
  if (!gateway || typeof gateway.handle !== 'function' || typeof gateway.close !== 'function') {
    throw new TypeError('Gateway initialization returned no usable gateway')
  }
  return { kind: 'opened', gateway }
}

/** Complete the diagnostic write before returning control to the CLI's natural exit. */
export async function reportListenerRefusal(result, stream = process.stderr) {
  await new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(result.diagnostic)}\n`, error => error ? reject(error) : resolve())
  })
  return result.exitCode
}

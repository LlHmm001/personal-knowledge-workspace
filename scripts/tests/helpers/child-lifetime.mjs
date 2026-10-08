/**
 * Follow one child process from the moment it is spawned until it has really exited.
 *
 * The exit event is registered immediately, before anything else can await. That is the whole
 * point: a child may exit before the first await (a startup that fails at once), while the caller
 * is busy doing something else (calls against the process it started), or only after a signal.
 * A caller that polls `child.exitCode` instead can miss the event entirely and then wait forever
 * for an exit that already happened — and a fixture that reports success while the writer is still
 * running leaves a second writer on the data root.
 *
 * Once registered, the same promise is reused: every wait is a wait on the one recorded outcome,
 * never a new listener on a process that has already ended.
 *
 * The recorded outcome distinguishes the ways a process ends:
 *
 *   { exitCode, signal: null }        it exited on its own, with 0 or non-zero
 *   { exitCode: null, signal: 'SIGTERM' }   it was killed by a signal
 *   { exitCode: null, spawnError }    it never started, which is not an exit at all
 */
export function trackLifetime(child) {
  let log = ''
  child.stdout?.on('data', chunk => { log += chunk })
  child.stderr?.on('data', chunk => { log += chunk })
  let settled = false
  let outcome = null
  let spawnError = null
  let resolveExit
  const exited = new Promise(resolvePromise => { resolveExit = resolvePromise })
  const settle = value => {
    if (settled) return
    settled = true
    outcome = value
    resolveExit(value)
  }
  child.once('error', error => {
    spawnError = error
    settle({ exitCode: null, signal: null, spawnError: error.message })
  })
  child.once('exit', (code, signal) => settle({ exitCode: code, signal: signal ?? null, spawnError: spawnError ? spawnError.message : null }))

  return {
    get log() { return log },
    get settled() { return settled },
    get outcome() { return outcome },
    get spawnError() { return spawnError },
    /** The one promise for this child's exit; every wait goes through it. */
    exited,
    /**
     * The outcome if it is already known, otherwise the outcome when it arrives, or null when the
     * deadline passes first. The timer is always cleared, so a wait that ended does not fire later.
     */
    race(timeoutMs) {
      if (settled) return Promise.resolve(outcome)
      return new Promise(resolvePromise => {
        const timer = setTimeout(() => resolvePromise(null), timeoutMs)
        timer.unref?.()
        exited.then(value => { clearTimeout(timer); resolvePromise(value) })
      })
    },
  }
}

/** How a lifetime ended, in one line, for an error message. */
export function describeOutcome(outcome) {
  if (!outcome) return 'was not observed to exit'
  if (outcome.spawnError) return `could not be started (${outcome.spawnError})`
  if (outcome.signal) return `was killed by ${outcome.signal}`
  return `exited with ${outcome.exitCode}`
}

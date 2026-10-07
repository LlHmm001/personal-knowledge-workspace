/**
 * Stop evidence for a systemd-managed service, for the deployment transaction.
 *
 * The switch may only write back inputs, repoint the entry point or start the previous release
 * when it has proof that no writer is alive. A unit that reports `inactive` is not that proof:
 *
 *   - `systemctl` may have failed, been denied, or not been there at all, and a command that did
 *     not run tells us nothing;
 *   - a unit can be inactive while a process it started is still alive, because Type=oneshot
 *     launchers and detached children outlive the main process;
 *   - the identity of the unit (its main process, its control process, its cgroup) may not be
 *     readable, and an identity that cannot be read cannot be ruled out.
 *
 * So every probe reports what it observed, with the exit code and the error text preserved, and
 * anything that could not be established is `known: false`. A caller must treat `known: false`
 * and `stopped: false` identically: neither is evidence that the service stopped.
 *
 * Reading is all this module does. It never stops, kills or reloads anything.
 */

/**
 * systemctl exit codes that mean "the command ran". `is-active` answers 3 for an inactive unit
 * and 4 for one systemd does not know, and both are real answers about the unit. A 1 from
 * `is-active` is how a failure is reported (a denied bus, a missing unit), so it is checked
 * separately per invocation rather than assumed to be a state.
 */
const RAN = new Set([0])

const text = value => value === null || value === undefined ? '' : String(value)

/**
 * Index the `Key=Value` output of `systemctl show`. Repeated keys are kept as a list, because a
 * property that appears twice is not a property this module is willing to interpret.
 */
export function parseProperties(stdout) {
  const properties = {}
  for (const line of text(stdout).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line)
    if (!match) continue
    const [, key, value] = match
    if (key in properties) {
      properties[key] = Array.isArray(properties[key]) ? [...properties[key], value] : [properties[key], value]
    } else {
      properties[key] = value
    }
  }
  return properties
}

/** One property, or null when it is absent or was reported more than once. */
export function singleProperty(properties, key) {
  const value = properties[key]
  if (typeof value !== 'string') return null
  return value
}

/**
 * Turn raw systemctl observations into stop evidence.
 *
 * Pure: it takes what the commands produced and decides. `show` is `{ stdout, stderr, code }`,
 * `isActive` the same for `systemctl is-active`, `members` the cgroup process ids that could be
 * read, `memberNotes` what could not be read, and `live` the membership verdict for those ids.
 * Every field that could not be established is named in `unknown` rather than assumed.
 */
export function stopEvidence({ unit, show, isActive, members = [], memberNotes = [], live = [] }) {
  const unknown = []
  const record = { unit, source: 'systemctl', systemctl: {} }
  // The exit code and the captured output are both kept. For `is-active`, a non-zero exit is how
  // systemd reports a real state (3 = inactive), so the text is recorded as stderr rather than
  // labelled an error; the code is what distinguishes "reported a state" from "did not run".
  if (show) record.systemctl.show = { code: show.code ?? null, stderr: text(show.stderr).trim() || null }
  if (isActive) record.systemctl.isActive = { code: isActive.code ?? null, stderr: text(isActive.stderr).trim() || null }

  if (!show || show.code === null || show.code === undefined) {
    unknown.push('systemctl show did not run')
  } else if (show.code !== 0) {
    unknown.push(`systemctl show exited ${show.code}${text(show.stderr).trim() ? `: ${text(show.stderr).trim()}` : ''}`)
  }
  // `is-active` reports a state through its exit code: 0 = active, 3 = inactive, 4 = no such unit.
  // Anything else, or a command that did not run, is a failure to make the observation.
  const IS_ACTIVE_STATES = new Set([0, 3, 4])
  if (isActive && isActive.code !== null && isActive.code !== undefined && !IS_ACTIVE_STATES.has(isActive.code)) {
    unknown.push(`systemctl is-active exited ${isActive.code}${text(isActive.stderr).trim() ? `: ${text(isActive.stderr).trim()}` : ''}`)
  }

  const properties = show && show.code === 0 ? parseProperties(show.stdout) : {}
  const activeState = singleProperty(properties, 'ActiveState')
  const mainPid = singleProperty(properties, 'MainPID')
  const controlPid = singleProperty(properties, 'ControlPID')
  const controlGroup = singleProperty(properties, 'ControlGroup')
  record.activeState = activeState
  record.mainPid = mainPid
  record.controlPid = controlPid
  record.controlGroup = controlGroup
  record.cgroupMembers = members.slice(0, 10)
  record.memberNotes = memberNotes

  // The identity is only judged when `show` actually produced output. When it did not, the reason
  // is the command itself: reporting four missing properties on top of it buries the real finding.
  if (show && show.code === 0) {
    if (activeState === null) unknown.push('ActiveState is missing or was reported more than once')
    if (mainPid === null) unknown.push('MainPID is missing or was reported more than once')
    if (controlPid === null) unknown.push('ControlPID is missing or was reported more than once')
    if (controlGroup === null) unknown.push('ControlGroup is missing or was reported more than once')
    const numeric = /^\d+$/
    if (mainPid !== null && !numeric.test(mainPid)) unknown.push(`MainPID is not a number (${JSON.stringify(mainPid)})`)
    if (controlPid !== null && !numeric.test(controlPid)) unknown.push(`ControlPID is not a number (${JSON.stringify(controlPid)})`)
  }

  if (unknown.length > 0) return { known: false, stopped: false, reason: unknown.join('; '), unknownChecks: unknown, ...record }

  if (activeState !== 'inactive' && activeState !== 'failed') {
    return { known: true, stopped: false, state: activeState, reason: `the unit is ${activeState}`, ...record }
  }
  // An identity that still points at a process is a writer, whether or not the unit is inactive.
  for (const [name, value] of [['MainPID', mainPid], ['ControlPID', controlPid]]) {
    if (value !== '0') {
      return { known: true, stopped: false, state: activeState, reason: `the unit is ${activeState} but ${name} is still ${value}`, ...record }
    }
  }
  if (live.length > 0) {
    return { known: true, stopped: false, state: activeState, reason: `the unit is ${activeState} but ${live.length} process(es) of its cgroup are still alive`, leftoverPids: live.slice(0, 5), ...record }
  }
  return { known: true, stopped: true, state: activeState, ...record }
}

/**
 * Read one unit's stop state, with every observation and every failure preserved.
 *
 * `runner(args)` runs one systemctl invocation and resolves `{ stdout, stderr, code }`; it must
 * resolve (not reject) for a command that ran and failed. `readMembers(controlGroup)` resolves
 * `{ members, notes }` for the unit's cgroup. Both are injectable so the refusal paths can be
 * exercised without a live systemd.
 */
export async function probeSystemdStopState({ unit, runCommand, readMembers, isAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } } }) {
  if (!unit) return { known: false, stopped: false, reason: 'no unit was named' }
  const show = await runCommand(['show', unit, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID', '-p', 'ControlGroup'])
  const isActive = await runCommand(['is-active', unit])
  const properties = show && show.code === 0 ? parseProperties(show.stdout) : {}
  const controlGroup = singleProperty(properties, 'ControlGroup')
  const observed = controlGroup === null ? { members: [], notes: [] } : await readMembers(controlGroup)
  const live = []
  const unreadable = []
  for (const pid of observed.members) {
    if (!Number.isInteger(pid) || pid <= 0) { unreadable.push(`cgroup.procs held ${JSON.stringify(pid)}`); continue }
    if (isAlive(pid)) live.push(pid)
  }
  const evidence = stopEvidence({
    unit, show, isActive,
    members: observed.members, memberNotes: [...observed.notes, ...unreadable], live,
  })
  // A cgroup that could not be enumerated in full is not a unit whose members were ruled out.
  if (evidence.known === true && evidence.stopped === true && observed.notes.length > 0) {
    return { ...evidence, known: false, stopped: false, reason: `the cgroup of ${unit} could not be enumerated: ${observed.notes.join('; ')}` }
  }
  return evidence
}

/**
 * Read the process ids belonging to one cgroup path, descending into its children.
 *
 * Anything that cannot be read is reported in `notes`. A missing cgroup is not a failure by
 * itself: systemd removes it when the unit is gone, which is exactly the state being confirmed.
 */
export async function readCgroupMembers(controlGroup, { root = '/sys/fs/cgroup', fs = null } = {}) {
  const io = fs ?? await import('node:fs/promises')
  const members = []
  const notes = []
  if (!controlGroup || controlGroup === '/') return { members, notes }
  const start = `${root}${controlGroup}`
  const walk = async dir => {
    let entries
    try {
      entries = await io.readdir(dir, { withFileTypes: true })
    } catch (error) {
      notes.push(`cannot read ${dir}: ${error.code ?? error.message}`)
      return
    }
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`
      if (entry.isDirectory()) { await walk(full); continue }
      if (entry.name !== 'cgroup.procs') continue
      let body
      try {
        body = await io.readFile(full, 'utf8')
      } catch (error) {
        notes.push(`cannot read ${full}: ${error.code ?? error.message}`)
        continue
      }
      for (const line of body.split('\n')) if (line.trim()) members.push(Number(line.trim()))
    }
  }
  await walk(start)
  return { members, notes }
}

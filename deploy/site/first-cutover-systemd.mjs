/** Fixed production-unit adapter for the first independent PKW cutover.
 * No configuration, environment, database or lock contents are changed here.
 * Merely constructing the adapter cannot start or stop a service.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { portHolder } from './process-stop-state.mjs'
import { parseProperties, singleProperty, probeSystemdStopState, processState } from './systemd-stop-state.mjs'

export const FIRST_CUTOVER_UNIT = 'pkw-collaboration.service'
export const FIRST_CUTOVER_CONFIG = '/root/pkw-upgrade-2026-10-02/config/collaboration.production.json'
const PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'ControlGroup', 'NRestarts']
const finitePid = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const errorCode = error => String(error?.code ?? error?.name ?? 'ERROR')
const failure = (code, message, evidence) => Object.assign(new Error(message), { code, evidence })

/** The stat comm field may itself contain spaces and parentheses. Field 22 is starttime. */
export function procStartTicks(stat) {
  const closing = String(stat).lastIndexOf(')')
  if (closing < 0) throw failure('PKW_SERVICE_IDENTITY', 'the process stat identity is unreadable')
  const fields = String(stat).slice(closing + 1).trim().split(/\s+/)
  const ticks = fields[19]
  if (!/^\d+$/.test(ticks ?? '')) throw failure('PKW_SERVICE_IDENTITY', 'the process start time is unreadable')
  return ticks
}

/** Only LISTEN rows for the requested port. The fd inode must independently match MainPID. */
export function tcpListeners(text, port, family = 'tcp') {
  const rows = []
  for (const line of String(text).split('\n').slice(1)) {
    if (!line.trim()) continue
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || !/^\d+:$/.test(fields[0])) throw failure('PKW_SERVICE_SOCKET', `unreadable /proc/net/${family} row`)
    const parts = fields[1].split(':')
    if (parts.length !== 2 || !/^[\dA-F]+$/i.test(parts[0]) || !/^[\dA-F]{4}$/i.test(parts[1])) throw failure('PKW_SERVICE_SOCKET', `unreadable /proc/net/${family} address`)
    if (Number.parseInt(parts[1], 16) !== port || fields[3] !== '0A') continue
    if (!/^[1-9]\d*$/.test(fields[9])) throw failure('PKW_SERVICE_SOCKET', 'the listening socket inode is unreadable')
    rows.push({ address: parts[0].toUpperCase(), inode: fields[9], family })
  }
  return rows
}

/** Bounded, shell-free command runner. It never requests systemd Environment or prints argv. */
async function systemctl(args) {
  return new Promise(resolve => {
    let child
    let stdout = '', stderr = '', settled = false, timedOut = false, spawnError = null
    let timer
    const finish = (code, signal = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: timedOut || spawnError ? null : code, signal, stdout, stderr, timedOut, error: spawnError })
    }
    try { child = spawn('/usr/bin/systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } }) }
    catch (error) { spawnError = errorCode(error); finish(null); return }
    child.stdout.on('data', value => { stdout += value; if (stdout.length > 65536) { timedOut = true; child.kill('SIGKILL') } })
    child.stderr.on('data', value => { stderr = (stderr + value).slice(-65536) })
    child.once('error', error => { spawnError = errorCode(error); finish(null) })
    child.once('close', finish)
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, args[0] === 'stop' ? 45000 : args[0] === 'start' ? 35000 : 5000)
  })
}

function commandPassed(command) {
  return command?.code === 0 && !command?.timedOut && !command?.error && !command?.signal
}

function guardOptions(options) {
  if (options.unit !== FIRST_CUTOVER_UNIT) throw failure('PKW_SERVICE_SCOPE', 'only pkw-collaboration.service is supported')
  if (options.dataRoot !== '/root/.dsh/pkw-collab' || options.port !== 3081) throw failure('PKW_SERVICE_SCOPE', 'the fixed production data root and loopback port must match')
  if (options.config !== undefined && options.config !== FIRST_CUTOVER_CONFIG) throw failure('PKW_SERVICE_SCOPE', 'the original production configuration path must be preserved')
  for (const [name, value] of Object.entries({ node: options.node, oldRunner: options.old?.runner, oldProfile: options.old?.profile, candidateRunner: options.candidate?.runner, candidateProfile: options.candidate?.profile })) {
    if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw failure('PKW_SERVICE_SCOPE', `${name} must be an absolute path`)
  }
  if (options.old.runner === options.candidate.runner || options.old.profile === options.candidate.profile) throw failure('PKW_SERVICE_SCOPE', 'legacy and candidate entry points must be distinct')
}

/**
 * Dependencies are narrow filesystem/command seams for unprivileged fixture tests.
 * start/stop are deliberately restricted to the one production unit, even under test.
 */
export function createFirstCutoverService(options, deps = {}) {
  guardOptions(options)
  const { unit, dataRoot, port, node, signal } = options
  const old = { version: '0.1.2-pkw.4', ...options.old }
  const candidate = { version: '0.1.9-pkw.1', ...options.candidate }
  if (old.version === candidate.version) throw failure('PKW_SERVICE_SCOPE', 'old and candidate versions must be distinct')
  const io = { ...fs, ...(deps.fs ?? {}) }
  const command = deps.runCommand ?? systemctl
  const kill = deps.kill ?? process.kill.bind(process)
  const holdPort = deps.holdPort ?? portHolder
  const sleep = deps.sleep ?? delay
  const now = deps.now ?? Date.now
  const startupTimeoutMs = deps.startupTimeoutMs ?? 35000
  const pollMs = deps.pollMs ?? 250
  const expectedGroup = `/system.slice/${unit}`
  const lockPath = join(dataRoot, 'gateway.lock')
  // A failed start may nevertheless create a writer. Keep every observed MainPID, not just one
  // that already passed readiness; no recovery operation may forget such a process.
  const observedPids = new Map()
  let retainedGroup = null
  let lastEvidence = null

  const run = async args => {
    if (!['show', 'is-active', 'start', 'stop'].includes(args[0]) || args[1] !== unit) throw failure('PKW_SERVICE_SCOPE', 'unsupported systemctl operation')
    try { return await command(args) }
    catch (error) { return { code: null, stdout: '', stderr: '', error: errorCode(error) } }
  }

  const boundedText = async (path, maximum = 262144) => {
    const body = await io.readFile(path, 'utf8')
    if (Buffer.byteLength(body) > maximum) throw failure('PKW_SERVICE_IDENTITY', 'an identity input exceeds its limit')
    return body
  }

  async function identity(pid) {
    const bootId = (await boundedText('/proc/sys/kernel/random/boot_id', 256)).trim()
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId)) throw failure('PKW_SERVICE_IDENTITY', 'boot identity is unreadable')
    const startTicks = procStartTicks(await boundedText(`/proc/${pid}/stat`, 65536))
    return { bootId, startTicks }
  }

  async function showUnit() {
    const result = await run(['show', unit, ...PROPERTIES.flatMap(key => ['-p', key])])
    if (!commandPassed(result)) throw failure('PKW_SERVICE_OBSERVATION', 'systemctl show did not complete successfully', { command: result })
    const parsed = parseProperties(result.stdout)
    const value = Object.fromEntries(PROPERTIES.map(key => [key, singleProperty(parsed, key)]))
    if (PROPERTIES.some(key => value[key] === null)) throw failure('PKW_SERVICE_OBSERVATION', 'unit properties are missing or duplicated')
    if (value.Id !== unit || value.LoadState !== 'loaded') throw failure('PKW_SERVICE_OBSERVATION', 'the named service is not loaded with the expected identity')
    if (value.ControlGroup !== '' && value.ControlGroup !== expectedGroup) throw failure('PKW_SERVICE_OBSERVATION', 'the unit has an unexpected or shared cgroup')
    if (value.ControlGroup === expectedGroup) retainedGroup = expectedGroup
    const pid = finitePid(value.MainPID)
    if (pid !== null) {
      let observedIdentity = null
      try { observedIdentity = await identity(pid) } catch { /* retained PID is still ruled out by stop */ }
      observedPids.set(pid, observedIdentity)
    }
    return value
  }

  async function readOwnedCgroup(group) {
    const effective = group || retainedGroup
    if (effective !== expectedGroup) return { members: [], notes: ['no exact, previously observed unit cgroup is available'], removed: false }
    const base = `/sys/fs/cgroup${effective}`
    const members = [], notes = []
    let removed = false
    async function visit(path, root = false) {
      let entries
      try { entries = await io.readdir(path, { withFileTypes: true }) }
      catch (error) {
        if (root && error?.code === 'ENOENT') { removed = true; return }
        notes.push(`cannot enumerate unit cgroup (${errorCode(error)})`)
        return
      }
      let body
      try { body = await boundedText(join(path, 'cgroup.procs')) }
      catch (error) { notes.push(`cannot read unit cgroup processes (${errorCode(error)})`); return }
      for (const line of body.split('\n')) {
        if (!line.trim()) continue
        const pid = finitePid(line.trim())
        if (pid === null) notes.push('unit cgroup contains an invalid process id')
        else members.push(pid)
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink?.()) { notes.push('unit cgroup contains an unexpected symbolic link'); continue }
        if (entry.isDirectory()) await visit(join(path, entry.name))
      }
    }
    await visit(base, true)
    return { members: [...new Set(members)], notes, removed, path: effective }
  }

  async function rootLock() {
    try {
      const stat = await io.lstat(lockPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) return { known: false, present: true, reason: 'the data root lock is not a bounded regular file' }
      const body = JSON.parse(await boundedText(lockPath, 16384))
      const pid = typeof body?.pid === 'number' && Number.isSafeInteger(body.pid) && body.pid > 0 ? body.pid : null
      if (pid === null) return { known: false, present: true, reason: 'the data root lock has no valid owner' }
      return { known: true, present: true, pid }
    } catch (error) {
      if (error?.code === 'ENOENT') return { known: true, present: false, pid: null }
      return { known: false, present: null, reason: `the data root lock could not be read (${errorCode(error)})` }
    }
  }

  async function socketOwner(pid) {
    const paths = await io.readdir(`/proc/${pid}/fd`)
    const owned = new Set()
    for (const fd of paths) {
      let link
      try { link = await io.readlink(`/proc/${pid}/fd/${fd}`) }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error }
      const match = /^socket:\[(\d+)\]$/.exec(link)
      if (match) owned.add(match[1])
    }
    const rows = tcpListeners(await boundedText(`/proc/${pid}/net/tcp`, 8 * 1024 * 1024), port)
    try { rows.push(...tcpListeners(await boundedText(`/proc/${pid}/net/tcp6`, 8 * 1024 * 1024), port, 'tcp6')) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (rows.length !== 1 || rows[0].family !== 'tcp' || rows[0].address !== '0100007F' || !owned.has(rows[0].inode)) throw failure('PKW_SERVICE_SOCKET', 'the loopback listener is not exclusively owned by this unit MainPID')
    return { owned: true, inode: rows[0].inode, address: '127.0.0.1', port }
  }

  const selectRelease = expectedVersion => {
    if (expectedVersion === old.version) return { ...old, candidate: false }
    if (expectedVersion === candidate.version) return { ...candidate, candidate: true }
    throw failure('PKW_SERVICE_VERSION', 'an unrecognized release was requested')
  }

  async function inspectRunning(expectedVersion) {
    const release = selectRelease(expectedVersion)
    try {
      const unitState = await showUnit()
      const pid = finitePid(unitState.MainPID)
      if (unitState.ActiveState !== 'active' || unitState.SubState !== 'running' || pid === null || unitState.ControlPID !== '0' || unitState.NRestarts !== '0' || unitState.ControlGroup !== expectedGroup) throw failure('PKW_SERVICE_NOT_READY', 'the unit is not running once with the expected process identity', { unitState })
      const before = await identity(pid)
      const exe = await io.readlink(`/proc/${pid}/exe`)
      if (exe.endsWith(' (deleted)') || await io.realpath(exe) !== await io.realpath(node)) throw failure('PKW_SERVICE_IDENTITY', 'MainPID is not the expected Node executable')
      const raw = await boundedText(`/proc/${pid}/cmdline`, 65536)
      if (!raw.endsWith('\0')) throw failure('PKW_SERVICE_IDENTITY', 'MainPID has an incomplete command line')
      const argv = raw.slice(0, -1).split('\0')
      const expected = [release.runner, '--profile', release.profile, '--config', FIRST_CUTOVER_CONFIG, '--port', String(port), ...(release.candidate ? ['--drain-timeout-ms', '25000'] : [])]
      if (await io.realpath(argv[0]) !== await io.realpath(node) || argv.length !== expected.length + 1 || expected.some((value, index) => argv[index + 1] !== value)) throw failure('PKW_SERVICE_IDENTITY', 'MainPID command line is not the exact selected release entry point')
      const processGroups = (await boundedText(`/proc/${pid}/cgroup`, 65536)).trim().split('\n')
      if (!processGroups.includes(`0::${expectedGroup}`)) throw failure('PKW_SERVICE_IDENTITY', 'MainPID is outside the exact service cgroup')
      const group = await readOwnedCgroup(expectedGroup)
      if (group.notes.length || group.removed || !group.members.includes(pid)) throw failure('PKW_SERVICE_IDENTITY', 'MainPID cgroup membership could not be confirmed', { group })
      const socket = await socketOwner(pid)
      const lock = await rootLock()
      if (!lock.known || !lock.present || lock.pid !== pid) throw failure('PKW_SERVICE_IDENTITY', 'the production data lock is not owned by MainPID', { lock })
      const after = await identity(pid)
      const confirmed = await showUnit()
      if (before.bootId !== after.bootId || before.startTicks !== after.startTicks || PROPERTIES.some(key => confirmed[key] !== unitState[key])) throw failure('PKW_SERVICE_IDENTITY', 'the service changed during identity verification')
      observedPids.set(pid, after)
      lastEvidence = { ok: true, listenerOwned: true, pid, identity: after, port, version: expectedVersion, unit, controlGroup: expectedGroup, socket, lock, nRestarts: 0, versionSource: 'selected-entry-point' }
      return lastEvidence
    } catch (error) {
      lastEvidence = { ok: false, listenerOwned: false, unit, port, version: expectedVersion, code: error?.code ?? 'PKW_SERVICE_OBSERVATION', reason: error?.message ?? 'the service identity could not be established', ...(error?.evidence ? { detail: error.evidence } : {}) }
      return lastEvidence
    }
  }

  async function probeStopped() {
    const reasons = []
    let known = true
    try { await showUnit() } catch (error) { known = false; reasons.push(error.message) }
    let systemd
    try {
      systemd = await probeSystemdStopState({ unit, runCommand: run, readMembers: readOwnedCgroup, kill })
    } catch (error) { systemd = { known: false, stopped: false, reason: `systemd stop observation failed (${errorCode(error)})` } }
    if (!systemd.known) known = false
    if (!systemd.stopped) reasons.push(systemd.reason ?? 'systemd has not confirmed the unit stopped')
    // Independently enumerate the retained group even if show now reports an empty ControlGroup.
    const group = await readOwnedCgroup(retainedGroup)
    if (group.notes.length) { known = false; reasons.push(...group.notes) }
    if (observedPids.size === 0) { known = false; reasons.push('no previous unit MainPID was observed, so its process identity cannot be ruled out') }
    const pids = new Set([...observedPids.keys(), ...group.members])
    const processes = [...pids].map(pid => ({ pid, identity: observedPids.get(pid) ?? null, state: processState(pid, { kill }) }))
    if (processes.some(item => item.state === 'unknown')) { known = false; reasons.push('a retained process could not be ruled out') }
    if (processes.some(item => item.state === 'alive')) reasons.push('a retained service process is still alive')
    let portState
    try { portState = await holdPort(port) }
    catch (error) { portState = { known: false, held: null, reason: errorCode(error) } }
    if (!portState.known) { known = false; reasons.push('the loopback port could not be checked') }
    else if (portState.held !== false) reasons.push('the loopback port remains held')
    const lock = await rootLock()
    if (!lock.known) { known = false; reasons.push(lock.reason ?? 'the root lock is unreadable') }
    else if (lock.present) reasons.push('the root lock is still present; it will not be removed by cutover')
    return { ok: known && reasons.length === 0, known, stopped: known && reasons.length === 0, unit, port, source: 'systemd+cgroup+retained-processes+port+absent-lock', systemd, group, processes, portState, lock, ...(reasons.length ? { reason: reasons.join('; ') } : {}) }
  }

  async function stopAndConfirm() {
    // Retain before issuing stop, even if it is a failed/partially started candidate. Failure to
    // observe does not authorize a broader stop; the command always names this one service.
    let beforeError = null
    try { await showUnit() } catch (error) { beforeError = { code: errorCode(error), message: error.message } }
    const result = await run(['stop', unit])
    const evidence = await probeStopped()
    return { ...evidence, ok: commandPassed(result) && evidence.stopped, command: result, commandSucceeded: commandPassed(result), ...(beforeError ? { beforeError } : {}), ...(!commandPassed(result) ? { code: 'PKW_STOP_FAILED', commandFailure: 'systemctl stop did not complete successfully' } : !evidence.stopped ? { code: 'PKW_STOP_NOT_CONFIRMED' } : {}) }
  }

  const health = deps.health ?? (async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(3000) })
    await response.body?.cancel()
    return { status: response.status }
  })

  async function start(expectedVersion) {
    selectRelease(expectedVersion)
    if (signal?.aborted) throw failure('PKW_START_ABORTED', 'the start was cancelled before invoking systemd')
    const result = await run(['start', unit])
    if (!commandPassed(result)) {
      const evidence = await inspectRunning(expectedVersion)
      throw failure('PKW_START_FAILED', 'systemctl start did not complete successfully; a process may nevertheless have started', { command: result, ...evidence })
    }
    const deadline = now() + startupTimeoutMs
    let evidence = null, healthObservation = null
    do {
      evidence = await inspectRunning(expectedVersion)
      if (evidence.ok) {
        try { healthObservation = await health() }
        catch (error) { healthObservation = { status: null, error: errorCode(error) } }
        if (healthObservation?.status === 200) {
          const confirmed = await inspectRunning(expectedVersion)
          if (confirmed.ok && confirmed.pid === evidence.pid && confirmed.identity.startTicks === evidence.identity.startTicks && confirmed.identity.bootId === evidence.identity.bootId) return { ...confirmed, health: { status: 200 } }
          evidence = confirmed
        }
      }
      if (signal?.aborted || now() >= deadline) break
      await sleep(pollMs)
    } while (now() <= deadline)
    throw failure('PKW_START_NOT_READY', 'the started unit did not establish owned-listener readiness before its deadline; stop evidence is required before recovery', { command: result, ...evidence, health: healthObservation })
  }

  return { inspectRunning, probeStopped, stopAndConfirm, start }
}

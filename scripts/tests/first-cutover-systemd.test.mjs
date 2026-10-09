import assert from 'node:assert/strict'
import test from 'node:test'
import { createFirstCutoverService, FIRST_CUTOVER_CONFIG, procStartTicks, tcpListeners } from '../../deploy/site/first-cutover-systemd.mjs'

const UNIT = 'pkw-collaboration.service'
const GROUP = `/system.slice/${UNIT}`
const NODE = '/root/.hermes/node/bin/node'
const OLD = '0.1.2-pkw.4'
const NEW = '0.1.9-pkw.1'
const options = {
  unit: UNIT, dataRoot: '/root/.dsh/pkw-collab', port: 3081, node: NODE,
  old: { runner: '/LlHmm9527/pkw-delivery-v3/repo/scripts/serve-collaboration.mjs', profile: '/root/.dsh/profiles/web' },
  candidate: { runner: '/LlHmm9527/prepared/runtime/current/runner/scripts/serve-collaboration.mjs', profile: '/LlHmm9527/prepared/runtime/current/profile' },
}
const BOOT = 'd80e20a0-b2e2-49f5-9c6c-611d49d50fe8'
const eno = code => Object.assign(new Error(code), { code })
const stat = ticks => `100 (node worker (active)) ${['S', ...Array(18).fill('0'), ticks, '0'].join(' ')}`
const tcp = ({ inode = '777', address = '0100007F', port = 3081 } = {}) => `  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n   0: ${address}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 ${inode} 1 0000000000000000\n`
const tcpEmpty = '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'

function fixture(overrides = {}) {
  const state = {
    active: true, version: OLD, pid: 100, controlPid: 0, restarts: 0, group: GROUP,
    alive: new Set([100]), ticks: new Map([[100, '851263033']]), members: [100], groupRemoved: false,
    cgroupError: null, rootLock: 100, lockError: null, listenerInode: '777', fdInode: '777', address: '0100007F',
    exe: NODE, commandExtra: [], commandOverride: null, nodeArg: '/usr/local/bin/node', identityShift: false,
    portHeld: true, portKnown: true, processError: null, healthStatus: 200, showError: null, repeatedPid: false,
    commandStop: null, commandStart: null, stopEffect: null, startEffect: null, healthCalls: 0, ...overrides,
  }
  const calls = [], reads = [], writes = []
  let clock = 0, statReads = 0
  const select = () => state.version === OLD ? options.old : options.candidate
  const stop = () => {
    state.active = false; state.pid = 0; state.controlPid = 0; state.group = ''; state.alive.clear()
    state.members = []; state.groupRemoved = true; state.rootLock = null; state.portHeld = false
  }
  const start = () => {
    state.active = true; state.pid = 200; state.controlPid = 0; state.group = GROUP; state.version = NEW
    state.alive.add(200); state.ticks.set(200, '999999'); state.members = [200]; state.groupRemoved = false; state.rootLock = 200; state.portHeld = true
  }
  const deps = {
    fs: {
      async readFile(path) {
        reads.push(path)
        if (path.endsWith('/environ') || path === FIRST_CUTOVER_CONFIG) throw new Error('private environment/config must not be read')
        if (path === '/proc/sys/kernel/random/boot_id') return `${BOOT}\n`
        const proc = /^\/proc\/(\d+)\/(.+)$/.exec(path)
        if (proc) {
          const pid = Number(proc[1]), item = proc[2]
          if (!state.alive.has(pid)) throw eno('ENOENT')
          if (item === 'stat') { statReads++; return stat(state.identityShift && statReads > 2 ? 'NEWIDENTITY' : state.ticks.get(pid)) }
          if (item === 'cmdline') {
            if (state.commandOverride) return state.commandOverride
            const entry = select()
            return [state.nodeArg, entry.runner, '--profile', entry.profile, '--config', FIRST_CUTOVER_CONFIG, '--port', '3081', ...(state.version === NEW ? ['--drain-timeout-ms', '25000'] : []), ...state.commandExtra].join('\0') + '\0'
          }
          if (item === 'cgroup') return `0::${state.group}\n`
          if (item === 'net/tcp') return tcp({ inode: state.listenerInode, address: state.address })
          if (item === 'net/tcp6') return tcpEmpty
        }
        if (path === `/sys/fs/cgroup${GROUP}/cgroup.procs`) {
          if (state.cgroupError) throw eno(state.cgroupError)
          return state.members.map(String).join('\n') + '\n'
        }
        if (path === `${options.dataRoot}/gateway.lock`) {
          if (state.lockError) throw eno(state.lockError)
          if (state.rootLock === null) throw eno('ENOENT')
          return typeof state.rootLock === 'number' ? JSON.stringify({ pid: state.rootLock }) : state.rootLock
        }
        throw new Error(`unexpected read ${path}`)
      },
      async readlink(path) {
        reads.push(path)
        if (/^\/proc\/\d+\/exe$/.test(path)) return state.exe
        if (/^\/proc\/\d+\/fd\/3$/.test(path)) return `socket:[${state.fdInode}]`
        throw eno('ENOENT')
      },
      async realpath(path) { return path === '/usr/local/bin/node' ? NODE : path },
      async readdir(path) {
        reads.push(path)
        if (/^\/proc\/\d+\/fd$/.test(path)) return ['0', '1', '2', '3']
        if (path === `/sys/fs/cgroup${GROUP}`) {
          if (state.cgroupError) throw eno(state.cgroupError)
          if (state.groupRemoved) throw eno('ENOENT')
          return [{ name: 'cgroup.procs', isDirectory: () => false, isSymbolicLink: () => false }]
        }
        throw new Error(`unexpected readdir ${path}`)
      },
      async lstat(path) {
        reads.push(path)
        assert.equal(path, `${options.dataRoot}/gateway.lock`)
        if (state.lockError) throw eno(state.lockError)
        if (state.rootLock === null) throw eno('ENOENT')
        return { isFile: () => true, isSymbolicLink: () => false, size: 200 }
      },
      async unlink(path) { writes.push(['unlink', path]); throw new Error('no unlink is allowed') },
      async writeFile(path) { writes.push(['write', path]); throw new Error('no write is allowed') },
    },
    async runCommand(args) {
      calls.push(args)
      assert.equal(args[1], UNIT)
      if (args[0] === 'show') {
        if (state.showError) return { code: null, stdout: '', stderr: state.showError }
        const values = { Id: UNIT, LoadState: 'loaded', ActiveState: state.active ? 'active' : 'inactive', SubState: state.active ? 'running' : 'dead', MainPID: String(state.pid), ControlPID: String(state.controlPid), ControlGroup: state.group, NRestarts: String(state.restarts) }
        return { code: 0, stdout: Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + (state.repeatedPid ? '\nMainPID=100\n' : '\n'), stderr: '' }
      }
      if (args[0] === 'is-active') return { code: state.active ? 0 : 3, stdout: state.active ? 'active\n' : 'inactive\n', stderr: '' }
      if (args[0] === 'stop') { (state.stopEffect ?? stop)(); return state.commandStop ?? { code: 0, stdout: '', stderr: '' } }
      if (args[0] === 'start') { (state.startEffect ?? start)(); return state.commandStart ?? { code: 0, stdout: '', stderr: '' } }
      throw new Error(`unexpected command ${args}`)
    },
    kill(pid, signal) { assert.equal(signal, 0); if (state.processError) throw eno(state.processError); if (!state.alive.has(pid)) throw eno('ESRCH') },
    holdPort: async () => ({ known: state.portKnown, held: state.portHeld }),
    health: async () => { state.healthCalls++; return { status: state.healthStatus } },
    now: () => clock, sleep: async ms => { clock += ms }, startupTimeoutMs: 3, pollMs: 1,
  }
  return { service: createFirstCutoverService(options, deps), state, calls, reads, writes, deps, stop, start }
}

test('first cutover service construction is inert and is restricted to the exact PKW service', () => {
  const f = fixture()
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.reads, [])
  for (const bad of [{ unit: 'deepseek-harness.service' }, { dataRoot: '/elsewhere' }, { port: 3080 }, { config: '/elsewhere.json' }]) {
    assert.throws(() => createFirstCutoverService({ ...options, ...bad }, f.deps), { code: 'PKW_SERVICE_SCOPE' })
  }
  assert.deepEqual(f.calls, [])
})

test('first cutover ties the real legacy PID to exact argv, inode listener and production lock without reading credentials', async () => {
  const f = fixture()
  const evidence = await f.service.inspectRunning(OLD)
  assert.equal(evidence.ok, true)
  assert.equal(evidence.listenerOwned, true)
  assert.equal(evidence.pid, 100)
  assert.deepEqual(evidence.identity, { bootId: BOOT, startTicks: '851263033' })
  assert.equal(evidence.socket.inode, '777')
  assert.equal(evidence.lock.pid, 100)
  assert.equal(evidence.versionSource, 'selected-entry-point')
  assert.equal(f.state.healthCalls, 0)
  assert.equal(f.reads.some(path => path.includes('environ') || path === FIRST_CUTOVER_CONFIG), false)
  assert.deepEqual(f.writes, [])
})

test('first cutover distinguishes selected candidate aliases and does not accept old argv as the new release', async () => {
  const f = fixture()
  assert.equal((await f.service.inspectRunning(NEW)).ok, false)
  f.start()
  const proof = await f.service.inspectRunning(NEW)
  assert.equal(proof.ok, true)
  assert.equal(proof.pid, 200)
  f.state.commandExtra = ['--other', 'value']
  assert.equal((await f.service.inspectRunning(NEW)).ok, false)
})

test('first cutover rejects foreign socket ownership, wildcard binds, wrong lock owner, shared cgroup and wrong executable', async t => {
  for (const [name, patch] of Object.entries({ foreignSocket: { fdInode: '999' }, wildcard: { address: '00000000' }, foreignLock: { rootLock: 999 }, sharedGroup: { group: '/' }, otherUnit: { group: '/system.slice/deepseek-harness.service' }, wrongExe: { exe: '/usr/bin/python3' }, deletedExe: { exe: `${NODE} (deleted)` }, unreadableLock: { rootLock: 'not json' }, restart: { restarts: 1 }, controlProcess: { controlPid: 987 }, duplicatedIdentity: { repeatedPid: true }, pidChanged: { identityShift: true } })) {
    await t.test(name, async () => {
      const f = fixture(patch)
      const evidence = await f.service.inspectRunning(OLD)
      assert.equal(evidence.ok, false)
      assert.equal(evidence.listenerOwned, false)
      assert.equal(f.state.healthCalls, 0)
    })
  }
})

test('first cutover exact cmdline excludes an unexpected config and extra drain flags on the old runner', async () => {
  const f = fixture({ commandExtra: ['--drain-timeout-ms', '25000'] })
  assert.equal((await f.service.inspectRunning(OLD)).ok, false)
  f.state.commandExtra = []
  f.state.commandOverride = [NODE, options.old.runner, '--profile', options.old.profile, '--config', '/another-data-root.json', '--port', '3081'].join('\0') + '\0'
  assert.equal((await f.service.inspectRunning(OLD)).ok, false)
})

test('first cutover explicit stop proves PID gone, exact removed cgroup, free port and absent lock', async () => {
  const f = fixture()
  assert.equal((await f.service.inspectRunning(OLD)).ok, true)
  const proof = await f.service.stopAndConfirm()
  assert.equal(proof.ok, true)
  assert.equal(proof.known, true)
  assert.equal(proof.stopped, true)
  assert.equal(proof.group.removed, true)
  assert.deepEqual(proof.processes.map(p => [p.pid, p.state]), [[100, 'gone']])
  assert.deepEqual(f.calls.filter(args => ['start', 'stop'].includes(args[0])), [['stop', UNIT]])
  assert.deepEqual(f.writes, [])
})

test('first cutover stop command failure is not success even when its independent stopped proof succeeds', async () => {
  const f = fixture({ commandStop: { code: 1, stdout: '', stderr: 'synthetic stop error' } })
  const proof = await f.service.stopAndConfirm()
  assert.equal(proof.ok, false)
  assert.equal(proof.known, true)
  assert.equal(proof.stopped, true)
  assert.equal(proof.code, 'PKW_STOP_FAILED')
  assert.equal(proof.command.stderr, 'synthetic stop error')
  assert.equal(proof.commandSucceeded, false)
})

test('first cutover retained PID, cgroup failure, a held port or any lock prevent a stopped claim', async t => {
  for (const [name, after, expectedKnown] of [
    ['retained live PID', f => f.state.alive.add(100), true],
    ['liveness permission failure', f => { f.state.processError = 'EPERM' }, false],
    ['cgroup permission failure', f => { f.state.cgroupError = 'EACCES' }, false],
    ['residual cgroup child', f => { f.state.groupRemoved = false; f.state.members = [222]; f.state.alive.add(222) }, true],
    ['malformed cgroup entry', f => { f.state.groupRemoved = false; f.state.members = ['broken'] }, false],
    ['port still held', f => { f.state.portHeld = true }, true],
    ['port unreadable', f => { f.state.portKnown = false }, false],
    ['stale lock is not deleted', f => { f.state.rootLock = 100 }, true],
    ['lock unreadable', f => { f.state.lockError = 'EACCES' }, false],
  ]) {
    await t.test(name, async () => {
      const f = fixture()
      await f.service.inspectRunning(OLD)
      f.stop(); after(f)
      const result = await f.service.probeStopped()
      assert.equal(result.ok, false)
      assert.equal(result.stopped, false)
      assert.equal(result.known, expectedKnown)
      assert.deepEqual(f.writes, [])
    })
  }
})

test('first cutover unknown systemctl and unexpected group never mean stopped', async () => {
  const f = fixture()
  await f.service.inspectRunning(OLD)
  f.stop(); f.state.showError = 'Permission denied'
  const proof = await f.service.probeStopped()
  assert.equal(proof.known, false)
  assert.equal(proof.stopped, false)
  f.state.showError = null; f.state.group = '/'
  assert.equal((await f.service.probeStopped()).known, false)
})

test('first cutover does not invent a removed cgroup when it has never observed one', async () => {
  const f = fixture({ active: false, pid: 0, group: '', alive: new Set(), groupRemoved: true, rootLock: null, portHeld: false })
  const proof = await f.service.probeStopped()
  assert.equal(proof.known, false)
  assert.equal(proof.stopped, false)
})

test('first cutover a cgroup name alone cannot replace a previously observed writer PID', async () => {
  const f = fixture({ active: false, pid: 0, group: GROUP, alive: new Set(), members: [], groupRemoved: true, rootLock: null, portHeld: false })
  const proof = await f.service.probeStopped()
  assert.equal(proof.known, false)
  assert.equal(proof.stopped, false)
  assert.match(proof.reason, /no previous unit MainPID/)
})

test('first cutover start returns only after own listener and health readiness with zero restarts', async () => {
  const f = fixture()
  await f.service.stopAndConfirm()
  const proof = await f.service.start(NEW)
  assert.equal(proof.ok, true)
  assert.equal(proof.pid, 200)
  assert.equal(proof.nRestarts, 0)
  assert.deepEqual(proof.health, { status: 200 })
  assert.equal(f.state.healthCalls, 1)
  assert.deepEqual(f.calls.filter(args => ['start', 'stop'].includes(args[0])), [['stop', UNIT], ['start', UNIT]])
})

test('first cutover never probes a foreign listener to make a failed start look ready', async () => {
  const f = fixture({ fdInode: '999' })
  await assert.rejects(f.service.start(NEW), { code: 'PKW_START_NOT_READY' })
  assert.equal(f.state.healthCalls, 0)
  assert.equal(f.state.alive.has(200), true)
  assert.equal((await f.service.probeStopped()).stopped, false)
})

test('first cutover a partial start failure retains its live candidate for subsequent stop evidence', async () => {
  const f = fixture({ commandStart: { code: 1, stdout: '', stderr: 'start error after spawn' } })
  await assert.rejects(f.service.start(NEW), error => {
    assert.equal(error.code, 'PKW_START_FAILED')
    assert.equal(error.evidence.pid, 200)
    assert.equal(error.evidence.command.code, 1)
    return true
  })
  assert.equal(f.state.healthCalls, 0)
  assert.equal((await f.service.probeStopped()).stopped, false)
  const stopped = await f.service.stopAndConfirm()
  assert.equal(stopped.ok, true)
  assert.equal(stopped.processes.some(p => p.pid === 200 && p.state === 'gone'), true)
})

test('first cutover health failure remains bounded and a live instance remains explicitly un-stopped', async () => {
  const f = fixture({ healthStatus: 404 })
  await assert.rejects(f.service.start(NEW), error => {
    assert.equal(error.code, 'PKW_START_NOT_READY')
    assert.equal(error.evidence.health.status, 404)
    return true
  })
  assert.equal(f.state.healthCalls > 0 && f.state.healthCalls <= 4, true)
  assert.equal((await f.service.probeStopped()).stopped, false)
})

test('first cutover start is cancelled before systemctl and unsupported versions cannot be started', async () => {
  const f = fixture()
  const controller = new AbortController(); controller.abort()
  const service = createFirstCutoverService({ ...options, signal: controller.signal }, f.deps)
  await assert.rejects(service.start(NEW), { code: 'PKW_START_ABORTED' })
  await assert.rejects(f.service.start('9.9.9'), { code: 'PKW_SERVICE_VERSION' })
  assert.deepEqual(f.calls, [])
})

test('first cutover parsers bind Linux starttime and socket inode without trusting process names', () => {
  assert.equal(procStartTicks(stat('1234567')), '1234567')
  assert.throws(() => procStartTicks('broken'), { code: 'PKW_SERVICE_IDENTITY' })
  assert.deepEqual(tcpListeners(tcp(), 3081), [{ address: '0100007F', inode: '777', family: 'tcp' }])
  assert.deepEqual(tcpListeners(tcp(), 3080), [])
  assert.throws(() => tcpListeners('header\nnot a socket row\n', 3081), { code: 'PKW_SERVICE_SOCKET' })
})

/**
 * Stop evidence for a systemd unit, on synthetic observations only.
 *
 * Each case is one way a probe can mislead: a command that did not run, a unit that is inactive
 * with a process still attached, an identity that cannot be read. None of them may be reported as
 * "stopped", because the deployment uses that answer to decide whether it may write back inputs,
 * repoint the entry point and start the previous release.
 *
 * No test here touches a live systemd, a real unit, or any file outside a temporary directory.
 * The runner and the cgroup reader are injected; the only real filesystem use is `mkdtemp` for
 * the cgroup fixtures.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseProperties, singleProperty, stopEvidence, probeSystemdStopState, readCgroupMembers } from '../../deploy/site/systemd-stop-state.mjs'

const UNIT = 'synthetic-pkw.service'

/** A systemctl invocation that ran and produced output. */
const ok = stdout => ({ stdout, stderr: '', code: 0 })
/** A systemctl invocation that ran and failed. */
const failed = (code, stderr = '') => ({ stdout: '', stderr, code })
/** A systemctl invocation that never ran. */
const neverRan = message => ({ stdout: '', stderr: message, code: null })

const showOutput = ({ activeState = 'inactive', mainPid = '0', controlPid = '0', controlGroup = '/system.slice/synthetic-pkw.service' } = {}) =>
  `ActiveState=${activeState}\nMainPID=${mainPid}\nControlPID=${controlPid}\nControlGroup=${controlGroup}\n`

/** A runner answering from a fixed table, recording what it was asked for. */
function runnerFor(table) {
  const asked = []
  return {
    asked,
    runCommand: async args => {
      asked.push(args.join(' '))
      const key = args[0] === 'is-active' ? 'is-active' : 'show'
      return table[key] ?? ok('')
    },
  }
}

test('stop evidence: an inactive unit with no process attached is stopped', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({ show: ok(showOutput()), 'is-active': failed(3, 'inactive\n') }).runCommand,
    readMembers: async () => ({ members: [], notes: [] }),
  })
  assert.equal(evidence.known, true)
  assert.equal(evidence.stopped, true)
  assert.equal(evidence.state, 'inactive')
  assert.equal(evidence.mainPid, '0')
  assert.equal(evidence.controlPid, '0')
  // The exit codes are kept: `is-active` answers 3 for an inactive unit, and that is a real answer.
  assert.deepEqual(evidence.systemctl.isActive, { code: 3, stderr: 'inactive' })
  assert.deepEqual(evidence.systemctl.show, { code: 0, stderr: null })
})

test('stop evidence: a systemctl that could not be run never means stopped', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({ show: neverRan('spawn systemctl ENOENT'), 'is-active': neverRan('spawn systemctl ENOENT') }).runCommand,
    readMembers: async () => ({ members: [], notes: [] }),
  })
  assert.equal(evidence.known, false)
  assert.equal(evidence.stopped, false)
  assert.equal(evidence.reason, 'systemctl show did not run')
  assert.match(evidence.systemctl.show.stderr, /ENOENT/)
})

test('stop evidence: a denied probe is unknown, not stopped', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({
      show: failed(1, 'Failed to connect to bus: Permission denied\n'),
      'is-active': failed(1, 'Failed to connect to bus: Permission denied\n'),
    }).runCommand,
    readMembers: async () => ({ members: [], notes: [] }),
  })
  assert.equal(evidence.known, false)
  assert.equal(evidence.stopped, false)
  assert.equal(evidence.reason, 'systemctl show exited 1: Failed to connect to bus: Permission denied; systemctl is-active exited 1: Failed to connect to bus: Permission denied')
  assert.match(evidence.systemctl.show.stderr, /Permission denied/)
  assert.equal(evidence.systemctl.isActive.code, 1)
  assert.match(evidence.systemctl.isActive.stderr, /Permission denied/)
})

test('stop evidence: a timeout with no exit code is unknown', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({
      show: { stdout: '', stderr: 'systemctl did not finish within 10000ms', code: null },
      'is-active': ok(''),
    }).runCommand,
    readMembers: async () => ({ members: [], notes: [] }),
  })
  assert.equal(evidence.known, false)
  assert.equal(evidence.stopped, false)
  assert.match(evidence.reason, /did not run|did not finish/)
})

test('stop evidence: an inactive unit whose MainPID is still live is a writer', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({ show: ok(showOutput({ mainPid: '4242' })), 'is-active': failed(3, 'inactive\n') }).runCommand,
    readMembers: async () => ({ members: [], notes: [] }),
  })
  assert.equal(evidence.known, true)
  assert.equal(evidence.stopped, false)
  assert.match(evidence.reason, /MainPID is still 4242/)
})

test('stop evidence: an inactive unit whose ControlPID is still live is a writer', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({ show: ok(showOutput({ controlPid: '4243' })), 'is-active': failed(3, 'inactive\n') }).runCommand,
    readMembers: async () => ({ members: [], notes: [] }),
  })
  assert.equal(evidence.stopped, false)
  assert.match(evidence.reason, /ControlPID is still 4243/)
})

test('stop evidence: a leftover child in the cgroup is a writer even with a clean identity', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({ show: ok(showOutput()), 'is-active': failed(3, 'inactive\n') }).runCommand,
    // This process is alive and belongs to the unit's cgroup, which no property reveals.
    readMembers: async () => ({ members: [424242], notes: [] }),
    isAlive: pid => pid === 424242,
  })
  assert.equal(evidence.known, true)
  assert.equal(evidence.stopped, false)
  assert.match(evidence.reason, /1 process\(es\) of its cgroup are still alive/)
  assert.deepEqual(evidence.leftoverPids, [424242])
})

test('stop evidence: a missing ActiveState is unknown', async () => {
  const evidence = stopEvidence({
    unit: UNIT,
    show: ok('MainPID=0\nControlPID=0\nControlGroup=/system.slice/x.service\n'),
    isActive: failed(3, 'inactive\n'),
  })
  assert.equal(evidence.known, false)
  assert.equal(evidence.stopped, false)
  assert.match(evidence.reason, /ActiveState is missing or was reported more than once/)
})

test('stop evidence: a property reported twice is not interpreted', async () => {
  const evidence = stopEvidence({
    unit: UNIT,
    show: ok('ActiveState=inactive\nActiveState=active\nMainPID=0\nControlPID=0\nControlGroup=/system.slice/x.service\n'),
    isActive: failed(3, 'inactive\n'),
  })
  assert.equal(evidence.known, false)
  assert.match(evidence.reason, /ActiveState is missing or was reported more than once/)
})

test('stop evidence: a non-numeric MainPID is unknown', async () => {
  const evidence = stopEvidence({
    unit: UNIT,
    show: ok(showOutput({ mainPid: '4242 (node)' })),
    isActive: failed(3, 'inactive\n'),
  })
  assert.equal(evidence.known, false)
  assert.match(evidence.reason, /MainPID is not a number/)
})

test('stop evidence: padding is stripped from property values', () => {
  const properties = parseProperties('ActiveState=inactive\nMainPID=0\nControlGroup=/system.slice/x.service\n')
  assert.equal(singleProperty(properties, 'ActiveState'), 'inactive')
  assert.equal(singleProperty(properties, 'MainPID'), '0')
  assert.equal(singleProperty(properties, 'Nope'), null)
})

test('stop evidence: an active unit is running, not stopped', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({ show: ok(showOutput({ activeState: 'active', mainPid: '4242' })), 'is-active': ok('active\n') }).runCommand,
    readMembers: async () => ({ members: [], notes: [] }),
  })
  assert.equal(evidence.known, true)
  assert.equal(evidence.stopped, false)
  assert.equal(evidence.state, 'active')
})

test('stop evidence: a cgroup that could not be enumerated is unknown', async () => {
  const evidence = await probeSystemdStopState({
    unit: UNIT,
    runCommand: runnerFor({ show: ok(showOutput()), 'is-active': failed(3, 'inactive\n') }).runCommand,
    readMembers: async () => ({ members: [], notes: ['cannot read /sys/fs/cgroup/x: EACCES'] }),
  })
  assert.equal(evidence.known, false)
  assert.equal(evidence.stopped, false)
  assert.match(evidence.reason, /could not be enumerated/)
})

test('stop evidence: an unreadable cgroup.procs is not an empty cgroup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-cgroup-'))
  try {
    const unit = join(root, 'synthetic.service')
    await mkdir(join(unit, 'child'), { recursive: true })
    await writeFile(join(unit, 'cgroup.procs'), '11111\n')
    await writeFile(join(unit, 'child', 'cgroup.procs'), '22222\n')
    // Both the unit's own cgroup and its nested children are counted.
    const nested = await readCgroupMembers('/synthetic.service', { root })
    assert.deepEqual(nested.members.sort((a, b) => a - b), [11111, 22222])
    assert.deepEqual(nested.notes, [])

    // A cgroup that cannot be read at all is reported, never silently treated as empty.
    const denied = await readCgroupMembers('/absent.service', { root })
    assert.deepEqual(denied.members, [])
    assert.equal(denied.notes.length, 1)
    assert.match(denied.notes[0], /cannot read/)

    // The probe turns that note into "unknown": an enumeration that failed did not rule out a
    // single process, so it is not evidence that the unit stopped.
    const evidence = await probeSystemdStopState({
      unit: UNIT,
      runCommand: runnerFor({ show: ok(showOutput({ controlGroup: '/absent.service' })), 'is-active': failed(3, 'inactive\n') }).runCommand,
      readMembers: controlGroup => readCgroupMembers(controlGroup, { root }),
    })
    assert.equal(evidence.known, false)
    assert.equal(evidence.stopped, false)
    assert.match(evidence.reason, /could not be enumerated/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('stop evidence: no unit named is unknown', async () => {
  const evidence = await probeSystemdStopState({ unit: '', runCommand: async () => ok(''), readMembers: async () => ({ members: [], notes: [] }) })
  assert.equal(evidence.known, false)
  assert.equal(evidence.stopped, false)
  assert.equal(evidence.reason, 'no unit was named')
})

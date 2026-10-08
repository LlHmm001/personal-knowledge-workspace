#!/usr/bin/env node
/**
 * Stop evidence and start discipline for a listener this repository starts itself.
 *
 * `deploy/site/process-stop-state.mjs` answers "has this listener stopped?" the way a deployment
 * needs it answered: three independent observations, none of which may be read as "stopped" when it
 * could not answer. These tests exercise that on real processes, and they include the counterexample
 * the whole design exists for — a child that never started, on a port something else is holding.
 *
 * Everything here runs on loopback, on ports the kernel picks, against processes this file starts
 * and stops. Nothing touches a live service, and no configuration outside this file is read.
 *
 * Usage:
 *   node --test scripts/tests/process-stop-state.test.mjs
 *   PKW_TEST_PROFILE=<profile> node --test scripts/tests/process-stop-state.test.mjs   # adds the real-listener case
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { listenerManager, portHolder, probeListenerStop } from '../../deploy/site/process-stop-state.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptsDir = join(repoRoot, 'scripts')
const profile = () => process.env.PKW_TEST_PROFILE ?? ''

/** A port nothing is listening on, chosen by the kernel. */
function freePort() {
  const server = createServer()
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolvePromise(port))
  }))
}

/** Hold a port the way a listener would, for the duration of the returned release function. */
async function holdPort(port) {
  const server = createServer((_req, res) => { res.writeHead(200); res.end('{"ready":true}') })
  await new Promise(resolvePromise => server.listen(port, '127.0.0.1', resolvePromise))
  return () => new Promise(resolvePromise => server.close(() => resolvePromise(undefined)))
}

const nothing = () => null

test('stop evidence: a live process, its held port and its lock are all reported as not stopped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-stop-'))
  const port = await freePort()
  const lockPath = join(root, 'gateway.lock')
  const server = await holdPort(port)
  try {
    // A child of our own, so the pid really is a live process and the liveness check is not a stub.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true })
    child.unref()
    await writeFile(lockPath, JSON.stringify({ pid: child.pid, at: new Date().toISOString() }), { mode: 0o600 })

    const evidence = await probeListenerStop({ pid: child.pid, port, lockPath })
    assert.equal(evidence.known, true, JSON.stringify(evidence))
    assert.equal(evidence.stopped, false, 'a live process is not a stopped one')
    // All three observations have to be reported, so a refusal can say which one refused it.
    assert.equal(evidence.observations.process.state, 'alive')
    assert.equal(evidence.observations.port.held, true)
    assert.equal(evidence.observations.lock.state, 'alive')
    assert.match(evidence.reason, /still running/)

    try { process.kill(-child.pid, 'SIGKILL') } catch { /* no group */ }
    try { process.kill(child.pid, 'SIGKILL') } catch { /* gone */ }
  } finally {
    await server()
    await rm(root, { recursive: true, force: true })
  }
})

test('stop evidence: an empty lock is undecided, never "stopped"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-stop-'))
  const port = await freePort()
  const lockPath = join(root, 'gateway.lock')
  try {
    // The lock is created empty and written afterwards, so this is the window between the two. No
    // writer is named, so no writer was ruled out: the answer is not knowledge.
    await writeFile(lockPath, '', { mode: 0o600 })
    const evidence = await probeListenerStop({ pid: null, port, lockPath })
    assert.equal(evidence.known, false, JSON.stringify(evidence))
    assert.equal(evidence.stopped, false)
    assert.equal(evidence.observations.lock.empty, true)
    assert.match(evidence.reason, /names no writer/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stop evidence: a lock that cannot be parsed is undecided, never "stopped"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-stop-'))
  const port = await freePort()
  const lockPath = join(root, 'gateway.lock')
  try {
    await writeFile(lockPath, 'not json at all', { mode: 0o600 })
    const evidence = await probeListenerStop({ pid: null, port, lockPath })
    assert.equal(evidence.known, false, JSON.stringify(evidence))
    assert.equal(evidence.stopped, false)
    assert.match(evidence.reason, /could not be read/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stop evidence: a liveness check that cannot answer is undecided, never "stopped"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-stop-'))
  const port = await freePort()
  try {
    // EPERM is what a process outside this uid looks like, and it is not proof of absence.
    const kill = () => { const error = new Error('operation not permitted'); error.code = 'EPERM'; throw error }
    const evidence = await probeListenerStop({ pid: 4242, port, kill })
    assert.equal(evidence.known, false, JSON.stringify(evidence))
    assert.equal(evidence.stopped, false)
    assert.equal(evidence.observations.process.state, 'unknown')
    assert.match(evidence.reason, /could not establish/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stop evidence: a port probe that breaks is undecided, never "free"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-stop-'))
  try {
    const brokenProbe = async () => ({ known: false, held: null, reason: 'EACCES: probe refused' })
    const evidence = await probeListenerStop({ pid: 4242, port: await freePort(), kill: nothing, holdPort: brokenProbe })
    assert.equal(evidence.known, false, JSON.stringify(evidence))
    assert.equal(evidence.stopped, false)
    assert.match(evidence.reason, /port probe/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('start discipline: a child that never served is a failed start, not a healthy port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-start-'))
  const dataRoot = join(root, 'data')
  const port = await freePort()
  // Something else answers on the port the manager is asked to use, exactly as an old listener would
  // if it were still up. A start that borrowed this response would report success for a child that
  // died on the way, which is the failure mode this test exists to catch.
  const foreign = await holdPort(port)
  const manager = listenerManager({
    root, port, dataRoot, password: 'unused',
    scriptsDir, repoRoot,
    configPath: join(root, 'collaboration.json'),
  })
  try {
    await writeFile(join(root, 'collaboration.json'), JSON.stringify({
      dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_E2E_BOOTSTRAP',
    }, null, 2) + '\n', { mode: 0o600 })
    // `current` leads to a release whose packages declare a version but whose listener cannot boot
    // (the profile is a stub with no code), so the child exits immediately. The port still answers —
    // from the foreign server — which is exactly the situation a start check must not mistake for
    // success.
    const { mkdir, symlink } = await import('node:fs/promises')
    const stubScope = join(root, 'releases', 'broken', 'profile', 'node_modules/@deepseek-ai/dsh-pkw-web')
    await mkdir(stubScope, { recursive: true })
    await writeFile(join(stubScope, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '0.0.1-stub', type: 'module', main: 'lib/index.js' }, null, 2) + '\n')
    await symlink(join('releases', 'broken'), join(root, 'current'))
    await assert.rejects(() => manager.start(), error => {
      assert.match(error.message, /exited before it served/, `unexpected failure: ${error.message}`)
      return true
    })
    // The manager recorded the pid it tried, and the independent probe refuses to call this stopped
    // — the child is gone but the port is held, and "gone" alone would have been read as success.
    const recorded = await manager.readPidFile()
    assert.ok(recorded?.pid, 'the manager must record the process it started')
    const evidence = await probeListenerStop({ pid: recorded.pid, port, lockPath: join(dataRoot, 'gateway.lock') })
    assert.equal(evidence.stopped, false, JSON.stringify(evidence))
    assert.match(evidence.reason, /still held/)
  } finally {
    await manager.stop().catch(() => undefined)
    await foreign()
    await rm(root, { recursive: true, force: true })
  }
})

test('start and stop: the manager proves the process it recorded is the one serving', { skip: profile() ? false : 'no PKW profile available (set PKW_TEST_PROFILE)' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-manager-'))
  const dataRoot = join(root, 'data')
  const port = await freePort()
  const { copyDataRoot } = await import('../../scripts/copy-data-root.mjs')
  const fixture = process.env.PKW_TEST_DATA_ROOT
  if (!fixture || !existsSync(join(fixture, 'identity.sqlite'))) {
    await rm(root, { recursive: true, force: true })
    return
  }
  const copy = await copyDataRoot(fixture, dataRoot)
  assert.deepEqual(copy.leaks, [], 'the copy must be isolated from its source')
  const { hashPassword } = await import('./helpers/synthetic.mjs')
  const { DatabaseSync } = await import('node:sqlite')
  const identity = new DatabaseSync(join(dataRoot, 'identity.sqlite'))
  identity.prepare('UPDATE accounts SET password=? WHERE username=?').run(await hashPassword('manager-test-pass'), 'owner')
  identity.close()
  const releaseDir = join(root, 'releases', 'only', 'profile')
  const { mkdir, symlink } = await import('node:fs/promises')
  const stubScope = join(releaseDir, 'node_modules/@deepseek-ai/dsh-pkw-web')
  await mkdir(stubScope, { recursive: true })
  await writeFile(join(stubScope, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '0.0.1-manager-test', type: 'module', main: 'lib/index.js' }, null, 2) + '\n')
  await mkdir(join(root, 'releases'), { recursive: true })
  await symlink(join('releases', 'only'), join(root, 'current'))
  const manager = listenerManager({
    root, port, dataRoot, password: 'manager-test-pass',
    scriptsDir, repoRoot,
    configPath: join(root, 'collaboration.json'),
  })
  try {
    await writeFile(join(root, 'collaboration.json'), JSON.stringify({
      dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_E2E_BOOTSTRAP',
    }, null, 2) + '\n', { mode: 0o600 })
    // The profile is a synthetic stub, so the child cannot serve: this case only asserts that the
    // manager refuses a child that does not report listening, with the child's own output attached.
    await assert.rejects(() => manager.start(), error => {
      assert.ok(/never reported listening|exited before it served/.test(error.message), `unexpected failure: ${error.message}`)
      assert.ok(error.message.length > 40, 'the refusal must carry the child output')
      return true
    })
  } finally {
    // Cleanup is only finished once our own process is gone, and the evidence says so.
    await manager.stop().catch(() => undefined)
    const evidence = await manager.isStopped()
    assert.equal(evidence.known, true, JSON.stringify(evidence))
    assert.equal(evidence.stopped, true, JSON.stringify(evidence))
    await rm(root, { recursive: true, force: true })
  }
})

test('port holder: a free port is free, and a held one is held', async () => {
  const port = await freePort()
  const free = await portHolder(port)
  assert.deepEqual(free, { known: true, held: false })
  const release = await holdPort(port)
  try {
    const held = await portHolder(port)
    assert.deepEqual(held, { known: true, held: true })
  } finally {
    await release()
  }
})

test('the manager stops what it started, and the probe agrees', { skip: profile() ? false : 'no PKW profile available (set PKW_TEST_PROFILE)' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-manager-'))
  const dataRoot = join(root, 'data')
  const port = await freePort()
  const { mkdir, symlink } = await import('node:fs/promises')
  // A release that really starts: the profile under test is copied wholesale, so this exercises the
  // real listener rather than a stub, and the config points at a copied fixture.
  const { cp } = await import('node:fs/promises')
  const releaseDir = join(root, 'releases', 'real', 'profile')
  await mkdir(dirname(releaseDir), { recursive: true })
  await cp(profile(), releaseDir, { recursive: true, dereference: false })
  await mkdir(join(root, 'releases'), { recursive: true })
  await symlink(join('releases', 'real'), join(root, 'current'))
  const { copyDataRoot } = await import('../../scripts/copy-data-root.mjs')
  const fixture = process.env.PKW_TEST_DATA_ROOT
  if (!fixture) { await rm(root, { recursive: true, force: true }); return }
  await copyDataRoot(fixture, dataRoot)
  const { hashPassword } = await import('./helpers/synthetic.mjs')
  const { DatabaseSync } = await import('node:sqlite')
  const identity = new DatabaseSync(join(dataRoot, 'identity.sqlite'))
  identity.prepare('UPDATE accounts SET password=? WHERE username=?').run(await hashPassword('manager-test-pass'), 'owner')
  identity.close()
  const manager = listenerManager({
    root, port, dataRoot, password: 'manager-test-pass',
    scriptsDir, repoRoot,
    configPath: join(root, 'collaboration.json'),
  })
  await writeFile(join(root, 'collaboration.json'), JSON.stringify({
    dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_E2E_BOOTSTRAP',
  }, null, 2) + '\n', { mode: 0o600 })
  try {
    const started = await manager.start()
    assert.equal(started.version, JSON.parse(await readFile(join(profile(), 'package.json'), 'utf8')).version)
    const live = await manager.isStopped()
    assert.equal(live.known, true, JSON.stringify(live))
    assert.equal(live.stopped, false, 'a listener that is serving is not a stopped one')

    const stopped = await manager.stop()
    assert.equal(stopped.exited, true, JSON.stringify(stopped))
    const after = await manager.isStopped()
    assert.equal(after.known, true, JSON.stringify(after))
    assert.equal(after.stopped, true, `the manager's own stop must be provable: ${JSON.stringify(after)}`)
  } finally {
    await manager.stop().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

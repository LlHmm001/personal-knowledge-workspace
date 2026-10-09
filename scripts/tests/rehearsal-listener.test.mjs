import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { listenerManager } from '../../deploy/site/process-stop-state.mjs'
import { assertRehearsalProfileVersion, runRehearsal, stopRehearsalListener } from '../../deploy/rehearse-release.mjs'
import { makeSyntheticDataRoot } from './helpers/synthetic.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pkw-rehearsal-listener-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'releases/old/profile')
  for (const name of ['dsh-pkw-web', 'dsh-pkw-notes']) {
    const dir = join(profile, 'node_modules/@deepseek-ai', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '1.0.0-old' }))
  }
  await symlink('releases/old', join(root, 'current'))
  await writeFile(join(root, 'collaboration.json'), '{}')
  return { root, profile }
}

function fakeChild({ mode = 'normal', ready = true, spawnError = false } = {}) {
  const child = new EventEmitter()
  child.pid = spawnError ? undefined : 987654321
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.signals = []
  const finish = (code, signal = null, close = true) => {
    child.exitCode = code; child.signalCode = signal
    child.emit('exit', code, signal)
    if (close) { child.stdout.end(); child.stderr.end(); child.emit('close', code, signal) }
  }
  child.finish = finish
  child.kill = signal => {
    child.signals.push(signal)
    if (mode === 'stuck') return true
    if (mode === 'forced' && signal === 'SIGTERM') return true
    queueMicrotask(() => {
      child.stdout.write('diagnostic tail\n')
      if (mode === 'pipe-held') finish(0, null, false)
      else if (signal === 'SIGKILL') finish(null, 'SIGKILL')
      else finish(mode === 'bad-exit' ? 1 : 0)
    })
    return true
  }
  child.begin = () => queueMicrotask(() => {
    if (spawnError) { child.emit('error', new Error('synthetic spawn failure')); child.emit('close', -2, null) }
    else if (ready) child.stdout.write('{"status":"listening"}\n')
  })
  return child
}

function managerFor(f, child, overrides = {}) {
  return listenerManager({
    root: f.root, dataRoot: join(f.root, 'data'), port: 32123, password: 'synthetic',
    scriptsDir: f.root, repoRoot: f.root, spawnChild: () => { child.begin(); return child },
    startupTimeoutMs: 100, stopTimeoutMs: 30, killTimeoutMs: 30, ...overrides,
  })
}

test('source version gate reads every installed PKW package without relabelling it', async t => {
  const f = await fixture(t)
  const path = join(f.profile, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json')
  const before = await readFile(path)
  const extension = join(f.profile, 'node_modules/@deepseek-ai/dsh-extension-pkw')
  await mkdir(extension)
  await writeFile(join(extension, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-extension-pkw', version: '9.0.0-host-peer' }))
  assert.equal((await assertRehearsalProfileVersion(f.profile, '1.0.0-old')).length, 2)
  await assert.rejects(assertRehearsalProfileVersion(f.profile, '0.0.0-invented'), { code: 'PKW_REHEARSAL_SOURCE_VERSION_MISMATCH' })
  assert.deepEqual(await readFile(path), before)
  const notes = join(f.profile, 'node_modules/@deepseek-ai/dsh-pkw-notes/package.json')
  await writeFile(notes, JSON.stringify({ name: '@deepseek-ai/dsh-pkw-notes', version: '2.0.0-other' }))
  await assert.rejects(assertRehearsalProfileVersion(f.profile, '1.0.0-old'), { code: 'PKW_REHEARSAL_SOURCE_VERSION_MISMATCH' })
})

test('source version gate follows installed package links and refuses a mismatched linked package', async t => {
  const f = await fixture(t)
  const scope = join(f.profile, 'node_modules/@deepseek-ai')
  await mkdir(join(f.root, 'linked'))
  await writeFile(join(f.root, 'linked/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-tasks', version: '9.0.0-other' }))
  await symlink(join(f.root, 'linked'), join(scope, 'dsh-pkw-tasks'))
  await assert.rejects(assertRehearsalProfileVersion(f.profile, '1.0.0-old'), { code: 'PKW_REHEARSAL_SOURCE_VERSION_MISMATCH' })
})

test('real rehearsal entry refuses version mismatch before allocating any work directory', async t => {
  const f = await fixture(t), work = join(f.root, 'new-work')
  await assert.rejects(runRehearsal([
    '--work-dir', work, '--profile-source', f.profile, '--data-source', join(f.root, 'unused-data'),
    '--artifact-dir', join(f.root, 'unused-artifacts'), '--version', '2.0.0-new', '--old-version', '0.0.0-fake', '--port', '32123',
  ]), { code: 'PKW_REHEARSAL_SOURCE_VERSION_MISMATCH' })
  assert.equal((await readdir(f.root)).includes('new-work'), false)
})

test('real rehearsal entry refuses an existing work directory and preserves its pid record', async t => {
  const f = await fixture(t), work = join(f.root, 'previous-run')
  await mkdir(work); await writeFile(join(work, 'listener.pid'), String(process.pid))
  await assert.rejects(runRehearsal([
    '--work-dir', work, '--profile-source', f.profile, '--data-source', join(f.root, 'unused-data'),
    '--artifact-dir', join(f.root, 'unused-artifacts'), '--version', '2.0.0-new', '--old-version', '1.0.0-old', '--port', '32123',
  ]), { code: 'EEXIST' })
  assert.equal(await readFile(join(work, 'listener.pid'), 'utf8'), String(process.pid))
  assert.deepEqual(await readdir(work), ['listener.pid'])
})

test('owned handle stops once, drains the final log and does not trust a replaced pid file', async t => {
  const f = await fixture(t), child = fakeChild(), manager = managerFor(f, child)
  await manager.start()
  child.stdout.write('x'.repeat(90000))
  assert.equal(manager.recorded().frames.join('').length, 65536, 'diagnostic capture remains bounded while running')
  await writeFile(join(f.root, 'listener.pid'), JSON.stringify({ pid: process.pid }))
  const first = manager.stop(), second = manager.stop()
  assert.equal(first, second)
  const outcome = await first
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(outcome.pid, child.pid)
  assert.equal(outcome.graceful, true)
  assert.deepEqual(outcome.exit, { exitCode: 0, signal: null, spawnError: null })
  const files = await readdir(join(f.root, 'logs'))
  assert.match(await readFile(join(f.root, 'logs', files[0]), 'utf8'), /diagnostic tail/)
})

test('already observed exit is never signalled and is not called a graceful requested stop', async t => {
  const f = await fixture(t), child = fakeChild(), manager = managerFor(f, child)
  await manager.start(); child.finish(1)
  const outcome = await manager.stop()
  assert.deepEqual(child.signals, [])
  assert.equal(outcome.exit.exitCode, 1)
  assert.equal(outcome.alreadyExited, true)
  assert.equal(outcome.graceful, false)
})

for (const [mode, expected] of [['bad-exit', 1], ['forced', null], ['stuck', null], ['pipe-held', 0]]) {
  test(`stop outcome ${mode} cannot pass as graceful`, async t => {
    const f = await fixture(t), child = fakeChild({ mode }), manager = managerFor(f, child)
    await manager.start()
    const outcome = await manager.stop()
    assert.equal(outcome.graceful, false)
    assert.equal(outcome.exit?.exitCode ?? null, expected)
    if (mode === 'forced' || mode === 'stuck') assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
    if (mode === 'forced') assert.equal(outcome.exit.signal, 'SIGKILL')
    if (mode === 'stuck' || mode === 'pipe-held') assert.equal(outcome.closed, false)
  })
}

test('startup timeout retains ownership so the same child is stopped during cleanup', async t => {
  const f = await fixture(t), child = fakeChild({ ready: false }), manager = managerFor(f, child)
  await assert.rejects(manager.start(), /never reported listening/)
  const outcome = await manager.stop()
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(outcome.closed, true)
})

test('spawn error is registered immediately and retained rather than escaping as an unhandled event', async t => {
  const f = await fixture(t), child = fakeChild({ spawnError: true }), manager = managerFor(f, child)
  await assert.rejects(manager.start(), /exited before it served/)
  const outcome = await manager.stop()
  assert.match(outcome.exit.spawnError, /synthetic spawn failure/)
  assert.equal(outcome.graceful, false)
  assert.deepEqual(child.signals, [])
})

test('a pid file alone never authorizes stop to signal any process', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'listener.pid'), JSON.stringify({ pid: process.pid }))
  const manager = managerFor(f, null)
  assert.equal((await manager.stop()).requested, false)
})

test('cleanup retains stop failure and still performs the independent probe', async () => {
  const calls = []
  const result = await stopRehearsalListener({
    stop: async () => { calls.push('stop'); throw new Error('stop broke') },
    isStopped: async () => { calls.push('probe'); return { known: true, stopped: true } },
  })
  assert.deepEqual(calls, ['stop', 'probe'])
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].message, 'stop broke')
})

for (const [label, stop, evidence, ok] of [
  ['normal', { requested: true, graceful: true }, { known: true, stopped: true }, true],
  ['never started', { requested: false }, { known: true, stopped: true }, true],
  ['forced but absent', { requested: true, graceful: false, killed: true }, { known: true, stopped: true }, false],
  ['unknown', { requested: true, graceful: true }, { known: false, stopped: false }, false],
  ['still held', { requested: true, graceful: true }, { known: true, stopped: false }, false],
]) {
  test(`cleanup verdict: ${label}`, async () => {
    assert.equal((await stopRehearsalListener({ stop: async () => stop, isStopped: async () => evidence })).ok, ok)
  })
}

async function listen(server, port = 0) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done) })
  return server.address().port
}
async function close(server) { await new Promise(done => server.close(done)) }

test('actual temporary child reports its own listening, exits zero and passes the independent stop probe', async t => {
  const f = await fixture(t)
  const reservation = createServer(), port = await listen(reservation); await close(reservation)
  await writeFile(join(f.root, 'serve-collaboration.mjs'), `
    import { createServer } from 'node:http';
    const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
    const server = createServer((req,res) => res.end('test'));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
    server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({status:'listening'})));
  `)
  const manager = listenerManager({ root: f.root, dataRoot: join(f.root, 'data'), port, scriptsDir: f.root, repoRoot: f.root, password: 'synthetic', startupTimeoutMs: 3000, stopTimeoutMs: 1000, killTimeoutMs: 1000 })
  t.after(() => manager.stop())
  const started = await manager.start()
  assert.ok(started.pid)
  assert.equal((await manager.isStopped()).observations.process.state, 'alive')
  const cleanup = await stopRehearsalListener(manager)
  assert.equal(cleanup.ok, true, JSON.stringify(cleanup))
  assert.equal(cleanup.confirmed, true)
  assert.equal(cleanup.error, null)
  assert.equal(cleanup.stop.exit.exitCode, 0)
})

test('actual child startup failure cannot borrow a foreign listener and cleanup never stops that listener', async t => {
  const f = await fixture(t), foreign = createServer((req, res) => res.end('foreign'))
  const port = await listen(foreign)
  t.after(() => close(foreign))
  await writeFile(join(f.root, 'serve-collaboration.mjs'), 'process.exit(7)\n')
  const manager = listenerManager({ root: f.root, dataRoot: join(f.root, 'data'), port, scriptsDir: f.root, repoRoot: f.root, password: 'synthetic', startupTimeoutMs: 3000, stopTimeoutMs: 1000, killTimeoutMs: 1000 })
  t.after(() => manager.stop())
  await assert.rejects(manager.start(), /exited before it served/)
  const cleanup = await stopRehearsalListener(manager)
  assert.equal(cleanup.ok, false)
  assert.equal(cleanup.stop.exit.exitCode, 7)
  assert.equal(cleanup.stop.signalled, false)
  assert.equal(cleanup.evidence.observations.port.held, true)
  assert.equal(foreign.listening, true)
})

test('real driver SIGTERM stops its real temporary listener, preserves the scene and records failure', { timeout: 15_000 }, async t => {
  const f = await fixture(t), data = await makeSyntheticDataRoot()
  t.after(() => rm(data.root, { recursive: true, force: true }))
  await writeFile(join(f.profile, 'package.json'), '{}')
  const web = join(f.profile, 'node_modules/@deepseek-ai/dsh-pkw-web')
  await writeFile(join(web, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '1.0.0-old', type: 'module' }))
  await mkdir(join(web, 'lib/collaboration'), { recursive: true })
  await writeFile(join(web, 'lib/collaboration/index.js'), `
    export class CollaborationGateway {
      static async open() { return { async close() {}, handle(req,res) { res.end('fixture') } }; }
    }
  `)
  const artifacts = join(f.root, 'artifacts/web'), pack = join(f.root, 'pack/package')
  await mkdir(artifacts, { recursive: true }); await mkdir(pack, { recursive: true })
  await writeFile(join(pack, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '2.0.0-new' }))
  execFileSync('tar', ['-czf', join(artifacts, 'web.tgz'), '-C', join(f.root, 'pack'), 'package'])
  // Only the installation transaction is replaced. The CLI, source/copy gates, actual
  // serve-collaboration process, listenerManager, signal handler and cleanup are real.
  const switchStub = join(f.root, 'switch-stub.mjs'), marker = join(f.root, 'transaction-entered')
  await writeFile(switchStub, `
    import { realpath, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export const currentRelease = root => realpath(join(root,'current'));
    export const checkReachable = async ({origin}) => ({reachable:(await fetch(origin+'/healthz')).status===200});
    export async function switchRelease() {
      await writeFile(${JSON.stringify(marker)},'entered');
      await new Promise((done,reject) => process.once('SIGTERM', () => reject(new Error('synthetic transaction interrupted'))));
    }
  `)
  const preload = join(f.root, 'preload.mjs')
  await writeFile(preload, `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier,context,next) {
      if (specifier === './switch-release.mjs' && context.parentURL?.endsWith('/deploy/rehearse-release.mjs')) return {url:${JSON.stringify(pathToFileURL(switchStub).href)},shortCircuit:true};
      return next(specifier,context);
    }});
  `)
  const reservation = createServer(), port = await listen(reservation); await close(reservation)
  const work = join(f.root, 'run')
  const child = spawn(process.execPath, [
    '--import', preload, fileURLToPath(new URL('../../deploy/rehearse-release.mjs', import.meta.url)),
    '--work-dir', work, '--profile-source', f.profile, '--data-source', data.root,
    '--artifact-dir', join(f.root, 'artifacts'), '--version', '2.0.0-new', '--old-version', '1.0.0-old', '--port', String(port),
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', PKW_TEST_PROFILE: '', PKW_TEST_DATA_ROOT: '' } })
  let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
  const completed = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })) })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await completed })
  let entered = false
  for (let i = 0; i < 100; i++) {
    if (await readFile(marker).catch(() => null)) { entered = true; break }
    if (child.exitCode !== null) break
    await new Promise(done => setTimeout(done, 25))
  }
  assert.equal(entered, true, output)
  const recorded = JSON.parse(await readFile(join(work, 'listener.pid'), 'utf8'))
  child.kill('SIGTERM')
  assert.deepEqual(await completed, { code: 1, signal: null }, output)
  const report = JSON.parse(await readFile(join(work, 'report.json'), 'utf8'))
  const layout = await readFile(join(work, 'root/releases/1.0.0-old/profile/pnpm-workspace.yaml'), 'utf8')
  assert.match(layout, /nodeLinker: hoisted/)
  assert.match(layout, /autoInstallPeers: false/)
  assert.equal(report.interruption.signal, 'SIGTERM')
  assert.equal(report.exit.code, 1)
  assert.equal(report.cleanup.confirmed, true, JSON.stringify(report.cleanup))
  assert.equal(report.cleanup.error, null)
  assert.equal(report.cleanup.stop.pid, recorded.pid)
  assert.equal(report.cleanup.stop.exit.exitCode, 0)
  assert.ok((await readdir(work)).includes('data'), 'failure keeps the copied data and report')
  assert.throws(() => process.kill(recorded.pid, 0), { code: 'ESRCH' })
})

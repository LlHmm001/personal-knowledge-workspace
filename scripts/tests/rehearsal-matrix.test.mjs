import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { runOwned, requireCommand, runMatrix, treeBytes, caseExecutionEvidence, assertCaseExecution, caseFailureEvidence } from '../../deploy/rehearse-matrix.mjs'

async function root(t) {
  const path = await mkdtemp(join(tmpdir(), 'pkw-matrix-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
test('matrix child drains both streams and retains real exit status', async t => {
  const dir = await root(t), log = join(dir, 'child.log')
  const r = await runOwned(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=7'], { cwd: dir, env: {}, log })
  assert.equal(r.code, 7); assert.equal(r.interrupted, false); assert.equal(r.signal, null)
  const text = await readFile(log, 'utf8')
  assert.match(text, /out/); assert.match(text, /err/)
  assert.throws(() => requireCommand(r, 'fixture'), { code: 'PKW_MATRIX_COMMAND_FAILED' })
})
test('matrix child records spawn failure and does not wait for an exit that never occurs', async t => {
  const dir = await root(t)
  const r = await runOwned(join(dir, 'missing'), [], { cwd: dir, env: {}, log: join(dir, 'missing.log') })
  assert.equal(r.error, 'ENOENT')
  assert.throws(() => requireCommand(r, 'fixture'), { code: 'PKW_MATRIX_COMMAND_FAILED' })
})
test('matrix deadline remains failure even when child handles TERM and exits zero', { timeout: 5000 }, async t => {
  const dir = await root(t)
  const progress = []
  const r = await runOwned(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},20)'], {
    cwd: dir, env: {}, log: join(dir, 'deadline.log'), timeoutMs: 600, graceMs: 1000,
    onProgress: value => progress.push(value),
  })
  assert.equal(r.code, 0); assert.equal(r.interrupted, true)
  assert.equal(r.timedOut, true); assert.equal(r.interruptionReason, 'timeout')
  assert.deepEqual(r.groupCleanup, { known: true, present: false, closed: true, confirmed: true })
  assert.equal(r.stopActions[0].scope, 'child'); assert.equal(r.stopActions[0].signal, 'SIGTERM')
  assert.equal(progress.at(-1).state, 'stopping'); assert.equal(progress.at(-1).running, false)
  assert.equal(progress.at(-1).timedOut, true)
  const entry = caseExecutionEvidence('positive', dir, r)
  entry.cleanup = { ok: true, confirmed: true, error: null }
  entry.lifecycleOk = true
  assert.throws(() => assertCaseExecution(entry), { code: 'PKW_MATRIX_TIMEOUT' })
  assert.equal('tail' in entry.execution, false); assert.equal('stdout' in entry.execution, false)
  assert.throws(() => requireCommand(r, 'fixture'), { code: 'PKW_MATRIX_COMMAND_FAILED' })
})

test('matrix distinguishes external interruption from its own deadline', { timeout: 5000 }, async t => {
  const dir = await root(t), controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), 300)
  try {
    const result = await runOwned(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},20)'], {
      cwd: dir, env: {}, log: join(dir, 'signal.log'), signal: controller.signal, timeoutMs: 2000, graceMs: 1000, onProgress: () => {},
    })
    assert.equal(result.interrupted, true); assert.equal(result.timedOut, false); assert.equal(result.interruptionReason, 'signal')
    const entry = caseExecutionEvidence('positive', dir, result)
    entry.cleanup = { ok: true, confirmed: true, error: null }; entry.lifecycleOk = true
    assert.throws(() => assertCaseExecution(entry), { code: 'PKW_MATRIX_EXECUTION' })
  } finally { clearTimeout(abort) }
})

test('matrix timeout cannot hide unconfirmed cleanup or a missing report', () => {
  const result = { code: 1, signal: null, error: null, interrupted: true, timedOut: true, interruptionReason: 'timeout', groupCleanup: { confirmed: true } }
  const entry = caseExecutionEvidence('positive', '/private/scene', result)
  entry.cleanup = { ok: true, confirmed: false }; entry.lifecycleOk = true
  assert.throws(() => assertCaseExecution(entry), { code: 'PKW_MATRIX_CLEANUP' })
  entry.cleanup.confirmed = true
  entry.execution.groupCleanup.confirmed = false
  assert.throws(() => assertCaseExecution(entry), { code: 'PKW_MATRIX_CLEANUP' })
  entry.execution.groupCleanup.confirmed = true
  entry.reportError = { code: 'ENOENT', message: 'missing report' }
  assert.throws(() => assertCaseExecution(entry), { code: 'PKW_MATRIX_REPORT' })
  assert.equal(entry.execution.timedOut, true, 'original timeout evidence survives refusal')
})

test('matrix leaves expected nonzero cases to the strict verdict only after cleanup', () => {
  const entry = caseExecutionEvidence('breakwrite', '/private/scene', { code: 1, signal: null, error: null, interrupted: false, timedOut: false, groupCleanup: { confirmed: true } })
  entry.cleanup = { ok: true, confirmed: true }; entry.lifecycleOk = true
  assert.doesNotThrow(() => assertCaseExecution(entry))
  entry.execution.error = 'PKW_MATRIX_DESCENDANTS'
  assert.throws(() => assertCaseExecution(entry), { code: 'PKW_MATRIX_CLEANUP' }, 'a leftover group remains a protocol failure even after it is removed')
})
test('matrix refuses an existing scene without deleting its files', async t => {
  const dir = await root(t)
  const work = join(dir, 'existing'), inputs = join(dir, 'inputs')
  await mkdir(work); await mkdir(inputs)
  const v = Object.fromEntries(['profile-source', 'data-source', 'old-artifact-dir', 'artifact-dir', 'store-source'].map(k => [k, inputs]))
  await assert.rejects(runMatrix({ ...v, 'work-dir': work, version: '2', 'old-version': '1' }), { code: 'EEXIST' })
  assert.equal((await import('node:fs')).existsSync(work), true)
})
test('matrix rejects any input inside its future working directory before creating it', async t => {
  const dir = await root(t)
  const v = Object.fromEntries(['profile-source', 'data-source', 'old-artifact-dir', 'artifact-dir', 'store-source'].map(k => [k, dir]))
  await assert.rejects(runMatrix({ ...v, 'work-dir': join(dir, 'run'), version: '2', 'old-version': '1' }), { code: 'PKW_MATRIX_PATH_OVERLAP' })
})

test('private store refuses even internal relative and absolute source links', async t => {
  const dir = await root(t)
  await writeFile(join(dir, 'file'), 'cache bytes')
  assert.equal(await treeBytes(dir, { rejectLinks: true }), 11)
  for (const target of ['file', join(dir, 'file')]) {
    await symlink(target, join(dir, 'alias'))
    await assert.rejects(treeBytes(dir, { rejectLinks: true }), { code: 'PKW_MATRIX_STORE_LINK' })
    await rm(join(dir, 'alias'))
  }
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'cache bytes')
})

test('matrix refuses a zero-exit driver with a surviving same-group child and confirms cleanup', { timeout: 7000 }, async t => {
  const dir = await root(t), ready = join(dir, 'descendant-ready')
  // This child has no inherited pipes to hold the driver's close event open.
  // It exits itself within three seconds even if the runner's cleanup regresses.
  const descendantSource = `
    const fs = require('node:fs')
    process.on('SIGTERM', () => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
    fs.writeFileSync(process.argv[1], String(process.pid))
  `
  const driverSource = `
    const { spawn } = require('node:child_process')
    const fs = require('node:fs')
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}, ${JSON.stringify(ready)}], { stdio: 'ignore', detached: false })
    child.once('error', () => process.exit(2))
    const wait = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(ready)})) return
      clearInterval(wait)
      process.stdout.write(JSON.stringify({ descendant: child.pid }) + '\\n', () => process.exit(0))
    }, 5)
  `
  let descendant
  const alive = () => {
    try { process.kill(descendant, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  try {
    const result = await runOwned(process.execPath, ['-e', driverSource], {
      cwd: dir, env: {}, log: join(dir, 'orphan.log'), timeoutMs: 1500, graceMs: 50,
    })
    descendant = JSON.parse(result.tail.trim()).descendant
    assert.ok(Number.isSafeInteger(descendant) && descendant > 0 && descendant !== process.pid && descendant !== result.pid)
    assert.equal(result.code, 0, 'the direct driver exited successfully')
    assert.equal(result.interrupted, false, 'this is a leftover group, not a deadline failure')
    assert.equal(result.error, 'PKW_MATRIX_DESCENDANTS')
    assert.throws(() => requireCommand(result, 'orphan-fixture'), { code: 'PKW_MATRIX_COMMAND_FAILED' })
    assert.equal(alive(), false, 'return only after the owned descendant is gone')
  } finally {
    // Never signal an arbitrary saved PID in the test. The only descendant is bounded above.
    if (Number.isSafeInteger(descendant) && descendant > 0) {
      const deadline = Date.now() + 3500
      while (alive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
    }
  }
})


test('matrix exposes the original business failure separately from rollback and verdict', () => {
  const report = {
    status: 'PKW_DEPLOYMENT_ROLLED_BACK',
    error: { code: 'PKW_DEPLOYMENT_ROLLED_BACK', message: 'previous release restored' },
    result: {
      status: 'rolled-back',
      activationError: { message: 'outer', details: { name: 'Error', message: 'uploadAttachment failed (400)', cause: { message: 'missing filename' } } },
      rollbackEvidence: { reachability: 'verified', acceptance: 'verified' },
    },
    phases: { login: { password: 'never-copy', csrf: 'never-copy' } },
  }
  const evidence = caseFailureEvidence(report)
  assert.equal(evidence.activationError.message, 'uploadAttachment failed (400)')
  assert.equal(evidence.activationError.cause.message, 'missing filename')
  assert.equal(evidence.driverError.code, 'PKW_DEPLOYMENT_ROLLED_BACK')
  assert.equal(evidence.transactionStatus, 'rolled-back')
  assert.deepEqual(evidence.rollbackEvidence, { reachability: 'verified', acceptance: 'verified' })
  assert.equal(JSON.stringify(evidence).includes('never-copy'), false)
})

test('matrix failure summary redacts credentials and bounds error text without mutating private evidence', () => {
  const message = 'password="secret-password" csrf="secret-csrf" token=secret-token Authorization: Bearer secret-bearer https://user:secret-url@example.test';
  const report = { status: 'failed', error: { message, cause: { message: 'csrf=secret-cause ' + 'x'.repeat(9000) } } }
  const evidence = caseFailureEvidence(report)
  const printed = JSON.stringify(evidence)
  for (const value of ['secret-password', 'secret-csrf', 'secret-token', 'secret-bearer', 'secret-url', 'secret-cause']) assert.equal(printed.includes(value), false)
  assert.equal(report.error.message, message)
  assert.ok(evidence.driverError.message.length <= 2000)
  assert.ok(evidence.driverError.cause.message.length <= 2000)
  assert.equal(evidence.activationError, null)
  assert.equal(caseFailureEvidence(null).driverError, null)
})


test('matrix failure summary tolerates a truncated nested error tree', () => {
  let error = { message: 'root cause' }
  for (let i = 0; i < 10; i++) error = { message: `layer-${i}`, cause: error }
  const evidence = caseFailureEvidence({ error })
  assert.match(JSON.stringify(evidence), /TruncatedError/)
  assert.equal(JSON.stringify(evidence).includes('root cause'), false)
})

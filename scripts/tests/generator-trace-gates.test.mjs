/**
 * The generator's child lifetime, and what the trace gate refuses.
 *
 * Both gates are about the same thing: a subprocess is evidence only if the process itself
 * succeeded and the result it produced has the shape the caller depends on. A child that exited
 * before a listener was registered, a child that was killed, and a child that never started are
 * three different failures and none of them may be read as success.
 *
 * Every child here is real (spawned `node -e`), and every trace result is a string, so nothing in
 * this file touches the network, a harness, or a production path.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { trackLifetime, describeOutcome } from './helpers/child-lifetime.mjs'
import { assertTraceResult } from '../../scripts/trace-result.mjs'

/** Spawn a node one-liner and track it. */
const spawnNode = (source, options = {}) => trackLifetime(spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'], ...options }))

test('generator: a child that exits before the first await is still observed', async () => {
  // The reported defect: `exitCode` was polled, so an exit that happened before the wait started
  // was waited for forever. The exit event is registered at spawn, so the outcome is already there.
  const lifetime = spawnNode('process.exit(7)')
  const outcome = await lifetime.race(5000)
  assert.deepEqual(outcome, { exitCode: 7, signal: null, spawnError: null })
  assert.equal(lifetime.settled, true)
  // Waiting again returns the same recorded outcome instead of hanging or re-listening.
  assert.deepEqual(await lifetime.race(1), outcome)
  assert.deepEqual(await lifetime.exited, outcome)
})

test('generator: a normal exit is reported with code 0 and its output', async () => {
  const lifetime = spawnNode('console.log("started")')
  const outcome = await lifetime.race(5000)
  assert.equal(outcome.exitCode, 0)
  assert.equal(outcome.signal, null)
  assert.match(lifetime.log, /started/)
})

test('generator: a child killed by a signal reports the signal', async () => {
  const { spawn: spawnChild } = await import('node:child_process')
  const raw = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const lifetime = trackLifetime(raw)
  await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
  assert.equal(lifetime.settled, false)
  raw.kill('SIGTERM')
  const outcome = await lifetime.race(5000)
  assert.equal(outcome.exitCode, null)
  assert.equal(outcome.signal, 'SIGTERM')
  assert.equal(describeOutcome(outcome), 'was killed by SIGTERM')
})

test('generator: a child that cannot be started is not an exit', async () => {
  const { spawn: spawnChild } = await import('node:child_process')
  const lifetime = trackLifetime(spawnChild('/nonexistent/binary-for-this-test', []))
  const outcome = await lifetime.race(5000)
  assert.equal(outcome.exitCode, null)
  assert.equal(outcome.signal, null)
  assert.match(outcome.spawnError, /ENOENT/)
  assert.match(describeOutcome(outcome), /could not be started/)
})

test('generator: a wait that ends does not leave a live timer behind', async () => {
  // A leaked timer would keep the process alive after the fixture is finished.
  const before = process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
  const lifetime = spawnNode('process.exit(0)')
  await lifetime.race(60000)
  const after = process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length
  assert.ok(after <= before, `a completed wait left ${after - before} timer(s) behind`)
})

test('generator: a stuck child is reported as stuck rather than as generated', async () => {
  // The stop flow's contract: if the child ignores SIGTERM and SIGKILL, no outcome is recorded, and
  // the caller must fail. This mirrors `stop()` in generate-fixture.mjs without spawning a server.
  const raw = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const lifetime = trackLifetime(raw)
  assert.equal(await lifetime.race(100), null, 'a child that has not exited produces no outcome')
  raw.kill('SIGKILL')
  const outcome = await lifetime.race(5000)
  assert.equal(outcome.signal, 'SIGKILL')
})

test('trace gate: a non-zero exit is refused even when the payload looks perfect', () => {
  const perfect = JSON.stringify({ ok: true, profile: '/p', entry: '/p/e.js', loaded: 3, outside: [], importError: null })
  assert.match(assertTraceResult({ exitCode: 5, stdout: perfect, stderr: 'not self-contained' }), /exited 5/)
  assert.match(assertTraceResult({ exitCode: null, stdout: perfect, stderr: 'spawn failed' }), /exited null/)
})

test('trace gate: null, false and non-objects are refused', () => {
  assert.match(assertTraceResult({ exitCode: 0, stdout: '' }), /no parseable result/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: 'null' }), /is not an object/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: 'false' }), /is not an object/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: '0' }), /is not an object/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: '"trace"' }), /is not an object/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: '[1,2]' }), /is not an object/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: 'not json at all' }), /no parseable result/)
})

test('trace gate: missing fields and wrong types are refused', () => {
  const base = { ok: true, loaded: 1, outside: [], importError: null }
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, loaded: undefined }) }), /no numeric loaded count/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, loaded: '3' }) }), /no numeric loaded count/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, loaded: null }) }), /no numeric loaded count/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, outside: undefined }) }), /no list of outside files/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, outside: '/p/x.js' }) }), /no list of outside files/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, outside: [1, 2] }) }), /no list of outside files/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, importError: { message: 'x' } }) }), /non-textual import error/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ...base, ok: false }) }), /did not report ok:true/)
  assert.match(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ loaded: 1, outside: [] }) }), /did not report ok:true/)
})

test('trace gate: a non-empty outside list is the violation, and is named', () => {
  const message = assertTraceResult({
    exitCode: 0,
    stdout: JSON.stringify({ ok: false, loaded: 12, outside: ['/opt/dsh/x.js', '/opt/dsh/y.js'], importError: null }),
  })
  assert.match(message, /2 file\(s\) loaded from outside the profile/)
  assert.match(message, /\/opt\/dsh\/x\.js/)
})

test('trace gate: a clean result is accepted', () => {
  const stdout = JSON.stringify({ ok: true, profile: '/p', entry: '/p/e.js', loaded: 4, outside: [], importError: null })
  assert.equal(assertTraceResult({ exitCode: 0, stdout, stderr: '' }), null)
  // `importError` may be absent when the import succeeded, and that is not a missing field.
  assert.equal(assertTraceResult({ exitCode: 0, stdout: JSON.stringify({ ok: true, loaded: 4, outside: [] }) }), null)
})

test('trace gate: the tracer itself reports the same shape the gate expects', async () => {
  // A real tracer run against a directory that is not a profile: the process must fail, and the
  // gate must refuse it for the exit rather than believe anything on stdout.
  const dir = await mkdtemp(join(tmpdir(), 'pkw-trace-'))
  try {
    const tracer = join(process.cwd(), 'scripts/tests/helpers/trace-imports.mjs')
    const result = await new Promise(resolvePromise => {
      const child = spawn(process.execPath, [tracer, '--profile', dir], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('exit', code => resolvePromise({ code, stdout, stderr }))
    })
    assert.notEqual(result.code, 0, 'tracing a directory that is not a profile must fail')
    const refusal = assertTraceResult({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr })
    assert.notEqual(refusal, null, 'the gate must refuse a tracer that failed')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('trace gate: combined with the checker flags, a refused trace becomes a violation', async () => {
  // The checker's own entry point must exit non-zero and report the refusal when the trace is not
  // believable. `--profile` points at a directory that is not an installed profile, so the checker
  // refuses before tracing; this asserts the command-line contract, not the internals.
  const dir = await mkdtemp(join(tmpdir(), 'pkw-not-a-profile-'))
  try {
    const checker = join(process.cwd(), 'scripts/check-profile-selfcontained.mjs')
    const result = await new Promise(resolvePromise => {
      const child = spawn(process.execPath, [checker, '--profile', dir, '--trace-imports'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('exit', code => resolvePromise({ code, stdout, stderr }))
    })
    assert.equal(result.code, 2, `unexpected exit ${result.code}: ${result.stderr}`)
    assert.match(result.stderr, /not an installed profile/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

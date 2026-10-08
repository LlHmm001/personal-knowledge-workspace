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
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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

// ── the real entry point, end to end ─────────────────────────────────────────────────────────

/**
 * A profile with a real peer closure, which the generator needs to start an actual listener.
 * Required, never guessed; the test declares the skip and names the input.
 */
function profileUnderTest() {
  return process.env.PKW_TEST_PROFILE ?? ''
}

/** The first port from `from` that nothing is listening on, so a parallel test cannot collide. */
async function freePort(from) {
  const { createServer } = await import('node:net')
  for (let port = from; port < from + 200; port += 1) {
    const free = await new Promise(resolvePromise => {
      const server = createServer()
      server.once('error', () => resolvePromise(false))
      server.once('listening', () => server.close(() => resolvePromise(true)))
      server.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free port in ${from}..${from + 200}`)
}

test('generator: the real entry point generates a fixture and stops its listener', {
  skip: profileUnderTest() ? false : 'no PKW profile available (set PKW_TEST_PROFILE)',
}, async () => {
  // The whole entry point: it must see the listener's own startup line while it is still printing,
  // confirm health from that process, create the fixture through the product API, stop the
  // listener, and exit 0. The log is read live, so a fixed snapshot would fail here.
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-gen-real-'))
  const target = join(workspace, 'data')
  const port = await freePort(42711)
  try {
    const generator = join(process.cwd(), 'scripts/tests/helpers/generate-fixture.mjs')
    const result = await new Promise(resolvePromise => {
      const child = spawn(process.execPath, [
        generator, '--target', target, '--profile', profileUnderTest(), '--port', String(port),
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('exit', code => resolvePromise({ code, stdout, stderr }))
    })
    assert.equal(result.code, 0, `the generator failed: ${result.stderr.slice(-600)}`)
    const report = JSON.parse(result.stdout)
    // The listener was stopped, and stopped by exiting rather than by being killed.
    assert.deepEqual(report.stopped, { exitCode: 0, signal: null, spawnError: null })
    assert.match(report.spaceId, /^sp_/)
    assert.match(report.noteId, /^note_/)
    assert.equal(report.attachmentBytes, 27)
    assert.equal(report.attachment?.sizeBytes, 27, 'the upload is reported with its stored size')
    assert.match(report.attachment?.attachmentId ?? '', /^att_/)
    // The fixture is a real data root: its own databases, and the note on disk.
    const entries = (await readdir(target)).sort()
    assert.ok(entries.includes('identity.sqlite'), `expected an identity store, got ${JSON.stringify(entries)}`)
    assert.ok(entries.includes('spaces'), `expected spaces, got ${JSON.stringify(entries)}`)
    const spaceEntries = await readdir(join(target, 'spaces', report.spaceId))
    assert.ok(spaceEntries.includes('state.sqlite'), `expected a space state store, got ${JSON.stringify(spaceEntries)}`)
    // The note lives under the space's workspace, at the relative path the fixture asked for.
    const note = join(target, 'spaces', report.spaceId, 'workspace', 'notes', 'fixture/note.md')
    const noteText = await readFile(note, 'utf8')
    // The product writes the note with its own front matter, and the body the fixture asked for.
    assert.ok(noteText.includes(`id: ${report.noteId}`), `the note must carry its own id: ${noteText.slice(0, 120)}`)
    assert.ok(noteText.endsWith(report.noteBody), `the note must hold the body the fixture asked for: ${noteText.slice(-120)}`)
    const attachmentDir = join(target, 'spaces', report.spaceId, 'workspace', 'attachments', report.attachment.attachmentId)
    const attachmentFiles = await readdir(attachmentDir)
    assert.equal(attachmentFiles.length, 1, `expected one stored attachment object, got ${JSON.stringify(attachmentFiles)}`)
    assert.equal((await stat(join(attachmentDir, attachmentFiles[0]))).size, 27)
    // The fixture is private, as the generator leaves it.
    assert.equal((await stat(target)).mode & 0o777, 0o700)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('generator: the real entry point refuses a target that already exists', async () => {
  // The other end of the entry point: an existing path is refused, and what is in it is untouched.
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-gen-exists-'))
  const target = join(workspace, 'data')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'someone-elses-file'), 'keep me\n')
  try {
    const generator = join(process.cwd(), 'scripts/tests/helpers/generate-fixture.mjs')
    const result = await new Promise(resolvePromise => {
      const child = spawn(process.execPath, [
        generator, '--target', target, '--profile', profileUnderTest() || '/nonexistent-profile', '--port', '42712',
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('exit', code => resolvePromise({ code, stdout, stderr }))
    })
    assert.equal(result.code, 3, `unexpected exit ${result.code}: ${result.stderr}`)
    assert.match(result.stderr, /refusing to generate into an existing path/)
    assert.equal(await readFile(join(target, 'someone-elses-file'), 'utf8'), 'keep me\n')
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

// ── the outcome gate: a generated fixture is only reported by a clean shutdown ───────────────

/** Run the real generator, optionally armed so its listener ends unexpectedly after generating. */
function runGenerator({ target, port, profile, probe = null }) {
  const generator = join(process.cwd(), 'scripts/tests/helpers/generate-fixture.mjs')
  const probeScript = join(process.cwd(), 'scripts/tests/helpers/fixture-listener-outcome.mjs')
  // The listener inherits the generator's environment, so the hatch is armed on the generator
  // itself; the probe only decides *when*, by writing the file the listener waits for.
  const env = probe ? { ...process.env, PKW_TEST_LISTENER_EXIT: probe === 'signal' ? 'signal' : 'code1' } : process.env
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [
      generator, '--target', target, '--profile', profile, '--port', String(port),
    ], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    if (!probe) {
      child.once('exit', code => resolvePromise({ code, stdout, stderr }))
      return
    }
    const watcher = spawn(process.execPath, [probeScript, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PKW_FIXTURE_PROBE: probe },
    })
    let probeError = ''
    watcher.stderr.on('data', chunk => { probeError += chunk })
    child.once('exit', code => {
      const finish = () => resolvePromise({ code, stdout, stderr, probeError })
      if (watcher.exitCode === null) watcher.once('exit', finish)
      else finish()
    })
  })
}

test('generator: the outcome gate holds on the success path', {
  skip: profileUnderTest() ? false : 'no PKW profile available (set PKW_TEST_PROFILE)',
}, async () => {
  // The control: a clean shutdown is the only thing reported as a generated fixture, and the report
  // says so in the three fields the gate reads.
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-gen-gate-'))
  const target = join(workspace, 'data')
  const port = await freePort(42811)
  try {
    const result = await runGenerator({ target, port, profile: profileUnderTest() })
    assert.equal(result.code, 0, `the generator failed: ${result.stderr.slice(-500)}`)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.stopped, { exitCode: 0, signal: null, spawnError: null },
      'a fixture may only be reported after a clean shutdown')
    assert.match(report.noteId, /^note_/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('generator: a listener that exits non-zero after generating is never reported as generated', {
  skip: profileUnderTest() ? false : 'no PKW profile available (set PKW_TEST_PROFILE)',
}, async () => {
  // The counterexample: the fixture exists — note and attachment are on disk — and then the writer
  // exits with code 1. The outcome gate must refuse it for the code and report the reason.
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-gen-exit1-'))
  const target = join(workspace, 'data')
  const port = await freePort(42831)
  try {
    const result = await runGenerator({ target, port, profile: profileUnderTest(), probe: 'exit1' })
    assert.notEqual(result.code, 0, 'a non-zero listener exit must not produce a successful run')
    assert.doesNotMatch(result.stdout, /noteId/, 'no success report may be printed')
    const failure = JSON.parse(result.stderr.slice(result.stderr.indexOf('{')))
    assert.equal(failure.stopped.exitCode, 1, `the stop outcome must show the exit code: ${JSON.stringify(failure.stopped)}`)
    assert.equal(failure.stopped.signal, null)
    assert.match(failure.error, /did not shut down cleanly/)
    assert.match(failure.error, /exited with 1/)
    assert.equal(failure.preserved, true)
    // The scene is kept, including the note this run generated.
    assert.equal(existsSync(join(target, 'identity.sqlite')), true)
    const spaces = await readdir(join(target, 'spaces'))
    assert.ok(spaces.length >= 1)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('generator: a listener killed after generating is never reported as generated', {
  skip: profileUnderTest() ? false : 'no PKW profile available (set PKW_TEST_PROFILE)',
}, async () => {
  // The same defect with the other ending: the writer dies from a signal.
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-gen-killed-'))
  const target = join(workspace, 'data')
  const port = await freePort(42851)
  try {
    const result = await runGenerator({ target, port, profile: profileUnderTest(), probe: 'signal' })
    assert.notEqual(result.code, 0, 'a killed listener must not produce a successful run')
    assert.doesNotMatch(result.stdout, /noteId/, 'no success report may be printed')
    const failure = JSON.parse(result.stderr.slice(result.stderr.indexOf('{')))
    assert.equal(failure.stopped.signal, 'SIGKILL', `the stop outcome must show the signal: ${JSON.stringify(failure.stopped)}`)
    assert.equal(failure.stopped.exitCode, null)
    assert.match(failure.error, /did not shut down cleanly|was killed by SIGKILL/)
    assert.equal(failure.preserved, true)
    assert.equal(existsSync(join(target, 'identity.sqlite')), true)
    const spaces = await readdir(join(target, 'spaces'))
    assert.ok(spaces.length >= 1)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

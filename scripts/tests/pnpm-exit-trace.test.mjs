import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const preload = fileURLToPath(new URL('../../deploy/site/pnpm-exit-trace.cjs', import.meta.url))
const prefix = '[PKW_PNPM_EXIT_TRACE] '
const secret = 'private-diagnostic-sentinel-should-not-appear'

function fixture(t, source, { onTrace } = {}) {
  const child = spawn(process.execPath, ['--require', preload, '-e', source, '--', secret], {
    env: { ...process.env, NODE_OPTIONS: '', PKW_TEST_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', pending = ''
  const traces = []
  const bound = setTimeout(() => child.kill('SIGKILL'), 8000)
  t.after(() => { clearTimeout(bound); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => {
    stderr += data; pending += data
    const lines = pending.split('\n'); pending = lines.pop()
    for (const line of lines) {
      if (!line.startsWith(prefix)) continue
      assert.ok(Buffer.byteLength('\n' + line + '\n', 'utf8') <= 3500, 'each complete trace write stays below the byte limit')
      const trace = JSON.parse(line.slice(prefix.length))
      traces.push(trace)
      onTrace?.(trace, child)
    }
  })
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { clearTimeout(bound); resolve({ code, signal, stdout, stderr, traces, pid: child.pid }) })
  })
  return { child, finished }
}

test('trace preserves fragmented stdout writes and callbacks, and permits natural exit', { timeout: 5000 }, async t => {
  const { finished } = fixture(t, `
    const assert = require('node:assert/strict')
    const callbacks = []
    assert.equal(process.stdout.write('Do', 'utf8', () => callbacks.push(1)), true)
    assert.equal(process.stdout.write(Buffer.from('ne i'), () => callbacks.push(2)), true)
    assert.equal(process.stdout.write(new Uint8Array(Buffer.from('n 3.9s using pnpm v11.7.0\\n')), () => {
      callbacks.push(3)
      assert.deepEqual(callbacks, [1, 2, 3])
      process.stderr.write('ordinary stderr\\n')
    }), true)
  `)
  const result = await finished
  assert.equal(result.code, 0); assert.equal(result.signal, null)
  assert.equal(result.stdout, 'Done in 3.9s using pnpm v11.7.0\n')
  assert.match(result.stderr, /ordinary stderr\n/)
  assert.equal(result.stderr.includes(secret), false)
  assert.deepEqual(result.traces.map(item => item.phase), ['startup', 'done', 'beforeExit', 'exit'])
  for (const trace of result.traces) {
    assert.equal(trace.pid, result.pid)
    assert.equal(trace.pnpmModule, null)
    assert.ok(trace.handles.length <= 32); assert.ok(trace.requests.length <= 32)
    assert.ok(trace.resources.every(resource => typeof resource.type === 'string' && Number.isInteger(resource.count)))
    assert.equal('argv' in trace, false); assert.equal('env' in trace, false)
    for (const handle of trace.handles) assert.ok(Object.keys(handle).every(key => ['type', 'ref', 'fd'].includes(key)))
  }
})

test('trace diagnoses Done while the child remains alive, without terminating it', { timeout: 10000 }, async t => {
  let diagnosed = false
  const { finished } = fixture(t, `
    setInterval(() => {}, 1000)
    process.stdout.write('Done in 1ms using pnpm v11.7.0\\n')
  `, { onTrace(trace, child) {
    if (trace.phase !== 'after-done-2s') return
    diagnosed = true
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null)
    assert.ok(trace.resources.some(resource => resource.type === 'Timeout' && resource.count >= 1))
    child.kill('SIGTERM') // Only the fixture's parent decides when to stop its child.
  } })
  const result = await finished
  assert.equal(diagnosed, true)
  assert.equal(result.code, null); assert.equal(result.signal, 'SIGTERM')
  assert.deepEqual(result.traces.map(item => item.phase), ['startup', 'done', 'after-done-2s'])
  assert.equal(result.stderr.includes(secret), false)
})

test('preload stays silent in worker threads', { timeout: 5000 }, async t => {
  const { finished } = fixture(t, `
    const { Worker } = require('node:worker_threads')
    const worker = new Worker("process.stdout.write('Done in 1ms using pnpm v11.7.0\\\\n')", { eval: true, stdout: true, stderr: true })
    worker.stdout.resume()
    worker.stderr.on('data', data => process.stderr.write(data))
  `)
  const result = await finished
  assert.equal(result.code, 0); assert.equal(result.signal, null)
  assert.deepEqual(result.traces.map(item => item.phase), ['startup', 'beforeExit', 'exit'])
  assert.ok(result.traces.every(trace => trace.pid === result.pid))
})

test('live timer allocations identify the fixture location without collecting secrets or diagnostic timers', { timeout: 10000 }, async t => {
  let doneEvidence, evidence
  const { finished } = fixture(t, `function keepAliveMarker() {
  return setInterval(() => {}, 1000)
}
keepAliveMarker()
const vm = require('node:vm')
const extra = Array.from({ length: 300 }, (_, index) => vm.runInThisContext('setInterval(() => {}, 1000)', { filename: '/tmp/' + '目录'.repeat(150) + '/' + index + '/pnpm.mjs' }))
process.stdout.write('Done in 1ms using pnpm v11.7.0\\n')
for (const timer of extra) clearInterval(timer)
`, { onTrace(trace, child) {
    if (trace.phase === 'done') doneEvidence = trace
    if (trace.phase !== 'after-done-2s') return
    evidence = trace
    child.kill('SIGTERM')
  } })
  const result = await finished
  assert.equal(result.signal, 'SIGTERM')
  assert.ok(evidence)
  assert.ok(evidence.allocations.some(allocation => allocation.type === 'Timeout' && allocation.stack.some(frame => frame.file === '[eval]' && frame.line === 2)))
  assert.ok(evidence.allocations.length <= 4)
  assert.ok(evidence.allocationTracked <= evidence.allocationLimit)
  assert.equal(doneEvidence.allocationTracked, 256)
  assert.ok(doneEvidence.allocations.length <= 2, 'large UTF-8 filenames require trimming allocation output')
  assert.ok(doneEvidence.allocationOmitted > 0)
  assert.ok(evidence.allocationDropped > 0)
  assert.equal(evidence.allocationOverflow, true)
  assert.equal(evidence.allocationTracked, 1, 'destroy removes cleared timers, and diagnostic timers are excluded')
  assert.ok(evidence.allocations.every(allocation => allocation.stack.length <= 2 && allocation.stack.every(frame => frame.file !== preload)))
  assert.equal(result.stderr.includes(secret), false)
  assert.equal(result.stderr.includes('keepAliveMarker'), false, 'only locations, not function names or source, are emitted')
})

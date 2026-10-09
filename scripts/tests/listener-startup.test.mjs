import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openListenerGateway, reportListenerRefusal, settleListenerLock } from '../listener-startup.mjs'

const config = { dataPath: '/injected/data' }
const ready = { ready: true }
const empty = { ready: false, reason: 'empty-lock', exitCode: 4 }
const ownerless = { ready: false, reason: 'lock-without-owner', exitCode: 4 }
const live = { ready: false, reason: 'live-writer', exitCode: 3, pid: 42 }
const gateway = { handle() {}, async close() {} }

function observations(states) {
  let reads = 0, waits = 0
  return {
    prepareLock: async () => states[Math.min(reads++, states.length - 1)],
    wait: async () => { waits += 1 },
    retries: 2,
    intervalMs: 50,
    counts: () => ({ reads, waits }),
  }
}

test('preflight: an incomplete claim becomes live only after a live-writer observation', async () => {
  const observe = observations([empty, ownerless, live])
  let opens = 0
  const result = await openListenerGateway(config, { ...observe, openGateway: async () => { opens += 1; return gateway } })
  assert.equal(result.kind, 'refused')
  assert.equal(result.exitCode, 3)
  assert.equal(result.diagnostic.pid, 42)
  assert.equal(opens, 0)
  assert.deepEqual(observe.counts(), { reads: 3, waits: 2 })
})

for (const lock of [empty, ownerless]) {
  test(`preflight: persistent ${lock.reason} stays unreadable, never becomes live or ready`, async () => {
    const observe = observations([lock])
    const result = await openListenerGateway(config, { ...observe, openGateway: () => assert.fail('must not open') })
    assert.equal(result.kind, 'refused')
    assert.equal(result.exitCode, 4)
    assert.equal(result.diagnostic.reason, lock.reason)
    assert.equal(result.diagnostic.settlementTimedOut, true)
    assert.deepEqual(observe.counts(), { reads: 3, waits: 2 })
  })
}

for (const [reason, exitCode] of [['malformed-lock', 4], ['unreadable', 4], ['writer-identity-uncertain', 5]]) {
  test(`preflight: ${reason} is refused immediately with its protocol code`, async () => {
    const observe = observations([{ ready: false, reason, exitCode }])
    const result = await openListenerGateway(config, { ...observe, openGateway: () => assert.fail('must not open') })
    assert.equal(result.kind, 'refused')
    assert.equal(result.exitCode, exitCode)
    assert.deepEqual(observe.counts(), { reads: 1, waits: 0 })
  })
}

test('a settled free claim still requires exactly one atomic gateway open', async () => {
  const observe = observations([empty, ready])
  let opens = 0
  const result = await openListenerGateway(config, { ...observe, openGateway: async value => {
    assert.equal(value, config); opens += 1; return gateway
  } })
  assert.equal(result.kind, 'opened')
  assert.equal(result.gateway, gateway)
  assert.equal(opens, 1)
})

for (const [name, states, code] of [
  ['live owner after an empty claim', [ready, empty, live], 3],
  ['persistent empty claim', [ready, empty], 4],
  ['persistent ownerless claim', [ready, ownerless], 4],
]) {
  test(`lost atomic claim: ${name} returns a refusal, never null`, async () => {
    const observe = observations(states)
    let opens = 0
    const result = await openListenerGateway(config, { ...observe, openGateway: async () => {
      opens += 1; throw new Error('exclusive claim lost')
    } })
    assert.equal(result.kind, 'refused')
    assert.equal(result.exitCode, code)
    assert.equal(opens, 1, 'do not repeatedly initialize the gateway while observing contention')
    assert.equal('gateway' in result, false)
  })
}

test('an initialization failure without lock evidence preserves the original error and is not retried', async () => {
  const original = new Error('schema initialization failed')
  const observe = observations([ready])
  let opens = 0
  await assert.rejects(openListenerGateway(config, { ...observe, openGateway: async () => {
    opens += 1; throw original
  } }), error => error === original)
  assert.equal(opens, 1)
  assert.deepEqual(observe.counts(), { reads: 2, waits: 0 })
})

test('a secondary observation error cannot replace the original initialization failure', async () => {
  const original = new Error('initial failure')
  let reads = 0
  await assert.rejects(openListenerGateway(config, {
    prepareLock: async () => { if (reads++ === 0) return ready; throw new Error('observation failed') },
    openGateway: async () => { throw original },
  }), error => error === original)
})

test('an unusable gateway can never produce an opened result', async () => {
  for (const invalid of [null, undefined, {}, { handle() {} }]) {
    await assert.rejects(openListenerGateway(config, { ...observations([ready]), openGateway: async () => invalid }), /no usable gateway/)
  }
})

test('stale-lock recovery evidence is forwarded without changing the lock protocol', async () => {
  const recoveredFrom = { pid: 123, inode: '45' }
  const seen = []
  await openListenerGateway(config, {
    ...observations([{ ready: true, recoveredFrom }]), openGateway: async () => gateway,
    onRecovered: value => seen.push(value),
  })
  assert.deepEqual(seen, [recoveredFrom])
})

test('invalid observation budgets cannot create an unbounded wait', async () => {
  for (const value of [-1, Infinity, 1.5]) {
    await assert.rejects(settleListenerLock(config.dataPath, { retries: value }), /observation budget/)
  }
})

test('refusal reporting resolves only after the diagnostic write callback', async () => {
  let finish, text, completed = false
  const result = { kind: 'refused', exitCode: 4, diagnostic: { status: 'lock-refused', reason: 'empty-lock' } }
  const writing = reportListenerRefusal(result, { write(value, callback) { text = value; finish = callback } })
    .then(code => { completed = true; return code })
  await Promise.resolve()
  assert.equal(completed, false)
  assert.deepEqual(JSON.parse(text), result.diagnostic)
  assert.ok(text.endsWith('\n'))
  finish()
  assert.equal(await writing, 4)
})

test('a diagnostic write failure is reported rather than claiming the refusal was flushed', async () => {
  const failure = new Error('pipe failed')
  await assert.rejects(reportListenerRefusal({ exitCode: 4, diagnostic: {} }, {
    write(_text, callback) { callback(failure) },
  }), error => error === failure)
})

// Exercise the actual CLI with an installed-layout fake package. The preload substitutes only
// HTTP creation (no sockets) and two exact Linux /proc observations (portable live-owner fixture).
// It also accelerates the 50ms observation delay; production has no test budget option.
async function runCli(t, scenario) {
  const root = await mkdtemp(join(tmpdir(), 'pkw-startup-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile'), dataPath = join(root, 'data')
  const pkg = join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web')
  await mkdir(join(pkg, 'lib/collaboration'), { recursive: true })
  await mkdir(dataPath)
  await writeFile(join(profile, 'package.json'), '{"private":true}\n')
  await writeFile(join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh-pkw-web","type":"module"}\n')
  await writeFile(join(pkg, 'lib/collaboration/index.js'), `
    import { appendFile, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    export class CollaborationGateway {
      static async open(config) {
        await appendFile(join(config.dataPath, 'open-attempts'), 'open\\n')
        const mode = process.env.FIXTURE_SCENARIO
        if (mode.startsWith('claim-')) {
          const content = mode === 'claim-empty' ? '' : mode === 'claim-ownerless' ? '{}' : mode === 'claim-live' ? '{"pid":424242}' : 'not-json'
          await writeFile(join(config.dataPath, 'gateway.lock'), content)
          throw new Error('fixture atomic claim failed')
        }
        if (mode === 'initialization-error') throw new Error('fixture original initialization failure')
        return { handle() {}, async close() { await appendFile(join(config.dataPath, 'closed'), 'close\\n') } }
      }
    }
  `)
  const configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ dataPath, publicOrigin: 'http://127.0.0.1:41234' }))
  const preload = join(root, 'preload.mjs')
  await writeFile(preload, `
    import http from 'node:http'
    import fs from 'node:fs'
    import fsp from 'node:fs/promises'
    import { EventEmitter } from 'node:events'
    import { syncBuiltinESMExports } from 'node:module'
    const stat = fsp.stat, readFile = fsp.readFile
    fsp.stat = async (path, ...args) => path === '/proc/424242' ? {} : stat(path, ...args)
    fsp.readFile = async (path, ...args) => path === '/proc/424242/cmdline' ? 'node\\0serve-collaboration.mjs' : readFile(path, ...args)
    http.createServer = () => {
      fs.appendFileSync(process.env.FIXTURE_SERVER_MARKER, 'created\\n')
      if (!['normal', 'bind-in-use'].includes(process.env.FIXTURE_SCENARIO)) throw new Error('refused CLI created a server')
      const server = new EventEmitter()
      server.listen = (_port, _host, callback) => {
        if (process.env.FIXTURE_SCENARIO === 'bind-in-use') {
          queueMicrotask(() => server.emit('error', Object.assign(new Error('fixture port busy'), { code: 'EADDRINUSE' })))
        } else callback()
        return server
      }
      return server
    }
    syncBuiltinESMExports()
    const timeout = globalThis.setTimeout
    globalThis.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 50 ? 0 : ms, ...args)
  `)
  const initial = scenario === 'initial-empty' ? '' : scenario === 'initial-malformed' ? 'not-json' : null
  if (initial !== null) await writeFile(join(dataPath, 'gateway.lock'), initial)
  const env = { ...process.env, FIXTURE_SCENARIO: scenario, FIXTURE_SERVER_MARKER: join(root, 'server-created') }
  for (const name of ['PKW_TEST_GATE_FILE', 'PKW_TEST_ENTRY_FILE', 'PKW_TEST_LISTENER_EXIT', 'NODE_OPTIONS']) delete env[name]
  const child = spawn(process.execPath, [
    '--import', preload, fileURLToPath(new URL('../serve-collaboration.mjs', import.meta.url)),
    '--profile', profile, '--config', configPath, '--port', '41234',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', timedOut = false, spawnError = null
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 5000)
  const outcome = await new Promise(resolve => {
    child.once('error', error => { spawnError = error })
    // 'exit' can precede the last pipe data. Assert diagnostics only after both pipes close.
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))
  assert.ifError(spawnError)
  assert.equal(timedOut, false, `CLI did not exit: ${stderr}`)
  assert.equal(outcome.signal, null)
  return { root, dataPath, stdout, stderr, ...outcome }
}

for (const [scenario, reason, code, expectedContent, expectedOpens] of [
  ['initial-empty', 'empty-lock', 4, '', 0],
  ['initial-malformed', 'malformed-lock', 4, 'not-json', 0],
  ['claim-empty', 'empty-lock', 4, '', 1],
  ['claim-ownerless', 'lock-without-owner', 4, '{}', 1],
  ['claim-malformed', 'malformed-lock', 4, 'not-json', 1],
  ['claim-live', 'live-writer', 3, '{"pid":424242}', 1],
]) {
  test(`actual CLI: ${scenario} refuses with ${code}, complete diagnostics and no listener`, async t => {
    const result = await runCli(t, scenario)
    assert.equal(result.code, code, result.stderr)
    const lines = result.stderr.trim().split('\n')
    assert.equal(lines.length, 1)
    assert.ok(result.stderr.endsWith('\n'))
    assert.equal(JSON.parse(lines[0]).reason, reason)
    assert.equal(result.stdout, '')
    await assert.rejects(access(join(result.root, 'server-created')), { code: 'ENOENT' })
    assert.equal(await readFile(join(result.dataPath, 'gateway.lock'), 'utf8'), expectedContent)
    const attempts = await readFile(join(result.dataPath, 'open-attempts'), 'utf8').catch(() => '')
    assert.equal(attempts, 'open\n'.repeat(expectedOpens))
  })
}

test('actual CLI: non-lock initialization error remains an error with no listener', async t => {
  const result = await runCli(t, 'initialization-error')
  assert.equal(result.code, 1)
  assert.match(result.stderr, /fixture original initialization failure/)
  assert.doesNotMatch(result.stderr, /lock-refused/)
  assert.equal(result.stdout, '')
  assert.equal(await readFile(join(result.dataPath, 'open-attempts'), 'utf8'), 'open\n')
  await assert.rejects(access(join(result.root, 'server-created')), { code: 'ENOENT' })
})

test('actual CLI: successful gateway creates one listener and reports listening', async t => {
  const result = await runCli(t, 'normal')
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout).status, 'listening')
  assert.equal(await readFile(join(result.root, 'server-created'), 'utf8'), 'created\n')
  assert.equal(await readFile(join(result.dataPath, 'open-attempts'), 'utf8'), 'open\n')
})

test('actual CLI: a bind refusal closes the acquired gateway and flushes its diagnostic', async t => {
  const result = await runCli(t, 'bind-in-use')
  assert.equal(result.code, 3, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(JSON.parse(result.stderr).status, 'bind-refused')
  assert.equal(JSON.parse(result.stderr).reason, 'port-in-use')
  assert.ok(result.stderr.endsWith('\n'))
  assert.equal(await readFile(join(result.dataPath, 'closed'), 'utf8'), 'close\n')
})

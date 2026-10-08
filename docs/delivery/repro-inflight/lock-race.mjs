/**
 * Race two listeners against one data root, repeatedly, and keep what each one said.
 *
 * This is the reproduction behind `Closed item 2` in `docs/delivery/STATUS.md`. The lifecycle test
 * asserts the same thing, but it is one sample per suite run and a flake at roughly one round in
 * fifteen takes many runs to see. Here the round is the unit, the outcome of every round is counted,
 * and a round that does not end the way the protocol says it must prints both processes' own output
 * — which is what turned an unexplained exit-4 into a named cause.
 *
 * What it expects: one process serves (`running`) and the other is refused with
 * `LOCK_EXIT.LIVE_WRITER` (3). Anything else is printed with the winner's lock and both processes'
 * stderr.
 *
 * Usage (needs a PKW profile and a data fixture):
 *   node docs/delivery/repro-inflight/lock-race.mjs <profile> [rounds]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, scrypt } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { copyDataRoot } from '/LlHmm9527/pkw-independent/repo/scripts/copy-data-root.mjs'
const scryptAsync = promisify(scrypt)
const PASSWORD = 'lock-race-pass'
const profile = process.argv[2] ?? process.env.PKW_TEST_PROFILE
const rounds = Number(process.argv[3] ?? 16)
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const results = {}
// The codes the protocol defines, so the summary is readable next to the table in STATUS.md.
const EXPECTED = 3
for (let round = 0; round < rounds; round++) {
  const work = await mkdtemp(join(tmpdir(), 'lock-race-'))
  const root = join(work, 'data')
  await copyDataRoot(process.env.PKW_TEST_DATA_ROOT ?? '/LlHmm9527/pkw-independent/fixtures/lifecycle-1', root)
  const salt = randomBytes(16).toString('hex')
  const derived = await scryptAsync(PASSWORD, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  const id = new DatabaseSync(join(root, 'identity.sqlite'))
  id.prepare('UPDATE accounts SET password=? WHERE username=?').run(`scrypt-v1:${salt}:${derived.toString('hex')}`, 'owner')
  id.close()
  const port = await freePort()
  const configPath = join(root, 'collaboration.json')
  await writeFile(configPath, JSON.stringify({ dataPath: root, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PW' }, null, 2), { mode: 0o600 })
  const start = () => {
    const child = spawn(process.execPath, ['/LlHmm9527/pkw-independent/repo/scripts/serve-collaboration.mjs', '--profile', profile, '--config', configPath, '--port', String(port)], { env: { ...process.env, PW: PASSWORD }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => out += d)
    child.stderr.on('data', d => out += d)
    const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal, out })))
    return { child, exited, get out() { return out } }
  }
  const a = start(); const b = start()
  const bound = ms => new Promise(r => setTimeout(() => r({ code: 'running' }), ms))
  const [ra, rb] = await Promise.all([Promise.race([a.exited, bound(20_000)]), Promise.race([b.exited, bound(20_000)])])
  const codes = [ra.code, rb.code]
  const key = JSON.stringify(codes)
  results[key] = (results[key] ?? 0) + 1
  if (!(codes.includes(EXPECTED) && codes.includes('running'))) {
    console.log(`round ${round}: codes=${key}`)
    console.log('  a:', JSON.stringify(String(ra.out ?? '(no output)').slice(-600)))
    console.log('  b:', JSON.stringify(String(rb.out ?? '(no output)').slice(-600)))
    console.log('  lock:', await readFile(join(root, 'gateway.lock'), 'utf8').catch(e => `unreadable: ${e.code}`))
  }
  a.child.kill('SIGKILL'); b.child.kill('SIGKILL')
  await rm(work, { recursive: true, force: true })
}
console.log('summary', JSON.stringify(results))
const clean = Object.entries(results).filter(([key]) => {
  const codes = JSON.parse(key)
  return codes.includes(EXPECTED) && codes.includes('running')
}).reduce((n, [, count]) => n + count, 0)
console.log(`one writer and one refusal with code ${EXPECTED}: ${clean}/${rounds} rounds`)
process.exit(clean === rounds ? 0 : 1)

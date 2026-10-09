import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { preparePackageManager } from '../../deploy/site/rehearsal-package-manager.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-pm-select-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const work = join(root, 'work'), tool = join(root, "tool ' with spaces")
  await mkdir(work); await mkdir(tool)
  const pnpmBin = join(tool, "pnpm ' entry.mjs")
  await writeFile(pnpmBin, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),executable:process.execPath,pid:process.pid})); process.exitCode=7\n')
  return { root, work, pnpmBin, sourcePackageManager: 'pnpm@11.7.0', pnpmVersion: '11.23.0' }
}
async function missing(path) { await assert.rejects(access(path), { code: 'ENOENT' }) }
function run(command, args, options) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject)
    child.once('close', (code, signal) => done({ code, signal, stdout, stderr, pid: child.pid }))
  })
}

test('package manager default keeps the source pin and does not create a launcher', async t => {
  const f = await fixture(t)
  const result = await preparePackageManager({ work: f.work, sourcePackageManager: f.sourcePackageManager, basePath: '/private/baseline/bin' })
  assert.equal(result.packageManager, 'pnpm@11.7.0')
  assert.equal(result.path, [dirname(process.execPath), '/private/baseline/bin'].join(delimiter))
  assert.equal(result.evidence.mode, 'source-pinned')
  await missing(join(f.work, 'bin'))
})

test('private package manager forwards exact arguments through nested PATH lookup and preserves exit status', async t => {
  const f = await fixture(t)
  const result = await preparePackageManager({ ...f, basePath: '/usr/bin:/bin' })
  const args = ['add', 'a b', "a'b", '$(must-not-run)', '--registry=http://127.0.0.1:1/path?x=one&y=two']
  const nested = await run(process.execPath, ['--input-type=module', '-e', `
    import {spawn} from 'node:child_process';
    const child=spawn('pnpm',JSON.parse(process.argv[1]),{stdio:'inherit'});
    child.once('error',()=>{process.exitCode=99});child.once('exit',code=>{process.exitCode=code});
  `, JSON.stringify(args)], { cwd: f.work, env: { PATH: result.path } })
  assert.equal(nested.code, 7); assert.equal(nested.signal, null); assert.equal(nested.stderr, '')
  assert.deepEqual(JSON.parse(nested.stdout).args, ['--pm-on-fail=error', ...args])
  assert.equal(JSON.parse(nested.stdout).executable, await realpath(process.execPath))
  assert.equal(result.packageManager, 'pnpm@11.23.0')
  assert.equal(result.evidence.sourcePackageManager, 'pnpm@11.7.0')
  assert.equal(result.evidence.pmOnFail, 'error')
  assert.equal(result.path.split(delimiter)[0], join(f.work, 'bin'))
  for (const [path, expected] of [[f.pnpmBin, result.evidence.entrySha256], [result.evidence.launcher, result.evidence.launcherSha256]]) {
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected)
  }
  assert.equal((await lstat(result.evidence.launcher)).mode & 0o777, 0o700)
})

test('private launcher safely quotes a Node path containing spaces and apostrophes', async t => {
  const f = await fixture(t), node = join(f.root, "node ' alias")
  const quoted = "'" + (await realpath(process.execPath)).replaceAll("'", "'\"'\"'") + "'"
  await writeFile(node, `#!/bin/sh\nexec ${quoted} "$@"\n`); await chmod(node, 0o700)
  const selected = await preparePackageManager({ ...f, node })
  const observed = await run('pnpm', ['--version'], { cwd: f.work, env: { PATH: selected.path } })
  assert.equal(observed.code, 7)
  assert.deepEqual(JSON.parse(observed.stdout).args, ['--pm-on-fail=error', '--version'])
})

test('private launcher exec leaves the actual child PID and signal observable', { timeout: 4000 }, async t => {
  const f = await fixture(t)
  await writeFile(f.pnpmBin, 'process.stdout.write(JSON.stringify({pid:process.pid})+"\\n");setInterval(()=>{},1000)\n')
  const selected = await preparePackageManager(f)
  const child = spawn('pnpm', [], { cwd: f.work, env: { PATH: selected.path }, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })) })
  const emergency = setTimeout(() => child.kill('SIGKILL'), 2500)
  t.after(() => { clearTimeout(emergency); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const ready = await new Promise((done, reject) => { child.once('error', reject); child.stdout.once('data', data => done(JSON.parse(data.toString()))) })
  assert.equal(ready.pid, child.pid)
  child.kill('SIGTERM')
  assert.deepEqual(await exited, { code: null, signal: 'SIGTERM' })
})

test('private package manager rejects missing pairs, unknown versions and noncanonical entries before writes', async t => {
  const f = await fixture(t), alias = join(f.root, 'entry-link')
  await symlink(f.pnpmBin, alias)
  for (const options of [
    { ...f, pnpmVersion: undefined }, { ...f, pnpmBin: undefined },
    { ...f, pnpmVersion: '11.7.0' }, { ...f, pnpmVersion: 'latest' },
    { ...f, pnpmBin: 'relative.mjs' }, { ...f, pnpmBin: alias },
    { ...f, pnpmBin: dirname(f.pnpmBin) }, { ...f, sourcePackageManager: 'pnpm@latest' },
  ]) {
    await assert.rejects(preparePackageManager(options), { code: 'PKW_MATRIX_PM' })
    await missing(join(f.work, 'bin'))
  }
})

test('private package manager never overwrites an existing launcher directory', async t => {
  const f = await fixture(t), bin = join(f.work, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'pnpm'), 'precious launcher')
  await assert.rejects(preparePackageManager(f), { code: 'EEXIST' })
  assert.equal(await readFile(join(bin, 'pnpm'), 'utf8'), 'precious launcher')
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp, { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { prepareFirstCutover } from '../../deploy/prepare-first-cutover.mjs'

const name = '@deepseek-ai/dsh-pkw-base', version = '0.1.9-pkw.1', oldVersion = '0.1.7-pkw.1'
const hash = value => createHash('sha256').update(value).digest('hex')
const missing = path => assert.rejects(access(path), { code: 'ENOENT' })
const startupFiles = ['serve-collaboration.mjs', 'listener-startup.mjs', 'root-lock.mjs']
async function put(path, bytes, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes, { mode })
}
function member(path, value) {
  const bytes = Buffer.from(value), header = Buffer.alloc(512)
  header.write(path, 0, 100); header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8)
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12)
  header.write('00000000000\0', 136, 12); header.fill(32, 148, 156)
  header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
  header.write(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}
async function fingerprint(root) {
  const out = {}
  async function walk(path) {
    const st = await lstat(path)
    const value = { mode: st.mode, ino: st.ino, dev: st.dev, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs }
    if (st.isSymbolicLink()) value.target = await readlink(path)
    else if (st.isDirectory()) for (const child of (await readdir(path)).sort()) await walk(join(path, child))
    else value.sha256 = hash(await readFile(path))
    out[relative(root, path)] = value
  }
  await walk(root)
  return out
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-first-prepare-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const matrixRoot = join(root, 'matrix'), artifactDir = join(root, 'artifacts/packages'), workDir = join(root, 'prepared')
  const profile = join(matrixRoot, 'positive/root/releases', version, 'profile')
  const files = new Map([
    ['package.json', Buffer.from(JSON.stringify({ name, version, type: 'module', main: 'lib/index.js' }))],
    ['lib/index.js', Buffer.from('export const artifactVersion = "0.1.9-pkw.1"\n')],
    ['lib/data.bin', Buffer.from([0, 255, 15, 13, 10])],
  ])
  const tarball = gzipSync(Buffer.concat([...files].map(([path, bytes]) => member('package/' + path, bytes)).concat(Buffer.alloc(1024))))
  await put(join(artifactDir, 'base.tgz'), tarball)
  const record = { name, version, sha256: hash(tarball), bytes: tarball.length }
  const receiptPath = join(dirname(artifactDir), 'receipt.json')
  await put(receiptPath, JSON.stringify({ version, artifacts: [record] }))
  for (const [path, bytes] of files) await put(join(profile, 'node_modules', name, path), bytes)
  await put(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager: 'pnpm@11.23.0', dependencies: { [name]: version } }))
  await put(join(profile, '.npmrc'), 'registry=http://127.0.0.1:1\n')
  await put(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  await put(join(profile, 'bin/fixture-tool'), '#!/bin/sh\nexit 0\n', 0o755)
  await put(join(profile, 'private.dat'), Buffer.from([42, 0, 255]), 0o600)
  await chmod(profile, 0o700)
  await chmod(join(profile, 'bin'), 0o750)
  await symlink('../private.dat', join(profile, 'bin/relative-link'))
  await symlink(join(profile, 'private.dat'), join(profile, 'absolute-link'))
  const cases = ['positive', 'breakwrite', 'mode'].map((kind, index) => ({
    kind, work: join(matrixRoot, kind), status: 'verified', ok: true, cleanupConfirmed: true,
    cleanup: { ok: true, confirmed: true, error: null }, lifecycleOk: true,
    execution: { code: index === 0 ? 0 : 1, signal: null, error: null, interrupted: false, timedOut: false,
      groupCleanup: { confirmed: true, known: true, present: false, closed: true } },
  }))
  const matrix = { status: 'three-rehearsals-verified', work: matrixRoot, version, oldVersion, cases, artifacts: { new: [record], old: [] },
    reference: { runnerRoot: join(matrixRoot, 'runner'), basis: 'verified-release-artifacts', version } }
  const matrixPath = join(matrixRoot, 'matrix-report.json')
  await put(matrixPath, JSON.stringify(matrix))
  const protectedPaths = [join(matrixRoot, 'positive/data'), join(matrixRoot, 'positive/collaboration.json'),
    join(root, 'production'), join(root, 'private.env')]
  await put(join(protectedPaths[0], 'identity.sqlite'), 'SQLITE_AND_PRODUCTION_MUST_NOT_BE_OPENED')
  await put(join(protectedPaths[0], 'spaces/sp1/state.sqlite'), 'SQLITE_AND_PRODUCTION_MUST_NOT_BE_OPENED')
  await put(protectedPaths[1], '{"password":"SECRET_CONFIG_CANARY"}')
  await put(join(protectedPaths[2], 'current-profile'), 'PRODUCTION_CANARY')
  await put(protectedPaths[3], 'SECRET_ENV_CANARY')
  const runtime = [], runners = []
  const options = { workDir, matrixRoot, artifactDir, version, checkout: join(root, 'checkout'), node: process.execPath }
  await mkdir(options.checkout)
  for (const script of startupFiles) {
    const bytes = '// synthetic startup closure ' + script + '\n'
    await put(join(options.checkout, 'scripts', script), bytes)
    await put(join(matrixRoot, 'runner/scripts', script), bytes)
  }
  const hooks = {
    expectedNames: [name],
    async createRunner(checkout, target, artifacts) {
      runners.push({ checkout, target, artifacts })
      await mkdir(target, { mode: 0o700 })
      for (const script of startupFiles) await put(join(target, 'scripts', script), await readFile(join(checkout, 'scripts', script)))
      return { runnerRoot: target, basis: 'verified-release-artifacts', version, packages: artifacts.map(({ name, sha256 }) => ({ name, artifactSha256: sha256 })) }
    },
    async checkRuntime(input) { runtime.push(input); return { ok: true } },
  }
  return { root, matrixRoot, artifactDir, workDir, profile, matrix, matrixPath, receiptPath, record, files, options, hooks, runtime, runners, protectedPaths }
}
async function guardedReads(paths, action) {
  const attempted = [], undo = []
  const protectedPath = value => {
    if (value instanceof URL) value = value.pathname
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) return false
    const absolute = resolve(value.toString())
    return paths.some(path => absolute === path || absolute.startsWith(path + sep))
  }
  for (const [object, keys] of [[fsp, ['open', 'readFile', 'readdir']], [fs, ['openSync', 'readFileSync', 'readdirSync']]]) {
    for (const key of keys) {
      const original = object[key]
      object[key] = function (path, ...args) {
        if (protectedPath(path)) {
          attempted.push(String(path))
          throw Object.assign(new Error('forbidden private input read'), { code: 'TEST_PRIVATE_READ' })
        }
        return original.call(this, path, ...args)
      }
      undo.push(() => { object[key] = original })
    }
  }
  syncBuiltinESMExports()
  try { return { value: await action(), attempted } }
  finally { for (const restore of undo) restore(); syncBuiltinESMExports() }
}

test('first preparation copies only the verified candidate, preserves source and creates drafts without activation', async t => {
  const f = await fixture(t), sourceBefore = await fingerprint(f.matrixRoot), artifactsBefore = await fingerprint(dirname(f.artifactDir))
  const protectedRoots = [...f.protectedPaths, '/root/.dsh', '/opt/deepseek-harness', '/opt/dsh-releases', '/etc/systemd/system', '/root/pkw-upgrade-2026-10-02']
  const { value: report, attempted } = await guardedReads(protectedRoots, () => prepareFirstCutover(f.options, f.hooks))
  assert.equal(report.status, 'PREPARED_NOT_ACTIVATED')
  assert.deepEqual(attempted, [])
  assert.deepEqual(await fingerprint(f.matrixRoot), sourceBefore)
  assert.deepEqual(await fingerprint(dirname(f.artifactDir)), artifactsBefore)
  const target = join(f.workDir, 'releases', version, 'profile')
  for (const [path, bytes] of f.files) assert.deepEqual(await readFile(join(target, 'node_modules', name, path)), bytes)
  assert.equal((await lstat(target)).mode & 0o777, 0o700)
  assert.equal((await lstat(join(target, 'bin'))).mode & 0o777, 0o750)
  assert.equal((await lstat(join(target, 'bin/fixture-tool'))).mode & 0o777, 0o755)
  assert.equal((await lstat(join(target, 'private.dat'))).mode & 0o777, 0o600)
  assert.notEqual((await lstat(join(target, 'private.dat'))).ino, (await lstat(join(f.profile, 'private.dat'))).ino)
  assert.equal(await realpath(join(target, 'absolute-link')), join(target, 'private.dat'))
  assert.equal(await realpath(join(target, 'bin/relative-link')), join(target, 'private.dat'))
  assert.equal(await readlink(join(f.profile, 'absolute-link')), join(f.profile, 'private.dat'))
  assert.equal(f.runtime.length, 1)
  assert.equal(f.runtime[0].profile, target)
  assert.equal(f.runners.length, 1)
  await missing(join(f.workDir, 'current'))
  await missing(join(f.workDir, 'data'))
  await missing(join(f.workDir, 'collaboration.json'))
  assert.equal((await lstat(join(f.workDir, 'drafts/50-pkw-independent.conf'))).isFile(), true)
  assert.equal(JSON.parse(await readFile(join(f.workDir, 'preparation-report.json'))).status, report.status)
  assert.doesNotMatch(JSON.stringify(report), /SECRET_CONFIG_CANARY|SECRET_ENV_CANARY|PRODUCTION_CANARY/)
})

test('first preparation refuses any existing destination without clearing it', async t => {
  const f = await fixture(t)
  await put(join(f.workDir, 'precious.txt'), 'keep')
  const before = await fingerprint(f.workDir)
  await assert.rejects(prepareFirstCutover(f.options, f.hooks))
  assert.deepEqual(await fingerprint(f.workDir), before)
  await rm(f.workDir, { recursive: true })
  await symlink(f.profile, f.workDir)
  await assert.rejects(prepareFirstCutover(f.options, f.hooks))
  assert.equal(await readlink(f.workDir), f.profile)
  assert.equal(f.runtime.length, 0)
  assert.equal(f.runners.length, 0)
})

test('matrix success requires every case and execution cleanup, not just the top-level label', async t => {
  const f = await fixture(t)
  for (const alter of [
    matrix => { matrix.status = 'stopped' },
    matrix => { matrix.cases.pop() },
    matrix => { matrix.cases[1].kind = 'positive' },
    matrix => { matrix.cases[0].cleanupConfirmed = false },
    matrix => { matrix.cases[0].cleanup.ok = false },
    matrix => { matrix.cases[0].execution.groupCleanup.confirmed = false },
    matrix => { matrix.cases[0].execution.timedOut = true },
    matrix => { matrix.cases[0].execution.code = 1 },
  ]) {
    const matrix = structuredClone(f.matrix); alter(matrix)
    await writeFile(f.matrixPath, JSON.stringify(matrix))
    await assert.rejects(prepareFirstCutover(f.options, f.hooks))
    await missing(f.workDir)
  }
  assert.equal(f.runtime.length, 0)
  assert.equal(f.runners.length, 0)
})

test('matrix artifact digest, receipt and installed payload must describe the same release', async t => {
  const f = await fixture(t)
  const badMatrix = structuredClone(f.matrix); badMatrix.artifacts.new[0].sha256 = '0'.repeat(64)
  await writeFile(f.matrixPath, JSON.stringify(badMatrix))
  await assert.rejects(prepareFirstCutover(f.options, f.hooks)); await missing(f.workDir)
  await writeFile(f.matrixPath, JSON.stringify(f.matrix))
  await writeFile(f.receiptPath, JSON.stringify({ version, artifacts: [{ ...f.record, sha256: '0'.repeat(64) }] }))
  await assert.rejects(prepareFirstCutover(f.options, f.hooks)); await missing(f.workDir)
  await writeFile(f.receiptPath, JSON.stringify({ version, artifacts: [f.record] }))
  await writeFile(join(f.profile, 'node_modules', name, 'lib/index.js'), 'unverified source code')
  await assert.rejects(prepareFirstCutover(f.options, f.hooks)); await missing(f.workDir)
  assert.equal(f.runtime.length, 0)
})

test('profile links that escape the candidate are refused without reading their target', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside-secret')
  await put(outside, 'NEVER_COPY_OR_READ_EXTERNAL_LINK')
  await symlink(outside, join(f.profile, 'external-link'))
  const before = await fingerprint(f.profile)
  const result = await guardedReads([outside], async () => {
    await assert.rejects(prepareFirstCutover(f.options, f.hooks))
  })
  assert.deepEqual(result.attempted, [])
  assert.deepEqual(await fingerprint(f.profile), before)
  assert.equal(await readFile(outside, 'utf8'), 'NEVER_COPY_OR_READ_EXTERNAL_LINK')
  assert.equal(f.runtime.length, 0)
  await missing(join(f.workDir, 'current'))
})

test('runtime rejection retains copied evidence and never reports a prepared or activated release', async t => {
  const f = await fixture(t), before = await fingerprint(f.profile)
  f.hooks.checkRuntime = async input => { f.runtime.push(input); throw Object.assign(new Error('synthetic runtime import refusal'), { code: 'TEST_RUNTIME_REFUSED' }) }
  await assert.rejects(prepareFirstCutover(f.options, f.hooks))
  const report = JSON.parse(await readFile(join(f.workDir, 'preparation-report.json')))
  assert.equal(report.status, 'PREPARATION_STOPPED')
  assert.equal((await lstat(join(f.workDir, 'releases', version, 'profile'))).isDirectory(), true)
  assert.deepEqual(await fingerprint(f.profile), before)
  await missing(join(f.workDir, 'current'))
  assert.equal(f.runtime.length, 1)
})

test('startup scripts must match the passed matrix and remain unchanged through runtime inspection', async t => {
  const f = await fixture(t)
  const script = join(f.options.checkout, 'scripts/serve-collaboration.mjs')
  const original = await readFile(script)
  await writeFile(script, '// changed after rehearsal\n')
  await assert.rejects(prepareFirstCutover(f.options, f.hooks))
  await missing(f.workDir)
  assert.equal(f.runtime.length, 0)
  await writeFile(script, original)
  f.hooks.checkRuntime = async input => {
    f.runtime.push(input)
    await put(join(f.workDir, 'releases', version, 'runner/scripts/late-mutation.mjs'), 'export const changed = true\n')
    return { ok: true }
  }
  await assert.rejects(prepareFirstCutover(f.options, f.hooks))
  const report = JSON.parse(await readFile(join(f.workDir, 'preparation-report.json')))
  assert.equal(report.status, 'PREPARATION_STOPPED')
  assert.equal(f.runtime.length, 1)
  await missing(join(f.workDir, 'current'))
})

test('runtime inspection cannot silently change a candidate file outside the PKW artifact payload', async t => {
  const f = await fixture(t), before = await fingerprint(f.profile)
  f.hooks.checkRuntime = async input => {
    f.runtime.push(input)
    await writeFile(join(input.profile, 'private.dat'), 'changed peer or profile input')
    return { ok: true }
  }
  await assert.rejects(prepareFirstCutover(f.options, f.hooks), { code: 'PKW_PREPARE_DRIFT' })
  const report = JSON.parse(await readFile(join(f.workDir, 'preparation-report.json')))
  assert.equal(report.status, 'PREPARATION_STOPPED')
  assert.deepEqual(await fingerprint(f.profile), before)
  assert.equal(await readFile(join(f.workDir, 'releases', version, 'profile/private.dat'), 'utf8'), 'changed peer or profile input')
  await missing(join(f.workDir, 'current'))
  await missing(join(f.workDir, 'drafts/50-pkw-independent.conf'))
})

test('an interrupt after runtime success retains the scene without preparing activation drafts', async t => {
  const f = await fixture(t), controller = new AbortController(), before = await fingerprint(f.profile)
  f.options.signal = controller.signal
  f.hooks.checkRuntime = async input => {
    f.runtime.push(input)
    controller.abort()
    return { ok: true }
  }
  await assert.rejects(prepareFirstCutover(f.options, f.hooks), { code: 'PKW_PREPARE_INTERRUPTED' })
  const report = JSON.parse(await readFile(join(f.workDir, 'preparation-report.json')))
  assert.equal(report.status, 'PREPARATION_STOPPED')
  assert.equal(report.error.code, 'PKW_PREPARE_INTERRUPTED')
  assert.equal(report.sceneRetained, true)
  assert.equal(f.runtime.length, 1)
  assert.equal((await lstat(join(f.workDir, 'releases', version, 'profile'))).isDirectory(), true)
  assert.deepEqual(await fingerprint(f.profile), before)
  await missing(join(f.workDir, 'current'))
  await missing(join(f.workDir, 'drafts/50-pkw-independent.conf'))
})

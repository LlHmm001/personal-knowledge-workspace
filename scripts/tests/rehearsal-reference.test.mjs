import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { readReleaseArtifacts, readArtifactFiles } from '../../deploy/site/rehearsal-artifacts.mjs'
import { createArtifactRunner } from '../../deploy/site/rehearsal-reference.mjs'

const name = '@deepseek-ai/dsh-pkw-base', version = '0.1.9-pkw.1'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const invalid = { code: 'PKW_REHEARSAL_REFERENCE_INVALID' }
const repo = fileURLToPath(new URL('../../', import.meta.url))

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

async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function tree(root) {
  const result = {}
  async function walk(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name), key = relative + entry.name, info = await lstat(child)
      result[key] = { mode: info.mode & 0o777, mtime: info.mtimeMs, size: info.size }
      if (entry.isDirectory()) { delete result[key].size; delete result[key].mtime; await walk(child, key + '/') }
      else result[key].sha256 = hash(await readFile(child))
    }
  }
  await walk(root)
  return result
}

async function fixture(t, { lib = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-reference-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const checkout = join(root, 'checkout'), packageRoot = join(checkout, 'packages/pkw/base')
  await put(join(checkout, 'package.json'), JSON.stringify({ name: 'pkw-test-checkout', type: 'module' }))
  await put(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '0.1.0', type: 'module', main: 'lib/index.js' }))
  await put(join(packageRoot, 'src/index.ts'), '// source is intentionally not compiled by this helper\n')
  await put(join(checkout, 'scripts/runner.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(checkout, 'scripts/runner.sh'), 0o755)
  await copyFile(join(repo, 'scripts/check-runtime-imports.mjs'), join(checkout, 'scripts/check-runtime-imports.mjs'))
  const dir = join(root, 'release/packages')
  await mkdir(dir, { recursive: true })
  const files = new Map([['package.json', Buffer.from(JSON.stringify({ name, version, type: 'module', main: 'lib/index.js' }))]])
  if (lib) {
    files.set('lib/index.js', Buffer.from('export const verifiedArtifact = 42\n'))
    files.set('lib/nested/data.bin', Buffer.from([0, 255, 1, 13, 10]))
  }
  const archive = gzipSync(Buffer.concat([...files].map(([path, bytes]) => member('package/' + path, bytes)).concat(Buffer.alloc(1024))))
  const tarball = join(dir, 'base.tgz')
  await writeFile(tarball, archive)
  await writeFile(join(root, 'release/receipt.json'), JSON.stringify({ version, artifacts: [{ name, version, sha256: hash(archive) }] }))
  const artifacts = await readReleaseArtifacts(dir, version, [name])
  return { root, checkout, packageRoot, artifacts, tarball, files, target: join(root, 'runner') }
}

test('clean source checkout builds a byte-exact artifact reference and runtime comparison passes', async t => {
  const f = await fixture(t), before = await tree(f.checkout), originalTar = await readFile(f.tarball)
  await assert.rejects(access(join(f.packageRoot, 'lib')), { code: 'ENOENT' })
  const report = await createArtifactRunner(f.checkout, f.target, f.artifacts)
  assert.equal(report.runnerRoot, f.target); assert.equal(report.compiled, false)
  assert.equal(report.basis, 'verified-release-artifacts'); assert.equal(report.version, version)
  assert.equal(report.packages[0].artifactSha256, hash(originalTar)); assert.equal(report.packages[0].libFiles, 2)
  for (const [path, bytes] of f.files) if (path.startsWith('lib/')) assert.deepEqual(await readFile(join(f.target, 'packages/pkw/base', path)), bytes)
  assert.equal(JSON.parse(await readFile(join(f.target, 'packages/pkw/base/package.json'))).version, '0.1.0')
  assert.deepEqual(await tree(f.checkout), before); assert.deepEqual(await readFile(f.tarball), originalTar)
  assert.equal((await lstat(f.target)).mode & 0o777, 0o700)
  assert.equal((await lstat(join(f.target, 'scripts/runner.sh'))).mode & 0o777, 0o755)
  assert.deepEqual(JSON.parse(await readFile(join(f.target, '.pkw-artifact-reference.json'))), report)

  const profile = join(f.root, 'profile')
  await put(join(profile, 'package.json'), '{}')
  for (const [path, bytes] of (await readArtifactFiles(f.artifacts[0])).files) await put(join(profile, 'node_modules', name, path), bytes)
  const output = execFileSync(process.execPath, [join(f.target, 'scripts/check-runtime-imports.mjs'), '--profile', profile, '--version', version], { encoding: 'utf8', timeout: 10_000 })
  assert.match(output, /artifact match \+ Node import/)
})

test('existing generated directories are omitted and stale lib is replaced only in the fresh runner', async t => {
  const f = await fixture(t)
  for (const path of ['.git/config', 'node_modules/ignored/index.js', '.pkw-secret/token', 'lib/stale.js', 'packages/pkw/base/lib/stale.js', 'scripts/node_modules/ignored.js']) await put(join(f.checkout, path), 'preserved source bytes')
  const before = await tree(f.checkout)
  await createArtifactRunner(f.checkout, f.target, f.artifacts)
  for (const path of ['.git', 'node_modules', '.pkw-secret', 'lib', 'packages/pkw/base/lib/stale.js', 'scripts/node_modules']) await assert.rejects(access(join(f.target, path)), { code: 'ENOENT' })
  assert.deepEqual(await tree(f.checkout), before)
})

test('any existing target is refused without clearing its files', async t => {
  const f = await fixture(t)
  await put(join(f.target, 'precious.txt'), 'keep')
  const before = await tree(f.target)
  await assert.rejects(createArtifactRunner(f.checkout, f.target, f.artifacts), invalid)
  assert.deepEqual(await tree(f.target), before)
  await rm(f.target, { recursive: true })
  await symlink(f.checkout, f.target)
  await assert.rejects(createArtifactRunner(f.checkout, f.target, f.artifacts), invalid)
  assert.equal((await lstat(f.target)).isSymbolicLink(), true)
})

test('overlap and aliased destination parents are refused before creating a runner', async t => {
  const f = await fixture(t)
  await assert.rejects(createArtifactRunner(f.checkout, join(f.checkout, 'runner'), f.artifacts), invalid)
  await symlink(f.root, join(f.root, 'alias'))
  await assert.rejects(createArtifactRunner(f.checkout, join(f.root, 'alias/runner'), f.artifacts), invalid)
  await assert.rejects(access(f.target), { code: 'ENOENT' })
})

test('artifact mutation and missing package coverage fail before the ownership boundary', async t => {
  const f = await fixture(t)
  await assert.rejects(createArtifactRunner(f.checkout, f.target, []), invalid)
  await assert.rejects(createArtifactRunner(f.checkout, f.target, [{ ...f.artifacts[0], name: '@deepseek-ai/dsh-pkw-wrong' }]), invalid)
  await writeFile(f.tarball, 'changed artifact')
  await assert.rejects(createArtifactRunner(f.checkout, f.target, f.artifacts), { code: 'PKW_REHEARSAL_ARTIFACT_INVALID' })
  await assert.rejects(access(f.target), { code: 'ENOENT' })
})

test('missing runtime lib in a valid artifact is refused without fabricating outputs', async t => {
  const f = await fixture(t, { lib: false })
  await assert.rejects(createArtifactRunner(f.checkout, f.target, f.artifacts), error => error.code === invalid.code && /lib\/index.js/.test(error.message))
  await assert.rejects(access(f.target), { code: 'ENOENT' })
})

test('non-excluded source symlinks are refused and the failed runner remains inspectable', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.txt')
  await writeFile(outside, 'never copy this linked content')
  await symlink(outside, join(f.checkout, 'linked-source'))
  await assert.rejects(createArtifactRunner(f.checkout, f.target, f.artifacts), invalid)
  assert.equal((await lstat(f.target)).isDirectory(), true)
  assert.equal(await readFile(outside, 'utf8'), 'never copy this linked content')
  await assert.rejects(access(join(f.target, 'linked-source')), { code: 'ENOENT' })
  await assert.rejects(access(join(f.target, '.pkw-artifact-reference.json')), { code: 'ENOENT' })
})

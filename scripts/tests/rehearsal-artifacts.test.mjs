import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, copyFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { readReleaseArtifacts, verifyArtifactPayload } from '../../deploy/site/rehearsal-artifacts.mjs'

const name = '@deepseek-ai/dsh-pkw-base', version = '0.1.7-pkw.1'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const invalid = { code: 'PKW_REHEARSAL_ARTIFACT_INVALID' }

function member(path, data = '', type = '0') {
  const bytes = Buffer.from(data), header = Buffer.alloc(512)
  header.write(path, 0, 100)
  header.write('0000644\0', 100, 8)
  header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8)
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12)
  header.write('00000000000\0', 136, 12)
  header.fill(32, 148, 156); header.write(type, 156, 1)
  header.write('ustar\0', 257, 6); header.write('00', 263, 2)
  const sum = header.reduce((a, b) => a + b, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}
const manifest = (packageName = name, packageVersion = version) => member('package/package.json', JSON.stringify({ name: packageName, version: packageVersion, main: 'lib/index.js' }))
const tar = members => gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]))
function pax(key, value) {
  const content = `${key}=${value}\n`
  let length = Buffer.byteLength(content) + 2
  while (Buffer.byteLength(`${length} ${content}`) !== length) length = Buffer.byteLength(`${length} ${content}`)
  return `${length} ${content}`
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-artifact-gate-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'packages'), packageDir = join(dir, 'dsh-pkw-base'), receiptPath = join(root, 'receipt.json')
  await mkdir(packageDir, { recursive: true })
  async function put(bytes, record = {}) {
    const path = join(packageDir, 'base.tgz')
    await writeFile(path, bytes)
    await writeFile(receiptPath, JSON.stringify({ version, registry: 'PRIVATE_RECEIPT_SECRET', artifacts: [{ name, version, sha256: hash(bytes), ...record }] }))
    return path
  }
  await put(tar([manifest(), member('package/lib/index.js', 'export const old = true\n')]))
  return { root, dir, packageDir, receiptPath, put, read: () => readReleaseArtifacts(dir, version, [name]) }
}

test('real npm tarball is verified without receipt bytes and payload is unchanged', async t => {
  const f = await fixture(t), source = join(f.root, 'source')
  await mkdir(join(source, 'lib'), { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name, version, files: ['lib'], main: 'lib/index.js' }))
  await writeFile(join(source, 'lib/index.js'), 'export const old = true\n')
  await writeFile(join(f.root, 'empty.npmrc'), '')
  execFileSync('npm', ['pack', '--ignore-scripts', '--quiet', '--offline'], {
    cwd: source, stdio: 'pipe', timeout: 30_000,
    env: { ...process.env, npm_config_cache: join(f.root, 'npm-cache'), npm_config_userconfig: join(f.root, 'empty.npmrc'), npm_config_update_notifier: 'false' },
  })
  const produced = (await readdir(source)).find(file => file.endsWith('.tgz'))
  const bytes = await readFile(join(source, produced)), path = await f.put(bytes)
  const items = await f.read()
  assert.equal(items.length, 1); assert.equal(items[0].sha256, hash(bytes)); assert.equal(items[0].bytes, bytes.length)
  assert.equal(JSON.stringify(items).includes('PRIVATE_RECEIPT_SECRET'), false)
  const profile = join(f.root, 'profile'), target = join(profile, 'node_modules', name)
  await mkdir(target, { recursive: true })
  execFileSync('tar', ['-xzf', path, '--strip-components=1', '-C', target])
  const report = await verifyArtifactPayload(profile, items)
  assert.equal(report.ok, true); assert.ok(report.packages[0].files >= 2)
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, version)
  assert.deepEqual(await readFile(path), bytes)
})

test('receipt is checked first and requires version, complete records and SHA256', async t => {
  const f = await fixture(t)
  for (const receipt of [null, {}, { version: 'wrong', artifacts: [] }, { version, artifacts: [] }, { version, artifacts: [{ name, version }] }, { version, artifacts: [{ name, version, sha256: 'x'.repeat(64) }] }]) {
    await writeFile(f.receiptPath, JSON.stringify(receipt))
    await assert.rejects(f.read(), invalid)
  }
  await writeFile(f.receiptPath, '{SECRET NOT JSON')
  await assert.rejects(f.read(), error => error.code === invalid.code && !error.message.includes('SECRET'))
})

test('receipt SHA or optional byte count mismatch refuses unchanged tarball', async t => {
  const f = await fixture(t), bytes = tar([manifest()])
  await f.put(bytes, { sha256: '0'.repeat(64) }); await assert.rejects(f.read(), invalid)
  await f.put(bytes, { bytes: bytes.length + 1 }); await assert.rejects(f.read(), invalid)
  await f.put(bytes, { bytes: bytes.length }); assert.equal((await f.read()).length, 1)
})

test('duplicate receipt records and additional PKW versions are refused', async t => {
  const f = await fixture(t), receipt = JSON.parse(await readFile(f.receiptPath, 'utf8'))
  receipt.artifacts.push({ ...receipt.artifacts[0] })
  await writeFile(f.receiptPath, JSON.stringify(receipt)); await assert.rejects(f.read(), invalid)
  receipt.artifacts[1].version = '0.1.9-pkw.1'
  await writeFile(f.receiptPath, JSON.stringify(receipt)); await assert.rejects(f.read(), invalid)
})

test('directory duplicate, missing, wrong-version and unexpected PKW packages are refused', async t => {
  const f = await fixture(t), original = join(f.packageDir, 'base.tgz')
  await copyFile(original, join(f.packageDir, 'duplicate.tgz')); await assert.rejects(f.read(), invalid)
  await rm(join(f.packageDir, 'duplicate.tgz'))
  await rm(original); await assert.rejects(f.read(), invalid)
  await f.put(tar([manifest(name, '0.1.9-pkw.1')])); await assert.rejects(f.read(), invalid)
  await f.put(tar([manifest('@deepseek-ai/dsh-pkw-surprise')])); await assert.rejects(f.read(), invalid)
})

test('non-PKW support tarballs do not enter the verified release', async t => {
  const f = await fixture(t)
  await writeFile(join(f.packageDir, 'peer.tgz'), tar([manifest('@deepseek-ai/cordis', '4.0.0')]))
  assert.deepEqual((await f.read()).map(item => item.name), [name])
})

test('tar member traversal, absolute paths, links, special members and duplicates are refused', async t => {
  const f = await fixture(t)
  const bad = [
    member('package/../outside', 'x'), member('/package/outside', 'x'), member('package//bad', 'x'),
    member('package/link', '', '2'), member('package/hard', '', '1'), member('package/fifo', '', '6'),
    member('package/device', '', '3'), member('package/package.json', '{}'),
    Buffer.concat([member('package/file', 'x'), member('package/file/child', 'y')]),
  ]
  for (const entry of bad) {
    await f.put(tar([manifest(), entry]))
    await assert.rejects(f.read(), invalid)
  }
})

test('PAX paths and GNU long names are supported but cannot escape package', async t => {
  const f = await fixture(t), long = `package/lib/${'a'.repeat(110)}.js`
  await f.put(tar([manifest(), member('PaxHeader', pax('path', long), 'x'), member('placeholder', 'old')]))
  assert.equal((await f.read()).length, 1)
  await f.put(tar([manifest(), member('././@LongLink', long + '\0', 'L'), member('placeholder', 'old')]))
  assert.equal((await f.read()).length, 1)
  await f.put(tar([manifest(), member('PaxHeader', pax('path', 'package/../../escape'), 'x'), member('placeholder', 'bad')]))
  await assert.rejects(f.read(), invalid)
})

test('bad tar checksum and incomplete end markers are refused', async t => {
  const f = await fixture(t), broken = manifest(); broken[0] = 0
  await f.put(tar([broken])); await assert.rejects(f.read(), invalid)
  await f.put(gzipSync(manifest())); await assert.rejects(f.read(), invalid)
})

test('symlink tarball and symlink receipt are refused', async t => {
  const f = await fixture(t), path = join(f.packageDir, 'base.tgz'), saved = join(f.root, 'saved.tgz')
  await copyFile(path, saved); await rm(path); await symlink(saved, path)
  await assert.rejects(f.read(), invalid)
  await rm(path); await copyFile(saved, path)
  const receiptCopy = join(f.root, 'receipt-copy.json')
  await copyFile(f.receiptPath, receiptCopy); await rm(f.receiptPath); await symlink(receiptCopy, f.receiptPath)
  await assert.rejects(f.read(), invalid)
})

test('payload mismatch or artifact changed after inventory cannot pass', async t => {
  const f = await fixture(t), items = await f.read(), profile = join(f.root, 'profile'), target = join(profile, 'node_modules', name)
  await mkdir(target, { recursive: true })
  execFileSync('tar', ['-xzf', items[0].tarball, '--strip-components=1', '-C', target])
  await writeFile(join(target, 'lib/index.js'), 'newer code')
  await assert.rejects(verifyArtifactPayload(profile, items), invalid)
  await f.put(tar([manifest(), member('package/lib/index.js', 'altered')]))
  await assert.rejects(verifyArtifactPayload(profile, items), invalid)
})

test('installed payload links outside profile are refused', async t => {
  const f = await fixture(t), items = await f.read(), profile = join(f.root, 'profile'), target = join(profile, 'node_modules', name)
  await mkdir(target, { recursive: true })
  execFileSync('tar', ['-xzf', items[0].tarball, '--strip-components=1', '-C', target])
  const outside = join(f.root, 'outside.js')
  await copyFile(join(target, 'lib/index.js'), outside)
  await rm(join(target, 'lib/index.js')); await symlink(outside, join(target, 'lib/index.js'))
  await assert.rejects(verifyArtifactPayload(profile, items), invalid)
})

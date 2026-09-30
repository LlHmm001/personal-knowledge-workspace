import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { activate, checkUiReview, restoreProfile, snapshotProfile, validateRegistry, validateVersion, verifyHttp } from '../deployment.mjs'
import { harnessConfig } from '../harness-config.mjs'

const dirs = []
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }) })
async function temporary() { const dir = await mkdtemp(join(tmpdir(), 'pkw-tooling-')); dirs.push(dir); return dir }

test('Harness override preserves repo-relative PKW paths and the default deployment seam', () => {
  const original = harnessConfig('tsconfig.json', {})
  const overridden = harnessConfig('tsconfig.json', { DSH_HARNESS_ROOT: '/tmp/custom harness' })
  assert.match(original.compilerOptions.paths['@deepseek-ai/cordis'][0], /^\/opt\/deepseek-harness\//)
  assert.match(overridden.compilerOptions.paths['@deepseek-ai/cordis'][0], /^\/tmp\/custom harness\//)
  assert.deepEqual(original.compilerOptions.paths['@deepseek-ai/dsh-pkw-domain'], overridden.compilerOptions.paths['@deepseek-ai/dsh-pkw-domain'])
  assert.throws(() => harnessConfig('tsconfig.json', { DSH_HARNESS_ROOT: '../harness' }))
})

test('release configuration refuses public registries, URL credentials and invalid versions', () => {
  assert.equal(validateRegistry('http://localhost:4873/'), 'http://localhost:4873')
  for (const url of ['https://registry.npmjs.org', 'http://user:secret@localhost:4873', 'file:///tmp/registry']) assert.throws(() => validateRegistry(url))
  assert.equal(validateVersion('0.1.1-pkw.1'), '0.1.1-pkw.1')
  for (const version of ['latest', '../escape', '0.1', 'v0.1.1', undefined]) assert.throws(() => validateVersion(version))
})

test('profile rollback restores exact installation files and links without touching canonical data', async () => {
  const dir = await temporary()
  const profile = join(dir, 'profile')
  const backup = join(dir, 'backup')
  await mkdir(join(profile, 'node_modules/pkg'), { recursive: true })
  await mkdir(join(profile, 'notes'))
  await writeFile(join(profile, 'package.json'), '{"version":"old"}')
  await writeFile(join(profile, '.npmrc'), 'configuration kept locally')
  await writeFile(join(profile, 'node_modules/pkg/index.js'), 'old artifact')
  await symlink('pkg', join(profile, 'node_modules/linked'))
  await writeFile(join(profile, 'notes/note.md'), '# Canonical')
  await snapshotProfile(profile, backup)
  await writeFile(join(profile, 'package.json'), '{"version":"new"}')
  await writeFile(join(profile, 'package-lock.json'), 'newly introduced')
  await writeFile(join(profile, 'node_modules/pkg/index.js'), 'new artifact')
  await restoreProfile(profile, backup)
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), '{"version":"old"}')
  assert.equal(await readFile(join(profile, 'node_modules/linked/index.js'), 'utf8'), 'old artifact')
  assert.equal(await readFile(join(profile, '.npmrc'), 'utf8'), 'configuration kept locally')
  assert.equal(await readFile(join(profile, 'notes/note.md'), 'utf8'), '# Canonical')
  await assert.rejects(readFile(join(profile, 'package-lock.json')), { code: 'ENOENT' })
})

test('UI patch review gate rejects a missing installed artifact', async () => {
  await assert.rejects(checkUiReview(await temporary()), /Existing profile PKW/)
})

test('a partial install failure restores the old profile and verifies it after restarting', async () => {
  const dir = await temporary()
  const profile = join(dir, 'profile')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), '{"version":"old"}')
  await writeFile(join(profile, 'node_modules/original'), 'original bytes')
  const server = createServer((req, res) => {
    res.end(req.url === '/pkw' ? '<title>PKW — Personal Knowledge Workspace</title>' : JSON.stringify({ ok: true, value: { workspaceId: 'old', notes: 1, attachments: 1 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const calls = []
  const execute = async command => {
    calls.push(command)
    if (command === 'pnpm') {
      await writeFile(join(profile, 'package.json'), '{"version":"partial"}')
      await rm(join(profile, 'node_modules/original'))
      throw new Error('simulated interrupted install')
    }
  }
  try {
    await assert.rejects(activate({ profile, backup: join(dir, 'backup'), artifacts: [{ name: '@deepseek-ai/dsh-pkw-web', version: '0.1.1' }], registry: 'http://localhost:4873', stop: '/hooks/stop', start: '/hooks/start', url: `http://127.0.0.1:${server.address().port}`, beforeHost: {} }, execute), /prior profile restored and verified/)
    assert.deepEqual(calls, ['/hooks/stop', 'pnpm', '/hooks/stop', '/hooks/start'])
    assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), '{"version":"old"}')
    assert.equal(await readFile(join(profile, 'node_modules/original'), 'utf8'), 'original bytes')
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('post-restart probe checks the page AND successful business RPC, not just HTTP 200', async () => {
  let mode = 'fallback'
  let servingVersion = 'old'
  let rpcRequest
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', req.url === '/pkw' ? 'text/html' : 'application/json')
    if (req.url === '/pkw') {
      res.setHeader('X-PKW-Version', servingVersion)
      res.end(mode === 'fallback' ? '<title>Host shell</title>' : '<title>PKW — Personal Knowledge Workspace</title>')
    } else {
      let body = ''
      for await (const chunk of req) body += chunk
      rpcRequest = JSON.parse(body)
      res.end(JSON.stringify(mode === 'error' ? { ok: false } : { ok: true, value: { workspaceId: 'ws-test', notes: 2, attachments: 1 } }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}`
    await assert.rejects(verifyHttp(url, 1), /post-restart verification failed/)
    mode = 'error'
    await assert.rejects(verifyHttp(url, 1), /post-restart verification failed/)
    mode = 'success'
    assert.equal((await verifyHttp(url, 1)).summaryRpc, 'passed')
    await assert.rejects(verifyHttp(url, 1, '0.1.1-test'), /post-restart verification failed/)
    servingVersion = '0.1.1-test'
    assert.equal((await verifyHttp(url, 1, '0.1.1-test')).servingVersion, '0.1.1-test')
    assert.deepEqual(rpcRequest, { method: 'summary', args: {} })
  } finally { await new Promise(resolve => server.close(resolve)) }
})

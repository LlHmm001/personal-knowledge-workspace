/** Local test harness for installed JS; all user data stays in a temp directory. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { verifyHttp } from './deployment.mjs'

const { values } = parseArgs({ options: { profile: { type: 'string' }, version: { type: 'string' } } })
const require = createRequire(join(resolve(values.profile), 'package.json'))
const load = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Storage } = await load('@deepseek-ai/dsh-storage')
const { DomainFacility } = await load('@deepseek-ai/dsh-storage-domain')
const { SqliteStorageBackend } = await load('@deepseek-ai/dsh-storage-sqlite')
const { default: Workspace } = await load('@deepseek-ai/dsh-workspace')
const { default: LocalFs } = await load('@deepseek-ai/dsh-fs-local')
const { default: Timer } = await load('@deepseek-ai/cordis-plugin-timer')
const { default: Web } = await load('@deepseek-ai/dsh-pkw-web')
const directory = await mkdtemp(join(tmpdir(), 'pkw-web-installed-'))
const routes = []
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://local').pathname
  const route = routes.find(r => r.kind === 'exact' ? path === r.path : path.startsWith(r.path + '/'))
  if (route) route.handler(req, res)
  else { res.writeHead(404); res.end() }
})
const ctx = new Context()
const backend = new SqliteStorageBackend({ path: join(directory, 'test.sqlite'), journalMode: 'wal' })
try {
  await mkdir(join(directory, 'workspace/notes'), { recursive: true })
  await mkdir(join(directory, 'workspace/attachments'), { recursive: true })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('webServer', { register: route => { routes.push(route); return () => {} } })
  ctx.provide('sessionPersistence', { list: async () => [], load: () => { throw new Error('unused') }, inspect: () => { throw new Error('unused') } })
  await ctx.plugin(Workspace)
  await ctx.plugin(LocalFs)
  await ctx.plugin(Timer)
  await ctx.plugin(Web, {
    workspacePath: join(directory, 'workspace'), kbId: 'test-kb',
    weknoraBaseUrl: 'http://127.0.0.1:1/api/v1', weknoraApiKeyRef: '', weknoraApiKey: '',
    pollMs: 3_600_000, retryBaseMs: 1000, retryMaxMs: 60000, recoveryGraceAttempts: 3,
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  await verifyHttp(url, 1, values.version)
  async function rpc(method, args) {
    const response = await fetch(url + '/pkw/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
    const result = await response.json()
    assert.equal(result.ok, true, result.error)
    return result.value
  }
  const created = await rpc('createNote', { relativePath: 'offline.md', markdown: '# Local canonical note\n' })
  const read = await rpc('getNote', { noteId: created.noteId })
  assert.equal(read.note.noteId, created.noteId)
  assert.match(read.markdown, /Local canonical note/)
  assert.equal((await rpc('summary', {})).integration, 'unavailable')
  console.log('PASS: installed JS serves /pkw with release version, summary RPC, and canonical note create/read with WeKnora unavailable')
} finally {
  await new Promise(resolve => server.close(resolve))
  await ctx.fiber.dispose()
  await backend.close()
  await rm(directory, { recursive: true, force: true })
}

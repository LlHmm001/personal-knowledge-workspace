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

export async function runWebSmoke(values) {
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
    if (values.version) assert.ok((await (await fetch(url + '/pkw')).text()).includes(`const PKW_BUILD = ${JSON.stringify(values.version)}`), 'UI version must match the installed package')
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
    const guard = { noteId: created.noteId, expectedRevision: read.note.observedRevision, expectedContentHash: read.note.contentHash }
    await rpc('saveNoteBody', { ...guard, body: '# Local canonical note\n\nSaved through the installed API.\n' })
    const stale = await fetch(url + '/pkw/api', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'saveNoteBody', args: { ...guard, body: '# Stale overwrite must fail\n' } }),
    })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).code, 'PKW_NOTE_CONFLICT')
    assert.match((await rpc('getNote', { noteId: created.noteId })).markdown, /Saved through the installed API/)
    assert.equal((await rpc('summary', {})).integration, 'unavailable')
    assert.equal(read.sync.configuration, 'missing_credential')
    const htmlName = '附件预览验收.html'
    const htmlBody = '<h1>Untrusted attachment must download</h1>'
    const htmlAttachment = await rpc('uploadAttachment', { filename: htmlName, mimeType: 'text/html', contentBase64: Buffer.from(htmlBody).toString('base64') })
    const download = await fetch(url + '/pkw/attachment/' + htmlAttachment.attachmentId + '/preview')
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition'), /^attachment;/)
    assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent(htmlName)))
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(download.headers.get('cache-control'), 'private, no-store')
    assert.match(download.headers.get('content-security-policy'), /sandbox/)
    assert.equal(await download.text(), htmlBody)
    const task = await rpc('createTask', { title: '验证日期清除', dueAt: '2026-10-03T12:00:00.000Z' })
    await rpc('updateTask', { taskId: task.taskId, patch: { dueAt: '' } })
    assert.equal((await rpc('listTasks', { matrixId: null })).find(t => t.taskId === task.taskId).dueAt, undefined)
    console.log('PASS: installed JS serves the release version, offline note create/read/save, stale-save HTTP 409, safe Unicode attachment downloads, and task date clearing')
    if (values.preview) {
      await rpc('createNote', {
        relativePath: '欢迎体验.md',
        markdown: '# PKW 升级预览\n\n这是隔离的演示工作区，可以放心尝试创建、编辑、保存和恢复笔记。\n\n> [!NOTE]\n> 此处的数据是临时样例，退出预览后删除。预览没有连接你的生产资料或 WeKnora。\n\n## 可以试试\n\n- 在笔记和知识主页之间切换\n- 修改正文并观察保存状态\n- 查看附件、任务和回收站的操作\n\n## 验收边界\n\n此预览运行从打包产物安装的 PKW，使用本地 SQLite 和文件系统；网页由测试用路由适配器提供，不代表生产服务器已升级。\n',
      })
      console.log(`PREVIEW_URL=${url}/pkw`)
      console.log('Temporary demo workspace only; WeKnora is unavailable. Stop with Ctrl+C; demo data will be deleted.')
      await new Promise(resolve => {
        const stop = () => {
          process.off('SIGINT', stop)
          process.off('SIGTERM', stop)
          resolve()
        }
        process.on('SIGINT', stop)
        process.on('SIGTERM', stop)
      })
    }
  } finally {
    await new Promise(resolve => server.close(resolve))
    await ctx.fiber.dispose()
    await backend.close()
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, version: { type: 'string' }, preview: { type: 'boolean', default: false } } })
  await runWebSmoke(values)
}

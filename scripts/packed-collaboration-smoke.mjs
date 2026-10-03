/** Installed-artifact isolation smoke and disposable browser preview. Never opens production data. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'

async function operationalSmoke(profile, root) {
  const reserve = createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const origin = `http://127.0.0.1:${port}`, scripts = dirname(fileURLToPath(import.meta.url))
  const dataRoot = join(root, 'operational-root'), config = join(root, 'operational.json')
  const original = 'synthetic-original-passphrase-only', changed = 'synthetic-recovered-passphrase-only'
  await writeFile(config, JSON.stringify({ dataPath: dataRoot, publicOrigin: origin, bootstrapUsername: 'operator', bootstrapPasswordEnv: 'PKW_SMOKE_BOOTSTRAP' }), { mode: 0o600 })
  let child
  async function start() {
    child = spawn(process.execPath, [join(scripts, 'serve-collaboration.mjs'), '--profile', profile, '--config', config, '--port', String(port)], { env: { ...process.env, PKW_SMOKE_BOOTSTRAP: original }, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dedicated gateway startup timed out')), 15_000)
      let output = ''
      child.stderr.resume()
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Dedicated gateway exited before startup (${code})`)) })
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('"status":"listening"')) { clearTimeout(timer); resolve() } })
    })
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Dedicated gateway failed graceful shutdown')) }, 15_000)
      child.once('exit', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Dedicated gateway stopped abnormally (${code}, ${signal})`)) })
      child.kill('SIGTERM')
    })
  }
  const login = password => fetch(origin + '/pkw/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: 'operator', password }) })
  const recoverArgs = [join(scripts, 'recover-account.mjs'), '--profile', profile, '--data-root', dataRoot, '--username', 'operator', '--password-env', 'PKW_SMOKE_RECOVERY', '--offline-confirmed']
  const recoveryEnv = { ...process.env, PKW_SMOKE_RECOVERY: changed }
  try {
    await start()
    assert.equal((await fetch(origin + '/healthz')).status, 200)
    assert.equal((await fetch(origin + '/')).status, 404)
    assert.equal((await login(original)).status, 200)
    await assert.rejects(promisify(execFile)(process.execPath, recoverArgs, { env: recoveryEnv }))
    await stop()
    const recovered = await promisify(execFile)(process.execPath, recoverArgs, { env: recoveryEnv })
    assert.equal(JSON.parse(recovered.stdout).status, 'complete')
    assert.ok(!recovered.stdout.includes(changed))
    await start()
    assert.equal((await login(original)).status, 401)
    assert.equal((await login(changed)).status, 200)
    console.log('PASS: installed dedicated listener, protected offline password recovery, active-writer lock refusal, graceful restart, and recovered login')
  } finally { await stop() }
}

export async function runCollaborationSmoke({ profile, preview = false }) {
  const require = createRequire(join(resolve(profile), 'package.json'))
  const { CollaborationGateway } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pkw-web/lib/collaboration/index.js')).href)
  const { IdentityStore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pkw-web/lib/collaboration/identity.js')).href)
  const dataPath = await realpath(await mkdtemp(join(tmpdir(), 'pkw-collaboration-installed-')))
  const password = 'temporary-demo-passphrase-only'
  let gateway
  const server = createServer((req, res) => {
    if (!gateway) { res.writeHead(503); res.end(); return }
    void gateway.handle(req, res)
  })
  try {
    const store = await IdentityStore.open(join(dataPath, 'identity.sqlite'))
    try { await store.bootstrap('owner', password) } finally { store.close() }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    gateway = await CollaborationGateway.open({ dataPath, publicOrigin: origin })
    async function request(path, input, auth) {
      const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: {
        ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
        ...(auth ? { Cookie: auth.cookie, 'X-PKW-CSRF': auth.csrf } : {}),
      }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
      const result = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text()
      return { response, result }
    }
    async function login(username, rememberMe = false) {
      const { response, result } = await request('/pkw/login', { username, password, rememberMe })
      assert.equal(response.status, 200, JSON.stringify(result))
      const setCookie = response.headers.get('set-cookie')
      const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)[1]), lifetime = rememberMe ? 2592000 : 43200
      assert.ok(maxAge >= lifetime - 2 && maxAge <= lifetime, 'cookie must match the selected login duration')
      const cookie = setCookie.split(';')[0]
      const session = await request('/pkw/session', undefined, { cookie })
      return { cookie, ...session.result.value }
    }
    const owner = await login('owner', true), personal = owner.spaces.find(s => s.kind === 'private')
    const anonymousPage = await fetch(origin + '/pkw/spaces/' + personal.id, { redirect: 'manual' })
    assert.equal(anonymousPage.status, 303)
    assert.equal(anonymousPage.headers.get('location'), '/pkw?next=' + encodeURIComponent('/pkw/spaces/' + personal.id) + '&reason=session-expired')
    await anonymousPage.arrayBuffer()
    const team = (await request('/pkw/manage', { action: 'createTeam', name: '示例研发团队' }, owner)).result.value
    const invitation = (await request('/pkw/manage', { action: 'invite', spaceId: team.id, role: 'viewer' }, owner)).result.value
    assert.equal((await request('/pkw/register', { username: 'viewer', password, token: invitation.token })).response.status, 200)
    const viewer = await login('viewer')
    async function rpc(space, method, args = {}, auth = owner) { return request('/pkw/spaces/' + space + '/api', { method, args }, auth) }
    const note = await rpc(personal.id, 'createNote', { relativePath: '私人空间使用说明.md', markdown: '# 我的私人空间\n\n这里只对当前账号开放。示例资料可以用于检查保存、附件、任务和分享预览。\n\n这是本机临时演示，没有连接生产资料或远程检索。\n' })
    assert.equal(note.response.status, 200)
    await rpc(team.id, 'createNote', { relativePath: '团队协作说明.md', markdown: '# 团队协作\n\n此空间包含合成样例。owner 可以编辑；viewer 可以阅读。\n\n- 每次请求在服务端验证成员身份\n- 私人内容不会因为加入团队自动共享\n- 保存冲突时保留草稿\n' })
    await rpc(team.id, 'createTask', { title: '检查团队笔记与只读权限', description: '这个任务仅为本机验收样例。', dueAt: '2026-10-10' })
    assert.equal((await rpc(personal.id, 'listNotes', {}, viewer)).response.status, 404)
    assert.equal((await rpc(team.id, 'createNote', { relativePath: 'forbidden.md', markdown: 'no' }, viewer)).response.status, 403)
    assert.equal((await request('/pkw/api', { method: 'listNotes' })).response.status, 401)
    const page = await request('/pkw/spaces/' + team.id, undefined, owner)
    assert.equal(page.response.status, 200)
    assert.ok(page.result.includes('/pkw/spaces/' + team.id))
    const read = await rpc(personal.id, 'getNote', { noteId: note.result.value.noteId })
    const guard = { noteId: note.result.value.noteId, expectedContentHash: read.result.value.note.contentHash, expectedRevision: read.result.value.note.observedRevision }
    assert.equal((await rpc(personal.id, 'saveNoteBody', { ...guard, body: '# 保存验收通过\n\n刷新后仍能看到这段合成文字。' })).response.status, 200)
    assert.equal((await rpc(personal.id, 'saveNoteBody', { ...guard, body: '# stale' })).response.status, 409)
    const sharePreview = await request('/pkw/share', { action: 'preview', sourceSpaceId: personal.id, targetSpaceId: team.id, noteId: note.result.value.noteId }, owner)
    assert.equal(sharePreview.response.status, 200)
    const shareInput = { action: 'commit', token: sharePreview.result.value.token }
    const shared = await request('/pkw/share', shareInput, owner)
    assert.equal(shared.response.status, 200)
    assert.equal(shared.result.value.status, 'complete')
    assert.notEqual(shared.result.value.noteId, note.result.value.noteId)
    assert.deepEqual((await request('/pkw/share', shareInput, owner)).result.value, shared.result.value)
    assert.equal((await rpc(team.id, 'getNote', { noteId: shared.result.value.noteId }, viewer)).response.status, 200)
    assert.equal((await rpc(personal.id, 'getNote', { noteId: note.result.value.noteId }, viewer)).response.status, 404)
    console.log('PASS: installed collaboration entry, real HTTP login/CSRF, selected session lifetime, expired-page login redirect, independent spaces, viewer denial, legacy-route denial, stale-save protection, and idempotent private-to-team sharing')
    await operationalSmoke(resolve(profile), dataPath)
    if (preview) {
      console.log(`COLLABORATION_PREVIEW_URL=${origin}/pkw`)
      console.log(`Synthetic demo accounts: owner / viewer; temporary password: ${password}`)
      console.log('Local disposable data only. Stop with Ctrl+C to remove the demo.')
      await new Promise(resolve => {
        const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve() }
        process.on('SIGINT', stop); process.on('SIGTERM', stop)
      })
    }
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    if (gateway) await gateway.close()
    await rm(dataPath, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, preview: { type: 'boolean', default: false } } })
  if (!values.profile) throw new Error('--profile is required')
  await runCollaborationSmoke(values)
}

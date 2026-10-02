import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { CollaborationGateway } from '../src/collaboration/index.ts'
import { authorizeRpc } from '../src/collaboration/policy.ts'
import { createSpaceRuntime } from '../src/collaboration/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const password = 'only-a-temporary-test-passphrase'
async function boot() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pkw-collaboration-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  let gateway: CollaborationGateway
  const server = createServer((req, res) => { void gateway.handle(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const config = { dataPath: dir, publicOrigin: origin, bootstrapUsername: 'alice', bootstrapPasswordEnv: 'PKW_COLLAB_TEST_PASSWORD' }
  process.env.PKW_COLLAB_TEST_PASSWORD = password
  try { gateway = await CollaborationGateway.open(config) } finally { delete process.env.PKW_COLLAB_TEST_PASSWORD }
  cleanups.push(() => gateway.close())
  async function request(path: string, input?: unknown, auth?: { cookie: string; csrf: string }, extra: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...(auth ? { Cookie: auth.cookie, 'X-PKW-CSRF': auth.csrf } : {}), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    const contentType = response.headers.get('content-type') ?? ''
    const value = contentType.includes('json') ? await response.json() : await response.text()
    return { status: response.status, headers: response.headers, value }
  }
  async function login(username: string) {
    const login = await request('/pkw/login', { username, password })
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict')
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const session = await request('/pkw/session', undefined, { cookie, csrf: '' })
    return { cookie, csrf: session.value.value.csrf as string, spaces: session.value.value.spaces as Array<{ id: string; ownerId: string; kind: string; role: string }> }
  }
  return { dir, gateway: gateway!, config, request, login }
}

describe('authenticated collaboration with real isolated SQLite/filesystem runtimes', () => {
  it('keeps canonical notes available when a configured remote credential is missing', async () => {
    const { dir, login, gateway } = await boot()
    const account = await login('alice')
    const space = gateway.identity.authorize(account.spaces[0]!.ownerId, account.spaces[0]!.id)
    const runtime = await createSpaceRuntime(dir, space, { baseUrl: 'http://127.0.0.1:1', kbId: 'synthetic-kb', apiKeyEnv: 'PKW_SYNTHETIC_UNSET_CREDENTIAL' })
    try {
      await runtime.web.call('createNote', { relativePath: 'offline.md', markdown: '# Local recovery\n\nStill available.' })
      expect(await runtime.web.call('listNotes', {})).toHaveLength(1)
      const result = await runtime.web.call('search', { query: 'recovery' }) as { mode: string; results: unknown[] }
      expect(result.mode).toBe('local-keyword')
      expect(result.results).toHaveLength(1)
    } finally { await runtime.close() }
  }, 20_000)

  it('keeps fifteen accounts isolated during concurrent private and shared writes', async () => {
    const { request, login } = await boot()
    const owner = await login('alice')
    const team = (await request('/pkw/manage', { action: 'createTeam', name: 'Fifteen person acceptance' }, owner)).value.value
    const accounts = [owner]
    for (let i = 1; i < 15; i++) {
      const invite = (await request('/pkw/manage', { action: 'invite', spaceId: team.id, role: 'editor' }, owner)).value.value
      expect((await request('/pkw/register', { username: `member${i}`, password, token: invite.token })).status).toBe(200)
      accounts.push(await login(`member${i}`))
    }
    const personal = accounts.map(a => a.spaces.find(s => s.kind === 'private')!.id)
    expect(new Set(personal).size).toBe(15)
    const rpc = (space: string, method: string, args: unknown, index: number) => request(`/pkw/spaces/${space}/api`, { method, args }, accounts[index])
    const start = performance.now()
    await Promise.all(accounts.map(async (_account, index) => {
      expect((await rpc(personal[index]!, 'createNote', { relativePath: 'private.md', markdown: `# Private marker ${index}` }, index)).status).toBe(200)
      expect((await rpc(team.id, 'createNote', { relativePath: `member-${index}.md`, markdown: `# Team marker ${index}` }, index)).status).toBe(200)
    }))
    await Promise.all(accounts.map(async (_account, index) => {
      const notes = (await rpc(personal[index]!, 'listNotes', {}, index)).value.value
      expect(notes).toHaveLength(1)
      expect(notes[0].title).toBe(`Private marker ${index}`)
      expect((await rpc(personal[(index + 1) % 15]!, 'listNotes', {}, index)).status).toBe(404)
      expect((await rpc(team.id, 'listNotes', {}, index)).value.value).toHaveLength(15)
    }))
    console.info(JSON.stringify({ scenario: '15 synthetic accounts, 30 writes and 45 reads', elapsedMs: Math.round(performance.now() - start), environment: 'local functional smoke, not production capacity' }))
  }, 90_000)

  it('isolates private, shared, HTTP attachment, actors and revocation', async () => {
    const { dir, gateway, request, login } = await boot()
    expect((await request('/pkw')).status).toBe(200)
    expect((await request('/pkw/session')).status).toBe(401)
    expect((await request('/pkw/api', { method: 'listNotes', args: {} })).status).toBe(401)
    expect((await request('/pkw/login', { username: 'alice', password }, undefined, { Origin: 'https://attacker.invalid' })).status).toBe(403)
    const alice = await login('alice'), privateA = alice.spaces[0]!
    const manage = async (input: unknown, auth = alice) => request('/pkw/manage', input, auth)
    const teamResponse = await manage({ action: 'createTeam', name: 'Shared engineering' })
    const team = teamResponse.value.value
    const invite = await manage({ action: 'invite', spaceId: team.id, role: 'editor' })
    expect((await request('/pkw/register', { username: 'bob', password, token: invite.value.value.token })).status).toBe(200)
    expect((await request('/pkw/register', { username: 'charlie', password, token: invite.value.value.token })).status).toBe(400)
    const bob = await login('bob'), privateB = bob.spaces.find(s => s.kind === 'private')!
    const rpc = (space: string, method: string, args: unknown = {}, auth = alice) => request('/pkw/spaces/' + space + '/api', { method, args }, auth)
    const a = await rpc(privateA.id, 'createNote', { relativePath: 'same.md', markdown: '# Alice private words' })
    expect(a.status).toBe(200)
    const b = await rpc(privateB.id, 'createNote', { relativePath: 'same.md', markdown: '# Bob private words' }, bob)
    expect(b.status).toBe(200)
    const shared = await rpc(team.id, 'createNote', { relativePath: 'same.md', markdown: '# Team shared words' }, bob)
    expect(shared.status).toBe(200)
    expect((await rpc(privateA.id, 'listNotes', {}, bob)).status).toBe(404)
    expect((await rpc(privateB.id, 'getNote', { noteId: b.value.value.noteId })).status).toBe(404)
    expect((await rpc(team.id, 'getNote', { noteId: a.value.value.noteId }, bob)).value.ok).toBe(false)
    const list = await rpc(team.id, 'listNotes', {}, bob)
    expect(JSON.stringify(list.value)).toContain('Team shared words')
    expect(JSON.stringify(list.value)).not.toContain('private words')
    // A client cannot switch backend identity through RPC arguments or impersonation headers.
    const forged = await rpc(team.id, 'listNotes', { workspaceId: privateA.id, actor: { id: privateA.ownerId }, spaceId: privateA.id }, bob)
    expect(JSON.stringify(forged.value)).not.toContain('Alice private words')
    const localSearch = await rpc(team.id, 'search', { query: 'private' }, bob)
    expect(localSearch.value.value.mode).toBe('local-keyword')
    expect(localSearch.value.value.results).toEqual([])
    expect((await rpc(team.id, 'search', { query: 'shared' }, bob)).value.value.results).toHaveLength(1)
    const noCsrf = await request('/pkw/spaces/' + team.id + '/api', { method: 'listNotes' }, { ...bob, csrf: 'forged' })
    expect(noCsrf.status).toBe(403)
    const upload = await rpc(privateA.id, 'uploadAttachment', { filename: 'secret.txt', mimeType: 'text/plain', contentBase64: Buffer.from('PRIVATE BYTE PAYLOAD').toString('base64') })
    const attachment = upload.value.value.attachmentId
    expect((await request('/pkw/spaces/' + privateA.id + '/attachment/' + attachment, undefined, bob)).status).toBe(404)
    expect((await request('/pkw/spaces/' + team.id + '/attachment/' + attachment, undefined, bob)).status).toBe(404)
    expect((await request('/pkw/spaces/' + privateA.id + '/attachment/' + attachment, undefined, alice)).value).toBe('PRIVATE BYTE PAYLOAD')
    const task = await rpc(team.id, 'createTask', { title: 'Shared task' }, bob)
    expect(task.status).toBe(200)
    const page = await request('/pkw/spaces/' + team.id, undefined, bob)
    expect(page.status).toBe(200)
    expect(page.value).toContain('/pkw/spaces/' + team.id)
    const saved = await rpc(team.id, 'getNote', { noteId: shared.value.value.noteId }, bob)
    const guard = { noteId: shared.value.value.noteId, expectedRevision: saved.value.value.note.observedRevision, expectedContentHash: saved.value.value.note.contentHash }
    expect((await rpc(team.id, 'saveNoteBody', { ...guard, body: '# Alice changed shared note' })).status).toBe(200)
    expect((await rpc(team.id, 'saveNoteBody', { ...guard, body: '# Bob stale draft' }, bob)).status).toBe(409)
    const bobId = privateB.ownerId
    expect((await manage({ action: 'setRole', spaceId: team.id, userId: bobId, role: 'viewer' })).status).toBe(200)
    expect((await rpc(team.id, 'createNote', { relativePath: 'denied.md', markdown: '# denied' }, bob)).status).toBe(403)
    expect((await rpc(team.id, 'purgeNote', { noteId: shared.value.value.noteId }, bob)).status).toBe(403)
    expect((await rpc(team.id, 'listNotes', {}, bob)).status).toBe(200)
    expect((await rpc(team.id, 'newUnreviewedMethod', {}, alice)).status).toBe(403)
    expect((await manage({ action: 'setRole', spaceId: team.id, userId: bobId, role: null })).status).toBe(200)
    expect((await rpc(team.id, 'listNotes', {}, bob)).status).toBe(404)
    expect((await request('/pkw/spaces/' + team.id, undefined, bob)).status).toBe(404)
    expect((await request('/pkw/spaces/' + team.id + '/attachment/' + attachment, undefined, bob)).status).toBe(404)
    // Durable event actor is derived from the verified request, never the JSON body.
    const database = new DatabaseSync(join(dir, 'spaces', team.id, 'state.sqlite'), { readOnly: true })
    const rows = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    const tables = rows.map(r => String(r.name))
    expect(tables.length).toBeGreaterThan(1)
    const commitTable = tables.find(name => name === 'u_pkw_commits')!
    expect(commitTable).toBeTruthy()
    const commits = database.prepare(`SELECT value FROM "${commitTable}"`).all().map(row => JSON.parse(String(row.value)))
    expect(commits.some(commit => commit.actor.id === bobId)).toBe(true)
    expect(commits.some(commit => commit.actor.id === privateA.ownerId)).toBe(true)
    database.close()
    expect((await manage({ action: 'logout' }, alice)).status).toBe(200)
    expect((await request('/pkw/session', undefined, alice)).status).toBe(401)
  }, 40_000)

  it('refuses unsafe origins, shared KBs and two writers on one data root', async () => {
    const { config } = await boot()
    await expect(CollaborationGateway.open({ ...config, publicOrigin: 'http://example.com' })).rejects.toThrow('HTTPS')
    await expect(CollaborationGateway.open(config)).rejects.toThrow('locked')
    await expect(CollaborationGateway.open({ ...config, retrieval: {
      ['sp_' + 'a'.repeat(32)]: { baseUrl: 'https://search.example/api/', kbId: 'kb1', apiKeyEnv: 'SECRET_A' },
      ['sp_' + 'b'.repeat(32)]: { baseUrl: 'https://search.example/api', kbId: 'kb1', apiKeyEnv: 'SECRET_B' },
    } })).rejects.toThrow('cannot be shared')
  }, 20_000)
})

describe('RPC policy completeness', () => {
  it('registers every actual dispatcher method and rejects unreviewed capabilities', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    for (const [, method] of source.matchAll(/case '([^']+)':/g)) expect(() => authorizeRpc('owner', method!)).not.toThrow()
    expect(() => authorizeRpc('viewer', 'listNotes')).not.toThrow()
    for (const method of ['saveNoteBody','uploadAttachment','updateTask','reconcile','purgeNote','newFutureMethod']) expect(() => authorizeRpc('viewer', method)).toThrow()
    for (const method of ['purgeNote','purgeAttachment','batchPurgeTrash','purgeFolder']) expect(() => authorizeRpc('editor', method)).toThrow()
  })
})

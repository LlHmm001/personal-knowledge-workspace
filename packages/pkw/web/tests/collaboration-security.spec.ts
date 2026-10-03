import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollaborationGateway, type RuntimeFactory } from '../src/collaboration/index.ts'
import type { SpaceRuntime } from '../src/collaboration/runtime.ts'
import type { Role, Session } from '../src/collaboration/identity.ts'

// Real gateway, loopback HTTP, identity SQLite and production scrypt. Only the
// content runtime is controlled so authorization races have deterministic gates.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const PASSWORD = 'Synthetic security passphrase 2026!'
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function contentRuntime(calls: string[], spaceId: string): SpaceRuntime {
  return {
    web: { call: async (method: string) => { calls.push(method); return { spaceId } } } as unknown as SpaceRuntime['web'],
    routes: [{ kind: 'exact', path: '/pkw/spaces/' + spaceId, handler: (_req, res) => { calls.push('page'); res.end('private page') } }],
    close: async () => {},
  }
}
interface Auth { cookie: string; csrf: string; session: Session }
async function boot(factory?: RuntimeFactory) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pkw-gateway-security-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  let gateway!: CollaborationGateway
  const arrivals: Array<(req: IncomingMessage) => void> = []
  const server = createServer((req, res) => {
    void gateway.handle(req, res)
    for (const notify of arrivals.splice(0)) notify(req)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const calls: string[] = [], creations: string[] = []
  process.env.PKW_SECURITY_TEST_PASSWORD = PASSWORD
  try {
    gateway = await CollaborationGateway.open({ dataPath: dir, publicOrigin: origin, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_SECURITY_TEST_PASSWORD' }, async (...args) => {
      creations.push(args[1].id)
      return factory ? factory(...args) : contentRuntime(calls, args[1].id)
    })
  } finally { delete process.env.PKW_SECURITY_TEST_PASSWORD }
  cleanups.push(() => gateway.close())
  async function auth(username: string): Promise<Auth> {
    const login = await gateway.identity.login(username, PASSWORD)
    return { cookie: 'pkw_session=' + login.token, csrf: login.session.csrf, session: login.session }
  }
  const owner = await auth('owner'), team = gateway.identity.createTeam(owner.session.id, 'Security test team')
  async function member(username: string, role: Exclude<Role, 'owner'>): Promise<Auth> {
    const invite = gateway.identity.invite(owner.session.id, team.id, role)
    await gateway.identity.register(invite.token, username, PASSWORD)
    return auth(username)
  }
  async function request(path: string, input?: unknown, actor = owner, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, {
      redirect: 'manual',
      method: input === undefined ? 'GET' : 'POST',
      headers: { Cookie: actor.cookie, 'X-PKW-CSRF': actor.csrf, ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
    return { status: response.status, headers: response.headers, text: await response.text() }
  }
  async function slowPost(path: string, input: unknown, actor = owner) {
    const arrived = deferred(), text = JSON.stringify(input)
    arrivals.push(() => arrived.resolve())
    const completed = deferred<{ status: number; text: string }>()
    const req = httpRequest(origin + path, { method: 'POST', headers: { Cookie: actor.cookie, 'X-PKW-CSRF': actor.csrf, 'Content-Type': 'application/json', Origin: origin } }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => completed.resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() }))
      res.on('error', completed.reject)
    })
    req.on('error', completed.reject)
    req.write(text.slice(0, 1))
    await arrived.promise
    return { finish: () => { req.end(text.slice(1)); return completed.promise } }
  }
  return { gateway, calls, creations, request, slowPost, owner, team, member }
}

describe('gateway independent security race regression', () => {
  it('redirects an expired space page to login while APIs keep a non-redirecting 401', async () => {
    const f = await boot(), page = '/pkw/spaces/' + f.team.id
    f.gateway.identity.logout(f.owner.session)
    for (const path of [page, page + '/']) {
      const response = await f.request(path)
      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/pkw?next=' + encodeURIComponent(page) + '&reason=session-expired')
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('set-cookie')).toBeNull() // a late 401 cannot erase a newer login cookie
    }
    const api = await f.request(page + '/api', { method: 'saveNoteBody', args: { body: 'unsaved draft' } })
    expect(api.status).toBe(401)
    expect(JSON.parse(api.text).code).toBe('PKW_AUTH_REQUIRED')
    expect(api.headers.get('location')).toBeNull()
    for (const path of ['/pkw/session', page + '/attachment/unknown']) {
      const response = await f.request(path)
      expect(response.status).toBe(401)
      expect(response.headers.get('location')).toBeNull()
    }
    expect((await f.request('/pkw?reason=session-expired')).status).toBe(200)
    expect(f.calls).toEqual([])
    expect(f.creations).toEqual([])
  }, 40_000)

  it('matches login cookie lifetime to the selected server session and requires an explicit boolean', async () => {
    const f = await boot()
    for (const [rememberMe, lifetime] of [[undefined, 43200], [false, 43200], [true, 2592000]] as const) {
      const response = await f.request('/pkw/login', { username: 'owner', password: PASSWORD, rememberMe })
      expect(response.status).toBe(200)
      const cookie = response.headers.get('set-cookie')!
      expect(cookie).toContain('Path=/pkw; HttpOnly; SameSite=Strict;')
      const seconds = Number(/Max-Age=(\d+)/.exec(cookie)![1])
      expect(seconds).toBeGreaterThanOrEqual(lifetime - 2)
      expect(seconds).toBeLessThanOrEqual(lifetime)
      const token = /^pkw_session=([^;]+)/.exec(cookie)![1]!
      const session = f.gateway.identity.session(token)!
      expect(session.expiresAt - Date.now()).toBeGreaterThanOrEqual((lifetime - 2) * 1000)
    }
    const invalid = await f.request('/pkw/login', { username: 'owner', password: PASSWORD, rememberMe: 'true' })
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('set-cookie')).toBeNull()
  }, 40_000)

  it('denies unknown capabilities, malformed arguments and unsafe request envelopes before opening a runtime', async () => {
    const { request, team, member, calls, creations } = await boot()
    const viewer = await member('reader', 'viewer'), endpoint = '/pkw/spaces/' + team.id + '/api'
    for (const method of ['constructor', '__proto__', 'futureAdminExport', 'call']) {
      expect((await request(endpoint, { method })).status).toBe(403)
    }
    expect((await request(endpoint, { method: 'saveNoteBody', args: {} }, viewer)).status).toBe(403)
    expect((await request(endpoint, { method: 'listNotes', args: [] })).status).toBe(400)
    expect((await request(endpoint, { method: 'listNotes' }, viewer, { Origin: 'https://attacker.invalid' })).status).toBe(403)
    expect((await request(endpoint, { method: 'listNotes' }, viewer, { 'X-PKW-CSRF': 'wrong' })).status).toBe(403)
    expect((await request(endpoint, { method: 'listNotes' }, viewer, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await request(endpoint, { method: 'listNotes' }, viewer, { Cookie: viewer.cookie + '; ' + viewer.cookie })).status).toBe(401)
    expect((await request('/pkw/api', { method: 'listNotes' }, viewer)).status).toBe(404)
    expect(calls).toEqual([]); expect(creations).toEqual([])
  }, 40_000)

  it.each(['api', 'page'] as const)('rechecks revocation after pending %s runtime startup', async kind => {
    const entered = deferred(), release = deferred(), calls: string[] = []
    const f = await boot(async (_root, space) => { entered.resolve(); await release.promise; return contentRuntime(calls, space.id) })
    const member = await f.member('writer', 'editor'), path = '/pkw/spaces/' + f.team.id
    const pending = kind === 'api' ? f.request(path + '/api', { method: 'saveNoteBody' }, member) : f.request(path, undefined, member)
    await entered.promise
    f.gateway.identity.setRole(f.owner.session.id, f.team.id, member.session.id, null)
    release.resolve()
    expect((await pending).status).toBe(404)
    expect(calls).toEqual([])
  }, 40_000)

  it('rechecks role after upload and after runtime startup', async () => {
    const entered = deferred(), release = deferred(), calls: string[] = []
    const f = await boot(async (_root, space) => { entered.resolve(); await release.promise; return contentRuntime(calls, space.id) })
    const member = await f.member('writer', 'editor'), endpoint = '/pkw/spaces/' + f.team.id + '/api'
    const pending = f.request(endpoint, { method: 'saveNoteBody' }, member)
    await entered.promise
    f.gateway.identity.setRole(f.owner.session.id, f.team.id, member.session.id, 'viewer')
    release.resolve()
    expect((await pending).status).toBe(403)
    const upload = await f.slowPost(endpoint, { method: 'saveNoteBody' })
    f.gateway.identity.transfer(f.owner.session.id, f.team.id, member.session.id)
    f.gateway.identity.setRole(member.session.id, f.team.id, f.owner.session.id, 'viewer')
    expect((await upload.finish()).status).toBe(403)
    expect(calls).toEqual([])
  }, 40_000)

  it.each(['api', 'page'] as const)('rechecks the session after pending %s runtime startup', async kind => {
    const entered = deferred(), release = deferred(), calls: string[] = []
    const f = await boot(async (_root, space) => { entered.resolve(); await release.promise; return contentRuntime(calls, space.id) })
    const path = '/pkw/spaces/' + f.team.id
    const pending = kind === 'api' ? f.request(path + '/api', { method: 'saveNoteBody' }) : f.request(path)
    await entered.promise
    expect((await f.request('/pkw/manage', { action: 'logout' })).status).toBe(200)
    release.resolve()
    const response = await pending
    expect(response.status).toBe(kind === 'page' ? 303 : 401)
    if (kind === 'page') expect(response.headers.get('location')).toBe('/pkw?next=' + encodeURIComponent(path) + '&reason=session-expired')
    expect(calls).toEqual([])
  }, 40_000)

  it.each(['api', 'manage'] as const)('does not execute %s after session revocation during a slow request body', async kind => {
    const f = await boot()
    const before = f.gateway.identity.spaces(f.owner.session.id).length
    const upload = kind === 'api'
      ? await f.slowPost('/pkw/spaces/' + f.team.id + '/api', { method: 'saveNoteBody' })
      : await f.slowPost('/pkw/manage', { action: 'createTeam', name: 'Must not exist after logout' })
    expect((await f.request('/pkw/manage', { action: 'logout' })).status).toBe(200)
    expect((await upload.finish()).status).toBe(401)
    expect(f.gateway.identity.spaces(f.owner.session.id)).toHaveLength(before)
    expect(f.calls).toEqual([])
  }, 40_000)

  it('does not cache a failed runtime and can recover on an authorized retry', async () => {
    let first = true
    const calls: string[] = []
    const f = await boot(async (_root, space) => {
      if (first) { first = false; throw new Error('Private deployment detail must not escape') }
      return contentRuntime(calls, space.id)
    })
    const endpoint = '/pkw/spaces/' + f.team.id + '/api'
    const failed = await f.request(endpoint, { method: 'listNotes' })
    expect(failed.status).toBeGreaterThanOrEqual(400)
    expect(failed.text).not.toContain('Private deployment detail')
    expect(failed.headers.get('cache-control')).toContain('no-store')
    expect((await f.request(endpoint, { method: 'listNotes' })).status).toBe(200)
    expect(calls).toEqual(['listNotes']); expect(f.creations).toHaveLength(2)
  }, 40_000)
})

/** Authenticated PKW composition. Replaces, never coexists with, the legacy /pkw plugin. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { mkdir, open, unlink, lstat, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withRequestActor } from '@deepseek-ai/dsh-pkw-events'
import { AccessError, IdentityStore, type Session, type Space } from './identity.ts'
import { createSpaceRuntime, type RetrievalConfig, type SpaceRuntime } from './runtime.ts'
import { authorizeRpc } from './policy.ts'
import { renderPortal } from './portal-ui.ts'
import { SharingService } from './sharing.ts'

export interface CollaborationConfig {
  dataPath: string
  publicOrigin: string
  bootstrapUsername?: string
  bootstrapPasswordEnv?: string
  /** Only dedicated PKW KBs; never share a remote KB between spaces. */
  retrieval?: Record<string, RetrievalConfig>
}
export type RuntimeFactory = (root: string, space: Space, retrieval?: RetrievalConfig) => Promise<SpaceRuntime>
const cookieName = 'pkw_session'
const validSpaceId = /^sp_[a-f0-9]{32}$/
const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
async function body(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new AccessError(415, '请求必须使用 JSON')
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += data.length
    if (bytes > limit) throw new AccessError(413, '请求内容过大，请分批上传')
    chunks.push(data)
  }
  let result: unknown
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new AccessError(400, 'JSON 格式不正确') }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new AccessError(400, '请求格式不正确')
  return result as Record<string, unknown>
}
function readCookie(req: IncomingMessage): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(p => p.trim()).filter(p => p.startsWith(cookieName + '='))
  return values.length === 1 ? values[0]!.slice(cookieName.length + 1) : undefined
}
function routeMatches(route: WebRoute, path: string): boolean { return path === route.path || (route.kind === 'prefix' && path.startsWith(route.path + '/')) }

export class CollaborationGateway {
  readonly identity: IdentityStore
  private readonly runtimes = new Map<string, Promise<SpaceRuntime>>()
  private readonly origin: URL
  private readonly sharing: SharingService
  private constructor(private readonly config: CollaborationConfig, identity: IdentityStore, private readonly lock: FileHandle, private readonly factory: RuntimeFactory) {
    this.identity = identity
    this.origin = new URL(config.publicOrigin)
    this.sharing = new SharingService({ identity, runtime: space => this.runtime(space), dataPath: config.dataPath })
  }
  static async open(config: CollaborationConfig, factory: RuntimeFactory = createSpaceRuntime): Promise<CollaborationGateway> {
    const origin = new URL(config.publicOrigin)
    if (origin.origin !== config.publicOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1','[::1]','localhost'].includes(origin.hostname)))) throw new Error('publicOrigin must be an exact HTTPS origin (HTTP is only allowed on loopback)')
    if (!isAbsolute(config.dataPath)) throw new Error('dataPath must be absolute')
    const seen = new Set<string>()
    for (const [spaceId, remote] of Object.entries(config.retrieval ?? {})) {
      if (!validSpaceId.test(spaceId) || !remote.kbId || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(remote.apiKeyEnv)) throw new Error('Invalid space retrieval configuration')
      const url = new URL(remote.baseUrl)
      if (url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol)) throw new Error('Invalid retrieval URL')
      const key = url.origin + url.pathname.replace(/\/+$/, '') + ':' + remote.kbId
      if (seen.has(key)) throw new Error('A retrieval knowledge base cannot be shared between spaces')
      seen.add(key)
    }
    await mkdir(config.dataPath, { recursive: true, mode: 0o700 })
    if ((await lstat(config.dataPath)).isSymbolicLink() || await realpath(config.dataPath) !== resolve(config.dataPath)) throw new Error('dataPath must be a canonical directory')
    const lockPath = join(config.dataPath, 'gateway.lock')
    const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Collaboration root is locked. Stop the old writer and inspect gateway.lock before recovery; never run two gateways on one root.') })
    let identity: IdentityStore | undefined
    try {
      try {
        await lstat(join(config.dataPath, 'recovery-pending.json'))
        throw new Error('Restored data requires membership review. Complete approve-recovery before starting the gateway.')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n'); await lock.sync()
      const database = join(config.dataPath, 'identity.sqlite')
      try { if (!(await lstat(database)).isFile()) throw new Error('Invalid identity database path') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      identity = await IdentityStore.open(database)
      if (!identity.isInitialized()) {
        const password = process.env[config.bootstrapPasswordEnv ?? 'PKW_BOOTSTRAP_PASSWORD']
        if (!config.bootstrapUsername || !password) throw new Error('First start requires bootstrapUsername and a password in bootstrapPasswordEnv; no public registration is enabled')
        await identity.bootstrap(config.bootstrapUsername, password)
      }
      return new CollaborationGateway(config, identity, lock, factory)
    } catch (error) {
      identity?.close(); await lock.close(); await unlink(lockPath); throw error
    }
  }
  async close(): Promise<void> {
    const settled = await Promise.allSettled([...this.runtimes.values()].map(async r => (await r).close()))
    this.identity.close(); await this.lock.close(); await unlink(join(this.config.dataPath, 'gateway.lock'))
    const failed = settled.find(r => r.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  private runtime(space: Space): Promise<SpaceRuntime> {
    let runtime = this.runtimes.get(space.id)
    if (!runtime) {
      runtime = this.factory(this.config.dataPath, space, this.config.retrieval?.[space.id])
      this.runtimes.set(space.id, runtime)
      runtime.catch(() => this.runtimes.delete(space.id))
    }
    return runtime
  }
  private session(req: IncomingMessage): Session {
    const session = this.identity.session(readCookie(req))
    if (!session) throw new AccessError(401, '登录已失效，请回到空间列表重新登录；当前草稿请先复制保存')
    return session
  }
  private verifyOrigin(req: IncomingMessage): void {
    if (req.headers.origin !== this.config.publicOrigin) throw new AccessError(403, '请求来源不匹配，请从配置的网址打开工作台')
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AccessError(403, '不允许跨站请求')
  }
  private csrf(req: IncomingMessage, session: Session): void {
    this.verifyOrigin(req)
    if (req.headers['x-pkw-csrf'] !== session.csrf) throw new AccessError(403, '会话校验已失效，请重新登录；请先保留草稿')
  }
  private cookie(res: ServerResponse, token: string, clear = false): void {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/pkw; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${this.origin.protocol === 'https:' ? '; Secure' : ''}`)
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'")
    try {
      if (req.headers.host !== this.origin.host) throw new AccessError(403, '访问域名与服务器配置不匹配')
      const path = new URL(req.url ?? '/', this.config.publicOrigin).pathname
      if (req.method === 'GET' && (path === '/pkw' || path === '/pkw/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderPortal()); return
      }
      if (req.method === 'GET' && path === '/pkw/session') {
        const session = this.session(req)
        json(res, 200, { ok: true, value: { username: session.username, csrf: session.csrf, spaces: this.identity.spaces(session.id) } }); return
      }
      if (req.method === 'POST' && ['/pkw/login','/pkw/register'].includes(path)) {
        this.verifyOrigin(req)
        const input = await body(req, 8192)
        if (path === '/pkw/register') {
          await this.identity.register(input.token, input.username, input.password)
          json(res, 200, { ok: true, value: { registered: true } }); return
        }
        const { token } = await this.identity.login(input.username, input.password)
        this.cookie(res, token); json(res, 200, { ok: true, value: { loggedIn: true } }); return
      }
      const session = this.session(req)
      if (req.method === 'POST' && path === '/pkw/share') {
        this.csrf(req, session)
        const input = await body(req, 8192)
        const assertActive = () => { this.csrf(req, this.session(req)) }
        assertActive()
        const value = await withRequestActor(session.id, () => {
          if (input.action === 'preview') return this.sharing.preview(session.id, { sourceSpaceId: String(input.sourceSpaceId ?? ''), targetSpaceId: String(input.targetSpaceId ?? ''), noteId: String(input.noteId ?? '') }, assertActive)
          if (input.action === 'commit') return this.sharing.commit(session.id, String(input.token ?? ''), assertActive)
          throw new AccessError(400, '未知的分享操作')
        })
        json(res, 200, { ok: true, value }); return
      }
      if (req.method === 'POST' && path === '/pkw/manage') {
        this.csrf(req, session)
        const input = await body(req, 8192), spaceId = String(input.spaceId ?? ''), target = String(input.userId ?? '')
        this.csrf(req, this.session(req))
        let value: unknown = {}
        switch (input.action) {
          case 'logout': this.identity.logout(session); this.cookie(res, '', true); break
          case 'password': await this.identity.changePassword(session, input.previous, input.password); this.cookie(res, '', true); break
          case 'createTeam': value = this.identity.createTeam(session.id, input.name); break
          case 'members': value = this.identity.members(session.id, spaceId); break
          case 'invite': value = this.identity.invite(session.id, spaceId, input.role); break
          case 'revokeInvites': this.identity.revokeInvites(session.id, spaceId); break
          case 'accept': this.identity.accept(session.id, input.token); break
          case 'setRole': this.identity.setRole(session.id, spaceId, target, input.role); break
          case 'transfer': this.identity.transfer(session.id, spaceId, target); break
          case 'audit': value = this.identity.auditLog(session.id, spaceId); break
          default: throw new AccessError(400, '未知的管理操作')
        }
        json(res, 200, { ok: true, value }); return
      }
      const match = /^\/pkw\/spaces\/(sp_[a-f0-9]{32})(\/.*)?$/.exec(path)
      if (!match) throw new AccessError(404, '页面不存在')
      let space = this.identity.authorize(session.id, match[1]!)
      if (req.method === 'POST' && match[2] === '/api') {
        this.csrf(req, session)
        const input = await body(req, 32 * 1024 * 1024)
        const method = typeof input.method === 'string' ? input.method : ''
        if (input.args !== undefined && (!input.args || typeof input.args !== 'object' || Array.isArray(input.args))) throw new AccessError(400, '接口参数必须为对象')
        this.csrf(req, this.session(req))
        space = this.identity.authorize(session.id, space.id)
        const permission = authorizeRpc(space.role, method)
        const runtime = await this.runtime(space)
        // A role can change during request upload or runtime startup.
        this.csrf(req, this.session(req))
        space = this.identity.authorize(session.id, space.id); authorizeRpc(space.role, method)
        const args = (input.args ?? {}) as Record<string, unknown>
        if (['saveNote', 'saveNoteBody', 'updateTask'].includes(method) && (typeof args.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedContentHash))) throw new AccessError(409, '请先重新读取当前版本，再提交保存；多人空间不允许无版本保护的覆盖')
        const result = await withRequestActor(session.id, () => runtime.web.call(method, args))
        if (permission !== 'read') this.identity.recordAction(session.id, space.id, 'rpc.' + method, '')
        json(res, 200, { ok: true, value: result }); return
      }
      if (req.method !== 'GET') throw new AccessError(405, '此地址不支持该请求方式')
      const runtime = await this.runtime(space)
      this.session(req)
      this.identity.authorize(session.id, space.id)
      const route = runtime.routes.find(r => routeMatches(r, path))
      if (!route || path.endsWith('/api')) throw new AccessError(404, '页面不存在')
      await route.handler(req, res)
    } catch (error) {
      if (res.headersSent) { res.destroy(); return }
      const code = (error as { code?: unknown })?.code
      if (code === 'PKW_NOTE_CONFLICT' || code === 'PKW_TASK_CONFLICT') {
        json(res, 409, { ok: false, code, error: error instanceof Error ? error.message : '资料已更新，请保留草稿后重新读取' }); return
      }
      const status = error instanceof AccessError ? error.status : 400
      json(res, status, { ok: false, code: status === 401 ? 'PKW_AUTH_REQUIRED' : status === 403 ? 'PKW_FORBIDDEN' : 'PKW_REQUEST_FAILED', error: error instanceof AccessError ? error.message : '操作未完成，请保留草稿并检查当前资料状态，或联系服务器管理员' })
    }
  }
}

/** Configure this module as the sole /pkw host plugin. */
export class PkwCollaborationService extends Service {
  static inject = ['webServer']
  static Config: z<CollaborationConfig> = z.object({
    dataPath: z.string(), publicOrigin: z.string(), bootstrapUsername: z.string().default(''), bootstrapPasswordEnv: z.string().default('PKW_BOOTSTRAP_PASSWORD'),
    retrieval: z.dict(z.object({ baseUrl: z.string(), kbId: z.string(), apiKeyEnv: z.string() })).default({}),
  })
  constructor(ctx: Context, private readonly config: CollaborationConfig) { super(ctx, 'pkwCollaboration') }
  protected async [Service.init](): Promise<void> {
    // An existing exact legacy route would outrank our prefix: claim both to fail on coexistence.
    let gateway: CollaborationGateway | undefined
    const handler = (req: IncomingMessage, res: ServerResponse) => gateway ? gateway.handle(req, res) : json(res, 503, { ok: false, error: '空间服务正在启动' })
    this.ctx.effect(() => this.ctx.webServer.register({ kind: 'exact', path: '/pkw', handler }), 'pkw.collaboration.page')
    this.ctx.effect(() => this.ctx.webServer.register({ kind: 'exact', path: '/pkw/api', handler }), 'pkw.collaboration.legacyDeny')
    this.ctx.effect(() => this.ctx.webServer.register({ kind: 'prefix', path: '/pkw', handler }), 'pkw.collaboration.gateway')
    gateway = await CollaborationGateway.open(this.config)
    this.ctx.effect(() => () => gateway!.close(), 'pkw.collaboration.close')
  }
}
export default PkwCollaborationService

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'

export type Role = 'owner' | 'admin' | 'editor' | 'viewer'
export interface Space { id: string; name: string; kind: 'private' | 'team'; ownerId: string }
export interface Account { id: string; username: string }
export interface Session extends Account { csrf: string; tokenHash: string; expiresAt: number }
export const SESSION_LIFETIME_MS = 12 * 60 * 60_000
export const REMEMBERED_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000
export class AccessError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const secret = (): string => randomBytes(32).toString('base64url')
const id = (prefix: string): string => prefix + '_' + randomUUID().replaceAll('-', '')
const normalizeUsername = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(value)) throw new AccessError(400, '账号应为 3–64 位字母、数字、点、横线或下划线')
  return value.toLowerCase()
}
const label = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new AccessError(400, '名称应为 1–80 个字符')
  return value.trim()
}
const roleValue = (value: unknown): Role => {
  if (!['owner', 'admin', 'editor', 'viewer'].includes(String(value))) throw new AccessError(400, '无效角色')
  return value as Role
}
const passwordValue = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 15 || Buffer.byteLength(value) > 1024) throw new AccessError(400, '密码至少 15 个字符，且不超过 1024 字节；可以使用长短语')
  return value
}
// OWASP scrypt profile: N=2^17, r=8, p=1. One worker per identity store bounds memory.
async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key)))
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  return `scrypt-v1:${salt}:${(await derive(passwordValue(password), salt)).toString('hex')}`
}
async function verifyPassword(password: unknown, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false
  const [format, salt, hash] = stored.split(':')
  if (format !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error('Unsupported password record')
  return timingSafeEqual(await derive(password, salt!), Buffer.from(hash!, 'hex'))
}

/** Durable identity/authorization store. Content lives in independent per-space databases. */
export class IdentityStore {
  private readonly db: DatabaseSync
  private hashing = false
  private readonly attempts = new Map<string, { count: number; until: number }>()
  private constructor(path: string, private readonly now: () => number) {
    if (existsSync(path)) {
      const probe = new DatabaseSync(path, { readOnly: true })
      try {
        const version = Number(probe.prepare('PRAGMA user_version').get()!.user_version)
        const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name)).sort()
        const expected = ['accounts','audit','invitations','members','sessions','spaces']
        if ((version !== 0 && version !== 1) || (version === 0 && tables.length) || (version === 1 && JSON.stringify(tables) !== JSON.stringify(expected))) throw new Error('Unsupported identity schema; source database was not opened for writing')
        if (version === 1) {
          const columns: Record<string, string[]> = { accounts: ['id','username','password'], audit: ['sequence','at','actor','spaceId','action','subject'], invitations: ['hash','spaceId','role','createdBy','expires'], members: ['spaceId','userId','role'], sessions: ['hash','userId','csrf','expires','seen'], spaces: ['id','name','kind','ownerId'] }
          for (const [table, names] of Object.entries(columns)) {
            const actual = probe.prepare(`PRAGMA table_info("${table}")`).all().map(row => String(row.name))
            if (JSON.stringify(actual) !== JSON.stringify(names)) throw new Error('Unsupported identity schema columns; source database was not opened for writing')
          }
        }
      } finally { probe.close() }
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('Unsupported identity schema; preserve the database and use a supported migration') }
    if (!version) {
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) { this.db.close(); throw new Error('Refusing to initialize an unknown database') }
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE accounts(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
        CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('private','team')), ownerId TEXT NOT NULL REFERENCES accounts(id));
        CREATE UNIQUE INDEX one_private_space ON spaces(ownerId) WHERE kind='private';
        CREATE TABLE members(spaceId TEXT NOT NULL REFERENCES spaces(id), userId TEXT NOT NULL REFERENCES accounts(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')), PRIMARY KEY(spaceId,userId));
        CREATE TABLE invitations(hash TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES spaces(id), role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), createdBy TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
        CREATE TABLE sessions(hash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES accounts(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL, seen INTEGER NOT NULL);
        CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, spaceId TEXT, action TEXT NOT NULL, subject TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`)
    }
  }
  static async open(path: string, now: () => number = Date.now): Promise<IdentityStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const store = new IdentityStore(path, now)
    await chmod(path, 0o600)
    return store
  }
  close(): void { this.db.close() }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private async expensive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.hashing) throw new AccessError(429, '正在处理登录，请稍后再试')
    this.hashing = true
    try { return await fn() } finally { this.hashing = false }
  }
  private audit(actor: string, action: string, subject: string, spaceId: string | null = null): void {
    this.db.prepare('INSERT INTO audit(at,actor,spaceId,action,subject) VALUES(?,?,?,?,?)').run(this.now(), actor, spaceId, action, subject)
  }
  private insertAccount(username: string, password: string): Account {
    if (this.db.prepare('SELECT 1 FROM accounts WHERE username=?').get(username)) throw new AccessError(409, '该账号已存在，请登录后接受邀请')
    const account = { id: id('usr'), username }
    this.db.prepare('INSERT INTO accounts VALUES(?,?,?)').run(account.id, username, password)
    const privateId = id('sp')
    this.db.prepare('INSERT INTO spaces VALUES(?,?,?,?)').run(privateId, '我的私人空间', 'private', account.id)
    this.db.prepare('INSERT INTO members VALUES(?,?,?)').run(privateId, account.id, 'owner')
    this.audit(account.id, 'account.created', account.id, privateId)
    return account
  }
  isInitialized(): boolean { return !!this.db.prepare('SELECT 1 FROM accounts LIMIT 1').get() }
  async bootstrap(username: string, password: string): Promise<void> {
    if (this.isInitialized()) return
    const normalized = normalizeUsername(username)
    const hash = await this.expensive(() => hashPassword(password))
    this.transaction(() => { if (!this.isInitialized()) this.insertAccount(normalized, hash) })
  }
  async login(username: unknown, password: unknown, rememberMe: unknown = false): Promise<{ token: string; session: Session }> {
    if (typeof rememberMe !== 'boolean') throw new AccessError(400, '保持登录选项必须为是或否')
    const normalized = normalizeUsername(username)
    const now = this.now()
    // Bound unauthenticated state. Each bucket expires even when the account doesn't exist.
    for (const [key, bucket] of this.attempts) if (bucket.until <= now) this.attempts.delete(key)
    const bucket = this.attempts.get(normalized) ?? { count: 0, until: now + 15 * 60_000 }
    if (bucket.count >= 5 || (this.attempts.size >= 1000 && !this.attempts.has(normalized))) throw new AccessError(429, '尝试次数过多，请 15 分钟后再试')
    bucket.count++; this.attempts.set(normalized, bucket)
    const row = this.db.prepare('SELECT * FROM accounts WHERE username=?').get(normalized) as (Account & { password: string }) | undefined
    // An absent account takes the same expensive path, with a valid dummy record.
    const dummy = 'scrypt-v1:' + '0'.repeat(32) + ':' + '0'.repeat(64)
    const valid = await this.expensive(() => verifyPassword(password, row?.password ?? dummy))
    if (!row || !valid) throw new AccessError(401, '账号或密码不正确')
    this.attempts.delete(normalized)
    return this.newSession(row, rememberMe)
  }
  private newSession(account: Account, rememberMe: boolean): { token: string; session: Session } {
    const token = secret(), csrf = secret(), now = this.now(), tokenHash = digest(token)
    const expiresAt = now + (rememberMe ? REMEMBERED_SESSION_LIFETIME_MS : SESSION_LIFETIME_MS)
    this.transaction(() => {
      // A reading pause is not a logout. Persist the chosen absolute deadline;
      // opening another device must not purge a still-valid inactive session.
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now)
      // Bound session storage per user; logging in never reuses a caller-supplied token.
      this.db.prepare('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE userId=? ORDER BY seen DESC LIMIT -1 OFFSET 9)').run(account.id)
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(tokenHash, account.id, csrf, expiresAt, now)
      this.audit(account.id, 'session.created', account.id)
    })
    return { token, session: { id: account.id, username: account.username, csrf, tokenHash, expiresAt } }
  }
  session(token: string | undefined): Session | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return
    const now = this.now(), hash = digest(token)
    const row = this.db.prepare('SELECT accounts.id,accounts.username,sessions.csrf,sessions.hash AS tokenHash,sessions.expires AS expiresAt FROM sessions JOIN accounts ON accounts.id=sessions.userId WHERE sessions.hash=? AND expires>?').get(hash, now) as unknown as Session | undefined
    // Seen is only for the device limit, not an idle-expiry timer. Avoid a FULL
    // synchronous SQLite write for every background poll / authorization check.
    if (row) this.db.prepare('UPDATE sessions SET seen=? WHERE hash=? AND seen<=?').run(now, hash, now - 5 * 60_000)
    return row
  }
  logout(session: Session): void {
    this.transaction(() => { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(session.tokenHash); this.audit(session.id, 'session.revoked', session.id) })
  }
  async changePassword(session: Session, previous: unknown, next: unknown): Promise<void> {
    const row = this.db.prepare('SELECT password FROM accounts WHERE id=?').get(session.id)!
    await this.expensive(async () => {
      if (!await verifyPassword(previous, String(row.password))) throw new AccessError(401, '当前密码不正确')
      const hash = await hashPassword(passwordValue(next))
      this.transaction(() => {
        if (!this.db.prepare('SELECT 1 FROM sessions WHERE hash=? AND userId=? AND expires>?').get(session.tokenHash, session.id, this.now())) throw new AccessError(401, '当前会话已失效，请重新登录')
        this.db.prepare('UPDATE accounts SET password=? WHERE id=?').run(hash, session.id)
        this.db.prepare('DELETE FROM sessions WHERE userId=?').run(session.id)
        this.audit(session.id, 'password.changed', session.id)
      })
    })
  }
  /** Offline, server-operator recovery only; never exposed through the HTTP dispatcher. */
  async resetPassword(username: string, next: string): Promise<void> {
    const user = this.db.prepare('SELECT id FROM accounts WHERE username=?').get(normalizeUsername(username))
    if (!user) throw new AccessError(404, '账号不存在')
    const hash = await this.expensive(() => hashPassword(passwordValue(next)))
    this.transaction(() => {
      this.db.prepare('UPDATE accounts SET password=? WHERE id=?').run(hash, user.id!)
      this.db.prepare('DELETE FROM sessions WHERE userId=?').run(user.id!)
      this.audit('local-operator', 'password.recovered', String(user.id))
    })
  }
  spaces(userId: string): Array<Space & { role: Role }> {
    return this.db.prepare("SELECT spaces.*,members.role FROM spaces JOIN members ON members.spaceId=spaces.id WHERE members.userId=? AND (kind='team' OR ownerId=?) ORDER BY kind,name,id").all(userId, userId) as unknown as Array<Space & { role: Role }>
  }
  authorize(userId: string, spaceId: string, allowed: readonly Role[] = ['owner', 'admin', 'editor', 'viewer']): Space & { role: Role } {
    const found = this.spaces(userId).find(space => space.id === spaceId)
    if (!found) throw new AccessError(404, '空间不存在或你没有访问权限')
    if (!allowed.includes(found.role)) throw new AccessError(403, '你的角色不能执行此操作')
    return found
  }
  createTeam(userId: string, name: unknown): Space {
    const space = { id: id('sp'), name: label(name), kind: 'team' as const, ownerId: userId }
    return this.transaction(() => {
      this.db.prepare('INSERT INTO spaces VALUES(?,?,?,?)').run(space.id, space.name, space.kind, userId)
      this.db.prepare('INSERT INTO members VALUES(?,?,?)').run(space.id, userId, 'owner')
      this.audit(userId, 'space.created', space.id, space.id)
      return space
    })
  }
  members(userId: string, spaceId: string): Array<Account & { role: Role }> {
    const space = this.authorize(userId, spaceId, ['owner','admin'])
    if (space.kind !== 'team') throw new AccessError(400, '私人空间不能添加其他成员')
    return this.db.prepare('SELECT accounts.id,accounts.username,members.role FROM members JOIN accounts ON accounts.id=members.userId WHERE spaceId=? ORDER BY username').all(spaceId) as unknown as Array<Account & { role: Role }>
  }
  setRole(userId: string, spaceId: string, targetId: string, requested: unknown): void {
    this.transaction(() => {
      const actor = this.authorize(userId, spaceId, ['owner','admin'])
      if (actor.kind !== 'team') throw new AccessError(400, '私人空间不能更改成员')
      const target = this.authorize(targetId, spaceId)
      const role = requested === null ? null : roleValue(requested)
      if (target.role === 'owner' || role === 'owner') throw new AccessError(400, '所有权请使用转让操作')
      if (actor.role === 'admin' && (target.role === 'admin' || role === 'admin')) throw new AccessError(403, '只有所有者可以管理管理员')
      if (role) this.db.prepare('UPDATE members SET role=? WHERE spaceId=? AND userId=?').run(role, spaceId, targetId)
      else this.db.prepare('DELETE FROM members WHERE spaceId=? AND userId=?').run(spaceId, targetId)
      // Pending invitations granted by a removed/downgraded member cannot outlive authority.
      this.db.prepare('DELETE FROM invitations WHERE spaceId=? AND createdBy=?').run(spaceId, targetId)
      this.audit(userId, role ? 'member.role.' + role : 'member.removed', targetId, spaceId)
    })
  }
  transfer(userId: string, spaceId: string, targetId: string): void {
    this.transaction(() => {
      const space = this.authorize(userId, spaceId, ['owner'])
      if (space.kind !== 'team' || targetId === userId) throw new AccessError(400, '无效的转让目标')
      this.authorize(targetId, spaceId)
      this.db.prepare('UPDATE members SET role=? WHERE spaceId=? AND userId=?').run('admin', spaceId, userId)
      this.db.prepare('UPDATE members SET role=? WHERE spaceId=? AND userId=?').run('owner', spaceId, targetId)
      this.db.prepare('UPDATE spaces SET ownerId=? WHERE id=?').run(targetId, spaceId)
      this.db.prepare('DELETE FROM invitations WHERE spaceId=?').run(spaceId)
      this.audit(userId, 'space.transferred', targetId, spaceId)
    })
  }
  invite(userId: string, spaceId: string, requested: unknown): { token: string; expires: number } {
    const space = this.authorize(userId, spaceId, ['owner','admin']), role = roleValue(requested)
    if (space.kind !== 'team' || role === 'owner' || (role === 'admin' && space.role !== 'owner')) throw new AccessError(403, '不能邀请此角色进入该空间')
    const token = secret(), expires = this.now() + 24 * 60 * 60_000
    this.transaction(() => {
      this.db.prepare('DELETE FROM invitations WHERE expires<=?').run(this.now())
      this.db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?)').run(digest(token), spaceId, role, userId, expires)
      this.audit(userId, 'invitation.created.' + role, digest(token), spaceId)
    })
    return { token, expires }
  }
  revokeInvites(userId: string, spaceId: string): void {
    this.authorize(userId, spaceId, ['owner','admin'])
    this.transaction(() => { this.db.prepare('DELETE FROM invitations WHERE spaceId=?').run(spaceId); this.audit(userId, 'invitations.revoked', spaceId, spaceId) })
  }
  private invitation(token: unknown): { spaceId: string; role: Role; createdBy: string } {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccessError(400, '邀请无效或已过期')
    const row = this.db.prepare('SELECT spaceId,role,createdBy FROM invitations WHERE hash=? AND expires>?').get(digest(token), this.now()) as { spaceId: string; role: Role; createdBy: string } | undefined
    if (!row) throw new AccessError(400, '邀请无效或已过期')
    this.authorize(row.createdBy, row.spaceId, row.role === 'admin' ? ['owner'] : ['owner','admin'])
    return row
  }
  async register(token: unknown, username: unknown, password: unknown): Promise<void> {
    this.invitation(token)
    const normalized = normalizeUsername(username), hash = await this.expensive(() => hashPassword(passwordValue(password)))
    this.transaction(() => {
      this.invitation(token) // Expiry/revocation can change while scrypt is running.
      const user = this.insertAccount(normalized, hash)
      this.acceptLocked(user.id, token as string)
    })
  }
  accept(userId: string, token: unknown): void { this.transaction(() => this.acceptLocked(userId, String(token))) }
  private acceptLocked(userId: string, token: string): void {
    const invitation = this.invitation(token)
    if (this.db.prepare('SELECT 1 FROM members WHERE spaceId=? AND userId=?').get(invitation.spaceId, userId)) throw new AccessError(409, '你已经是该空间的成员')
    this.db.prepare('INSERT INTO members VALUES(?,?,?)').run(invitation.spaceId, userId, invitation.role)
    this.db.prepare('DELETE FROM invitations WHERE hash=?').run(digest(token))
    this.audit(userId, 'invitation.accepted', userId, invitation.spaceId)
  }
  auditLog(userId: string, spaceId: string): unknown[] {
    this.authorize(userId, spaceId, ['owner','admin'])
    return this.db.prepare('SELECT sequence,at,actor,action,subject FROM audit WHERE spaceId=? ORDER BY sequence DESC LIMIT 200').all(spaceId)
  }
  recordAction(userId: string, spaceId: string, action: string, subject: string): void { this.audit(userId, action, subject, spaceId) }
}

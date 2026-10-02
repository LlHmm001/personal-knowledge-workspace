import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { replaceNoteId, splitFrontmatter } from '@deepseek-ai/dsh-pkw-notes'
import { AccessError, type IdentityStore, type Role, type Space } from './identity.ts'
import type { SpaceRuntime } from './runtime.ts'

export interface SharingDependencies {
  identity: IdentityStore
  runtime(space: Space): Promise<SpaceRuntime>
  dataPath: string
  now?: () => number
}
export interface ShareInput { sourceSpaceId: string; targetSpaceId: string; noteId: string }
export interface SharedAttachment { attachmentId: string; filename: string; mimeType: string; sizeBytes: number; sha256: string; indexable: boolean }
export interface SharePreview {
  token: string; expiresAt: string; title: string; body: string; frontmatter: string
  sourceSpaceId: string; targetSpaceId: string; targetName: string
  attachments: SharedAttachment[]; warnings: string[]
}
export interface ShareResult {
  status: 'complete' | 'needs_review'; receiptId: string; targetSpaceId: string
  noteId?: string; relativePath: string; copiedAttachmentIds: string[]; warnings: string[]
}
interface Snapshot {
  title: string; markdown: string; body: string; frontmatter: string; hash: string
  attachments: SharedAttachment[]; bytes: Map<string, string>
}
interface Receipt extends ShareInput {
  schemaVersion: 1; userId: string; createdAt: number; expiresAt: number; targetRole: Role
  sourceHash: string; attachments: SharedAttachment[]; relativePath: string
  state: 'preview' | 'copying' | 'complete' | 'needs_review' | 'invalidated'
  copies: Array<{ sourceId: string; attachmentId: string; filename: string }>
  operation?: { kind: 'upload'; sourceId: string } | { kind: 'createNote' }
  targetNoteId?: string; failure?: 'interrupted' | 'copy_failed' | 'source_changed'
}
const MAX_NOTE = 1024 * 1024, MAX_FILE = 16 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const warnings = [
  '只复制当前笔记的完整正文、元数据（重新生成身份）和下面列出的附件。其他私人笔记、任务、历史与目录不会分享。',
  '目标空间内的全部成员可按其角色阅读或下载副本；以后修改私人原件不会更新团队副本。',
  '正文中的其他笔记链接按目标空间解析，外部链接保持原样；请核对链接和正文是否含有不想公开的信息。',
]
function denied(): never { throw new AccessError(404, '分享预览不存在或你无权访问') }
function changed(): never { throw new AccessError(409, '原笔记或附件已改变，请重新预览后确认分享') }

// Keep offsets unchanged while excluding fenced/inline code from link copying.
function maskCode(text: string): string {
  let fence: { char: string; count: number } | undefined
  return text.split(/(?<=\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence.char && marker.length >= fence.count && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = undefined
      return line.replace(/[^\r\n]/g, ' ')
    }
    if (marker) { fence = { char: marker[0]!, count: marker.length }; return line.replace(/[^\r\n]/g, ' ') }
    return line
  }).join('').replace(/(`+)[^\n]*?\1/g, part => part.replace(/[^\r\n]/g, ' '))
}
interface Link { start: number; end: number; label: string; id: string; suffix: string; title: string }
function managedLinks(body: string): Link[] {
  const masked = maskCode(body), links: Link[] = [], spans: Array<[number, number]> = []
  const re = /(?<!\\)(!?\[[^\]\n]*\])\(([^)\s]+)([ \t]+(?:"[^"\n]*"|'[^'\n]*'))?\)/g
  for (const match of masked.matchAll(re)) {
    const url = match[2]!, managed = /^(?:\.\.\/)*attachments\/(att_[A-Za-z0-9_-]+)\/[^?#]+([?#].*)?$/.exec(url)
    if (managed) {
      links.push({ start: match.index!, end: match.index! + match[0].length, label: body.slice(match.index!, match.index! + match[1]!.length), id: managed[1]!, suffix: managed[2] ?? '', title: match[3] ?? '' })
      spans.push([match.index!, match.index! + match[0].length])
    } else if (/^(https?:|mailto:)/i.test(url)) spans.push([match.index!, match.index! + match[0].length])
  }
  let remaining = masked
  for (const [start, end] of spans.reverse()) remaining = remaining.slice(0, start) + ' '.repeat(end - start) + remaining.slice(end)
  // The canonical parser cannot reliably enumerate reference-style/HTML links.
  // Reject them explicitly instead of silently leaving an uncopied private asset.
  if (/(?:\battachments\/|\/pkw\/(?:spaces\/[^/]+\/)?attachment\/)/.test(remaining)) throw new AccessError(400, '发现当前无法安全复制的附件链接格式。请先将附件改为标准 Markdown 图片或文件链接，再重新预览')
  return links
}
function rewrite(markdown: string, copies: Receipt['copies']): string {
  const { frontmatterRaw, body } = splitFrontmatter(markdown.replace(/^\uFEFF/, ''))
  let transformed = body
  const mapping = new Map(copies.map(copy => [copy.sourceId, copy]))
  for (const link of managedLinks(body).reverse()) {
    const copy = mapping.get(link.id)
    if (!copy) throw new Error('Missing copied attachment mapping')
    const encoded = encodeURIComponent(copy.filename).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
    transformed = transformed.slice(0, link.start) + `${link.label}(../attachments/${copy.attachmentId}/${encoded}${link.suffix}${link.title})` + transformed.slice(link.end)
  }
  for (const copy of copies) transformed = transformed.replaceAll(`<!-- pkw:attachment-summary:start ${copy.sourceId} -->`, `<!-- pkw:attachment-summary:start ${copy.attachmentId} -->`)
  return replaceNoteId(frontmatterRaw ? frontmatterRaw + '\n' + transformed : transformed, '__placeholder_share__')
}

/** Explicit private→team copy. A durable journal never blindly repeats a side effect. */
export class SharingService {
  private readonly active = new Set<string>()
  private readonly now: () => number
  constructor(private readonly deps: SharingDependencies) { this.now = deps.now ?? Date.now }
  private authorize(userId: string, input: ShareInput, expectedRole?: Role): Role {
    const source = this.deps.identity.authorize(userId, input.sourceSpaceId, ['owner'])
    const target = this.deps.identity.authorize(userId, input.targetSpaceId, ['owner', 'admin', 'editor'])
    if (source.kind !== 'private' || source.ownerId !== userId || target.kind !== 'team' || source.id === target.id) throw new AccessError(403, '只能把本人私人空间的笔记复制到有编辑权限的团队空间')
    if (expectedRole !== undefined && target.role !== expectedRole) throw new AccessError(409, '目标空间角色已改变，请重新预览并确认分享范围')
    return target.role
  }
  private async directory(): Promise<string> {
    const root = resolve(this.deps.dataPath), directory = join(root, 'shares')
    for (const path of [root, directory]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('Invalid sharing receipt directory')
    }
    return directory
  }
  private async persist(directory: string, key: string, receipt: Receipt, fresh = false): Promise<void> {
    const path = join(directory, key + '.json'), temporary = join(directory, key + '.' + randomBytes(8).toString('hex') + '.tmp')
    const file = await open(fresh ? path : temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(receipt)); await file.sync() } finally { await file.close() }
    if (!fresh) await rename(temporary, path)
    const dir = await open(directory, 'r')
    try { await dir.sync() } finally { await dir.close() }
  }
  private async receipt(userId: string, token: string): Promise<{ directory: string; key: string; receipt: Receipt }> {
    if (!TOKEN.test(token)) denied()
    const directory = await this.directory(), key = sha(token), path = join(directory, key + '.json')
    let receipt: Receipt
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > 256 * 1024) denied()
      receipt = JSON.parse(await readFile(path, 'utf8')) as Receipt
    } catch { denied() }
    if (!receipt! || receipt!.schemaVersion !== 1 || receipt!.userId !== userId
      || !['preview', 'copying', 'complete', 'needs_review', 'invalidated'].includes(receipt!.state)
      || !Array.isArray(receipt!.copies) || !Array.isArray(receipt!.attachments)
      || receipt!.attachments.length > 40 || receipt!.copies.length > 40
      || typeof receipt!.noteId !== 'string' || !receipt!.noteId
      || !/^[a-f0-9]{64}$/.test(receipt!.sourceHash)
      || !/^shared-[a-f0-9]{32}\.md$/.test(receipt!.relativePath)
      || !Number.isFinite(receipt!.expiresAt)) denied()
    this.authorize(userId, receipt!, receipt!.targetRole)
    return { directory, key, receipt: receipt! }
  }
  private async snapshot(runtime: SpaceRuntime, noteId: string, check: () => void): Promise<Snapshot> {
    check()
    const raw = await runtime.web.call('getNote', { noteId }) as { note: { noteId: string; title: string; contentHash: string }; markdown: string; body: string; frontmatter: string; attachments: Array<{ attachmentId: string }> }
    check()
    if (raw.note.noteId !== noteId || typeof raw.markdown !== 'string' || sha(raw.markdown.replace(/\r\n/g, '\n')) !== raw.note.contentHash) throw new Error('Invalid canonical note snapshot')
    if (Buffer.byteLength(raw.markdown) > MAX_NOTE) throw new AccessError(413, '单次分享的笔记正文不能超过 1 MiB，请拆分笔记后重试')
    const links = managedLinks(raw.body), ids = [...new Set(links.map(link => link.id))]
    // Verify that the source service and copy scanner agree about asset scope.
    if (raw.attachments.some(ref => !ids.includes(ref.attachmentId))) throw new AccessError(400, '附件引用范围无法准确确认，请整理为标准 Markdown 链接后重试')
    if (ids.length > 40) throw new AccessError(413, '单次最多分享 40 个引用附件，请拆分笔记后重试')
    const attachments: SharedAttachment[] = [], bytes = new Map<string, string>(); let total = 0
    for (const attachmentId of ids) {
      const metadata = await runtime.web.call('getAttachment', { attachmentId }) as { attachment: { filename: string; indexable: boolean } }; check()
      const file = await runtime.web.call('downloadAttachment', { attachmentId }) as { attachmentId: string; filename: string; mimeType: string; contentBase64: string }; check()
      if (file.attachmentId !== attachmentId || file.filename !== metadata.attachment.filename || typeof file.contentBase64 !== 'string') throw new Error('Invalid attachment snapshot')
      const content = Buffer.from(file.contentBase64, 'base64'); total += content.length
      if (content.length > MAX_FILE || total > MAX_TOTAL) throw new AccessError(413, '分享附件限每个 16 MiB、合计 32 MiB，请拆分后重试')
      attachments.push({ attachmentId, filename: file.filename, mimeType: file.mimeType, sizeBytes: content.length, sha256: sha(content), indexable: metadata.attachment.indexable !== false })
      bytes.set(attachmentId, content.toString('base64'))
    }
    const latest = await runtime.web.call('getNote', { noteId }) as { markdown: string }; check()
    if (sha(latest.markdown) !== sha(raw.markdown)) changed()
    return { title: raw.note.title, markdown: raw.markdown, body: raw.body, frontmatter: raw.frontmatter, hash: sha(raw.markdown), attachments, bytes }
  }
  async preview(userId: string, input: ShareInput, assertActive: () => void = () => {}): Promise<SharePreview> {
    const targetRole = this.authorize(userId, input), check = () => { assertActive(); this.authorize(userId, input, targetRole) }
    check()
    const source = await this.deps.runtime(this.deps.identity.authorize(userId, input.sourceSpaceId)); check()
    const snapshot = await this.snapshot(source, input.noteId, check)
    const token = randomBytes(32).toString('base64url'), key = sha(token), now = this.now(), expiresAt = now + 10 * 60_000
    const directory = await this.directory(); check()
    // Receipts hold hashes and identities, never raw private note content/bytes.
    await this.persist(directory, key, { schemaVersion: 1, ...input, userId, createdAt: now, expiresAt, targetRole, sourceHash: snapshot.hash, attachments: snapshot.attachments, relativePath: 'shared-' + randomBytes(16).toString('hex') + '.md', state: 'preview', copies: [] }, true)
    check()
    return { token, expiresAt: new Date(expiresAt).toISOString(), title: snapshot.title, body: snapshot.body, frontmatter: snapshot.frontmatter, sourceSpaceId: input.sourceSpaceId, targetSpaceId: input.targetSpaceId, targetName: this.deps.identity.authorize(userId, input.targetSpaceId).name, attachments: snapshot.attachments, warnings: [...warnings] }
  }
  private result(key: string, receipt: Receipt): ShareResult {
    return { status: receipt.state === 'complete' ? 'complete' : 'needs_review', receiptId: key, targetSpaceId: receipt.targetSpaceId, noteId: receipt.targetNoteId, relativePath: receipt.relativePath, copiedAttachmentIds: receipt.copies.map(copy => copy.attachmentId), warnings: receipt.state === 'complete' ? ['已复制独立副本，私人原件保持不变。重复确认只返回这次结果。'] : ['复制未确认完成，私人原件保持不变。为避免生成重复附件，此凭据不会自动重试。请将记录编号交给管理员，核对目标文件路径及已确认附件后，再决定保留或移入回收站；尚未确认的最后一步也可能已经执行。'] }
  }
  async commit(userId: string, token: string, assertActive: () => void = () => {}): Promise<ShareResult> {
    assertActive()
    const { directory, key, receipt } = await this.receipt(userId, token)
    const check = () => { assertActive(); this.authorize(userId, receipt, receipt.targetRole) }
    check()
    if (receipt.state === 'complete' || receipt.state === 'needs_review') return this.result(key, receipt)
    if (receipt.state === 'invalidated') changed()
    if (this.active.has(key)) throw new AccessError(409, '这次分享正在处理，请等待结果')
    if (receipt.state === 'copying') {
      // A different in-process instance may still hold the lock. Interpret the
      // durable state conservatively without overwriting another writer's journal.
      return this.result(key, { ...receipt, state: 'needs_review', failure: 'interrupted' })
    }
    if (receipt.expiresAt <= this.now()) throw new AccessError(409, '分享预览已过期，请重新预览后确认')
    // A process crash leaves the exclusive lock and write-ahead receipt in place.
    // Another service instance must not silently replay an uncertain mutation.
    this.active.add(key)
    let lock
    try { lock = await open(join(directory, key + '.lock'), 'wx', 0o600) }
    catch { this.active.delete(key); throw new AccessError(409, '分享记录处于待核对状态，请交由管理员核对，不要重复创建副本。记录编号：' + key) }
    try {
      check()
      const source = await this.deps.runtime(this.deps.identity.authorize(userId, receipt.sourceSpaceId)); check()
      let snapshot: Snapshot
      try { snapshot = await this.snapshot(source, receipt.noteId, check) }
      catch {
        check() // Preserve session/permission denial rather than disguising it.
        receipt.state = 'invalidated'; await this.persist(directory, key, receipt); changed()
      }
      if (snapshot.hash !== receipt.sourceHash || JSON.stringify(snapshot.attachments) !== JSON.stringify(receipt.attachments)) {
        receipt.state = 'invalidated'; await this.persist(directory, key, receipt); changed()
      }
      const target = await this.deps.runtime(this.deps.identity.authorize(userId, receipt.targetSpaceId)); check()
      receipt.state = 'copying'; await this.persist(directory, key, receipt); check()
      for (const attachment of snapshot.attachments) {
        receipt.operation = { kind: 'upload', sourceId: attachment.attachmentId }
        await this.persist(directory, key, receipt); check()
        const uploaded = await target.web.call('uploadAttachment', { filename: attachment.filename, mimeType: attachment.mimeType, indexable: attachment.indexable, contentBase64: snapshot.bytes.get(attachment.attachmentId)! }) as { attachmentId: string; filename: string }
        if (!/^att_[A-Za-z0-9_-]+$/.test(uploaded.attachmentId) || typeof uploaded.filename !== 'string') throw new Error('Invalid copied attachment identity')
        receipt.copies.push({ sourceId: attachment.attachmentId, attachmentId: uploaded.attachmentId, filename: uploaded.filename }); delete receipt.operation
        await this.persist(directory, key, receipt); check()
      }
      // A user may continue editing while uploads run. Never silently copy a
      // source revision that differs from the explicitly confirmed preview.
      const latest = await this.snapshot(source, receipt.noteId, check)
      if (latest.hash !== receipt.sourceHash || JSON.stringify(latest.attachments) !== JSON.stringify(receipt.attachments)) changed()
      const markdown = rewrite(snapshot.markdown, receipt.copies)
      receipt.operation = { kind: 'createNote' }; await this.persist(directory, key, receipt); check()
      const created = await target.web.call('createNote', { relativePath: receipt.relativePath, markdown }) as { noteId: string; relativePath: string }
      if (typeof created.noteId !== 'string' || created.noteId === receipt.noteId || created.relativePath !== receipt.relativePath) throw new Error('Invalid copied note identity')
      receipt.targetNoteId = created.noteId; delete receipt.operation; receipt.state = 'complete'
      await this.persist(directory, key, receipt); check()
      return this.result(key, receipt)
    } catch (error) {
      if (receipt.state === 'copying') {
        receipt.state = 'needs_review'; receipt.failure = error instanceof AccessError && error.status === 409 ? 'source_changed' : 'copy_failed'
        await this.persist(directory, key, receipt)
        check() // A revoked session/member receives no details of team copies.
        return this.result(key, receipt)
      }
      throw error
    } finally {
      this.active.delete(key); await lock.close(); await unlink(join(directory, key + '.lock'))
    }
  }
}

/**
 * PKW Markdown Notes core (`ctx.pkwNotes`).
 *
 * Markdown file = content source of truth; NoteIndex = rebuildable projection;
 * Durable History = `ctx.pkwEvents`. Reconcile is the correctness mechanism and
 * is idempotent via a deterministic operation id derived from the observed-state
 * transition (a state already durable-observed is repaired, not re-emitted).
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import {
  AttachmentId,
  NOTE_CREATED,
  NOTE_DELETED,
  NOTE_DISCOVERED,
  NOTE_IDENTITY_CONFLICT,
  NOTE_MOVED,
  NOTE_UPDATED,
  NoteId,
  OperationId,
  noteDomainSpec,
  type CreateNoteInput,
  type NoteDocument,
  type NoteIdentityConflict,
  type NoteIndexRecord,
  type NoteListFilter,
  type PkwNotesService,
  type ReconcileReport,
} from '@deepseek-ai/dsh-pkw-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceHandle } from '@deepseek-ai/dsh-pkw-workspace'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pkwNotes: PkwNotesService
  }
}

export interface Config {
  workspaceId: string
}

const NOTE_AGG = 'note'

/** Hidden marker file written to force an empty directory to exist in the workspace tree. */
const FOLDER_MARKER = '.pkw-folder'

/** Manual-order child identity: note → NoteId, folder → basename within its parent. */
export interface OrderChild {
  kind: 'note' | 'folder'
  id: string
}

interface OrderRecord {
  workspaceId: WorkspaceId
  parentPath: string
  children: OrderChild[]
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function noteFingerprint(workspaceId: string, noteId: string, relativePath: string, contentHash: string, deleted: boolean): string {
  return sha256(`${workspaceId}\u0000${noteId}\u0000${relativePath}\u0000${contentHash}\u0000${deleted ? '1' : '0'}`)
}

function contentHash(markdown: string): string {
  return sha256(markdown.replace(/\r\n/g, '\n'))
}

interface NoteEventPayload {
  noteId: string
  afterStateFingerprint: string
  beforeStateFingerprint?: string
  relativePath?: string
  fromPath?: string
  toPath?: string
  contentHash?: string
  observedRevision?: number
  paths?: string[]
}

export class NotesService extends Service {
  static inject = ['pkwWorkspace', 'fs', 'pkwEvents', 'storageDomain']
  static Config: z<Config> = z.object({ workspaceId: z.string() })

  private handle!: WorkspaceHandle
  private table?: KvTable<NoteId, NoteIndexRecord>
  private paths?: KvTable<string, NoteId>
  private order?: KvTable<string, OrderRecord>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwNotes')
  }

  protected async [Service.init](): Promise<void> {
    const handle = this.ctx.pkwWorkspace.forWorkspace(WorkspaceId(this.config.workspaceId))
    if (handle === undefined) throw new Error(`pkwNotes: workspace '${this.config.workspaceId}' is not registered`)
    this.handle = handle
    const domain: Domain<typeof noteDomainSpec> = await this.ctx.storageDomain.open(noteDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'pkw.notesDomainClose')
    this.table = domain.table('note_index')
    this.paths = domain.table('note_paths')
    this.order = domain.table('note_order')
  }

  private requireTable(): KvTable<NoteId, NoteIndexRecord> {
    if (this.table === undefined) throw new Error('pkwNotes is not started yet')
    return this.table
  }

  private requirePaths(): KvTable<string, NoteId> {
    if (this.paths === undefined) throw new Error('pkwNotes is not started yet')
    return this.paths
  }

  private requireOrder(): KvTable<string, OrderRecord> {
    if (this.order === undefined) throw new Error('pkwNotes is not started yet')
    return this.order
  }

  list(filter: NoteListFilter = {}): NoteIndexRecord[] {
    const out: NoteIndexRecord[] = []
    for (const [, record] of this.requireTable().entries()) {
      if (!(filter.includeDeleted === true) && record.deletedAt !== undefined) continue
      if (filter.tag !== undefined && !record.tags.includes(filter.tag)) continue
      out.push(record)
    }
    return out
  }

  get(noteId: NoteId): NoteIndexRecord | undefined {
    return this.requireTable().get(noteId)
  }

  async getDocument(noteId: NoteId): Promise<NoteDocument> {
    const record = this.requireTable().get(noteId)
    if (record === undefined) throw new Error(`pkwNotes: unknown note '${noteId}'`)
    const markdown = await this.ctx.fs.readText(await this.ctx.fs.resolve(this.handle.notePath(record.relativePath)))
    const attachments = collectManagedLinks(record.workspaceId, markdown)
    return { note: record, markdown, attachments }
  }

  resolveByPath(relativePath: string): NoteIndexRecord | undefined {
    const id = this.requirePaths().get(relativePath)
    if (id === undefined) return undefined
    return this.requireTable().get(id)
  }

  async create(input: CreateNoteInput): Promise<NoteIndexRecord> {
    const { parseFrontmatter, injectNoteId, deriveTitle } = await import('./frontmatter.ts')
    const parsed = parseFrontmatter(input.markdown)
    let markdown = input.markdown
    let noteIdStr = parsed.frontmatter.id
    if (noteIdStr === undefined || noteIdStr === '') {
      noteIdStr = `note_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      markdown = injectNoteId(input.markdown, noteIdStr)
    }
    const noteId = NoteId(noteIdStr)
    await this.ctx.fs.writeText(
      await this.ctx.fs.resolve(this.handle.notePath(input.relativePath)),
      markdown,
      { kind: 'createIfAbsent' },
    )
    const hash = contentHash(markdown)
    const now = new Date().toISOString()
    const payload: NoteEventPayload = {
      noteId: noteIdStr,
      relativePath: input.relativePath,
      contentHash: hash,
      observedRevision: 1,
      afterStateFingerprint: noteFingerprint(this.config.workspaceId, noteIdStr, input.relativePath, hash, false),
    }
    await this.commitEvent(NOTE_CREATED, noteIdStr, payload)
    const record: NoteIndexRecord = {
      noteId,
      workspaceId: WorkspaceId(this.config.workspaceId),
      relativePath: input.relativePath,
      title: deriveTitle(markdown, parsed.frontmatter.title, posix.basename(input.relativePath)),
      tags: parsed.frontmatter.tags ?? [],
      contentHash: hash,
      observedRevision: 1,
      fileSize: Buffer.byteLength(markdown, 'utf8'),
      createdAt: now,
      updatedAt: now,
    }
    await this.putRecord(record, input.relativePath)
    return record
  }

  async update(noteId: NoteId, markdown: string): Promise<NoteIndexRecord> {
    const { parseFrontmatter, injectNoteId } = await import('./frontmatter.ts')
    const existing = this.requireTable().get(noteId)
    if (existing === undefined) throw new Error(`pkwNotes: unknown note '${noteId}'`)
    const parsed = parseFrontmatter(markdown)
    let next = markdown
    if (parsed.frontmatter.id === undefined || parsed.frontmatter.id === '') next = injectNoteId(markdown, String(noteId))
    await this.ctx.fs.writeText(await this.ctx.fs.resolve(this.handle.notePath(existing.relativePath)), next)
    const hash = contentHash(next)
    if (hash === existing.contentHash) return existing
    const observedRevision = existing.observedRevision + 1
    const payload: NoteEventPayload = {
      noteId: String(noteId),
      relativePath: existing.relativePath,
      contentHash: hash,
      observedRevision,
      afterStateFingerprint: noteFingerprint(this.config.workspaceId, String(noteId), existing.relativePath, hash, false),
      beforeStateFingerprint: noteFingerprint(this.config.workspaceId, String(noteId), existing.relativePath, existing.contentHash, false),
    }
    await this.commitEvent(NOTE_UPDATED, String(noteId), payload)
    const record = { ...existing, contentHash: hash, observedRevision, updatedAt: new Date().toISOString(), fileSize: Buffer.byteLength(next, 'utf8') }
    await this.putRecord(record, existing.relativePath)
    return record
  }

  async move(noteId: NoteId, newRelativePath: string): Promise<NoteIndexRecord> {
    const existing = this.requireTable().get(noteId)
    if (existing === undefined) throw new Error(`pkwNotes: unknown note '${noteId}'`)
    const newTarget = await this.ctx.fs.resolve(this.handle.notePath(newRelativePath))
    await this.ctx.fs.rename(
      await this.ctx.fs.resolve(this.handle.notePath(existing.relativePath)),
      newTarget,
    )
    // Preserve managed attachment links across the directory-depth change.
    const markdown = await this.ctx.fs.readText(newTarget)
    const rewritten = rewriteManagedLinks(markdown, dirDepth(existing.relativePath), dirDepth(newRelativePath))
    if (rewritten !== markdown) await this.ctx.fs.writeText(newTarget, rewritten)
    const newHash = contentHash(rewritten)
    const payload: NoteEventPayload = {
      noteId: String(noteId),
      fromPath: existing.relativePath,
      toPath: newRelativePath,
      contentHash: newHash,
      observedRevision: existing.observedRevision,
      afterStateFingerprint: noteFingerprint(this.config.workspaceId, String(noteId), newRelativePath, newHash, false),
      beforeStateFingerprint: noteFingerprint(this.config.workspaceId, String(noteId), existing.relativePath, existing.contentHash, false),
    }
    await this.commitEvent(NOTE_MOVED, String(noteId), payload)
    const record = { ...existing, relativePath: newRelativePath, contentHash: newHash, updatedAt: new Date().toISOString() }
    await this.requirePaths().delete(existing.relativePath)
    await this.putRecord(record, newRelativePath)
    return record
  }

  async delete(noteId: NoteId): Promise<void> {
    const existing = this.requireTable().get(noteId)
    if (existing === undefined || existing.deletedAt !== undefined) return
    await this.ctx.fs.rename(
      await this.ctx.fs.resolve(this.handle.notePath(existing.relativePath)),
      await this.ctx.fs.resolve(this.handle.archivePath(existing.relativePath)),
    )
    const payload: NoteEventPayload = {
      noteId: String(noteId),
      relativePath: existing.relativePath,
      contentHash: existing.contentHash,
      observedRevision: existing.observedRevision,
      afterStateFingerprint: noteFingerprint(this.config.workspaceId, String(noteId), existing.relativePath, existing.contentHash, true),
      beforeStateFingerprint: noteFingerprint(this.config.workspaceId, String(noteId), existing.relativePath, existing.contentHash, false),
    }
    await this.commitEvent(NOTE_DELETED, String(noteId), payload)
    await this.putRecord({ ...existing, deletedAt: new Date().toISOString() }, existing.relativePath)
  }

  async reconcile(): Promise<ReconcileReport> {
    const { parseFrontmatter, injectNoteId, deriveTitle } = await import('./frontmatter.ts')
    const report: ReconcileReport = { decisions: [], repairedProjections: 0 }
    const observed = new Map<string, { target: import('@deepseek-ai/dsh-fs').FsTarget; relativePath: string; markdown: string; hash: string }>()
    await walkNotes(this.ctx, this.handle, observed)

    const seenIds = new Map<string, string[]>()
    for (const [relativePath, obs] of observed) {
      const parsed = parseFrontmatter(obs.markdown)
      const idStr = parsed.frontmatter.id
      if (idStr !== undefined && idStr !== '') {
        const arr = seenIds.get(idStr) ?? []
        arr.push(relativePath)
        seenIds.set(idStr, arr)
      }
    }

    // 1. Missing NoteId: discover + inject id.
    for (const [relativePath, obs] of observed) {
      const parsed = parseFrontmatter(obs.markdown)
      if (parsed.frontmatter.id !== undefined && parsed.frontmatter.id !== '') continue
      const idStr = `note_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const next = injectNoteId(obs.markdown, idStr)
      await this.ctx.fs.writeText(obs.target, next)
      const hash = contentHash(next)
      const payload: NoteEventPayload = {
        noteId: idStr,
        relativePath,
        contentHash: hash,
        observedRevision: 1,
        afterStateFingerprint: noteFingerprint(this.config.workspaceId, idStr, relativePath, hash, false),
      }
      await this.commitEvent(NOTE_DISCOVERED, idStr, payload)
      const record: NoteIndexRecord = {
        noteId: NoteId(idStr),
        workspaceId: WorkspaceId(this.config.workspaceId),
        relativePath,
        title: deriveTitle(next, parsed.frontmatter.title, posix.basename(relativePath)),
        tags: parsed.frontmatter.tags ?? [],
        contentHash: hash,
        observedRevision: 1,
        fileSize: Buffer.byteLength(next, 'utf8'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await this.putRecord(record, relativePath)
      obs.markdown = next
      obs.hash = hash
      report.decisions.push({ changeKind: NOTE_DISCOVERED, noteId: NoteId(idStr), operationId: OperationId(`reconcile:${payload.afterStateFingerprint}`) })
      const arr = seenIds.get(idStr) ?? []
      arr.push(relativePath)
      seenIds.set(idStr, arr)
    }

    // 2. Duplicate NoteId detection.
    for (const [idStr, relPaths] of seenIds) {
      if (relPaths.length > 1) {
        const payload: NoteEventPayload = { noteId: idStr, paths: relPaths, afterStateFingerprint: noteFingerprint(this.config.workspaceId, idStr, 'CONFLICT', sha256(relPaths.join('\u0000')), false) }
        await this.commitEvent(NOTE_IDENTITY_CONFLICT, idStr, payload)
        report.decisions.push({ changeKind: NOTE_IDENTITY_CONFLICT, noteId: NoteId(idStr), operationId: OperationId(`reconcile:${payload.afterStateFingerprint}`) })
      }
    }

    // 3. Compare durable observation + projection for each observed identity/path.
    for (const [relativePath, obs] of observed) {
      const idStr = parseFrontmatter(obs.markdown).frontmatter.id ?? ''
      const indexed = this.resolveByPath(relativePath)
      if (idStr === '') continue
      const latest = await this.latestDurableFingerprint(idStr)
      const fingerprint = noteFingerprint(this.config.workspaceId, idStr, relativePath, obs.hash, false)
      if (latest === fingerprint) {
        if (indexed === undefined || indexed.contentHash !== obs.hash || indexed.relativePath !== relativePath) {
          // Projection repair: rebuild from authoritative filesystem + durable history (no fabricated fields).
          const latestPayload = await this.latestDurablePayload(idStr)
          const fm = parseFrontmatter(obs.markdown).frontmatter
          const record: NoteIndexRecord = {
            noteId: NoteId(idStr),
            workspaceId: WorkspaceId(this.config.workspaceId),
            relativePath,
            title: deriveTitle(obs.markdown, fm.title, posix.basename(relativePath)),
            tags: fm.tags ?? [],
            contentHash: obs.hash,
            observedRevision: latestPayload?.observedRevision ?? 1,
            fileSize: Buffer.byteLength(obs.markdown, 'utf8'),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          await this.putRecord(record, relativePath)
          report.repairedProjections += 1
        }
        continue
      }
      // New durable observation.
      const kind = indexed === undefined ? NOTE_DISCOVERED : (indexed.contentHash !== obs.hash ? NOTE_UPDATED : NOTE_MOVED)
      const prevFingerprint = indexed === undefined
        ? undefined
        : noteFingerprint(this.config.workspaceId, idStr, indexed.relativePath, indexed.contentHash, false)
      const payload: NoteEventPayload = {
        noteId: idStr,
        relativePath,
        contentHash: obs.hash,
        observedRevision: (indexed?.observedRevision ?? 0) + 1,
        afterStateFingerprint: fingerprint,
        ...(prevFingerprint !== undefined ? { beforeStateFingerprint: prevFingerprint } : {}),
        ...(kind === NOTE_MOVED && indexed !== undefined ? { fromPath: indexed.relativePath, toPath: relativePath } : {}),
      }
      await this.commitEvent(kind, idStr, payload)
      const record: NoteIndexRecord = {
        noteId: NoteId(idStr),
        workspaceId: WorkspaceId(this.config.workspaceId),
        relativePath,
        title: deriveTitle(obs.markdown, parseFrontmatter(obs.markdown).frontmatter.title, posix.basename(relativePath)),
        tags: parseFrontmatter(obs.markdown).frontmatter.tags ?? [],
        contentHash: obs.hash,
        observedRevision: (indexed?.observedRevision ?? 0) + 1,
        fileSize: Buffer.byteLength(obs.markdown, 'utf8'),
        createdAt: indexed?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await this.putRecord(record, relativePath)
      if (indexed !== undefined && indexed.relativePath !== relativePath) await this.requirePaths().delete(indexed.relativePath)
      report.decisions.push({ changeKind: kind, noteId: NoteId(idStr), operationId: OperationId(`reconcile:${fingerprint}`) })
    }

    // 4. External delete: indexed note whose file is gone.
    for (const [relativePath, id] of [...this.requirePaths().entries()]) {
      if (observed.has(relativePath)) continue
      const record = this.requireTable().get(id)
      if (record === undefined || record.deletedAt !== undefined) continue
      const fingerprint = noteFingerprint(this.config.workspaceId, String(id), relativePath, record.contentHash, true)
      const latest = await this.latestDurableFingerprint(String(id))
      if (latest === fingerprint) { if (record.deletedAt === undefined) { await this.putRecord({ ...record, deletedAt: new Date().toISOString() }, relativePath); report.repairedProjections += 1 } ; continue }
      const payload: NoteEventPayload = { noteId: String(id), relativePath, contentHash: record.contentHash, observedRevision: record.observedRevision, afterStateFingerprint: fingerprint }
      await this.commitEvent(NOTE_DELETED, String(id), payload)
      await this.putRecord({ ...record, deletedAt: new Date().toISOString() }, relativePath)
      report.decisions.push({ changeKind: NOTE_DELETED, noteId: id, operationId: OperationId(`reconcile:${fingerprint}`) })
    }

    return report
  }

  getIdentityConflict(noteId: NoteId): NoteIdentityConflict | undefined {
    const paths: string[] = []
    for (const [p, id] of this.requirePaths().entries()) if (id === noteId) paths.push(p)
    return paths.length > 1 ? { noteId, paths } : undefined
  }

  listIdentityConflicts(): NoteIdentityConflict[] {
    const byId = new Map<string, string[]>()
    for (const [p, id] of this.requirePaths().entries()) { const arr = byId.get(String(id)) ?? []; arr.push(p); byId.set(String(id), arr) }
    const out: NoteIdentityConflict[] = []
    for (const [id, paths] of byId) if (paths.length > 1) out.push({ noteId: NoteId(id), paths })
    return out
  }

  // ── folders + manual ordering ──────────────────────────────────────────────

  /** Recursively list every folder relative path under `notes/` (sorted). */
  async listFolders(): Promise<string[]> {
    const out: string[] = []
    await this.collectFolders(await this.ctx.fs.resolve(this.handle.notePath('')), '', out)
    return out.sort()
  }

  private async collectFolders(target: import('@deepseek-ai/dsh-fs').FsTarget, prefix: string, out: string[]): Promise<void> {
    const info = await this.ctx.fs.stat(target)
    if (info === undefined || info.type !== 'directory') return
    const entries = await this.ctx.fs.listDir(target)
    for (const entry of entries) {
      if (entry.type !== 'directory') continue
      const rel = `${prefix}${entry.name}`
      out.push(rel)
      await this.collectFolders(entry.target, `${rel}/`, out)
    }
  }

  /** Create an empty folder by writing a hidden marker (parent dirs are auto-created). */
  async createFolder(relativePath: string): Promise<void> {
    this.assertFolderPath(relativePath)
    const marker = await this.ctx.fs.resolve(this.handle.notePath(posix.join(relativePath, FOLDER_MARKER)))
    await this.ctx.fs.writeText(marker, '', { kind: 'createIfAbsent' })
  }

  /** Rename/move a folder; every note under it keeps its NoteId and gains the new path. */
  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    this.assertFolderPath(oldPath)
    this.assertFolderPath(newPath)
    if (oldPath === newPath) return
    await this.ctx.fs.rename(
      await this.ctx.fs.resolve(this.handle.notePath(oldPath)),
      await this.ctx.fs.resolve(this.handle.notePath(newPath)),
    )
    await this.repathNotes(oldPath, newPath)
    await this.migrateOrderFolder(oldPath, newPath)
  }

  /** Soft-delete an empty folder to archive. Non-empty folders are rejected. */
  async deleteFolder(relativePath: string): Promise<void> {
    this.assertFolderPath(relativePath)
    const target = await this.ctx.fs.resolve(this.handle.notePath(relativePath))
    const entries = await this.ctx.fs.listDir(target)
    const hasContent = entries.some(e => e.type === 'directory' || e.name.endsWith('.md'))
    if (hasContent) throw new Error(`pkwNotes: folder '${relativePath}' is not empty`)
    await this.ctx.fs.rename(target, await this.ctx.fs.resolve(this.handle.archivePath(relativePath)))
    await this.requireOrder().delete(this.orderKey(relativePath))
    await this.removeChildFromOrder(parentOf(relativePath), 'folder', posix.basename(relativePath))
  }

  /** Manual order for one parent folder ('' = workspace root). Empty = default sort. */
  getOrder(parentPath: string): OrderChild[] {
    const rec = this.requireOrder().get(this.orderKey(parentPath))
    return rec === undefined ? [] : [...rec.children]
  }

  async setOrder(parentPath: string, children: OrderChild[]): Promise<void> {
    await this.requireOrder().put(this.orderKey(parentPath), {
      workspaceId: WorkspaceId(this.config.workspaceId),
      parentPath,
      children: children.map(c => ({ kind: c.kind, id: c.id })),
    })
  }

  private orderKey(parentPath: string): string {
    return `${this.config.workspaceId}:${parentPath}`
  }

  private assertFolderPath(relativePath: string): void {
    const clean = relativePath.replace(/\\/g, '/')
    if (clean === '' || clean.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(clean) || /(^|\/)\.(\/|$)/.test(clean)) {
      throw new Error(`pkwNotes: invalid folder path '${relativePath}'`)
    }
  }

  private async repathNotes(oldPrefix: string, newPrefix: string): Promise<void> {
    const prefix = `${oldPrefix}/`
    for (const [path, id] of [...this.requirePaths().entries()]) {
      if (path !== oldPrefix && !path.startsWith(prefix)) continue
      const rest = path === oldPrefix ? '' : path.slice(oldPrefix.length)
      const newPath = newPrefix + rest
      const record = this.requireTable().get(id)
      if (record === undefined) continue
      await this.requirePaths().delete(path)
      await this.putRecord({ ...record, relativePath: newPath, updatedAt: new Date().toISOString() }, newPath)
    }
  }

  private async migrateOrderFolder(oldPath: string, newPath: string): Promise<void> {
    // (1) this folder's own order record re-keyed to the new path.
    const selfRec = this.requireOrder().get(this.orderKey(oldPath))
    if (selfRec !== undefined) {
      await this.requireOrder().delete(this.orderKey(oldPath))
      await this.requireOrder().put(this.orderKey(newPath), { ...selfRec, parentPath: newPath })
    }
    // (2) descendants' order records re-keyed.
    const prefix = `${oldPath}/`
    for (const [key, rec] of [...this.requireOrder().entries()]) {
      if (!(rec.parentPath === oldPath || rec.parentPath.startsWith(prefix))) continue
      const newParent = newPath + rec.parentPath.slice(oldPath.length)
      await this.requireOrder().delete(key)
      await this.requireOrder().put(this.orderKey(newParent), { ...rec, parentPath: newParent })
    }
    // (3) parent order: rename the folder child id when it stays in the same parent,
    // else remove from old parent and append to new parent.
    const oldParent = parentOf(oldPath)
    const newParent = parentOf(newPath)
    if (oldParent === newParent) {
      await this.renameChildInOrder(oldParent, 'folder', posix.basename(oldPath), posix.basename(newPath))
    } else {
      await this.removeChildFromOrder(oldParent, 'folder', posix.basename(oldPath))
      await this.ensureChildInOrder(newParent, { kind: 'folder', id: posix.basename(newPath) })
    }
  }

  private async renameChildInOrder(parentPath: string, kind: 'note' | 'folder', oldId: string, newId: string): Promise<void> {
    const children = this.getOrder(parentPath)
    if (children.length === 0) return
    await this.setOrder(parentPath, children.map(c => c.kind === kind && c.id === oldId ? { kind, id: newId } : c))
  }

  private async removeChildFromOrder(parentPath: string, kind: 'note' | 'folder', id: string): Promise<void> {
    const children = this.getOrder(parentPath)
    if (children.length === 0) return
    const next = children.filter(c => !(c.kind === kind && c.id === id))
    if (next.length !== children.length) await this.setOrder(parentPath, next)
  }

  private async ensureChildInOrder(parentPath: string, child: OrderChild): Promise<void> {
    const children = this.getOrder(parentPath)
    if (children.some(c => c.kind === child.kind && c.id === child.id)) return
    await this.setOrder(parentPath, [...children, child])
  }

  private async commitEvent(type: string, aggregateId: string, payload: NoteEventPayload): Promise<void> {
    const opCtx = this.handle.newOperationContext({ type: 'system' })
    await this.ctx.pkwEvents.commit({
      operationContext: { ...opCtx, operationId: OperationId(`${type}:${aggregateId}:${payload.afterStateFingerprint}`) },
      events: [{ type, aggregateType: NOTE_AGG, aggregateId, payload }],
    })
  }

  private async latestDurablePayload(noteId: string): Promise<NoteEventPayload | undefined> {
    const events = this.ctx.pkwEvents.list({ aggregateType: NOTE_AGG, aggregateId: noteId })
    if (events.length === 0) return undefined
    return events[events.length - 1]!.payload as NoteEventPayload | undefined
  }

  private async latestDurableFingerprint(noteId: string): Promise<string | undefined> {
    return (await this.latestDurablePayload(noteId))?.afterStateFingerprint
  }

  private async putRecord(record: NoteIndexRecord, relativePath: string): Promise<void> {
    await this.requireTable().put(record.noteId, record)
    await this.requirePaths().put(relativePath, record.noteId)
  }
}

async function walkNotes(ctx: Context, handle: WorkspaceHandle, out: Map<string, { target: import('@deepseek-ai/dsh-fs').FsTarget; relativePath: string; markdown: string; hash: string }>): Promise<void> {
  const notesTarget = await ctx.fs.resolve(handle.notePath(''))
  const info = await ctx.fs.stat(notesTarget)
  if (info === undefined || info.type !== 'directory') return
  async function walk(dirTarget: import('@deepseek-ai/dsh-fs').FsTarget, prefix: string): Promise<void> {
    const entries = await ctx.fs.listDir(dirTarget)
    for (const entry of entries) {
      if (entry.type === 'directory') await walk(entry.target, `${prefix}${entry.name}/`)
      else if (entry.type === 'file' && entry.name.endsWith('.md')) {
        const markdown = await ctx.fs.readText(entry.target)
        out.set(`${prefix}${entry.name}`, { target: entry.target, relativePath: `${prefix}${entry.name}`, markdown, hash: contentHash(markdown) })
      }
    }
  }
  await walk(notesTarget, '')
}

function collectManagedLinks(workspaceId: string, markdown: string): Array<{ attachmentId: import('@deepseek-ai/dsh-pkw-domain').AttachmentId; relativePath: string }> {
  const out: Array<{ attachmentId: import('@deepseek-ai/dsh-pkw-domain').AttachmentId; relativePath: string }> = []
  const seen = new Set<string>()
  // Conservative scan: skip fenced code blocks and inline code, then match
  // `attachments/<id>/<rest>` inside markdown link/image destinations.
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const re = /!\[[^\]]*\]\(([^)\s]+)\)|\[[^\]]*\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(withoutFences)) !== null) {
    const url = m[1] ?? m[2]!
    const match = /(?:^|\/)attachments\/([^/\s]+)\//.exec(url)
    if (match === null) continue
    const id = match[1]!
    const rel = url.replace(/^.*attachments\//, 'attachments/')
    const key = `${id}\u0000${rel}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ attachmentId: AttachmentId(id), relativePath: rel })
  }
  return out
}

/** Parent folder relative path of a note/folder path ('' for files directly under `notes/`). */
function parentOf(relativePath: string): string {
  const d = posix.dirname(relativePath)
  return d === '.' ? '' : d
}

/** Directory depth of a note relative to the workspace root (notes/ = depth 1). */
function dirDepth(relativePath: string): number {
  return 1 + posix.dirname(relativePath).split('/').filter(s => s !== '' && s !== '.').length
}

/** Rewrite managed attachment links (`attachments/<id>/...`) when a note's depth changes. */
function rewriteManagedLinks(markdown: string, fromDepth: number, toDepth: number): string {
  if (fromDepth === toDepth) return markdown
  const fromPrefix = '../'.repeat(fromDepth)
  const toPrefix = '../'.repeat(toDepth)
  const blocks: string[] = []
  let noCode = markdown.replace(/```[\s\S]*?```/g, m => { blocks.push(m); return `\u0000${blocks.length - 1}\u0000` })
  noCode = noCode.replace(/`[^`\n]*`/g, m => { blocks.push(m); return `\u0000${blocks.length - 1}\u0000` })
  const re = /(!\[[^\]]*\]|\[[^\]]*\])\(([^)\s]*attachments\/[^)\s]*)\)/g
  const rewritten = noCode.replace(re, (whole, label, url) => {
    if (!url.startsWith(`${fromPrefix}attachments/`)) return whole
    return `${label}(${toPrefix}${url.slice(fromPrefix.length)})`
  })
  return rewritten.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]!)
}

export default NotesService

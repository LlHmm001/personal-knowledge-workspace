/**
 * PKW Attachments core (`ctx.pkwAttachments`).
 *
 * Workspace binary file = source of truth (under `attachments/<AttachmentId>/`);
 * catalog = rebuildable projection over `ctx.storage`. `AttachmentId ≠ sha256`;
 * external binary replacement is the SAME attachment with a new observed state.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import {
  ATTACHMENT_DELETED,
  ATTACHMENT_IMPORTED,
  ATTACHMENT_RESTORED,
  ATTACHMENT_UPDATED,
  AttachmentId,
  OperationId,
  attachmentDomainSpec,
  type AttachmentRecord,
  type ImportAttachmentInput,
  type PkwAttachmentsService,
  type ReconcileReport,
} from '@deepseek-ai/dsh-pkw-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceHandle } from '@deepseek-ai/dsh-pkw-workspace'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pkwAttachments: PkwAttachmentsService
  }
}

export interface Config {
  workspaceId: string
}

const ATT_AGG = 'attachment'

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function safeFilename(name: string): string {
  return posix.basename(name).replace(/[^\w.\-]+/g, '_') || 'file'
}

interface AttachmentEventPayload {
  attachmentId: string
  relativePath?: string
  sha256?: string
  sizeBytes?: number
  observedRevision?: number
  afterStateFingerprint: string
}

function fingerprint(workspaceId: string, attachmentId: string, relativePath: string, hash: string, deleted: boolean): string {
  return createHash('sha256').update(`${workspaceId}\u0000${attachmentId}\u0000${relativePath}\u0000${hash}\u0000${deleted ? '1' : '0'}`).digest('hex')
}

export class AttachmentsService extends Service {
  static inject = ['pkwWorkspace', 'fs', 'pkwEvents', 'storageDomain']
  static Config: z<Config> = z.object({ workspaceId: z.string() })

  private handle!: WorkspaceHandle
  private table?: KvTable<AttachmentId, AttachmentRecord>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwAttachments')
  }

  protected async [Service.init](): Promise<void> {
    const handle = this.ctx.pkwWorkspace.forWorkspace(WorkspaceId(this.config.workspaceId))
    if (handle === undefined) throw new Error(`pkwAttachments: workspace '${this.config.workspaceId}' is not registered`)
    this.handle = handle
    const domain: Domain<typeof attachmentDomainSpec> = await this.ctx.storageDomain.open(attachmentDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'pkw.attachmentsDomainClose')
    this.table = domain.table('attachments')
  }

  private requireTable(): KvTable<AttachmentId, AttachmentRecord> {
    if (this.table === undefined) throw new Error('pkwAttachments is not started yet')
    return this.table
  }

  list(filter: import('@deepseek-ai/dsh-pkw-domain').AttachmentListFilter = {}): AttachmentRecord[] {
    const out: AttachmentRecord[] = []
    for (const [, record] of this.requireTable().entries()) {
      if (!(filter.includeDeleted === true) && record.deletedAt !== undefined) continue
      out.push(record)
    }
    return out
  }

  get(attachmentId: AttachmentId): AttachmentRecord | undefined {
    return this.requireTable().get(attachmentId)
  }

  resolve(relativePath: string): AttachmentRecord | undefined {
    const m = /(?:^|\/)attachments\/([^/\s]+)\//.exec(relativePath)
    if (m === null) return undefined
    return this.requireTable().get(AttachmentId(m[1]!))
  }

  async importFile(input: ImportAttachmentInput): Promise<AttachmentRecord> {
    const attachmentId = AttachmentId(`att_${randomUUID().replaceAll('-', '').slice(0, 12)}`)
    const filename = safeFilename(input.filename)
    const relativePath = `attachments/${attachmentId}/${filename}`
    const target = await this.ctx.fs.resolve(this.handle.attachmentPath(attachmentId, filename))
    await this.ctx.fs.writeBytes(target, input.content, { kind: 'createIfAbsent' })
    const hash = sha256(input.content)
    const now = new Date().toISOString()
    const record: AttachmentRecord = {
      id: attachmentId,
      workspaceId: WorkspaceId(this.config.workspaceId),
      filename,
      mimeType: input.mimeType,
      sizeBytes: input.content.byteLength,
      sha256: hash,
      relativePath,
      observedRevision: 1,
      indexedAt: now,
      createdAt: now,
    }
    const payload: AttachmentEventPayload = {
      attachmentId: String(attachmentId),
      relativePath,
      sha256: hash,
      sizeBytes: input.content.byteLength,
      observedRevision: 1,
      afterStateFingerprint: fingerprint(this.config.workspaceId, String(attachmentId), relativePath, hash, false),
    }
    await this.commitEvent(ATTACHMENT_IMPORTED, String(attachmentId), payload)
    await this.requireTable().put(attachmentId, record)
    return record
  }

  async open(attachmentId: AttachmentId): Promise<Uint8Array> {
    const record = this.requireTable().get(attachmentId)
    if (record === undefined) throw new Error(`pkwAttachments: unknown attachment '${attachmentId}'`)
    return this.ctx.fs.readBytes(await this.ctx.fs.resolve(this.handle.attachmentPath(attachmentId, record.filename)), undefined, record.sizeBytes)
  }

  async remove(attachmentId: AttachmentId): Promise<void> {
    const record = this.requireTable().get(attachmentId)
    if (record === undefined || record.deletedAt !== undefined) return
    await this.ctx.fs.remove(await this.ctx.fs.resolve(this.handle.attachmentPath(attachmentId, record.filename)))
    const payload: AttachmentEventPayload = {
      attachmentId: String(attachmentId),
      relativePath: record.relativePath,
      sha256: record.sha256,
      observedRevision: record.observedRevision,
      afterStateFingerprint: fingerprint(this.config.workspaceId, String(attachmentId), record.relativePath, record.sha256, true),
    }
    await this.commitEvent(ATTACHMENT_DELETED, String(attachmentId), payload)
    await this.requireTable().put(attachmentId, { ...record, deletedAt: new Date().toISOString() })
  }

  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { decisions: [], repairedProjections: 0 }
    const indexed = [...this.requireTable().entries()]
    for (const [attachmentId, record] of indexed) {
      const target = await this.ctx.fs.resolve(this.handle.attachmentPath(attachmentId, record.filename))
      const info = await this.ctx.fs.stat(target)
      const exists = info !== undefined && info.type === 'file'

      // Deleted attachment whose file reappeared: the SAME identity is restored.
      if (record.deletedAt !== undefined) {
        if (!exists) continue
        const bytes = await this.ctx.fs.readBytes(target, undefined, record.sizeBytes > 0 ? record.sizeBytes + 1 : 1024 * 1024)
        const hash = sha256(bytes)
        const fp = fingerprint(this.config.workspaceId, String(attachmentId), record.relativePath, hash, false)
        const latest = await this.latestFingerprint(String(attachmentId))
        if (latest === fp) { await this.requireTable().put(attachmentId, { ...record, deletedAt: undefined, sha256: hash, sizeBytes: bytes.byteLength }); report.repairedProjections += 1; continue }
        const payload: AttachmentEventPayload = { attachmentId: String(attachmentId), relativePath: record.relativePath, sha256: hash, sizeBytes: bytes.byteLength, observedRevision: record.observedRevision + 1, afterStateFingerprint: fp }
        await this.commitEvent(ATTACHMENT_RESTORED, String(attachmentId), payload)
        await this.requireTable().put(attachmentId, { ...record, deletedAt: undefined, sha256: hash, sizeBytes: bytes.byteLength, observedRevision: record.observedRevision + 1 })
        report.decisions.push({ changeKind: ATTACHMENT_RESTORED, attachmentId, operationId: OperationId(`reconcile:${fp}`) })
        continue
      }

      if (!exists) {
        const fp = fingerprint(this.config.workspaceId, String(attachmentId), record.relativePath, record.sha256, true)
        const latest = await this.latestFingerprint(String(attachmentId))
        if (latest === fp) { await this.requireTable().put(attachmentId, { ...record, deletedAt: new Date().toISOString() }); report.repairedProjections += 1; continue }
        const payload: AttachmentEventPayload = { attachmentId: String(attachmentId), relativePath: record.relativePath, sha256: record.sha256, observedRevision: record.observedRevision, afterStateFingerprint: fp }
        await this.commitEvent(ATTACHMENT_DELETED, String(attachmentId), payload)
        await this.requireTable().put(attachmentId, { ...record, deletedAt: new Date().toISOString() })
        report.decisions.push({ changeKind: ATTACHMENT_DELETED, attachmentId, operationId: OperationId(`reconcile:${fp}`) })
        continue
      }
      const bytes = await this.ctx.fs.readBytes(target, undefined, record.sizeBytes > 0 ? record.sizeBytes + 1 : 1024 * 1024)
      const hash = sha256(bytes)
      if (hash === record.sha256) continue
      const fp = fingerprint(this.config.workspaceId, String(attachmentId), record.relativePath, hash, false)
      const latest = await this.latestFingerprint(String(attachmentId))
      if (latest === fp) { await this.requireTable().put(attachmentId, { ...record, sha256: hash, sizeBytes: bytes.byteLength, observedRevision: record.observedRevision + 1 }); report.repairedProjections += 1; continue }
      const payload: AttachmentEventPayload = { attachmentId: String(attachmentId), relativePath: record.relativePath, sha256: hash, sizeBytes: bytes.byteLength, observedRevision: record.observedRevision + 1, afterStateFingerprint: fp }
      await this.commitEvent(ATTACHMENT_UPDATED, String(attachmentId), payload)
      await this.requireTable().put(attachmentId, { ...record, sha256: hash, sizeBytes: bytes.byteLength, observedRevision: record.observedRevision + 1 })
      report.decisions.push({ changeKind: ATTACHMENT_UPDATED, attachmentId, operationId: OperationId(`reconcile:${fp}`) })
    }
    return report
  }

  private async commitEvent(type: string, aggregateId: string, payload: AttachmentEventPayload): Promise<void> {
    const opCtx = this.handle.newOperationContext({ type: 'system' })
    await this.ctx.pkwEvents.commit({
      operationContext: { ...opCtx, operationId: OperationId(`${type}:${aggregateId}:${payload.afterStateFingerprint}`) },
      events: [{ type, aggregateType: ATT_AGG, aggregateId, payload }],
    })
  }

  private async latestFingerprint(attachmentId: string): Promise<string | undefined> {
    const events = this.ctx.pkwEvents.list({ aggregateType: ATT_AGG, aggregateId: attachmentId })
    if (events.length === 0) return undefined
    return (events[events.length - 1]!.payload as AttachmentEventPayload | undefined)?.afterStateFingerprint
  }
}

export default AttachmentsService

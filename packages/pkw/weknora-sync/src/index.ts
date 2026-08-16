/**
 * PKW ↔ WeKnora Sync (`ctx.pkwWeKnoraSync`).
 *
 * Local-first: a local note/attachment save never depends on WeKnora. Durable
 * Sync Intent is written BEFORE remote mutation; unknown outcomes are recovered
 * by identity lookup (read original Manual content → match NoteId + payload
 * fingerprint), never by blind re-create.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import zz from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { parseNoteId } from '@deepseek-ai/dsh-pkw-domain'
import type { NoteId } from '@deepseek-ai/dsh-pkw-domain'
import { WeKnoraError } from '@deepseek-ai/dsh-pkw-weknora'
import type { WeKnoraClient } from '@deepseek-ai/dsh-pkw-weknora'

export interface Config { kbId: string; workspaceId: string }

const syncIntentSchema = z.object({
  operationId: z.string(),
  workspaceId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  remoteFingerprint: z.string(),
  kbId: z.string(),
  operationKind: z.string(),
  state: z.string(),
  attempt: z.number().int().nonnegative(),
  knowledgeId: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: z.string(),
})

const entityMappingSchema = z.object({
  workspaceId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  knowledgeId: z.string(),
  remoteFingerprint: z.string(),
  localObservedRevision: z.number().int().nonnegative(),
  syncState: z.string(),
  remoteParseStatus: z.string().optional(),
  updatedAt: z.string(),
})

export const weknoraSyncDomainSpec = defineDomain({
  name: 'pkw_weknora_sync',
  version: 1,
  tables: {
    intents: domainTable<string, z.infer<typeof syncIntentSchema>>(syncIntentSchema),
    mappings: domainTable<string, z.infer<typeof entityMappingSchema>>(entityMappingSchema),
  },
})

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export class WeKnoraSyncService extends Service {
  static inject = ['pkwNotes', 'storageDomain', 'pkwWeKnora']
  static Config: zz<Config> = zz.object({ kbId: zz.string(), workspaceId: zz.string() })

  private intents?: KvTable<string, z.infer<typeof syncIntentSchema>>
  private mappings?: KvTable<string, z.infer<typeof entityMappingSchema>>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwWeKnoraSync')
  }

  protected async [Service.init](): Promise<void> {
    const domain: Domain<typeof weknoraSyncDomainSpec> = await this.ctx.storageDomain.open(weknoraSyncDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'pkw.weknoraSyncDomainClose')
    this.intents = domain.table('intents')
    this.mappings = domain.table('mappings')
  }

  private reqIntents(): KvTable<string, z.infer<typeof syncIntentSchema>> {
    if (this.intents === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.intents
  }

  private reqMappings(): KvTable<string, z.infer<typeof entityMappingSchema>> {
    if (this.mappings === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.mappings
  }

  /** Workspace-scoped mapping key. */
  private mappingKey(entityType: string, entityId: string): string {
    return `${this.config.workspaceId}:${entityType}:${entityId}`
  }

  /** Classify a thrown remote error into a durable outcome. */
  private outcome(error: unknown): string {
    if (error instanceof WeKnoraError) {
      // A structured HTTP response is a KNOWN outcome (retryable or permanent),
      // never "unknown".
      return error.kind === 'rate_limit' || error.kind === 'temporary' || error.kind === 'server'
        ? 'retryable'
        : 'permanent'
    }
    // Network-level failure (connection reset / timeout after send): ambiguous.
    return 'unknown'
  }

  /** Sync a note to its current state (create or update), local-first. */
  async syncNote(noteId: NoteId): Promise<string> {
    const doc = await this.ctx.pkwNotes.getDocument(noteId)
    const fingerprint = sha256(doc.markdown)
    const ws = String(doc.note.workspaceId)
    const key = this.mappingKey('note', String(noteId))
    const existing = this.reqMappings().get(key)
    if (existing !== undefined && existing.remoteFingerprint === fingerprint) {
      return existing.knowledgeId // no-op: unchanged
    }

    const operationId = randomUUID()
    const intent = {
      operationId, workspaceId: ws, entityType: 'note', entityId: String(noteId), remoteFingerprint: fingerprint,
      kbId: this.config.kbId, operationKind: existing === undefined ? 'create' : 'update',
      state: 'pending', attempt: 0, createdAt: new Date().toISOString(),
    }
    await this.reqIntents().put(operationId, intent)

    let knowledgeId: string
    try {
      if (existing === undefined) {
        const created = await this.ctx.pkwWeKnora.createManualKnowledge(this.config.kbId, { title: doc.note.title, content: doc.markdown })
        knowledgeId = created.id
      } else {
        const updated = await this.ctx.pkwWeKnora.updateManualKnowledge(existing.knowledgeId, { title: doc.note.title, content: doc.markdown })
        knowledgeId = updated.id
      }
    } catch (error) {
      await this.reqIntents().put(operationId, { ...intent, state: this.outcome(error), attempt: 1, lastError: String(error), createdAt: new Date().toISOString() })
      throw error
    }

    await this.reqMappings().put(key, {
      workspaceId: ws, entityType: 'note', entityId: String(noteId), knowledgeId, remoteFingerprint: fingerprint,
      localObservedRevision: doc.note.observedRevision, syncState: 'synced', updatedAt: new Date().toISOString(),
    })
    await this.reqIntents().put(operationId, { ...intent, state: 'completed', attempt: 1, knowledgeId, createdAt: new Date().toISOString() })
    return knowledgeId
  }

  /** Recover a note's remote identity after an unknown-outcome create OR update. */
  async recoverNote(noteId: NoteId): Promise<string | undefined> {
    const doc = await this.ctx.pkwNotes.getDocument(noteId)
    const fingerprint = sha256(doc.markdown)
    const ws = String(doc.note.workspaceId)
    const key = this.mappingKey('note', String(noteId))
    const existing = this.reqMappings().get(key)

    // Update recovery: known KnowledgeId → read remote content, no full-KB scan.
    if (existing !== undefined) {
      let remote: string
      try { remote = await this.ctx.pkwWeKnora.readManualContent(existing.knowledgeId) }
      catch { return undefined } // remote missing → drift (full reconcile handles it)
      if (sha256(remote) === fingerprint) {
        // PUT already applied (response lost); mapping is authoritative.
        return existing.knowledgeId
      }
      // Remote still holds the previous state → retry the update.
      const updated = await this.ctx.pkwWeKnora.updateManualKnowledge(existing.knowledgeId, { title: doc.note.title, content: doc.markdown })
      await this.reqMappings().put(key, {
        workspaceId: ws, entityType: 'note', entityId: String(noteId), knowledgeId: updated.id, remoteFingerprint: fingerprint,
        localObservedRevision: doc.note.observedRevision, syncState: 'synced', updatedAt: new Date().toISOString(),
      })
      return updated.id
    }

    // Create recovery: enumerate candidates (NoteId + fingerprint double match).
    const candidates = await this.ctx.pkwWeKnora.listKnowledge(this.config.kbId)
    for (const c of candidates) {
      let content: string
      try { content = await this.ctx.pkwWeKnora.readManualContent(c.id) } catch { continue }
      if (parseNoteId(content) !== String(noteId)) continue
      if (sha256(content) !== fingerprint) continue
      await this.reqMappings().put(key, {
        workspaceId: ws, entityType: 'note', entityId: String(noteId), knowledgeId: c.id, remoteFingerprint: fingerprint,
        localObservedRevision: doc.note.observedRevision, syncState: 'synced', updatedAt: new Date().toISOString(),
      })
      return c.id
    }
    return undefined
  }

  getMapping(noteId: NoteId): z.infer<typeof entityMappingSchema> | undefined {
    return this.reqMappings().get(this.mappingKey('note', String(noteId)))
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { pkwWeKnoraSync: WeKnoraSyncService }
}

export default WeKnoraSyncService

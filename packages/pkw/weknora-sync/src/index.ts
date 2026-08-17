/**
 * PKW ↔ WeKnora Sync (`ctx.pkwWeKnoraSync`).
 *
 * Local-first: a local note/attachment save never depends on WeKnora. Durable
 * Sync Intent is written BEFORE remote mutation; unknown mutation outcomes are
 * recovered by identity lookup, never by blind re-create/re-upload.
 *
 * Durable sync state is workspace-scoped everywhere: mapping / intent / dirty /
 * reverse keys all carry `WorkspaceId + EntityType + EntityId` (or a globally
 * unique KnowledgeId that is itself workspace-tagged in its record).
 *
 * Worker model: `pkw/event.committed` only MARKS an entity dirty (durably); the
 * worker later reads the CURRENT canonical local state and converges the remote
 * to it — it never replays historical versions. Full reconcile is the
 * eventual-correctness backstop. Remote mutations are serialized per entity;
 * different entities may sync in parallel.
 *
 * @module @deepseek-ai/dsh-pkw-weknora-sync
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import zz from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AttachmentId, NoteId } from '@deepseek-ai/dsh-pkw-domain'
import type { NoteId as NoteIdT, AttachmentId as AttachmentIdT } from '@deepseek-ai/dsh-pkw-domain'
import {
  WeKnoraError,
  WeKnoraNotConfiguredError,
  md5Bytes,
  redactSecrets,
  remoteManualFingerprint,
  sha256Bytes,
} from '@deepseek-ai/dsh-pkw-weknora'
import type {
  SearchResultChunk,
  WeKnoraClient,
} from '@deepseek-ai/dsh-pkw-weknora'
import { classifyOutcome } from './outcome.ts'
import type { Outcome } from './outcome.ts'

export type { Outcome, ErrorCategory, OutcomeCertainty } from './outcome.ts'

export interface Config {
  kbId: string
  workspaceId: string
  /** Worker poll interval (ms). */
  pollMs: number
  /** Base backoff for retryable/unknown outcomes (ms). */
  retryBaseMs: number
  /** Backoff ceiling (ms). */
  retryMaxMs: number
  /** Unknown-outcome CREATE lookups before falling back to a safe re-create. */
  recoveryGraceAttempts: number
}

// ── durable records ─────────────────────────────────────────────────────────

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
  errorCategory: z.string().optional(),
  errorCertainty: z.string().optional(),
  nextRetryAt: z.string().optional(),
  recoveryAttempts: z.number().int().nonnegative(),
  knowledgeId: z.string().optional(),
  replacementKnowledgeId: z.string().optional(),
  lastError: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const entityMappingSchema = z.object({
  workspaceId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  knowledgeId: z.string(),
  remoteFingerprint: z.string(),
  remoteFileHash: z.string().optional(),
  localObservedRevision: z.number().int().nonnegative(),
  syncState: z.string(),
  remoteParseStatus: z.string().optional(),
  replacementKnowledgeId: z.string().optional(),
  replacementFingerprint: z.string().optional(),
  replacementState: z.string().optional(),
  supersededKnowledgeIds: z.array(z.string()).optional(),
  updatedAt: z.string(),
})

const dirtySchema = z.object({
  workspaceId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  dirty: z.boolean(),
  pendingOperationId: z.string().optional(),
  lastEventAt: z.string(),
  lastEventRevision: z.number().int().nonnegative(),
})

const reverseSchema = z.object({
  knowledgeId: z.string(),
  workspaceId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
})

export const weknoraSyncDomainSpec = defineDomain({
  name: 'pkw_weknora_sync',
  version: 2,
  tables: {
    intents: domainTable<string, z.infer<typeof syncIntentSchema>>(syncIntentSchema),
    mappings: domainTable<string, z.infer<typeof entityMappingSchema>>(entityMappingSchema),
    dirty: domainTable<string, z.infer<typeof dirtySchema>>(dirtySchema),
    reverse: domainTable<string, z.infer<typeof reverseSchema>>(reverseSchema),
  },
})

type IntentRecord = z.infer<typeof syncIntentSchema>
type MappingRecord = z.infer<typeof entityMappingSchema>
type DirtyRecord = z.infer<typeof dirtySchema>

const ENTITY_NOTE = 'note'
const ENTITY_ATTACHMENT = 'attachment'

// Intent / mapping states.
const S_PENDING = 'pending'
const S_RUNNING = 'running'
const S_UNKNOWN = 'unknown'
const S_RETRYABLE = 'retryable'
const S_PERMANENT = 'permanent'
const S_COMPLETED = 'completed'
const S_SUPERSEDED = 'superseded'

const M_SYNCED = 'synced'
const M_STALE = 'stale'
const M_DELETED = 'deleted'

export interface RetrievalResult {
  remote: {
    kbId: string
    knowledgeId: string
    chunkId: string
    chunkIndex: number
    score: number
    content: string
    title?: string
    filename?: string
    source?: string
    channel?: string
  }
  local?: {
    workspaceId: string
    entityType: string
    entityId: string
  }
}

export interface ReconcileReport {
  /** Entities that need (re)sync (never-synced / changed / stale / restored / remote-missing). */
  markedDirty: number
  /** Local entities deleted while a remote mapping was active (mapping converged to deleted). */
  markedDeleted: number
}

function backoffMs(attempt: number, base: number, cap: number): number {
  return Math.max(1, Math.min(cap, base * 2 ** Math.max(0, attempt - 1)))
}

export class WeKnoraSyncService extends Service {
  static inject = ['pkwNotes', 'pkwAttachments', 'storageDomain', 'pkwWeKnora', 'timer']
  static Config: zz<Config> = zz.object({
    kbId: zz.string(),
    workspaceId: zz.string(),
    pollMs: zz.number().default(1000),
    retryBaseMs: zz.number().default(1000),
    retryMaxMs: zz.number().default(60000),
    recoveryGraceAttempts: zz.number().default(3),
  })

  private intents?: KvTable<string, IntentRecord>
  private mappings?: KvTable<string, MappingRecord>
  private dirty?: KvTable<string, DirtyRecord>
  private reverse?: KvTable<string, z.infer<typeof reverseSchema>>

  /** Per-entity in-process serialization: one remote mutation per entity at a time. */
  private readonly locks = new Map<string, Promise<void>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwWeKnoraSync')
  }

  protected async [Service.init](): Promise<void> {
    const domain: Domain<typeof weknoraSyncDomainSpec> = await this.ctx.storageDomain.open(weknoraSyncDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'pkw.weknoraSyncDomainClose')
    this.intents = domain.table('intents')
    this.mappings = domain.table('mappings')
    this.dirty = domain.table('dirty')
    this.reverse = domain.table('reverse')

    // Live dirty hint (never the audit log). Durable dirty write happens inside
    // markDirty; this listener is loss-tolerant because full reconcile re-derives.
    this.ctx.on('pkw/event.committed', (signal) => {
      if (String(signal.workspaceId) !== this.config.workspaceId) return
      for (const event of signal.events) {
        if (event.aggregateType === 'note' || event.aggregateType === 'attachment') {
          void this.markDirty(event.aggregateType, event.aggregateId, event.aggregateRevision).catch(() => {})
        }
      }
    })

    this.ctx.interval(() => {
      void this.drain().catch((error: unknown) => {
        this.ctx.logger.warn('pkw weknora sync drain failed')
        this.ctx.logger.warn(error)
      })
    }, this.config.pollMs)

    // Restart resume: actively recover dirty/pending/unknown/retryable state,
    // not just wait for a new event.
    void this.drain().catch(() => {})
  }

  private reqIntents(): KvTable<string, IntentRecord> {
    if (this.intents === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.intents
  }

  private reqMappings(): KvTable<string, MappingRecord> {
    if (this.mappings === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.mappings
  }

  private reqDirty(): KvTable<string, DirtyRecord> {
    if (this.dirty === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.dirty
  }

  private reqReverse(): KvTable<string, z.infer<typeof reverseSchema>> {
    if (this.reverse === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.reverse
  }

  /** Workspace-scoped durable entity key. */
  private entityKey(entityType: string, entityId: string): string {
    return `${this.config.workspaceId}:${entityType}:${entityId}`
  }

  private now(): string {
    return new Date().toISOString()
  }

  /** Lightweight structured observability — never logs user content. */
  private logKnowledge(rec: { entityType: string; entityId: string; mime?: string; action: string; parser?: string; durationMs: number; result: string }): void {
    const id = rec.entityId.length > 12 ? `${rec.entityId.slice(0, 12)}…` : rec.entityId
    this.ctx.logger.info(`[pkw.knowledge] type=${rec.entityType} id=${id} mime=${rec.mime ?? '-'} action=${rec.action} parser=${rec.parser ?? '-'} ms=${rec.durationMs} result=${rec.result}`)
  }

  // ── integration availability ───────────────────────────────────────────────

  async integrationState(): Promise<'ready' | 'unavailable'> {
    const status = await this.ctx.pkwWeKnora.credentialStatus()
    return status === 'configured' ? 'ready' : 'unavailable'
  }

  // ── durable dirty ───────────────────────────────────────────────────────────

  async markDirty(entityType: string, entityId: string, revision = 0): Promise<void> {
    const key = this.entityKey(entityType, entityId)
    const existing = this.reqDirty().get(key)
    await this.reqDirty().put(key, {
      workspaceId: this.config.workspaceId,
      entityType,
      entityId,
      dirty: true,
      pendingOperationId: existing?.pendingOperationId,
      lastEventAt: this.now(),
      lastEventRevision: Math.max(existing?.lastEventRevision ?? 0, revision),
    })
  }

  private async clearDirty(key: string): Promise<void> {
    const rec = this.reqDirty().get(key)
    if (rec === undefined) return
    await this.reqDirty().put(key, { ...rec, dirty: false, pendingOperationId: undefined })
  }

  private async putDirty(rec: DirtyRecord): Promise<void> {
    await this.reqDirty().put(this.entityKey(rec.entityType, rec.entityId), rec)
  }

  /** Serialize remote mutations per entity; distinct entities run independently. */
  private withEntityLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.locks.set(key, run.then(() => {}, () => {}))
    return run
  }

  // ── public entry points ─────────────────────────────────────────────────────

  /** Force-sync one note now; returns its remote KnowledgeId, throws on remote failure. */
  async syncNote(noteId: NoteIdT): Promise<string> {
    return this.withEntityLock(this.entityKey(ENTITY_NOTE, String(noteId)), async () => {
      const id = await this.runNoteSync(noteId)
      if (id === undefined) throw new Error(`pkwWeKnoraSync: note '${noteId}' did not converge`)
      return id
    })
  }

  /** Force-sync one attachment now; returns its remote KnowledgeId, throws on remote failure. */
  async syncAttachment(attachmentId: AttachmentIdT): Promise<string> {
    return this.withEntityLock(this.entityKey(ENTITY_ATTACHMENT, String(attachmentId)), async () => {
      const id = await this.runAttachmentSync(attachmentId)
      if (id === undefined) throw new Error(`pkwWeKnoraSync: attachment '${attachmentId}' did not converge`)
      return id
    })
  }

  getMapping(noteId: NoteIdT): MappingRecord | undefined {
    return this.reqMappings().get(this.entityKey(ENTITY_NOTE, String(noteId)))
  }

  getAttachmentMapping(attachmentId: AttachmentIdT): MappingRecord | undefined {
    return this.reqMappings().get(this.entityKey(ENTITY_ATTACHMENT, String(attachmentId)))
  }

  /** Diagnostic surface (read-only): all durable intents. */
  listIntents(): IntentRecord[] {
    return [...this.reqIntents().entries()].map(([, v]) => v)
  }

  /** Diagnostic surface (read-only): all durable entity mappings. */
  listMappings(): MappingRecord[] {
    return [...this.reqMappings().entries()].map(([, v]) => v)
  }

  /** Diagnostic surface (read-only): all durable dirty records. */
  listDirty(): DirtyRecord[] {
    return [...this.reqDirty().entries()].map(([, v]) => v)
  }

  getMappingByKnowledgeId(knowledgeId: string): MappingRecord | undefined {
    const rev = this.reqReverse().get(knowledgeId)
    if (rev === undefined) return undefined
    return this.reqMappings().get(this.entityKey(rev.entityType, rev.entityId))
  }

  // ── worker ──────────────────────────────────────────────────────────────────

  /** Drain dirty entities + resumable intents. Never throws (records outcomes). */
  async drain(): Promise<void> {
    if ((await this.integrationState()) === 'unavailable') return

    // Only dirty records drive the worker. The invariant "active intent ⇔
    // dirty:true" holds because armPending() sets dirty:true before any remote
    // mutation and clearDirty() runs only after the intent reaches a terminal
    // state, so scanning the unbounded, operationId-keyed intents table here is
    // redundant. Restart resume still works: a crash mid-mutation leaves the
    // durable dirty flag set, and resumeCreate/resumeUpdate no-op until
    // nextRetryAt for retryable intents.
    const keys = new Set<string>()
    for (const [key, rec] of this.reqDirty().entries()) {
      if (rec.dirty) keys.add(key)
    }

    await Promise.all([...keys].map(key => this.dispatchEntity(key)))
  }

  private async dispatchEntity(key: string): Promise<void> {
    const rec = this.reqDirty().get(key)
    const entityType = rec?.entityType ?? this.entityTypeFromKey(key)
    const entityId = rec?.entityId ?? this.entityIdFromKey(key)
    await this.withEntityLock(key, async () => {
      try {
        if (entityType === ENTITY_NOTE) await this.runNoteSync(NoteId(entityId))
        else if (entityType === ENTITY_ATTACHMENT) await this.runAttachmentSync(AttachmentId(entityId))
      } catch (error) {
        this.ctx.logger.warn(`pkw weknora sync entity '${key}' failed: ${redactSecrets(String(error))}`)
      }
    })
  }

  private entityTypeFromKey(key: string): string {
    return key.split(':')[1] ?? ''
  }

  private entityIdFromKey(key: string): string {
    return key.split(':').slice(2).join(':')
  }

  // ── manual note sync ────────────────────────────────────────────────────────

  private async runNoteSync(noteId: NoteIdT): Promise<string | undefined> {
    const key = this.entityKey(ENTITY_NOTE, String(noteId))
    const record = this.ctx.pkwNotes.get(noteId)
    if (record === undefined) return undefined

    const mapping = this.reqMappings().get(key)
    if (record.deletedAt !== undefined) {
      await this.runRemoteDelete(ENTITY_NOTE, String(noteId), key, mapping)
      return undefined
    }

    const doc = await this.ctx.pkwNotes.getDocument(noteId)
    const fingerprint = remoteManualFingerprint(doc.markdown)

    if (mapping !== undefined && mapping.remoteFingerprint === fingerprint) {
      // No-op when already synced; reactivate a stale/deleted mapping on restore.
      if (mapping.syncState !== M_SYNCED) {
        await this.putMapping(key, { ...mapping, syncState: M_SYNCED, updatedAt: this.now() })
      }
      await this.clearDirty(key)
      return mapping.knowledgeId
    }

    const dirtyRec = this.reqDirty().get(key)
    const pending = dirtyRec?.pendingOperationId === undefined
      ? undefined
      : this.reqIntents().get(dirtyRec.pendingOperationId)

    if (mapping === undefined) {
      return pending !== undefined
        ? this.resumeCreate(noteId, doc.markdown, fingerprint, pending)
        : this.createManual(noteId, doc.markdown, fingerprint, doc.note.title)
    }
    return pending !== undefined
      ? this.resumeUpdate(noteId, doc.markdown, fingerprint, mapping, pending)
      : this.updateManual(noteId, doc.markdown, fingerprint, mapping, doc.note.title)
  }

  private async convergeDeleted(key: string, mapping: MappingRecord | undefined): Promise<void> {
    if (mapping === undefined) return
    if (mapping.syncState === M_DELETED || mapping.syncState === M_STALE) return
    // Immediate local hide: mark deleted and KEEP the reverse entry so retrieval
    // can filter this KnowledgeId while the async remote delete is still pending.
    await this.reqMappings().put(key, { ...mapping, syncState: M_DELETED, updatedAt: this.now() })
  }

  /** Durable, outcome-aware remote delete: enqueue intent, DELETE, verify absence. */
  private async runRemoteDelete(entityType: string, entityId: string, key: string, mapping: MappingRecord | undefined): Promise<void> {
    if (mapping === undefined) { await this.clearDirty(key); return }
    await this.convergeDeleted(key, mapping)

    const dirtyRec = this.reqDirty().get(key)
    let intent = dirtyRec?.pendingOperationId !== undefined ? this.reqIntents().get(dirtyRec.pendingOperationId) : undefined
    if (intent === undefined || intent.operationKind !== 'delete') {
      intent = await this.newIntent({ entityType, entityId, remoteFingerprint: mapping.remoteFingerprint, operationKind: 'delete' })
      await this.armPending(intent)
      return // armed; the next drain executes the DELETE
    }
    if (intent.state === S_COMPLETED || intent.state === S_SUPERSEDED) { await this.clearDirty(key); return }
    if (intent.state === S_RETRYABLE && intent.nextRetryAt !== undefined && intent.nextRetryAt > this.now()) return
    if (intent.state === S_PERMANENT) return

    try {
      await this.ctx.pkwWeKnora.deleteKnowledge(mapping.knowledgeId)
      if (await this.remoteGone(mapping.knowledgeId)) {
        // Keep the reverse entry: search filters by the deleted mapping's syncState,
        // so a deleted KnowledgeId stays hidden even after the remote converges.
        await this.recordCompletion(intent, mapping.knowledgeId)
        await this.clearDirty(key)
      } else {
        // Async worker still cleaning up: keep dirty so the next drain re-checks.
        await this.recordIntent(intent, { ...intent, attempt: intent.attempt + 1 })
      }
    } catch (error) {
      if (error instanceof WeKnoraError && error.kind === 'not_found') {
        await this.recordCompletion(intent, mapping.knowledgeId)
        await this.clearDirty(key)
      } else {
        await this.failIntent(intent, error, { mutation: true }, key)
      }
    }
  }

  private async remoteGone(knowledgeId: string): Promise<boolean> {
    try {
      await this.ctx.pkwWeKnora.getKnowledge(knowledgeId)
      return false
    } catch (error) {
      return error instanceof WeKnoraError && error.kind === 'not_found'
    }
  }

  private async newIntent(fields: {
    entityType: string
    entityId: string
    remoteFingerprint: string
    operationKind: string
    attempt?: number
    state?: string
  }): Promise<IntentRecord> {
    const now = this.now()
    const intent: IntentRecord = {
      operationId: randomUUID(),
      workspaceId: this.config.workspaceId,
      entityType: fields.entityType,
      entityId: fields.entityId,
      remoteFingerprint: fields.remoteFingerprint,
      kbId: this.config.kbId,
      operationKind: fields.operationKind,
      state: fields.state ?? S_RUNNING,
      attempt: fields.attempt ?? 1,
      recoveryAttempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.reqIntents().put(intent.operationId, intent)
    return intent
  }

  private async recordIntent(intent: IntentRecord, patch: Partial<IntentRecord>): Promise<void> {
    const next: IntentRecord = { ...intent, ...patch, updatedAt: this.now() }
    await this.reqIntents().put(intent.operationId, next)
  }

  private async armPending(intent: IntentRecord): Promise<void> {
    await this.reqDirty().put(this.entityKey(intent.entityType, intent.entityId), {
      workspaceId: this.config.workspaceId,
      entityType: intent.entityType,
      entityId: intent.entityId,
      dirty: true,
      pendingOperationId: intent.operationId,
      lastEventAt: this.now(),
      lastEventRevision: 0,
    })
  }

  /** Record a remote failure durably; a permanent failure clears the dirty flag (no retry storm). */
  private async failIntent(intent: IntentRecord, error: unknown, opts: { mutation: boolean }, key: string): Promise<Outcome> {
    const outcome = classifyOutcome(error, opts)
    await this.recordIntent(intent, {
      state: outcome.category,
      errorCategory: outcome.category,
      errorCertainty: outcome.certainty,
      nextRetryAt: outcome.category === S_PERMANENT
        ? undefined
        : new Date(Date.now() + backoffMs(intent.attempt, this.config.retryBaseMs, this.config.retryMaxMs)).toISOString(),
      attempt: intent.attempt + 1,
      lastError: redactSecrets(String(error)),
    })
    if (outcome.category === S_PERMANENT) await this.clearDirty(key)
    return outcome
  }

  private async recordCompletion(intent: IntentRecord, knowledgeId: string): Promise<void> {
    await this.recordIntent(intent, { state: S_COMPLETED, knowledgeId })
  }

  /** Re-check that the entity still holds the just-synced fingerprint before clearing dirty (lost-update guard). */
  private async settleDirty(key: string, entityType: string, entityId: string, syncedFingerprint: string): Promise<void> {
    const current = await this.currentFingerprint(entityType, entityId)
    if (current === syncedFingerprint) await this.clearDirty(key)
    // else: a newer change arrived mid-sync — keep dirty so the next drain re-syncs.
  }

  private async currentFingerprint(entityType: string, entityId: string): Promise<string | undefined> {
    if (entityType === ENTITY_NOTE) {
      const rec = this.ctx.pkwNotes.get(NoteId(entityId))
      if (rec === undefined || rec.deletedAt !== undefined) return undefined
      const doc = await this.ctx.pkwNotes.getDocument(NoteId(entityId))
      return remoteManualFingerprint(doc.markdown)
    }
    const rec = this.ctx.pkwAttachments.get(AttachmentId(entityId))
    if (rec === undefined || rec.deletedAt !== undefined) return undefined
    const bytes = await this.ctx.pkwAttachments.open(AttachmentId(entityId))
    return sha256Bytes(bytes)
  }

  private async putMapping(key: string, record: MappingRecord): Promise<void> {
    await this.reqMappings().put(key, record)
    await this.reqReverse().put(record.knowledgeId, {
      knowledgeId: record.knowledgeId,
      workspaceId: record.workspaceId,
      entityType: record.entityType,
      entityId: record.entityId,
    })
  }

  // ── CREATE path ─────────────────────────────────────────────────────────────

  private async createManual(noteId: NoteIdT, markdown: string, fingerprint: string, title: string): Promise<string | undefined> {
    const key = this.entityKey(ENTITY_NOTE, String(noteId))
    const intent = await this.newIntent({ entityType: ENTITY_NOTE, entityId: String(noteId), remoteFingerprint: fingerprint, operationKind: 'create' })
    await this.armPending(intent)
    const t0 = Date.now()
    try {
      const created = await this.ctx.pkwWeKnora.createManualKnowledge(this.config.kbId, { title, content: markdown })
      this.logKnowledge({ entityType: ENTITY_NOTE, entityId: String(noteId), mime: 'text/markdown', action: 'note-manual', parser: 'manual', durationMs: Date.now() - t0, result: 'ok' })
      await this.putMapping(key, {
        workspaceId: this.config.workspaceId, entityType: ENTITY_NOTE, entityId: String(noteId),
        knowledgeId: created.id, remoteFingerprint: fingerprint, localObservedRevision: 0,
        syncState: M_SYNCED, remoteParseStatus: created.parse_status ?? 'pending', updatedAt: this.now(),
      })
      await this.recordCompletion(intent, created.id)
      await this.settleDirty(key, ENTITY_NOTE, String(noteId), fingerprint)
      return created.id
    } catch (error) {
      await this.failIntent(intent, error, { mutation: true }, key)
      return undefined
    }
  }

  private async resumeCreate(noteId: NoteIdT, markdown: string, fingerprint: string, intent: IntentRecord): Promise<string | undefined> {
    const key = this.entityKey(ENTITY_NOTE, String(noteId))
    // If a known retryable intent is not yet due, do nothing.
    if (intent.state === S_RETRYABLE && intent.nextRetryAt !== undefined && intent.nextRetryAt > this.now()) return undefined
    if (intent.state === S_PERMANENT) return undefined

    const candidates = await this.enumerateManualCandidates(fingerprint)
    if (candidates.length === 0) {
      const grace = this.config.recoveryGraceAttempts
      if (intent.recoveryAttempts < grace) {
        await this.recordIntent(intent, {
          recoveryAttempts: intent.recoveryAttempts + 1,
          nextRetryAt: new Date(Date.now() + backoffMs(intent.recoveryAttempts + 1, this.config.retryBaseMs, this.config.retryMaxMs)).toISOString(),
        })
        return undefined
      }
      // Grace exhausted with zero visible candidates → safe re-create (at-least-once).
      await this.recordIntent(intent, { state: S_SUPERSEDED })
      await this.clearDirty(key)
      return this.createManual(noteId, markdown, fingerprint, (await this.ctx.pkwNotes.getDocument(noteId)).note.title)
    }

    const canonical = this.selectCanonical(candidates)
    await this.putMapping(key, {
      workspaceId: this.config.workspaceId, entityType: ENTITY_NOTE, entityId: String(noteId),
      knowledgeId: canonical.knowledgeId, remoteFingerprint: fingerprint, localObservedRevision: 0,
      syncState: M_SYNCED, remoteParseStatus: canonical.parseStatus,
      supersededKnowledgeIds: candidates.filter(c => c.knowledgeId !== canonical.knowledgeId).map(c => c.knowledgeId),
      updatedAt: this.now(),
    })
    await this.recordCompletion(intent, canonical.knowledgeId)
    await this.settleDirty(key, ENTITY_NOTE, String(noteId), fingerprint)
    return canonical.knowledgeId
  }

  // ── UPDATE path ─────────────────────────────────────────────────────────────

  private async updateManual(noteId: NoteIdT, markdown: string, fingerprint: string, mapping: MappingRecord, title: string): Promise<string | undefined> {
    const key = this.entityKey(ENTITY_NOTE, String(noteId))
    const intent = await this.newIntent({ entityType: ENTITY_NOTE, entityId: String(noteId), remoteFingerprint: fingerprint, operationKind: 'update' })
    await this.armPending(intent)
    try {
      const updated = await this.ctx.pkwWeKnora.updateManualKnowledge(mapping.knowledgeId, { title, content: markdown })
      await this.putMapping(key, {
        ...mapping, knowledgeId: updated.id, remoteFingerprint: fingerprint, syncState: M_SYNCED,
        remoteParseStatus: updated.parse_status ?? mapping.remoteParseStatus, updatedAt: this.now(),
      })
      await this.recordCompletion(intent, updated.id)
      await this.settleDirty(key, ENTITY_NOTE, String(noteId), fingerprint)
      return updated.id
    } catch (error) {
      // Remote missing (PUT → 404): safe recreate, new remote identity.
      if (error instanceof WeKnoraError && error.kind === 'not_found') {
        await this.recordIntent(intent, { state: S_SUPERSEDED })
        await this.reqReverse().delete(mapping.knowledgeId)
        await this.reqMappings().delete(key)
        await this.clearDirty(key)
        return this.createManual(noteId, markdown, fingerprint, title)
      }
      await this.failIntent(intent, error, { mutation: true }, key)
      return undefined
    }
  }

  private async resumeUpdate(noteId: NoteIdT, markdown: string, fingerprint: string, mapping: MappingRecord, intent: IntentRecord): Promise<string | undefined> {
    const key = this.entityKey(ENTITY_NOTE, String(noteId))
    if (intent.state === S_RETRYABLE && intent.nextRetryAt !== undefined && intent.nextRetryAt > this.now()) return undefined
    if (intent.state === S_PERMANENT) return undefined

    // UPDATE recovery: known KnowledgeId → read remote content, no full-KB scan.
    let remote: string
    try {
      remote = await this.ctx.pkwWeKnora.readManualContent(mapping.knowledgeId)
    } catch (error) {
      if (error instanceof WeKnoraError && error.kind === 'not_found') {
        // Remote missing → recreate (new identity), converge mapping.
        await this.recordIntent(intent, { state: S_SUPERSEDED })
        await this.reqReverse().delete(mapping.knowledgeId)
        await this.reqMappings().delete(key)
        await this.clearDirty(key)
        return this.createManual(noteId, markdown, fingerprint, (await this.ctx.pkwNotes.getDocument(noteId)).note.title)
      }
      await this.failIntent(intent, error, { mutation: false }, key)
      return undefined
    }

    if (remoteManualFingerprint(remote) === fingerprint) {
      // PUT already applied (response lost); mapping becomes authoritative.
      await this.putMapping(key, { ...mapping, remoteFingerprint: fingerprint, syncState: M_SYNCED, updatedAt: this.now() })
      await this.recordCompletion(intent, mapping.knowledgeId)
      await this.settleDirty(key, ENTITY_NOTE, String(noteId), fingerprint)
      return mapping.knowledgeId
    }

    // Remote still holds previous state → re-apply the update.
    await this.recordIntent(intent, { state: S_RUNNING, attempt: intent.attempt + 1 })
    const title = (await this.ctx.pkwNotes.getDocument(noteId)).note.title
    try {
      const updated = await this.ctx.pkwWeKnora.updateManualKnowledge(mapping.knowledgeId, { title, content: markdown })
      await this.putMapping(key, { ...mapping, knowledgeId: updated.id, remoteFingerprint: fingerprint, syncState: M_SYNCED, remoteParseStatus: updated.parse_status ?? mapping.remoteParseStatus, updatedAt: this.now() })
      await this.recordCompletion(intent, updated.id)
      await this.settleDirty(key, ENTITY_NOTE, String(noteId), fingerprint)
      return updated.id
    } catch (error) {
      await this.failIntent(intent, error, { mutation: true }, key)
      return undefined
    }
  }

  // ── create recovery: candidate enumeration + canonical selection ───────────

  private async enumerateManualCandidates(fingerprint: string): Promise<Array<{ knowledgeId: string; parseStatus?: string }>> {
    const out: Array<{ knowledgeId: string; parseStatus?: string }> = []
    // PKW always ingests with channel='pkw'; WeKnora's `source` query filters by
    // channel for non-manual/url values, so this avoids listing + downloading the
    // entire shared KB during CREATE unknown-outcome recovery.
    const list = await this.ctx.pkwWeKnora.listKnowledge(this.config.kbId, { source: 'pkw' })
    for (const item of list) {
      let content: string
      try { content = await this.ctx.pkwWeKnora.readManualContent(item.id) } catch { continue }
      if (remoteManualFingerprint(content) !== fingerprint) continue
      out.push({ knowledgeId: item.id, parseStatus: item.parse_status })
    }
    return out
  }

  /** Deterministic canonical: completed parse first, then stable id order. */
  private selectCanonical(candidates: Array<{ knowledgeId: string; parseStatus?: string }>): { knowledgeId: string; parseStatus?: string } {
    return [...candidates].sort((a, b) => {
      const ap = a.parseStatus === 'completed' ? 0 : 1
      const bp = b.parseStatus === 'completed' ? 0 : 1
      if (ap !== bp) return ap - bp
      return a.knowledgeId < b.knowledgeId ? -1 : a.knowledgeId > b.knowledgeId ? 1 : 0
    })[0]!
  }

  /** Recovery entry point (kept for direct callers): enumerate + recover, serialized per entity. */
  async recoverNote(noteId: NoteIdT): Promise<string | undefined> {
    return this.withEntityLock(this.entityKey(ENTITY_NOTE, String(noteId)), async () => {
      const key = this.entityKey(ENTITY_NOTE, String(noteId))
      const record = this.ctx.pkwNotes.get(noteId)
      if (record === undefined || record.deletedAt !== undefined) return undefined
      const doc = await this.ctx.pkwNotes.getDocument(noteId)
      const fingerprint = remoteManualFingerprint(doc.markdown)
      const mapping = this.reqMappings().get(key)
      if (mapping !== undefined) {
        try {
          const remote = await this.ctx.pkwWeKnora.readManualContent(mapping.knowledgeId)
          if (remoteManualFingerprint(remote) === fingerprint) return mapping.knowledgeId
          return this.updateManual(noteId, doc.markdown, fingerprint, mapping, doc.note.title)
        } catch {
          return undefined
        }
      }
      const candidates = await this.enumerateManualCandidates(fingerprint)
      if (candidates.length === 0) return undefined
      const canonical = this.selectCanonical(candidates)
      await this.putMapping(key, {
        workspaceId: this.config.workspaceId, entityType: ENTITY_NOTE, entityId: String(noteId),
        knowledgeId: canonical.knowledgeId, remoteFingerprint: fingerprint, localObservedRevision: 0,
        syncState: M_SYNCED, remoteParseStatus: canonical.parseStatus,
        supersededKnowledgeIds: candidates.filter(c => c.knowledgeId !== canonical.knowledgeId).map(c => c.knowledgeId),
        updatedAt: this.now(),
      })
      return canonical.knowledgeId
    })
  }

  // ── attachment sync ─────────────────────────────────────────────────────────

  private async runAttachmentSync(attachmentId: AttachmentIdT): Promise<string | undefined> {
    const key = this.entityKey(ENTITY_ATTACHMENT, String(attachmentId))
    const record = this.ctx.pkwAttachments.get(attachmentId)
    if (record === undefined) return undefined

    const mapping = this.reqMappings().get(key)
    if (record.deletedAt !== undefined) {
      await this.runRemoteDelete(ENTITY_ATTACHMENT, String(attachmentId), key, mapping)
      return undefined
    }

    const bytes = await this.ctx.pkwAttachments.open(attachmentId)
    const fingerprint = sha256Bytes(bytes)
    const fileHash = md5Bytes(bytes)

    // Replacement already in flight → resume it (poll parse status, switch).
    if (mapping !== undefined && mapping.replacementKnowledgeId !== undefined
      && (mapping.replacementState === 'uploaded' || mapping.replacementState === 'parsing')) {
      return this.resumeReplacement(key, mapping, fingerprint, fileHash)
    }

    // No-op when synced; reactivate a stale/deleted mapping on restore (same bytes).
    if (mapping !== undefined && mapping.remoteFingerprint === fingerprint) {
      if (mapping.syncState !== M_SYNCED) {
        await this.putMapping(key, { ...mapping, syncState: M_SYNCED, updatedAt: this.now() })
      }
      await this.clearDirty(key)
      return mapping.knowledgeId
    }

    const dirtyRec = this.reqDirty().get(key)
    const pending = dirtyRec?.pendingOperationId === undefined
      ? undefined
      : this.reqIntents().get(dirtyRec.pendingOperationId)

    if (mapping === undefined) {
      return pending !== undefined && (pending.state === S_UNKNOWN || pending.state === S_RUNNING || pending.state === S_PENDING)
        ? this.resumeUpload(attachmentId, key, fingerprint, fileHash, bytes, record.filename, record.mimeType, pending)
        : this.uploadAttachment(attachmentId, key, fingerprint, fileHash, bytes, record.filename, record.mimeType)
    }

    // Local bytes changed while a remote object exists → safe replacement.
    return this.replaceAttachment(attachmentId, key, mapping, fingerprint, fileHash, bytes, record.filename, record.mimeType)
  }

  private async uploadAttachment(attachmentId: AttachmentIdT, key: string, fingerprint: string, fileHash: string, bytes: Uint8Array, filename: string, mimeType: string, existingIntent?: IntentRecord): Promise<string | undefined> {
    const intent = existingIntent ?? await this.newIntent({ entityType: ENTITY_ATTACHMENT, entityId: String(attachmentId), remoteFingerprint: fingerprint, operationKind: 'upload' })
    if (existingIntent === undefined) await this.armPending(intent)
    const t0 = Date.now()
    try {
      const uploaded = await this.ctx.pkwWeKnora.uploadFile(this.config.kbId, { content: bytes, filename, channel: 'pkw', mimeType })
      this.logKnowledge({ entityType: ENTITY_ATTACHMENT, entityId: String(attachmentId), mime: mimeType, action: 'attachment-file', durationMs: Date.now() - t0, result: 'ok' })
      await this.putMapping(key, {
        workspaceId: this.config.workspaceId, entityType: ENTITY_ATTACHMENT, entityId: String(attachmentId),
        knowledgeId: uploaded.id, remoteFingerprint: fingerprint, remoteFileHash: fileHash,
        localObservedRevision: 0, syncState: M_SYNCED, remoteParseStatus: uploaded.parse_status ?? 'pending', updatedAt: this.now(),
      })
      await this.recordCompletion(intent, uploaded.id)
      await this.settleDirty(key, ENTITY_ATTACHMENT, String(attachmentId), fingerprint)
      return uploaded.id
    } catch (error) {
      // 409 duplicate_file: claim only if the existing object IS the intended state.
      if (error instanceof WeKnoraError && error.kind === 'conflict' && error.duplicate !== undefined) {
        if (error.duplicate.file_hash === fileHash) {
          await this.putMapping(key, {
            workspaceId: this.config.workspaceId, entityType: ENTITY_ATTACHMENT, entityId: String(attachmentId),
            knowledgeId: error.duplicate.id, remoteFingerprint: fingerprint, remoteFileHash: fileHash,
            localObservedRevision: 0, syncState: M_SYNCED, remoteParseStatus: error.duplicate.parse_status ?? 'pending', updatedAt: this.now(),
          })
          await this.recordCompletion(intent, error.duplicate.id)
          await this.settleDirty(key, ENTITY_ATTACHMENT, String(attachmentId), fingerprint)
          return error.duplicate.id
        }
        // Conflict mismatch: permanent — do NOT claim a foreign object.
        await this.failIntent(intent, error, { mutation: true }, key)
        return undefined
      }
      await this.failIntent(intent, error, { mutation: true }, key)
      return undefined
    }
  }

  private async resumeUpload(attachmentId: AttachmentIdT, key: string, fingerprint: string, fileHash: string, bytes: Uint8Array, filename: string, mimeType: string, intent: IntentRecord): Promise<string | undefined> {
    // Upload dedups by MD5: a re-upload either returns the same object (409) or
    // creates it. This is the unknown-upload-outcome recovery primitive.
    await this.recordIntent(intent, { state: S_RUNNING, attempt: intent.attempt + 1 })
    return this.uploadAttachment(attachmentId, key, fingerprint, fileHash, bytes, filename, mimeType, intent)
  }

  private async replaceAttachment(attachmentId: AttachmentIdT, key: string, mapping: MappingRecord, fingerprint: string, fileHash: string, bytes: Uint8Array, filename: string, mimeType: string): Promise<string | undefined> {
    const intent = await this.newIntent({ entityType: ENTITY_ATTACHMENT, entityId: String(attachmentId), remoteFingerprint: fingerprint, operationKind: 'replacement' })
    await this.armPending(intent)

    // Upload the replacement B (never delete A first).
    let uploaded
    try {
      uploaded = await this.ctx.pkwWeKnora.uploadFile(this.config.kbId, { content: bytes, filename, channel: 'pkw', mimeType })
    } catch (error) {
      if (error instanceof WeKnoraError && error.kind === 'conflict' && error.duplicate !== undefined && error.duplicate.file_hash === fileHash) {
        uploaded = error.duplicate
      } else {
        await this.failIntent(intent, error, { mutation: true }, key)
        return undefined
      }
    }

    // Durable replacement marker BEFORE switching, so a crash here resumes.
    await this.reqMappings().put(key, {
      ...mapping,
      replacementKnowledgeId: uploaded.id,
      replacementFingerprint: fingerprint,
      replacementState: 'parsing',
      updatedAt: this.now(),
    })
    await this.recordIntent(intent, { ...intent, state: S_RUNNING, replacementKnowledgeId: uploaded.id })

    const switched = await this.finishReplacement(key, mapping, uploaded.id, fingerprint, fileHash, intent)
    return switched
  }

  private async resumeReplacement(key: string, mapping: MappingRecord, fingerprint: string, fileHash: string): Promise<string | undefined> {
    const repId = mapping.replacementKnowledgeId!
    const intentId = this.reqDirty().get(key)?.pendingOperationId
    const intent = intentId === undefined ? undefined : this.reqIntents().get(intentId)
    return this.finishReplacement(key, mapping, repId, fingerprint, fileHash, intent)
  }

  /** Poll replacement B parse status; switch active mapping only on `completed`. */
  private async finishReplacement(key: string, mapping: MappingRecord, replacementId: string, fingerprint: string, fileHash: string, intent?: IntentRecord): Promise<string | undefined> {
    let knowledge
    try {
      knowledge = await this.ctx.pkwWeKnora.getKnowledge(replacementId)
    } catch (error) {
      if (intent !== undefined) await this.failIntent(intent, error, { mutation: false }, key)
      return undefined
    }

    const status = knowledge.parse_status ?? 'pending'
    if (status === 'completed') {
      // Switch active mapping to B; old A becomes superseded (kept, not deleted).
      const oldId = mapping.knowledgeId
      await this.putMapping(key, {
        ...mapping,
        knowledgeId: replacementId,
        remoteFingerprint: fingerprint,
        remoteFileHash: fileHash,
        replacementKnowledgeId: undefined,
        replacementFingerprint: undefined,
        replacementState: 'completed',
        supersededKnowledgeIds: [...(mapping.supersededKnowledgeIds ?? []), ...(oldId !== replacementId ? [oldId] : [])],
        syncState: M_SYNCED,
        remoteParseStatus: status,
        updatedAt: this.now(),
      })
      await this.reqReverse().delete(oldId)
      if (intent !== undefined) await this.recordCompletion(intent, replacementId)
      await this.settleDirty(key, ENTITY_ATTACHMENT, mapping.entityId, fingerprint)
      return replacementId
    }
    if (status === 'failed' || status === 'cancelled') {
      // B failed: keep A active.
      await this.reqMappings().put(key, { ...mapping, replacementState: status, updatedAt: this.now() })
      if (intent !== undefined) await this.recordIntent(intent, { state: S_PERMANENT, errorCategory: 'permanent', errorCertainty: 'known', lastError: `parse ${status}` })
      await this.clearDirty(key)
      return undefined
    }
    // pending / processing / finalizing → keep polling (worker re-arms via dirty).
    await this.reqMappings().put(key, { ...mapping, replacementState: 'parsing', remoteParseStatus: status, updatedAt: this.now() })
    await this.reqDirty().put(key, {
      workspaceId: this.config.workspaceId, entityType: ENTITY_ATTACHMENT, entityId: mapping.entityId,
      dirty: true, pendingOperationId: intent?.operationId, lastEventAt: this.now(), lastEventRevision: 0,
    })
    return undefined
  }

  // ── full reconcile ──────────────────────────────────────────────────────────

  /** Reconcile local canonical entities → durable dirty/deleted state. Local-first. */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { markedDirty: 0, markedDeleted: 0 }

    // Notes: every current (and deleted) canonical entity.
    for (const rec of this.ctx.pkwNotes.list({ includeDeleted: true })) {
      const key = this.entityKey(ENTITY_NOTE, String(rec.noteId))
      const mapping = this.reqMappings().get(key)
      if (rec.deletedAt !== undefined) {
        await this.convergeDeleted(key, mapping)
        if (mapping !== undefined && mapping.syncState !== M_DELETED) report.markedDeleted += 1
        continue
      }
      const doc = await this.ctx.pkwNotes.getDocument(rec.noteId)
      const fingerprint = remoteManualFingerprint(doc.markdown)
      if (mapping === undefined || mapping.remoteFingerprint !== fingerprint || mapping.syncState !== M_SYNCED) {
        await this.markDirty(ENTITY_NOTE, String(rec.noteId), rec.observedRevision)
        report.markedDirty += 1
      }
    }

    // Attachments.
    for (const rec of this.ctx.pkwAttachments.list({ includeDeleted: true })) {
      const key = this.entityKey(ENTITY_ATTACHMENT, String(rec.id))
      const mapping = this.reqMappings().get(key)
      if (rec.deletedAt !== undefined) {
        await this.convergeDeleted(key, mapping)
        if (mapping !== undefined && mapping.syncState !== M_DELETED) report.markedDeleted += 1
        continue
      }
      // Prefer the catalog's sha256 (already a projection of the current binary);
      // fall back to a full open() only when the catalog lacks a hash.
      const fingerprint = rec.sha256 ?? sha256Bytes(await this.ctx.pkwAttachments.open(rec.id))
      if (mapping === undefined || mapping.remoteFingerprint !== fingerprint || mapping.syncState !== M_SYNCED) {
        await this.markDirty(ENTITY_ATTACHMENT, String(rec.id), rec.observedRevision)
        report.markedDirty += 1
      }
    }

    // Mappings pointing at entities no longer tracked (stale) stay until the
    // entity reappears or is re-created; the worker's remote-missing recovery
    // handles 404. Re-activation happens naturally when a restore re-marks dirty.
    return report
  }

  // ── retrieval ───────────────────────────────────────────────────────────────

  async search(query: string, opts: { kbId?: string; limit?: number; knowledgeIds?: string[] } = {}): Promise<RetrievalResult[]> {
    const kbId = opts.kbId ?? this.config.kbId
    const chunks: SearchResultChunk[] = await this.ctx.pkwWeKnora.hybridSearch(kbId, {
      query,
      limit: opts.limit ?? 10,
      ...(opts.knowledgeIds !== undefined ? { knowledgeIds: opts.knowledgeIds } : {}),
    })
    // Immediate hide: a locally-deleted (or stale) projection must not surface in
    // PKW retrieval even while the async WeKnora delete is still converging.
    return chunks
      .filter(chunk => {
        const mapping = this.getMappingByKnowledgeId(chunk.knowledge_id)
        return mapping === undefined || (mapping.syncState !== M_DELETED && mapping.syncState !== M_STALE)
      })
      .map(chunk => this.toRetrievalResult(kbId, chunk))
  }

  private toRetrievalResult(kbId: string, chunk: SearchResultChunk): RetrievalResult {
    const rev = this.reqReverse().get(chunk.knowledge_id)
    return {
      remote: {
        kbId,
        knowledgeId: chunk.knowledge_id,
        chunkId: chunk.id,
        chunkIndex: chunk.chunk_index,
        score: chunk.score,
        content: chunk.content,
        title: chunk.knowledge_title,
        filename: chunk.knowledge_filename,
        source: chunk.knowledge_source,
        channel: chunk.knowledge_channel,
      },
      ...(rev === undefined ? {} : { local: { workspaceId: rev.workspaceId, entityType: rev.entityType, entityId: rev.entityId } }),
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { pkwWeKnoraSync: WeKnoraSyncService }
}

export default WeKnoraSyncService

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
 * Worker model: committed events and durable catalog changes MARK dirty; the
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
import { AttachmentId, NoteId, NoteUpdateConflictError, enrichNoteForKnowledge, extractAttachmentSummary, hasCompanionUserContent, insertAttachmentSummary, stripInternalFrontmatter } from '@deepseek-ai/dsh-pkw-domain'
import type { NoteId as NoteIdT, AttachmentId as AttachmentIdT } from '@deepseek-ai/dsh-pkw-domain'
import {
  WeKnoraError,
  WeKnoraNotConfiguredError,
  md5Bytes,
  redactSecrets,
  remoteManualFingerprint,
  sha256Bytes,
  sha256Text,
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
  remoteSummaryStatus: z.string().optional(),
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

/** Note-scoped attachment processing projection (NOT a persistent Knowledge mapping). */
const processingRecordSchema = z.object({
  attachmentId: z.string(),
  workspaceId: z.string(),
  processingKbId: z.string().optional(),
  processingKnowledgeId: z.string().optional(),
  state: z.string(), // queued | uploading | parsing | derived-ready | failed
  parseStatus: z.string().optional(),
  summaryStatus: z.string().optional(),
  summary: z.string().optional(),
  chunks: z.array(z.string()).optional(),
  derivedHash: z.string().optional(),
  /** Parser config fingerprint at capture time (for needsReparse detection). */
  configFingerprint: z.string().optional(),
  lastError: z.string().optional(),
  updatedAt: z.string(),
})

/** One durable Processing KB identity + parser config fingerprint per workspace. */
const processingKbSchema = z.object({
  workspaceId: z.string(),
  processingKbId: z.string(),
  configFingerprint: z.string(),
  /** Old Processing KB ids retired by a create-only config rebuild (cleanup pending). */
  retiredKbIds: z.array(z.string()).optional(),
  updatedAt: z.string(),
})

export const weknoraSyncDomainSpec = defineDomain({
  name: 'pkw_weknora_sync',
  // No migrations (harness pre-release stance: a medium stamped with a
  // different version rejects at open; changing a schema migrates by hand).
  version: 3,
  tables: {
    intents: domainTable<string, z.infer<typeof syncIntentSchema>>(syncIntentSchema),
    mappings: domainTable<string, z.infer<typeof entityMappingSchema>>(entityMappingSchema),
    dirty: domainTable<string, z.infer<typeof dirtySchema>>(dirtySchema),
    reverse: domainTable<string, z.infer<typeof reverseSchema>>(reverseSchema),
    processing: domainTable<string, z.infer<typeof processingRecordSchema>>(processingRecordSchema),
    processing_kb: domainTable<string, z.infer<typeof processingKbSchema>>(processingKbSchema),
  },
})

type IntentRecord = z.infer<typeof syncIntentSchema>
type MappingRecord = z.infer<typeof entityMappingSchema>
type DirtyRecord = z.infer<typeof dirtySchema>
type ProcessingRecord = z.infer<typeof processingRecordSchema>

const ENTITY_NOTE = 'note'
const ENTITY_ATTACHMENT = 'attachment'

/**
 * Normalize a Note's Markdown for the WeKnora manual-knowledge projection.
 * Managed attachment references (`attachments/<id>/<file>`) are relative and
 * would surface as "invalid image link" in WeKnora; rewrite them to readable
 * text so the projection is honest and self-contained. Canonical Markdown is
 * unchanged locally — this is projection-only.
 */
function normalizeForRemote(markdown: string): string {
  const imgRe = /!\[[^\]]*\]\([^)]*attachments\/[^/]+\/([^)]+)\)/g
  const fileRe = /\[([^\]]*)\]\([^)]*attachments\/[^/]+\/[^)]+\)/g
  return markdown
    .replace(imgRe, (_m, filename) => `图片附件：${filename}`)
    .replace(fileRe, (_m, text) => text)
}

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

/**
 * Relative relevance band for retrieval. WeKnora hybrid-search scores are
 * RRF-style fused values (rank-based, ~0.016 at rank 1) — NOT a 0..1 cosine —
 * so an absolute floor is meaningless and silently erased every result. Only a
 * relative band of the top score is valid. See the live-verification note in
 * the sprint report.
 */
const RELEVANCE_RELATIVE_FLOOR = 0.25

export interface RetrievalEvidence {
  chunkId: string
  content: string
  score: number
  filename?: string
  source?: 'main' | 'processing'
}

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
    /** For an attachment hit, the Companion Note to open (if one exists) so a single uploaded file surfaces as one knowledge object. */
    companionNoteId?: string
    /** A2 federation: when a Processing-KB hit remaps to an owner Note, the matched Source Asset (AttachmentId). */
    matchedAttachmentId?: string
    /** Why this Business Knowledge matched: 'note' (Main KB body), 'attachment' (Processing KB remapped), or 'both'. */
    matchReason?: 'note' | 'attachment' | 'both'
  }
  /** Internal retrieval evidence: every chunk that matched, aggregated to one business object. Never exposed verbatim to the user. */
  evidence?: RetrievalEvidence[]
}

/**
 * Readable dev-diagnostic for one retrieval run (C4). Stage-by-stage counts so a
 * "search found nothing" can be localized to exactly the layer that dropped the
 * hits — never exposed in the product UI, only logged + available on the RPC.
 */
export interface RetrievalTrace {
  processingUnavailable?: boolean
  query: string
  mainRaw: number
  processingRaw: number
  afterBusiness: number
  afterCanonical: number
  afterRelevance: number
  final: number
}

/**
 * Map WeKnora's real parse status enum to the user-facing processing phase.
 * Unknown values map to 'processing' (处理中), never 'waiting' (等待解析), so a
 * status we don't recognise still shows "working on it" rather than "not started".
 */
export function mapWeKnoraProcessingPhase(parseStatus?: string): 'waiting' | 'processing' | 'optimizing' | 'ready' | 'failed' {
  switch (parseStatus) {
    case 'completed': return 'ready'
    case 'failed': case 'error': return 'failed'
    case 'optimizing': return 'optimizing'
    case 'processing': case 'parsing': return 'processing'
    case 'pending': case 'queued': case 'waiting': case 'none': case '': return 'waiting'
    default: return 'processing'
  }
}

/**
 * Derive a user-facing processing phase from WeKnora's parse AND summary status
 * (a file can be parse-completed while its summary is still optimizing).
 */
export function weKnoraKnowledgePhase(parseStatus?: string, summaryStatus?: string): 'waiting' | 'processing' | 'optimizing' | 'ready' | 'failed' {
  if (parseStatus === 'failed' || summaryStatus === 'failed') return 'failed'
  if (parseStatus === 'completed' && (summaryStatus === undefined || summaryStatus === '' || summaryStatus === 'none' || summaryStatus === 'completed')) return 'ready'
  if (summaryStatus === 'optimizing' || parseStatus === 'optimizing') return 'optimizing'
  if (parseStatus === 'processing' || parseStatus === 'parsing' || summaryStatus === 'processing') return 'processing'
  if (parseStatus === 'pending' || parseStatus === 'queued' || parseStatus === 'waiting' || parseStatus === undefined) return 'waiting'
  return 'processing'
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
  private processing?: KvTable<string, ProcessingRecord>
  private processingKb?: KvTable<string, z.infer<typeof processingKbSchema>>

  /** Per-entity in-process serialization: one remote mutation per entity at a time. */
  private readonly locks = new Map<string, Promise<void>>()

  /** Short bookkeeping queues, independent of slow remote mutations. */
  private readonly dirtyWrites = new Map<string, Promise<void>>()
  /** A pass may acknowledge only changes accepted before that pass started. */
  private readonly activePasses = new Map<string, { invalidated: boolean }>()

  /** Throttle tick for the periodic standalone-attachment processing reconcile. */
  private reconcileTick = 0

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwWeKnoraSync')
  }

  protected async [Service.init](): Promise<void> {
    const domain: Domain<typeof weknoraSyncDomainSpec> = await this.ctx.storageDomain.open(weknoraSyncDomainSpec)
    this.ctx.effect(() => async () => {
      await Promise.all([...this.dirtyWrites.values()])
      await domain.close()
    }, 'pkw.weknoraSyncDomainClose')
    this.intents = domain.table('intents')
    this.mappings = domain.table('mappings')
    this.dirty = domain.table('dirty')
    this.reverse = domain.table('reverse')
    this.processing = domain.table('processing')
    this.processingKb = domain.table('processing_kb')

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

    // The event log commits BEFORE the canonical catalog is updated. An early
    // event hint can therefore be consumed against the previous catalog state.
    // Domain notifications arrive after durability AND the in-memory snapshot;
    // this second hint also covers projection repair and metadata-only changes.
    this.ctx.on('domain/changed', (change) => {
      const entityType = change.domain === 'pkw_notes' && change.table === 'note_index' ? ENTITY_NOTE
        : change.domain === 'pkw_attachments' && change.table === 'attachments' ? ENTITY_ATTACHMENT : undefined
      if (entityType === undefined || change.operation !== 'put') return
      const value = change.value as { workspaceId?: string }
      if (String(value.workspaceId) !== this.config.workspaceId) return
      void this.markDirty(entityType, change.key).catch(() => {})
    })

    this.ctx.interval(() => {
      void this.drain().catch((error: unknown) => {
        this.ctx.logger.warn('pkw weknora sync drain failed')
        this.ctx.logger.warn(error)
      })
      void this.drainCompanionSummaries().catch((error: unknown) => {
        this.ctx.logger.warn('pkw companion summary sweep failed')
        this.ctx.logger.warn(error)
      })
      void this.drainNoteScopedProcessing().catch((error: unknown) => {
        this.ctx.logger.warn('pkw note-scoped processing sweep failed')
        this.ctx.logger.warn(error)
      })
      // Standalone attachment processing reconcile: throttled (every ~5s) to avoid
      // hammering WeKnora, but keeps PKW following remote parse/summary status.
      if (++this.reconcileTick % 5 === 0) {
        void this.reconcileNonTerminalAttachments().catch((error: unknown) => {
          this.ctx.logger.warn('pkw attachment processing reconcile failed')
          this.ctx.logger.warn(error)
        })
      }
    }, this.config.pollMs)

    // Restart resume: actively recover dirty/pending/unknown/retryable state,
    // not just wait for a new event.
    void this.rearmDeleted().then(() => this.drain()).catch(() => {})
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

  private reqProcessing(): KvTable<string, ProcessingRecord> {
    if (this.processing === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.processing
  }

  private reqProcessingKb(): KvTable<string, z.infer<typeof processingKbSchema>> {
    if (this.processingKb === undefined) throw new Error('pkwWeKnoraSync not started')
    return this.processingKb
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
    // Invalidate synchronously at receipt, even when the durable write queues
    // behind an older clear. Revision 0 hints (derived content) count as changes.
    const pass = this.activePasses.get(key)
    if (pass !== undefined) pass.invalidated = true
    await this.withDirtyWrite(key, async () => {
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
    })
  }

  private async clearDirty(key: string): Promise<void> {
    const pass = this.activePasses.get(key)
    if (pass === undefined) throw new Error('clearDirty requires an entity sync pass')
    await this.withDirtyWrite(key, async () => {
      const rec = this.reqDirty().get(key)
      if (rec === undefined) return
      // For example, a note-scoped attachment can have an unfinished legacy
      // remote DELETE while its derived-content processing has finished.
      if (this.activeIntent(rec) !== undefined) return
      await this.reqDirty().put(key, { ...rec, dirty: pass.invalidated, pendingOperationId: undefined })
    })
  }

  private activeIntent(rec: DirtyRecord | undefined): IntentRecord | undefined {
    const intent = rec?.pendingOperationId === undefined ? undefined : this.reqIntents().get(rec.pendingOperationId)
    return intent !== undefined && ![S_COMPLETED, S_SUPERSEDED, S_PERMANENT].includes(intent.state) ? intent : undefined
  }

  private withDirtyWrite(key: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.dirtyWrites.get(key) ?? Promise.resolve()).then(fn, fn)
    const tail = run.then(() => {}, () => {})
    this.dirtyWrites.set(key, tail)
    void tail.then(() => {
      if (this.dirtyWrites.get(key) === tail) this.dirtyWrites.delete(key)
    })
    return run
  }

  /** Serialize remote mutations per entity; distinct entities run independently. */
  private withEntityLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const run = prev.then(async () => {
      await this.dirtyWrites.get(key)
      const pass = { invalidated: false }
      this.activePasses.set(key, pass)
      try { return await fn() } finally { this.activePasses.delete(key) }
    })
    const tail = run.then(() => {}, () => {})
    this.locks.set(key, tail)
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
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

  /**
   * Companion Note summary materialization: when the Attachment Knowledge
   * summary is ready (description non-empty), upsert the managed summary block
   * into the Companion Note's canonical Markdown. Idempotent (same summary =
   * no-op), replace-in-place, and updates the SAME Note KnowledgeId (never
   * creates a second manual knowledge).
   */
  async materializeCompanionSummary(attachmentId: AttachmentIdT): Promise<boolean> {
    const rec = this.ctx.pkwAttachments.get(attachmentId)
    if (rec === undefined || rec.companionNoteId === undefined) return false
    // Poll sweeps and direct callers can overlap. Serialize the whole
    // read/compare/write by destination note, including multiple attachments
    // with the same companion, so a stale snapshot cannot overwrite a summary.
    return this.withEntityLock(`companion-note:${String(rec.companionNoteId)}`,
      () => this.materializeCompanionSummaryLocked(attachmentId, String(rec.companionNoteId)))
  }

  private async materializeCompanionSummaryLocked(attachmentId: AttachmentIdT, expectedNoteId: string): Promise<boolean> {
    const rec = this.ctx.pkwAttachments.get(attachmentId)
    if (rec === undefined || rec.companionNoteId === undefined) return false
    if (String(rec.companionNoteId) !== expectedNoteId) return false // relation changed while queued; retry with its new lock
    const mapping = this.reqMappings().get(this.entityKey(ENTITY_ATTACHMENT, String(attachmentId)))
    if (mapping === undefined || mapping.knowledgeId === undefined) return false
    let description: string | undefined
    try {
      const k = await this.ctx.pkwWeKnora.getKnowledge(mapping.knowledgeId)
      if (k.summary_status !== 'completed' || !k.description) return false
      description = k.description
    } catch { return false } // offline → retry next drain

    const noteId = NoteId(String(rec.companionNoteId))
    const doc = await this.ctx.pkwNotes.getDocument(noteId).catch(() => undefined)
    if (doc === undefined) return false
    const current = extractAttachmentSummary(doc.markdown, String(attachmentId))
    if (current !== undefined && current.trim() === description.trim()) return false // no-op
    const next = insertAttachmentSummary(doc.markdown, String(attachmentId), description)
    try {
      await this.ctx.pkwNotes.update(noteId, next, {
        expectedRevision: doc.note.observedRevision,
        expectedContentHash: doc.note.contentHash,
      })
    } catch (error) {
      if (error instanceof NoteUpdateConflictError) return false // re-read current user content on the next sweep
      throw error
    }
    this.ctx.logger.info(`[pkw.knowledge] companion-summary attachment=${String(attachmentId)} note=${String(noteId)}`)
    return true
  }

  /** Best-effort sweep: materialize summaries for every attachment with a Companion Note. */
  async drainCompanionSummaries(): Promise<void> {
    for (const rec of this.ctx.pkwAttachments.list({})) {
      if (rec.companionNoteId === undefined) continue
      try { await this.materializeCompanionSummary(rec.id) } catch { /* retry next drain */ }
    }
  }

  // ── Note-scoped attachment processing pipeline ──────────────────────────────
  //
  // A note-scoped attachment (uploaded inside a Normal Note) is PARSED in a
  // dedicated internal Processing KB, its derived content (bounded summary +
  // top chunks) is captured, and the owner Note's remote projection is enriched
  // with it — WITHOUT creating a second Persistent Knowledge in the main KB.

  private parserConfigFingerprint(kb: Record<string, unknown>): string {
    const cc = kb.chunking_config as Record<string, unknown> | undefined
    const relevant = {
      parser_engine_rules: cc?.parser_engine_rules ?? null,
      chunk_size: cc?.chunk_size ?? null,
      chunk_separator: cc?.chunk_separator ?? null,
      vlm_config: kb.vlm_config ?? null,
      // CREATE-ONLY fields are part of the processing contract too (an empty
      // embedding_model_id leaves knowledge stuck in 'processing').
      embedding_model_id: kb.embedding_model_id ?? null,
      summary_model_id: kb.summary_model_id ?? null,
    }
    return sha256Text(JSON.stringify(relevant))
  }

  /** Fingerprint of CREATE-ONLY KB fields (cannot be fixed by updateKnowledgeBase). */
  private createOnlyFingerprint(kb: Record<string, unknown>): string {
    return sha256Text(JSON.stringify({
      embedding_model_id: kb.embedding_model_id ?? null,
      summary_model_id: kb.summary_model_id ?? null,
    }))
  }

  /** Ensure the internal Processing KB exists and mirrors the main KB parser config.
   *
   * MUTABLE config (chunking_config / vlm_config) is reconciled in-place via
   * updateKnowledgeBase. CREATE-ONLY config (embedding_model_id / summary_model_id)
   * cannot be fixed by update (WeKnora ignores them on PUT), so a drift there
   * triggers a CONTROLLED REBUILD: create a new KB → validate it → atomically
   * switch the mapping → retire the old KB (cleanup pending, never deleted first).
   */
  async ensureProcessingKb(): Promise<string | undefined> {
    try {
      const existing = this.reqProcessingKb().get(this.config.workspaceId)
      const mainKb = await this.ctx.pkwWeKnora.getKnowledgeBase(this.config.kbId)
      const fp = this.parserConfigFingerprint(mainKb)
      const name = `PKW Processing — ${this.config.workspaceId.slice(0, 8)}`
      const cc = (mainKb.chunking_config as Record<string, unknown> | undefined) ?? {}
      const vlm = mainKb.vlm_config
      const emb = typeof mainKb.embedding_model_id === 'string' ? mainKb.embedding_model_id : ''
      const sum = typeof mainKb.summary_model_id === 'string' ? mainKb.summary_model_id : ''

      const createNew = async (): Promise<string> => {
        const created = await this.ctx.pkwWeKnora.createKnowledgeBase(name, {
          is_temporary: true,
          chunking_config: cc,
          ...(vlm !== undefined ? { vlm_config: vlm } : {}),
          ...(emb !== '' ? { embedding_model_id: emb } : {}),
          ...(sum !== '' ? { summary_model_id: sum } : {}),
        })
        // Validate the CREATE-ONLY contract before committing to the new KB.
        const got = await this.ctx.pkwWeKnora.getKnowledgeBase(created.id)
        const gotEmb = typeof got.embedding_model_id === 'string' ? got.embedding_model_id : ''
        if (emb !== '' && gotEmb === '') {
          throw new Error(`pkwWeKnoraSync: new Processing KB missing embedding_model_id`)
        }
        return created.id
      }

      let kbId = existing?.processingKbId
      let retired = existing?.retiredKbIds ?? []
      let needCreate = false
      if (kbId === undefined) {
        needCreate = true
      } else {
        try {
          const existingKb = await this.ctx.pkwWeKnora.getKnowledgeBase(kbId)
          const drift = this.createOnlyFingerprint(existingKb) !== this.createOnlyFingerprint(mainKb)
          if (drift) {
            // CREATE-ONLY drift → controlled rebuild (update cannot fix it).
            this.ctx.logger.info(`[pkw.knowledge] processing-kb create-only drift → rebuild (old ${kbId})`)
            retired = [...retired, kbId]
            needCreate = true
            kbId = undefined
          } else if (existing !== undefined && existing.configFingerprint !== fp) {
            // MUTABLE-only drift → in-place update.
            await this.ctx.pkwWeKnora.updateKnowledgeBase(kbId, {
              name,
              chunking_config: cc,
              ...(vlm !== undefined ? { vlm_config: vlm } : {}),
              ...(emb !== '' ? { embedding_model_id: emb } : {}),
              ...(sum !== '' ? { summary_model_id: sum } : {}),
            })
          }
        } catch {
          // Existing KB vanished → recreate.
          needCreate = true
          kbId = undefined
        }
      }

      if (needCreate) {
        kbId = await createNew()
      }
      if (kbId === undefined) throw new Error('pkwWeKnoraSync: failed to resolve Processing KB id')

      await this.reqProcessingKb().put(this.config.workspaceId, {
        workspaceId: this.config.workspaceId,
        processingKbId: kbId,
        configFingerprint: fp,
        ...(retired.length > 0 ? { retiredKbIds: retired } : {}),
        updatedAt: this.now(),
      })
      return kbId
    } catch {
      return undefined // offline → retry next drain
    }
  }

  /** Capture the bounded derived content of a finished Processing Knowledge.
   *
   * Verified against WeKnora: `GET /chunks/:knowledge_id` returns the FULL
   * extracted text (not just the summary), so injecting chunks preserves
   * full-text search (e.g. a specific PDF sentence absent from the summary).
   * We capture the full chunk text (soft storage cap) — `enrichNoteForKnowledge`
   * applies the actual remote-projection budget later.
   */
  private async captureDerived(processingKnowledgeId: string, filename: string): Promise<{ summary?: string; chunks?: string[] }> {
    const k = await this.ctx.pkwWeKnora.getKnowledge(processingKnowledgeId)
    let chunks: string[] | undefined
    try {
      const list = await this.ctx.pkwWeKnora.listKnowledgeChunks(processingKnowledgeId)
      let total = 0
      const captured: string[] = []
      for (const c of list) {
        const content = c.content ?? ''
        if (content === '') continue
        if (total + content.length > 30000) { captured.push(content.slice(0, 30000 - total)); total = 30000; break }
        captured.push(content)
        total += content.length
      }
      chunks = captured
    } catch { chunks = undefined }
    return { summary: k.description, chunks }
  }

  /** Core note-scoped processing: upload (idempotent) → poll → capture → persist. */
  async runNoteScopedProcessing(attachmentId: AttachmentIdT): Promise<boolean> {
    const rec = this.ctx.pkwAttachments.get(attachmentId)
    if (rec === undefined || rec.knowledgeMode !== 'note-scoped') return false

    const key = String(attachmentId)
    const existing = this.reqProcessing().get(key)
    if (existing?.state === 'derived-ready') return true // already captured

    const kbId = await this.ensureProcessingKb()
    if (kbId === undefined) return false

    // Idempotent: reuse an existing Processing Knowledge instead of re-uploading.
    const cfgFp = this.reqProcessingKb().get(this.config.workspaceId)?.configFingerprint
    let processingKnowledgeId = existing?.processingKnowledgeId
    if (processingKnowledgeId === undefined) {
      const bytes = await this.ctx.pkwAttachments.open(attachmentId)
      let uploaded
      try {
        uploaded = await this.ctx.pkwWeKnora.uploadFile(kbId, { content: bytes, filename: rec.filename, mimeType: rec.mimeType, channel: 'pkw-processing' })
      } catch (error) {
        // 409 duplicate_file: the SAME bytes already exist in this Processing KB
        // (WeKnora dedups by file_hash). Adopt the existing KnowledgeId instead of
        // re-throwing — otherwise every drain re-uploads and 409s forever, which
        // is the "operations get slower over time" hot loop.
        if (error instanceof WeKnoraError && error.kind === 'conflict' && error.duplicate !== undefined) {
          uploaded = error.duplicate
        } else {
          throw error
        }
      }
      processingKnowledgeId = uploaded.id
      await this.reqProcessing().put(key, { attachmentId: key, workspaceId: this.config.workspaceId, processingKbId: kbId, processingKnowledgeId, state: 'parsing', configFingerprint: cfgFp, updatedAt: this.now() })
    }

    const k = await this.ctx.pkwWeKnora.getKnowledge(processingKnowledgeId)
    const parseStatus = k.parse_status ?? 'pending'
    const summaryStatus = k.summary_status ?? 'none'
    if (parseStatus === 'completed') {
      const derived = await this.captureDerived(processingKnowledgeId, rec.filename)
      const derivedHash = sha256Text(JSON.stringify(derived))
      if (derivedHash !== existing?.derivedHash) {
        await this.reqProcessing().put(key, { attachmentId: key, workspaceId: this.config.workspaceId, processingKbId: kbId, processingKnowledgeId, state: 'derived-ready', parseStatus, summaryStatus, summary: derived.summary, chunks: derived.chunks, derivedHash, configFingerprint: cfgFp, updatedAt: this.now() })
        await this.markOwnerNotesDirty(attachmentId)
      } else {
        await this.reqProcessing().put(key, { attachmentId: key, workspaceId: this.config.workspaceId, processingKbId: kbId, processingKnowledgeId, state: 'derived-ready', parseStatus, summaryStatus, summary: derived.summary, chunks: derived.chunks, derivedHash, configFingerprint: cfgFp, updatedAt: this.now() })
      }
      return true
    }
    if (parseStatus === 'failed') {
      await this.reqProcessing().put(key, { attachmentId: key, workspaceId: this.config.workspaceId, processingKbId: kbId, processingKnowledgeId, state: 'failed', parseStatus, summaryStatus, configFingerprint: cfgFp, lastError: k.error_message, updatedAt: this.now() })
      return false
    }
    // pending/processing → still parsing, retry next drain.
    await this.reqProcessing().put(key, { attachmentId: key, workspaceId: this.config.workspaceId, processingKbId: kbId, processingKnowledgeId, state: 'parsing', parseStatus, summaryStatus, configFingerprint: cfgFp, updatedAt: this.now() })
    return false
  }

  /** Mark every Note that references this attachment dirty, so runNoteSync re-projects it. */
  private async markOwnerNotesDirty(attachmentId: AttachmentIdT): Promise<void> {
    const id = String(attachmentId)
    for (const n of this.ctx.pkwNotes.list({})) {
      if (n.deletedAt !== undefined) continue
      const doc = await this.ctx.pkwNotes.getDocument(n.noteId).catch(() => undefined)
      if (doc === undefined) continue
      if (doc.attachments.some(a => String(a.attachmentId) === id)) {
        await this.markDirty(ENTITY_NOTE, String(n.noteId), n.observedRevision)
      }
    }
  }

  /** Sweep all note-scoped attachments through the processing pipeline. */
  async drainNoteScopedProcessing(): Promise<void> {
    for (const rec of this.ctx.pkwAttachments.list({})) {
      if (rec.knowledgeMode !== 'note-scoped') continue
      try { await this.runNoteScopedProcessing(rec.id) } catch { /* retry next drain */ }
    }
  }

  /** Derived content for a note-scoped attachment (for owner Note enrichment). */
  getDerivedContent(attachmentId: AttachmentIdT): { summary?: string; chunks?: string[] } | undefined {
    const rec = this.reqProcessing().get(String(attachmentId))
    if (rec === undefined || rec.state !== 'derived-ready') return undefined
    return { summary: rec.summary, chunks: rec.chunks }
  }

  /** User-facing processing state for an attachment (no remote identity exposed). */
  getAttachmentProcessingState(attachmentId: AttachmentIdT): 'waiting' | 'processing' | 'optimizing' | 'ready' | 'failed' {
    const rec = this.reqProcessing().get(String(attachmentId))
    if (rec !== undefined) {
      if (rec.state === 'derived-ready') return 'ready'
      if (rec.state === 'failed') return 'failed'
      // in-flight ('parsing') → map from the captured remote statuses.
      return weKnoraKnowledgePhase(rec.parseStatus, rec.summaryStatus)
    }
    // Standalone attachment (Sources): the processing state lives on the mapping's
    // remote parse/summary status, NOT the note-scoped processing table.
    const mapping = this.getAttachmentMapping(attachmentId)
    if (mapping !== undefined && mapping.knowledgeId !== undefined) {
      return weKnoraKnowledgePhase(mapping.remoteParseStatus, mapping.remoteSummaryStatus)
    }
    return 'waiting'
  }

  /** AttachmentIds whose captured config fingerprint differs from the current one (needs reparse). */
  listNeedsReparse(): string[] {
    const current = this.reqProcessingKb().get(this.config.workspaceId)?.configFingerprint
    if (current === undefined) return []
    const out: string[] = []
    for (const [attachmentId, rec] of this.reqProcessing().entries()) {
      if (rec.state === 'derived-ready' && rec.configFingerprint !== undefined && rec.configFingerprint !== current) out.push(attachmentId)
    }
    return out
  }

  /**
   * Reconcile standalone attachment processing: re-poll WeKnora for any
   * standalone attachment still in a non-terminal phase and patch the mapping.
   * This is what closes the "WeKnora=optimizing but PKW=waiting" gap — the
   * upload-time parse status is a snapshot, not a live status.
   */
  async reconcileNonTerminalAttachments(): Promise<number> {
    let updated = 0
    for (const [key, candidate] of this.reqMappings().entries()) {
      if (candidate.entityType !== ENTITY_ATTACHMENT) continue
      await this.withEntityLock(key, async () => {
        const mapping = this.reqMappings().get(key)
        if (mapping === undefined || mapping.syncState !== M_SYNCED) return
        const phase = weKnoraKnowledgePhase(mapping.remoteParseStatus, mapping.remoteSummaryStatus)
        if (phase === 'ready' || phase === 'failed') return
        try {
          const k = await this.ctx.pkwWeKnora.getKnowledge(mapping.knowledgeId)
          const nextParse = k.parse_status ?? mapping.remoteParseStatus
          const nextSummary = k.summary_status ?? mapping.remoteSummaryStatus
          if (nextParse !== mapping.remoteParseStatus || nextSummary !== mapping.remoteSummaryStatus) {
            await this.putMapping(key, { ...mapping, remoteParseStatus: nextParse, remoteSummaryStatus: nextSummary, updatedAt: this.now() })
            updated++
          }
        } catch { /* offline → retry next reconcile */ }
      })
    }
    return updated
  }

  /** Read the note-scoped attachment refs a Note's canonical Markdown references. */
  async noteScopedDerivedFor(noteId: NoteIdT): Promise<Array<{ attachmentId: string; filename: string; summary?: string; chunks?: string[] }>> {
    const doc = await this.ctx.pkwNotes.getDocument(noteId)
    const out: Array<{ attachmentId: string; filename: string; summary?: string; chunks?: string[] }> = []
    for (const ref of doc.attachments) {
      const att = this.ctx.pkwAttachments.get(ref.attachmentId)
      if (att === undefined || att.knowledgeMode !== 'note-scoped') continue
      const derived = this.getDerivedContent(att.id)
      if (derived === undefined) continue
      out.push({ attachmentId: String(att.id), filename: att.filename, summary: derived.summary, chunks: derived.chunks })
    }
    return out
  }

  /** Single source of truth: a Note's remote projection (normalized canonical + note-scoped derived content). */
  private async noteRemoteProjection(noteId: NoteIdT): Promise<{ markdown: string; fingerprint: string }> {
    const doc = await this.ctx.pkwNotes.getDocument(noteId)
    // Projection hygiene: strip PKW internal frontmatter (`id:`/`pkw:*`) before
    // it can enter WeKnora embedding/summary/Wiki/Graph. Canonical stays intact.
    let remoteMarkdown = normalizeForRemote(stripInternalFrontmatter(doc.markdown))
    const derived = await this.noteScopedDerivedFor(noteId)
    if (derived.length > 0) remoteMarkdown = enrichNoteForKnowledge(remoteMarkdown, derived)
    return { markdown: remoteMarkdown, fingerprint: remoteManualFingerprint(remoteMarkdown) }
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
    await Promise.all([...this.dirtyWrites.values()])

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

    let mapping = this.reqMappings().get(key)
    if (record.deletedAt !== undefined) {
      await this.runRemoteDelete(ENTITY_NOTE, String(noteId), key, mapping)
      return undefined
    }

    // Attachment-backed Companion Note: the Attachment Knowledge is the single
    // remote projection. Do NOT create an independent Note Knowledge. If an older
    // Companion Note already has a Note Knowledge mapping, converge it to deleted
    // (migration) so the duplicate remote card is removed without touching the
    // local Companion Note.
    if (record.attachmentBacked === true) {
      if (mapping !== undefined) await this.runRemoteDelete(ENTITY_NOTE, String(noteId), key, mapping)
      else await this.clearDirty(key)
      return undefined
    }

    mapping = await this.restoreMapping(key, mapping)

    const doc = await this.ctx.pkwNotes.getDocument(noteId)
    // Remote projection = normalized canonical text + note-scoped attachment
    // derived content (bounded). The canonical local Markdown is NEVER changed.
    const { markdown: remoteMarkdown, fingerprint } = await this.noteRemoteProjection(noteId)

    if (mapping !== undefined && mapping.remoteFingerprint === fingerprint && this.activeIntent(this.reqDirty().get(key)) === undefined) {
      // No-op when already synced; reactivate a stale/deleted mapping on restore.
      if (mapping.syncState !== M_SYNCED) {
        await this.putMapping(key, { ...mapping, syncState: M_SYNCED, updatedAt: this.now() })
      }
      await this.clearDirty(key)
      return mapping.knowledgeId
    }

    const pending = this.activeIntent(this.reqDirty().get(key))

    if (mapping === undefined) {
      return pending !== undefined
        ? this.resumeCreate(noteId, remoteMarkdown, fingerprint, pending)
        : this.createManual(noteId, remoteMarkdown, fingerprint, doc.note.title)
    }
    return pending !== undefined
      ? this.resumeUpdate(noteId, remoteMarkdown, fingerprint, mapping, pending)
      : this.updateManual(noteId, remoteMarkdown, fingerprint, mapping, doc.note.title)
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
      if ([...this.reqIntents().entries()].some(([, i]) => i.entityType === entityType && i.entityId === entityId
        && i.operationKind === 'delete' && i.knowledgeId === mapping.knowledgeId && i.state === S_COMPLETED)) {
        await this.clearDirty(key)
        return
      }
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

  /** Restore may race a completed remote delete; the old id is not proof of existence. */
  private async restoreMapping(key: string, mapping: MappingRecord | undefined): Promise<MappingRecord | undefined> {
    if (mapping?.syncState !== M_DELETED) return mapping
    const pending = this.activeIntent(this.reqDirty().get(key))
    if (pending?.operationKind === 'delete') {
      await this.recordIntent(pending, { state: S_SUPERSEDED })
    }
    try {
      await this.ctx.pkwWeKnora.getKnowledge(mapping.knowledgeId)
      return mapping
    } catch (error) {
      // Offline/auth failures do not prove existence OR absence. Keep dirty.
      if (!(error instanceof WeKnoraError && error.kind === 'not_found')) throw error
    }
    await this.reqReverse().delete(mapping.knowledgeId)
    await this.reqMappings().delete(key)
    return undefined
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
    const key = this.entityKey(intent.entityType, intent.entityId)
    await this.withDirtyWrite(key, async () => {
      const existing = this.reqDirty().get(key)
      await this.reqDirty().put(key, {
        workspaceId: this.config.workspaceId,
        entityType: intent.entityType,
        entityId: intent.entityId,
        dirty: true,
        pendingOperationId: intent.operationId,
        lastEventAt: existing?.lastEventAt ?? this.now(),
        lastEventRevision: existing?.lastEventRevision ?? 0,
      })
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
      const { fingerprint } = await this.noteRemoteProjection(NoteId(entityId))
      return fingerprint
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
      const { markdown: remoteMarkdown, fingerprint } = await this.noteRemoteProjection(noteId)
      const mapping = this.reqMappings().get(key)
      if (mapping !== undefined) {
        try {
          const remote = await this.ctx.pkwWeKnora.readManualContent(mapping.knowledgeId)
          if (remoteManualFingerprint(remote) === fingerprint) return mapping.knowledgeId
          return this.updateManual(noteId, remoteMarkdown, fingerprint, mapping, record.title)
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
    let mapping = this.reqMappings().get(key)

    // Non-indexable attachments stay local and are never projected to WeKnora.
    if (record.indexable === false) {
      await this.clearDirty(key)
      return undefined
    }

    // Knowledge Ownership: note-scoped attachments are PARSED in the internal
    // Processing KB (never become a Persistent main-KB Attachment Knowledge);
    // local-only attachments stay local.
    if (record.knowledgeMode === 'local-only') {
      if (mapping === undefined) await this.clearDirty(key)
      else await this.runRemoteDelete(ENTITY_ATTACHMENT, String(attachmentId), key, mapping) // legacy duplicate cleanup
      return undefined
    }
    if (record.knowledgeMode === 'note-scoped') {
      // Legacy duplicate cleanup: any old main-KB Attachment Knowledge converges to deleted.
      if (mapping !== undefined) await this.runRemoteDelete(ENTITY_ATTACHMENT, String(attachmentId), key, mapping)
      await this.runNoteScopedProcessing(attachmentId)
      await this.clearDirty(key)
      return undefined
    }

    if (record.deletedAt !== undefined) {
      await this.runRemoteDelete(ENTITY_ATTACHMENT, String(attachmentId), key, mapping)
      return undefined
    }

    mapping = await this.restoreMapping(key, mapping)

    const bytes = await this.ctx.pkwAttachments.open(attachmentId)
    const fingerprint = sha256Bytes(bytes)
    const fileHash = md5Bytes(bytes)

    // Replacement already in flight → resume it (poll parse status, switch).
    if (mapping !== undefined && mapping.replacementKnowledgeId !== undefined
      && (mapping.replacementState === 'uploaded' || mapping.replacementState === 'parsing')) {
      return this.resumeReplacement(key, mapping, fingerprint, fileHash)
    }

    // No-op when synced; reactivate a stale/deleted mapping on restore (same bytes).
    if (mapping !== undefined && mapping.remoteFingerprint === fingerprint && this.activeIntent(this.reqDirty().get(key)) === undefined) {
      if (mapping.syncState !== M_SYNCED) {
        await this.putMapping(key, { ...mapping, syncState: M_SYNCED, updatedAt: this.now() })
      }
      await this.clearDirty(key)
      return mapping.knowledgeId
    }

    const pending = this.activeIntent(this.reqDirty().get(key))

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
    await this.withDirtyWrite(key, async () => {
      const existing = this.reqDirty().get(key)
      await this.reqDirty().put(key, {
        workspaceId: this.config.workspaceId, entityType: ENTITY_ATTACHMENT, entityId: mapping.entityId,
        dirty: true, pendingOperationId: intent?.operationId ?? existing?.pendingOperationId,
        lastEventAt: existing?.lastEventAt ?? this.now(), lastEventRevision: existing?.lastEventRevision ?? 0,
      })
    })
    return undefined
  }

  // ── full reconcile ──────────────────────────────────────────────────────────

  /** Recover lost deletion hints without migrating or writing canonical content. */
  private async rearmDeleted(): Promise<void> {
    for (const rec of this.ctx.pkwNotes.list({ includeDeleted: true })) {
      if (rec.deletedAt !== undefined || rec.attachmentBacked === true) await this.rearmDeletion(ENTITY_NOTE, String(rec.noteId))
    }
    for (const rec of this.ctx.pkwAttachments.list({ includeDeleted: true })) {
      if (rec.deletedAt !== undefined) await this.rearmDeletion(ENTITY_ATTACHMENT, String(rec.id))
    }
  }

  private async rearmDeletion(entityType: string, entityId: string): Promise<boolean> {
    const key = this.entityKey(entityType, entityId)
    return this.withEntityLock(key, async () => {
      const note = entityType === ENTITY_NOTE ? this.ctx.pkwNotes.get(NoteId(entityId)) : undefined
      const record = entityType === ENTITY_NOTE ? note : this.ctx.pkwAttachments.get(AttachmentId(entityId))
      if (record === undefined || (record.deletedAt === undefined && note?.attachmentBacked !== true)) return false
      const mapping = this.reqMappings().get(key)
      if (mapping === undefined) return false
      await this.convergeDeleted(key, mapping)
      await this.markDirty(entityType, entityId)
      return mapping.syncState !== M_DELETED
    })
  }

  /** Reconcile local canonical entities → durable dirty/deleted state. Local-first. */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { markedDirty: 0, markedDeleted: 0 }

    // Notes: every current (and deleted) canonical entity.
    for (const rec of this.ctx.pkwNotes.list({ includeDeleted: true })) {
      const key = this.entityKey(ENTITY_NOTE, String(rec.noteId))
      const mapping = this.reqMappings().get(key)
      if (rec.deletedAt !== undefined) {
        if (await this.rearmDeletion(ENTITY_NOTE, String(rec.noteId))) report.markedDeleted += 1
        continue
      }
      if (rec.attachmentBacked === true) {
        // Attachment-backed: no independent Note Knowledge. Converge any legacy
        // Companion Note Knowledge to deleted; the drain performs the remote delete.
        if (await this.rearmDeletion(ENTITY_NOTE, String(rec.noteId))) report.markedDeleted += 1
        continue
      }
      const { fingerprint } = await this.noteRemoteProjection(rec.noteId)
      if (mapping === undefined || mapping.remoteFingerprint !== fingerprint || mapping.syncState !== M_SYNCED) {
        await this.markDirty(ENTITY_NOTE, String(rec.noteId), rec.observedRevision)
        report.markedDirty += 1
      }
    }

    // Migration: mark legacy Companion Notes (no user-authored content) as
    // attachment-backed so their duplicate Note Knowledge converges to deleted.
    for (const att of this.ctx.pkwAttachments.list()) {
      if (att.companionNoteId === undefined) continue
      const note = this.ctx.pkwNotes.get(att.companionNoteId)
      if (note === undefined || note.deletedAt !== undefined || note.attachmentBacked === true) continue
      const doc = await this.ctx.pkwNotes.getDocument(note.noteId)
      if (!hasCompanionUserContent(doc.markdown)) {
        await this.ctx.pkwNotes.setAttachmentBacked(note.noteId, true)
      }
    }

    // Attachments.
    for (const rec of this.ctx.pkwAttachments.list({ includeDeleted: true })) {
      const key = this.entityKey(ENTITY_ATTACHMENT, String(rec.id))
      const mapping = this.reqMappings().get(key)
      if (rec.deletedAt !== undefined) {
        if (await this.rearmDeletion(ENTITY_ATTACHMENT, String(rec.id))) report.markedDeleted += 1
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
    return (await this.searchWithTrace(query, opts)).results
  }

  /**
   * Retrieval with a dev-diagnostic trace (C4). Same pipeline as {@link search};
   * the trace lets "search found nothing" be localized to the exact layer.
   */
  async searchWithTrace(query: string, opts: { kbId?: string; limit?: number; knowledgeIds?: string[] } = {}): Promise<{ results: RetrievalResult[]; trace: RetrievalTrace }> {
    const kbId = opts.kbId ?? this.config.kbId
    const limit = opts.limit ?? 10
    const trace: RetrievalTrace = { query, mainRaw: 0, processingRaw: 0, afterBusiness: 0, afterCanonical: 0, afterRelevance: 0, final: 0 }

    const mainChunks: SearchResultChunk[] = await this.ctx.pkwWeKnora.hybridSearch(kbId, {
      query,
      limit,
      ...(opts.knowledgeIds !== undefined ? { knowledgeIds: opts.knowledgeIds } : {}),
    })
    trace.mainRaw = mainChunks.length

    // Immediate hide: a locally-deleted (or stale) projection must not surface in
    // PKW retrieval even while the async WeKnora delete is still converging.
    const main = mainChunks
      .filter(chunk => {
        const mapping = this.getMappingByKnowledgeId(chunk.knowledge_id)
        return mapping === undefined || (mapping.syncState !== M_DELETED && mapping.syncState !== M_STALE)
      })
      .map(chunk => this.toRetrievalResult(kbId, chunk))

    // A2 federation: also search the Processing KB and remap hits to Business
    // Knowledge (owner Notes), then merge into the Main results.
    const processing = await this.searchProcessingForBusiness(query, limit)
    if (processing.unavailable) trace.processingUnavailable = true
    trace.processingRaw = processing.raw

    // Retrieval Core (Foundation-lite): aggregate chunk-level EVIDENCE into one
    // BUSINESS result per Note / Attachment / Knowledge. A single PDF's N chunks
    // must never surface as N duplicate cards.
    const byBusiness = new Map<string, RetrievalResult>()
    for (const r of [...main, ...processing.results]) {
      const key = this.businessKey(r)
      const existing = byBusiness.get(key)
      if (existing === undefined) {
        r.evidence = [{ chunkId: r.remote.chunkId, content: r.remote.content, score: r.remote.score, filename: r.remote.filename, source: r.remote.kbId === kbId ? 'main' : 'processing' }]
        byBusiness.set(key, r)
        continue
      }
      // Merge evidence; keep the best-scoring chunk as the headline.
      existing.evidence!.push({ chunkId: r.remote.chunkId, content: r.remote.content, score: r.remote.score, filename: r.remote.filename, source: r.remote.kbId === kbId ? 'main' : 'processing' })
      if (r.remote.score > existing.remote.score) {
        existing.remote.score = r.remote.score
        existing.remote.content = r.remote.content
        existing.remote.chunkId = r.remote.chunkId
        existing.remote.kbId = r.remote.kbId
      }
      // Match-reason merge: body hit + attachment hit → 'both'.
      if (existing.local !== undefined && r.local !== undefined) {
        if (r.local.matchedAttachmentId !== undefined && existing.local.matchedAttachmentId === undefined) {
          existing.local.matchedAttachmentId = r.local.matchedAttachmentId
          existing.local.matchReason = existing.local.matchReason === undefined ? 'attachment' : 'both'
        } else if (existing.local.matchReason === 'attachment' && r.local.matchReason === undefined && r.local.entityType === ENTITY_NOTE) {
          existing.local.matchReason = 'both'
        }
      }
    }
    trace.afterBusiness = byBusiness.size

    // Active canonical filter (B7): a remote hit whose local entity was deleted
    // (or archived) must not surface while the async delete is converging. This
    // mirrors the RPC-boundary guard so the trace count is authoritative.
    const canonical: RetrievalResult[] = []
    for (const r of byBusiness.values()) {
      if (r.local === undefined) { canonical.push(r); continue }
      if (r.local.entityType === ENTITY_NOTE) {
        const n = this.ctx.pkwNotes.get(NoteId(r.local.entityId))
        if (n === undefined || n.deletedAt !== undefined) continue
      } else if (r.local.entityType === ENTITY_ATTACHMENT) {
        const a = this.ctx.pkwAttachments.get(AttachmentId(r.local.entityId))
        if (a === undefined || a.deletedAt !== undefined) continue
      }
      canonical.push(r)
    }
    trace.afterCanonical = canonical.length

    if (canonical.length === 0) {
      this.logRetrievalTrace(trace)
      return { results: [], trace }
    }

    // Relevance floor is RELATIVE-ONLY. WeKnora hybrid-search returns RRF-style
    // fused scores whose absolute magnitude is meaningless (a rank-1 hit scores
    // ≈0.016, not a 0..1 cosine), so an absolute floor like `0.1` filtered every
    // result out. A relative band of the top score keeps the ranking without
    // erasing it.
    canonical.sort((a, b) => b.remote.score - a.remote.score)
    const top = canonical[0]!.remote.score
    const floor = top * RELEVANCE_RELATIVE_FLOOR
    const filtered = canonical.filter(r => r.remote.score >= floor)
    trace.afterRelevance = filtered.length
    const results = filtered.slice(0, limit)
    trace.final = results.length
    this.logRetrievalTrace(trace)
    return { results, trace }
  }

  private logRetrievalTrace(trace: RetrievalTrace): void {
    this.ctx.logger.info(`[pkw.retrieval] q=${JSON.stringify(trace.query)} main=${trace.mainRaw} processing=${trace.processingRaw} business=${trace.afterBusiness} canonical=${trace.afterCanonical} relevance=${trace.afterRelevance} final=${trace.final}`)
  }

  /** Business-object identity for retrieval aggregation (Note > Attachment > Knowledge). */
  private businessKey(r: RetrievalResult): string {
    if (r.local === undefined) return `knowledge:${r.remote.knowledgeId}`
    if (r.local.entityType === ENTITY_NOTE) return `note:${r.local.entityId}`
    if (r.local.entityType === ENTITY_ATTACHMENT) {
      // A standalone attachment with a Companion Note surfaces as ONE Note object.
      if (r.local.companionNoteId !== undefined) return `note:${r.local.companionNoteId}`
      return `attachment:${r.local.entityId}`
    }
    return `knowledge:${r.remote.knowledgeId}`
  }

  /** A2: search the Processing KB and remap hits → owner Note (Business Knowledge). */
  private async searchProcessingForBusiness(query: string, limit: number): Promise<{ results: RetrievalResult[]; raw: number; unavailable?: boolean }> {
    const kbRec = this.reqProcessingKb().get(this.config.workspaceId)
    if (kbRec?.processingKbId === undefined) return { results: [], raw: 0 }
    let chunks: SearchResultChunk[]
    try {
      chunks = await this.ctx.pkwWeKnora.hybridSearch(kbRec.processingKbId, { query, limit })
    } catch { return { results: [], raw: 0, unavailable: true } }

    const out: RetrievalResult[] = []
    for (const chunk of chunks) {
      // The processing table is keyed by attachmentId; resolve by processingKnowledgeId.
      const rec = this.findProcessingByKnowledgeId(chunk.knowledge_id)
      if (rec === undefined) continue
      const attachmentId = rec.attachmentId
      const owners = await this.referencingNotes(attachmentId)
      if (owners.length === 0) continue // isolated attachment: not a Business Knowledge
      for (const noteId of owners) {
        out.push({
          remote: {
            kbId: kbRec.processingKbId,
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
          local: { workspaceId: this.config.workspaceId, entityType: ENTITY_NOTE, entityId: noteId, matchedAttachmentId: attachmentId, matchReason: 'attachment' },
        })
      }
    }
    return { results: out, raw: chunks.length }
  }

  private findProcessingByKnowledgeId(knowledgeId: string): ProcessingRecord | undefined {
    for (const [, rec] of this.reqProcessing().entries()) {
      if (rec.processingKnowledgeId === knowledgeId) return rec
    }
    return undefined
  }

  /** NoteIds whose canonical Markdown references the given attachment (durable managed refs). */
  private async referencingNotes(attachmentId: string): Promise<string[]> {
    const out: string[] = []
    for (const n of this.ctx.pkwNotes.list({})) {
      if (n.deletedAt !== undefined) continue
      const doc = await this.ctx.pkwNotes.getDocument(n.noteId).catch(() => undefined)
      if (doc !== undefined && doc.attachments.some(a => String(a.attachmentId) === attachmentId)) out.push(String(n.noteId))
    }
    return out
  }

  private toRetrievalResult(kbId: string, chunk: SearchResultChunk): RetrievalResult {
    const rev = this.reqReverse().get(chunk.knowledge_id)
    let local: RetrievalResult['local']
    if (rev !== undefined) {
      local = { workspaceId: rev.workspaceId, entityType: rev.entityType, entityId: rev.entityId }
      // Attachment hit → prefer the Companion Note so one uploaded file surfaces
      // as a single knowledge object (attachment-backed policy).
      if (rev.entityType === ENTITY_ATTACHMENT) {
        const att = this.ctx.pkwAttachments.get(AttachmentId(rev.entityId))
        if (att !== undefined && att.companionNoteId !== undefined) local.companionNoteId = String(att.companionNoteId)
      }
    }
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
      ...(local === undefined ? {} : { local }),
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { pkwWeKnoraSync: WeKnoraSyncService }
}

export default WeKnoraSyncService

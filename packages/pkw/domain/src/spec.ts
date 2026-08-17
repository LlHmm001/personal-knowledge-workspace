/**
 * The `pkw` domain declaration: record schema and the `defineDomain` spec the
 * event store opens. Record schemas are zod (the durable-boundary validator);
 * branding has no runtime representation, so ids are string-transformed.
 * @module @deepseek-ai/dsh-pkw-domain/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AttachmentId, CorrelationId, EventId, NoteId, OperationId } from './types.ts'

const eventId = z.string().transform(value => value as EventId)
const operationId = z.string().transform(value => value as OperationId)
const correlationId = z.string().transform(value => value as CorrelationId)
const workspaceId = z.string().transform(value => value as WorkspaceId)

const actorSchema = z.object({
  type: z.enum(['user', 'agent', 'system', 'sync']),
  id: z.string().optional(),
})

const domainEventSchema = z.object({
  eventId,
  type: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  aggregateRevision: z.number().int().nonnegative(),
  createdAt: z.string(),
  payload: z.unknown(),
})

/** Durable shape of one operation commit: 1..N events under one idempotency key. */
export const operationCommitRecord = z.object({
  operationId,
  workspaceId,
  actor: actorSchema,
  correlationId,
  causationId: z.string().optional(),
  committedAt: z.string(),
  events: z.array(domainEventSchema).min(1),
})

/** One stored commit record, inferred from {@link operationCommitRecord}. */
export type OperationCommitRecord = z.infer<typeof operationCommitRecord>

/**
 * The `pkw` domain spec: one `commits` table keyed by {@link OperationId}.
 * Phase 1 declares only what it uses; later phases bump `version` when adding
 * tables (notes_index, tasks, facts, relations, outbox, sync_records, …).
 */
export const pkwDomainSpec = defineDomain({
  name: 'pkw',
  version: 1,
  tables: {
    commits: domainTable<OperationId, OperationCommitRecord>(operationCommitRecord),
  },
})

// ── Phase 2: notes / attachments projection domains ─────────────────────────

const noteId = z.string().transform(value => value as NoteId)
const attachmentId = z.string().transform(value => value as AttachmentId)

const noteIndexRecordSchema = z.object({
  noteId,
  workspaceId,
  relativePath: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  contentHash: z.string(),
  observedRevision: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().optional(),
})

const attachmentRecordSchema = z.object({
  id: attachmentId,
  workspaceId,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  relativePath: z.string(),
  observedRevision: z.number().int().nonnegative(),
  indexedAt: z.string(),
  createdAt: z.string(),
  deletedAt: z.string().optional(),
})

const orderChildSchema = z.object({
  kind: z.enum(['note', 'folder']),
  id: z.string(),
})

const noteOrderSchema = z.object({
  workspaceId,
  parentPath: z.string(),
  children: z.array(orderChildSchema),
})

/** Notes projection domain: identity index + path→identity reverse index + manual order projection. */
export const noteDomainSpec = defineDomain({
  name: 'pkw_notes',
  version: 2,
  migrations: {
    // v1 → v2: keep note_index + note_paths verbatim; add the (empty) note_order
    // manual-ordering projection. No records are transformed.
    1: {
      upgrade: (previous) => ({ tables: { ...previous.tables, note_order: {} } }),
    },
  },
  tables: {
    note_index: domainTable<NoteId, z.infer<typeof noteIndexRecordSchema>>(noteIndexRecordSchema),
    note_paths: domainTable<string, NoteId>(noteId),
    note_order: domainTable<string, z.infer<typeof noteOrderSchema>>(noteOrderSchema),
  },
})

/** Attachments catalog domain. */
export const attachmentDomainSpec = defineDomain({
  name: 'pkw_attachments',
  version: 1,
  tables: {
    attachments: domainTable<AttachmentId, z.infer<typeof attachmentRecordSchema>>(attachmentRecordSchema),
  },
})

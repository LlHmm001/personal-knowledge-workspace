/**
 * The `pkw` domain declaration: record schema and the `defineDomain` spec the
 * event store opens. Record schemas are zod (the durable-boundary validator);
 * branding has no runtime representation, so ids are string-transformed.
 * @module @deepseek-ai/dsh-pkw-domain/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AttachmentId, CorrelationId, EventId, FolderTrashEntryId, NoteId, OperationId } from './types.ts'

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
  canonicalMissing: z.boolean().optional(),
  attachmentBacked: z.boolean().optional(),
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

/** A trashed folder with a stable identity independent of its original path. */
const folderTrashEntrySchema = z.object({
  trashEntryId: z.string().transform(value => value as FolderTrashEntryId),
  workspaceId,
  originalPath: z.string(),
  archivedPath: z.string(),
  deletedAt: z.string(),
})

/** Notes projection domain: identity index + path→identity reverse index + manual order projection + folder trash entries. */
export const noteDomainSpec = defineDomain({
  name: 'pkw_notes',
  // No migrations (harness pre-release stance: a medium stamped with a
  // different version rejects at open; changing a schema migrates by hand).
  version: 3,
  tables: {
    note_index: domainTable<NoteId, z.infer<typeof noteIndexRecordSchema>>(noteIndexRecordSchema),
    note_paths: domainTable<string, NoteId>(noteId),
    note_order: domainTable<string, z.infer<typeof noteOrderSchema>>(noteOrderSchema),
    folder_trash: domainTable<string, z.infer<typeof folderTrashEntrySchema>>(folderTrashEntrySchema),
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

// ── Phase C: tasks + matrices ───────────────────────────────────────────────

const taskMatrixId = z.string().transform(value => value as import('./types.ts').TaskMatrixId)
const taskId = z.string().transform(value => value as import('./types.ts').TaskId)

const taskMatrixSchema = z.object({
  matrixId: taskMatrixId,
  workspaceId,
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  manualOrder: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
})

const taskSourceRefSchema = z.object({
  kind: z.enum(['note', 'selection']),
  noteId: z.string(),
  exact: z.string().optional(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  noteRevision: z.number().int().nonnegative().optional(),
  contentHash: z.string().optional(),
})

const taskSchema = z.object({
  taskId,
  workspaceId,
  matrixId: taskMatrixId.nullable(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['open', 'completed', 'cancelled']),
  important: z.boolean(),
  urgent: z.boolean(),
  priority: z.number().int().nonnegative().optional(),
  dueAt: z.string().optional(),
  scheduledAt: z.string().optional(),
  tags: z.array(z.string()),
  parentTaskId: taskId.nullable(),
  sourceRefs: z.array(taskSourceRefSchema),
  manualOrder: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  deletedAt: z.string().optional(),
})

/** Tasks domain: matrices (multiple Eisenhower scopes) + current-state Task Store. */
export const taskDomainSpec = defineDomain({
  name: 'pkw_tasks',
  version: 1,
  tables: {
    matrices: domainTable<import('./types.ts').TaskMatrixId, z.infer<typeof taskMatrixSchema>>(taskMatrixSchema),
    tasks: domainTable<import('./types.ts').TaskId, z.infer<typeof taskSchema>>(taskSchema),
  },
})

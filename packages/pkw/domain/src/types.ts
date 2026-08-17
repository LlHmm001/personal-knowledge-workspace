/**
 * PKW domain type vocabulary. Types only — branding has no runtime representation;
 * factories return the input string cast at compile time (see packages/workspace
 * of the harness for the established pattern).
 * @module @deepseek-ai/dsh-pkw-domain/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

// ── stable identifiers (id ≠ path) ──────────────────────────────────────────

export type NoteId = Branded<'NoteId'>
export type AttachmentId = Branded<'AttachmentId'>
export type EventId = Branded<'EventId'>
export type OperationId = Branded<'OperationId'>
export type CorrelationId = Branded<'CorrelationId'>
export type TaskId = Branded<'TaskId'>
export type TaskMatrixId = Branded<'TaskMatrixId'>
export type FolderTrashEntryId = Branded<'FolderTrashEntryId'>

export function NoteId(id: string): NoteId { return id as NoteId }
export function AttachmentId(id: string): AttachmentId { return id as AttachmentId }
export function EventId(id: string): EventId { return id as EventId }
export function OperationId(id: string): OperationId { return id as OperationId }
export function CorrelationId(id: string): CorrelationId { return id as CorrelationId }
export function TaskId(id: string): TaskId { return id as TaskId }
export function TaskMatrixId(id: string): TaskMatrixId { return id as TaskMatrixId }
export function FolderTrashEntryId(id: string): FolderTrashEntryId { return id as FolderTrashEntryId }

// ── operation context ────────────────────────────────────────────────────────

export type ActorType = 'user' | 'agent' | 'system' | 'sync'

export interface Actor {
  type: ActorType
  id?: string
}

/** Normalized after {@link newOperationContext}; operationId/correlationId always present. */
export interface OperationContext {
  workspaceId: WorkspaceId
  actor: Actor
  operationId: OperationId
  correlationId: CorrelationId
  causationId?: string
}

// ── durable event / commit envelope ──────────────────────────────────────────

export interface DomainEvent {
  eventId: EventId
  type: string
  aggregateType: string
  aggregateId: string
  aggregateRevision: number
  createdAt: string
  payload: unknown
}

export interface OperationCommit {
  operationId: OperationId
  workspaceId: WorkspaceId
  actor: Actor
  correlationId: CorrelationId
  causationId?: string
  committedAt: string
  events: DomainEvent[]
}

/** Flattened event timeline view: envelope fields denormalized onto one event. */
export interface DomainEventView extends DomainEvent {
  operationId: OperationId
  workspaceId: WorkspaceId
  actor: Actor
  correlationId: CorrelationId
  causationId?: string
}

// ── context compiler reservation (model-visible ⟺ logged) ───────────────────

export interface ContextSourceRef {
  kind: 'note' | 'task' | 'fact' | 'knowledge' | 'event' | 'local-search'
  ref: string
  revision?: number
  excerptHash?: string
}

export interface ContextSnapshot {
  id: string
  correlationId: string
  compiledAt: string
  sources: ContextSourceRef[]
  maxTokens: number
}

// ── outbox / sync extension seam (reserved, not implemented in Phase 1) ─────

export interface OutboxRecord {
  operationId: OperationId
  workspaceId: WorkspaceId
  target: 'note' | 'attachment' | 'fact'
  aggregateId: string
  aggregateRevision: number
  status: 'pending' | 'running' | 'success' | 'retry' | 'failed'
  attempts: number
  nextRetryAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface PkwEventCommitted {
  operationId: OperationId
  correlationId: CorrelationId
  workspaceId: WorkspaceId
  events: Array<{
    eventId: EventId
    type: string
    aggregateType: string
    aggregateId: string
    aggregateRevision: number
  }>
}

export interface OutboxSink {
  onCommitted(signal: PkwEventCommitted): void
}

// ── note / attachment core types (validation only in Phase 1) ───────────────

export interface Note {
  id: NoteId
  workspaceId: WorkspaceId
  path: string
  title: string
  revision: number
  contentHash: string
  createdAt: string
  updatedAt: string
}

export interface Attachment {
  id: AttachmentId
  workspaceId: WorkspaceId
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  localPath: string
  createdAt: string
}

// ── event store contract ─────────────────────────────────────────────────────

export interface DomainEventInput {
  type: string
  aggregateType: string
  aggregateId: string
  payload: unknown
}

export interface CommitRequest {
  operationContext: OperationContext
  events: DomainEventInput[]
}

export interface EventListFilter {
  workspaceId?: WorkspaceId
  aggregateType?: string
  aggregateId?: string
}

export interface PkwEventStore {
  commit(req: CommitRequest): Promise<OperationCommit>
  get(operationId: OperationId): OperationCommit | undefined
  list(filter?: EventListFilter): DomainEventView[]
}

// ── Phase 2: Notes / Attachments projection + service contracts ─────────────

/** NoteIndex projection record (Markdown is the content source of truth). */
export interface NoteIndexRecord {
  noteId: NoteId
  workspaceId: WorkspaceId
  relativePath: string
  title: string
  tags: string[]
  contentHash: string
  observedRevision: number
  fileSize: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** Attachment catalog record (workspace file is the binary source of truth). */
export interface AttachmentRecord {
  id: AttachmentId
  workspaceId: WorkspaceId
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  relativePath: string
  observedRevision: number
  indexedAt: string
  createdAt: string
  deletedAt?: string
  /** When false, the attachment stays local and is never projected to WeKnora. */
  indexable?: boolean
}

export interface AttachmentRef {
  attachmentId: AttachmentId
  relativePath: string
}

export interface NoteDocument {
  note: NoteIndexRecord
  markdown: string
  attachments: AttachmentRef[]
}

export interface NoteIdentityConflict {
  noteId: NoteId
  paths: string[]
}

export interface NoteListFilter {
  includeDeleted?: boolean
  tag?: string
}

export interface CreateNoteInput {
  relativePath: string
  markdown: string
}

export interface ReconcileReport {
  decisions: Array<{
    changeKind: string
    noteId?: NoteId
    attachmentId?: AttachmentId
    operationId: OperationId
  }>
  repairedProjections: number
}

export interface NoteOrderChild {
  kind: 'note' | 'folder'
  id: string
}

/** A trashed folder: stable identity decoupled from its original path. */
export interface FolderTrashEntry {
  trashEntryId: FolderTrashEntryId
  workspaceId: WorkspaceId
  originalPath: string
  archivedPath: string
  deletedAt: string
}

export interface PkwNotesService {
  list(filter?: NoteListFilter): NoteIndexRecord[]
  get(noteId: NoteId): NoteIndexRecord | undefined
  getDocument(noteId: NoteId): Promise<NoteDocument>
  resolveByPath(relativePath: string): NoteIndexRecord | undefined
  findNoteById(noteIdStr: string): Promise<string | undefined>
  listMissingNotes(): Promise<Array<{ noteId: string; relativePath: string }>>
  create(input: CreateNoteInput): Promise<NoteIndexRecord>
  update(noteId: NoteId, markdown: string): Promise<NoteIndexRecord>
  move(noteId: NoteId, newRelativePath: string): Promise<NoteIndexRecord>
  delete(noteId: NoteId): Promise<void>
  restore(noteId: NoteId): Promise<NoteIndexRecord>
  purge(noteId: NoteId): Promise<void>
  reconcile(): Promise<ReconcileReport>
  getIdentityConflict(noteId: NoteId): NoteIdentityConflict | undefined
  listIdentityConflicts(): NoteIdentityConflict[]
  listFolders(): Promise<string[]>
  listTrashFolders(): Promise<FolderTrashEntry[]>
  createFolder(relativePath: string): Promise<void>
  renameFolder(oldPath: string, newPath: string): Promise<void>
  deleteFolder(relativePath: string): Promise<void>
  trashFolder(relativePath: string): Promise<FolderTrashEntry>
  restoreFolder(trashEntryId: FolderTrashEntryId): Promise<void>
  purgeFolder(trashEntryId: FolderTrashEntryId): Promise<void>
  getOrder(parentPath: string): NoteOrderChild[]
  setOrder(parentPath: string, children: NoteOrderChild[]): Promise<void>
}

export interface ImportAttachmentInput {
  content: Uint8Array
  filename: string
  mimeType: string
  /** Default true; false keeps the attachment local (no WeKnora projection). */
  indexable?: boolean
}

export interface AttachmentListFilter {
  includeDeleted?: boolean
}

export interface PkwAttachmentsService {
  list(filter?: AttachmentListFilter): AttachmentRecord[]
  get(attachmentId: AttachmentId): AttachmentRecord | undefined
  resolve(relativePath: string): AttachmentRecord | undefined
  importFile(input: ImportAttachmentInput): Promise<AttachmentRecord>
  open(attachmentId: AttachmentId): Promise<Uint8Array>
  remove(attachmentId: AttachmentId): Promise<void>
  restore(attachmentId: AttachmentId): Promise<AttachmentRecord>
  purge(attachmentId: AttachmentId): Promise<void>
  reconcile(): Promise<ReconcileReport>
}

export interface FileWatchEvent {
  path: string
  kind: 'add' | 'change' | 'unlink'
}

/** File-watch abstraction; the chokidar provider is a separate package. */
export interface FileWatch {
  watch(paths: string[], handler: (event: FileWatchEvent) => void): () => void
}

/** Note change kinds (event `type` and reconcile decision keys). */
export const NOTE_CREATED = 'note.created'
export const NOTE_DISCOVERED = 'note.discovered'
export const NOTE_UPDATED = 'note.updated'
export const NOTE_MOVED = 'note.moved'
export const NOTE_DELETED = 'note.deleted'
export const NOTE_RESTORED = 'note.restored'
export const NOTE_PURGED = 'note.purged'
export const NOTE_IDENTITY_CONFLICT = 'note.identity_conflict.detected'
export const ATTACHMENT_IMPORTED = 'attachment.imported'
export const ATTACHMENT_UPDATED = 'attachment.updated'
export const ATTACHMENT_DELETED = 'attachment.deleted'
export const ATTACHMENT_RESTORED = 'attachment.restored'

// ── Phase C: tasks + matrices ───────────────────────────────────────────────

export type TaskStatus = 'open' | 'completed' | 'cancelled'

export interface TaskMatrix {
  matrixId: TaskMatrixId
  workspaceId: WorkspaceId
  name: string
  description?: string
  icon?: string
  color?: string
  manualOrder: number
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

export interface TaskSourceRef {
  kind: 'note' | 'selection'
  noteId: string
  exact?: string
  prefix?: string
  suffix?: string
  /** Offset hints into the note body at capture time (never a source of truth). */
  start?: number
  end?: number
  noteRevision?: number
  contentHash?: string
}

export interface Task {
  taskId: TaskId
  workspaceId: WorkspaceId
  matrixId: TaskMatrixId | null
  title: string
  description?: string
  status: TaskStatus
  important: boolean
  urgent: boolean
  priority?: number
  dueAt?: string
  scheduledAt?: string
  tags: string[]
  parentTaskId: TaskId | null
  sourceRefs: TaskSourceRef[]
  manualOrder: number
  createdAt: string
  updatedAt: string
  completedAt?: string
  deletedAt?: string
}

export interface CreateTaskInput {
  title: string
  matrixId?: TaskMatrixId | null
  description?: string
  important?: boolean
  urgent?: boolean
  priority?: number
  dueAt?: string
  scheduledAt?: string
  tags?: string[]
  parentTaskId?: TaskId | null
  sourceRefs?: TaskSourceRef[]
}

export interface PkwTasksService {
  listMatrices(filter?: { includeArchived?: boolean }): TaskMatrix[]
  createMatrix(input: { name: string; description?: string; icon?: string; color?: string }): Promise<TaskMatrix>
  renameMatrix(matrixId: TaskMatrixId, name: string): Promise<TaskMatrix>
  archiveMatrix(matrixId: TaskMatrixId): Promise<void>
  reassignMatrixTasks(fromMatrixId: TaskMatrixId, toMatrixId: TaskMatrixId | null): Promise<{ moved: number }>
  removeMatrix(matrixId: TaskMatrixId, opts?: { reassignTo?: TaskMatrixId | null }): Promise<{ removed: boolean; moved: number }>
  removeMatrixWithTasks(matrixId: TaskMatrixId): Promise<{ removed: boolean; deleted: number }>
  listTasks(filter?: { matrixId?: TaskMatrixId | null; status?: TaskStatus; includeDeleted?: boolean }): Task[]
  listSubtasks(parentTaskId: TaskId): Task[]
  createTask(input: CreateTaskInput): Promise<Task>
  updateTask(taskId: TaskId, patch: Partial<Omit<Task, 'taskId' | 'workspaceId' | 'createdAt'>>): Promise<Task>
  completeTask(taskId: TaskId): Promise<Task>
  reopenTask(taskId: TaskId): Promise<Task>
  moveTaskToMatrix(taskId: TaskId, matrixId: TaskMatrixId | null): Promise<Task>
  reorderTasks(orderedTaskIds: TaskId[]): Promise<void>
  deleteTask(taskId: TaskId): Promise<void>
  restoreTask(taskId: TaskId): Promise<Task>
}

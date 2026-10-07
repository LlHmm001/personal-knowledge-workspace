/**
 * PKW Tasks core (`ctx.pkwTasks`): multiple Eisenhower matrices + a current-state
 * Task Store over `ctx.storage`, with durable event history via `ctx.pkwEvents`.
 *
 * Quadrant is DERIVED from `important × urgent` inside a TaskMatrix (never stored);
 * a Task belongs to ONE primary matrix (nullable = Inbox/unassigned).
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID, createHash } from 'node:crypto'
import {
  TaskId,
  TaskMatrixId,
  taskDomainSpec,
  type CreateTaskInput,
  type PkwTasksService,
  type Task,
  type TaskMatrix,
  type TaskStatus,
} from '@deepseek-ai/dsh-pkw-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/cordis' {
  interface Context { pkwTasks: PkwTasksService }
}

export interface Config { workspaceId: string }

export const taskContentHash = (task: Task): string => createHash('sha256').update(JSON.stringify(task)).digest('hex')
export class TaskUpdateConflictError extends Error {
  readonly code = 'PKW_TASK_CONFLICT'
  constructor() { super('任务已被其他人修改。请保留当前输入，重新读取任务后再保存。') }
}

const TASK_AGG = 'task'
const MATRIX_AGG = 'taskMatrix'

export class TasksService extends Service {
  static inject = ['storageDomain', 'pkwEvents']
  static Config: z<Config> = z.object({ workspaceId: z.string() })

  private matrices?: KvTable<TaskMatrixId, TaskMatrix>
  private tasks?: KvTable<TaskId, Task>
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwTasks')
  }

  protected async [Service.init](): Promise<void> {
    const domain: Domain<typeof taskDomainSpec> = await this.ctx.storageDomain.open(taskDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'pkw.tasksDomainClose')
    this.matrices = domain.table('matrices')
    this.tasks = domain.table('tasks')
  }

  private reqMatrices(): KvTable<TaskMatrixId, TaskMatrix> {
    if (this.matrices === undefined) throw new Error('pkwTasks is not started yet')
    return this.matrices
  }

  private reqTasks(): KvTable<TaskId, Task> {
    if (this.tasks === undefined) throw new Error('pkwTasks is not started yet')
    return this.tasks
  }

  private now(): string { return new Date().toISOString() }

  /** Keep reference validation and writes in one service-instance queue. */
  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.mutationTail.then(operation)
    this.mutationTail = running.then(() => undefined, () => undefined)
    return running
  }

  private assertMatrix(matrixId: TaskMatrixId | null): void {
    if (matrixId !== null && this.reqMatrices().get(matrixId) === undefined) {
      throw new Error(`pkwTasks: unknown matrix '${matrixId}'`)
    }
  }

  private assertParent(parentTaskId: TaskId | null): void {
    if (parentTaskId === null) return
    const parent = this.reqTasks().get(parentTaskId)
    if (parent === undefined || parent.deletedAt !== undefined) {
      throw new Error(`pkwTasks: parent task '${parentTaskId}' is missing or trashed`)
    }
  }

  private activeTask(taskId: TaskId): Task {
    const task = this.reqTasks().get(taskId)
    if (task === undefined) throw new Error(`pkwTasks: unknown task '${taskId}'`)
    if (task.deletedAt !== undefined) throw new Error(`pkwTasks: task '${taskId}' is trashed; restore it before editing`)
    return task
  }

  private normalizeDate(value: string | undefined, field: 'dueAt' | 'scheduledAt'): string | undefined {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`pkwTasks: ${field} must be a string; use an empty string to clear it`)
    }
    return value === '' ? undefined : value
  }

  private async promoteSurvivingChildren(deletingIds: Set<TaskId>): Promise<void> {
    for (const [id, child] of this.reqTasks().entries()) {
      if (child.deletedAt !== undefined || deletingIds.has(id) || child.parentTaskId === null || !deletingIds.has(child.parentTaskId)) continue
      await this.reqTasks().put(id, { ...child, parentTaskId: null, updatedAt: this.now() })
      await this.emit('task.updated', TASK_AGG, String(id), { taskId: String(id), parentTaskId: null, reason: 'parent_deleted' })
    }
  }

  /** A removed matrix cannot remain referenced even by tasks currently in trash. */
  private async detachTrashedMatrixTasks(matrixId: TaskMatrixId): Promise<void> {
    for (const [id, task] of this.reqTasks().entries()) {
      if (task.matrixId !== matrixId || task.deletedAt === undefined) continue
      await this.reqTasks().put(id, { ...task, matrixId: null, updatedAt: this.now() })
      await this.emit('task.matrix_changed', TASK_AGG, String(id), { taskId: String(id), fromMatrixId: String(matrixId), toMatrixId: null, reason: 'matrix_deleted' })
    }
  }

  private async emit(type: string, aggregateType: string, aggregateId: string, payload: unknown): Promise<void> {
    await this.ctx.pkwEvents.commit({
      operationContext: {
        workspaceId: WorkspaceId(this.config.workspaceId),
        actor: { type: 'user' },
        operationId: `${type}:${aggregateId}:${randomUUID()}` as never,
        correlationId: randomUUID() as never,
      },
      events: [{ type, aggregateType, aggregateId, payload }],
    })
  }

  // ── matrices ──────────────────────────────────────────────────────────────

  listMatrices(filter: { includeArchived?: boolean } = {}): TaskMatrix[] {
    const out: TaskMatrix[] = []
    for (const [, m] of this.reqMatrices().entries()) {
      if (filter.includeArchived !== true && m.archivedAt !== undefined) continue
      out.push(m)
    }
    return out.sort((a, b) => a.manualOrder - b.manualOrder)
  }

  async createMatrix(input: { name: string; description?: string; icon?: string; color?: string }): Promise<TaskMatrix> {
    return this.withMutation(() => this.createMatrixLocked(input))
  }

  private async createMatrixLocked(input: { name: string; description?: string; icon?: string; color?: string }): Promise<TaskMatrix> {
    const now = this.now()
    const matrix: TaskMatrix = taskDomainSpec.tables.matrices.valueSchema.parse({
      matrixId: TaskMatrixId(`matrix_${randomUUID().replaceAll('-', '').slice(0, 12)}`),
      workspaceId: WorkspaceId(this.config.workspaceId),
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      manualOrder: this.listMatrices({ includeArchived: true }).length,
      createdAt: now,
      updatedAt: now,
    })
    await this.reqMatrices().put(matrix.matrixId, matrix)
    await this.emit('task.matrix_created', MATRIX_AGG, String(matrix.matrixId), { matrixId: String(matrix.matrixId), name: matrix.name })
    return matrix
  }

  async renameMatrix(matrixId: TaskMatrixId, name: string): Promise<TaskMatrix> {
    return this.withMutation(() => this.renameMatrixLocked(matrixId, name))
  }

  private async renameMatrixLocked(matrixId: TaskMatrixId, name: string): Promise<TaskMatrix> {
    const m = this.reqMatrices().get(matrixId)
    if (m === undefined) throw new Error(`pkwTasks: unknown matrix '${matrixId}'`)
    const next = taskDomainSpec.tables.matrices.valueSchema.parse({ ...m, name, updatedAt: this.now() })
    await this.reqMatrices().put(matrixId, next)
    await this.emit('task.matrix_updated', MATRIX_AGG, String(matrixId), { matrixId: String(matrixId), name })
    return next
  }

  async archiveMatrix(matrixId: TaskMatrixId): Promise<void> {
    return this.withMutation(() => this.archiveMatrixLocked(matrixId))
  }

  private async archiveMatrixLocked(matrixId: TaskMatrixId): Promise<void> {
    const m = this.reqMatrices().get(matrixId)
    if (m === undefined) return
    await this.reqMatrices().put(matrixId, { ...m, archivedAt: this.now(), updatedAt: this.now() })
    await this.emit('task.matrix_archived', MATRIX_AGG, String(matrixId), { matrixId: String(matrixId) })
  }

  /**
   * Bulk-move every (non-deleted) task of a matrix to another matrix (or the
   * Inbox when `toMatrixId` is null). TaskId/sourceRefs/important/urgent are
   * preserved; one `task.matrix_changed` event per task keeps the audit trail
   * granular. No orphan matrixId is ever left behind on the moved tasks.
   */
  async reassignMatrixTasks(fromMatrixId: TaskMatrixId, toMatrixId: TaskMatrixId | null): Promise<{ moved: number }> {
    return this.withMutation(() => this.reassignMatrixTasksLocked(fromMatrixId, toMatrixId))
  }

  private async reassignMatrixTasksLocked(fromMatrixId: TaskMatrixId, toMatrixId: TaskMatrixId | null): Promise<{ moved: number }> {
    this.assertMatrix(fromMatrixId)
    this.assertMatrix(toMatrixId)
    if (fromMatrixId === toMatrixId) return { moved: 0 }
    let moved = 0
    for (const [id, t] of [...this.reqTasks().entries()]) {
      if (t.deletedAt !== undefined) continue
      if (String(t.matrixId) !== String(fromMatrixId)) continue
      await this.reqTasks().put(id, { ...t, matrixId: toMatrixId, updatedAt: this.now() })
      await this.emit('task.matrix_changed', TASK_AGG, String(id), {
        taskId: String(id),
        fromMatrixId: String(fromMatrixId),
        toMatrixId: toMatrixId === null ? null : String(toMatrixId),
        bulk: true,
      })
      moved++
    }
    return { moved }
  }

  /**
   * Permanently remove a matrix. Empty matrices remove directly. A non-empty
   * matrix rejects with its task counts unless `reassignTo` is supplied, in
   * which case all its tasks are bulk-reassigned first (Inbox = `null`).
   */
  async removeMatrix(matrixId: TaskMatrixId, opts: { reassignTo?: TaskMatrixId | null } = {}): Promise<{ removed: boolean; moved: number }> {
    return this.withMutation(() => this.removeMatrixLocked(matrixId, opts))
  }

  private async removeMatrixLocked(matrixId: TaskMatrixId, opts: { reassignTo?: TaskMatrixId | null } = {}): Promise<{ removed: boolean; moved: number }> {
    const m = this.reqMatrices().get(matrixId)
    if (m === undefined) return { removed: false, moved: 0 }
    if (opts.reassignTo === matrixId) throw new Error('pkwTasks: cannot remove a matrix by reassigning its tasks to itself')
    if (opts.reassignTo !== undefined) this.assertMatrix(opts.reassignTo)
    const tasks = this.listTasks({ matrixId })
    const open = tasks.filter(t => t.status === 'open').length
    if (tasks.length > 0) {
      if (opts.reassignTo === undefined) {
        throw new Error(`pkwTasks: matrix '${matrixId}' is not empty (${open} open / ${tasks.length} total); reassign tasks or move them to Inbox first`)
      }
      await this.reassignMatrixTasksLocked(matrixId, opts.reassignTo)
    }
    await this.detachTrashedMatrixTasks(matrixId)
    await this.reqMatrices().delete(matrixId)
    await this.emit('task.matrix_deleted', MATRIX_AGG, String(matrixId), { matrixId: String(matrixId), moved: tasks.length })
    return { removed: true, moved: tasks.length }
  }

  /**
   * Trash this matrix's tasks. Subtasks have independent matrix assignments:
   * children outside the affected matrix survive as top-level tasks.
   */
  async removeMatrixWithTasks(matrixId: TaskMatrixId): Promise<{ removed: boolean; deleted: number }> {
    return this.withMutation(() => this.removeMatrixWithTasksLocked(matrixId))
  }

  private async removeMatrixWithTasksLocked(matrixId: TaskMatrixId): Promise<{ removed: boolean; deleted: number }> {
    const m = this.reqMatrices().get(matrixId)
    if (m === undefined) return { removed: false, deleted: 0 }
    const tasks = this.listTasks({ matrixId })
    const deletingIds = new Set(tasks.map(t => t.taskId))
    // Promote survivors before deleting their parent, so a failed put cannot
    // leave an active child hidden under a trashed parent.
    await this.promoteSurvivingChildren(deletingIds)
    const depth = (task: Task): number => {
      let parentId = task.parentTaskId
      const seen = new Set<TaskId>([task.taskId])
      let value = 0
      while (parentId !== null && deletingIds.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId)
        value++
        parentId = this.reqTasks().get(parentId)?.parentTaskId ?? null
      }
      return value
    }
    // Children first: if a later write fails, still-active members retain an
    // active parent. Bulk changes are deliberately not claimed as atomic.
    tasks.sort((a, b) => depth(b) - depth(a))
    let deleted = 0
    for (const t of tasks) {
      if (t.deletedAt !== undefined) continue
      await this.reqTasks().put(t.taskId, { ...t, matrixId: null, deletedAt: this.now(), updatedAt: this.now() })
      await this.emit('task.deleted', TASK_AGG, String(t.taskId), { taskId: String(t.taskId), bulk: true })
      deleted++
    }
    await this.detachTrashedMatrixTasks(matrixId)
    await this.reqMatrices().delete(matrixId)
    await this.emit('task.matrix_deleted', MATRIX_AGG, String(matrixId), { matrixId: String(matrixId), moved: 0, deleted })
    return { removed: true, deleted }
  }

  // ── tasks ─────────────────────────────────────────────────────────────────

  listTasks(filter: { matrixId?: TaskMatrixId | null; status?: TaskStatus; includeDeleted?: boolean } = {}): Task[] {
    const out: Task[] = []
    for (const [, t] of this.reqTasks().entries()) {
      if (filter.includeDeleted !== true && t.deletedAt !== undefined) continue
      if (filter.matrixId !== undefined && t.matrixId !== filter.matrixId) continue
      if (filter.status !== undefined && t.status !== filter.status) continue
      out.push(t)
    }
    return out.sort((a, b) => a.manualOrder - b.manualOrder)
  }

  listSubtasks(parentTaskId: TaskId): Task[] {
    const out: Task[] = []
    for (const [, t] of this.reqTasks().entries()) {
      if (t.deletedAt !== undefined) continue
      if (t.parentTaskId !== null && String(t.parentTaskId) === String(parentTaskId)) out.push(t)
    }
    return out.sort((a, b) => a.manualOrder - b.manualOrder)
  }

  /** True if reparenting `taskId` under `newParentId` would create a cycle (incl. self-parent). */
  private wouldCreateCycle(taskId: TaskId, newParentId: TaskId | null): boolean {
    if (newParentId === null) return false
    let cur: TaskId | null = newParentId
    const seen = new Set<string>()
    while (cur !== null) {
      const id = String(cur)
      if (id === String(taskId)) return true
      if (seen.has(id)) return true // defensive against a pre-existing broken cycle
      seen.add(id)
      const parent = this.reqTasks().get(cur)
      if (parent === undefined || parent.parentTaskId === null) return false
      cur = parent.parentTaskId
    }
    return false
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    return this.withMutation(() => this.createTaskLocked(input))
  }

  private async createTaskLocked(input: CreateTaskInput): Promise<Task> {
    this.assertMatrix(input.matrixId ?? null)
    this.assertParent(input.parentTaskId ?? null)
    const dueAt = this.normalizeDate(input.dueAt, 'dueAt')
    const scheduledAt = this.normalizeDate(input.scheduledAt, 'scheduledAt')
    const now = this.now()
    // The host table validates on reopen, not on put. Validate caller input
    // before it can poison the canonical store for the next process start.
    const task: Task = taskDomainSpec.tables.tasks.valueSchema.parse({
      taskId: TaskId(`task_${randomUUID().replaceAll('-', '').slice(0, 12)}`),
      workspaceId: WorkspaceId(this.config.workspaceId),
      matrixId: input.matrixId ?? null,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: 'open',
      important: input.important ?? false,
      urgent: input.urgent ?? false,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      tags: input.tags ?? [],
      parentTaskId: input.parentTaskId ?? null,
      sourceRefs: input.sourceRefs ?? [],
      manualOrder: this.listTasks({ includeDeleted: true }).length,
      createdAt: now,
      updatedAt: now,
    })
    await this.reqTasks().put(task.taskId, task)
    await this.emit('task.created', TASK_AGG, String(task.taskId), { taskId: String(task.taskId), title: task.title, matrixId: task.matrixId === null ? null : String(task.matrixId) })
    return task
  }

  async updateTask(taskId: TaskId, patch: Partial<Omit<Task, 'taskId' | 'workspaceId' | 'createdAt'>>, options: { expectedContentHash?: string } = {}): Promise<Task> {
    return this.withMutation(() => this.updateTaskLocked(taskId, patch, options.expectedContentHash))
  }

  private async updateTaskLocked(taskId: TaskId, patch: Partial<Omit<Task, 'taskId' | 'workspaceId' | 'createdAt'>>, expectedContentHash?: string): Promise<Task> {
    const t = this.activeTask(taskId)
    if (expectedContentHash !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) throw new Error('Invalid expectedContentHash')
      if (taskContentHash(t) !== expectedContentHash) throw new TaskUpdateConflictError()
    }
    for (const key of ['taskId', 'workspaceId', 'createdAt'] as const) {
      if (key in patch) throw new Error(`pkwTasks: ${key} is immutable`)
    }
    if ('deletedAt' in patch) throw new Error('pkwTasks: use deleteTask or restoreTask to change trash state')
    if ('matrixId' in patch) this.assertMatrix(patch.matrixId as TaskMatrixId | null)
    if ('parentTaskId' in patch) this.assertParent(patch.parentTaskId as TaskId | null)
    if (patch.parentTaskId !== undefined && this.wouldCreateCycle(taskId, patch.parentTaskId)) {
      throw new Error(`pkwTasks: cannot set parentTaskId — cycle detected`)
    }
    const next: Task = taskDomainSpec.tables.tasks.valueSchema.parse({
      ...t,
      ...patch,
      ...('dueAt' in patch ? { dueAt: this.normalizeDate(patch.dueAt, 'dueAt') } : {}),
      ...('scheduledAt' in patch ? { scheduledAt: this.normalizeDate(patch.scheduledAt, 'scheduledAt') } : {}),
      taskId: t.taskId,
      workspaceId: t.workspaceId,
      createdAt: t.createdAt,
      updatedAt: this.now(),
    })
    await this.reqTasks().put(taskId, next)
    await this.emit('task.updated', TASK_AGG, String(taskId), { taskId: String(taskId) })
    return next
  }

  async completeTask(taskId: TaskId): Promise<Task> {
    return this.withMutation(() => this.completeTaskLocked(taskId))
  }

  private async completeTaskLocked(taskId: TaskId): Promise<Task> {
    const t = this.activeTask(taskId)
    const next = { ...t, status: 'completed' as const, completedAt: this.now(), updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.completed', TASK_AGG, String(taskId), { taskId: String(taskId) })
    return next
  }

  async reopenTask(taskId: TaskId): Promise<Task> {
    return this.withMutation(() => this.reopenTaskLocked(taskId))
  }

  private async reopenTaskLocked(taskId: TaskId): Promise<Task> {
    const t = this.activeTask(taskId)
    const next = { ...t, status: 'open' as const, completedAt: undefined, updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.reopened', TASK_AGG, String(taskId), { taskId: String(taskId) })
    return next
  }

  async reorderTasks(orderedTaskIds: TaskId[]): Promise<void> {
    return this.withMutation(() => this.reorderTasksLocked(orderedTaskIds))
  }

  private async reorderTasksLocked(orderedTaskIds: TaskId[]): Promise<void> {
    const tasks = this.reqTasks()
    const idSet = new Set(orderedTaskIds.map((id) => String(id)))
    const next: Task[] = []
    for (const id of orderedTaskIds) {
      const t = tasks.get(id)
      if (t === undefined || t.deletedAt !== undefined) continue
      next.push(t)
    }
    const remaining: Task[] = []
    for (const [, t] of tasks.entries()) {
      if (t.deletedAt !== undefined) continue
      if (idSet.has(String(t.taskId))) continue
      remaining.push(t)
    }
    // Preserve the relative order of every task NOT in this reorder scope, so
    // reordering one matrix/quadrant never scrambles another's manual order.
    remaining.sort((a, b) => a.manualOrder - b.manualOrder)
    next.push(...remaining)
    let order = 0
    for (const t of next) {
      await tasks.put(t.taskId, { ...t, manualOrder: order, updatedAt: this.now() })
      order++
    }
    await this.emit('task.reordered', TASK_AGG, 'all', { taskIds: orderedTaskIds.map((id) => String(id)) })
  }

  async moveTaskToMatrix(taskId: TaskId, matrixId: TaskMatrixId | null): Promise<Task> {
    return this.withMutation(() => this.moveTaskToMatrixLocked(taskId, matrixId))
  }

  private async moveTaskToMatrixLocked(taskId: TaskId, matrixId: TaskMatrixId | null): Promise<Task> {
    const t = this.activeTask(taskId)
    this.assertMatrix(matrixId)
    const next = { ...t, matrixId, updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.matrix_changed', TASK_AGG, String(taskId), { taskId: String(taskId), fromMatrixId: t.matrixId === null ? null : String(t.matrixId), toMatrixId: matrixId === null ? null : String(matrixId) })
    return next
  }

  async deleteTask(taskId: TaskId): Promise<void> {
    return this.withMutation(() => this.deleteTaskLocked(taskId))
  }

  private async deleteTaskLocked(taskId: TaskId): Promise<void> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined || t.deletedAt !== undefined) return
    // Promote children to top-level tasks (never cascade-delete, never leave dangling refs).
    await this.promoteSurvivingChildren(new Set([taskId]))
    await this.reqTasks().put(taskId, { ...t, deletedAt: this.now(), updatedAt: this.now() })
    await this.emit('task.deleted', TASK_AGG, String(taskId), { taskId: String(taskId) })
  }

  async restoreTask(taskId: TaskId): Promise<Task> {
    return this.withMutation(() => this.restoreTaskLocked(taskId))
  }

  private async restoreTaskLocked(taskId: TaskId): Promise<Task> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined || t.deletedAt === undefined) throw new Error(`pkwTasks: task '${taskId}' is not trashed`)
    const matrix = t.matrixId === null ? undefined : this.reqMatrices().get(t.matrixId)
    const matrixId = matrix !== undefined && matrix.archivedAt === undefined ? matrix.matrixId : null
    let parentTaskId = t.parentTaskId
    let ancestorId = parentTaskId
    const visited = new Set<TaskId>([taskId])
    while (ancestorId !== null) {
      const ancestor = this.reqTasks().get(ancestorId)
      const parentMatrix = ancestor?.matrixId === null || ancestor === undefined ? undefined : this.reqMatrices().get(ancestor.matrixId)
      if (visited.has(ancestorId) || ancestor === undefined || ancestor.deletedAt !== undefined
        || (ancestor.matrixId !== null && (parentMatrix === undefined || parentMatrix.archivedAt !== undefined))) {
        // Inbox renders roots. Keeping a hidden/invalid ancestor would make a
        // successfully restored task disappear from all reachable task views.
        parentTaskId = null
        break
      }
      visited.add(ancestorId)
      ancestorId = ancestor.parentTaskId
    }
    const next = { ...t, matrixId, parentTaskId, deletedAt: undefined, updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.restored', TASK_AGG, String(taskId), { taskId: String(taskId), matrixId, parentTaskId, previousMatrixId: t.matrixId, previousParentTaskId: t.parentTaskId })
    return next
  }
}

export default TasksService

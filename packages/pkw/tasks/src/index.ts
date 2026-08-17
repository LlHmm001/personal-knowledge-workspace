/**
 * PKW Tasks core (`ctx.pkwTasks`): multiple Eisenhower matrices + a current-state
 * Task Store over `ctx.storage`, with durable event history via `ctx.pkwEvents`.
 *
 * Quadrant is DERIVED from `important × urgent` inside a TaskMatrix (never stored);
 * a Task belongs to ONE primary matrix (nullable = Inbox/unassigned).
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
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

const TASK_AGG = 'task'
const MATRIX_AGG = 'taskMatrix'

export class TasksService extends Service {
  static inject = ['storageDomain', 'pkwEvents']
  static Config: z<Config> = z.object({ workspaceId: z.string() })

  private matrices?: KvTable<TaskMatrixId, TaskMatrix>
  private tasks?: KvTable<TaskId, Task>

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
    const now = this.now()
    const matrix: TaskMatrix = {
      matrixId: TaskMatrixId(`matrix_${randomUUID().replaceAll('-', '').slice(0, 12)}`),
      workspaceId: WorkspaceId(this.config.workspaceId),
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      manualOrder: this.listMatrices({ includeArchived: true }).length,
      createdAt: now,
      updatedAt: now,
    }
    await this.reqMatrices().put(matrix.matrixId, matrix)
    await this.emit('task.matrix_created', MATRIX_AGG, String(matrix.matrixId), { matrixId: String(matrix.matrixId), name: matrix.name })
    return matrix
  }

  async renameMatrix(matrixId: TaskMatrixId, name: string): Promise<TaskMatrix> {
    const m = this.reqMatrices().get(matrixId)
    if (m === undefined) throw new Error(`pkwTasks: unknown matrix '${matrixId}'`)
    const next = { ...m, name, updatedAt: this.now() }
    await this.reqMatrices().put(matrixId, next)
    await this.emit('task.matrix_updated', MATRIX_AGG, String(matrixId), { matrixId: String(matrixId), name })
    return next
  }

  async archiveMatrix(matrixId: TaskMatrixId): Promise<void> {
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
    const m = this.reqMatrices().get(matrixId)
    if (m === undefined) return { removed: false, moved: 0 }
    const tasks = this.listTasks({ matrixId })
    const open = tasks.filter(t => t.status === 'open').length
    if (tasks.length > 0) {
      if (opts.reassignTo === undefined) {
        throw new Error(`pkwTasks: matrix '${matrixId}' is not empty (${open} open / ${tasks.length} total); reassign tasks or move them to Inbox first`)
      }
      await this.reassignMatrixTasks(matrixId, opts.reassignTo)
    }
    await this.reqMatrices().delete(matrixId)
    await this.emit('task.matrix_deleted', MATRIX_AGG, String(matrixId), { matrixId: String(matrixId), moved: tasks.length })
    return { removed: true, moved: tasks.length }
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

  async createTask(input: CreateTaskInput): Promise<Task> {
    const now = this.now()
    const task: Task = {
      taskId: TaskId(`task_${randomUUID().replaceAll('-', '').slice(0, 12)}`),
      workspaceId: WorkspaceId(this.config.workspaceId),
      matrixId: input.matrixId ?? null,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: 'open',
      important: input.important ?? false,
      urgent: input.urgent ?? false,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      tags: input.tags ?? [],
      parentTaskId: input.parentTaskId ?? null,
      sourceRefs: input.sourceRefs ?? [],
      manualOrder: this.listTasks({ includeDeleted: true }).length,
      createdAt: now,
      updatedAt: now,
    }
    await this.reqTasks().put(task.taskId, task)
    await this.emit('task.created', TASK_AGG, String(task.taskId), { taskId: String(task.taskId), title: task.title, matrixId: task.matrixId === null ? null : String(task.matrixId) })
    return task
  }

  async updateTask(taskId: TaskId, patch: Partial<Omit<Task, 'taskId' | 'workspaceId' | 'createdAt'>>): Promise<Task> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined) throw new Error(`pkwTasks: unknown task '${taskId}'`)
    const next: Task = { ...t, ...patch, taskId: t.taskId, workspaceId: t.workspaceId, createdAt: t.createdAt, updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.updated', TASK_AGG, String(taskId), { taskId: String(taskId) })
    return next
  }

  async completeTask(taskId: TaskId): Promise<Task> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined) throw new Error(`pkwTasks: unknown task '${taskId}'`)
    const next = { ...t, status: 'completed' as const, completedAt: this.now(), updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.completed', TASK_AGG, String(taskId), { taskId: String(taskId) })
    return next
  }

  async reopenTask(taskId: TaskId): Promise<Task> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined) throw new Error(`pkwTasks: unknown task '${taskId}'`)
    const next = { ...t, status: 'open' as const, completedAt: undefined, updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.reopened', TASK_AGG, String(taskId), { taskId: String(taskId) })
    return next
  }

  async reorderTasks(orderedTaskIds: TaskId[]): Promise<void> {
    const tasks = this.reqTasks()
    const idSet = new Set(orderedTaskIds.map((id) => String(id)))
    const next: Task[] = []
    for (const id of orderedTaskIds) {
      const t = tasks.get(id)
      if (t === undefined) continue
      next.push(t)
    }
    for (const [, t] of tasks.entries()) {
      if (t.deletedAt !== undefined) continue
      if (idSet.has(String(t.taskId))) continue
      next.push(t)
    }
    let order = 0
    for (const t of next) {
      await tasks.put(t.taskId, { ...t, manualOrder: order, updatedAt: this.now() })
      order++
    }
    await this.emit('task.reordered', TASK_AGG, 'all', { taskIds: orderedTaskIds.map((id) => String(id)) })
  }

  async moveTaskToMatrix(taskId: TaskId, matrixId: TaskMatrixId | null): Promise<Task> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined) throw new Error(`pkwTasks: unknown task '${taskId}'`)
    const next = { ...t, matrixId, updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.matrix_changed', TASK_AGG, String(taskId), { taskId: String(taskId), fromMatrixId: t.matrixId === null ? null : String(t.matrixId), toMatrixId: matrixId === null ? null : String(matrixId) })
    return next
  }

  async deleteTask(taskId: TaskId): Promise<void> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined || t.deletedAt !== undefined) return
    await this.reqTasks().put(taskId, { ...t, deletedAt: this.now(), updatedAt: this.now() })
    await this.emit('task.deleted', TASK_AGG, String(taskId), { taskId: String(taskId) })
  }

  async restoreTask(taskId: TaskId): Promise<Task> {
    const t = this.reqTasks().get(taskId)
    if (t === undefined || t.deletedAt === undefined) throw new Error(`pkwTasks: task '${taskId}' is not trashed`)
    const next = { ...t, deletedAt: undefined, updatedAt: this.now() }
    await this.reqTasks().put(taskId, next)
    await this.emit('task.restored', TASK_AGG, String(taskId), { taskId: String(taskId) })
    return next
  }
}

export default TasksService

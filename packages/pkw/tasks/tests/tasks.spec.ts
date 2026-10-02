import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import PkwEventStoreService from '../../events/src/index.ts'
import PkwWorkspaceService from '../../workspace/src/index.ts'
import TasksService from '../src/index.ts'
import { TaskId, TaskMatrixId } from '@deepseek-ai/dsh-pkw-domain'

const dirs: string[] = []
const contexts: Context[] = []
const backends: SqliteStorageBackend[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(backends.splice(0).map(backend => backend.close()))
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function boot(options: { dir?: string; databasePath?: string } = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'pkw-tasks-'))
  if (options.dir === undefined) dirs.push(dir)
  await mkdir(join(dir, 'notes'), { recursive: true })
  await mkdir(join(dir, 'attachments'), { recursive: true })
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: options.databasePath ?? ':memory:', journalMode: 'wal' })
  backends.push(backend)
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [], load: () => { throw new Error('unused') }, inspect: () => { throw new Error('unused') } } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(PkwEventStoreService)
  await ctx.plugin(PkwWorkspaceService)
  const ws = await ctx.workspaceRegistry.create(dir)
  await ctx.plugin(TasksService, { workspaceId: ws.id })
  return { ctx, backend, dir, tasks: ctx.pkwTasks, workspaceId: ws.id }
}

describe('PKW tasks core', () => {
  it('rejects runtime patches of immutable identity, workspace and creation timestamp', async () => {
    const { tasks } = await boot()
    const original = await tasks.createTask({ title: 'original' })
    const another = await tasks.createTask({ title: 'another valid task' })
    for (const patch of [
      { taskId: another.taskId },
      { workspaceId: 'another-workspace' },
      { createdAt: '2000-01-01T00:00:00.000Z' },
    ]) {
      await expect(tasks.updateTask(original.taskId, patch as never)).rejects.toThrow('immutable')
    }
    expect(tasks.listTasks()).toEqual([original, another])
  })

  it('clears dates with empty strings, rejects null and reopens the durable Task Store without schema drift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pkw-tasks-durable-'))
    dirs.push(dir)
    const databasePath = join(dir, 'tasks.sqlite')
    const first = await boot({ dir, databasePath })
    const dated = await first.tasks.createTask({ title: 'keep dates', dueAt: '2026-10-10', scheduledAt: '2026-10-09' })
    const cleared = await first.tasks.createTask({ title: 'clear dates', dueAt: '2026-10-10', scheduledAt: '2026-10-09' })
    const updated = await first.tasks.updateTask(cleared.taskId, { dueAt: '', scheduledAt: '' })
    expect(updated.dueAt).toBeUndefined()
    expect(updated.scheduledAt).toBeUndefined()
    await expect(first.tasks.updateTask(cleared.taskId, { dueAt: null as never })).rejects.toThrow('dueAt')
    await expect(first.tasks.updateTask(cleared.taskId, { scheduledAt: null as never })).rejects.toThrow('scheduledAt')
    await expect(first.tasks.createTask({ title: 'bad input', dueAt: null as never })).rejects.toThrow('dueAt')
    await expect(first.tasks.updateTask(dated.taskId, { status: 'invalid-status' as never })).rejects.toThrow()
    await expect(first.tasks.updateTask(dated.taskId, { priority: Number.NaN })).rejects.toThrow()
    await expect(first.tasks.updateTask(dated.taskId, { sourceRefs: [{ kind: 'unknown', noteId: 'note_source' }] as never })).rejects.toThrow()
    await expect(first.tasks.createTask({ title: null as never })).rejects.toThrow()
    await first.ctx.fiber.dispose()
    await first.backend.close()
    const reopened = await boot({ dir, databasePath })
    expect(reopened.workspaceId).toBe(first.workspaceId)
    expect(reopened.tasks.listTasks()).toHaveLength(2)
    expect(reopened.tasks.listTasks().find(t => t.taskId === dated.taskId)).toMatchObject({ dueAt: '2026-10-10', scheduledAt: '2026-10-09' })
    const restored = reopened.tasks.listTasks().find(t => t.taskId === cleared.taskId)!
    expect(restored.dueAt).toBeUndefined()
    expect(restored.scheduledAt).toBeUndefined()
  })

  it('serializes matrix removal with a concurrent task creation so validation cannot race deletion', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'work' })
    const matrixTable = (tasks as unknown as { reqMatrices(): { delete(id: TaskMatrixId): Promise<boolean> } }).reqMatrices()
    const remove = matrixTable.delete.bind(matrixTable)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const spy = vi.spyOn(matrixTable, 'delete').mockImplementationOnce(async id => {
      entered.resolve()
      await release.promise
      return remove(id)
    })
    try {
      const removing = tasks.removeMatrix(matrix.matrixId)
      await entered.promise
      const creating = tasks.createTask({ title: 'must not be orphaned', matrixId: matrix.matrixId })
      const settled = Promise.allSettled([removing, creating])
      release.resolve()
      const results = await settled
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { removed: true } })
      expect(results[1]).toMatchObject({ status: 'rejected' })
      expect(tasks.listTasks({ includeDeleted: true })).toEqual([])
      expect(tasks.listMatrices({ includeArchived: true })).toEqual([])
      expect((await tasks.createTask({ title: 'queue still usable' })).matrixId).toBeNull()
    } finally {
      release.resolve()
      spy.mockRestore()
    }
  })

  it('rejects one of two concurrent reparentings that would jointly form a cycle', async () => {
    const { tasks } = await boot()
    const a = await tasks.createTask({ title: 'A' })
    const b = await tasks.createTask({ title: 'B' })
    const results = await Promise.allSettled([
      tasks.updateTask(a.taskId, { parentTaskId: b.taskId }),
      tasks.updateTask(b.taskId, { parentTaskId: a.taskId }),
    ])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('rejected')
    expect(tasks.listTasks().find(t => t.taskId === b.taskId)!.parentTaskId).toBeNull()
    expect(tasks.listSubtasks(b.taskId).map(t => t.taskId)).toEqual([a.taskId])
  })

  it('preserves an active parent if promoting its child fails, then permits a safe retry', async () => {
    const { tasks } = await boot()
    const parent = await tasks.createTask({ title: 'parent' })
    const child = await tasks.createTask({ title: 'child', parentTaskId: parent.taskId })
    const table = (tasks as unknown as { reqTasks(): { put(id: TaskId, value: unknown): Promise<void> } }).reqTasks()
    const put = table.put.bind(table)
    const spy = vi.spyOn(table, 'put').mockImplementation(async (id, value) => {
      if (id === child.taskId) throw new Error('injected child storage failure')
      return put(id, value)
    })
    try {
      await expect(tasks.deleteTask(parent.taskId)).rejects.toThrow('injected child storage failure')
      expect(tasks.listTasks()).toEqual([parent, child])
    } finally {
      spy.mockRestore()
    }
    await tasks.deleteTask(parent.taskId)
    expect(tasks.listTasks()).toEqual([expect.objectContaining({ taskId: child.taskId, parentTaskId: null })])
  })

  it('deletes descendants before parents in a bulk operation so partial failure remains visible and retryable', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'work' })
    const parent = await tasks.createTask({ title: 'parent', matrixId: matrix.matrixId })
    const child = await tasks.createTask({ title: 'child', matrixId: matrix.matrixId, parentTaskId: parent.taskId })
    const table = (tasks as unknown as { reqTasks(): { put(id: TaskId, value: unknown): Promise<void> } }).reqTasks()
    const put = table.put.bind(table)
    const spy = vi.spyOn(table, 'put').mockImplementation(async (id, value) => {
      if (id === parent.taskId) throw new Error('injected parent storage failure')
      return put(id, value)
    })
    try {
      await expect(tasks.removeMatrixWithTasks(matrix.matrixId)).rejects.toThrow('injected parent storage failure')
      expect(tasks.listTasks()).toEqual([parent])
      expect(tasks.listTasks({ includeDeleted: true }).find(t => t.taskId === child.taskId)!.deletedAt).toBeDefined()
      expect(tasks.listMatrices()).toEqual([matrix])
    } finally {
      spy.mockRestore()
    }
    await tasks.removeMatrixWithTasks(matrix.matrixId)
    expect(tasks.listTasks()).toEqual([])
    expect(tasks.listMatrices()).toEqual([])
    expect(tasks.listTasks({ includeDeleted: true }).every(t => t.matrixId === null)).toBe(true)
  })

  it('restores a task from an archived matrix into Inbox with its identity and sources intact', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'archived' })
    const task = await tasks.createTask({ title: 'recover me', matrixId: matrix.matrixId, sourceRefs: [{ kind: 'note', noteId: 'note_source' }] })
    await tasks.deleteTask(task.taskId)
    await tasks.archiveMatrix(matrix.matrixId)
    const restored = await tasks.restoreTask(task.taskId)
    expect(restored).toMatchObject({ taskId: task.taskId, matrixId: null, sourceRefs: task.sourceRefs })
    expect(tasks.listMatrices()).toEqual([])
  })

  it('restores a child of a parent in an archived matrix as a visible Inbox top-level task', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'archived hierarchy' })
    const parent = await tasks.createTask({ title: 'parent', matrixId: matrix.matrixId })
    const child = await tasks.createTask({ title: 'child', matrixId: matrix.matrixId, parentTaskId: parent.taskId })
    await tasks.deleteTask(child.taskId)
    await tasks.archiveMatrix(matrix.matrixId)
    const restored = await tasks.restoreTask(child.taskId)
    expect(restored).toMatchObject({ taskId: child.taskId, matrixId: null, parentTaskId: null })
    expect(tasks.listTasks({ matrixId: null }).filter(t => t.parentTaskId === null).map(t => t.taskId)).toEqual([child.taskId])
    expect(tasks.listTasks({ matrixId: matrix.matrixId })).toEqual([parent])
  })

  it('rejects nonexistent matrix references on create, update, move and bulk reassignment without changing records', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'valid' })
    const task = await tasks.createTask({ title: 'keep', matrixId: matrix.matrixId })
    const missing = TaskMatrixId('matrix_missing')
    await expect(tasks.createTask({ title: 'invalid', matrixId: missing })).rejects.toThrow('unknown matrix')
    await expect(tasks.updateTask(task.taskId, { matrixId: missing })).rejects.toThrow('unknown matrix')
    await expect(tasks.moveTaskToMatrix(task.taskId, missing)).rejects.toThrow('unknown matrix')
    await expect(tasks.reassignMatrixTasks(matrix.matrixId, missing)).rejects.toThrow('unknown matrix')
    expect(tasks.listTasks()).toEqual([task])
  })

  it('rejects matrix removal that reassigns tasks to itself or to a nonexistent target', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'keep' })
    const task = await tasks.createTask({ title: 'keep', matrixId: matrix.matrixId })
    await expect(tasks.removeMatrix(matrix.matrixId, { reassignTo: matrix.matrixId })).rejects.toThrow('itself')
    await expect(tasks.removeMatrix(matrix.matrixId, { reassignTo: TaskMatrixId('matrix_missing') })).rejects.toThrow('unknown matrix')
    expect(tasks.listMatrices()).toEqual([matrix])
    expect(tasks.listTasks()).toEqual([task])
  })

  it('rejects nonexistent or trashed parents before creating or reparenting a task', async () => {
    const { tasks } = await boot()
    const parent = await tasks.createTask({ title: 'parent' })
    const child = await tasks.createTask({ title: 'child' })
    await expect(tasks.createTask({ title: 'invalid', parentTaskId: TaskId('task_missing') })).rejects.toThrow('parent')
    await expect(tasks.updateTask(child.taskId, { parentTaskId: TaskId('task_missing') })).rejects.toThrow('parent')
    await tasks.deleteTask(parent.taskId)
    await expect(tasks.createTask({ title: 'invalid', parentTaskId: parent.taskId })).rejects.toThrow('parent')
    await expect(tasks.updateTask(child.taskId, { parentTaskId: parent.taskId })).rejects.toThrow('parent')
    expect(tasks.listTasks()).toEqual([child])
  })

  it('keeps trashed tasks restorable in Inbox when their matrix is removed', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'work' })
    const task = await tasks.createTask({ title: 'restore me', matrixId: matrix.matrixId, important: true, sourceRefs: [{ kind: 'note', noteId: 'note_source' }] })
    await tasks.deleteTask(task.taskId)
    const deletedAt = tasks.listTasks({ includeDeleted: true })[0]!.deletedAt
    await tasks.removeMatrix(matrix.matrixId)
    const trashed = tasks.listTasks({ includeDeleted: true })[0]!
    expect(trashed.matrixId).toBeNull()
    expect(trashed.deletedAt).toBe(deletedAt)
    const restored = await tasks.restoreTask(task.taskId)
    expect(restored).toMatchObject({ taskId: task.taskId, matrixId: null, important: true, sourceRefs: task.sourceRefs })
  })

  it('matrix deletion preserves independent children in other matrices as top-level tasks', async () => {
    const { tasks } = await boot()
    const work = await tasks.createMatrix({ name: 'work' })
    const life = await tasks.createMatrix({ name: 'life' })
    const parent = await tasks.createTask({ title: 'parent', matrixId: work.matrixId })
    const child = await tasks.createTask({ title: 'independent child', matrixId: life.matrixId, parentTaskId: parent.taskId })
    const result = await tasks.removeMatrixWithTasks(work.matrixId)
    expect(result).toEqual({ removed: true, deleted: 1 })
    expect(tasks.listTasks()).toEqual([expect.objectContaining({ taskId: child.taskId, matrixId: life.matrixId, parentTaskId: null })])
    expect(tasks.listTasks({ includeDeleted: true }).find(t => t.taskId === parent.taskId)!.deletedAt).toBeDefined()
  })

  it('restoring a child before its trashed parent makes it a visible top-level task', async () => {
    const { tasks } = await boot()
    const matrix = await tasks.createMatrix({ name: 'work' })
    const parent = await tasks.createTask({ title: 'parent', matrixId: matrix.matrixId })
    const child = await tasks.createTask({ title: 'child', matrixId: matrix.matrixId, parentTaskId: parent.taskId })
    await tasks.removeMatrixWithTasks(matrix.matrixId)
    const restored = await tasks.restoreTask(child.taskId)
    expect(restored.matrixId).toBeNull()
    expect(restored.parentTaskId).toBeNull()
    expect(restored.deletedAt).toBeUndefined()
  })

  it('does not let a generic patch bypass task delete/restore lifecycle', async () => {
    const { tasks } = await boot()
    const parent = await tasks.createTask({ title: 'parent' })
    const child = await tasks.createTask({ title: 'child', parentTaskId: parent.taskId })
    await expect(tasks.updateTask(parent.taskId, { deletedAt: new Date().toISOString() })).rejects.toThrow('deleteTask')
    expect(tasks.listTasks()).toEqual([parent, child])
    await tasks.deleteTask(parent.taskId)
    await expect(tasks.updateTask(parent.taskId, { deletedAt: undefined })).rejects.toThrow()
    expect(tasks.listTasks()).toHaveLength(1)
  })

  it('creates multiple independent matrices (user-defined, not hardcoded)', async () => {
    const { tasks } = await boot()
    const work = await tasks.createMatrix({ name: '工作' })
    const life = await tasks.createMatrix({ name: '生活' })
    const startup = await tasks.createMatrix({ name: '创业' })
    expect(tasks.listMatrices().map(m => m.name)).toEqual(['工作', '生活', '创业'])
    expect(work.matrixId).not.toBe(life.matrixId)
    expect(startup.matrixId).not.toBe(work.matrixId)
  })

  it('derives quadrant from important × urgent inside a matrix (one task = one primary matrix)', async () => {
    const { tasks } = await boot()
    const work = await tasks.createMatrix({ name: '工作' })
    const a = await tasks.createTask({ title: 'A', matrixId: work.matrixId, important: true, urgent: true })   // Q1
    const b = await tasks.createTask({ title: 'B', matrixId: work.matrixId, important: true, urgent: false })  // Q2
    expect(a.important).toBe(true); expect(a.urgent).toBe(true)
    expect(b.important).toBe(true); expect(b.urgent).toBe(false)
    // matrix scoping: only work tasks in this matrix.
    expect(tasks.listTasks({ matrixId: work.matrixId })).toHaveLength(2)
  })

  it('moves a task between matrices preserving TaskId', async () => {
    const { tasks } = await boot()
    const work = await tasks.createMatrix({ name: '工作' })
    const startup = await tasks.createMatrix({ name: '创业' })
    const t = await tasks.createTask({ title: 'move me', matrixId: startup.matrixId })
    const moved = await tasks.moveTaskToMatrix(t.taskId, work.matrixId)
    expect(moved.taskId).toBe(t.taskId)
    expect(String(moved.matrixId)).toBe(String(work.matrixId))
    expect(tasks.listTasks({ matrixId: work.matrixId }).some(x => x.taskId === t.taskId)).toBe(true)
  })

  it('supports unassigned Inbox (null matrix) and complete/reopen', async () => {
    const { tasks } = await boot()
    const t = await tasks.createTask({ title: 'inbox task' })
    expect(t.matrixId).toBeNull()
    const done = await tasks.completeTask(t.taskId)
    expect(done.status).toBe('completed')
    expect(done.completedAt).toBeDefined()
    const reopened = await tasks.reopenTask(t.taskId)
    expect(reopened.status).toBe('open')
    expect(reopened.completedAt).toBeUndefined()
  })

  it('stores Note sourceRef (Note→Task) and TextQuoteAnchor (Selection→Task) with stable NoteId', async () => {
    const { tasks } = await boot()
    const fromNote = await tasks.createTask({ title: 'note task', sourceRefs: [{ kind: 'note', noteId: 'note_abc' }] })
    expect(fromNote.sourceRefs).toEqual([{ kind: 'note', noteId: 'note_abc' }])
    const fromSelection = await tasks.createTask({
      title: 'selection task',
      sourceRefs: [{ kind: 'selection', noteId: 'note_abc', exact: '重新整理商业模型', prefix: '创业', suffix: 'DDmind', start: 12, end: 22, noteRevision: 3, contentHash: 'h1' }],
    })
    expect(fromSelection.sourceRefs[0]).toMatchObject({ kind: 'selection', noteId: 'note_abc', exact: '重新整理商业模型', prefix: '创业', suffix: 'DDmind', start: 12, end: 22, noteRevision: 3, contentHash: 'h1' })
  })

  it('reorders tasks within a manual order (matrix/quadrant drag support)', async () => {
    const { tasks } = await boot()
    const m = await tasks.createMatrix({ name: '工作' })
    const a = await tasks.createTask({ title: 'A', matrixId: m.matrixId })
    const b = await tasks.createTask({ title: 'B', matrixId: m.matrixId })
    const c = await tasks.createTask({ title: 'C', matrixId: m.matrixId })
    expect(tasks.listTasks({ matrixId: m.matrixId }).map(t => t.title)).toEqual(['A', 'B', 'C'])
    await tasks.reorderTasks([c.taskId, a.taskId, b.taskId])
    expect(tasks.listTasks({ matrixId: m.matrixId }).map(t => t.title)).toEqual(['C', 'A', 'B'])
  })

  it('removeMatrix deletes an empty matrix', async () => {
    const { tasks } = await boot()
    const m = await tasks.createMatrix({ name: '空矩阵' })
    const r = await tasks.removeMatrix(m.matrixId)
    expect(r).toEqual({ removed: true, moved: 0 })
    expect(tasks.listMatrices({ includeArchived: true }).some(x => x.matrixId === m.matrixId)).toBe(false)
  })

  it('removeMatrix on a non-empty matrix rejects without reassignTo', async () => {
    const { tasks } = await boot()
    const m = await tasks.createMatrix({ name: '工作' })
    await tasks.createTask({ title: 'A', matrixId: m.matrixId })
    await expect(tasks.removeMatrix(m.matrixId)).rejects.toThrow('not empty')
  })

  it('removeMatrix with reassignTo bulk-moves tasks preserving TaskId/sourceRefs/important/urgent', async () => {
    const { tasks } = await boot()
    const work = await tasks.createMatrix({ name: '工作' })
    const life = await tasks.createMatrix({ name: '生活' })
    const t = await tasks.createTask({ title: '迁移我', matrixId: work.matrixId, important: true, urgent: false, sourceRefs: [{ kind: 'note', noteId: 'note_abc' }] })
    const r = await tasks.removeMatrix(work.matrixId, { reassignTo: life.matrixId })
    expect(r.moved).toBe(1)
    expect(tasks.listMatrices({ includeArchived: true }).some(x => x.matrixId === work.matrixId)).toBe(false)
    const moved = tasks.listTasks({ matrixId: life.matrixId }).find(x => x.taskId === t.taskId)!
    expect(moved.taskId).toBe(t.taskId)
    expect(moved.important).toBe(true)
    expect(moved.urgent).toBe(false)
    expect(moved.sourceRefs).toEqual([{ kind: 'note', noteId: 'note_abc' }])
  })

  it('reassignMatrixTasks bulk-moves to Inbox (null) and reports count', async () => {
    const { tasks } = await boot()
    const m = await tasks.createMatrix({ name: '创业' })
    await tasks.createTask({ title: 'A', matrixId: m.matrixId })
    await tasks.createTask({ title: 'B', matrixId: m.matrixId })
    const r = await tasks.reassignMatrixTasks(m.matrixId, null)
    expect(r.moved).toBe(2)
    expect(tasks.listTasks({ matrixId: null }).some(x => x.title === 'A' || x.title === 'B')).toBe(true)
    expect(tasks.listTasks({ matrixId: m.matrixId })).toHaveLength(0)
  })

  it('reordering one matrix preserves another matrix\'s relative order', async () => {
    const { tasks } = await boot()
    const work = await tasks.createMatrix({ name: '工作' })
    const startup = await tasks.createMatrix({ name: '创业' })
    const w1 = await tasks.createTask({ title: 'W1', matrixId: work.matrixId })
    const w2 = await tasks.createTask({ title: 'W2', matrixId: work.matrixId })
    const s1 = await tasks.createTask({ title: 'S1', matrixId: startup.matrixId })
    const s2 = await tasks.createTask({ title: 'S2', matrixId: startup.matrixId })
    await tasks.reorderTasks([w2.taskId, w1.taskId])
    expect(tasks.listTasks({ matrixId: work.matrixId }).map(t => t.title)).toEqual(['W2', 'W1'])
    expect(tasks.listTasks({ matrixId: startup.matrixId }).map(t => t.title)).toEqual(['S1', 'S2'])
  })

  it('delete (trash) then restore a task', async () => {
    const { tasks } = await boot()
    const t = await tasks.createTask({ title: 'trash me' })
    await tasks.deleteTask(t.taskId)
    expect(tasks.listTasks().some(x => x.taskId === t.taskId)).toBe(false)
    const restored = await tasks.restoreTask(t.taskId)
    expect(restored.deletedAt).toBeUndefined()
    expect(tasks.listTasks().some(x => x.taskId === t.taskId)).toBe(true)
  })

  it('subtasks: create child, query children, complete/reopen, independent matrix', async () => {
    const { tasks } = await boot()
    const work = await tasks.createMatrix({ name: '工作' })
    const parent = await tasks.createTask({ title: '父任务', matrixId: work.matrixId, important: true, urgent: false })
    const child = await tasks.createTask({ title: '子任务', matrixId: work.matrixId, parentTaskId: parent.taskId })
    expect(tasks.listSubtasks(parent.taskId).map(t => t.title)).toEqual(['子任务'])
    expect(tasks.listSubtasks(parent.taskId)[0]!.parentTaskId).toBe(parent.taskId)
    await tasks.completeTask(child.taskId)
    expect(tasks.listSubtasks(parent.taskId)[0]!.status).toBe('completed')
    await tasks.reopenTask(child.taskId)
    expect(tasks.listSubtasks(parent.taskId)[0]!.status).toBe('open')
    // child matrix is independent: move it elsewhere
    const life = await tasks.createMatrix({ name: '生活' })
    await tasks.moveTaskToMatrix(child.taskId, life.matrixId)
    expect(tasks.listSubtasks(parent.taskId)[0]!.matrixId).toBe(life.matrixId)
  })

  it('subtasks: parent delete promotes children (no dangling refs)', async () => {
    const { tasks } = await boot()
    const parent = await tasks.createTask({ title: '父' })
    const child = await tasks.createTask({ title: '子', parentTaskId: parent.taskId })
    await tasks.deleteTask(parent.taskId)
    const promoted = tasks.listTasks().find(t => t.title === '子')!
    expect(promoted.parentTaskId).toBeNull()
  })

  it('subtasks: rejects self-parent and A→B→A cycle', async () => {
    const { tasks } = await boot()
    const a = await tasks.createTask({ title: 'A' })
    const b = await tasks.createTask({ title: 'B', parentTaskId: a.taskId })
    await expect(tasks.updateTask(a.taskId, { parentTaskId: a.taskId })).rejects.toThrow('cycle')
    await expect(tasks.updateTask(a.taskId, { parentTaskId: b.taskId })).rejects.toThrow('cycle')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
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

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-tasks-'))
  dirs.push(dir)
  await mkdir(join(dir, 'notes'), { recursive: true })
  await mkdir(join(dir, 'attachments'), { recursive: true })
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
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
  return { ctx, tasks: ctx.pkwTasks, workspaceId: ws.id }
}

describe('PKW tasks core', () => {
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
      sourceRefs: [{ kind: 'selection', noteId: 'note_abc', exact: '重新整理商业模型', prefix: '创业', suffix: 'DDmind', noteRevision: 3, contentHash: 'h1' }],
    })
    expect(fromSelection.sourceRefs[0]).toMatchObject({ kind: 'selection', noteId: 'note_abc', exact: '重新整理商业模型', prefix: '创业', suffix: 'DDmind' })
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
})

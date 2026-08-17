import { describe, expect, it } from 'vitest'
import { filterTasksForView, quadrantOf, type Task } from '../src/index.ts'

let seq = 0
function mk(over: Partial<Task> & { title: string }): Task {
  seq++
  return {
    taskId: `task_${seq}` as never,
    workspaceId: 'ws' as never,
    matrixId: null,
    status: 'open',
    important: false,
    urgent: false,
    tags: [],
    parentTaskId: null,
    sourceRefs: [],
    manualOrder: seq,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
    title: over.title,
  }
}

describe('quadrantOf', () => {
  it('derives Q1–Q4 from important × urgent', () => {
    expect(quadrantOf({ important: true, urgent: true })).toBe(1)
    expect(quadrantOf({ important: true, urgent: false })).toBe(2)
    expect(quadrantOf({ important: false, urgent: true })).toBe(3)
    expect(quadrantOf({ important: false, urgent: false })).toBe(4)
  })
})

describe('filterTasksForView', () => {
  const now = new Date('2026-08-17T12:00:00Z')
  const m1 = 'matrix_work' as never, m2 = 'matrix_life' as never
  const tasks: Task[] = [
    mk({ title: 'work today', matrixId: m1, dueAt: '2026-08-17' }),
    mk({ title: 'life upcoming', matrixId: m2, dueAt: '2026-08-20' }),
    mk({ title: 'inbox no date', matrixId: null }),
    mk({ title: 'overdue', matrixId: m1, dueAt: '2026-08-10' }),
    mk({ title: 'done', matrixId: m1, status: 'completed', completedAt: '2026-08-01' }),
  ]

  it('all → only open tasks (soonest due first, undated last)', () => {
    expect(filterTasksForView(tasks, 'all', now).map(t => t.title)).toEqual(['overdue', 'work today', 'life upcoming', 'inbox no date'])
  })

  it('inbox → unassigned open tasks only', () => {
    expect(filterTasksForView(tasks, 'inbox', now).map(t => t.title)).toEqual(['inbox no date'])
  })

  it('completed → completed tasks only', () => {
    expect(filterTasksForView(tasks, 'completed', now).map(t => t.title)).toEqual(['done'])
  })

  it('today → due today or overdue (cross-matrix)', () => {
    const got = filterTasksForView(tasks, 'today', now).map(t => t.title)
    expect(got).toContain('work today')
    expect(got).toContain('overdue')
    expect(got).not.toContain('life upcoming')
    expect(got).not.toContain('inbox no date')
  })

  it('upcoming → future-due tasks only', () => {
    expect(filterTasksForView(tasks, 'upcoming', now).map(t => t.title)).toEqual(['life upcoming'])
  })

  it('cross-matrix: today includes tasks from multiple matrices', () => {
    const lifeToday = mk({ title: 'life today', matrixId: m2, dueAt: '2026-08-17' })
    const got = filterTasksForView([...tasks, lifeToday], 'today', now)
    const matrixIds = new Set(got.map(t => String(t.matrixId)))
    expect(matrixIds).toContain(String(m1))
    expect(matrixIds).toContain(String(m2))
  })

  it('sorts by due date, then manual order', () => {
    const got = filterTasksForView(tasks, 'all', now)
    const dueTitles = got.filter(t => t.dueAt).map(t => t.title)
    expect(dueTitles).toEqual(['overdue', 'work today', 'life upcoming'])
  })
})

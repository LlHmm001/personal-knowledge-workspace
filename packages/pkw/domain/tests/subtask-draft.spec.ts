import { describe, expect, it } from 'vitest'
import { applyCompletionToggle, baselineFromSubtasks, completedCount, deriveCompletionChanges, deriveSubtaskSeed, isCompletionDirty, projectionOf, removeCompletionDraft } from '../src/index.ts'

describe('subtask completion draft', () => {
  const base = { a: false, b: true, c: false }

  it('baselineFromSubtasks builds a completion map', () => {
    expect(baselineFromSubtasks([{ taskId: 'a', status: 'open' }, { taskId: 'b', status: 'completed' }])).toEqual({ a: false, b: true })
  })

  it('projectionOf prefers draft over baseline', () => {
    expect(projectionOf(base, { a: true }, 'a')).toBe(true)
    expect(projectionOf(base, {}, 'a')).toBe(false)
    expect(projectionOf(base, {}, 'b')).toBe(true)
  })

  it('applyCompletionToggle toggles immediately (local)', () => {
    const d1 = applyCompletionToggle({}, 'a', false)
    expect(d1).toEqual({ a: true })
    const d2 = applyCompletionToggle(d1, 'a', false) // toggle back
    expect(d2).toEqual({ a: false })
  })

  it('toggling back to baseline is no longer dirty', () => {
    const d = applyCompletionToggle({}, 'a', false) // a: true (differs)
    expect(isCompletionDirty(base, d)).toBe(true)
    const back = applyCompletionToggle(d, 'a', false) // a: false (back to baseline)
    expect(isCompletionDirty(base, back)).toBe(false)
  })

  it('deriveCompletionChanges only lists real diffs', () => {
    const draft = { a: true, b: false } // b false == baseline true? no: baseline b=true, draft b=false → diff
    expect(deriveCompletionChanges(base, draft)).toEqual([{ taskId: 'a', completed: true }, { taskId: 'b', completed: false }])
  })

  it('completedCount uses merged projection', () => {
    expect(completedCount(base, { a: true }, ['a', 'b', 'c'])).toBe(2) // a true + b true
    expect(completedCount(base, {}, ['a', 'b', 'c'])).toBe(1)
  })

  it('removeCompletionDraft drops a pending entry', () => {
    const d = { a: true, b: false }
    expect(removeCompletionDraft(d, 'a')).toEqual({ b: false })
  })

  it('deriveSubtaskSeed: subtaskCache wins over tasksCache', () => {
    const r = deriveSubtaskSeed('p', [{ taskId: 'x', title: 'X', status: 'open' }], [{ taskId: 'x', title: 'X', status: 'completed', parentTaskId: 'p' }])
    expect(r.source).toBe('subtask-cache')
    expect(r.items).toEqual([{ taskId: 'x', title: 'X', status: 'open' }])
  })

  it('deriveSubtaskSeed: tasksCache positive seed', () => {
    const tasks = [{ taskId: 'a', title: 'A', status: 'open', parentTaskId: 'p' }, { taskId: 'b', title: 'B', status: 'open', parentTaskId: null }]
    const r = deriveSubtaskSeed('p', undefined, tasks)
    expect(r.source).toBe('tasks-cache')
    expect(r.items).toEqual([{ taskId: 'a', title: 'A', status: 'open' }])
  })

  it('deriveSubtaskSeed: empty tasksCache → none (unknown, not empty)', () => {
    const r = deriveSubtaskSeed('p', undefined, [])
    expect(r.source).toBe('none')
    expect(r.items).toEqual([])
  })

  it('deriveSubtaskSeed: non-empty snapshot with no children → tasks-cache empty (valid no-subtask)', () => {
    const tasks = [{ taskId: 'r', title: 'R', status: 'open', parentTaskId: null }]
    const r = deriveSubtaskSeed('p', undefined, tasks)
    expect(r.source).toBe('tasks-cache')
    expect(r.items).toEqual([])
  })
})

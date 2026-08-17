/**
 * Pure task-view helpers shared by the Tasks UI and tests. `quadrantOf` encodes
 * the derived Eisenhower quadrant (never stored); `filterTasksForView` encodes
 * the cross-matrix aggregate views (Inbox / Today / Upcoming / Completed / All).
 * @module @deepseek-ai/dsh-pkw-domain/tasks-view
 */

import type { Task } from './types.ts'

export type TaskQuadrant = 1 | 2 | 3 | 4

/** Eisenhower quadrant DERIVED from `important × urgent` (Q1 = both, Q4 = neither). */
export function quadrantOf(task: { important: boolean; urgent: boolean }): TaskQuadrant {
  return task.important ? (task.urgent ? 1 : 2) : (task.urgent ? 3 : 4)
}

export type TaskView = 'all' | 'today' | 'upcoming' | 'completed' | 'inbox'

function isSameDay(d: Date, ref: Date): boolean {
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate()
}

/** A task's earliest "date-like" timestamp (dueAt preferred, then scheduledAt). */
function taskDate(t: Task): Date | undefined {
  const iso = t.dueAt ?? t.scheduledAt
  if (!iso) return undefined
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
  return isNaN(d.getTime()) ? undefined : d
}

/**
 * Cross-matrix aggregate view filter. `now` is injectable for deterministic
 * tests (defaults to the wall clock). Only open tasks appear in `all`, `inbox`,
 * `today`, `upcoming`; `completed` returns completed tasks.
 */
export function filterTasksForView(tasks: Task[], view: TaskView, now: Date = new Date()): Task[] {
  let list: Task[]
  switch (view) {
    case 'completed':
      list = tasks.filter(x => x.status === 'completed')
      break
    case 'inbox':
      list = tasks.filter(x => x.matrixId === null && x.status === 'open')
      break
    case 'today':
      list = tasks.filter(x => {
        if (x.status !== 'open') return false
        const d = taskDate(x)
        return d !== undefined && (isSameDay(d, now) || d < now)
      })
      break
    case 'upcoming':
      list = tasks.filter(x => {
        if (x.status !== 'open') return false
        const d = taskDate(x)
        return d !== undefined && d > now
      })
      break
    case 'all':
    default:
      list = tasks.filter(x => x.status === 'open')
  }
  // Stable order: soonest due first, then tasks without a date keep their manual order.
  return list.sort((a, b) => {
    const ad = taskDate(a)?.getTime() ?? Number.POSITIVE_INFINITY
    const bd = taskDate(b)?.getTime() ?? Number.POSITIVE_INFINITY
    return ad === bd ? a.manualOrder - b.manualOrder : ad - bd
  })
}

/**
 * Task drag/drop semantic model — a pure function from (task, drop target) to a
 * domain mutation intent. Smart views are queries, not containers: dropping a
 * task must always map to an explicit domain mutation, never a fake "view flag".
 * @module @deepseek-ai/dsh-pkw-domain/tasks-drag
 */

import type { Task, TaskMatrixId, TaskStatus } from './types.ts'
import type { TaskQuadrant } from './tasks-view.ts'

export type TaskDropTarget =
  | { kind: 'matrix-quadrant'; matrixId: TaskMatrixId; quadrant: TaskQuadrant }
  | { kind: 'matrix'; matrixId: TaskMatrixId } // keep current quadrant
  | { kind: 'inbox' }
  | { kind: 'today' }
  | { kind: 'completed' }

export interface TaskMutationIntent {
  matrixId?: TaskMatrixId | null
  important?: boolean
  urgent?: boolean
  scheduledAt?: string
  status?: TaskStatus
}

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * Resolve a drag drop into an explicit domain mutation intent. Returns
 * `undefined` for targets that are queries (All / Upcoming without a date) —
 * those are not drop containers.
 */
export function resolveTaskDrop(task: Task, target: TaskDropTarget, now: Date = new Date()): TaskMutationIntent | undefined {
  switch (target.kind) {
    case 'matrix-quadrant': {
      const q = target.quadrant
      return { matrixId: target.matrixId, important: q === 1 || q === 2, urgent: q === 1 || q === 3 }
    }
    case 'matrix':
      return { matrixId: target.matrixId }
    case 'inbox':
      return { matrixId: null }
    case 'today':
      return { scheduledAt: todayIso(now) }
    case 'completed':
      return { status: 'completed' }
    default:
      return undefined
  }
}

/** Same-quadrant reorder only changes manual order — never matrix/important/urgent. */
export function isReorderOnly(source: { matrixId: TaskMatrixId | null; important: boolean; urgent: boolean }, target: TaskDropTarget): boolean {
  if (target.kind !== 'matrix-quadrant') return false
  return source.matrixId === target.matrixId
    && source.important === (target.quadrant === 1 || target.quadrant === 2)
    && source.urgent === (target.quadrant === 1 || target.quadrant === 3)
}

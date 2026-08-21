/**
 * Pure task-view helper. `quadrantOf` encodes the derived Eisenhower quadrant
 * (never stored); the cross-matrix aggregate views (Inbox / Today / Upcoming /
 * Completed / All) are computed client-side in the Tasks UI.
 * @module @deepseek-ai/dsh-pkw-domain/tasks-view
 */

export type TaskQuadrant = 1 | 2 | 3 | 4

/** Eisenhower quadrant DERIVED from `important × urgent` (Q1 = both, Q4 = neither). */
export function quadrantOf(task: { important: boolean; urgent: boolean }): TaskQuadrant {
  return task.important ? (task.urgent ? 1 : 2) : (task.urgent ? 3 : 4)
}

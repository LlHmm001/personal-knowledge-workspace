/**
 * Subtask completion draft — pure, DOM-free helpers for the "checkbox is local
 * interaction state, persistence belongs to Save" model. Store baseline + local
 * draft = current Detail projection; Save persists only the differences.
 * @module @deepseek-ai/dsh-pkw-domain/subtask-draft
 */

export type CompletionDraft = Record<string, boolean> // taskId → completed

/** Build the baseline completion map from the Store's current subtask list. */
export function baselineFromSubtasks(subtasks: Array<{ taskId: string; status: string }>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const s of subtasks) out[s.taskId] = s.status === 'completed'
  return out
}

/** The currently-visible completion state = draft override, else baseline. */
export function projectionOf(baseline: Record<string, boolean>, draft: CompletionDraft, taskId: string): boolean {
  return taskId in draft ? draft[taskId]! : (baseline[taskId] ?? false)
}

/** Toggle a checkbox locally (never touches the Store). */
export function applyCompletionToggle(draft: CompletionDraft, taskId: string, baselineCompleted: boolean): CompletionDraft {
  const current = taskId in draft ? draft[taskId]! : baselineCompleted
  return { ...draft, [taskId]: !current }
}

/** Remove a task's pending entry (used when a child is deleted). */
export function removeCompletionDraft(draft: CompletionDraft, taskId: string): CompletionDraft {
  const next = { ...draft }
  delete next[taskId]
  return next
}

/** The list of {taskId, completed} that actually differ from the baseline. */
export function deriveCompletionChanges(baseline: Record<string, boolean>, draft: CompletionDraft): Array<{ taskId: string; completed: boolean }> {
  const out: Array<{ taskId: string; completed: boolean }> = []
  for (const id of Object.keys(draft)) {
    if (baseline[id] !== draft[id]) out.push({ taskId: id, completed: draft[id]! })
  }
  return out
}

/** True when any completion draft entry differs from its baseline. */
export function isCompletionDirty(baseline: Record<string, boolean>, draft: CompletionDraft): boolean {
  return deriveCompletionChanges(baseline, draft).length > 0
}

/** Completed count using the merged projection (baseline + draft). */
export function completedCount(baseline: Record<string, boolean>, draft: CompletionDraft, taskIds: string[]): number {
  let n = 0
  for (const id of taskIds) if (projectionOf(baseline, draft, id)) n++
  return n
}

/**
 * Pure Trash-Manager helpers: stable identity, selection derivation, selection
 * reconciliation across background revalidate, and batch-result summarization.
 * These are DOM-free so the browser and the Host orchestration share one rule
 * set. No canonical mutation lives here — restore/purge stay in the services.
 * @module @deepseek-ai/dsh-pkw-domain/trash
 */

export type TrashItemKind = 'note' | 'folder' | 'attachment'

/** Stable selection identity — NEVER a path/filename/array index. */
export function trashItemKey(kind: TrashItemKind, id: string): string {
  return `${kind}:${id}`
}

export function parseTrashItemKey(key: string): { kind: TrashItemKind; id: string } | undefined {
  const i = key.indexOf(':')
  if (i <= 0) return undefined
  const kind = key.slice(0, i)
  if (kind !== 'note' && kind !== 'folder' && kind !== 'attachment') return undefined
  return { kind, id: key.slice(i + 1) }
}

export type SelectAllState = 'none' | 'partial' | 'all'

/**
 * Derive the Select-All checkbox state from the selected set vs the currently
 * visible keys — never a separately-maintained sticky flag.
 */
export function deriveSelectAll(selected: Iterable<string>, visible: string[]): SelectAllState {
  if (visible.length === 0) return 'none'
  const set = selected instanceof Set ? selected : new Set(selected)
  let hit = 0
  for (const k of visible) if (set.has(k)) hit++
  if (hit === 0) return 'none'
  if (hit === visible.length) return 'all'
  return 'partial'
}

/** Keep only selected keys that still exist in the fresh projection. */
export function reconcileSelection(selected: Iterable<string>, fresh: string[]): string[] {
  const set = new Set(fresh)
  const out: string[] = []
  for (const k of selected) if (set.has(k)) out.push(k)
  return out
}

export interface BatchResult {
  ok: string[]
  failed: Array<{ key: string; error: string }>
}

/**
 * Summarize per-item allSettled results into success/failure buckets. A single
 * failure never masks the items that already succeeded.
 */
export function summarizeBatch(results: Array<{ key: string; ok: boolean; error?: string }>): BatchResult {
  const ok: string[] = []
  const failed: Array<{ key: string; error: string }> = []
  for (const r of results) {
    if (r.ok) ok.push(r.key)
    else failed.push({ key: r.key, error: r.error ?? 'unknown error' })
  }
  return { ok, failed }
}

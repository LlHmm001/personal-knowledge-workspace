/**
 * Pure Trash-Manager helpers: stable identity parsing and batch-result
 * summarization. DOM-free so the browser and the Host orchestration share one
 * rule set. Selection derivation/reconciliation live client-side in the Trash
 * UI. No canonical mutation lives here — restore/purge stay in the services.
 * @module @deepseek-ai/dsh-pkw-domain/trash
 */

export type TrashItemKind = 'note' | 'folder' | 'attachment'

export function parseTrashItemKey(key: string): { kind: TrashItemKind; id: string } | undefined {
  const i = key.indexOf(':')
  if (i <= 0) return undefined
  const kind = key.slice(0, i)
  if (kind !== 'note' && kind !== 'folder' && kind !== 'attachment') return undefined
  return { kind, id: key.slice(i + 1) }
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

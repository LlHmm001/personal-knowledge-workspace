/**
 * TextQuoteAnchor resolution — a pure, runtime-free function that re-locates a
 * captured selection (`TaskSourceRef` with `kind: 'selection'`) inside the
 * current note body. The `exact` text and its `prefix`/`suffix` context are the
 * source of truth; `start`/`end` are offset HINTS that only ever disambiguate
 * among already-exact matches (never trusted blindly), so a stale offset cannot
 * jump to a wrong position after the note was edited above the selection.
 * @module @deepseek-ai/dsh-pkw-domain/resolve
 */

import type { TaskSourceRef } from './types.ts'

export type ResolveTextQuoteResult =
  | { status: 'resolved'; start: number; end: number }
  | { status: 'source-changed' }

export function resolveTextQuoteAnchor(body: string, anchor: TaskSourceRef): ResolveTextQuoteResult {
  if (anchor.kind !== 'selection') return { status: 'source-changed' }
  const exact = anchor.exact
  if (exact === undefined || exact === '') return { status: 'source-changed' }

  // Locate every occurrence of the exact text.
  const matches: number[] = []
  let idx = body.indexOf(exact)
  while (idx !== -1) {
    matches.push(idx)
    idx = body.indexOf(exact, idx + 1)
  }
  if (matches.length === 0) return { status: 'source-changed' }

  // A single occurrence is unambiguous by definition.
  if (matches.length === 1) {
    return { status: 'resolved', start: matches[0]!, end: matches[0]! + exact.length }
  }

  // Multiple occurrences: the surrounding context disambiguates.
  const prefix = anchor.prefix ?? ''
  const suffix = anchor.suffix ?? ''
  const candidates = matches.filter((start) => {
    const end = start + exact.length
    if (prefix !== '' && body.slice(Math.max(0, start - prefix.length), start) !== prefix) return false
    if (suffix !== '' && body.slice(end, end + suffix.length) !== suffix) return false
    return true
  })
  if (candidates.length === 1) {
    return { status: 'resolved', start: candidates[0]!, end: candidates[0]! + exact.length }
  }

  // Still ambiguous: the offset hint may break the tie, but only onto an
  // already-exact candidate (never a blind trust of a stale offset).
  if (anchor.start !== undefined && candidates.includes(anchor.start)) {
    return { status: 'resolved', start: anchor.start, end: anchor.start + exact.length }
  }

  // Context mismatch (0 candidates) or irreducible ambiguity: refuse to guess.
  return { status: 'source-changed' }
}

/**
 * Outcome certainty model for the WeKnora sync engine.
 *
 * Two independent dimensions:
 *  - `category`: what KIND of failure (permanent / retryable / unknown).
 *  - `certainty`: whether the REMOTE mutation outcome is known.
 *
 * A mutation (create / update / upload) that hits a 5xx, a timeout, or a
 * connection reset may already have applied remotely, so it must go through
 * recovery — never a blind retry. Reads have no remote side effect and are
 * safe to retry. This module is pure (no IO) so tests can cover every branch.
 *
 * @module @deepseek-ai/dsh-pkw-weknora-sync/src/outcome
 */

import { WeKnoraError } from '@deepseek-ai/dsh-pkw-weknora'

/** Failure category: is it safe to retry, a known dead end, or ambiguous? */
export type ErrorCategory = 'permanent' | 'retryable' | 'unknown'

/** Whether the remote mutation outcome is determinable from the response. */
export type OutcomeCertainty = 'known' | 'unknown'

export interface Outcome {
  category: ErrorCategory
  certainty: OutcomeCertainty
}

const PERMANENT_KINDS = new Set(['auth', 'forbidden', 'validation', 'not_found', 'conflict', 'parse_failed', 'cancelled'])
const RETRYABLE_KINDS = new Set(['rate_limit'])

/**
 * Classify a thrown remote error into an {@link Outcome}.
 *
 * @param error - the error from the adapter.
 * @param mutation - whether the operation that threw is a remote mutation
 *   (create/update/upload/delete). Reads pass `false`.
 */
export function classifyOutcome(error: unknown, opts: { mutation: boolean }): Outcome {
  if (error instanceof WeKnoraError) {
    // A structured HTTP response is a KNOWN remote outcome. Only ambiguity is
    // 5xx/`temporary` on a mutation (the request may have been applied before
    // the error was produced).
    if (PERMANENT_KINDS.has(error.kind)) return { category: 'permanent', certainty: 'known' }
    if (RETRYABLE_KINDS.has(error.kind)) return { category: 'retryable', certainty: 'known' }
    // server (5xx) / temporary (timeout-ish structured status)
    if (opts.mutation) return { category: 'unknown', certainty: 'unknown' }
    return { category: 'retryable', certainty: 'known' }
  }
  // Network-level failure (fetch rejected before a structured response):
  // mutations are ambiguous, reads are safely retryable.
  if (opts.mutation) return { category: 'unknown', certainty: 'unknown' }
  return { category: 'retryable', certainty: 'known' }
}

/** A terminal state for a permanent failure: never auto-retried. */
export const PERMANENT = 'permanent' as const
/** A known retryable failure: retried with backoff. */
export const RETRYABLE = 'retryable' as const
/** An ambiguous mutation outcome: requires recovery, not blind retry. */
export const UNKNOWN = 'unknown' as const

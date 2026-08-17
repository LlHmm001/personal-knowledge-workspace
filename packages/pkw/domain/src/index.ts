/**
 * PKW domain foundation package (runtime-free): re-exports the type vocabulary
 * and the `pkw` domain spec, and declares the `ctx.pkwEvents` service plus the
 * `pkw/event.committed` signal through Cordis declaration merging.
 * @module @deepseek-ai/dsh-pkw-domain
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PkwEventCommitted, PkwEventStore } from './types.ts'

export * from './types.ts'
export { parseNoteId } from './frontmatter.ts'
export { attachmentDomainSpec, noteDomainSpec, operationCommitRecord, pkwDomainSpec, taskDomainSpec } from './spec.ts'
export type { OperationCommitRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pkwEvents: PkwEventStore
  }

  interface Events {
    /** Post-commit, in-process live signal (never the audit log). @mode emit */
    'pkw/event.committed'(signal: PkwEventCommitted): void
  }
}

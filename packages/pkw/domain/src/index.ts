/**
 * PKW domain foundation package (runtime-free): re-exports the type vocabulary
 * and the `pkw` domain spec, and declares the `ctx.pkwEvents` service plus the
 * `pkw/event.committed` signal through Cordis declaration merging.
 * @module @deepseek-ai/dsh-pkw-domain
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PkwEventCommitted, PkwEventStore } from './types.ts'

export * from './types.ts'
export { resolveTextQuoteAnchor } from './resolve.ts'
export type { ResolveTextQuoteResult } from './resolve.ts'
export { filterTasksForView, quadrantOf } from './tasks-view.ts'
export type { TaskQuadrant, TaskView } from './tasks-view.ts'
export { CALLOUT_TYPES, CODE_LANGUAGES, buildSelectionSourceRef, calloutMarkdown, codeBlockMarkdown, inlineCodeMarkdown, selectionTaskTitle, tableMarkdown, wikiLinkMarkdown, wrapMarkdown } from './editor-commands.ts'
export type { CalloutType } from './editor-commands.ts'
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

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
export { CALLOUT_TYPES, CODE_LANGUAGES, buildSelectionSourceRef, calloutMarkdown, codeBlockMarkdown, inlineCodeMarkdown, noteTaskDescriptionPreview, selectionTaskTitle, stripFrontmatter, tableMarkdown, wikiLinkMarkdown, wrapMarkdown } from './editor-commands.ts'
export type { CalloutType } from './editor-commands.ts'
export { isReorderOnly, resolveTaskDrop } from './tasks-drag.ts'
export type { TaskDropTarget, TaskMutationIntent } from './tasks-drag.ts'
export { parseAttachmentReference, parseCalloutBlock, parseWikiLink, serializeCalloutBlock } from './markdown-semantics.ts'
export type { AttachmentRef, CalloutBlock, WikiLink } from './markdown-semantics.ts'
export { escapeHtml, protectWikiLinks, restoreWikiLinks, rewriteAttachmentUrls } from './lute-pipeline.ts'
export type { WikiLinkToken } from './lute-pipeline.ts'
export { appendFootnoteDefinition, countFootnoteReferences, deleteFootnote, editFootnoteDefinition, footnoteKeys, listFootnoteDefinitions, nextFootnoteKey, removeFootnoteDefinition } from './footnote.ts'
export type { FootnoteDef } from './footnote.ts'
export { addColumnLeft, addColumnRight, addRowAbove, addRowBelow, deleteColumn, deleteRow, deleteTable, findTableBlock, findTableBlockByIndex, listTableBlocks, parseTableBlock, resolveTableCell, serializeTableBlock, setColumnAlign } from './table.ts'
export type { ColumnAlign, TableBlock } from './table.ts'
export { applyCompletionToggle, baselineFromSubtasks, completedCount, deriveCompletionChanges, deriveSubtaskSeed, isCompletionDirty, projectionOf, removeCompletionDraft } from './subtask-draft.ts'
export type { CompletionDraft, SubtaskSeedItem, SubtaskSeedSource } from './subtask-draft.ts'
export { deriveSelectAll, parseTrashItemKey, reconcileSelection, summarizeBatch, trashItemKey } from './trash.ts'
export type { BatchResult, SelectAllState, TrashItemKind } from './trash.ts'
export { companionUserContent, extractAttachmentSummary, hasCompanionUserContent, insertAttachmentSummary } from './companion-summary.ts'
export { companionNoteMarkdown, filenameStem, sanitizeNoteBase, uniqueNotePath } from './direct-upload.ts'
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

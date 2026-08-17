/**
 * Companion-note attachment-summary materialization. A Companion Note (created
 * by Direct Upload) owns a managed, replace-in-place summary block in its
 * canonical Markdown. The block is stable/idempotent so repeated writes never
 * append a second copy and a same-summary write is a no-op.
 *
 * Canonical block:
 *   <!-- pkw:attachment-summary:start <attachmentId> -->
 *   ## 附件解析摘要
 *
 *   <summary text>
 *   <!-- pkw:attachment-summary:end -->
 * @module @deepseek-ai/dsh-pkw-domain/companion-summary
 */

const SUMMARY_HEADING = '## 附件解析摘要'
const END_MARKER = '<!-- pkw:attachment-summary:end -->'

function startMarker(attachmentId: string): string {
  return `<!-- pkw:attachment-summary:start ${attachmentId} -->`
}

/**
 * Upsert the managed summary block for `attachmentId` into `markdown`.
 * Replaces an existing block in place; appends a new block at the end.
 */
export function insertAttachmentSummary(markdown: string, attachmentId: string, summary: string): string {
  const start = startMarker(attachmentId)
  const block = `${start}\n${SUMMARY_HEADING}\n\n${summary.trim()}\n${END_MARKER}`
  const startIdx = markdown.indexOf(start)
  if (startIdx >= 0) {
    const endIdx = markdown.indexOf(END_MARKER, startIdx + start.length)
    if (endIdx >= 0) {
      return markdown.slice(0, startIdx) + block + markdown.slice(endIdx + END_MARKER.length)
    }
  }
  return markdown.replace(/\n+$/, '') + '\n\n' + block + '\n'
}

/** Extract the current summary text for `attachmentId` (undefined if no block). */
export function extractAttachmentSummary(markdown: string, attachmentId: string): string | undefined {
  const start = startMarker(attachmentId)
  const startIdx = markdown.indexOf(start)
  if (startIdx < 0) return undefined
  const contentStart = startIdx + start.length
  const endIdx = markdown.indexOf(END_MARKER, contentStart)
  if (endIdx < 0) return undefined
  const body = markdown.slice(contentStart, endIdx).trim()
  // Strip the stable heading line, leaving only the summary text.
  const withoutHeading = body.startsWith(SUMMARY_HEADING) ? body.slice(SUMMARY_HEADING.length) : body
  return withoutHeading.trim() || undefined
}

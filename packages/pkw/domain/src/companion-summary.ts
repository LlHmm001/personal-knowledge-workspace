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

// ── Managed vs user-authored content (attachment-backed Companion Note) ──────
//
// A Companion Note created by Direct Upload has a deterministic managed region:
//   - frontmatter
//   - the `# <title>` heading
//   - the managed attachment reference (`attachments/<id>/<file>` image/link)
//   - the managed summary block
// Everything outside that region is user-authored. `companionUserContent` is the
// single source of truth for "does this Companion Note carry real original text"
// — never a naive `body.length > 0`, which would count the managed region as
// user content and wrongly re-create a duplicate remote Knowledge.

const SUMMARY_BLOCK_RE = /<!-- pkw:attachment-summary:start[\s\S]*?<!-- pkw:attachment-summary:end -->\s*/g
const MANAGED_IMAGE_RE = /!\[[^\]]*\]\([^)\s]*attachments\/[^)\s]*\)/g
const MANAGED_LINK_RE = /\[[^\]]*\]\([^)\s]*attachments\/[^)\s]*\)/g

/**
 * Return the user-authored Markdown of a Companion Note: the note minus its
 * frontmatter, title heading, managed attachment reference(s), and managed
 * summary block(s). Empty string means the note is purely attachment-backed.
 */
export function companionUserContent(markdown: string): string {
  let md = String(markdown)
  // Frontmatter block.
  md = md.replace(/^---\n[\s\S]*?\n---\s*/, '')
  // Managed summary block(s) (with their trailing blank lines).
  md = md.replace(SUMMARY_BLOCK_RE, '')
  // Managed attachment reference(s) (image and file link forms).
  md = md.replace(MANAGED_IMAGE_RE, '')
  md = md.replace(MANAGED_LINK_RE, '')
  // Title heading (first H1 line).
  md = md.replace(/^#[ \t].*$/m, '')
  // Collapse leftover blank runs.
  return md.replace(/\n{3,}/g, '\n\n').trim()
}

/** True when the Companion Note carries real user-authored content beyond the managed region. */
export function hasCompanionUserContent(markdown: string): boolean {
  return companionUserContent(markdown).length > 0
}

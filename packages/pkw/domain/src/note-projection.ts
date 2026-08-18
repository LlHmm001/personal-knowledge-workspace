/**
 * Note-scoped Attachment remote projection enrichment.
 *
 * A Normal Note's canonical Markdown stays canonical (never has parsed text
 * written back into it). Its remote WeKnora projection is the canonical text
 * PLUS the derived (parser) content of its note-scoped attachments, injected
 * under a bounded budget so a 100MB PDF never becomes a 100MB manual Note.
 *
 * @module @deepseek-ai/dsh-pkw-domain/note-projection
 */

export interface NoteScopedDerived {
  /** Stable AttachmentId (display/label only; the note's canonical ref already carries it). */
  attachmentId: string
  filename: string
  /** Bounded summary/description from the parser (WeKnora `description`). */
  summary?: string
  /** Optional top relevant text segments (WeKnora chunks). */
  chunks?: string[]
}

export interface NoteProjectionBudget {
  /** Max chars per attachment summary (default 2000). */
  maxSummaryChars?: number
  /** Max chars per attachment chunk text (default 4000). */
  maxChunkChars?: number
  /** Max total enrichment chars across all attachments (default 12000). */
  maxTotalChars?: number
}

/**
 * Strip PKW-owned internal frontmatter keys from the canonical Markdown for the
 * remote projection. `id` (and any `pkw:*` internal key) must never enter WeKnora
 * embedding/summary/Wiki/Graph; user fields (title/tags/custom YAML) are kept.
 * Canonical Markdown is unchanged — this is projection-only.
 */
export function stripInternalFrontmatter(markdown: string): string {
  const out = String(markdown).replace(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/, (block) => {
    const inner = block
      .replace(/^---[ \t]*\r?\n/, '')
      .replace(/\r?\n---[ \t]*\r?\n?$/, '')
    const lines = inner.split('\n').filter(line => {
      const t = line.trim()
      if (t === '') return false
      if (/^id:[ \t]*\S/.test(t)) return false
      if (/^pkw[:_-]/.test(t)) return false
      return true
    })
    if (lines.length === 0) return ''
    return '---\n' + lines.join('\n') + '\n---\n'
  })
  // A fully-dropped frontmatter leaves a leading blank line; trim one newline.
  return out.replace(/^\r?\n/, '')
}

const DEFAULT_MAX_SUMMARY = 2000
const DEFAULT_MAX_CHUNK = 4000
const DEFAULT_MAX_TOTAL = 12000

function clamp(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/**
 * Build the remote Note payload: the already-normalized canonical Markdown
 * (managed image refs already rewritten to `图片附件：<file>` etc.) plus a
 * bounded "附件解析摘要" section per note-scoped attachment.
 */
export function enrichNoteForKnowledge(normalizedMarkdown: string, derived: NoteScopedDerived[], opts: NoteProjectionBudget = {}): string {
  const maxSummary = opts.maxSummaryChars ?? DEFAULT_MAX_SUMMARY
  const maxChunk = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK
  const maxTotal = opts.maxTotalChars ?? DEFAULT_MAX_TOTAL
  const body = String(normalizedMarkdown)
  if (derived.length === 0) return body

  const blocks: string[] = []
  let used = 0
  for (const d of derived) {
    if (used >= maxTotal) break
    const parts: string[] = []
    if (d.summary !== undefined && d.summary.trim() !== '') {
      parts.push(clamp(d.summary.trim(), maxSummary))
    }
    if (d.chunks !== undefined) {
      for (const c of d.chunks) {
        if (c === undefined || c.trim() === '') continue
        parts.push(clamp(c.trim(), maxChunk))
      }
    }
    if (parts.length === 0) continue
    const block = `## 附件解析摘要（${d.filename}）\n\n${parts.join('\n\n')}`
    const blockLen = block.length
    if (used + blockLen > maxTotal) {
      // Fit a truncated tail so the note still carries a hint of this attachment.
      const remaining = maxTotal - used
      if (remaining <= 40) break
      blocks.push(clamp(block, remaining))
      used = maxTotal
      break
    }
    blocks.push(block)
    used += blockLen
  }
  if (blocks.length === 0) return body
  return body.replace(/\n+$/, '') + '\n\n' + blocks.join('\n\n') + '\n'
}

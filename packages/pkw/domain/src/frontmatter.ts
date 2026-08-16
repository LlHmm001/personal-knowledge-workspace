/**
 * Pure Markdown identity contract, shared by Local Note discovery and
 * WeKnora remote recovery so both sides parse `id` with EXACTLY one rule.
 * This package must stay runtime-free (no service implementation dependency).
 */

/** Extract the PKW NoteId from a leading `---` frontmatter block. */
export function parseNoteId(markdown: string): string | undefined {
  const normalized = markdown.replace(/^\uFEFF/, '') // strip UTF-8 BOM
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(normalized)
  if (m === null) return undefined
  const v = /^id:\s*([^\r\n]+)$/m.exec(m[1]!)?.[1]?.trim()
  if (v === undefined || v === '') return undefined
  return v.replace(/^["']|["']$/g, '')
}

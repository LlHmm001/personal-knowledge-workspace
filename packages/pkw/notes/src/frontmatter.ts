/**
 * Minimal, portable YAML-ish frontmatter for PKW Notes.
 * System-required field: `id`. User fields: `title`, `tags`, `created_at`.
 * No projection metadata (contentHash/observedRevision/…) is ever written back.
 */

import { parseNoteId } from '@deepseek-ai/dsh-pkw-domain'

export interface NoteFrontmatter {
  hasFrontmatter: boolean
  id?: string
  title?: string
  tags?: string[]
}

/** Strip one pair of matching surrounding quotes when present. */
function stripQuotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/** Split a leading `---` YAML block from the body; the raw block is preserved verbatim. */
export function splitFrontmatter(markdown: string): { frontmatterRaw: string; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(normalized)
  if (match === null) return { frontmatterRaw: '', body: markdown }
  return { frontmatterRaw: match[0].replace(/\r?\n$/, ''), body: markdown.slice(match[0].length) }
}

/** Extract `id`/`title`/`tags` from a leading `---` block, leaving the body untouched. */
export function parseFrontmatter(markdown: string): { frontmatter: NoteFrontmatter; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '') // strip a UTF-8 BOM
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(normalized)
  if (match === null) return { frontmatter: { hasFrontmatter: false }, body: markdown }

  const raw = match[1]!
  const id = parseNoteId(markdown) // shared identity contract (single parser)
  const title = stripQuotes(/^title:\s*([^\r\n]+)$/m.exec(raw)?.[1]?.trim())
  const tags = parseTags(raw)
  return { frontmatter: { hasFrontmatter: true, id, title, tags }, body: markdown.slice(match[0].length) }
}

function parseTags(raw: string): string[] | undefined {
  // Block list form: `tags:\n  - a\n  - b`
  const block = /^tags:[ \t]*\r?\n((?:[ \t]+-\s*[^\r\n]*\r?\n?)+)/m.exec(raw)
  if (block !== null) {
    const tags = block[1]!
      .split('\n')
      .map(line => /^\s*-\s*([^\r\n]*)\s*$/.exec(line)?.[1]?.trim())
      .filter((tag): tag is string => tag !== undefined && tag !== '')
    return tags.length > 0 ? tags : undefined
  }
  // Flow form: `tags: [a, b]`
  const flow = /^tags:\s*\[([^\]]*)\]$/m.exec(raw)
  if (flow !== null) {
    const tags = flow[1]!
      .split(',')
      .map(tag => tag.trim().replace(/^['"]|['"]$/g, ''))
      .filter(tag => tag !== '')
    return tags.length > 0 ? tags : undefined
  }
  return undefined
}

/** Inject a `id: …` line into the frontmatter (creating one when absent). Minimal targeted edit. */
export function injectNoteId(markdown: string, noteId: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(markdown)
  if (match === null) {
    // No frontmatter: prepend a fresh block, preserving the body verbatim.
    return `---\nid: ${noteId}\n---\n\n${markdown}`
  }
  const block = match[0]
  if (/^id:\s*[^\r\n]+$/m.test(block)) {
    // id already present: leave untouched (identity is authoritative from the file).
    return markdown
  }
  // Insert `id:` right after the opening `---` line.
  const opening = /^---[ \t]*\r?\n/.exec(block)!
  const inserted = `${opening[0]}id: ${noteId}\n`
  return markdown.slice(0, match.index + opening[0].length) + inserted + markdown.slice(match.index + opening[0].length)
}

/** Replace (or insert) the `id:` line with `noteId` — used when minting a real identity over a placeholder. */
export function replaceNoteId(markdown: string, noteId: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(markdown)
  if (match === null) return `---\nid: ${noteId}\n---\n\n${markdown}`
  const block = match[0]
  if (/^id:\s*[^\r\n]+$/m.test(block)) {
    const replaced = block.replace(/^id:\s*[^\r\n]+$/m, `id: ${noteId}`)
    return markdown.slice(0, match.index) + replaced + markdown.slice(match.index + block.length)
  }
  return injectNoteId(markdown, noteId)
}

/** Derive a display title: frontmatter.title → first H1 → filename. */
export function deriveTitle(markdown: string, frontmatterTitle: string | undefined, filename: string): string {
  if (frontmatterTitle !== undefined && frontmatterTitle !== '') return frontmatterTitle
  const h1 = /^#\s+([^\r\n]+)\s*$/m.exec(markdown)?.[1]?.trim()
  if (h1 !== undefined && h1 !== '') return h1
  return filename.replace(/\.md$/i, '')
}

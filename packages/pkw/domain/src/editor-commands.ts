/**
 * Pure Markdown editor command vocabulary. Toolbar, Slash, Selection floating
 * toolbar, and Context Menus all derive from these transforms — no UI surface
 * re-implements a snippet. Markdown stays the canonical source of truth.
 * @module @deepseek-ai/dsh-pkw-domain/editor-commands
 */

/** Canonical Obsidian/GitHub-style callout types (admonition boxes). */
export const CALLOUT_TYPES = ['NOTE', 'TIP', 'INFO', 'IMPORTANT', 'WARNING', 'QUESTION', 'EXAMPLE', 'SUCCESS', 'DANGER'] as const
export type CalloutType = (typeof CALLOUT_TYPES)[number]

/** Fenced code-block languages offered by the insert/change-language UI. */
export const CODE_LANGUAGES = ['text', 'javascript', 'typescript', 'python', 'json', 'bash', 'markdown', 'html', 'css', 'sql'] as const

/** Wrap `text` with `before`/`after` (bold/italic/strike/highlight/inline-code). */
export function wrapMarkdown(text: string, before: string, after: string): string {
  return `${before}${text}${after}`
}

/** Inline-code wrap uses a single backtick. */
export function inlineCodeMarkdown(text: string): string {
  return wrapMarkdown(text, '`', '`')
}

/** Canonical callout block: `> [!TYPE]\n> body…`. Multi-line body → one `> ` per line. */
export function calloutMarkdown(type: CalloutType, body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  return `> [!${type}]\n${lines.map(line => `> ${line}`).join('\n')}`
}

/** GFM table: header + separator + `rows` data rows × `cols` columns. */
export function tableMarkdown(rows: number, cols: number): string {
  const r = Math.max(1, Math.min(rows, 20))
  const c = Math.max(1, Math.min(cols, 10))
  const cells = (fill: string) => Array.from({ length: c }, () => fill).join(' | ')
  const header = `| ${cells('  ')} |`
  const sep = `| ${cells('---')} |`
  const row = `| ${cells('  ')} |`
  return [header, sep, ...Array.from({ length: r }, () => row)].join('\n')
}

/** Fenced code block with optional language. */
export function codeBlockMarkdown(lang: string = ''): string {
  return `\`\`\`${lang}\n\n\`\`\``
}

/** Wiki link: `[[title]]` or `[[title|alias]]`. */
export function wikiLinkMarkdown(title: string, alias?: string): string {
  return alias && alias.length > 0 ? `[[${title}|${alias}]]` : `[[${title}]]`
}

/** A Selection→Task SourceRef carrying full recovery context (TextQuoteAnchor). */
export function buildSelectionSourceRef(input: {
  noteId: string
  exact: string
  prefix?: string
  suffix?: string
  start?: number
  end?: number
  noteRevision?: number
  contentHash?: string
}): import('./types.ts').TaskSourceRef {
  return {
    kind: 'selection',
    noteId: input.noteId,
    exact: input.exact,
    ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
    ...(input.suffix !== undefined ? { suffix: input.suffix } : {}),
    ...(input.start !== undefined ? { start: input.start } : {}),
    ...(input.end !== undefined ? { end: input.end } : {}),
    ...(input.noteRevision !== undefined ? { noteRevision: input.noteRevision } : {}),
    ...(input.contentHash !== undefined ? { contentHash: input.contentHash } : {}),
  }
}

/** Default Quick-Task title from a selection (first line, truncated). */
export function selectionTaskTitle(selection: string, max = 60): string {
  const first = selection.replace(/\r\n/g, '\n').split('\n').map(s => s.trim()).find(s => s.length > 0) ?? ''
  return first.length > max ? `${first.slice(0, max)}…` : first
}

/** Strip a leading YAML frontmatter block (`---\n…\n---`). */
export function stripFrontmatter(markdown: string): string {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(markdown)
  return m ? markdown.slice(m[0].length) : markdown
}

/**
 * Whole-Note→Task initial description preview: skip frontmatter, take the first
 * meaningful paragraph(s) up to `maxLen`. Never an empty description for a
 * non-empty note, but never a 20k-word dump either.
 */
export function noteTaskDescriptionPreview(markdown: string, maxLen = 500): string {
  const body = stripFrontmatter(markdown)
  const paragraphs = body
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0 && !/^#{1,6}\s/.test(p))
  if (paragraphs.length === 0) return ''
  let out = ''
  for (const p of paragraphs) {
    const candidate = out === '' ? p : `${out}\n\n${p}`
    if (candidate.length > maxLen) break
    out = candidate
  }
  return out || paragraphs[0]!.slice(0, maxLen)
}

/**
 * Pure footnote (GFM `[^key]` reference + `[^key]:` definition) helpers.
 * Markdown stays canonical — no hidden JSON. Keys are reference identities
 * (numeric by default) and are never re-numbered on delete.
 *
 * MVP scope: one reference per key (insert always mints a fresh unique key);
 * "delete footnote" removes every reference with that key plus its definition.
 * @module @deepseek-ai/dsh-pkw-domain/footnote
 */

export interface FootnoteDef { key: string; content: string; line: number; endLine: number }

const DEF_RE = /^\[\^([^\]]+)\]:\s?(.*)$/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Reference `[^key]` that is NOT a definition (`[^key]:`). */
function refPattern(key: string): RegExp {
  return new RegExp('\\[\\^' + escapeRegExp(key) + '\\](?!:)', 'g')
}

/** List every `[^key]:` definition (with indented continuation lines). */
export function listFootnoteDefinitions(lines: string[]): FootnoteDef[] {
  const out: FootnoteDef[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = DEF_RE.exec(lines[i]!)
    if (m) {
      const contentParts = [m[2]!]
      let end = i
      while (end + 1 < lines.length && /^( {4}|\t)/.test(lines[end + 1]!)) {
        end++
        contentParts.push(lines[end]!.replace(/^( {4}|\t)/, ''))
      }
      out.push({ key: m[1]!, content: contentParts.join('\n'), line: i, endLine: end })
      i = end
    }
  }
  return out
}

/** Every footnote key in use (references + definitions). */
export function footnoteKeys(markdown: string): Set<string> {
  const keys = new Set<string>()
  const re = /\[\^([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown)) !== null) keys.add(m[1]!)
  return keys
}

/** Next free numeric key (smallest positive integer not already in use). */
export function nextFootnoteKey(markdown: string): string {
  const keys = footnoteKeys(markdown)
  let n = 1
  while (keys.has(String(n))) n++
  return String(n)
}

/** Append a definition to the end of the markdown (canonical position). */
export function appendFootnoteDefinition(markdown: string, key: string, content: string): string {
  const def = `[^${key}]: ${content}`
  if (markdown.trim() === '') return def + '\n'
  return markdown.replace(/\n+$/, '') + '\n\n' + def + '\n'
}

/** Replace a definition's content (undefined if the key has no definition). */
export function editFootnoteDefinition(lines: string[], key: string, content: string): string[] | undefined {
  const d = listFootnoteDefinitions(lines).find(x => x.key === key)
  if (d === undefined) return undefined
  const next = lines.slice()
  next.splice(d.line, d.endLine - d.line + 1, `[^${key}]: ${content}`)
  return next
}

/** Remove a definition block (undefined if absent). */
export function removeFootnoteDefinition(lines: string[], key: string): string[] | undefined {
  const d = listFootnoteDefinitions(lines).find(x => x.key === key)
  if (d === undefined) return undefined
  return [...lines.slice(0, d.line), ...lines.slice(d.endLine + 1)]
}

/** Count inline references to a key (definitions excluded). */
export function countFootnoteReferences(markdown: string, key: string): number {
  const m = markdown.match(refPattern(key))
  return m === null ? 0 : m.length
}

/**
 * Delete a whole footnote: remove every `[^key]` reference and the definition
 * block. Leaves surrounding text (no re-numbering).
 */
export function deleteFootnote(markdown: string, key: string): string {
  const lines = markdown.split('\n')
  const withoutDef = removeFootnoteDefinition(lines, key) ?? lines
  return withoutDef.join('\n').replace(refPattern(key), '')
}

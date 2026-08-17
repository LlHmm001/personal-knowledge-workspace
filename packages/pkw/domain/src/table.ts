/**
 * Pure GFM-table structural transforms. Markdown stays the canonical source of
 * truth: every operation parses the current table block, mutates its cell
 * model, and re-serializes canonical GFM — never a separate JSON table state.
 * @module @deepseek-ai/dsh-pkw-domain/table
 */

export type ColumnAlign = 'left' | 'center' | 'right' | null

export interface TableBlock {
  header: string[]
  aligns: ColumnAlign[]
  rows: string[][]
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map(c => c.trim())
}

function parseAlign(sep: string): ColumnAlign {
  const t = sep.trim()
  if (t.startsWith(':') && t.endsWith(':')) return 'center'
  if (t.endsWith(':')) return 'right'
  if (t.startsWith(':')) return 'left'
  return null
}

function serializeAlign(a: ColumnAlign): string {
  if (a === 'center') return ':---:'
  if (a === 'right') return '---:'
  if (a === 'left') return ':---'
  return '---'
}

/** Parse the table block starting at `lines[start]` (a header row). */
export function parseTableBlock(lines: string[]): TableBlock | undefined {
  if (lines.length < 2) return undefined
  const header = splitRow(lines[0]!)
  if (header.length === 0 || header.every(c => c === '')) return undefined
  const sepCells = splitRow(lines[1]!)
  const isSep = sepCells.length >= header.length && sepCells.every(c => /^:?-{1,}:?$/.test(c))
  if (!isSep) return undefined
  const aligns = header.map((_, i) => parseAlign(sepCells[i] ?? '---'))
  const rows: string[][] = []
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '' || !line.includes('|')) break
    rows.push(splitRow(line))
  }
  return { header, aligns, rows }
}

function serializeRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

export function serializeTableBlock(t: TableBlock): string[] {
  const out = [serializeRow(t.header), `| ${t.aligns.map(serializeAlign).join(' | ')} |`]
  for (const r of t.rows) out.push(serializeRow(r))
  return out
}

/** Locate the table block containing `cursorLine` (0-based). */
export function findTableBlock(lines: string[], cursorLine: number): { start: number; end: number } | undefined {
  const start = Math.max(0, Math.min(cursorLine, lines.length - 1))
  // walk up to find a header line (previous line is a separator)
  let h = start
  while (h >= 0) {
    const block = parseTableBlock(lines.slice(h))
    if (block !== undefined) {
      // last data-row index = header + separator + rows (1-based) → h + 1 + rows.length
      const end = h + 1 + block.rows.length
      if (cursorLine >= h && cursorLine <= end) return { start: h, end }
      return undefined
    }
    h--
  }
  return undefined
}

function withTable(lines: string[], cursorLine: number, fn: (t: TableBlock) => TableBlock): string[] | undefined {
  const loc = findTableBlock(lines, cursorLine)
  if (loc === undefined) return undefined
  const block = parseTableBlock(lines.slice(loc.start))!
  const next = fn(block)
  const serialized = serializeTableBlock(next)
  return [...lines.slice(0, loc.start), ...serialized, ...lines.slice(loc.end + 1)]
}

export function addRowAbove(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    const idx = Math.max(0, Math.min(cursorLine - 2, t.rows.length))
    t.rows.splice(idx, 0, t.header.map(() => ''))
    return t
  })
}

export function addRowBelow(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    const idx = Math.max(0, Math.min(cursorLine - 2 + 1, t.rows.length))
    t.rows.splice(idx, 0, t.header.map(() => ''))
    return t
  })
}

export function deleteRow(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    if (t.rows.length === 0) return t
    const idx = Math.max(0, Math.min(cursorLine - 2, t.rows.length - 1))
    t.rows.splice(idx, 1)
    return t
  })
}

export function addColumnRight(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    t.header.push('')
    t.aligns.push(null)
    for (const r of t.rows) r.push('')
    return t
  })
}

export function addColumnLeft(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    t.header.unshift('')
    t.aligns.unshift(null)
    for (const r of t.rows) r.unshift('')
    return t
  })
}

export function deleteColumn(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    if (t.header.length <= 1) return t
    t.header.pop()
    t.aligns.pop()
    for (const r of t.rows) r.pop()
    return t
  })
}

export function setColumnAlign(lines: string[], cursorLine: number, align: ColumnAlign): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    const i = t.aligns.length - 1
    if (i >= 0) t.aligns[i] = align
    return t
  })
}

export function deleteTable(lines: string[], cursorLine: number): string[] | undefined {
  const loc = findTableBlock(lines, cursorLine)
  if (loc === undefined) return undefined
  return [...lines.slice(0, loc.start), ...lines.slice(loc.end + 1)]
}

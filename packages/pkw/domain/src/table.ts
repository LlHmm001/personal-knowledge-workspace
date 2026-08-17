/**
 * Pure GFM-table structural transforms. Markdown stays the canonical source of
 * truth: every operation parses the current table block, mutates its cell
 * model, and re-serializes canonical GFM — never a separate JSON table state.
 *
 * Row operations are row-aware via `cursorLine` (the canonical markdown line of
 * the current cell). Column operations are column-aware via an explicit
 * `columnIndex` (0-based). `findTableBlockByIndex` maps a DOM table's structural
 * index (k-th top-level table) back to its canonical line range, so a rendered
 * cell can be located without depending on its text content.
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
  let h = start
  while (h >= 0) {
    const block = parseTableBlock(lines.slice(h))
    if (block !== undefined) {
      const end = h + 1 + block.rows.length
      if (cursorLine >= h && cursorLine <= end) return { start: h, end }
      return undefined
    }
    h--
  }
  return undefined
}

/** List every top-level table block (header line → last data-row line). */
export function listTableBlocks(lines: string[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < lines.length) {
    const block = parseTableBlock(lines.slice(i))
    if (block !== undefined) {
      const end = i + 1 + block.rows.length
      out.push({ start: i, end })
      i = end + 1
    } else {
      i++
    }
  }
  return out
}

/**
 * Map the k-th top-level table (0-based DOM order) to its canonical line range.
 * Vditor IR renders tables in markdown order, so DOM index == markdown index.
 */
export function findTableBlockByIndex(lines: string[], tableIndex: number): { start: number; end: number } | undefined {
  return listTableBlocks(lines)[tableIndex]
}

/**
 * Resolve a rendered cell to its canonical cursor position.
 * `tableIndex` = k-th top-level table (DOM order); `rowIndex` = data-row index
 * (0-based; `isHeader` selects the header line); `columnIndex` = 0-based column.
 */
export function resolveTableCell(
  lines: string[],
  tableIndex: number,
  isHeader: boolean,
  rowIndex: number,
  columnIndex: number,
): { cursorLine: number; columnIndex: number } | undefined {
  const loc = findTableBlockByIndex(lines, tableIndex)
  if (loc === undefined) return undefined
  const block = parseTableBlock(lines.slice(loc.start))!
  const dataRow = Math.max(0, Math.min(rowIndex, block.rows.length - 1))
  const cursorLine = isHeader ? loc.start : loc.start + 2 + dataRow
  const col = Math.max(0, Math.min(columnIndex, block.header.length - 1))
  return { cursorLine, columnIndex: col }
}

function withTable(lines: string[], cursorLine: number, fn: (t: TableBlock, rel: number) => TableBlock | null): string[] | undefined {
  const loc = findTableBlock(lines, cursorLine)
  if (loc === undefined) return undefined
  const block = parseTableBlock(lines.slice(loc.start))!
  const next = fn(block, cursorLine - loc.start)
  if (next === null) return undefined
  const serialized = serializeTableBlock(next)
  return [...lines.slice(0, loc.start), ...serialized, ...lines.slice(loc.end + 1)]
}

/** Data-row insertion/deletion index from a relative line (0=header,1=sep,2+=data). */
function rowIdx(rel: number, rowsLen: number, below: boolean): number {
  if (rel <= 1) return 0 // header/separator → first data row
  const i = rel - 2
  return below ? Math.min(i + 1, rowsLen) : Math.min(i, rowsLen)
}

export function addRowAbove(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, (t, rel) => {
    const idx = rowIdx(rel, t.rows.length, false)
    t.rows.splice(idx, 0, t.header.map(() => ''))
    return t
  })
}

export function addRowBelow(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, (t, rel) => {
    const idx = rowIdx(rel, t.rows.length, true)
    t.rows.splice(idx, 0, t.header.map(() => ''))
    return t
  })
}

export function deleteRow(lines: string[], cursorLine: number): string[] | undefined {
  return withTable(lines, cursorLine, (t, rel) => {
    if (rel <= 1) return null // GFM requires a header row — cannot delete it
    if (t.rows.length === 0) return null
    const idx = Math.max(0, Math.min(rel - 2, t.rows.length - 1))
    t.rows.splice(idx, 1)
    return t
  })
}

export function addColumnLeft(lines: string[], cursorLine: number, columnIndex: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    const i = Math.max(0, Math.min(columnIndex, t.header.length))
    t.header.splice(i, 0, '')
    t.aligns.splice(i, 0, null)
    for (const r of t.rows) r.splice(i, 0, '')
    return t
  })
}

export function addColumnRight(lines: string[], cursorLine: number, columnIndex: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    const i = Math.max(0, Math.min(columnIndex + 1, t.header.length))
    t.header.splice(i, 0, '')
    t.aligns.splice(i, 0, null)
    for (const r of t.rows) r.splice(i, 0, '')
    return t
  })
}

export function deleteColumn(lines: string[], cursorLine: number, columnIndex: number): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    if (t.header.length <= 1) return null // GFM table needs ≥1 column
    const i = Math.max(0, Math.min(columnIndex, t.header.length - 1))
    t.header.splice(i, 1)
    t.aligns.splice(i, 1)
    for (const r of t.rows) r.splice(i, 1)
    return t
  })
}

export function setColumnAlign(lines: string[], cursorLine: number, columnIndex: number, align: ColumnAlign): string[] | undefined {
  return withTable(lines, cursorLine, t => {
    const i = Math.max(0, Math.min(columnIndex, t.aligns.length - 1))
    if (t.aligns[i] === align) return null
    t.aligns[i] = align
    return t
  })
}

export function deleteTable(lines: string[], cursorLine: number): string[] | undefined {
  const loc = findTableBlock(lines, cursorLine)
  if (loc === undefined) return undefined
  return [...lines.slice(0, loc.start), ...lines.slice(loc.end + 1)]
}

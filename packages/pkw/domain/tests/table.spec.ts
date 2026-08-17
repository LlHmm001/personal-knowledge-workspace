import { describe, expect, it } from 'vitest'
import {
  addRowBelow,
  addRowAbove,
  deleteRow,
  addColumnRight,
  addColumnLeft,
  deleteColumn,
  setColumnAlign,
  parseTableBlock,
  serializeTableBlock,
  findTableBlock,
  findTableBlockByIndex,
  listTableBlocks,
  resolveTableCell,
  deleteTable,
} from '../src/index.ts'

const t3 = ['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |']
// table at lines 2..5 (offset from top, like a real note)
const doc = ['# title', '', ...t3, '', 'after']

describe('GFM table transforms', () => {
  it('parses and round-trips a 3×3 table', () => {
    const block = parseTableBlock(t3)!
    expect(block.header).toEqual(['A', 'B', 'C'])
    expect(block.rows).toHaveLength(2)
    expect(serializeTableBlock(block)).toEqual(t3)
  })

  it('adds a row below the current data row (offset table)', () => {
    const out = addRowBelow(doc, 5)! // data row "4 5 6" at line 5
    expect(out[6]).toBe('|  |  |  |')
    expect(out[2]).toBe('| A | B | C |') // header untouched
  })

  it('adds a row above the current data row (offset table)', () => {
    const out = addRowAbove(doc, 5)!
    expect(out[4]).toBe('| 1 | 2 | 3 |')
    expect(out[5]).toBe('|  |  |  |')
    expect(out[6]).toBe('| 4 | 5 | 6 |')
  })

  it('adds a row below the header → first data row', () => {
    const out = addRowBelow(doc, 2)! // header line
    expect(out[4]).toBe('|  |  |  |')
  })

  it('deletes a data row (offset table)', () => {
    const out = deleteRow(doc, 4)! // "1 2 3"
    expect(out).toEqual(['# title', '', '| A | B | C |', '| --- | --- | --- |', '| 4 | 5 | 6 |', '', 'after'])
  })

  it('refuses to delete the header row (GFM needs a header)', () => {
    expect(deleteRow(doc, 2)).toBeUndefined()
  })

  it('adds a column to the right of a specific column (offset table)', () => {
    const out = addColumnRight(doc, 5, 1)!
    expect(out[2]).toBe('| A | B |  | C |')
    expect(out[5]).toBe('| 4 | 5 |  | 6 |')
  })

  it('adds a column to the left of a specific column (offset table)', () => {
    const out = addColumnLeft(doc, 5, 1)!
    expect(out[2]).toBe('| A |  | B | C |')
  })

  it('deletes a specific column (offset table)', () => {
    const out = deleteColumn(doc, 5, 1)!
    expect(out[2]).toBe('| A | C |')
    expect(out[5]).toBe('| 4 | 6 |')
  })

  it('refuses to delete the only remaining column', () => {
    const one = ['| A |', '| --- |', '| 1 |']
    expect(deleteColumn(one, 0, 0)).toBeUndefined()
  })

  it('sets alignment of a specific column', () => {
    const out = setColumnAlign(doc, 5, 1, 'center')!
    expect(out[3]).toBe('| --- | :---: | --- |')
  })

  it('sets alignment no-op when already equal', () => {
    expect(setColumnAlign(doc, 5, 0, null)).toBeUndefined()
  })

  it('locates the table block containing the cursor line', () => {
    expect(findTableBlock(doc, 4)).toEqual({ start: 2, end: 5 })
  })

  it('lists table blocks and maps DOM order index → line range', () => {
    const two = ['# t', '', '| A |', '| - |', '| 1 |', '', '| X |', '| - |', '| 9 |']
    expect(listTableBlocks(two)).toEqual([{ start: 2, end: 4 }, { start: 6, end: 8 }])
    expect(findTableBlockByIndex(two, 1)).toEqual({ start: 6, end: 8 })
    expect(findTableBlockByIndex(two, 2)).toBeUndefined()
  })

  it('resolves a rendered cell to its canonical cursor position', () => {
    const md = ['# t', '', '| A | B |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |']
    expect(resolveTableCell(md, 0, false, 1, 1)).toEqual({ cursorLine: 5, columnIndex: 1 })
    expect(resolveTableCell(md, 0, true, 0, 0)).toEqual({ cursorLine: 2, columnIndex: 0 })
    expect(resolveTableCell(md, 1, false, 0, 0)).toBeUndefined() // no 2nd table
  })

  it('deletes the whole table block from surrounding markdown', () => {
    expect(deleteTable(doc, 4)).toEqual(['# title', '', '', 'after'])
  })

  it('ignores a cursor outside any table', () => {
    expect(addRowBelow(['# no table', 'text'], 0)).toBeUndefined()
    expect(findTableBlock(['# no table'], 0)).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import {
  addRowBelow,
  deleteRow,
  addColumnRight,
  deleteColumn,
  setColumnAlign,
  parseTableBlock,
  serializeTableBlock,
  findTableBlock,
  deleteTable,
} from '../src/index.ts'

const t3 = ['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |']

describe('GFM table transforms', () => {
  it('parses and round-trips a 3×3 table', () => {
    const block = parseTableBlock(t3)!
    expect(block.header).toEqual(['A', 'B', 'C'])
    expect(block.rows).toHaveLength(2)
    expect(serializeTableBlock(block)).toEqual(t3)
  })

  it('adds a row below', () => {
    const out = addRowBelow(t3, 3)!
    expect(out).toEqual(['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |', '|  |  |  |'])
  })

  it('deletes a row', () => {
    const out = deleteRow(t3, 3)!
    expect(out).toEqual(['| A | B | C |', '| --- | --- | --- |', '| 1 | 2 | 3 |'])
  })

  it('adds a column to the right', () => {
    const out = addColumnRight(t3, 2)!
    expect(out).toEqual(['| A | B | C |  |', '| --- | --- | --- | --- |', '| 1 | 2 | 3 |  |', '| 4 | 5 | 6 |  |'])
  })

  it('deletes a column (last)', () => {
    const out = deleteColumn(t3, 2)!
    expect(out).toEqual(['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 4 | 5 |'])
  })

  it('sets column alignment (last column)', () => {
    const out = setColumnAlign(t3, 2, 'center')!
    expect(out[1]).toBe('| --- | --- | :---: |')
  })

  it('locates the table block containing the cursor line', () => {
    const md = ['# title', '', ...t3, '', 'after']
    const loc = findTableBlock(md, 4) // inside table
    expect(loc).toEqual({ start: 2, end: 5 })
  })

  it('deletes the whole table block from surrounding markdown', () => {
    const md = ['# title', '', ...t3, '', 'after']
    const out = deleteTable(md, 4)!
    expect(out).toEqual(['# title', '', '', 'after'])
  })

  it('ignores a cursor outside any table', () => {
    expect(addRowBelow(['# no table', 'text'], 0)).toBeUndefined()
    expect(findTableBlock(['# no table'], 0)).toBeUndefined()
  })
})

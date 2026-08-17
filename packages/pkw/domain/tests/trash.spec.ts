import { describe, expect, it } from 'vitest'
import { deriveSelectAll, parseTrashItemKey, reconcileSelection, summarizeBatch, trashItemKey } from '../src/index.ts'

describe('trash manager helpers', () => {
  it('builds a stable composite identity and parses it back', () => {
    expect(trashItemKey('folder', 'trash_abc')).toBe('folder:trash_abc')
    expect(parseTrashItemKey('note:n123')).toEqual({ kind: 'note', id: 'n123' })
    expect(parseTrashItemKey('attachment:a1')).toEqual({ kind: 'attachment', id: 'a1' })
    expect(parseTrashItemKey('folder:trash_xyz')).toEqual({ kind: 'folder', id: 'trash_xyz' })
    expect(parseTrashItemKey('bogus')).toBeUndefined()
    expect(parseTrashItemKey('weird:id')).toBeUndefined()
  })

  it('derives select-all state (none/partial/all) from sets, never a sticky flag', () => {
    const visible = ['a', 'b', 'c']
    expect(deriveSelectAll([], visible)).toBe('none')
    expect(deriveSelectAll(['a'], visible)).toBe('partial')
    expect(deriveSelectAll(['a', 'b', 'c'], visible)).toBe('all')
    expect(deriveSelectAll(['a', 'b', 'c', 'd'], visible)).toBe('all')
    expect(deriveSelectAll(['x'], [])).toBe('none')
  })

  it('reconciles selection against a fresh projection (intersection)', () => {
    expect(reconcileSelection(['a', 'b', 'c'], ['a', 'c', 'd'])).toEqual(['a', 'c'])
    expect(reconcileSelection(['a'], ['x', 'y'])).toEqual([])
    expect(reconcileSelection(new Set(['a', 'b']), ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('summarizes batch results — a failure never masks successes', () => {
    const r = summarizeBatch([
      { key: 'a', ok: true },
      { key: 'b', ok: false, error: 'boom' },
      { key: 'c', ok: true },
      { key: 'd', ok: false },
    ])
    expect(r.ok).toEqual(['a', 'c'])
    expect(r.failed).toEqual([{ key: 'b', error: 'boom' }, { key: 'd', error: 'unknown error' }])
  })
})

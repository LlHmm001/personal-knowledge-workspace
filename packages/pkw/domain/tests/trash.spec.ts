import { describe, expect, it } from 'vitest'
import { parseTrashItemKey, summarizeBatch } from '../src/index.ts'

describe('trash manager helpers', () => {
  it('parses a stable composite identity', () => {
    expect(parseTrashItemKey('note:n123')).toEqual({ kind: 'note', id: 'n123' })
    expect(parseTrashItemKey('attachment:a1')).toEqual({ kind: 'attachment', id: 'a1' })
    expect(parseTrashItemKey('folder:trash_xyz')).toEqual({ kind: 'folder', id: 'trash_xyz' })
    expect(parseTrashItemKey('bogus')).toBeUndefined()
    expect(parseTrashItemKey('weird:id')).toBeUndefined()
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

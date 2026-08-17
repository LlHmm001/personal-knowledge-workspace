import { describe, expect, it } from 'vitest'
import { resolveTextQuoteAnchor, type TaskSourceRef } from '../src/index.ts'

const body = '第一段内容。\n\n重新整理商业模型，专注创业方向。\n\n结尾段落。\n'
const anchor = (exact: string, prefix: string, suffix: string, start: number): TaskSourceRef => ({
  kind: 'selection',
  noteId: 'note_abc',
  exact,
  prefix,
  suffix,
  start,
  end: start + exact.length,
  noteRevision: 3,
  contentHash: 'h1',
})

describe('resolveTextQuoteAnchor', () => {
  it('A. unchanged note → precise location via exact match', () => {
    const start = body.indexOf('重新整理商业模型')
    const r = resolveTextQuoteAnchor(body, anchor('重新整理商业模型', '专注', '创业', start))
    expect(r).toEqual({ status: 'resolved', start, end: start + '重新整理商业模型'.length })
  })

  it('B. paragraph inserted above → stale offset ignored, exact/context still locates', () => {
    const edited = '新增的一段内容。\n\n' + body
    const staleOffset = body.indexOf('重新整理商业模型')
    const newStart = edited.indexOf('重新整理商业模型')
    const r = resolveTextQuoteAnchor(edited, anchor('重新整理商业模型', '专注', '创业', staleOffset))
    expect(r).toEqual({ status: 'resolved', start: newStart, end: newStart + '重新整理商业模型'.length })
  })

  it('C. exact appears twice → prefix/suffix disambiguate', () => {
    const twice = '第一次提到「目标」在这里。\n\n第二次提到「目标」在别处。\n'
    const first = twice.indexOf('目标')
    const second = twice.indexOf('目标', first + 1)
    const r = resolveTextQuoteAnchor(twice, { kind: 'selection', noteId: 'n', exact: '目标', prefix: '第二次提到「', suffix: '」在别处', start: second })
    expect(r).toEqual({ status: 'resolved', start: second, end: second + 2 })
    expect(first).not.toBe(second)
  })

  it('D. selected text modified → source-changed, never jumps to a wrong position', () => {
    const edited = body.replace('重新整理商业模型', '完全改写了这段内容')
    const r = resolveTextQuoteAnchor(edited, anchor('重新整理商业模型', '专注', '创业', body.indexOf('重新整理商业模型')))
    expect(r).toEqual({ status: 'source-changed' })
  })

  it('D2. surrounding context changed but exact still unique → still resolves (exact is truth)', () => {
    // exact occurs once, so context mismatch is irrelevant for uniqueness.
    const edited = body.replace('专注创业方向', '改成别的方向')
    const start = edited.indexOf('重新整理商业模型')
    const r = resolveTextQuoteAnchor(edited, anchor('重新整理商业模型', '专注', '创业', 0))
    expect(r).toEqual({ status: 'resolved', start, end: start + '重新整理商业模型'.length })
  })

  it('E. note-level source is NoteId-based (rename/move does not change noteId)', () => {
    // The anchor carries a stable NoteId; resolution is purely body-scoped.
    const noteAnchor: TaskSourceRef = { kind: 'note', noteId: 'note_abc' }
    expect(resolveTextQuoteAnchor(body, noteAnchor)).toEqual({ status: 'source-changed' })
    expect(noteAnchor.noteId).toBe('note_abc')
  })

  it('ambiguous exact (twice) with no context and no offset → source-changed', () => {
    const twice = 'abc abc'
    const r = resolveTextQuoteAnchor(twice, { kind: 'selection', noteId: 'n', exact: 'abc' })
    expect(r).toEqual({ status: 'source-changed' })
  })

  it('ambiguous exact (twice) resolved by offset hint landing on a candidate', () => {
    const twice = 'abc abc'
    const r = resolveTextQuoteAnchor(twice, { kind: 'selection', noteId: 'n', exact: 'abc', start: 4 })
    expect(r).toEqual({ status: 'resolved', start: 4, end: 7 })
  })
})

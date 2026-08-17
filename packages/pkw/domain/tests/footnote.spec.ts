import { describe, expect, it } from 'vitest'
import {
  appendFootnoteDefinition,
  countFootnoteReferences,
  deleteFootnote,
  editFootnoteDefinition,
  footnoteKeys,
  listFootnoteDefinitions,
  nextFootnoteKey,
  removeFootnoteDefinition,
} from '../src/index.ts'

describe('footnote canonical helpers', () => {
  it('collects keys from references and definitions', () => {
    expect(footnoteKeys('a[^1] b[^note] c')).toEqual(new Set(['1', 'note']))
    expect(footnoteKeys('[^1]: def')).toEqual(new Set(['1']))
  })

  it('mints the next free numeric key without collisions', () => {
    expect(nextFootnoteKey('')).toBe('1')
    expect(nextFootnoteKey('a[^1] b[^2] c')).toBe('3')
    expect(nextFootnoteKey('[^3]: x and [^1]')).toBe('2')
  })

  it('appends a definition at the end (canonical position)', () => {
    expect(appendFootnoteDefinition('# t\n\ntext', '1', 'the note')).toBe('# t\n\ntext\n\n[^1]: the note\n')
    expect(appendFootnoteDefinition('', '1', 'the note')).toBe('[^1]: the note\n')
  })

  it('lists definitions with indented continuation lines', () => {
    const lines = ['text', '[^1]: first line', '    second line', '', 'after']
    expect(listFootnoteDefinitions(lines)).toEqual([{ key: '1', content: 'first line\nsecond line', line: 1, endLine: 2 }])
  })

  it('edits a definition content (replacing continuation lines)', () => {
    const lines = ['text', '[^1]: old', '    cont', 'after']
    expect(editFootnoteDefinition(lines, '1', 'new content')).toEqual(['text', '[^1]: new content', 'after'])
    expect(editFootnoteDefinition(lines, '9', 'x')).toBeUndefined()
  })

  it('removes a definition block', () => {
    const lines = ['text', '[^1]: note', '    cont', 'after']
    expect(removeFootnoteDefinition(lines, '1')).toEqual(['text', 'after'])
  })

  it('counts references excluding the definition line', () => {
    expect(countFootnoteReferences('a[^1] b[^1] c', '1')).toBe(2)
    expect(countFootnoteReferences('[^1]: def', '1')).toBe(0)
  })

  it('deletes a whole footnote (all references + definition), no re-numbering', () => {
    const md = 'a[^1] b[^2] c\n\n[^1]: one\n[^2]: two'
    expect(deleteFootnote(md, '1')).toBe('a b[^2] c\n\n[^2]: two')
  })

  it('round-trips: insert reference + definition produces canonical GFM', () => {
    const body = 'PKW uses Markdown as canonical body.'
    const key = nextFootnoteKey(body)
    const ref = body.replace('Markdown', 'Markdown[^' + key + ']')
    const full = appendFootnoteDefinition(ref, key, 'Markdown is a plain-text markup format.')
    expect(full).toContain('Markdown[^1]')
    expect(full).toContain('[^1]: Markdown is a plain-text markup format.')
    // definition + reference are self-consistent
    expect(countFootnoteReferences(full, key)).toBe(1)
    expect(listFootnoteDefinitions(full.split('\n')).map(d => d.key)).toEqual(['1'])
  })
})

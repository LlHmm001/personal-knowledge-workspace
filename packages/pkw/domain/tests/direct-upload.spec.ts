import { describe, expect, it } from 'vitest'
import { companionNoteMarkdown, filenameStem, sanitizeNoteBase, uniqueNotePath } from '../src/direct-upload.ts'

describe('direct-upload helpers', () => {
  it('preserves CJK and spaces in note base names (no ASCII whitelist collapse)', () => {
    expect(sanitizeNoteBase('海报3')).toBe('海报3')
    expect(sanitizeNoteBase('AI & Agent')).toBe('AI & Agent')
    expect(sanitizeNoteBase('  spaced  ')).toBe('spaced')
  })

  it('strips path separators, Windows-reserved chars and control bytes only', () => {
    expect(sanitizeNoteBase('a/b\\c')).toBe('a_b_c')
    expect(sanitizeNoteBase('a:b*c?')).toBe('a_b_c_')
    expect(sanitizeNoteBase('a\u0001b')).toBe('a_b')
  })

  it('guards empty / dot-only names and trailing dots-spaces', () => {
    expect(sanitizeNoteBase('')).toBe('untitled')
    expect(sanitizeNoteBase('.')).toBe('untitled')
    expect(sanitizeNoteBase('..')).toBe('untitled')
    expect(sanitizeNoteBase('name.')).toBe('name')
    expect(sanitizeNoteBase('name ')).toBe('name')
  })

  it('derives a collision-free path and never emits 海报(2)-style duplicates', () => {
    const existing = new Set(['海报3.md'])
    expect(uniqueNotePath('', '海报3', existing)).toBe('海报3 2.md')
    expect(uniqueNotePath('工作', '海报3', existing)).toBe('工作/海报3.md')
    expect(uniqueNotePath('工作', '海报3', new Set(['工作/海报3.md']))).toBe('工作/海报3 2.md')
  })

  it('strips the extension from a filename', () => {
    expect(filenameStem('海报3.jpg')).toBe('海报3')
    expect(filenameStem('noext')).toBe('noext')
    expect(filenameStem('.hidden')).toBe('.hidden')
  })

  it('builds the canonical markdown reference from the STORED filename', () => {
    expect(companionNoteMarkdown('海报3', 'att_x', '海报3.jpg', 'image/jpeg')).toBe('# 海报3\n\n![](attachments/att_x/海报3.jpg)\n')
    expect(companionNoteMarkdown('报告', 'att_y', '报告.pdf', 'application/pdf')).toBe('# 报告\n\n[报告.pdf](attachments/att_y/报告.pdf)\n')
  })
})

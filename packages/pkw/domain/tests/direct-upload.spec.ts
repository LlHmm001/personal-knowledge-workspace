import { describe, expect, it } from 'vitest'
import { companionNoteMarkdown, decodeAttachmentMarkdownPath, encodeAttachmentMarkdownPath, filenameStem, sanitizeNoteBase, uniqueNotePath } from '../src/direct-upload.ts'

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

  it('builds the canonical markdown reference from the STORED filename (URL-encoded)', () => {
    expect(companionNoteMarkdown('海报3', 'att_x', '海报3.jpg', 'image/jpeg')).toBe('# 海报3\n\n![](attachments/att_x/%E6%B5%B7%E6%8A%A53.jpg)\n')
    expect(companionNoteMarkdown('报告', 'att_y', '报告.pdf', 'application/pdf')).toBe('# 报告\n\n[报告.pdf](attachments/att_y/%E6%8A%A5%E5%91%8A.pdf)\n')
    expect(companionNoteMarkdown('dl', 'att_z', 'download_file (1).jpg', 'image/jpeg')).toBe('# dl\n\n![](attachments/att_z/download_file%20%281%29.jpg)\n')
  })

  it('encodes only unsafe Markdown-destination chars, keeps / separators, decodes idempotently', () => {
    expect(encodeAttachmentMarkdownPath('download_file (1).jpg')).toBe('download_file%20%281%29.jpg')
    expect(encodeAttachmentMarkdownPath('a#b?c%d&e+f[g]h.jpg')).toBe('a%23b%3Fc%25d%26e%2Bf%5Bg%5Dh.jpg')
    // A sub-path keeps its '/' separators (only each segment is encoded).
    expect(encodeAttachmentMarkdownPath('sub dir/file (1).pdf')).toBe('sub%20dir/file%20%281%29.pdf')
    // Round-trip.
    expect(decodeAttachmentMarkdownPath('download_file%20%281%29.jpg')).toBe('download_file (1).jpg')
    expect(decodeAttachmentMarkdownPath(encodeAttachmentMarkdownPath('海报3 (1).jpg'))).toBe('海报3 (1).jpg')
    // Malformed legacy %-sequence is returned unchanged (never throws).
    expect(decodeAttachmentMarkdownPath('100%done.jpg')).toBe('100%done.jpg')
  })
})

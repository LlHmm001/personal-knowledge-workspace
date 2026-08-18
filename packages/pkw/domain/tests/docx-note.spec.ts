import { describe, expect, it } from 'vitest'
import { createDocxNote, extractDocxText, readDocxNoteId, writeDocxNoteId } from '../src/docx-note.ts'

describe('DOCX note canonical format', () => {
  it('round-trips a note body through create → extract text', async () => {
    const bytes = await createDocxNote({ noteId: 'note_abc123', title: '项目复盘', body: '第一行\n\n第二行内容' })
    const text = await extractDocxText(bytes)
    expect(text).toContain('项目复盘')
    expect(text).toContain('第一行')
    expect(text).toContain('第二行内容')
  })

  it('embeds and reads the PKW.NoteId custom property', async () => {
    const bytes = await createDocxNote({ noteId: 'note_xyz789', title: 'T', body: 'B' })
    expect(await readDocxNoteId(bytes)).toBe('note_xyz789')
  })

  it('writes/replaces the PKW.NoteId custom property', async () => {
    const bytes = await createDocxNote({ noteId: 'note_old', title: 'T', body: 'B' })
    const updated = await writeDocxNoteId(bytes, 'note_new')
    expect(await readDocxNoteId(updated)).toBe('note_new')
  })

  it('handles XML-escaping in body text', async () => {
    const bytes = await createDocxNote({ noteId: 'n1', title: 'A & B <tag>', body: 'x < y & z' })
    const text = await extractDocxText(bytes)
    expect(text).toContain('A & B <tag>')
    expect(text).toContain('x < y & z')
  })
})

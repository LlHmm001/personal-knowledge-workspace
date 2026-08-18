import { describe, expect, it } from 'vitest'
import { compileProcessingDocx, createDocxNote, extractDocxText, readDocxNoteId, writeDocxNoteId } from '../src/docx-note.ts'

// 1x1 PNG (valid image bytes for ImageRun embedding).
const PNG_1x1 = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

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

  it('compiles a note body + embedded image into one processing DOCX (text + caption)', async () => {
    const bytes = await compileProcessingDocx({
      noteId: 'note_proc',
      title: '客户项目资料',
      markdown: '# 客户项目资料\n\n这是客户项目资料。\n\n![](attachments/att_x/海报2.png)\n',
      images: [{ filename: '海报2.png', bytes: PNG_1x1, mimeType: 'image/png' }],
    })
    const text = await extractDocxText(bytes)
    expect(text).toContain('客户项目资料')
    expect(text).toContain('这是客户项目资料。')
    expect(text).toContain('[图片附件：海报2.png]') // searchable caption
    expect(await readDocxNoteId(bytes)).toBe('note_proc')
  })
})

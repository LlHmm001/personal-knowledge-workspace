/**
 * DOCX Note canonical format — the Word-route vertical-slice foundation.
 *
 * A Note's canonical body becomes a `.docx` binary (text + embedded images).
 * PKW identity is written into the DOCX custom property `PKW.NoteId` as a
 * recoverability hint when the file is moved/renamed externally (the database
 * remains the authoritative identity store). `.doc` is export-only; PDF/XLSX/…
 * stay independent Source Assets.
 *
 * This module owns the OOXML read/write mechanics: create a note DOCX, extract
 * its plain text (for hashing + WeKnora projection), and read/write the
 * `PKW.NoteId` custom property. No Markdown canonical is created.
 *
 * @module @deepseek-ai/dsh-pkw-domain/docx-note
 */

import JSZip from 'jszip'
import { Document, ImageRun, Packer, Paragraph, TextRun } from 'docx'

const CUSTOM_PROPS_PATH = 'docProps/custom.xml'
const DOCUMENT_XML_PATH = 'word/document.xml'

export interface EmbeddedImage {
  filename: string
  bytes: Uint8Array
  mimeType: string
}

function propXml(noteId: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="PKW.NoteId">
    <vt:lpwstr>${escapeXml(noteId)}</vt:lpwstr>
  </property>
</Properties>`
}

function escapeXml(s: string): string {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
}

/**
 * Create a new Note DOCX (body paragraphs only — no Markdown) and embed the
 * stable `PKW.NoteId` custom property.
 */
export async function createDocxNote(input: { noteId: string; title: string; body: string }): Promise<Uint8Array> {
  const paragraphs: Paragraph[] = []
  if (input.title.trim() !== '') paragraphs.push(new Paragraph({ children: [new TextRun({ text: input.title, bold: true, size: 32 })] }))
  for (const line of input.body.split(/\n+/)) {
    if (line.trim() === '') continue
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: line })] }))
  }
  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buf = await Packer.toBuffer(doc)
  return writeDocxNoteId(new Uint8Array(buf), input.noteId)
}

/**
 * Compile the canonical Note (Markdown body + managed image attachments) into a
 * single `.processing.docx` — a PROCESSING ARTIFACT, not a new canonical. The
 * note text becomes paragraphs; each managed image ref `![alt](attachments/<id>/<file>)`
 * becomes an embedded image (ImageRun) plus a searchable text caption
 * `[图片附件：<file>]`, so WeKnora parses body + image together as ONE document.
 */
export async function compileProcessingDocx(input: { noteId: string; title: string; markdown: string; images: EmbeddedImage[] }): Promise<Uint8Array> {
  const byFilename = new Map(input.images.map(im => [im.filename, im]))
  const paragraphs: Paragraph[] = []
  if (input.title.trim() !== '') paragraphs.push(new Paragraph({ children: [new TextRun({ text: input.title, bold: true, size: 32 })] }))

  // Walk body lines; replace image refs with embedded image + caption.
  const imgRef = /!\[[^\]]*\]\([^)]*attachments\/[^/]+\/([^)]+)\)/g
  for (const rawLine of input.markdown.split(/\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    // Collect text and image refs in order.
    let lastIndex = 0
    const runs: (string | EmbeddedImage)[] = []
    let m: RegExpExecArray | null
    imgRef.lastIndex = 0
    while ((m = imgRef.exec(line)) !== null) {
      const before = line.slice(lastIndex, m.index)
      if (before.trim() !== '') runs.push(before)
      const filename = m[1]!
      const img = byFilename.get(filename)
      if (img !== undefined) runs.push(img)
      else runs.push(`[图片附件：${filename}]`)
      lastIndex = m.index + m[0].length
    }
    const tail = line.slice(lastIndex)
    if (tail.trim() !== '') runs.push(tail)

    if (runs.length === 0) continue
    const children: (TextRun | ImageRun)[] = []
    for (const r of runs) {
      if (typeof r === 'string') {
        children.push(new TextRun({ text: r }))
      } else {
        children.push(new TextRun({ text: `\n[图片附件：${r.filename}]\n` }))
        children.push(new ImageRun({ data: Buffer.from(r.bytes), type: imageRunType(r.mimeType), transformation: { width: 480, height: 360 } }))
      }
    }
    paragraphs.push(new Paragraph({ children }))
  }

  const doc = new Document({ sections: [{ children: paragraphs }] })
  const buf = await Packer.toBuffer(doc)
  return writeDocxNoteId(new Uint8Array(buf), input.noteId)
}

function imageRunType(mimeType: string): 'png' | 'jpg' | 'gif' | 'bmp' {
  if (mimeType.includes('png')) return 'png'
  if (mimeType.includes('gif')) return 'gif'
  if (mimeType.includes('bmp')) return 'bmp'
  return 'jpg'
}

/** Extract the plain text of a DOCX (concatenated `<w:t>` runs, newline per paragraph). */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file(DOCUMENT_XML_PATH)
  if (entry === null) return ''
  const xml = await entry.async('string')
  // Split into paragraphs so line boundaries survive; collect text runs.
  const parts = xml.split(/<\/w:p>/)
  const lines: string[] = []
  for (const p of parts) {
    const runs = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(m => m[1]!).map(unescapeXml)
    const text = runs.join('')
    if (text.trim() !== '') lines.push(text)
  }
  return lines.join('\n')
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/** Read the `PKW.NoteId` custom property (undefined when absent). */
export async function readDocxNoteId(bytes: Uint8Array): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file(CUSTOM_PROPS_PATH)
  if (entry === null) return undefined
  const xml = await entry.async('string')
  const m = /name="PKW\.NoteId"[\s\S]*?<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/.exec(xml)
  return m === null ? undefined : unescapeXml(m[1]!).trim()
}

/** Write (or replace) the `PKW.NoteId` custom property and return the new DOCX bytes. */
export async function writeDocxNoteId(bytes: Uint8Array, noteId: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  // Replace the whole custom.xml with a single-property file. This is the
  // simplest durable approach for the recoverability hint (the DB is the real source).
  zip.file(CUSTOM_PROPS_PATH, propXml(noteId))
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  return out
}

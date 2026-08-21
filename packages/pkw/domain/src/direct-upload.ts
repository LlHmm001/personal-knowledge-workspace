/**
 * Direct Upload orchestration helpers (runtime-free, testable).
 *
 * Direct Upload is local-first: the binary is imported as an AttachmentRecord,
 * then an optional Companion Note is created whose Markdown embeds the managed
 * `attachments/<id>/<storedFilename>` reference. The durable relation is
 * `AttachmentRecord.companionNoteId → NoteId` (stable identity, never the title
 * or path).
 *
 * Root cause of the original "companion note broken" bug: `importFile` stored
 * the binary under a sanitized filename while the note referenced the raw upload
 * name. These helpers are the single source of truth so the note reference and
 * the stored filename can never diverge again.
 *
 * @module @deepseek-ai/dsh-pkw-domain/direct-upload
 */

const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * Sanitize a note base name (a file stem, not a full path) into a safe
 * filesystem name WITHOUT destroying Unicode. CJK, accented letters, spaces and
 * most punctuation survive; only path separators, Windows-reserved characters
 * and control bytes are replaced. The prior implementation whitelisted ASCII
 * and collapsed `海报3` → `__3`, which is why Companion Notes appeared under
 * mangled `__3.md`-style names.
 */
export function sanitizeNoteBase(base: string): string {
  let out = String(base).replace(UNSAFE_FILENAME_CHARS, '_').replace(/\s+/g, ' ').trim()
  // Filesystem/Windows-unfriendly: strip leading/trailing dots and spaces.
  out = out.replace(/^[.\s]+|[.\s]+$/g, '')
  if (out === '' || out === '.' || out === '..') out = 'untitled'
  return out
}

/** Strip the extension from a filename, returning the stem ('' when there is none). */
export function filenameStem(filename: string): string {
  const name = String(filename)
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(0, idx) : name
}

/**
 * Choose a collision-free note relative path under `folder` ('' = notes root)
 * for the given base name, avoiding every path in `existing`.
 */
export function uniqueNotePath(folder: string, base: string, existing: ReadonlySet<string>): string {
  const safe = sanitizeNoteBase(base)
  const prefix = folder !== '' ? String(folder).replace(/\/+$/g, '') + '/' : ''
  let candidate = prefix + safe + '.md'
  let n = 2
  while (existing.has(candidate)) {
    candidate = prefix + safe + ' ' + n + '.md'
    n++
  }
  return candidate
}

/**
 * Build the canonical Companion Note Markdown for an attachment. `storedFilename`
 * MUST be the filename the binary was persisted under (AttachmentRecord.filename),
 * never the raw browser `File.name`, so the managed reference always resolves.
 */
export function companionNoteMarkdown(base: string, attachmentId: string, storedFilename: string, mimeType: string): string {
  const ref = 'attachments/' + attachmentId + '/' + encodeAttachmentMarkdownPath(storedFilename)
  const isImage = String(mimeType || '').startsWith('image/')
  const refMd = isImage ? '![](' + ref + ')' : '[' + storedFilename + '](' + ref + ')'
  return '# ' + base + '\n\n' + refMd + '\n'
}

/**
 * Encode a filename (or a relative path segment) into a URL-safe Markdown
 * destination. Only the user's filename/path segments are encoded — the
 * `attachments/<id>/` structure and the `/` separators are preserved.
 *
 * Covers space, `()`, `#`, `?`, `%`, `&`, `+`, `[]`, CJK, Japanese and emoji
 * (F2). This is the SINGLE write-side rule for managed attachment references;
 * every reader (rewriteAttachmentUrls / collectManagedLinks /
 * managedAttachmentUrl / serveAttachment) resolves by AttachmentId only, so it
 * accepts either an encoded or a legacy raw filename.
 */
export function encodeAttachmentMarkdownPath(segment: string): string {
  return String(segment).split('/').map(encodeAttachmentSegment).join('/')
}

function encodeAttachmentSegment(segment: string): string {
  // encodeURIComponent escapes space # ? % & + [ ] and all non-ASCII, but LEAVES
  // - _ . ! ~ * ' ( ) unescaped. In a bare Markdown destination `(`, `)` and `'`
  // are unsafe, so encode them too. `-`, `_`, `.` and `~` stay literal (safe).
  return encodeURIComponent(segment).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/**
 * Inverse of {@link encodeAttachmentMarkdownPath}. Idempotent on raw names and
 * tolerant of malformed legacy refs (returns the input unchanged on decode error
 * rather than throwing).
 */
export function decodeAttachmentMarkdownPath(segment: string): string {
  try {
    return decodeURIComponent(String(segment))
  } catch {
    return String(segment)
  }
}

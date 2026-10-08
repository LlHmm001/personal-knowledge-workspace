/**
 * PKW Web MVP — Host Web Bridge + served browser UI.
 *
 * One dual-role Host plugin: it loads the PKW Core services (Notes, Attachments,
 * Workspace, Durable Events, WeKnora Sync/Retrieval) into the current Harness
 * process, then registers the `/pkw` HTTP surface on `ctx.webServer`:
 *   - GET  /pkw       → the browser UI (a self-contained page, no client bundle)
 *   - POST /pkw/api   → JSON RPC dispatcher over the PKW Core services
 *
 * The browser never touches SQLite, the Workspace filesystem, the WeKnora API
 * key, or WeKnora REST directly — every capability goes through these handlers.
 * Local Save is the synchronous UI contract; WeKnora Sync is asynchronous.
 *
 * @module @deepseek-ai/dsh-pkw-web
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { posix, extname, resolve as pathResolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { AttachmentId, FolderTrashEntryId, NoteId, NoteUpdateConflictError, TaskId, TaskMatrixId, addColumnLeft, addColumnRight, addRowAbove, addRowBelow, companionNoteMarkdown, deleteColumn, deleteRow, deleteFootnote, deleteTable, editFootnoteDefinition, filenameStem, nextFootnoteKey, parseTrashItemKey, resolveTableCell, sanitizeNoteBase, setColumnAlign, summarizeBatch, uniqueNotePath } from '@deepseek-ai/dsh-pkw-domain'
import type { ColumnAlign, NoteUpdateOptions } from '@deepseek-ai/dsh-pkw-domain'
import type { OrderChild } from '@deepseek-ai/dsh-pkw-notes'
import PkwEventStoreService from '@deepseek-ai/dsh-pkw-events'
import PkwWorkspaceService from '@deepseek-ai/dsh-pkw-workspace'
import NotesService, { splitFrontmatter } from '@deepseek-ai/dsh-pkw-notes'
import AttachmentsService from '@deepseek-ai/dsh-pkw-attachments'
import TasksService, { taskContentHash, TaskUpdateConflictError } from '@deepseek-ai/dsh-pkw-tasks'
import WeKnoraClient from '@deepseek-ai/dsh-pkw-weknora'
import WeKnoraSyncService, { type RetrievalResult } from '@deepseek-ai/dsh-pkw-weknora-sync'
import { renderPage } from './ui.ts'
import { renderMarkdownToHtml } from './lute.ts'
import { localKeywordSearch, type LocalDocument } from './local-search.ts'

// Capture at module load: a stale running process must not claim a newly
// installed version merely because package.json changed on disk.
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const noteContentHash = (markdown: string): string => createHash('sha256').update(markdown.replace(/\r\n/g, '\n')).digest('hex')
type SyncConfiguration = 'configured' | 'missing_base_url' | 'missing_credential' | 'missing_kb' | 'unavailable'
interface SyncSnapshot {
  intents: Map<string, { state: string; lastError?: string }>
  dirty: Set<string>
  configuration: SyncConfiguration
}

const activeSyncIntent = (intent: { state: string } | undefined): boolean => intent !== undefined && ['pending', 'running', 'unknown', 'retryable'].includes(intent.state)

function noteWriteOptions(args: Record<string, unknown>): NoteUpdateOptions {
  const { expectedRevision, expectedContentHash } = args
  if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('Invalid expectedRevision')
  if (expectedContentHash !== undefined && (typeof expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedContentHash))) throw new Error('Invalid expectedContentHash')
  return { expectedRevision: expectedRevision as number | undefined, expectedContentHash: expectedContentHash as string | undefined }
}

export interface Config {
  /** Authenticated collaboration hosts bind each runtime to its own path. */
  basePath?: string
  workspaceTitle?: string
  /** Workspace root directory (notes/ + attachments/ live under it). */
  workspacePath: string
  /** Target WeKnora knowledge base id (the PKW mirror KB). */
  kbId: string
  /** WeKnora API base URL. */
  weknoraBaseUrl: string
  /** Credential ref for the WeKnora API key (production; '' = not configured). */
  weknoraApiKeyRef: string
  /** Literal API key for test / DI ('' = unset). */
  weknoraApiKey: string
  pollMs: number
  retryBaseMs: number
  retryMaxMs: number
  recoveryGraceAttempts: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { pkwWeb: PkwWebService }
}

type Json = Record<string, unknown>

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text) as Json
}

/** Directory part of a note relative path ('' for files directly under `notes/`). */
function folderOf(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/')
  return idx === -1 ? '' : relativePath.slice(0, idx)
}

/**
 * Derive a plain-text summary snippet from canonical Markdown (body only, after
 * stripping PKW frontmatter). Never depends on WeKnora — the Knowledge Discovery
 * list stays readable while the remote engine is offline.
 */
function markdownSnippet(markdown: string, max = 220): string {
  const { body } = splitFrontmatter(markdown)
  let inFence = false
  const parts: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('```') || line.startsWith('~~~')) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^(#{1,6})\s/.test(line)) continue          // headings
    if (/^\|.*\|$/.test(line)) continue             // GFM tables
    if (/^!\[/.test(line) || /^</.test(line)) continue // images / raw html
    if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) continue // task-list rows
    let text = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // image
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // wiki link
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // markdown link
      .replace(/`([^`]+)`/g, '$1')                    // inline code
      .replace(/\*\*([^*]+)\*\*/g, '$1')              // bold
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|\s)[*_]([^*_]+)[*_](\s|$)/g, '$1$2$3') // italic
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/, '') // bullet / ordered / quote marker
      .trim()
    if (text) parts.push(text)
    if (parts.join(' ').length >= max) break
  }
  let snippet = parts.join(' ')
  if (snippet.length > max) snippet = snippet.slice(0, max).replace(/\s+\S*$/, '') + '…'
  return snippet
}

/**
 * Lightweight Markdown → readable plain-text snippet for a search hit (chunk
 * content), reusing strip semantics without a full Markdown parser. Never
 * depends on WeKnora.
 */
function plainTextSnippet(markdown: string, max = 220): string {
  let text = String(markdown ?? '')
  text = text
    .replace(/^---[\s\S]*?---\s*/m, '')            // frontmatter
    .replace(/```[\s\S]*?```/g, ' ')               // fenced code
    .replace(/<[^>]+>/g, ' ')                      // raw HTML (tables etc.)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](\s|$)/g, '$1$2$3')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/, '') + '…'
  return text
}

/**
 * Rewrite a Note's displayed title (frontmatter `title:` when present, else the
 * first `# heading`, else a new leading heading) while preserving NoteId, path,
 * and the rest of the body. Used by inline rename (title-only, never path).
 */
function retitleMarkdown(markdown: string, title: string): string {
  const { frontmatterRaw, body } = splitFrontmatter(markdown)
  const trimmed = title.trim()
  const titleRe = /^title:\s*[^\r\n]*$/m
  if (frontmatterRaw !== '' && titleRe.test(frontmatterRaw)) {
    return frontmatterRaw.replace(titleRe, 'title: ' + trimmed) + '\n' + body
  }
  if (/^#\s+[^\r\n]*/m.test(body)) {
    return frontmatterRaw + (frontmatterRaw === '' ? '' : '\n') + body.replace(/^#\s+[^\r\n]*/m, '# ' + trimmed)
  }
  return frontmatterRaw + (frontmatterRaw === '' ? '' : '\n') + '# ' + trimmed + '\n' + body
}

/**
 * Pinned Vditor version. The served asset URLs embed it so the browser can
 * long-cache immutably; Vditor's own `cdn` base also uses it. Bump together
 * with the `vditor` dependency in the lockfile.
 */
const VDITOR_VERSION = '3.11.3'

const VDITOR_MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

interface TreeChild {
  kind: 'note' | 'folder'
  id: string
  name: string
  path?: string
  updatedAt?: string
  note?: Record<string, unknown>
}

/** Sort children by sort mode (manual/title/updated); manual falls back to folders-then-notes by name. */
function applyOrder(children: TreeChild[], order: OrderChild[], sortMode: string): TreeChild[] {
  if (sortMode === 'title') {
    return children.slice().sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }
  if (sortMode === 'updated') {
    return children.slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      const au = a.updatedAt ?? ''
      const bu = b.updatedAt ?? ''
      return bu < au ? -1 : bu > au ? 1 : 0
    })
  }
  if (order.length === 0) {
    return children.slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  }
  const idx = new Map<string, number>()
  order.forEach((o, i) => idx.set(`${o.kind}:${o.id}`, i))
  const key = (c: TreeChild) => `${c.kind}:${c.id}`
  const inOrder = children.filter(c => idx.has(key(c)))
  const rest = children.filter(c => !idx.has(key(c)))
  inOrder.sort((a, b) => idx.get(key(a))! - idx.get(key(b))!)
  return [...inOrder, ...applyOrder(rest, [], 'manual')]
}

export class PkwWebService extends Service {
  static inject = ['storageDomain', 'fs', 'workspaceRegistry', 'webServer', 'timer']
  static Config: z<Config> = z.object({
    basePath: z.string().default('/pkw'),
    workspaceTitle: z.string().default(''),
    workspacePath: z.string(),
    kbId: z.string(),
    weknoraBaseUrl: z.string(),
    weknoraApiKeyRef: z.string().default(''),
    weknoraApiKey: z.string().default(''),
    pollMs: z.number().default(1000),
    retryBaseMs: z.number().default(1000),
    retryMaxMs: z.number().default(60000),
    recoveryGraceAttempts: z.number().default(3),
  })

  private workspaceId = ''
  private workspaceName = ''
  private notes!: NotesService
  private attachments!: AttachmentsService
  private weknora!: WeKnoraClient
  private sync!: WeKnoraSyncService
  private tasks!: TasksService

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwWeb')
  }

  protected async [Service.init](): Promise<void> {
    if (!/^\/pkw(?:\/spaces\/[a-zA-Z0-9_-]+)?$/.test(this.basePath)) throw new Error('Invalid PKW basePath')
    const registry = this.ctx.workspaceRegistry
    const existing = await registry.resolveByPath(this.config.workspacePath)
    const ws = existing ?? await registry.create(this.config.workspacePath, 'PKW Personal Knowledge Workspace')
    this.workspaceId = String(ws.id)
    this.workspaceName = this.config.workspaceTitle || ws.title

    // PKW Core services, loaded into this plugin's fiber (browser never reaches them directly).
    await this.ctx.plugin(PkwEventStoreService)
    await this.ctx.plugin(PkwWorkspaceService)
    await this.ctx.plugin(NotesService, { workspaceId: this.workspaceId })
    await this.ctx.plugin(AttachmentsService, { workspaceId: this.workspaceId })
    await this.ctx.plugin(TasksService, { workspaceId: this.workspaceId })
    await this.ctx.plugin(WeKnoraClient, {
      baseUrl: this.config.weknoraBaseUrl,
      apiKey: this.config.weknoraApiKey,
      apiKeyRef: this.config.weknoraApiKeyRef,
    })
    await this.ctx.plugin(WeKnoraSyncService, {
      kbId: this.config.kbId,
      workspaceId: this.workspaceId,
      pollMs: this.config.pollMs,
      retryBaseMs: this.config.retryBaseMs,
      retryMaxMs: this.config.retryMaxMs,
      recoveryGraceAttempts: this.config.recoveryGraceAttempts,
    })

    // Capture the service instances via the reflect store (global), NOT the
    // inject-based context property (ctx.pkwNotes would require inject and fail
    // across the child-fiber boundary).
    this.notes = this.ctx.get('pkwNotes') as NotesService
    this.attachments = this.ctx.get('pkwAttachments') as AttachmentsService
    this.weknora = this.ctx.get('pkwWeKnora') as WeKnoraClient
    this.sync = this.ctx.get('pkwWeKnoraSync') as WeKnoraSyncService
    this.tasks = this.ctx.get('pkwTasks') as TasksService

    // Route surface. Disposers are owned by this fiber via ctx.effect.
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact', path: this.basePath, handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-PKW-Version': packageVersion })
        res.end(renderPage(packageVersion, this.basePath))
      },
    }), 'pkw.web.page')

    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact', path: this.basePath + '/api', handler: (req, res) => {
        void this.handleApi(req, res)
      },
    }), 'pkw.web.api')

    // Vditor self-hosted assets. Serve the pinned version under
    // `/pkw/assets/vditor/<version>/dist/**` from the installed package so
    // Vditor's own lazy `cdn`-relative fetches (i18n, icons, highlight, math,
    // mermaid, …) resolve to the same tree. Versioned + immutable long-cache.
    const vditorEntry = createRequire(import.meta.url).resolve('vditor/dist/index.min.js')
    const vditorRoot = vditorEntry.slice(0, vditorEntry.length - 'dist/index.min.js'.length)
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix', path: this.basePath + '/assets/vditor', handler: (req, res) => {
        void this.serveVditorAsset(req, res, vditorRoot)
      },
    }), 'pkw.web.vditorAssets')

    // Managed attachment bytes for Reading mode (`/pkw/attachment/<id>`).
    // The renderer rewrites `attachments/<id>/<file>` srcs/hrefs to this URL;
    // bytes stream with the stored mime + inline (image) / download (file).
    this.ctx.effect(() => this.ctx.webServer.register({
      // NOTE: WebServer prefix matching is `pathname.startsWith(path + '/')` and
      // requires `path` to have NO trailing slash. A trailing slash here made the
      // matcher look for `/pkw/attachment//…`, so every byte request fell through
      // to the SPA fallback and returned the GUI shell — breaking BOTH Live images
      // and Attachment Manager thumbnails.
      kind: 'prefix', path: this.basePath + '/attachment', handler: (req, res) => {
        void this.serveAttachment(req, res)
      },
    }), 'pkw.web.attachment')
  }

  private async serveAttachment(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // The byte route identity is the stable AttachmentId ONLY. The trailing
      // `<filename>` segment (if any) is never used for lookup — filename is
      // display/reference metadata, not route identity (CJK/spaces/rename safe).
      let raw = decodeURIComponent(url.pathname.slice((this.basePath + '/attachment/').length)).replace(/^\/+|\/+$/g, '')
      // Preview supports passive image/PDF/plain text; active document types remain downloads.
      const isPreview = raw.endsWith('/preview')
      if (isPreview) raw = raw.slice(0, -'/preview'.length).replace(/\/+$/g, '')
      const id = raw
      if (!/^att_[0-9a-f]{12}$/.test(id)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      const rec = this.attachments.get(AttachmentId(id))
      if (rec === undefined) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      const bytes = await this.attachments.open(AttachmentId(id))
      const mime = rec.mimeType || 'application/octet-stream'
      const safeName = (rec.filename ?? 'attachment').replace(/["\r\n\\]/g, '_')
      // Uploaded HTML/SVG/XML must never become active same-origin documents.
      const mediaType = mime.split(';')[0]!.trim().toLowerCase()
      const inlineImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(mediaType)
      const safeInline = inlineImage || mediaType === 'application/pdf' || (isPreview && mediaType === 'text/plain')
      const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_')
      const encodedName = encodeURIComponent(safeName).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
      const disposition = safeInline ? 'inline' : `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': disposition,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(!safeInline ? { 'Content-Security-Policy': "sandbox; default-src 'none'" } : {}),
      })
      res.end(Buffer.from(bytes))
    } catch (error) {
      this.ctx.logger.warn(`pkw.attachment serve failed: ${error instanceof Error ? error.message : String(error)}`)
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    }
  }

  private async serveVditorAsset(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // e.g. '3.11.3/dist/index.min.js' → version + 'dist/...' (allowlist).
      const sub = url.pathname.slice((this.basePath + '/assets/vditor/').length)
      const [version, ...rest] = sub.split('/')
      if (version !== VDITOR_VERSION) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      const rel = rest.join('/')
      if (!rel.startsWith('dist/')) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const target = pathResolve(root, rel)
      if (!target.startsWith(pathResolve(root) + sep)) {
        json(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const mime = VDITOR_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      const data = await readFile(target)
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    }
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody(req)
      const method = typeof body.method === 'string' ? body.method : ''
      const args = (body.args ?? {}) as Json
      const result = await this.call(method, args)
      json(res, 200, { ok: true, value: result })
    } catch (error) {
      if (error instanceof NoteUpdateConflictError || error instanceof TaskUpdateConflictError) {
        json(res, 409, { ok: false, code: error.code, error: error.message })
        return
      }
      json(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  }

  /** Stable UI-facing RPC entry (also the contract under test). */
  private get basePath(): string { return this.config.basePath ?? '/pkw' }

  async call(method: string, args: Json): Promise<unknown> {
    switch (method) {
      case 'summary': return this.summary()
      case 'listNotes': {
        const snap = await this.syncSnapshot()
        return this.notes.list().map(n => ({
          noteId: String(n.noteId),
          relativePath: n.relativePath,
          folder: folderOf(n.relativePath),
          title: n.title,
          tags: n.tags,
          updatedAt: n.updatedAt,
          observedRevision: n.observedRevision,
          deleted: n.deletedAt !== undefined,
          attachmentBacked: n.attachmentBacked === true,
          sync: this.syncView('note', String(n.noteId), snap),
        }))
      }
      case 'getNote': {
        const noteId = NoteId(String(args.noteId))
        const doc = await this.notes.getDocument(noteId)
        const { frontmatterRaw, body } = splitFrontmatter(doc.markdown)
        return {
          note: { noteId: String(doc.note.noteId), relativePath: doc.note.relativePath, title: doc.note.title, tags: doc.note.tags, updatedAt: doc.note.updatedAt, observedRevision: doc.note.observedRevision, contentHash: noteContentHash(doc.markdown), attachmentBacked: doc.note.attachmentBacked === true },
          markdown: doc.markdown,
          frontmatter: frontmatterRaw,
          body,
          attachments: doc.attachments.map(a => ({ attachmentId: String(a.attachmentId), relativePath: a.relativePath })),
          sync: this.syncView('note', String(noteId), await this.syncSnapshot()),
        }
      }
      case 'renderMarkdown': {
        // Reading-mode HTML via the shared Lute engine (callout/table/code/wiki).
        const md = String(args.markdown ?? '')
        if (args.noteId !== undefined && args.noteId !== null && args.noteId !== '') return this.renderNoteMarkdown(md, String(args.noteId))
        return renderMarkdownToHtml(md, this.basePath)
      }
      case 'tableMutation': {
        // Canonical GFM table edit: browser resolves the cell (tableIndex, header,
        // row, column) structurally, Host applies the pure table.ts transform.
        const lines = String(args.markdown ?? '').split('\n')
        const op = String(args.op ?? '')
        const loc = resolveTableCell(lines, Number(args.tableIndex ?? 0), args.isHeader === true, Number(args.rowIndex ?? 0), Number(args.columnIndex ?? 0))
        if (loc === undefined) return { unchanged: true }
        const align = args.align === 'center' ? 'center' : args.align === 'right' ? 'right' : args.align === 'left' ? 'left' : null
        let next: string[] | undefined
        if (op === 'addRowAbove') next = addRowAbove(lines, loc.cursorLine)
        else if (op === 'addRowBelow') next = addRowBelow(lines, loc.cursorLine)
        else if (op === 'deleteRow') next = deleteRow(lines, loc.cursorLine)
        else if (op === 'addColumnLeft') next = addColumnLeft(lines, loc.cursorLine, loc.columnIndex)
        else if (op === 'addColumnRight') next = addColumnRight(lines, loc.cursorLine, loc.columnIndex)
        else if (op === 'deleteColumn') next = deleteColumn(lines, loc.cursorLine, loc.columnIndex)
        else if (op === 'setColumnAlign') next = setColumnAlign(lines, loc.cursorLine, loc.columnIndex, align as ColumnAlign)
        else if (op === 'deleteTable') next = deleteTable(lines, loc.cursorLine)
        else return { unchanged: true }
        if (next === undefined) return { unchanged: true }
        return { markdown: next.join('\n') }
      }
      case 'nextFootnoteKey': return { key: nextFootnoteKey(String(args.markdown ?? '')) }
      case 'footnoteEdit': {
        const lines = String(args.markdown ?? '').split('\n')
        const next = editFootnoteDefinition(lines, String(args.key ?? ''), String(args.content ?? ''))
        if (next === undefined) return { unchanged: true }
        return { markdown: next.join('\n') }
      }
      case 'footnoteDelete': {
        return { markdown: deleteFootnote(String(args.markdown ?? ''), String(args.key ?? '')) }
      }
      case 'batchRestoreTrash': {
        const items = Array.isArray(args.items) ? args.items as Array<{ key?: string; kind?: string; id?: string }> : []
        const results: Array<{ key: string; ok: boolean; error?: string }> = []
        for (const it of items) {
          const parsed = it.key !== undefined ? parseTrashItemKey(String(it.key)) : { kind: it.kind as never, id: String(it.id ?? '') }
          const key = it.key !== undefined ? String(it.key) : String(it.kind) + ':' + String(it.id ?? '')
          try {
            if (parsed === undefined) throw new Error('invalid trash key')
            if (parsed.kind === 'note') await this.notes.restore(NoteId(parsed.id))
            else if (parsed.kind === 'attachment') await this.attachments.restore(AttachmentId(parsed.id))
            else await this.notes.restoreFolder(FolderTrashEntryId(parsed.id))
            results.push({ key, ok: true })
          } catch (e) {
            results.push({ key, ok: false, error: String(e instanceof Error ? e.message : e) })
          }
        }
        return summarizeBatch(results)
      }
      case 'batchPurgeTrash': {
        const items = Array.isArray(args.items) ? args.items as Array<{ key?: string; kind?: string; id?: string }> : []
        const results: Array<{ key: string; ok: boolean; error?: string }> = []
        for (const it of items) {
          const parsed = it.key !== undefined ? parseTrashItemKey(String(it.key)) : { kind: it.kind as never, id: String(it.id ?? '') }
          const key = it.key !== undefined ? String(it.key) : String(it.kind) + ':' + String(it.id ?? '')
          try {
            if (parsed === undefined) throw new Error('invalid trash key')
            if (parsed.kind === 'note') await this.notes.purge(NoteId(parsed.id))
            else if (parsed.kind === 'attachment') await this.attachments.purge(AttachmentId(parsed.id))
            else await this.notes.purgeFolder(FolderTrashEntryId(parsed.id))
            results.push({ key, ok: true })
          } catch (e) {
            results.push({ key, ok: false, error: String(e instanceof Error ? e.message : e) })
          }
        }
        return summarizeBatch(results)
      }
      case 'createNote': {
        const rec = await this.notes.create({ relativePath: String(args.relativePath), markdown: String(args.markdown) })
        return { noteId: String(rec.noteId), relativePath: rec.relativePath, title: rec.title }
      }
      case 'saveNote': {
        const rec = await this.notes.update(NoteId(String(args.noteId)), String(args.markdown), noteWriteOptions(args))
        return { noteId: String(rec.noteId), updatedAt: rec.updatedAt, observedRevision: rec.observedRevision, contentHash: rec.contentHash }
      }
      case 'saveNoteBody': {
        // Live editor only edits the body; the Host re-attaches the preserved
        // frontmatter (stable id) so the editor never owns it.
        const noteId = NoteId(String(args.noteId))
        const doc = await this.notes.getDocument(noteId)
        const { frontmatterRaw } = splitFrontmatter(doc.markdown)
        const body = String(args.body)
        const markdown = frontmatterRaw === '' ? body : `${frontmatterRaw}\n${body}`
        const options = noteWriteOptions(args)
        const rec = await this.notes.update(noteId, markdown, {
          expectedRevision: options.expectedRevision ?? doc.note.observedRevision,
          expectedContentHash: options.expectedContentHash ?? noteContentHash(doc.markdown),
        })
        return { noteId: String(rec.noteId), updatedAt: rec.updatedAt, observedRevision: rec.observedRevision, contentHash: rec.contentHash }
      }
      case 'moveNote': {
        const rec = await this.notes.move(NoteId(String(args.noteId)), String(args.relativePath))
        return { noteId: String(rec.noteId), relativePath: rec.relativePath }
      }
      case 'renameNoteTitle': {
        // Title-only inline rename: rewrite the displayed title, preserve NoteId
        // and path. Move stays a separate action (moveNote / folder picker).
        const noteId = NoteId(String(args.noteId))
        const title = String(args.title).trim()
        if (title === '') throw new Error('pkwWeb: empty title')
        const doc = await this.notes.getDocument(noteId)
        const rec = await this.notes.update(noteId, retitleMarkdown(doc.markdown, title), { expectedRevision: doc.note.observedRevision, expectedContentHash: noteContentHash(doc.markdown) })
        return { noteId: String(rec.noteId), relativePath: rec.relativePath, title: rec.title }
      }
      case 'deleteNote': {
        await this.notes.delete(NoteId(String(args.noteId)))
        return { deleted: true }
      }
      case 'restoreNote': {
        const rec = await this.notes.restore(NoteId(String(args.noteId)))
        return { noteId: String(rec.noteId), relativePath: rec.relativePath, deleted: false }
      }
      case 'purgeNote': {
        await this.notes.purge(NoteId(String(args.noteId)))
        return { purged: true }
      }
      case 'listTrash': {
        const snap = await this.syncSnapshot()
        return this.notes.list({ includeDeleted: true })
          .filter(n => n.deletedAt !== undefined)
          .map(n => ({
            noteId: String(n.noteId), relativePath: n.relativePath, folder: folderOf(n.relativePath),
            title: n.title, updatedAt: n.updatedAt, deletedAt: n.deletedAt, deleted: true, canonicalMissing: n.canonicalMissing === true,
            sync: this.syncView('note', String(n.noteId), snap),
          }))
      }
      case 'listTrashAttachments': {
        const snap = await this.syncSnapshot()
        return this.attachments.list({ includeDeleted: true })
          .filter(a => a.deletedAt !== undefined)
          .map(a => ({
            attachmentId: String(a.id), filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes, deletedAt: a.deletedAt, deleted: true,
            sync: this.syncView('attachment', String(a.id), snap),
          }))
      }
      case 'listTrashFolders': return (await this.notes.listTrashFolders()).map(e => ({ trashEntryId: String(e.trashEntryId), originalPath: e.originalPath, deletedAt: e.deletedAt }))
      case 'listAttachments': {
        const snap = await this.syncSnapshot()
        const owners = await this.attachmentOwners()
        return this.attachments.list().map(a => {
          const companion = a.companionNoteId !== undefined ? this.notes.get(a.companionNoteId) : undefined
          const derived = this.sync.getDerivedContent(a.id)
          const ownerNotes = owners.get(String(a.id)) ?? []
          const key = `attachment:${String(a.id)}`
          const mapping = this.sync.getAttachmentMapping(a.id)
          const intent = snap.intents.get(key)
          return {
            attachmentId: String(a.id),
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            observedRevision: a.observedRevision,
            createdAt: a.createdAt,
            deleted: a.deletedAt !== undefined,
            indexable: a.indexable !== false,
            companionNoteId: a.companionNoteId !== undefined ? String(a.companionNoteId) : undefined,
            companionNoteTitle: companion !== undefined && companion.deletedAt === undefined ? companion.title : undefined,
            processingState: this.sync.getAttachmentProcessingState(a.id),
            summary: derived?.summary,
            hasSummary: derived?.summary !== undefined && derived.summary.trim() !== '',
            ownerCount: ownerNotes.length,
            indexed: mapping !== undefined && mapping.knowledgeId !== undefined && mapping.syncState === 'synced',
            pending: snap.dirty.has(key) || activeSyncIntent(intent),
            configuration: snap.configuration,
            intentState: intent?.state,
            error: intent?.lastError,
          }
        })
      }
      case 'attachmentRelatedNotes': {
        const owners = await this.attachmentOwners()
        return owners.get(String(args.attachmentId)) ?? []
      }
      case 'getAttachmentKnowledge': {
        // Remote Attachment Knowledge projection (WeKnora-derived summary).
        const mapping = this.sync.getAttachmentMapping(AttachmentId(String(args.attachmentId)))
        if (mapping === undefined || mapping.knowledgeId === undefined) return { knowledgeId: undefined, parseStatus: undefined, summaryStatus: undefined, description: undefined }
        try {
          const k = await this.weknora.getKnowledge(mapping.knowledgeId)
          return { knowledgeId: mapping.knowledgeId, parseStatus: k.parse_status, summaryStatus: k.summary_status, description: k.description, fileType: k.file_type }
        } catch {
          return { knowledgeId: mapping.knowledgeId, parseStatus: mapping.remoteParseStatus, summaryStatus: undefined, description: undefined }
        }
      }
      case 'reparseAttachmentKnowledge': {
        const mapping = this.sync.getAttachmentMapping(AttachmentId(String(args.attachmentId)))
        if (mapping === undefined || mapping.knowledgeId === undefined) return { reparse: false }
        await this.weknora.reparseKnowledge(mapping.knowledgeId)
        return { reparse: true }
      }
      case 'noteAttachmentSummaries': {
        // Business Knowledge Viewer (Sources) aggregation: for a Note's referenced
        // attachments, surface filename/mime/size + processing state + summary
        // (when available) + owner count. No remote identity is exposed.
        const doc = await this.notes.getDocument(NoteId(String(args.noteId)))
        const owners = await this.attachmentOwners()
        const out: Array<{ attachmentId: string; filename: string; mimeType?: string; sizeBytes?: number; processingState?: string; description?: string; summaryStatus?: string; ownerCount?: number }> = []
        for (const ref of doc.attachments) {
          const rec = this.attachments.get(ref.attachmentId)
          const derived = this.sync.getDerivedContent(ref.attachmentId)
          out.push({
            attachmentId: String(ref.attachmentId),
            filename: rec?.filename ?? '',
            mimeType: rec?.mimeType,
            sizeBytes: rec?.sizeBytes,
            processingState: this.sync.getAttachmentProcessingState(ref.attachmentId),
            description: derived?.summary,
            summaryStatus: derived !== undefined ? 'completed' : undefined,
            ownerCount: (owners.get(String(ref.attachmentId)) ?? []).length,
          })
        }
        return out
      }
      case 'getAttachment': {
        const id = AttachmentId(String(args.attachmentId))
        const rec = this.attachments.get(id)
        if (rec === undefined) throw new Error(`pkwWeb: unknown attachment '${args.attachmentId}'`)
        const companion = rec.companionNoteId !== undefined ? this.notes.get(rec.companionNoteId) : undefined
        const derived = this.sync.getDerivedContent(id)
        const owners = (await this.attachmentOwners()).get(String(id)) ?? []
        const mapping = this.sync.getAttachmentMapping(id)
        const snap = await this.syncSnapshot()
        const key = `attachment:${String(id)}`
        const intent = snap.intents.get(key)
        return {
          attachment: {
            attachmentId: String(rec.id), filename: rec.filename, mimeType: rec.mimeType,
            sizeBytes: rec.sizeBytes, observedRevision: rec.observedRevision, createdAt: rec.createdAt,
            indexable: rec.indexable !== false,
            companionNoteId: rec.companionNoteId !== undefined ? String(rec.companionNoteId) : undefined,
          },
          companionNote: companion !== undefined && companion.deletedAt === undefined
            ? { noteId: String(companion.noteId), relativePath: companion.relativePath, title: companion.title }
            : null,
          processingState: this.sync.getAttachmentProcessingState(id),
          summary: derived?.summary,
          hasSummary: derived?.summary !== undefined && derived.summary.trim() !== '',
          owners,
          ownerCount: owners.length,
          indexed: mapping !== undefined && mapping.knowledgeId !== undefined && mapping.syncState === 'synced',
          pending: snap.dirty.has(key) || activeSyncIntent(intent),
          configuration: snap.configuration,
          intentState: intent?.state,
          error: intent?.lastError,
        }
      }
      case 'downloadAttachment': {
        const id = AttachmentId(String(args.attachmentId))
        const rec = this.attachments.get(id)
        const bytes = await this.attachments.open(id)
        return {
          attachmentId: String(id),
          filename: rec?.filename ?? 'attachment',
          mimeType: rec?.mimeType ?? 'application/octet-stream',
          contentBase64: Buffer.from(bytes).toString('base64'),
        }
      }
      case 'uploadAttachment': {
        const content = Buffer.from(String(args.contentBase64), 'base64')
        const rec = await this.attachments.importFile({
          content,
          // Passed through as it arrived, not coerced: `String(undefined)` is the string
          // "undefined", and that is how an upload with no filename came to be stored, indexed and
          // served under that literal name. The attachments service is the place that decides
          // whether a name is usable.
          filename: args.filename as string,
          mimeType: String(args.mimeType),
          ...(args.indexable !== undefined ? { indexable: args.indexable === true } : {}),
          ...(args.knowledgeMode === 'note-scoped' || args.knowledgeMode === 'local-only' ? { knowledgeMode: args.knowledgeMode as 'note-scoped' | 'local-only' } : {}),
          ...(args.ownerNoteId !== undefined && args.ownerNoteId !== null && args.ownerNoteId !== '' ? { ownerNoteId: NoteId(String(args.ownerNoteId)) } : {}),
        })
        return { attachmentId: String(rec.id), filename: rec.filename, sizeBytes: rec.sizeBytes }
      }
      case 'setCompanionNote': {
        await this.attachments.setCompanionNote(AttachmentId(String(args.attachmentId)), args.noteId !== undefined && args.noteId !== null ? NoteId(String(args.noteId)) : null)
        return { ok: true }
      }
      case 'getCompanionNote': {
        const rec = this.attachments.get(AttachmentId(String(args.attachmentId)))
        if (rec === undefined || rec.companionNoteId === undefined) return null
        const note = this.notes.get(rec.companionNoteId)
        if (note === undefined || note.deletedAt !== undefined) return null
        return { noteId: String(note.noteId), relativePath: note.relativePath, title: note.title }
      }
      case 'createCompanionNote': {
        // Idempotent, local-first orchestration. If a durable Companion relation
        // already exists it is returned as-is; otherwise the note is created and
        // the AttachmentRecord.companionNoteId is persisted. Never waits on WeKnora.
        const id = AttachmentId(String(args.attachmentId))
        const folder = args.folder !== undefined ? String(args.folder) : ''
        return this.ensureCompanionNote(id, folder)
      }
      case 'upgradeCompanionNote': {
        // Explicitly promote an attachment-backed Companion Note to an independent
        // Note Knowledge (so user-authored companion text becomes searchable).
        // Never auto-upgraded: this is a user-triggered, durable decision.
        const noteId = NoteId(String(args.noteId))
        await this.notes.setAttachmentBacked(noteId, false)
        await this.sync.syncNote(noteId)
        return { upgraded: true, noteId: String(noteId) }
      }
      case 'deleteAttachment': {
        await this.attachments.remove(AttachmentId(String(args.attachmentId)))
        return { deleted: true }
      }
      case 'restoreAttachment': {
        const rec = await this.attachments.restore(AttachmentId(String(args.attachmentId)))
        return { attachmentId: String(rec.id), filename: rec.filename, deleted: false }
      }
      case 'purgeAttachment': {
        await this.attachments.purge(AttachmentId(String(args.attachmentId)))
        return { purged: true }
      }
      case 'search': {
        const query = String(args.query ?? '').trim()
        if (query.length > 200) throw new Error('检索问题请控制在 200 个字符以内')
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 10
        if (!query) return { results: [], mode: 'local-keyword' }
        if (args.mode === 'local' || await this.syncConfiguration() !== 'configured') return this.searchLocal(query, limit)
        try {
          const { results, trace } = await this.sync.searchWithTrace(query, { limit })
          return { results: this.enrichRetrievalResults(results), trace, mode: 'remote', ...(trace.processingUnavailable ? { warning: '部分附件正文检索暂时不可用。以下结果来自当前可用的索引，不能据此断定附件中没有相关内容。' } : {}) }
        } catch { return this.searchLocal(query, limit) }
      }
      case 'listKnowledge': return this.listKnowledge()
      case 'relatedKnowledge': return this.relatedKnowledge(String(args.noteId))
      case 'syncEntity': {
        const entityType = String(args.entityType)
        if (entityType === 'note') {
          await this.sync.syncNote(NoteId(String(args.entityId)))
        } else if (entityType === 'attachment') {
          await this.sync.syncAttachment(AttachmentId(String(args.entityId)))
        } else {
          throw new Error(`pkwWeb: unknown entity type '${entityType}'`)
        }
        return { synced: true }
      }
      case 'syncNow': return this.sync.drain().then(() => ({ drained: true }))
      case 'reconcileProcessing': return this.sync.reconcileNonTerminalAttachments().then(n => ({ reconciled: n }))
      case 'reconcile': {
        const notesRep = await this.notes.reconcile()
        const attRep = await this.attachments.reconcile()
        const syncRep = await this.sync.reconcile()
        return {
          notesDecisions: notesRep.decisions.length,
          notesRepaired: notesRep.repairedProjections,
          attachmentsDecisions: attRep.decisions.length,
          attachmentsRepaired: attRep.repairedProjections,
          markedDirty: syncRep.markedDirty,
          markedDeleted: syncRep.markedDeleted,
        }
      }
      case 'noteSyncInfo': {
        const mapping = this.sync.getMapping(NoteId(String(args.noteId)))
        return mapping ?? null
      }
      case 'getTree': return this.tree(typeof args.sortMode === 'string' ? args.sortMode : 'manual')
      case 'listFolders': return this.notes.listFolders()
      case 'createFolder': {
        await this.notes.createFolder(String(args.path))
        return { created: true }
      }
      case 'renameFolder': {
        await this.notes.renameFolder(String(args.path), String(args.newPath))
        return { renamed: true }
      }
      case 'deleteFolder': {
        await this.notes.deleteFolder(String(args.path))
        return { deleted: true }
      }
      case 'trashFolder': {
        const e = await this.notes.trashFolder(String(args.path))
        return { trashed: true, trashEntryId: String(e.trashEntryId), originalPath: e.originalPath }
      }
      case 'restoreFolder': {
        await this.notes.restoreFolder(FolderTrashEntryId(String(args.trashEntryId)))
        return { restored: true }
      }
      case 'purgeFolder': {
        await this.notes.purgeFolder(FolderTrashEntryId(String(args.trashEntryId)))
        return { purged: true }
      }
      case 'setOrder': {
        const children = Array.isArray(args.children) ? args.children as Array<{ kind: string; id: string }> : []
        await this.notes.setOrder(String(args.parentPath), children.map(c => ({ kind: c.kind === 'folder' ? 'folder' : 'note', id: c.id })))
        return { ordered: true }
      }
      // ── tasks ─────────────────────────────────────────────────────────────
      case 'listMatrices': return this.tasks.listMatrices({ includeArchived: args.includeArchived === true })
      case 'createMatrix': return this.tasks.createMatrix({ name: String(args.name), ...(args.description !== undefined ? { description: String(args.description) } : {}), ...(args.icon !== undefined ? { icon: String(args.icon) } : {}), ...(args.color !== undefined ? { color: String(args.color) } : {}) })
      case 'renameMatrix': return this.tasks.renameMatrix(TaskMatrixId(String(args.matrixId)), String(args.name))
      case 'archiveMatrix': return this.tasks.archiveMatrix(TaskMatrixId(String(args.matrixId))).then(() => ({ archived: true }))
      case 'reassignMatrixTasks': return this.tasks.reassignMatrixTasks(TaskMatrixId(String(args.matrixId)), args.toMatrixId !== undefined && args.toMatrixId !== null ? TaskMatrixId(String(args.toMatrixId)) : null)
      case 'removeMatrix': {
        const matrixId = TaskMatrixId(String(args.matrixId))
        // Explicit product contract: taskDisposition carries the intent (never null/undefined).
        if (args.taskDisposition === 'delete-tasks') {
          const r = await this.tasks.removeMatrixWithTasks(matrixId)
          return { removed: r.removed, moved: 0, deleted: r.deleted }
        }
        if (args.taskDisposition === 'move-to-inbox') {
          const r = await this.tasks.removeMatrix(matrixId, { reassignTo: null })
          return { removed: r.removed, moved: r.moved, deleted: 0 }
        }
        // Backward-compatible reassignTo path (legacy callers only).
        const opts = args.reassignTo === undefined ? {} : { reassignTo: args.reassignTo === null ? null : TaskMatrixId(String(args.reassignTo)) }
        return this.tasks.removeMatrix(matrixId, opts)
      }
      case 'listTasks': return this.tasks.listTasks({
        ...(args.matrixId !== undefined ? { matrixId: args.matrixId === null ? null : TaskMatrixId(String(args.matrixId)) } : {}),
        ...(args.status !== undefined ? { status: String(args.status) as never } : {}),
        includeDeleted: args.includeDeleted === true,
      }).map(task => ({ ...task, contentHash: taskContentHash(task) }))
      case 'listTrashTasks': return this.tasks.listTasks({ includeDeleted: true }).filter(task => task.deletedAt !== undefined).map(task => ({ ...task, contentHash: taskContentHash(task) }))
      case 'listSubtasks': return this.tasks.listSubtasks(TaskId(String(args.parentTaskId))).map(task => ({ ...task, contentHash: taskContentHash(task) }))
      case 'createTask': return this.tasks.createTask({
        title: String(args.title),
        ...(args.matrixId !== undefined && args.matrixId !== null ? { matrixId: TaskMatrixId(String(args.matrixId)) } : {}),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        ...(args.important !== undefined ? { important: args.important === true } : {}),
        ...(args.urgent !== undefined ? { urgent: args.urgent === true } : {}),
        ...(args.priority !== undefined ? { priority: Number(args.priority) } : {}),
        ...(args.dueAt !== undefined ? { dueAt: String(args.dueAt) } : {}),
        ...(args.parentTaskId !== undefined && args.parentTaskId !== null ? { parentTaskId: TaskId(String(args.parentTaskId)) } : {}),
        ...(args.tags !== undefined ? { tags: Array.isArray(args.tags) ? args.tags.map(String) : [] } : {}),
        ...(args.sourceRefs !== undefined ? { sourceRefs: Array.isArray(args.sourceRefs) ? args.sourceRefs : [] } : {}),
      })
      case 'updateTask': {
        if (args.expectedContentHash !== undefined && (typeof args.expectedContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedContentHash))) throw new Error('Invalid expectedContentHash')
        const task = await this.tasks.updateTask(TaskId(String(args.taskId)), (args.patch ?? {}) as never, { expectedContentHash: args.expectedContentHash as string | undefined })
        return { ...task, contentHash: taskContentHash(task) }
      }
      case 'completeTask': return this.tasks.completeTask(TaskId(String(args.taskId)))
      case 'reopenTask': return this.tasks.reopenTask(TaskId(String(args.taskId)))
      case 'moveTaskToMatrix': return this.tasks.moveTaskToMatrix(TaskId(String(args.taskId)), args.matrixId !== undefined && args.matrixId !== null ? TaskMatrixId(String(args.matrixId)) : null)
      case 'reorderTasks': return this.tasks.reorderTasks(Array.isArray(args.taskIds) ? args.taskIds.map((id: unknown) => TaskId(String(id))) : [])
      case 'deleteTask': return this.tasks.deleteTask(TaskId(String(args.taskId))).then(() => ({ deleted: true }))
      case 'restoreTask': return this.tasks.restoreTask(TaskId(String(args.taskId)))
      default: throw new Error(`unknown pkw method: ${method}`)
    }
  }

  /** Nested notes folder tree with per-parent ordering + per-note sync views. */
  private async tree(sortMode: string): Promise<unknown> {
    const snap = await this.syncSnapshot()
    const notes = this.notes.list().map(n => ({
      kind: 'note' as const,
      noteId: String(n.noteId),
      relativePath: n.relativePath,
      folder: folderOf(n.relativePath),
      title: n.title,
      updatedAt: n.updatedAt,
      observedRevision: n.observedRevision,
      deleted: n.deletedAt !== undefined,
      sync: this.syncView('note', String(n.noteId), snap),
    }))
    const folders = await this.notes.listFolders()

    const childrenByParent = new Map<string, TreeChild[]>()
    for (const f of folders) {
      const parent = folderOf(f)
      const name = posix.basename(f)
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
      childrenByParent.get(parent)!.push({ kind: 'folder', id: name, name, path: f })
    }
    for (const n of notes) {
      const parent = n.folder
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
      childrenByParent.get(parent)!.push({
        kind: 'note',
        id: n.noteId,
        name: n.title || n.relativePath,
        path: n.relativePath,
        updatedAt: n.updatedAt,
        note: { noteId: n.noteId, relativePath: n.relativePath, folder: n.folder, title: n.title, updatedAt: n.updatedAt, observedRevision: n.observedRevision, deleted: n.deleted, sync: n.sync },
      })
    }

    const build = (parentPath: string): unknown[] => {
      const children = childrenByParent.get(parentPath) ?? []
      const ordered = applyOrder(children, this.notes.getOrder(parentPath), sortMode)
      return ordered.map(c => c.kind === 'folder'
        ? { kind: 'folder', name: c.name, path: c.path, children: build(c.path!) }
        : { kind: 'note', ...c.note })
    }
    return { root: build('') }
  }

  /** Latest operation per entity, including terminal failures, plus dirty keys. */
  private async searchLocal(query: string, limit: number): Promise<unknown> {
    const documents: LocalDocument[] = []
    const notes = this.notes.list()
    let skipped = 0
    for (const note of notes.slice(0, 5000)) {
      try {
        const doc = await this.notes.getDocument(note.noteId)
        documents.push({ id: String(note.noteId), kind: 'note', title: doc.note.title, path: doc.note.relativePath, content: splitFrontmatter(doc.markdown).body })
      } catch { skipped++ }
    }
    for (const attachment of this.attachments.list().slice(0, 5000)) {
      // Companion-backed files already have a discoverable canonical note.
      if (attachment.companionNoteId && this.notes.get(attachment.companionNoteId)?.deletedAt === undefined && this.notes.get(attachment.companionNoteId)) continue
      documents.push({ id: String(attachment.id), kind: 'attachment', title: attachment.filename, content: attachment.filename })
    }
    const results = localKeywordSearch(query, documents, limit)
    return { results, mode: 'local-keyword', warning: '当前使用本空间的本地关键词检索，范围为笔记正文和附件文件名；不包含附件内部全文或语义检索。' + (skipped || notes.length > 5000 || this.attachments.list().length > 5000 ? ' 部分资料未纳入本次检索，请检查文件状态或缩小资料范围。' : ''), trace: { mode: 'local-keyword', scanned: documents.length, skipped, final: results.length } }
  }

  private async syncSnapshot(configuration?: SyncConfiguration): Promise<SyncSnapshot> {
    const currentConfiguration = configuration ?? await this.syncConfiguration()
    const intents = new Map<string, { state: string; lastError?: string }>()
    const timestamps = new Map<string, { createdAt: string; updatedAt: string }>()
    for (const intent of this.sync.listIntents()) {
      const key = `${intent.entityType}:${intent.entityId}`
      const previous = timestamps.get(key)
      if (previous && (previous.createdAt > intent.createdAt ||
        (previous.createdAt === intent.createdAt && previous.updatedAt > intent.updatedAt))) continue
      timestamps.set(key, intent)
      const failed = ['unknown', 'retryable', 'permanent'].includes(intent.state)
      intents.set(key, { state: intent.state, lastError: failed ? intent.lastError : undefined })
    }
    const dirty = new Set<string>()
    for (const rec of this.sync.listDirty()) if (rec.dirty) dirty.add(`${rec.entityType}:${rec.entityId}`)
    return { intents, dirty, configuration: currentConfiguration }
  }

  /** UI-facing per-entity sync view (mapping + pending/error, no raw table shapes). */
  private syncView(entityType: string, entityId: string, snap: SyncSnapshot): Record<string, unknown> {
    const mapping = entityType === 'note'
      ? this.sync.getMapping(NoteId(entityId))
      : this.sync.getAttachmentMapping(AttachmentId(entityId))
    const key = `${entityType}:${entityId}`
    const intent = snap.intents.get(key)
    return {
      kbId: this.config.kbId,
      knowledgeId: mapping?.knowledgeId,
      syncState: mapping?.syncState,
      remoteParseStatus: mapping?.remoteParseStatus,
      updatedAt: mapping?.updatedAt,
      pending: snap.dirty.has(key) || activeSyncIntent(intent),
      configuration: snap.configuration,
      intentState: intent?.state,
      error: intent?.lastError,
    }
  }

  /**
   * User-facing retrieval projection: keep only the leaf fields the UI needs and
   * enrich local hits with stable PKW identity (title / path / folder). Internal
   * WeKnora ids (kbId / knowledgeId / chunkId) never cross the RPC boundary.
   */
  private enrichRetrievalResults(results: RetrievalResult[]): unknown[] {
    const out: unknown[] = []
    for (const r of results) {
      // Best evidence: top 2 distinct cleaned snippets from the aggregated chunks.
      const evidenceSnippets: string[] = []
      if (r.evidence !== undefined && r.evidence.length > 0) {
        const sorted = r.evidence.slice().sort((a, b) => b.score - a.score)
        for (const ev of sorted) {
          const s = plainTextSnippet(ev.content, 200)
          if (s !== '' && !evidenceSnippets.includes(s)) evidenceSnippets.push(s)
          if (evidenceSnippets.length >= 2) break
        }
      }
      const remote = {
        content: r.remote.content,
        snippet: plainTextSnippet(r.remote.content, 220),
        bestEvidence: evidenceSnippets,
        title: r.remote.title,
        filename: r.remote.filename,
        score: r.remote.score,
      }
      if (r.local === undefined) { if (this.basePath === '/pkw') out.push({ remote }); continue }
      // Stale-result guard: a remote hit whose local entity no longer exists (deleted
      // or archived) must NOT surface as a Business Knowledge result. The async
      // remote delete will eventually converge; until then, drop it here.
      if (r.local.entityType === 'note') {
        const n = this.notes.get(NoteId(r.local.entityId))
        if (n === undefined || n.deletedAt !== undefined) continue
      } else if (r.local.entityType === 'attachment') {
        const a = this.attachments.get(AttachmentId(r.local.entityId))
        if (a === undefined || a.deletedAt !== undefined) continue
      }
      const local: Record<string, unknown> = {
        entityType: r.local.entityType,
        entityId: r.local.entityId,
        matchReason: r.local.matchReason,
        matchedAttachmentId: r.local.matchedAttachmentId,
        companionNoteId: r.local.companionNoteId,
      }
      if (r.local.entityType === 'note') {
        const n = this.notes.get(NoteId(r.local.entityId))
        if (n !== undefined) { local.title = n.title; local.relativePath = n.relativePath; local.folder = folderOf(n.relativePath) }
      } else if (r.local.entityType === 'attachment') {
        const a = this.attachments.get(AttachmentId(r.local.entityId))
        if (a !== undefined) local.title = a.filename
        if (r.local.companionNoteId !== undefined) {
          const cn = this.notes.get(NoteId(r.local.companionNoteId))
          if (cn !== undefined) { local.title = cn.title; local.relativePath = cn.relativePath; local.folder = folderOf(cn.relativePath) }
        }
      }
      out.push({ remote, local })
    }
    return out
  }

  /**
   * Knowledge Discovery list: one discoverable Business Knowledge object per
   * local Note, with a real summary (attachment-derived when available, else a
   * body snippet) and user-facing fields only. Fully offline-safe (no WeKnora).
   */
  private async listKnowledge(): Promise<unknown[]> {
    const snap = await this.syncSnapshot()
    const out: unknown[] = []
    for (const n of this.notes.list()) {
      const doc = await this.notes.getDocument(n.noteId)
      let summary: string | undefined
      for (const ref of doc.attachments) {
        const derived = this.sync.getDerivedContent(ref.attachmentId)
        if (derived?.summary !== undefined && derived.summary.trim() !== '') { summary = derived.summary; break }
      }
      const mapping = this.sync.getMapping(n.noteId)
      const intent = snap.intents.get(`note:${String(n.noteId)}`)
      out.push({
        noteId: String(n.noteId),
        title: n.title,
        relativePath: n.relativePath,
        folder: folderOf(n.relativePath),
        tags: n.tags,
        updatedAt: n.updatedAt,
        attachmentBacked: n.attachmentBacked === true,
        attachmentCount: doc.attachments.length,
        summary: summary ?? markdownSnippet(doc.markdown),
        indexed: mapping !== undefined && mapping.knowledgeId !== undefined && mapping.syncState === 'synced',
        pending: snap.dirty.has(`note:${String(n.noteId)}`) || activeSyncIntent(intent),
        configuration: snap.configuration,
        intentState: intent?.state,
        error: intent?.lastError,
      })
    }
    return out
  }

  /**
   * Related Knowledge (lightweight, reads existing WeKnora Wiki graph relations —
   * no new recommendation system). Maps graph neighbors back to local Notes by
   * title. Gracefully degrades to [] when the graph is empty or WeKnora offline.
   */
  private async relatedKnowledge(noteId: string): Promise<unknown[]> {
    const note = this.notes.get(NoteId(noteId))
    if (note === undefined) return []
    let graph: { nodes: Array<{ slug: string; title: string }>; edges: Array<{ source: string; target: string }> }
    try {
      graph = await this.weknora.getWikiGraph(this.config.kbId, { mode: 'overview', limit: 500 })
    } catch {
      return [] // WeKnora offline: related knowledge is optional, never blocks the Note.
    }
    const nodes = graph.nodes ?? []
    const edges = graph.edges ?? []
    if (nodes.length === 0 || edges.length === 0) return []
    const byTitle = new Map<string, string>() // normalized title → slug
    for (const node of nodes) byTitle.set(node.title.trim().toLowerCase(), node.slug)
    const norm = (s: string) => s.trim().toLowerCase()
    const selfSlug = byTitle.get(norm(note.title)) ?? nodes.find(node => node.title === note.title)?.slug
    if (selfSlug === undefined) return []
    const neighborTitles = new Set<string>()
    for (const e of edges) {
      if (e.source === selfSlug) neighborTitles.add(e.target)
      else if (e.target === selfSlug) neighborTitles.add(e.source)
    }
    // Resolve neighbor slugs → wiki titles → local notes (title match, stable NoteId).
    const slugTitle = new Map<string, string>()
    for (const node of nodes) slugTitle.set(node.slug, node.title)
    const byLocalTitle = new Map<string, { noteId: string; title: string }>()
    for (const n of this.notes.list()) byLocalTitle.set(n.title.trim().toLowerCase(), { noteId: String(n.noteId), title: n.title })
    const out: Array<{ noteId: string; title: string }> = []
    const seen = new Set<string>()
    for (const slug of neighborTitles) {
      const title = slugTitle.get(slug)
      if (title === undefined) continue
      const local = byLocalTitle.get(norm(title))
      if (local === undefined || local.noteId === noteId || seen.has(local.noteId)) continue
      seen.add(local.noteId)
      out.push(local)
      if (out.length >= 5) break
    }
    return out
  }

  /**
   * Note↔Attachment relation (derived from canonical Markdown, no structural
   * table): attachmentId → referencing Notes. One pass over the Notes registry;
   * used for owner counts, "used by" lists, and isolated-attachment detection.
   */
  private async attachmentOwners(): Promise<Map<string, Array<{ noteId: string; title: string }>>> {
    const map = new Map<string, Array<{ noteId: string; title: string }>>()
    for (const n of this.notes.list()) {
      const doc = await this.notes.getDocument(n.noteId)
      for (const ref of doc.attachments) {
        const key = String(ref.attachmentId)
        let arr = map.get(key)
        if (arr === undefined) { arr = []; map.set(key, arr) }
        arr.push({ noteId: String(n.noteId), title: n.title })
      }
    }
    return map
  }

  /**
   * Reading-mode Markdown with Managed Source projection: Lute-render, then
   * transform managed file links (`attachments/<id>/<file>`) into rich source
   * blocks (icon + filename + type · size · processing state + preview).
   * Images stay inline (already resolved to /pkw/attachment/<id>). Canonical
   * Markdown is never mutated.
   */
  private async renderNoteMarkdown(markdown: string, noteId: string): Promise<string> {
    const html = await renderMarkdownToHtml(markdown, this.basePath)
    const doc = await this.notes.getDocument(NoteId(noteId)).catch(() => undefined)
    if (doc === undefined) return html
    const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
    const stateLabel: Record<string, string> = { waiting: '等待解析', processing: '解析中', optimizing: '优化索引中', ready: '已解析', failed: '解析失败' }
    let out = html
    for (const ref of doc.attachments) {
      const rec = this.attachments.get(ref.attachmentId)
      if (rec === undefined || (rec.mimeType ?? '').indexOf('image/') === 0) continue
      const id = String(ref.attachmentId)
      const href = this.basePath + '/attachment/' + encodeURIComponent(id)
      const re = new RegExp('<a[^>]*href="' + href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>[^<]*</a>', 'g')
      const parts: string[] = []
      parts.push((rec.mimeType ?? '').split('/').pop() ?? '')
      if (rec.sizeBytes !== undefined) parts.push(rec.sizeBytes < 1024 ? rec.sizeBytes + ' B' : rec.sizeBytes < 1024 * 1024 ? (rec.sizeBytes / 1024).toFixed(1) + ' KB' : (rec.sizeBytes / 1024 / 1024).toFixed(1) + ' MB')
      parts.push(stateLabel[this.sync.getAttachmentProcessingState(ref.attachmentId)] ?? '')
      const sub = parts.filter(Boolean).join(' · ')
      const block = '<span class="src-block"><span class="src-ic">📄</span><span class="src-meta"><span class="src-name">' + esc(rec.filename) + '</span>' +
        (sub !== '' ? '<span class="src-sub">' + esc(sub) + '</span>' : '') +
        '</span><a class="src-act" href="' + href + '/preview" target="_blank" rel="noopener">预览</a><a class="src-act" href="' + href + '" download>下载</a></span>'
      out = out.replace(re, block)
    }
    return out
  }

  /** Local capability metadata only; failures must never block canonical reads. */
  private async syncConfiguration(): Promise<SyncConfiguration> {
    if (this.config.kbId.trim() === '') return 'missing_kb'
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Credential providers may be asynchronous or stuck. Their diagnostics
      // must not indefinitely delay local Note/Attachment reads.
      return await Promise.race([
        this.weknora.credentialStatus(),
        new Promise<SyncConfiguration>(resolve => { timer = setTimeout(() => resolve('unavailable'), 300) }),
      ])
    } catch { return 'unavailable' }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }

  private async summary(): Promise<unknown> {
    const configuration = await this.syncConfiguration()
    const credential = configuration
    const integration = configuration === 'configured' ? 'ready' : 'unavailable'
    let pendingSync = 0
    for (const rec of this.sync.listDirty()) if (rec.dirty) pendingSync += 1
    let syncErrors = 0
    for (const intent of (await this.syncSnapshot(configuration)).intents.values()) {
      if (intent.state === 'retryable' || intent.state === 'unknown' || intent.state === 'permanent') syncErrors += 1
    }
    const notes = this.notes.list()
    const attachments = this.attachments.list()
    const recent = [
      ...notes.map(n => ({ kind: 'note' as const, id: String(n.noteId), title: n.title, updatedAt: n.updatedAt })),
      ...attachments.map(a => ({ kind: 'attachment' as const, id: String(a.id), title: a.filename, updatedAt: a.indexedAt })),
    ].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8)
    return {
      workspaceId: this.workspaceId,
      workspaceName: this.workspaceName,
      workspacePath: this.config.workspacePath,
      kbId: this.config.kbId,
      weknoraBaseUrl: this.config.weknoraBaseUrl,
      credential: credential,
      configuration,
      integration: integration,
      notes: notes.length,
      attachments: attachments.length,
      mappings: this.sync.listMappings().length,
      pendingSync,
      syncErrors,
      recent,
    }
  }

  /**
   * Idempotent Companion Note orchestration (local-first). Returns the existing
   * note when a durable relation already exists; otherwise derives a collision-free
   * path from the STORED filename (never the raw upload name), creates the note,
   * persists `companionNoteId`, and returns the new note. No WeKnora dependency.
   */
  private async ensureCompanionNote(id: AttachmentId, folder: string): Promise<{ noteId: string; relativePath: string; title: string; created: boolean; attachmentBacked: boolean }> {
    const rec = this.attachments.get(id)
    if (rec === undefined) throw new Error(`pkwWeb: unknown attachment '${id}'`)
    if (rec.companionNoteId !== undefined) {
      const existing = this.notes.get(rec.companionNoteId)
      if (existing !== undefined && existing.deletedAt === undefined) {
        return { noteId: String(existing.noteId), relativePath: existing.relativePath, title: existing.title, created: false, attachmentBacked: existing.attachmentBacked === true }
      }
    }
    const base = sanitizeNoteBase(filenameStem(rec.filename))
    const existingPaths = new Set<string>()
    for (const n of this.notes.list({ includeDeleted: true })) existingPaths.add(n.relativePath)
    const notePath = uniqueNotePath(folder, base, existingPaths)
    const markdown = companionNoteMarkdown(base, String(rec.id), rec.filename, rec.mimeType)
    // Attachment-backed Companion Note: local canonical note only. It does NOT
    // create an independent remote Note Knowledge (avoids the duplicate WeKnora
    // card). The Attachment Knowledge is the single remote projection.
    const created = await this.notes.create({ relativePath: notePath, markdown, attachmentBacked: true })
    await this.attachments.setCompanionNote(rec.id, created.noteId)
    return { noteId: String(created.noteId), relativePath: created.relativePath, title: created.title, created: true, attachmentBacked: true }
  }
}

export default PkwWebService

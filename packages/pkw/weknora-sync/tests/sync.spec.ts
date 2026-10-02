import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { WeKnoraError, canonicalizeRemoteManualContent, redactSecrets } from '@deepseek-ai/dsh-pkw-weknora'
import { NoteId, stripInternalFrontmatter } from '@deepseek-ai/dsh-pkw-domain'
import PkwEventStoreService from '../../events/src/index.ts'
import PkwWorkspaceService from '../../workspace/src/index.ts'
import NotesService from '../../notes/src/index.ts'
import AttachmentsService from '../../attachments/src/index.ts'
import WeKnoraClient from '../../weknora/src/index.ts'
import WeKnoraSyncService, { mapWeKnoraProcessingPhase, weKnoraKnowledgePhase } from '../src/index.ts'
import { classifyOutcome } from '../src/outcome.ts'

const dirs: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(c => c.fiber.dispose().catch(() => {})))
    await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))))
    await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
  } finally { vi.useRealTimers() }
})

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
function md5Hex(b: Uint8Array): string {
  return createHash('md5').update(b).digest('hex')
}

// ── stateful fake WeKnora ─────────────────────────────────────────────────────

interface ManualRec { id: string; title: string; content: string; parseStatus: string }
interface FileRec { id: string; title: string; filename: string; fileHash: string; parseStatus: string; content: Buffer; summary?: string; summaryStatus?: string }

interface FakeWeKnora {
  baseUrl: string
  manuals: Map<string, ManualRec>
  files: Map<string, FileRec>
  listPageSize: number
  hidden: Set<string>
  manualUpdateApplications: number
  manualContentReads: number
  /** One-shot request barrier, before the PUT is applied or its response lost. */
  manualUpdateGate?: { entered: () => void; release: Promise<void> }
  /** One-shot failure behaviors, cleared after the matching request. */
  next: {
    commitThenDrop?: 'create-manual' | 'update-manual' | 'upload'
    dropBeforeRead?: 'create-manual' | 'upload'
    respond?: { status: number; body: unknown }
  }
}

function parseMultipart(contentType: string, body: Buffer): { fields: Map<string, string>; file?: { filename: string; contentType: string; data: Buffer } } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[1] ?? /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[2]
  const out: { fields: Map<string, string>; file?: { filename: string; contentType: string; data: Buffer } } = { fields: new Map() }
  if (boundary === undefined) return out
  const marker = Buffer.from(`--${boundary}`)
  const parts: Buffer[] = []
  let idx = 0
  for (;;) {
    const start = body.indexOf(marker, idx)
    if (start === -1) break
    const end = body.indexOf(marker, start + marker.length)
    if (end === -1) break
    parts.push(body.subarray(start + marker.length, end))
    idx = end
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const header = part.subarray(0, headerEnd).toString('utf8')
    let data = part.subarray(headerEnd + 4)
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) data = data.subarray(0, data.length - 2)
    const name = /Content-Disposition: form-data; name="([^"]+)"/i.exec(header)?.[1]
    if (name === 'file') {
      const filename = /filename="([^"]*)"/i.exec(header)?.[1] ?? 'file'
      const ct = /Content-Type: ([^\r\n]+)/i.exec(header)?.[1]?.trim() ?? 'application/octet-stream'
      out.file = { filename, contentType: ct, data }
    } else if (name !== undefined) {
      out.fields.set(name, data.toString('utf8'))
    }
  }
  return out
}

function startFakeServer(): Promise<FakeWeKnora> {
  const fake: FakeWeKnora = {
    baseUrl: '',
    manuals: new Map(),
    files: new Map(),
    listPageSize: 1,
    hidden: new Set(),
    manualUpdateApplications: 0,
    manualContentReads: 0,
    next: {},
  }
  let counter = 0
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://x')
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const readBody = async (): Promise<Buffer> => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        return Buffer.concat(chunks)
      }

      // One-shot failure gates.
      if (fake.next.dropBeforeRead !== undefined) {
        const kind = fake.next.dropBeforeRead
        const matches = (kind === 'create-manual' && req.method === 'POST' && /\/knowledge-bases\/[^/]+\/knowledge\/manual$/.test(url.pathname))
          || (kind === 'upload' && req.method === 'POST' && /\/knowledge-bases\/[^/]+\/knowledge\/file$/.test(url.pathname))
        if (matches) {
          fake.next.dropBeforeRead = undefined
          res.socket?.destroy()
          return
        }
      }

      // Manual create.
      if (req.method === 'POST' && /\/knowledge-bases\/[^/]+\/knowledge\/manual$/.test(url.pathname)) {
        const body = JSON.parse((await readBody()).toString('utf8')) as { title: string; content: string }
        const id = `kn-${++counter}`
        fake.manuals.set(id, { id, title: body.title, content: body.content, parseStatus: 'pending' })
        if (fake.next.respond !== undefined) {
          const r = fake.next.respond; fake.next.respond = undefined
          send(r.status, r.body)
          return
        }
        if (fake.next.commitThenDrop === 'create-manual') {
          fake.next.commitThenDrop = undefined
          res.socket?.destroy()
          return
        }
        send(200, { data: { id, title: body.title, parse_status: 'pending' } })
        return
      }

      // Manual update.
      const up = /\/knowledge\/manual\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'PUT' && up) {
        const body = JSON.parse((await readBody()).toString('utf8')) as { title: string; content: string }
        const existing = fake.manuals.get(up[1]!)
        if (existing === undefined) { res.writeHead(404); res.end('{}'); return }
        const gate = fake.manualUpdateGate
        fake.manualUpdateGate = undefined
        if (gate) { gate.entered(); await gate.release }
        fake.manualUpdateApplications++
        existing.content = body.content; existing.title = body.title
        if (fake.next.respond !== undefined) {
          const r = fake.next.respond; fake.next.respond = undefined
          send(r.status, r.body)
          return
        }
        if (fake.next.commitThenDrop === 'update-manual') {
          fake.next.commitThenDrop = undefined
          res.socket?.destroy()
          return
        }
        send(200, { data: { id: up[1]!, title: body.title, parse_status: 'pending' } })
        return
      }

      // File upload.
      if (req.method === 'POST' && /\/knowledge-bases\/[^/]+\/knowledge\/file$/.test(url.pathname)) {
        const contentType = req.headers['content-type'] ?? ''
        const raw = await readBody()
        const { file } = parseMultipart(contentType, raw)
        if (file === undefined) { send(400, { code: 'bad_request' }); return }
        const fileHash = md5Hex(file.data)
        const existing = [...fake.files.values()].find(f => f.fileHash === fileHash)
        if (existing !== undefined) {
          send(409, { success: false, code: 'duplicate_file', message: 'duplicate', data: { id: existing.id, title: existing.title, file_name: existing.filename, file_hash: existing.fileHash, parse_status: existing.parseStatus } })
          return
        }
        const id = `kn-${++counter}`
        fake.files.set(id, { id, title: file.filename, filename: file.filename, fileHash, parseStatus: 'pending', content: file.data })
        if (fake.next.respond !== undefined) {
          const r = fake.next.respond; fake.next.respond = undefined
          send(r.status, r.body)
          return
        }
        if (fake.next.commitThenDrop === 'upload') {
          fake.next.commitThenDrop = undefined
          res.socket?.destroy()
          return
        }
        send(200, { data: { id, title: file.filename, file_name: file.filename, file_hash: fileHash, parse_status: 'pending' } })
        return
      }

      // Download (manual content or file bytes).
      const dl = /\/knowledge\/([^/]+)\/download$/.exec(url.pathname)
      if (req.method === 'GET' && dl) {
        const m = fake.manuals.get(dl[1]!)
        if (m !== undefined) { fake.manualContentReads++; res.writeHead(200, { 'Content-Type': 'text/markdown' }); res.end(m.content); return }
        const f = fake.files.get(dl[1]!)
        if (f !== undefined) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(f.content); return }
        res.writeHead(404); res.end('{}'); return
      }

      // List (paginated).
      if (req.method === 'GET' && /\/knowledge-bases\/[^/]+\/knowledge$/.test(url.pathname)) {
        const page = Number(url.searchParams.get('page') ?? '1')
        const all = [
          ...[...fake.manuals.values()].filter(m => !fake.hidden.has(m.id)).map(m => ({ id: m.id, title: m.title, parse_status: m.parseStatus })),
          ...[...fake.files.values()].map(f => ({ id: f.id, title: f.title, parse_status: f.parseStatus })),
        ]
        const slice = all.slice((page - 1) * fake.listPageSize, page * fake.listPageSize)
        send(200, { data: slice, total: all.length })
        return
      }

      // Get knowledge.
      const get = /\/knowledge\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'DELETE' && get) {
        fake.manuals.delete(get[1]!)
        fake.files.delete(get[1]!)
        send(200, { success: true })
        return
      }
      if (req.method === 'GET' && get) {
        const m = fake.manuals.get(get[1]!)
        if (m !== undefined) { send(200, { data: { id: m.id, title: m.title, parse_status: m.parseStatus, channel: 'pkw' } }); return }
        const f = fake.files.get(get[1]!)
        if (f !== undefined) { send(200, { data: { id: f.id, title: f.title, file_name: f.filename, file_hash: f.fileHash, parse_status: f.parseStatus, description: f.summary, summary_status: f.summaryStatus } }); return }
        res.writeHead(404); res.end('{}'); return
      }

      // Reparse / cancel.
      if (req.method === 'POST' && /\/knowledge\/([^/]+)\/reparse$/.exec(url.pathname)) {
        const id = /\/knowledge\/([^/]+)\/reparse$/.exec(url.pathname)![1]!
        const target = fake.manuals.get(id) ?? fake.files.get(id)
        if (target !== undefined) target.parseStatus = 'pending'
        send(200, { data: { id, parse_status: 'pending' } })
        return
      }
      if (req.method === 'POST' && /\/knowledge\/([^/]+)\/cancel-parse$/.exec(url.pathname)) {
        const id = /\/knowledge\/([^/]+)\/cancel-parse$/.exec(url.pathname)![1]!
        const target = fake.manuals.get(id) ?? fake.files.get(id)
        if (target !== undefined) target.parseStatus = 'cancelled'
        send(200, { data: { id, parse_status: 'cancelled' } })
        return
      }

      // Hybrid search: one synthetic chunk per known object.
      if (req.method === 'POST' && /\/knowledge-bases\/[^/]+\/hybrid-search$/.test(url.pathname)) {
        const chunks = [
          ...[...fake.manuals.values()].map(m => ({ id: `chunk-${m.id}`, content: m.content, knowledge_id: m.id, chunk_index: 0, score: 0.9, knowledge_title: m.title, knowledge_source: 'manual', knowledge_channel: 'pkw' })),
          ...[...fake.files.values()].map(f => ({ id: `chunk-${f.id}`, content: f.title, knowledge_id: f.id, chunk_index: 0, score: 0.8, knowledge_title: f.title, knowledge_filename: f.filename, knowledge_channel: 'pkw' })),
        ]
        send(200, { data: chunks })
        return
      }

      res.writeHead(404); res.end('{}')
    })().catch(() => { try { res.socket?.destroy() } catch { /* already gone */ } })
  })
  servers.push(server)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
      resolve(fake)
    })
  })
}

// ── boot ──────────────────────────────────────────────────────────────────────

interface BootOptions {
  apiKey?: string
  apiKeyRef?: string
  /** In-memory credential provider values (only when apiKeyRef is used). */
  credentials?: Record<string, string>
  pollMs?: number
  /** Hold periodic ticks; tests drive the real durable worker through drain(). */
  manualWorker?: boolean
}

async function boot(opts: BootOptions = {}) {
  // Only interval scheduling is controlled. HTTP, SQLite, filesystem, Date and
  // timeout behavior remain real, and no sync outcome or storage method is mocked.
  if (opts.manualWorker) vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const fake = await startFakeServer()
  const dir = await mkdtemp(join(tmpdir(), 'pkw-'))
  dirs.push(dir)
  await mkdir(join(dir, 'notes'), { recursive: true })
  await mkdir(join(dir, 'attachments'), { recursive: true })

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [], load: () => { throw new Error('unused') }, inspect: () => { throw new Error('unused') } } as never)
  if (opts.credentials !== undefined) {
    ctx.provide('credentials', {
      resolve: async (ref: string) => {
        const value = opts.credentials![String(ref)]
        return value === undefined ? undefined : { value, source: 'test' }
      },
      describe: async (ref: string) => ({ configured: opts.credentials![String(ref)] !== undefined, writable: true }),
      set: async () => {}, unset: async () => {},
    } as never)
  }
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(Timer)
  await ctx.plugin(PkwEventStoreService)
  await ctx.plugin(PkwWorkspaceService)

  const ws = await ctx.workspaceRegistry.create(dir)
  await ctx.plugin(NotesService, { workspaceId: ws.id })
  await ctx.plugin(AttachmentsService, { workspaceId: ws.id })
  await ctx.plugin(WeKnoraClient, { baseUrl: fake.baseUrl, apiKey: opts.apiKey ?? 'test-key', apiKeyRef: opts.apiKeyRef ?? '' })
  const syncFork = await ctx.plugin(WeKnoraSyncService, { kbId: 'kb-1', workspaceId: ws.id, pollMs: opts.pollMs ?? 25, retryBaseMs: 5, retryMaxMs: 10, recoveryGraceAttempts: 2 })
  // Let the startup resume pass finish on an empty workspace before test events.
  if (opts.manualWorker) await ctx.pkwWeKnoraSync.drain()
  return { ctx, dir, workspaceId: ws.id, notes: ctx.pkwNotes, attachments: ctx.pkwAttachments, adapter: ctx.pkwWeKnora, sync: ctx.pkwWeKnoraSync, syncFork, fake }
}

// ── outcome model ─────────────────────────────────────────────────────────────

describe('outcome certainty model', () => {
  it('classifies structured auth/validation as permanent + known', () => {
    for (const kind of ['auth', 'forbidden', 'validation', 'conflict'] as const) {
      const err = new WeKnoraError('x', kind, kind === 'auth' ? 401 : 400, {})
      expect(classifyOutcome(err, { mutation: true })).toEqual({ category: 'permanent', certainty: 'known' })
    }
  })

  it('classifies rate_limit as retryable + known', () => {
    const err = new WeKnoraError('x', 'rate_limit', 429, {})
    expect(classifyOutcome(err, { mutation: true })).toEqual({ category: 'retryable', certainty: 'known' })
  })

  it('classifies 5xx mutation as unknown, but 5xx read as retryable', () => {
    const err = new WeKnoraError('x', 'server', 500, {})
    expect(classifyOutcome(err, { mutation: true })).toEqual({ category: 'unknown', certainty: 'unknown' })
    expect(classifyOutcome(err, { mutation: false })).toEqual({ category: 'retryable', certainty: 'known' })
  })

  it('classifies network errors as unknown for mutation, retryable for read', () => {
    expect(classifyOutcome(new Error('ECONNRESET'), { mutation: true })).toEqual({ category: 'unknown', certainty: 'unknown' })
    expect(classifyOutcome(new Error('ECONNRESET'), { mutation: false })).toEqual({ category: 'retryable', certainty: 'known' })
  })
})

// ── fingerprint round-trip ────────────────────────────────────────────────────

describe('manual payload fingerprint round-trip', () => {
  it('round-trips Unicode / CJK / emoji / CRLF / BOM / trailing newline / quoted frontmatter', async () => {
    const { notes, adapter, sync } = await boot()
    const cases = [
      '---\nid: note_special\n---\n\n# 中文标题\n\nemoji 🎉 mixed\n',
      '\uFEFF---\r\nid: "note_special"\r\n---\r\n\r\nbody\r\n',
      '---\nid: note_special\nnested:\n  unknown: value\n---\n\nno trailing newline',
      '---\nid: note_special\n---\n\nends with newline\n',
    ]
    for (const markdown of cases) {
      const created = await adapter.createManualKnowledge('kb-1', { title: 't', content: markdown })
      const downloaded = await adapter.readManualContent(created.id)
      // Exact bytes round-trip (including BOM/CRLF), so the fingerprint is stable.
      expect(downloaded).toBe(markdown)
      expect(adapter.fingerprintManualContent(downloaded)).toBe(adapter.fingerprintManualContent(markdown))
    }
    // silence unused
    void notes; void sync
  })
})

// ── canonicalization (matches WeKnora secutils.CleanMarkdown) ─────────────────

describe('remote manual content canonicalization', () => {
  it('strips WeKnora XSS patterns (idempotent) and leaves normal content untouched', () => {
    const dirty = 'a<script>alert(1)</script>b<iframe>x</iframe>c[javascript:x](x) onload=1 onclick=2 end'
    const once = canonicalizeRemoteManualContent(dirty)
    expect(once).not.toContain('script')
    expect(once).not.toContain('iframe')
    expect(once).not.toContain('javascript:')
    expect(once).not.toContain('onload=')
    expect(once).not.toContain('onclick=')
    expect(canonicalizeRemoteManualContent(once)).toBe(once) // idempotent

    const clean = '---\nid: note_x\n---\n\n# 中文 🎉\nCRLF ok\r\n'
    expect(canonicalizeRemoteManualContent(clean)).toBe(clean)
  })
})

// ── manual create/update vertical slice ───────────────────────────────────────

describe('pkw weknora sync (vertical slice)', () => {
  it('syncs a note (create manual knowledge) and persists the mapping', async () => {
    const { notes, sync } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\nbody\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    expect(knowledgeId).toBeDefined()
    expect(sync.getMapping(note.noteId)!.knowledgeId).toBe(knowledgeId)
  })

  it('is idempotent: unchanged note does not create a second remote knowledge', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const first = await sync.syncNote(note.noteId)
    const second = await sync.syncNote(note.noteId)
    expect(second).toBe(first)
    expect(fake.manuals.size).toBe(1)
  })

  it('Move keeps the SAME KnowledgeId (update, never delete+recreate)', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    await notes.move(note.noteId, 'sub/a.md')
    const after = await sync.syncNote(note.noteId)
    expect(after).toBe(knowledgeId) // KnowledgeId stable across Move
    expect(sync.getMapping(note.noteId)!.knowledgeId).toBe(knowledgeId)
    expect(fake.manuals.size).toBe(1) // no second remote object created
  })

  it('attachment-backed Companion Note is skipped (no independent Note Knowledge)', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'c.md', markdown: '# 海报\n\n![](attachments/att_x/海报.jpg)\n', attachmentBacked: true })
    await expect(sync.syncNote(note.noteId)).rejects.toThrow(/did not converge/)
    expect(sync.getMapping(note.noteId)).toBeUndefined()
    expect(fake.manuals.size).toBe(0) // no remote manual knowledge
  })

  it('upgrading an attachment-backed note to independent creates the Note Knowledge', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'c.md', markdown: '# 海报\n\n这是我的补充。\n', attachmentBacked: true })
    await notes.setAttachmentBacked(note.noteId, false)
    const kid = await sync.syncNote(note.noteId)
    expect(kid).toBeDefined()
    expect(fake.manuals.size).toBe(1)
    expect(sync.getMapping(note.noteId)!.knowledgeId).toBe(kid)
  })

  it('note-scoped / local-only attachments never become independent Knowledge', async () => {
    const { attachments, sync, fake } = await boot()
    const scoped = await attachments.importFile({ content: new Uint8Array([1, 2, 3]), filename: 'a.jpg', mimeType: 'image/jpeg', knowledgeMode: 'note-scoped', ownerNoteId: NoteId('note_x') })
    await expect(sync.syncAttachment(scoped.id)).rejects.toThrow(/did not converge/)
    expect(fake.files.size).toBe(0)
    const local = await attachments.importFile({ content: new Uint8Array([4, 5, 6]), filename: 'b.pdf', mimeType: 'application/pdf', knowledgeMode: 'local-only' })
    await expect(sync.syncAttachment(local.id)).rejects.toThrow(/did not converge/)
    expect(fake.files.size).toBe(0)
    // standalone still syncs
    const standalone = await attachments.importFile({ content: new Uint8Array([7, 8, 9]), filename: 'c.txt', mimeType: 'text/plain' })
    const kid = await sync.syncAttachment(standalone.id)
    expect(kid).toBeDefined()
    expect(fake.files.size).toBe(1)
  })

  it('recovers a lost mapping via remote identity lookup (unknown-outcome)', async () => {
    const { notes, adapter, sync } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\nlost mapping\n' })
    const doc = await notes.getDocument(note.noteId)
    await adapter.createManualKnowledge('kb-1', { title: note.title, content: stripInternalFrontmatter(doc.markdown) })
    expect(sync.getMapping(note.noteId)).toBeUndefined()
    const recovered = await sync.recoverNote(note.noteId)
    expect(recovered).toBeDefined()
    expect(sync.getMapping(note.noteId)!.knowledgeId).toBe(recovered)
  })

  it('recovers an unknown-outcome UPDATE via known KnowledgeId (no full-KB scan)', async () => {
    const { notes, adapter, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# v2\n`)
    const doc = await notes.getDocument(note.noteId)
    await adapter.updateManualKnowledge(knowledgeId, { title: doc.note.title, content: doc.markdown })
    const recovered = await sync.recoverNote(note.noteId)
    expect(recovered).toBe(knowledgeId)
    expect(fake.manuals.size).toBe(1)
  })

  it('create recovery enumerates across pagination pages (target on page 2)', async () => {
    const { notes, adapter, sync } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# target\n' })
    const doc = await notes.getDocument(note.noteId)
    await adapter.createManualKnowledge('kb-1', { title: 'other', content: '# other\n' })
    await adapter.createManualKnowledge('kb-1', { title: doc.note.title, content: stripInternalFrontmatter(doc.markdown) })
    const recovered = await sync.recoverNote(note.noteId)
    expect(recovered).toBeDefined()
    expect(sync.getMapping(note.noteId)!.knowledgeId).toBe(recovered)
  })
})

// ── distributed failure sequences: manual ─────────────────────────────────────

describe('manual create distributed failures', () => {
  it('remote commit + lost response → unknown → drain recovers by candidate enumeration (no duplicate)', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\nlost\n' })
    fake.next.commitThenDrop = 'create-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    expect(fake.manuals.size).toBe(1) // committed despite lost response
    expect(sync.getMapping(note.noteId)).toBeUndefined()

    await vi.waitFor(() => {
      expect(sync.getMapping(note.noteId)?.knowledgeId).toBeDefined()
    }, { timeout: 2000 })
    // Recovered, not re-created.
    expect(fake.manuals.size).toBe(1)
  })

  it('request never reached server → 0-candidate grace → safe re-create', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\nunreached\n' })
    fake.next.dropBeforeRead = 'create-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    expect(fake.manuals.size).toBe(0)

    // Grace elapses (recoveryGraceAttempts=2) and the worker re-creates.
    await vi.waitFor(() => {
      expect(fake.manuals.size).toBe(1)
    }, { timeout: 2000 })
    expect(sync.getMapping(note.noteId)?.knowledgeId).toBeDefined()
  })

  it('delayed visibility: grace re-polls until the committed object appears', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\ndelayed\n' })
    fake.next.commitThenDrop = 'create-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    // Committed but hidden from list (delayed visibility).
    const committed = [...fake.manuals.keys()][0]!
    fake.hidden.add(committed)

    // Let at least one grace attempt observe 0 candidates.
    await vi.waitFor(() => {
      expect(sync.listIntents().some(i => i.recoveryAttempts >= 1)).toBe(true)
    }, { timeout: 2000 })

    // Become visible → recovery should claim the original, not re-create.
    fake.hidden.delete(committed)
    await vi.waitFor(() => {
      expect(sync.getMapping(note.noteId)?.knowledgeId).toBe(committed)
    }, { timeout: 2000 })
    expect(fake.manuals.size).toBe(1)
  })

  it('multiple exact candidates → deterministic canonical (completed preferred) + superseded recorded', async () => {
    // The worker never polls inside this test: the background note sync must not
    // race the manual fixtures below. If it did land first, a mapping would exist
    // and `recoverNote` would take the known-KnowledgeId path instead of candidate
    // enumeration — which is exactly what this test is meant to cover.
    const { notes, adapter, sync, fake } = await boot({ pollMs: 3_600_000 })
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\ncanonical\n' })
    const doc = await notes.getDocument(note.noteId)
    const body = stripInternalFrontmatter(doc.markdown)
    const a = await adapter.createManualKnowledge('kb-1', { title: note.title, content: body })
    const b = await adapter.createManualKnowledge('kb-1', { title: note.title, content: body })
    fake.manuals.get(a.id)!.parseStatus = 'pending'
    fake.manuals.get(b.id)!.parseStatus = 'completed'

    const recovered = await sync.recoverNote(note.noteId)
    expect(recovered).toBe(b.id)
    const mapping = sync.getMapping(note.noteId)!
    expect(mapping.knowledgeId).toBe(b.id)
    expect(mapping.supersededKnowledgeIds).toContain(a.id)
    expect(fake.manuals.size).toBe(2) // nothing hard-deleted
  })
})

describe('manual update distributed failures', () => {
  it('applied + lost response → recovery reads remote content and converges without re-apply', async () => {
    const { notes, sync, fake } = await boot({ manualWorker: true })
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    const previousFingerprint = sync.getMapping(note.noteId)!.remoteFingerprint
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# v2\n`)
    fake.next.commitThenDrop = 'update-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()

    expect(fake.next.commitThenDrop).toBeUndefined()
    expect(fake.manuals.get(knowledgeId)!.content).toContain('# v2')
    expect(fake.manualUpdateApplications).toBe(1)
    expect(fake.manualContentReads).toBe(0)
    expect(sync.getMapping(note.noteId)!.remoteFingerprint).toBe(previousFingerprint)
    const intent = sync.listIntents().find(i => i.operationKind === 'update')!
    expect(intent).toMatchObject({ state: 'unknown', errorCertainty: 'unknown' })
    expect(sync.listDirty().find(i => i.entityId === note.noteId)).toMatchObject({ dirty: true, pendingOperationId: intent.operationId })

    await sync.drain()
    expect(sync.getMapping(note.noteId)).toMatchObject({ knowledgeId, remoteFingerprint: sha256Hex(fake.manuals.get(knowledgeId)!.content) })
    expect(sync.listIntents().find(i => i.operationId === intent.operationId)!.state).toBe('completed')
    expect(sync.listDirty().find(i => i.entityId === note.noteId)!.dirty).toBe(false)
    expect(fake.manualContentReads).toBe(1)
    // Repeated worker passes must not replay an already-applied PUT.
    await sync.drain()
    await sync.drain()
    expect(fake.manualUpdateApplications).toBe(1)
    expect(fake.manuals.size).toBe(1)
  })

  it('worker consumes a lost update response before a queued explicit sync, which recovers without re-apply', async () => {
    const { notes, sync, fake } = await boot({ manualWorker: true })
    const note = await notes.create({ relativePath: 'worker-first.md', markdown: '# v1\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# v2\n`)
    expect(sync.listDirty().find(i => i.entityId === note.noteId)!.dirty).toBe(true)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    fake.manualUpdateGate = { entered: entered.resolve, release: release.promise }
    fake.next.commitThenDrop = 'update-manual'
    const worker = sync.drain()
    await entered.promise // Worker now owns the entity lock and the in-flight PUT.
    const explicit = sync.syncNote(note.noteId)
    release.resolve()
    await worker
    // The worker records its unknown outcome; the queued caller observes the
    // resulting durable intent and legitimately returns the recovered identity.
    await expect(explicit).resolves.toBe(knowledgeId)
    expect(fake.next.commitThenDrop).toBeUndefined()
    expect(fake.manualUpdateApplications).toBe(1)
    expect(fake.manualContentReads).toBe(1)
    expect(fake.manuals.get(knowledgeId)!.content).toContain('# v2')
    const intent = sync.listIntents().find(i => i.operationKind === 'update')!
    expect(intent).toMatchObject({ state: 'completed', errorCertainty: 'unknown' })
    expect(sync.getMapping(note.noteId)).toMatchObject({ knowledgeId, remoteFingerprint: sha256Hex(fake.manuals.get(knowledgeId)!.content) })
    expect(sync.listDirty().find(i => i.entityId === note.noteId)!.dirty).toBe(false)
    await sync.drain()
    expect(fake.manualUpdateApplications).toBe(1)
    expect(fake.manuals.size).toBe(1)
  })

  it('remote previous state → re-apply update', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    // Local v2; remote still v1 (no lost response, just not yet synced).
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# v2\n`)
    await sync.syncNote(note.noteId)
    expect(fake.manuals.get(knowledgeId)!.content).toContain('# v2')
  })

  it('third-state drift: intent B unknown while local already C → converge to C (no replay)', async () => {
    const { notes, sync, fake } = await boot({ pollMs: 3_600_000 })
    const note = await notes.create({ relativePath: 'a.md', markdown: '# A\n' })
    const knowledgeId = await sync.syncNote(note.noteId)

    // B update: commit + lost response (unknown intent for B).
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# B\n`)
    fake.next.commitThenDrop = 'update-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()

    // Local drifts to C before the unknown B intent is recovered.
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# C\n`)

    await vi.waitFor(async () => {
      await sync.drain()
      expect(fake.manuals.get(knowledgeId)!.content).toContain('# C')
    }, { timeout: 2000 })
    expect(fake.manuals.size).toBe(1)
  })
})

// ── worker ────────────────────────────────────────────────────────────────────

describe('worker: durable dirty, coalescing, retry, resume', () => {
  it.each(['before-clear', 'during-clear'] as const)('keeps a deletion arriving %s in an older sync pass', async (when) => {
    const { attachments, sync, fake } = await boot({ manualWorker: true })
    const rec = await attachments.importFile({ content: Buffer.from('delete-race'), filename: 'race.txt', mimeType: 'text/plain' })
    await sync.syncAttachment(rec.id)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const dirty = (sync as any).reqDirty()
    const originalPut = dirty.put.bind(dirty)
    const originalOpen = attachments.open.bind(attachments)
    let held = false
    const gate = when === 'during-clear'
      ? vi.spyOn(dirty, 'put').mockImplementation(async (key: any, value: any) => {
          if (!held && value.dirty === false) { held = true; entered.resolve(); await release.promise }
          return originalPut(key, value)
        })
      : vi.spyOn(attachments, 'open').mockImplementation(async (id) => {
          const bytes = await originalOpen(id)
          if (!held) { held = true; entered.resolve(); await release.promise }
          return bytes
        })
    const oldPass = sync.syncAttachment(rec.id)
    try {
      await entered.promise
      await attachments.remove(rec.id)
    } finally { release.resolve() }
    await oldPass
    gate.mockRestore()
    // No full reconcile or new event: the existing hint must drive deletion.
    await sync.drain()
    await sync.drain()
    expect(sync.getAttachmentMapping(rec.id)?.syncState).toBe('deleted')
    expect(sync.listIntents().filter(i => i.entityId === rec.id && i.operationKind === 'delete')).toHaveLength(1)
    expect(sync.listIntents().find(i => i.entityId === rec.id && i.operationKind === 'delete')?.state).toBe('completed')
    expect(fake.files.size).toBe(0)
  })

  it('re-arms a deletion when the catalog becomes visible after the event hint was consumed', async () => {
    const { attachments, sync } = await boot({ manualWorker: true })
    const rec = await attachments.importFile({ content: Buffer.from('projection-race'), filename: 'race.txt', mimeType: 'text/plain' })
    await sync.syncAttachment(rec.id)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const table = (attachments as any).requireTable()
    const original = table.put.bind(table)
    const put = vi.spyOn(table, 'put').mockImplementation(async (key: any, value: any) => {
      if (key === rec.id && value.deletedAt !== undefined) { entered.resolve(); await release.promise }
      return original(key, value)
    })
    const removing = attachments.remove(rec.id)
    try {
      await entered.promise
      // The committed deletion is visible, but the catalog still says active.
      // Supply the old bytes to force the no-op path instead of a file-not-found retry.
      const open = vi.spyOn(attachments, 'open').mockResolvedValue(Buffer.from('projection-race'))
      try { await sync.drain() } finally { open.mockRestore() }
      expect(sync.listDirty().find(i => i.entityId === rec.id)?.dirty).toBe(false)
    } finally { release.resolve() }
    await removing
    put.mockRestore()
    await sync.drain()
    await sync.drain()
    expect(sync.getAttachmentMapping(rec.id)?.syncState).toBe('deleted')
    expect(sync.listIntents().find(i => i.entityId === rec.id && i.operationKind === 'delete')?.state).toBe('completed')
  })

  it('preserves a revision-zero derived-content hint received during a no-op pass', async () => {
    const { attachments, sync } = await boot({ manualWorker: true })
    const rec = await attachments.importFile({ content: Buffer.from('derived'), filename: 'derived.txt', mimeType: 'text/plain' })
    await sync.syncAttachment(rec.id)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = attachments.open.bind(attachments)
    const open = vi.spyOn(attachments, 'open').mockImplementationOnce(async (id) => {
      const bytes = await original(id)
      entered.resolve()
      await release.promise
      return bytes
    })
    const oldPass = sync.syncAttachment(rec.id)
    try {
      await entered.promise
      await sync.markDirty('attachment', String(rec.id), 0)
      expect(sync.listDirty().find(i => i.entityId === rec.id)?.dirty).toBe(true)
    } finally { release.resolve() }
    await oldPass
    open.mockRestore()
    expect(sync.listDirty().find(i => i.entityId === rec.id)?.dirty).toBe(true)
    await sync.drain()
    expect(sync.listDirty().find(i => i.entityId === rec.id)?.dirty).toBe(false)
  })

  it('recovers an unknown update even when local content returns to the previous fingerprint', async () => {
    const { notes, sync, fake } = await boot({ manualWorker: true })
    const note = await notes.create({ relativePath: 'revert.md', markdown: '# A\n' })
    const original = (await notes.getDocument(note.noteId)).markdown
    const knowledgeId = await sync.syncNote(note.noteId)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# B\n`)
    fake.next.commitThenDrop = 'update-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    expect(fake.manuals.get(knowledgeId)?.content).toContain('# B')
    await notes.update(note.noteId, original)
    await sync.drain()
    expect(fake.manuals.get(knowledgeId)?.content).toContain('# A')
    expect(sync.listDirty().find(i => i.entityId === note.noteId)?.dirty).toBe(false)
  })

  it('full reconcile re-arms a lost deletion hint and completes the remote deletion only once', async () => {
    const { attachments, sync, fake } = await boot({ manualWorker: true })
    const rec = await attachments.importFile({ content: Buffer.from('backstop'), filename: 'backstop.txt', mimeType: 'text/plain' })
    await sync.syncAttachment(rec.id)
    await attachments.remove(rec.id)
    await sync.markDirty('attachment', String(rec.id)) // settle all earlier hint writes
    const dirty = (sync as any).reqDirty()
    const [key, value] = [...dirty.entries()][0] as [string, any]
    await dirty.put(key, { ...value, dirty: false, pendingOperationId: undefined })
    await sync.reconcile()
    await sync.drain()
    await sync.drain()
    expect(fake.files.size).toBe(0)
    expect(sync.listIntents().filter(i => i.operationKind === 'delete' && i.state === 'completed')).toHaveLength(1)
    await sync.reconcile()
    await sync.drain()
    expect(sync.listIntents().filter(i => i.operationKind === 'delete')).toHaveLength(1)
  })

  it('timer worker propagates each deletion without a full reconcile', async () => {
    const { attachments, sync, fake } = await boot()
    for (let n = 0; n < 15; n++) {
      const rec = await attachments.importFile({ content: Buffer.from(`timer-${n}`), filename: 'timer.txt', mimeType: 'text/plain' })
      const knowledgeId = await sync.syncAttachment(rec.id)
      await attachments.remove(rec.id)
      await vi.waitFor(() => {
        expect(sync.getAttachmentMapping(rec.id)?.syncState).toBe('deleted')
        expect(fake.files.has(knowledgeId)).toBe(false)
        expect(sync.listIntents().find(i => i.entityId === rec.id && i.operationKind === 'delete')?.state).toBe('completed')
      }, { timeout: 2000 })
    }
  })

  it('service restart re-arms a deleted catalog record whose durable dirty hint was lost', async () => {
    const { ctx, workspaceId, attachments, sync, syncFork, fake } = await boot({ manualWorker: true })
    const rec = await attachments.importFile({ content: Buffer.from('restart-delete'), filename: 'restart.txt', mimeType: 'text/plain' })
    await sync.syncAttachment(rec.id)
    await attachments.remove(rec.id)
    await sync.markDirty('attachment', String(rec.id))
    const dirty = (sync as any).reqDirty()
    const [key, value] = [...dirty.entries()][0] as [string, any]
    await dirty.put(key, { ...value, dirty: false, pendingOperationId: undefined })
    await syncFork.dispose()
    await ctx.plugin(WeKnoraSyncService, { kbId: 'kb-1', workspaceId, pollMs: 25, retryBaseMs: 5, retryMaxMs: 10, recoveryGraceAttempts: 2 })
    const restarted = ctx.pkwWeKnoraSync
    // No new event and no full reconcile. Startup repairs the lost hint.
    await vi.waitFor(async () => {
      await restarted.drain()
      expect(fake.files.size).toBe(0)
      expect(restarted.listIntents().find(i => i.entityId === rec.id && i.operationKind === 'delete')?.state).toBe('completed')
    }, { timeout: 2000 })
  })

  it('coalesces A→B→C→D: worker converges remote to the current state, not replay', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# A\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# B\n`)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# C\n`)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# D\n`)
    await vi.waitFor(() => {
      expect(fake.manuals.get(knowledgeId)!.content).toContain('# D')
    }, { timeout: 2000 })
    expect(fake.manuals.size).toBe(1)
  })

  it('event-independent backstop: reconcile re-derives dirty from canonical entities', async () => {
    const { notes, sync } = await boot({ pollMs: 3_600_000 })
    // Reconcile is the event-loss backstop: it enumerates local canonical entities
    // directly (not the live event stream) and marks never-synced ones dirty.
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const report = await sync.reconcile()
    expect(report.markedDirty).toBeGreaterThanOrEqual(1)
    await vi.waitFor(async () => {
      await sync.drain()
      expect(sync.getMapping(note.noteId)?.knowledgeId).toBeDefined()
    }, { timeout: 2000 })
  })

  it('restart resume: unknown intent is recovered by a later drain (no new event)', async () => {
    const { notes, sync, fake } = await boot({ pollMs: 3_600_000 })
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\nresume\n' })
    fake.next.commitThenDrop = 'create-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    expect(sync.listIntents().some(i => i.state === 'unknown')).toBe(true)

    // A fresh drain (equivalent to init-time resume) must recover the durable intent.
    await sync.drain()
    await vi.waitFor(async () => {
      await sync.drain()
      expect(sync.getMapping(note.noteId)?.knowledgeId).toBeDefined()
    }, { timeout: 2000 })
    expect(fake.manuals.size).toBe(1)
  })

  it('known retryable (429) → backoff, then converges', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\n429\n' })
    fake.next.respond = { status: 429, body: { code: 'rate_limited' } }
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    expect(sync.listIntents().some(i => i.state === 'retryable')).toBe(true)
    await vi.waitFor(() => {
      expect(sync.getMapping(note.noteId)?.knowledgeId).toBeDefined()
    }, { timeout: 2000 })
  })
})

// ── attachment sync ───────────────────────────────────────────────────────────

describe('attachment sync', () => {
  it('first upload maps the remote knowledge id', async () => {
    const { attachments, sync, fake } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('hello attachment'), filename: 'a.txt', mimeType: 'text/plain' })
    const knowledgeId = await sync.syncAttachment(rec.id)
    expect(knowledgeId).toBeDefined()
    expect(sync.getAttachmentMapping(rec.id)!.knowledgeId).toBe(knowledgeId)
    expect(fake.files.size).toBe(1)
  })

  it('duplicate 409 with matching file_hash → claim existing (no new object)', async () => {
    const { attachments, sync, fake } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('dup'), filename: 'd.txt', mimeType: 'text/plain' })
    // Upload commits but the response is lost (unknown outcome).
    fake.next.commitThenDrop = 'upload'
    await expect(sync.syncAttachment(rec.id)).rejects.toThrow()
    expect(fake.files.size).toBe(1)
    expect(sync.getAttachmentMapping(rec.id)).toBeUndefined()

    // Recovery re-uploads the same bytes → 409 duplicate → claim the existing object.
    await vi.waitFor(() => {
      expect(sync.getAttachmentMapping(rec.id)?.knowledgeId).toBeDefined()
    }, { timeout: 2000 })
    expect(fake.files.size).toBe(1)
  })

  it('idempotent: same attachment id + same fingerprint → no-op', async () => {
    const { attachments, sync, fake } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('same'), filename: 's.txt', mimeType: 'text/plain' })
    const first = await sync.syncAttachment(rec.id)
    const second = await sync.syncAttachment(rec.id)
    expect(second).toBe(first)
    expect(fake.files.size).toBe(1)
  })

  it('replacement success: upload B, parse completed, switch active; A superseded (not deleted)', async () => {
    const { attachments, sync, fake, dir } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('AAA'), filename: 'r.txt', mimeType: 'text/plain' })
    const oldId = await sync.syncAttachment(rec.id)
    // External binary replacement: same AttachmentId, new bytes (A→B).
    const bytes = Buffer.from('BBB')
    const fs = await import('node:fs/promises')
    const rec2 = attachments.list().find(r => r.id === rec.id)!
    await fs.writeFile(join(dir, 'attachments', String(rec2.id), rec2.filename), bytes)
    await attachments.reconcile() // detects A→B as same-id update

    await vi.waitFor(() => {
      expect(fake.files.size).toBe(2) // B uploaded alongside still-active A
    }, { timeout: 2000 })
    const b = [...fake.files.values()].find(f => f.fileHash === md5Hex(bytes))!
    fake.files.get(b.id)!.parseStatus = 'completed'

    await vi.waitFor(() => {
      const m = sync.getAttachmentMapping(rec.id)
      expect(m?.knowledgeId).toBe(b.id)
    }, { timeout: 2000 })
    expect(oldId).not.toBe(b.id)
    expect(sync.getAttachmentMapping(rec.id)!.supersededKnowledgeIds).toContain(oldId)
    expect(fake.files.size).toBe(2) // A not deleted
  })

  it('replacement parse failed → old A stays active', async () => {
    const { attachments, sync, fake, dir } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('AAA'), filename: 'rf.txt', mimeType: 'text/plain' })
    const oldId = await sync.syncAttachment(rec.id)
    const bytes = Buffer.from('BBB')
    const fs = await import('node:fs/promises')
    const rec2 = attachments.list().find(r => r.id === rec.id)!
    await fs.writeFile(join(dir, 'attachments', String(rec2.id), rec2.filename), bytes)
    await attachments.reconcile()

    await vi.waitFor(() => {
      expect(fake.files.size).toBe(2)
    }, { timeout: 2000 })
    const b = [...fake.files.values()].find(f => f.fileHash === md5Hex(bytes))!
    fake.files.get(b.id)!.parseStatus = 'failed'

    await vi.waitFor(() => {
      const m = sync.getAttachmentMapping(rec.id)
      expect(m?.replacementState).toBe('failed')
    }, { timeout: 2000 })
    const m = sync.getAttachmentMapping(rec.id)!
    expect(m.knowledgeId).toBe(oldId) // A stays active
    expect(fake.files.size).toBe(2)
  })
})

// ── reconcile ─────────────────────────────────────────────────────────────────

describe('full reconcile', () => {
  it('marks never-synced entities dirty and converges', async () => {
    const { notes, attachments, sync } = await boot({ pollMs: 3_600_000 })
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    await attachments.importFile({ content: Buffer.from('x'), filename: 'x.txt', mimeType: 'text/plain' })
    const report = await sync.reconcile()
    expect(report.markedDirty).toBe(2)
    await vi.waitFor(async () => {
      await sync.drain()
      expect(sync.getMapping(note.noteId)?.knowledgeId).toBeDefined()
    }, { timeout: 2000 })
  })

  it('remote missing (404) → safe recreate, new mapping', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const oldId = await sync.syncNote(note.noteId)
    // Remote object disappears.
    fake.manuals.delete(oldId)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# v2\n`)
    await vi.waitFor(() => {
      const m = sync.getMapping(note.noteId)
      expect(m?.knowledgeId).toBeDefined()
      expect(m?.knowledgeId).not.toBe(oldId)
    }, { timeout: 2000 })
  })
})

// ── retrieval + source ref ────────────────────────────────────────────────────

describe('retrieval + SourceRef', () => {
  it('distinguishes unavailable attachment processing from a healthy empty search', async () => {
    const { sync, adapter, notes } = await boot()
    const note = await notes.create({ relativePath: 'partial-search.md', markdown: '# searchable\n' })
    await sync.syncNote(note.noteId)
    const healthy = await sync.searchWithTrace('searchable')
    expect(healthy.trace.processingUnavailable).toBeUndefined()
    const original = adapter.hybridSearch.bind(adapter)
    const kb = vi.spyOn(sync as any, 'reqProcessingKb').mockReturnValue({ get: () => ({ processingKbId: 'processing-offline' }) })
    const remote = vi.spyOn(adapter, 'hybridSearch').mockImplementation((id, input) => {
      if (id === 'processing-offline') return Promise.reject(new Error('processing unavailable'))
      return original(id, input)
    })
    try {
      const partial = await sync.searchWithTrace('searchable')
      expect(partial.trace.processingUnavailable).toBe(true)
      expect(partial.trace.processingRaw).toBe(0)
      expect(partial.results.map(r => r.local?.entityId)).toContain(String(note.noteId))
    } finally { kb.mockRestore(); remote.mockRestore() }
  })

  it('attaches workspace-correct local SourceRef for mapped PKW knowledge', async () => {
    const { notes, sync, workspaceId } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# searchable\n' })
    await sync.syncNote(note.noteId)
    const results = await sync.search('searchable')
    expect(results.length).toBeGreaterThan(0)
    const hit = results.find(r => r.local !== undefined)
    expect(hit).toBeDefined()
    expect(hit!.local!.workspaceId).toBe(String(workspaceId))
    expect(hit!.local!.entityType).toBe('note')
    expect(hit!.local!.entityId).toBe(String(note.noteId))
  })

  it('external WeKnora knowledge yields no local SourceRef', async () => {
    const { adapter, sync } = await boot()
    await adapter.createManualKnowledge('kb-1', { title: 'external', content: '---\nid: note_ext\n---\n\n# external\n' })
    const results = await sync.search('external')
    const hit = results.find(r => r.remote.knowledgeId !== undefined)
    expect(hit).toBeDefined()
    expect(hit!.local).toBeUndefined()
  })

  it('hides a locally-deleted note from retrieval before remote delete converges', async () => {
    const { notes, sync } = await boot()
    const note = await notes.create({ relativePath: 'del.md', markdown: '# delete me\n' })
    const kid = await sync.syncNote(note.noteId)
    await notes.delete(note.noteId)
    // The worker marks the mapping deleted (immediate hide) while the async
    // remote delete is still pending; retrieval must filter it out.
    await vi.waitFor(() => {
      expect(sync.getMapping(note.noteId)?.syncState).toBe('deleted')
    }, { timeout: 3000 })
    const results = await sync.search('delete me')
    expect(results.find(r => r.remote.knowledgeId === kid)).toBeUndefined()
  })
})

// ── security ──────────────────────────────────────────────────────────────────

describe('secret redaction', () => {
  it('redactSecrets masks X-API-Key / Authorization / api_key values', () => {
    expect(redactSecrets('X-API-Key: sk-secret')).not.toContain('sk-secret')
    expect(redactSecrets('Authorization: Bearer tok')).not.toContain('tok')
    expect(redactSecrets('api_key=abc')).not.toContain('abc')
  })

  it('a remote failure never embeds the api key in the durable lastError', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    fake.next.respond = { status: 400, body: { code: 'validation' } }
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    const intent = sync.listIntents().find(i => i.state === 'permanent')!
    expect(intent.lastError).not.toContain('test-key')
    expect(intent.lastError).not.toContain('X-API-Key')
  })
})

// ── Companion Note summary materialization ────────────────────────────────────

describe('companion summary materialization', () => {
  it('does not overwrite a user save made after the summary reads its note snapshot', async () => {
    const { attachments, notes, sync, fake } = await boot({ pollMs: 3_600_000 })
    const note = await notes.create({ relativePath: 'user-edit.md', markdown: '# Original\n' })
    const attachment = await attachments.importFile({ content: Buffer.from('SUMMARY'), filename: 'summary.txt', mimeType: 'text/plain' })
    await attachments.setCompanionNote(attachment.id, note.noteId)
    const knowledgeId = await sync.syncAttachment(attachment.id)
    fake.files.get(knowledgeId)!.summary = 'Derived summary'
    fake.files.get(knowledgeId)!.summaryStatus = 'completed'
    const captured = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const readDocument = notes.getDocument.bind(notes)
    const spy = vi.spyOn(notes, 'getDocument').mockImplementationOnce(async id => {
      const snapshot = await readDocument(id)
      captured.resolve()
      await release.promise
      return snapshot
    })
    try {
      const pending = sync.materializeCompanionSummary(attachment.id)
      await captured.promise
      await notes.update(note.noteId, '# User saved newer work\n')
      release.resolve()
      const changed = await pending
      expect((await readDocument(note.noteId)).markdown).toContain('# User saved newer work')
      expect(changed).toBe(false)
      expect(await sync.materializeCompanionSummary(attachment.id)).toBe(true)
      const after = await readDocument(note.noteId)
      expect(after.markdown).toContain('# User saved newer work')
      expect(after.markdown).toContain('Derived summary')
    } finally {
      release.resolve()
      spy.mockRestore()
    }
  })

  it('serializes overlapping summary materializations and writes the canonical note once', async () => {
    const { attachments, notes, sync, fake } = await boot({ pollMs: 3_600_000 })
    const note = await notes.create({ relativePath: 'concurrent.md', markdown: '# Original\n' })
    const attachment = await attachments.importFile({ content: Buffer.from('SUMMARY'), filename: 'summary.txt', mimeType: 'text/plain' })
    await attachments.setCompanionNote(attachment.id, note.noteId)
    const knowledgeId = await sync.syncAttachment(attachment.id)
    const remote = fake.files.get(knowledgeId)!
    remote.summary = 'One derived summary'
    remote.summaryStatus = 'completed'
    const before = notes.get(note.noteId)!.observedRevision
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => sync.materializeCompanionSummary(attachment.id)))
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(notes.get(note.noteId)!.observedRevision).toBe(before + 1)
    const doc = await notes.getDocument(note.noteId)
    expect(doc.markdown).toContain('# Original')
    expect(doc.markdown.split('pkw:attachment-summary:start')).toHaveLength(2)
  })

  it('materializes the Attachment Knowledge summary into the Companion Note (upsert, reuse KnowledgeId)', async () => {
    const { attachments, notes, sync, fake } = await boot({ pollMs: 3_600_000 })
    const note = await notes.create({ relativePath: '海报3.md', markdown: '# 海报3\n\n![](attachments/att_x/海报3.png)\n' })
    const rec = await attachments.importFile({ content: Buffer.from('PNG'), filename: '海报3.png', mimeType: 'image/png' })
    await attachments.setCompanionNote(rec.id, note.noteId)
    const knowledgeId = await sync.syncAttachment(rec.id)
    // summary becomes ready on the remote projection
    const f = fake.files.get(knowledgeId)!
    f.summary = '这张海报展示了……'
    f.summaryStatus = 'completed'

    const changed = await sync.materializeCompanionSummary(rec.id)
    expect(changed).toBe(true)
    const doc = await notes.getDocument(note.noteId)
    expect(doc.markdown).toContain('附件解析摘要')
    expect(doc.markdown).toContain('这张海报展示了……')

    // same summary → no-op (no second write)
    const changedAgain = await sync.materializeCompanionSummary(rec.id)
    expect(changedAgain).toBe(false)

    // replace-in-place on a new summary (reparse update)
    f.summary = '新摘要'
    const changed3 = await sync.materializeCompanionSummary(rec.id)
    expect(changed3).toBe(true)
    const doc3 = await notes.getDocument(note.noteId)
    expect(doc3.markdown).toContain('新摘要')
    expect(doc3.markdown).not.toContain('这张海报展示了')
    expect(doc3.markdown.split('pkw:attachment-summary:start').length - 1).toBe(1)
  })

  it('does NOT materialize for an attachment without a companion relation', async () => {
    const { attachments, sync, fake } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('X'), filename: 'x.png', mimeType: 'image/png' })
    const knowledgeId = await sync.syncAttachment(rec.id)
    fake.files.get(knowledgeId)!.summary = 'no note'; fake.files.get(knowledgeId)!.summaryStatus = 'completed'
    const changed = await sync.materializeCompanionSummary(rec.id)
    expect(changed).toBe(false)
  })
})

// ── attachment restore + replacement crash recovery ───────────────────────────

describe('attachment restore + replacement crash recovery', () => {
  it('restore: deleted attachment reappearing with same bytes reactivates (no new id)', async () => {
    const { attachments, sync, fake, dir } = await boot({ manualWorker: true })
    const rec = await attachments.importFile({ content: Buffer.from('RESTORE'), filename: 'restore.txt', mimeType: 'text/plain' })
    const knowledgeId = await sync.syncAttachment(rec.id)

    await attachments.remove(rec.id)
    await sync.drain() // tombstone + arm DELETE; restore before it executes
    expect(sync.getAttachmentMapping(rec.id)?.syncState).toBe('deleted')

    // Same AttachmentId + same bytes reappear (restore, not a new id).
    const fs = await import('node:fs/promises')
    await fs.writeFile(join(dir, 'attachments', String(rec.id), rec.filename), Buffer.from('RESTORE'))
    await attachments.reconcile()
    await sync.drain()

    await vi.waitFor(() => {
      const m = sync.getAttachmentMapping(rec.id)
      expect(m?.syncState).toBe('synced')
      expect(m?.knowledgeId).toBe(knowledgeId)
    }, { timeout: 2000 })
    expect(fake.files.size).toBe(1) // reactivated, not replaced
  })

  it.each(['note', 'attachment'] as const)('restores a %s after remote DELETE completed, with a new remote id', async (kind) => {
    const { attachments, notes, sync, fake, adapter } = await boot({ manualWorker: true })
    const note = kind === 'note' ? await notes.create({ relativePath: 'restore.md', markdown: '# restore\n' }) : undefined
    const att = kind === 'attachment' ? await attachments.importFile({ content: Buffer.from('restore'), filename: 'restore.txt', mimeType: 'text/plain' }) : undefined
    const id = note?.noteId ?? att!.id
    const oldId = note ? await sync.syncNote(note.noteId) : await sync.syncAttachment(att!.id)
    if (note) await notes.delete(note.noteId)
    else await attachments.remove(att!.id)
    await sync.drain()
    await sync.drain()
    expect(fake.manuals.has(oldId) || fake.files.has(oldId)).toBe(false)
    if (note) await notes.restore(note.noteId)
    else await attachments.restore(att!.id)
    // A failed existence check must neither claim success nor lose the retry.
    const get = vi.spyOn(adapter, 'getKnowledge').mockRejectedValueOnce(new Error('offline'))
    await sync.drain()
    get.mockRestore()
    expect(sync.listDirty().find(i => i.entityId === id)?.dirty).toBe(true)
    await sync.drain()
    const mapping = note ? sync.getMapping(note.noteId) : sync.getAttachmentMapping(att!.id)
    expect(mapping?.syncState).toBe('synced')
    expect(mapping?.knowledgeId).not.toBe(oldId)
    expect(fake.manuals.has(mapping!.knowledgeId) || fake.files.has(mapping!.knowledgeId)).toBe(true)
  })

  it('replacement crash recovery: B durably recorded while A active, then resumed and switched', { timeout: 20000 }, async () => {
    const { attachments, sync, fake, dir } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('A'), filename: 'rr.txt', mimeType: 'text/plain' })
    const oldId = await sync.syncAttachment(rec.id)

    const bytes = Buffer.from('B')
    const fs = await import('node:fs/promises')
    const rec2 = attachments.list().find(r => r.id === rec.id)!
    await fs.writeFile(join(dir, 'attachments', String(rec2.id), rec2.filename), bytes)
    await attachments.reconcile()

    // B uploaded but NOT switched yet: durable replacement marker + A still active.
    await vi.waitFor(() => {
      expect(sync.getAttachmentMapping(rec.id)?.replacementKnowledgeId).toBeDefined()
    }, { timeout: 15000 })
    const mid = sync.getAttachmentMapping(rec.id)!
    expect(mid.knowledgeId).toBe(oldId)
    const bId = mid.replacementKnowledgeId!

    // A later drain (restart resume) finishes the switch once B parses.
    fake.files.get(bId)!.parseStatus = 'completed'
    await sync.drain()
    await vi.waitFor(() => {
      expect(sync.getAttachmentMapping(rec.id)?.knowledgeId).toBe(bId)
    }, { timeout: 15000 })
    expect(sync.getAttachmentMapping(rec.id)!.supersededKnowledgeIds).toContain(oldId)
  })
})

// ── credential wiring + unavailable ────────────────────────────────────────────

describe('credential wiring + unavailable', () => {
  it('resolves apiKeyRef through ctx.credentials (no literal key)', async () => {
    const { adapter, fake } = await boot({ apiKey: '', apiKeyRef: 'WKN_KEY', credentials: { WKN_KEY: 'secret-from-provider' } })
    expect(await adapter.credentialStatus()).toBe('configured')
    const created = await adapter.createManualKnowledge('kb-1', { title: 't', content: '# wired\n' })
    expect(created.id).toBeDefined()
    expect(fake.manuals.get(created.id)!.content).toBe('# wired\n')
  })

  it('missing credential → integration unavailable → worker pauses (no retry storm)', async () => {
    const { notes, sync, fake } = await boot({ apiKey: '', apiKeyRef: 'WKN_KEY', credentials: {} })
    expect(await sync.integrationState()).toBe('unavailable')
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    await sync.drain()
    expect(fake.manuals.size).toBe(0) // no remote call attempted
  })
})

describe('mapWeKnoraProcessingPhase', () => {
  it('maps real WeKnora parse statuses to user phases (unknown → processing, never waiting)', () => {
    expect(mapWeKnoraProcessingPhase('completed')).toBe('ready')
    expect(mapWeKnoraProcessingPhase('failed')).toBe('failed')
    expect(mapWeKnoraProcessingPhase('error')).toBe('failed')
    expect(mapWeKnoraProcessingPhase('optimizing')).toBe('optimizing')
    expect(mapWeKnoraProcessingPhase('processing')).toBe('processing')
    expect(mapWeKnoraProcessingPhase('parsing')).toBe('processing')
    expect(mapWeKnoraProcessingPhase('pending')).toBe('waiting')
    expect(mapWeKnoraProcessingPhase('queued')).toBe('waiting')
    expect(mapWeKnoraProcessingPhase('unknown-status')).toBe('processing')
    expect(mapWeKnoraProcessingPhase(undefined)).toBe('processing')
  })
  it('derives phase from parse + summary (optimizing summary while parse completed)', () => {
    expect(weKnoraKnowledgePhase('completed', undefined)).toBe('ready')
    expect(weKnoraKnowledgePhase('completed', 'none')).toBe('ready')
    expect(weKnoraKnowledgePhase('completed', 'optimizing')).toBe('optimizing')
    expect(weKnoraKnowledgePhase('processing', undefined)).toBe('processing')
    expect(weKnoraKnowledgePhase('completed', 'failed')).toBe('failed')
  })
})

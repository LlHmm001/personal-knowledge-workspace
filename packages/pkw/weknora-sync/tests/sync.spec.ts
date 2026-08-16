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
import { WeKnoraError, redactSecrets } from '@deepseek-ai/dsh-pkw-weknora'
import PkwEventStoreService from '../../events/src/index.ts'
import PkwWorkspaceService from '../../workspace/src/index.ts'
import NotesService from '../../notes/src/index.ts'
import AttachmentsService from '../../attachments/src/index.ts'
import WeKnoraClient from '../../weknora/src/index.ts'
import WeKnoraSyncService from '../src/index.ts'
import { classifyOutcome } from '../src/outcome.ts'

const dirs: string[] = []
const contexts: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(c => c.fiber.dispose().catch(() => {})))
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))))
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
function md5Hex(b: Uint8Array): string {
  return createHash('md5').update(b).digest('hex')
}

// ── stateful fake WeKnora ─────────────────────────────────────────────────────

interface ManualRec { id: string; title: string; content: string; parseStatus: string }
interface FileRec { id: string; title: string; filename: string; fileHash: string; parseStatus: string; content: Buffer }

interface FakeWeKnora {
  baseUrl: string
  manuals: Map<string, ManualRec>
  files: Map<string, FileRec>
  listPageSize: number
  hidden: Set<string>
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
        if (m !== undefined) { res.writeHead(200, { 'Content-Type': 'text/markdown' }); res.end(m.content); return }
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
      if (req.method === 'GET' && get) {
        const m = fake.manuals.get(get[1]!)
        if (m !== undefined) { send(200, { data: { id: m.id, title: m.title, parse_status: m.parseStatus, channel: 'pkw' } }); return }
        const f = fake.files.get(get[1]!)
        if (f !== undefined) { send(200, { data: { id: f.id, title: f.title, file_name: f.filename, file_hash: f.fileHash, parse_status: f.parseStatus } }); return }
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
}

async function boot(opts: BootOptions = {}) {
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
  await ctx.plugin(WeKnoraSyncService, { kbId: 'kb-1', workspaceId: ws.id, pollMs: opts.pollMs ?? 25, retryBaseMs: 5, retryMaxMs: 10, recoveryGraceAttempts: 2 })
  return { ctx, dir, workspaceId: ws.id, notes: ctx.pkwNotes, attachments: ctx.pkwAttachments, adapter: ctx.pkwWeKnora, sync: ctx.pkwWeKnoraSync, fake }
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

  it('recovers a lost mapping via remote identity lookup (unknown-outcome)', async () => {
    const { notes, adapter, sync } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\nlost mapping\n' })
    const doc = await notes.getDocument(note.noteId)
    await adapter.createManualKnowledge('kb-1', { title: note.title, content: doc.markdown })
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
    await adapter.createManualKnowledge('kb-1', { title: 'other', content: '---\nid: note_other\n---\n\n# other\n' })
    await adapter.createManualKnowledge('kb-1', { title: doc.note.title, content: doc.markdown })
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
    const { notes, adapter, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\ncanonical\n' })
    const doc = await notes.getDocument(note.noteId)
    const a = await adapter.createManualKnowledge('kb-1', { title: note.title, content: doc.markdown })
    const b = await adapter.createManualKnowledge('kb-1', { title: note.title, content: doc.markdown })
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
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const knowledgeId = await sync.syncNote(note.noteId)
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# v2\n`)
    fake.next.commitThenDrop = 'update-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()

    await vi.waitFor(() => {
      const mapping = sync.getMapping(note.noteId)
      expect(mapping?.remoteFingerprint).toBe(sha256Hex((fake.manuals.get(knowledgeId)!.content)))
    }, { timeout: 2000 })
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
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# A\n' })
    const knowledgeId = await sync.syncNote(note.noteId)

    // B update: commit + lost response (unknown intent for B).
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# B\n`)
    fake.next.commitThenDrop = 'update-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()

    // Local drifts to C before the unknown B intent is recovered.
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# C\n`)

    await vi.waitFor(() => {
      expect(fake.manuals.get(knowledgeId)!.content).toContain('# C')
    }, { timeout: 2000 })
    expect(fake.manuals.size).toBe(1)
  })
})

// ── worker ────────────────────────────────────────────────────────────────────

describe('worker: durable dirty, coalescing, retry, resume', () => {
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
    const { notes, sync } = await boot()
    // Reconcile is the event-loss backstop: it enumerates local canonical entities
    // directly (not the live event stream) and marks never-synced ones dirty.
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    const report = await sync.reconcile()
    expect(report.markedDirty).toBeGreaterThanOrEqual(1)
    await vi.waitFor(() => {
      expect(sync.getMapping(note.noteId)?.knowledgeId).toBeDefined()
    }, { timeout: 2000 })
  })

  it('restart resume: unknown intent is recovered by a later drain (no new event)', async () => {
    const { notes, sync, fake } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n\nresume\n' })
    fake.next.commitThenDrop = 'create-manual'
    await expect(sync.syncNote(note.noteId)).rejects.toThrow()
    expect(sync.listIntents().some(i => i.state === 'unknown')).toBe(true)

    // A fresh drain (equivalent to init-time resume) must recover the durable intent.
    await sync.drain()
    await vi.waitFor(() => {
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
    const { notes, attachments, sync } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    await attachments.importFile({ content: Buffer.from('x'), filename: 'x.txt', mimeType: 'text/plain' })
    const report = await sync.reconcile()
    expect(report.markedDirty).toBe(2)
    await vi.waitFor(() => {
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

// ── attachment restore + replacement crash recovery ───────────────────────────

describe('attachment restore + replacement crash recovery', () => {
  it('restore: deleted attachment reappearing with same bytes reactivates (no new id)', async () => {
    const { attachments, sync, fake, dir } = await boot()
    const rec = await attachments.importFile({ content: Buffer.from('RESTORE'), filename: 'restore.txt', mimeType: 'text/plain' })
    const knowledgeId = await sync.syncAttachment(rec.id)

    await attachments.remove(rec.id)
    await vi.waitFor(() => {
      expect(sync.getAttachmentMapping(rec.id)?.syncState).toBe('deleted')
    }, { timeout: 2000 })

    // Same AttachmentId + same bytes reappear (restore, not a new id).
    const fs = await import('node:fs/promises')
    await fs.writeFile(join(dir, 'attachments', String(rec.id), rec.filename), Buffer.from('RESTORE'))
    await attachments.reconcile()

    await vi.waitFor(() => {
      const m = sync.getAttachmentMapping(rec.id)
      expect(m?.syncState).toBe('synced')
      expect(m?.knowledgeId).toBe(knowledgeId)
    }, { timeout: 2000 })
    expect(fake.files.size).toBe(1) // reactivated, not replaced
  })

  it('replacement crash recovery: B durably recorded while A active, then resumed and switched', async () => {
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
    }, { timeout: 2000 })
    const mid = sync.getAttachmentMapping(rec.id)!
    expect(mid.knowledgeId).toBe(oldId)
    const bId = mid.replacementKnowledgeId!

    // A later drain (restart resume) finishes the switch once B parses.
    fake.files.get(bId)!.parseStatus = 'completed'
    await sync.drain()
    await vi.waitFor(() => {
      expect(sync.getAttachmentMapping(rec.id)?.knowledgeId).toBe(bId)
    }, { timeout: 2000 })
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

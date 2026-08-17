import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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
import PkwWebService from '../src/index.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(c => c.fiber.dispose().catch(() => {})))
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function startFakeWeKnora(): Promise<{ baseUrl: string; manuals: Map<string, { id: string; title: string; content: string }> }> {
  const manuals = new Map<string, { id: string; title: string; content: string }>()
  let counter = 0
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://x')
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      const readBody = async () => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); return Buffer.concat(chunks).toString('utf8') }
      if (req.method === 'POST' && /\/knowledge-bases\/[^/]+\/knowledge\/manual$/.test(url.pathname)) {
        const b = JSON.parse(await readBody())
        const id = `kn-${++counter}`
        manuals.set(id, { id, title: b.title, content: b.content })
        send(200, { data: { id, title: b.title, parse_status: 'pending' } }); return
      }
      const up = /\/knowledge\/manual\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'PUT' && up) {
        const b = JSON.parse(await readBody())
        const m = manuals.get(up[1]!)
        if (m !== undefined) { m.content = b.content; m.title = b.title }
        send(200, { data: { id: up[1]!, title: b.title, parse_status: 'pending' } }); return
      }
      const dl = /\/knowledge\/([^/]+)\/download$/.exec(url.pathname)
      if (req.method === 'GET' && dl) {
        const m = manuals.get(dl[1]!)
        if (m === undefined) { res.writeHead(404); res.end('{}'); return }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(m.content); return
      }
      if (req.method === 'GET' && /\/knowledge-bases\/[^/]+\/knowledge$/.test(url.pathname)) {
        const all = [...manuals.values()].map(m => ({ id: m.id, title: m.title, parse_status: 'pending' }))
        send(200, { data: all, total: all.length }); return
      }
      if (req.method === 'POST' && /\/knowledge-bases\/[^/]+\/hybrid-search$/.test(url.pathname)) {
        const chunks = [...manuals.values()].map(m => ({ id: `chunk-${m.id}`, content: m.content, knowledge_id: m.id, chunk_index: 0, score: 0.9, knowledge_title: m.title, knowledge_source: 'manual', knowledge_channel: 'pkw' }))
        send(200, { data: chunks }); return
      }
      res.writeHead(404); res.end('{}')
    })().catch(() => { res.destroy() })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, manuals })))
}

async function boot() {
  const fake = await startFakeWeKnora()
  const dir = await mkdtemp(join(tmpdir(), 'pkw-web-'))
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
  ctx.provide('webServer', { register: () => () => {}, registerUpgrade: () => () => {}, registerFallback: () => () => {}, tapIndex: () => () => {} } as never)
  ctx.provide('sessionPersistence', { list: async () => [], load: () => { throw new Error('unused') }, inspect: () => { throw new Error('unused') } } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(Timer)

  await ctx.plugin(PkwWebService, {
    workspacePath: dir,
    kbId: 'kb-1',
    weknoraBaseUrl: fake.baseUrl,
    weknoraApiKeyRef: '',
    weknoraApiKey: 'test-key',
    pollMs: 25,
    retryBaseMs: 5,
    retryMaxMs: 10,
    recoveryGraceAttempts: 2,
  })
  return { ctx, dir, web: ctx.pkwWeb, sync: ctx.pkwWeKnoraSync, fake }
}

describe('PKW Web Host Bridge (real Core integration)', () => {
  it('summary reports workspace, KB, and integration facts', async () => {
    const { web } = await boot()
    const s = await web.call('summary', {}) as Record<string, unknown>
    expect(s.kbId).toBe('kb-1')
    expect(s.integration).toBe('ready') // literal test key injected
    expect(s.notes).toBe(0)
  })

  it('create → list → get round-trips a real Note through pkwNotes', async () => {
    const { web } = await boot()
    const created = await web.call('createNote', { relativePath: 'a.md', markdown: '# hello\n' }) as { noteId: string }
    const list = await web.call('listNotes', {}) as Array<{ noteId: string; relativePath: string }>
    expect(list).toHaveLength(1)
    expect(list[0]!.relativePath).toBe('a.md')
    const doc = await web.call('getNote', { noteId: created.noteId }) as { markdown: string; note: { title: string } }
    expect(doc.markdown).toContain('# hello')
  })

  it('save → revision bump; move → path change (identity preserved); delete', async () => {
    const { web } = await boot()
    const created = await web.call('createNote', { relativePath: 'a.md', markdown: '# v1\n' }) as { noteId: string }
    const saved = await web.call('saveNote', { noteId: created.noteId, markdown: '# v2\n' }) as { observedRevision: number }
    expect(saved.observedRevision).toBe(2)
    const moved = await web.call('moveNote', { noteId: created.noteId, relativePath: 'sub/a.md' }) as { relativePath: string; noteId: string }
    expect(moved.relativePath).toBe('sub/a.md')
    expect(moved.noteId).toBe(created.noteId) // NoteId ≠ path
    await web.call('deleteNote', { noteId: created.noteId })
    const list = await web.call('listNotes', {}) as Array<{ noteId: string }>
    expect(list).toHaveLength(0)
  })

  it('attachment upload → list (real pkwAttachments)', async () => {
    const { web } = await boot()
    const up = await web.call('uploadAttachment', { filename: 'x.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hello attachment').toString('base64') }) as { attachmentId: string }
    expect(up.attachmentId).toBeDefined()
    const list = await web.call('listAttachments', {}) as Array<{ filename: string }>
    expect(list).toHaveLength(1)
    expect(list[0]!.filename).toBe('x.txt')
  })

  it('search returns a WeKnora hit with a workspace-scoped local SourceRef after sync', async () => {
    const { web, sync } = await boot()
    const created = await web.call('createNote', { relativePath: 's.md', markdown: '# searchable note\n' }) as { noteId: string }
    await sync.syncNote(created.noteId as never) // force real WeKnora sync
    const results = await web.call('search', { query: 'searchable', limit: 5 }) as Array<{ local?: { entityType: string; entityId: string }; remote: { knowledgeId: string } }>
    expect(results.length).toBeGreaterThan(0)
    const hit = results.find(r => r.local !== undefined)
    expect(hit).toBeDefined()
    expect(hit!.local!.entityType).toBe('note')
    expect(hit!.local!.entityId).toBe(created.noteId)
  })

  it('reconcile reports a clean local workspace', async () => {
    const { web } = await boot()
    const r = await web.call('reconcile', {}) as { markedDirty: number; markedDeleted: number }
    expect(r.markedDirty).toBe(0)
    expect(r.markedDeleted).toBe(0)
  })

  it('summary exposes workspace name, sync counters, and recent list for the overview', async () => {
    const { web } = await boot()
    const s = await web.call('summary', {}) as Record<string, unknown>
    expect(s.workspaceName).toBeTypeOf('string')
    expect(s.pendingSync).toBe(0)
    expect(s.syncErrors).toBe(0)
    expect(Array.isArray(s.recent)).toBe(true)
  })

  it('listNotes includes folder + per-entity sync view; listAttachments includes sync view', async () => {
    const { web } = await boot()
    await web.call('createNote', { relativePath: 'sub/a.md', markdown: '# hi\n' })
    const notes = await web.call('listNotes', {}) as Array<Record<string, unknown>>
    expect(notes[0]!.folder).toBe('sub')
    expect(notes[0]!.sync).toBeDefined()
    await web.call('uploadAttachment', { filename: 'x.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') })
    const atts = await web.call('listAttachments', {}) as Array<Record<string, unknown>>
    expect(atts[0]!.sync).toBeDefined()
  })

  it('getAttachment + downloadAttachment round-trip through the bridge', async () => {
    const { web } = await boot()
    const up = await web.call('uploadAttachment', { filename: 'd.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') }) as { attachmentId: string }
    const d = await web.call('downloadAttachment', { attachmentId: up.attachmentId }) as { filename: string; contentBase64: string }
    expect(d.filename).toBe('d.txt')
    expect(Buffer.from(d.contentBase64, 'base64').toString()).toBe('hello')
    const detail = await web.call('getAttachment', { attachmentId: up.attachmentId }) as { attachment: { filename: string } }
    expect(detail.attachment.filename).toBe('d.txt')
  })

  it('syncEntity forces a note sync; reconcile returns the combined report', async () => {
    const { web } = await boot()
    const created = await web.call('createNote', { relativePath: 's.md', markdown: '# sync me\n' }) as { noteId: string }
    const r = await web.call('syncEntity', { entityType: 'note', entityId: created.noteId }) as { synced: boolean }
    expect(r.synced).toBe(true)
    const rep = await web.call('reconcile', {}) as Record<string, number>
    expect(rep.markedDirty).toBe(0)
    expect(rep.markedDeleted).toBe(0)
    expect(rep.notesRepaired).toBe(0)
    expect(rep.attachmentsRepaired).toBe(0)
  })
})

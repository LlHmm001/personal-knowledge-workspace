import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import PkwEventStoreService from '../../events/src/index.ts'
import PkwWorkspaceService from '../../workspace/src/index.ts'
import NotesService from '../../notes/src/index.ts'
import AttachmentsService from '../../attachments/src/index.ts'
import WeKnoraClient from '../../weknora/src/index.ts'
import WeKnoraSyncService from '../src/index.ts'

const dirs: string[] = []
const closers: Array<() => void> = []

afterEach(async () => {
  closers.splice(0).forEach(c => c())
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

interface FakeWeKnora { baseUrl: string; manuals: Map<string, { id: string; title: string; content: string }> }

function startFakeServer(): Promise<FakeWeKnora> {
  const manuals = new Map<string, { id: string; title: string; content: string }>()
  let counter = 0
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (req.method === 'POST' && /\/knowledge-bases\/[^/]+\/knowledge\/manual$/.test(url.pathname)) {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body) as { title: string; content: string }
      const id = `kn-${++counter}`
      manuals.set(id, { id, title: parsed.title, content: parsed.content })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: { id, title: parsed.title, parse_status: 'pending' } }))
      return
    }
    const up = /\/knowledge\/manual\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'PUT' && up) {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body) as { title: string; content: string }
      const existing = manuals.get(up[1]!)
      if (existing !== undefined) { existing.content = parsed.content; existing.title = parsed.title }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: { id: up[1]!, title: parsed.title, parse_status: 'pending' } }))
      return
    }
    const dl = /\/knowledge\/([^/]+)\/download$/.exec(url.pathname)
    if (req.method === 'GET' && dl) {
      const m = manuals.get(dl[1]!)
      if (m === undefined) { res.writeHead(404); res.end('{}'); return }
      res.writeHead(200, { 'Content-Type': 'text/markdown' })
      res.end(m.content)
      return
    }
    if (req.method === 'GET' && /\/knowledge-bases\/[^/]+\/knowledge$/.test(url.pathname)) {
      // Paginated list, but capped at 1 item per page to exercise the adapter's loop.
      const page = Number(url.searchParams.get('page') ?? '1')
      const all = [...manuals.values()]
      const slice = all.slice(page - 1, page)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: slice.map(m => ({ id: m.id, title: m.title, parse_status: 'pending' })), total: all.length }))
      return
    }
    res.writeHead(404); res.end('{}')
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ baseUrl: `http://127.0.0.1:${port}/api/v1`, manuals })
    })
  })
}

async function boot() {
  const fake = await startFakeServer()
  const dir = await mkdtemp(join(tmpdir(), 'pkw-'))
  dirs.push(dir)
  await mkdir(join(dir, 'notes'), { recursive: true })
  await mkdir(join(dir, 'attachments'), { recursive: true })

  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [], load: () => { throw new Error('unused') }, inspect: () => { throw new Error('unused') } } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(PkwEventStoreService)
  await ctx.plugin(PkwWorkspaceService)

  const ws = await ctx.workspaceRegistry.create(dir)
  await ctx.plugin(NotesService, { workspaceId: ws.id })
  await ctx.plugin(AttachmentsService, { workspaceId: ws.id })
  await ctx.plugin(WeKnoraClient, { baseUrl: fake.baseUrl, apiKey: 'test-key' })
  await ctx.plugin(WeKnoraSyncService, { kbId: 'kb-1', workspaceId: ws.id })
  return { ctx, dir, notes: ctx.pkwNotes, adapter: ctx.pkwWeKnora, sync: ctx.pkwWeKnoraSync, fake }
}

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
    // Simulate: remote create succeeded, but local mapping write "crashed".
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
    // Local edit to v2.
    await notes.update(note.noteId, `---\nid: ${note.noteId}\n---\n\n# v2\n`)
    const doc = await notes.getDocument(note.noteId)
    // Simulate: PUT succeeded on remote but client lost the response.
    await adapter.updateManualKnowledge(knowledgeId, { title: doc.note.title, content: doc.markdown })
    const recovered = await sync.recoverNote(note.noteId)
    expect(recovered).toBe(knowledgeId) // same remote identity, no new object
    expect(fake.manuals.size).toBe(1)
  })

  it('create recovery enumerates across pagination pages (target on page 2)', async () => {
    const { notes, adapter, sync } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# target\n' })
    const doc = await notes.getDocument(note.noteId)
    // A non-matching candidate first, forcing the target onto page 2.
    await adapter.createManualKnowledge('kb-1', { title: 'other', content: '---\nid: note_other\n---\n\n# other\n' })
    await adapter.createManualKnowledge('kb-1', { title: doc.note.title, content: doc.markdown })
    const recovered = await sync.recoverNote(note.noteId)
    expect(recovered).toBeDefined()
    expect(sync.getMapping(note.noteId)!.knowledgeId).toBe(recovered)
  })
})

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
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = []
  ctx.provide('webServer', { register: (opts: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => { routes.push(opts); return () => {} }, registerUpgrade: () => () => {}, registerFallback: () => () => {}, tapIndex: () => () => {} } as never)
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
  return { ctx, dir, web: ctx.pkwWeb, sync: ctx.pkwWeKnoraSync, fake, routes }
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

  it('listNotes includes folder + per-entity sync view; listAttachments exposes source fields (no remote ids)', async () => {
    const { web } = await boot()
    await web.call('createNote', { relativePath: 'sub/a.md', markdown: '# hi\n' })
    const notes = await web.call('listNotes', {}) as Array<Record<string, unknown>>
    expect(notes[0]!.folder).toBe('sub')
    expect(notes[0]!.sync).toBeDefined()
    await web.call('uploadAttachment', { filename: 'x.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') })
    const atts = await web.call('listAttachments', {}) as Array<Record<string, unknown>>
    expect(atts[0]!.processingState).toBeDefined()
    expect(atts[0]!.ownerCount).toBe(0)
    expect(atts[0]!.hasSummary).toBe(false)
    expect(atts[0]!).not.toHaveProperty('knowledgeId')
    expect(atts[0]!).not.toHaveProperty('kbId')
    expect(atts[0]!).not.toHaveProperty('sync')
  })

  it('attachment owners surface through getAttachment: isolated → referenced by a Note (stable NoteId)', async () => {
    const { web } = await boot()
    const up = await web.call('uploadAttachment', { filename: 'x.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') }) as { attachmentId: string }
    // Isolated: no Note references the attachment yet.
    const isolated = await web.call('getAttachment', { attachmentId: up.attachmentId }) as { owners: Array<{ noteId: string; title: string }>; ownerCount: number; processingState: string }
    expect(isolated.ownerCount).toBe(0)
    expect(isolated.owners).toHaveLength(0)
    expect(['waiting', 'processing', 'ready', 'failed']).toContain(isolated.processingState)
    // Create a Companion Note → the attachment is now referenced by exactly one Note.
    const note = await web.call('createCompanionNote', { attachmentId: up.attachmentId, folder: '' }) as { noteId: string }
    const det = await web.call('getAttachment', { attachmentId: up.attachmentId }) as { owners: Array<{ noteId: string; title: string }>; ownerCount: number }
    expect(det.ownerCount).toBe(1)
    expect(det.owners[0]!.noteId).toBe(note.noteId)
    // And listAttachments reflects the owner count without exposing remote ids.
    const list = await web.call('listAttachments', {}) as Array<Record<string, unknown>>
    expect(list[0]!.ownerCount).toBe(1)
    expect(list[0]!).not.toHaveProperty('knowledgeId')
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

  it('getTree exposes the folder tree; folder CRUD + setOrder round-trip', async () => {
    const { web } = await boot()
    await web.call('createFolder', { path: '工作/项目A' })
    await web.call('createNote', { relativePath: '工作/项目A/a.md', markdown: '# a\n' })
    await web.call('createNote', { relativePath: '工作/项目A/b.md', markdown: '# b\n' })
    const tree = await web.call('getTree', { sortMode: 'manual' }) as { root: Array<Record<string, unknown>> }
    const work = tree.root.find(n => n.kind === 'folder' && n.name === '工作') as { children: Array<Record<string, unknown>> }
    const proj = work.children.find(n => n.kind === 'folder' && n.name === '项目A') as { children: Array<Record<string, unknown>> }
    expect(proj.children.length).toBe(2)
    // move note a after note b via setOrder.
    const notes = proj.children as Array<{ kind: string; noteId: string; name: string }>
    const a = notes[0]!
    const b = notes[1]!
    await web.call('setOrder', { parentPath: '工作/项目A', children: [{ kind: 'note', id: b.noteId }, { kind: 'note', id: a.noteId }] })
    const tree2 = await web.call('getTree', { sortMode: 'manual' }) as { root: Array<Record<string, unknown>> }
    const proj2 = (tree2.root.find(n => n.kind === 'folder' && n.name === '工作') as { children: Array<Record<string, unknown>> }).children.find(n => n.kind === 'folder' && n.name === '项目A') as { children: Array<Record<string, unknown>> }
    expect((proj2.children as Array<{ noteId: string }>).map(n => n.noteId)).toEqual([b.noteId, a.noteId])
    // rename folder → tree re-keys.
    await web.call('renameFolder', { path: '工作/项目A', newPath: '工作/项目B' })
    const folders = await web.call('listFolders', {}) as string[]
    expect(folders).toContain('工作/项目B')
  })

  it('serves attachment bytes at /pkw/attachment/<id> with mime + disposition', async () => {
    const { web, routes } = await boot()
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const up = await web.call('uploadAttachment', { filename: 'p.png', mimeType: 'image/png', contentBase64: png.toString('base64') }) as { attachmentId: string }
    const route = routes.find(r => r.path === '/pkw/attachment')
    expect(route).toBeDefined()
    const captured: { status: number; headers: Record<string, string>; body: Buffer } = { status: 0, headers: {}, body: Buffer.alloc(0) }
    let resolveEnd!: () => void
    const ended = new Promise<void>(r => { resolveEnd = r })
    const res = {
      writeHead: (s: number, h: Record<string, string>) => { captured.status = s; captured.headers = h },
      end: (b: unknown) => { captured.body = Buffer.from((b as Buffer) ?? Buffer.alloc(0)); resolveEnd() },
    }
    route!.handler({ url: '/pkw/attachment/' + up.attachmentId, method: 'GET' }, res)
    await ended
    expect(captured.status).toBe(200)
    expect(captured.headers['Content-Type']).toBe('image/png')
    expect(captured.headers['Content-Disposition']).toBe('inline')
    expect(captured.body).toEqual(png)
  })

  it('registers prefix routes with NO trailing slash (WebServer matcher contract)', async () => {
    const { routes } = await boot()
    const prefixes = routes.filter(r => r.kind === 'prefix')
    expect(prefixes.length).toBeGreaterThan(0)
    for (const r of prefixes) expect(r.path.endsWith('/')).toBe(false)
    const att = routes.find(r => r.path === '/pkw/attachment')
    expect(att).toBeDefined()
    expect(att!.kind).toBe('prefix')
  })

  it('404s unknown or malformed attachment ids', async () => {
    const { routes } = await boot()
    const route = routes.find(r => r.path === '/pkw/attachment')
    expect(route).toBeDefined()
    const invoke = async (url: string): Promise<number> => {
      let resolveEnd!: () => void
      const ended = new Promise<void>(r => { resolveEnd = r })
      const captured: { status: number } = { status: 0 }
      const res = { writeHead: (s: number) => { captured.status = s }, end: () => resolveEnd() }
      route!.handler({ url, method: 'GET' }, res)
      await ended
      return captured.status
    }
    expect(await invoke('/pkw/attachment/att_ffffffffffff')).toBe(404) // unknown
    expect(await invoke('/pkw/attachment/../../etc/passwd')).toBe(404) // traversal
    expect(await invoke('/pkw/attachment/')).toBe(404) // empty
  })

  it('tableMutation applies structural GFM edits via the pure table transforms', async () => {
    const { web } = await boot()
    const md = '# t\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n'
    const addRow = await web.call('tableMutation', { markdown: md, op: 'addRowBelow', tableIndex: 0, isHeader: false, rowIndex: 1, columnIndex: 1 }) as { markdown: string }
    expect(addRow.markdown).toContain('|  |  |  |')
    const addCol = await web.call('tableMutation', { markdown: md, op: 'addColumnRight', tableIndex: 0, isHeader: false, rowIndex: 1, columnIndex: 1 }) as { markdown: string }
    expect(addCol.markdown).toContain('| A | B |  | C |')
    const align = await web.call('tableMutation', { markdown: md, op: 'setColumnAlign', tableIndex: 0, isHeader: false, rowIndex: 0, columnIndex: 1, align: 'center' }) as { markdown: string }
    expect(align.markdown).toContain('| --- | :---: | --- |')
  })

  it('tableMutation reports unchanged for GFM-illegal edits', async () => {
    const { web } = await boot()
    const md = '| A |\n| --- |\n| 1 |\n'
    const delCol = await web.call('tableMutation', { markdown: md, op: 'deleteColumn', tableIndex: 0, isHeader: false, rowIndex: 0, columnIndex: 0 }) as { unchanged: boolean }
    expect(delCol.unchanged).toBe(true)
    const delHeader = await web.call('tableMutation', { markdown: md, op: 'deleteRow', tableIndex: 0, isHeader: true, rowIndex: 0, columnIndex: 0 }) as { unchanged: boolean }
    expect(delHeader.unchanged).toBe(true)
  })

  it('footnote RPCs mint keys and edit/delete definitions', async () => {
    const { web } = await boot()
    const key = await web.call('nextFootnoteKey', { markdown: 'a[^1] b' }) as { key: string }
    expect(key.key).toBe('2')
    const edited = await web.call('footnoteEdit', { markdown: 't[^1]\n\n[^1]: old', key: '1', content: 'new' }) as { markdown: string }
    expect(edited.markdown).toContain('[^1]: new')
    const del = await web.call('footnoteDelete', { markdown: 'a[^1] b[^2]\n\n[^1]: one\n[^2]: two', key: '1' }) as { markdown: string }
    expect(del.markdown).not.toContain('[^1]')
    expect(del.markdown).toContain('[^2]: two')
  })

  it('batchRestoreTrash restores mixed kinds and reports per-item failures', async () => {
    const { web } = await boot()
    const note = await web.call('createNote', { relativePath: 'a.md', markdown: '# a\n' }) as { noteId: string }
    await web.call('deleteNote', { noteId: note.noteId })
    const up = await web.call('uploadAttachment', { filename: 'x.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64') }) as { attachmentId: string }
    await web.call('deleteAttachment', { attachmentId: up.attachmentId })
    const r = await web.call('batchRestoreTrash', { items: [{ key: 'note:' + note.noteId }, { key: 'attachment:' + up.attachmentId }, { key: 'folder:nonexistent' }] }) as { ok: string[]; failed: Array<{ key: string; error: string }> }
    expect(r.ok).toContain('note:' + note.noteId)
    expect(r.ok).toContain('attachment:' + up.attachmentId)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.key).toBe('folder:nonexistent')
    expect(r.failed[0]!.error).toBeTruthy()
  })

  it('batchPurgeTrash purges a trashed folder by stable trashEntryId', async () => {
    const { web } = await boot()
    await web.call('createNote', { relativePath: 'f/a.md', markdown: '# a\n' })
    const entry = await web.call('trashFolder', { path: 'f' }) as { trashEntryId: string }
    const r = await web.call('batchPurgeTrash', { items: [{ key: 'folder:' + entry.trashEntryId }, { key: 'bogus' }] }) as { ok: string[]; failed: Array<{ key: string; error: string }> }
    expect(r.ok).toEqual(['folder:' + entry.trashEntryId])
    expect(r.failed.map(f => f.key)).toEqual(['bogus'])
    expect(r.failed[0]!.error).toContain('invalid trash key')
  })

  it('removeMatrix with reassignTo:null moves tasks to Inbox (not a not-empty throw)', async () => {
    const { web } = await boot()
    const m = await web.call('createMatrix', { name: 'm' }) as { matrixId: string }
    await web.call('createTask', { title: 't', matrixId: m.matrixId })
    const r = await web.call('removeMatrix', { matrixId: m.matrixId, reassignTo: null }) as { removed: boolean; moved: number }
    expect(r.removed).toBe(true)
    expect(r.moved).toBe(1)
    const tasks = await web.call('listTasks', {}) as Array<{ matrixId: string | null }>
    expect(tasks.some(t => t.matrixId === null)).toBe(true)
  })

  it('removeMatrix taskDisposition:delete-tasks soft-deletes all matrix tasks (no child promotion)', async () => {
    const { web } = await boot()
    const m = await web.call('createMatrix', { name: 'm' }) as { matrixId: string }
    const root = await web.call('createTask', { title: 'root', matrixId: m.matrixId }) as { taskId: string }
    await web.call('createTask', { title: 'child', matrixId: m.matrixId, parentTaskId: root.taskId })
    const r = await web.call('removeMatrix', { matrixId: m.matrixId, taskDisposition: 'delete-tasks' }) as { removed: boolean; deleted: number }
    expect(r.removed).toBe(true)
    expect(r.deleted).toBe(2)
    const all = await web.call('listTasks', { includeDeleted: true }) as Array<{ matrixId: string | null; deletedAt?: string; parentTaskId: string | null }>
    const trashed = all.filter(t => t.matrixId === null && t.deletedAt !== undefined)
    expect(trashed).toHaveLength(2) // root + child both soft-deleted, child NOT promoted
    // child parentTaskId preserved (not promoted to top-level)
    const child = trashed.find(t => t.parentTaskId === root.taskId)
    expect(child).toBeDefined()
  })

  it('uploadAttachment indexable:false stays local (sync is skipped)', async () => {
    const { web } = await boot()
    const up = await web.call('uploadAttachment', { filename: 'x.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hi').toString('base64'), indexable: false }) as { attachmentId: string }
    // Force-sync a non-indexable attachment → skipped (no KnowledgeId), so it rejects.
    await expect(web.call('syncEntity', { entityType: 'attachment', entityId: up.attachmentId })).rejects.toThrow(/did not converge/)
  })

  it('ghost note: deleteNote is idempotent after external file removal', async () => {
    const { web, dir } = await boot()
    const n = await web.call('createNote', { relativePath: 'ghost.md', markdown: '# g\n' }) as { noteId: string }
    await rm(join(dir, 'notes', 'ghost.md'))
    await web.call('deleteNote', { noteId: n.noteId }) // must not throw ENOENT
    const list = await web.call('listNotes', {}) as Array<{ noteId: string }>
    expect(list.some(x => x.noteId === n.noteId)).toBe(false) // gone from tree
  })

  it('createCompanionNote is local-first + idempotent and references the STORED (CJK) filename', async () => {
    const { web } = await boot()
    const up = await web.call('uploadAttachment', { filename: '海报3.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from([1, 2, 3]).toString('base64') }) as { attachmentId: string; filename: string }
    expect(up.filename).toBe('海报3.jpg') // Unicode preserved by safeFilename
    const first = await web.call('createCompanionNote', { attachmentId: up.attachmentId, folder: '工作' }) as { noteId: string; relativePath: string; title: string; created: boolean }
    expect(first.created).toBe(true)
    expect(first.relativePath).toBe('工作/海报3.md') // CJK base preserved (not __3.md)
    expect(first.title).toBe('海报3')
    const doc = await web.call('getNote', { noteId: first.noteId }) as { markdown: string }
    expect(doc.markdown).toContain('attachments/' + up.attachmentId + '/海报3.jpg') // ref matches stored binary
    // Idempotent: a second call returns the SAME note (created:false), no 海报(2).md.
    const second = await web.call('createCompanionNote', { attachmentId: up.attachmentId, folder: '工作' }) as { noteId: string; created: boolean }
    expect(second.created).toBe(false)
    expect(second.noteId).toBe(first.noteId)
    const list = await web.call('listAttachments', {}) as Array<{ companionNoteId?: string; companionNoteTitle?: string }>
    expect(list[0]!.companionNoteId).toBe(first.noteId)
    expect(list[0]!.companionNoteTitle).toBe('海报3')
    const c = await web.call('getCompanionNote', { attachmentId: up.attachmentId }) as { noteId: string } | null
    expect(c).not.toBeNull()
    expect(c!.noteId).toBe(first.noteId)
  })

  it('move preserves NoteId and the Companion relation (no delete+recreate)', async () => {
    const { web } = await boot()
    const up = await web.call('uploadAttachment', { filename: '海报3.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from([1, 2, 3]).toString('base64') }) as { attachmentId: string }
    const note = await web.call('createCompanionNote', { attachmentId: up.attachmentId, folder: '工作' }) as { noteId: string }
    const moved = await web.call('moveNote', { noteId: note.noteId, relativePath: '工作/归档/海报3.md' }) as { noteId: string; relativePath: string }
    expect(moved.noteId).toBe(note.noteId) // NoteId stable across Move
    expect(moved.relativePath).toBe('工作/归档/海报3.md')
    const c = await web.call('getCompanionNote', { attachmentId: up.attachmentId }) as { noteId: string } | null
    expect(c).not.toBeNull()
    expect(c!.noteId).toBe(note.noteId) // Companion relation still resolves to the SAME NoteId
  })

  it('listKnowledge exposes user-facing knowledge only (no WeKnora ids) with a body snippet', async () => {
    const { web } = await boot()
    await web.call('createNote', { relativePath: 'sub/plan.md', markdown: '# 计划\n\n这是第一段正文内容。\n\n第二段。\n' })
    const list = await web.call('listKnowledge', {}) as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    const item = list[0]!
    expect(item.noteId).toBeDefined()
    expect(item.folder).toBe('sub')
    expect(item.title).toBe('计划')
    expect(item.attachmentCount).toBe(0)
    expect(item.summary).toContain('这是第一段正文内容。')
    expect(item.summary).not.toContain('#')
    expect(item.summary).not.toContain('计划') // heading stripped, not the summary
    expect(item).not.toHaveProperty('knowledgeId')
    expect(item).not.toHaveProperty('kbId')
    expect(item).not.toHaveProperty('chunkId')
  })

  it('search enrichment strips WeKnora ids and adds stable Note identity (folder)', async () => {
    const { web, sync } = await boot()
    const created = await web.call('createNote', { relativePath: 'sub/s.md', markdown: '# searchable note\n' }) as { noteId: string }
    await sync.syncNote(created.noteId as never)
    const results = await web.call('search', { query: 'searchable', limit: 5 }) as Array<{ local?: Record<string, unknown>; remote: Record<string, unknown> }>
    expect(results.length).toBeGreaterThan(0)
    const hit = results.find(r => r.local !== undefined)!
    expect(hit).toBeDefined()
    expect(hit.remote).not.toHaveProperty('knowledgeId')
    expect(hit.remote).not.toHaveProperty('kbId')
    expect(hit.remote).not.toHaveProperty('chunkId')
    expect(hit.local!.entityId).toBe(created.noteId)
    expect(hit.local!.folder).toBe('sub')
    expect(hit.local!.relativePath).toBe('sub/s.md')
  })

  it('relatedKnowledge degrades to [] when the Wiki graph is unavailable (offline)', async () => {
    const { web } = await boot()
    const note = await web.call('createNote', { relativePath: 'a.md', markdown: '# a\n' }) as { noteId: string }
    const rel = await web.call('relatedKnowledge', { noteId: note.noteId }) as unknown[]
    expect(Array.isArray(rel)).toBe(true)
    expect(rel).toHaveLength(0)
  })
})

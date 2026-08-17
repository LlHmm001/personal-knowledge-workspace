import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CorrelationId, NoteId, OperationId } from '@deepseek-ai/dsh-pkw-domain'
import PkwEventStoreService from '../../events/src/index.ts'
import PkwWorkspaceService from '../../workspace/src/index.ts'
import NotesService from '../src/index.ts'
import AttachmentsService from '../../attachments/src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function boot() {
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
  ctx.provide('sessionPersistence', {
    list: async () => [],
    load: () => { throw new Error('unused') },
    inspect: () => { throw new Error('unused') },
  } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(PkwEventStoreService)
  await ctx.plugin(PkwWorkspaceService)

  const ws = await ctx.workspaceRegistry.create(dir)
  await ctx.plugin(NotesService, { workspaceId: ws.id })
  await ctx.plugin(AttachmentsService, { workspaceId: ws.id })
  return { ctx, dir, workspaceId: ws.id, notes: ctx.pkwNotes, attachments: ctx.pkwAttachments }
}

function fp(wsId: string, noteId: string, rel: string, hash: string, deleted: boolean): string {
  return createHash('sha256').update(`${wsId}\u0000${noteId}\u0000${rel}\u0000${hash}\u0000${deleted ? '1' : '0'}`).digest('hex')
}

function ch(md: string): string {
  return createHash('sha256').update(md.replace(/\r\n/g, '\n')).digest('hex')
}

describe('pkw notes + attachments core', () => {
  it('creates a note as a real .md file and reads a NoteDocument', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: '工作/a.md', markdown: '# Hello\n\nbody\n' })
    expect(note.noteId.length).toBeGreaterThan(0)
    expect(await readFile(join(dir, 'notes', '工作', 'a.md'), 'utf8')).toContain('# Hello')
    const doc = await notes.getDocument(note.noteId)
    expect(doc.markdown).toContain('id:')
    expect(doc.markdown).toContain('# Hello')
  })

  it('mints a real NoteId instead of adopting a placeholder id', async () => {
    const { notes } = await boot()
    const note = await notes.create({ relativePath: 'p.md', markdown: '---\nid: __placeholder__\n---\n\n# P\n' })
    expect(String(note.noteId)).not.toBe('__placeholder__')
    expect(String(note.noteId).startsWith('note_')).toBe(true)
    const doc = await notes.getDocument(note.noteId)
    expect(doc.markdown).not.toContain('__placeholder__')
    expect(doc.markdown).toContain('id: ' + String(note.noteId))
  })

  it('trash → restore preserves NoteId, then purge removes it permanently', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'life.md', markdown: '# life\n' })
    const id = note.noteId
    await notes.delete(id)
    expect(notes.get(id)!.deletedAt).toBeDefined()
    // restore
    const rec = await notes.restore(id)
    expect(rec.noteId).toBe(id)
    expect(rec.deletedAt).toBeUndefined()
    expect(notes.list().some(n => n.noteId === id)).toBe(true)
    // trash again, then purge
    await notes.delete(id)
    await notes.purge(id)
    expect(notes.get(id)).toBeUndefined()
    expect(notes.list({ includeDeleted: true }).some(n => n.noteId === id)).toBe(false)
  })

  it('re-injects the stable id when a source edit removes it', async () => {
    const { notes } = await boot()
    const note = await notes.create({ relativePath: 'guard.md', markdown: '# v1\n' })
    const rec = await notes.update(note.noteId, '# v2\n') // no frontmatter at all
    expect(rec.noteId).toBe(note.noteId)
    const doc = await notes.getDocument(note.noteId)
    expect(doc.markdown).toContain('id: ' + String(note.noteId))
  })

  it('rejects a source edit that changes the stable id', async () => {
    const { notes } = await boot()
    const note = await notes.create({ relativePath: 'guard2.md', markdown: '# v1\n' })
    await expect(notes.update(note.noteId, '---\nid: note_fake\n---\n\n# v2\n')).rejects.toThrow('cannot change note identity')
    // identity unchanged, content untouched
    expect(String(notes.get(note.noteId)!.noteId)).toBe(String(note.noteId))
    expect((await notes.getDocument(note.noteId)).markdown).toContain('id: ' + String(note.noteId))
  })

  it('reconcile discovers an external .md without id and injects a stable NoteId', async () => {
    const { notes, dir } = await boot()
    await mkdir(join(dir, 'notes', '随手'), { recursive: true })
    await writeFile(join(dir, 'notes', '随手', 'x.md'), '# 随手记录\n', 'utf8')
    const report = await notes.reconcile()
    expect(report.decisions.some(d => d.changeKind === 'note.discovered')).toBe(true)
    const list = notes.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.relativePath).toBe('随手/x.md')
    // id was injected into the real file
    expect(await readFile(join(dir, 'notes', '随手', 'x.md'), 'utf8')).toContain('id: note_')
  })

  it('reconcile detects external update and bumps observedRevision', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    await writeFile(join(dir, 'notes', 'a.md'), `---\nid: ${note.noteId}\n---\n\n# v2\n`, 'utf8')
    const report = await notes.reconcile()
    expect(report.decisions.some(d => d.changeKind === 'note.updated')).toBe(true)
    const got = notes.get(note.noteId)!
    expect(got.observedRevision).toBe(2)
    expect(got.contentHash).not.toBe(note.contentHash)
  })

  it('reconcile detects external delete (soft)', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# x\n' })
    await rm(join(dir, 'notes', 'a.md'))
    await notes.reconcile()
    expect(notes.get(note.noteId)!.deletedAt).toBeDefined()
    expect(notes.list()).toHaveLength(0)
  })

  it('reconcile detects duplicate NoteId as identity conflict', async () => {
    const { notes, dir } = await boot()
    await writeFile(join(dir, 'notes', 'a.md'), '---\nid: note_dup\n---\n\nA\n', 'utf8')
    await writeFile(join(dir, 'notes', 'b.md'), '---\nid: note_dup\n---\n\nB\n', 'utf8')
    await notes.reconcile()
    expect(notes.listIdentityConflicts()).toHaveLength(1)
    expect(notes.listIdentityConflicts()[0]!.noteId).toBe(NoteId('note_dup'))
  })

  it('reconcile is idempotent (no duplicate events on a second pass)', async () => {
    const { ctx, notes } = await boot()
    await notes.create({ relativePath: 'a.md', markdown: '# x\n' })
    const first = await notes.reconcile()
    const second = await notes.reconcile()
    expect(second.decisions).toHaveLength(0)
    const noteEvents = ctx.pkwEvents.list({ aggregateType: 'note' })
    expect(noteEvents.length).toBeGreaterThan(0)
  })

  it('moves a note keeping its NoteId and rewriting managed links (code blocks untouched)', async () => {
    const { notes, dir } = await boot()
    const markdown = '# x\n\n![img](../attachments/att_x/y.png)\n\n[doc](../attachments/att_d/spec.pdf)\n\n`![fake](../attachments/att_f/a.png)`\n\n```md\n![code](../attachments/att_c/a.png)\n```\n\nhttps://example.com/attachments/foo\n'
    const note = await notes.create({ relativePath: 'a.md', markdown })
    await notes.move(note.noteId, 'sub/a.md')
    const moved = notes.get(note.noteId)!
    expect(moved.relativePath).toBe('sub/a.md')
    const content = await readFile(join(dir, 'notes', 'sub', 'a.md'), 'utf8')
    expect(content).toContain('![img](../../attachments/att_x/y.png)')
    expect(content).toContain('[doc](../../attachments/att_d/spec.pdf)')
    expect(content).toContain('`![fake](../attachments/att_f/a.png)`')   // inline code untouched
    expect(content).toContain('![code](../attachments/att_c/a.png)')      // fenced code untouched
    expect(content).toContain('https://example.com/attachments/foo')      // HTTP untouched
  })

  it('imports arbitrary binary attachment and reads it back', async () => {
    const { attachments } = await boot()
    const bytes = new Uint8Array([0, 255, 128, 1, 2, 3, 0])
    const rec = await attachments.importFile({ content: bytes, filename: 'data.bin', mimeType: 'application/octet-stream' })
    expect(rec.id.length).toBeGreaterThan(0)
    expect(rec.sha256).toBeDefined()
    const read = await attachments.open(rec.id)
    expect(Array.from(read)).toEqual(Array.from(bytes))
  })

  it('reconcile detects external binary replacement as the SAME attachment', async () => {
    const { attachments, dir } = await boot()
    const rec = await attachments.importFile({ content: new Uint8Array([1, 2, 3]), filename: 'f.bin', mimeType: 'x' })
    await writeFile(join(dir, 'attachments', rec.id, 'f.bin'), Buffer.from([9, 9, 9, 9]))
    const report = await attachments.reconcile()
    expect(report.decisions.some(d => d.changeKind === 'attachment.updated')).toBe(true)
    const got = attachments.get(rec.id)!
    expect(got.observedRevision).toBe(2)
    expect(got.sha256).not.toBe(rec.sha256)
  })

  it('repairs a stale projection without re-emitting a durable event (crash before projection)', async () => {
    const { ctx, notes, dir, workspaceId } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    // Simulate: file mutated to v2, durable commit succeeded, projection write "crashed".
    const v2 = `---\nid: ${note.noteId}\n---\n\n# v2\n`
    await writeFile(join(dir, 'notes', 'a.md'), v2, 'utf8')
    const h2 = ch(v2)
    const fingerprint = fp(String(workspaceId), String(note.noteId), 'a.md', h2, false)
    await ctx.pkwEvents.commit({
      operationContext: { workspaceId, actor: { type: 'system' }, operationId: OperationId('manual'), correlationId: CorrelationId('c') },
      events: [{ type: 'note.updated', aggregateType: 'note', aggregateId: String(note.noteId), payload: { noteId: String(note.noteId), afterStateFingerprint: fingerprint, contentHash: h2, observedRevision: 2 } }],
    })
    // Projection still holds v1 (stale). Reconcile must repair it without a NEW durable event.
    const eventsBefore = ctx.pkwEvents.list({ aggregateType: 'note' }).length
    const report = await notes.reconcile()
    expect(report.decisions).toHaveLength(0)
    expect(notes.get(note.noteId)!.contentHash).toBe(h2)
    expect(notes.get(note.noteId)!.observedRevision).toBe(2)
    expect(ctx.pkwEvents.list({ aggregateType: 'note' }).length).toBe(eventsBefore)
  })

  it('recovers from a crash BEFORE the durable commit by discovering the new filesystem state', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# v1\n' })
    // File mutated but NO durable event (crash before commit). Reconcile must observe it.
    const v2 = `---\nid: ${note.noteId}\n---\n\n# v2\n`
    await writeFile(join(dir, 'notes', 'a.md'), v2, 'utf8')
    const report = await notes.reconcile()
    expect(report.decisions.some(d => d.changeKind === 'note.updated')).toBe(true)
    expect(notes.get(note.noteId)!.contentHash).toBe(ch(v2))
  })

  it('preserves unknown frontmatter fields and strips quotes when discovering a real Markdown', async () => {
    const { notes, dir } = await boot()
    const md = '---\ntitle: "AI: Memory & Agent"\ntags:\n  - agent\n  - "deep seek"\ncustom:\n  nested: value\n---\n\nbody\n'
    await writeFile(join(dir, 'notes', 'a.md'), md, 'utf8')
    await notes.reconcile()
    const content = await readFile(join(dir, 'notes', 'a.md'), 'utf8')
    expect(content).toContain('id: note_')              // id injected
    expect(content).toContain('custom:\n  nested: value') // unknown nested field preserved verbatim
    expect(content).toContain('title: "AI: Memory & Agent"') // quoted title untouched
    const note = notes.list()[0]!
    expect(note.title).toBe('AI: Memory & Agent')        // quotes stripped for the projection
  })

  it('restores a deleted attachment when its file reappears (same identity)', async () => {
    const { attachments, dir } = await boot()
    const rec = await attachments.importFile({ content: new Uint8Array([1, 2, 3]), filename: 'f.bin', mimeType: 'x' })
    await attachments.remove(rec.id)
    expect(attachments.get(rec.id)!.deletedAt).toBeDefined()
    await writeFile(join(dir, 'attachments', rec.id, 'f.bin'), Buffer.from([1, 2, 3]))
    const report = await attachments.reconcile()
    expect(report.decisions.some(d => d.changeKind === 'attachment.restored')).toBe(true)
    const got = attachments.get(rec.id)!
    expect(got.deletedAt).toBeUndefined()
    expect(got.id).toBe(rec.id) // identity unchanged
  })

  it('attachment trash → restore keeps identity, then purge removes it permanently', async () => {
    const { attachments } = await boot()
    const rec = await attachments.importFile({ content: new Uint8Array([9, 9, 9]), filename: 't.bin', mimeType: 'x' })
    const id = rec.id
    await attachments.remove(id)
    expect(attachments.get(id)!.deletedAt).toBeDefined()
    // explicit restore
    const restored = await attachments.restore(id)
    expect(restored.id).toBe(id)
    expect(restored.deletedAt).toBeUndefined()
    // trash again + purge
    await attachments.remove(id)
    await attachments.purge(id)
    expect(attachments.get(id)).toBeUndefined()
    expect(attachments.list({ includeDeleted: true }).some(a => a.id === id)).toBe(false)
  })

  it('creates folders as real directories and lists them', async () => {
    const { notes, dir } = await boot()
    await notes.createFolder('工作/项目A')
    await notes.createFolder('工作/项目B')
    await notes.createFolder('学习/Agent')
    const folders = await notes.listFolders()
    expect(folders).toEqual(expect.arrayContaining(['工作', '工作/项目A', '工作/项目B', '学习', '学习/Agent']))
    expect(folders.sort()).toEqual(folders)
  })

  it('renames a folder, preserving NoteId while updating note paths', async () => {
    const { notes } = await boot()
    await notes.createFolder('工作/项目A')
    const note = await notes.create({ relativePath: '工作/项目A/a.md', markdown: '# A\n' })
    const before = note.noteId
    await notes.renameFolder('工作/项目A', '工作/项目B')
    const rec = notes.get(before)!
    expect(rec.noteId).toBe(before) // NoteId stable
    expect(rec.relativePath).toBe('工作/项目B/a.md')
    expect(notes.list().every(n => n.noteId === before)).toBe(true)
  })

  it('trashFolder archives a non-empty folder and marks descendant notes deleted', async () => {
    const { notes } = await boot()
    await notes.createFolder('项目')
    const a = await notes.create({ relativePath: '项目/a.md', markdown: '# a\n' })
    const b = await notes.create({ relativePath: '项目/sub/b.md', markdown: '# b\n' })
    await notes.trashFolder('项目')
    expect((await notes.listFolders()).includes('项目')).toBe(false)
    expect(notes.get(a.noteId)!.deletedAt).toBeDefined()
    expect(notes.get(b.noteId)!.deletedAt).toBeDefined()
    expect(notes.list().some(n => n.noteId === a.noteId || n.noteId === b.noteId)).toBe(false)
    // restore the folder: same NoteIds, un-deleted, folder back.
    await notes.restoreFolder('项目')
    expect((await notes.listFolders()).includes('项目')).toBe(true)
    expect(notes.get(a.noteId)!.deletedAt).toBeUndefined()
    expect(notes.get(b.noteId)!.deletedAt).toBeUndefined()
    expect(notes.list().some(n => n.noteId === a.noteId)).toBe(true)
    // trash again + purge permanently
    await notes.trashFolder('项目')
    await notes.purgeFolder('项目')
    expect((await notes.listFolders()).includes('项目')).toBe(false)
    expect(notes.get(a.noteId)).toBeUndefined()
    expect(notes.get(b.noteId)).toBeUndefined()
    expect(notes.list({ includeDeleted: true }).some(n => n.noteId === a.noteId || n.noteId === b.noteId)).toBe(false)
  })

  it('deletes an empty folder but rejects a non-empty one', async () => {
    const { notes } = await boot()
    await notes.createFolder('空')
    await notes.deleteFolder('空')
    expect((await notes.listFolders()).includes('空')).toBe(false)
    await notes.createFolder('非空')
    await notes.create({ relativePath: '非空/a.md', markdown: '# a\n' })
    await expect(notes.deleteFolder('非空')).rejects.toThrow('not empty')
  })

  it('persists manual order per parent and rekeys on folder rename', async () => {
    const { notes } = await boot()
    await notes.createFolder('F')
    const a = await notes.create({ relativePath: 'F/a.md', markdown: '# a\n' })
    const b = await notes.create({ relativePath: 'F/b.md', markdown: '# b\n' })
    const c = await notes.create({ relativePath: 'F/c.md', markdown: '# c\n' })
    await notes.setOrder('F', [
      { kind: 'note', id: String(c.noteId) },
      { kind: 'note', id: String(a.noteId) },
      { kind: 'note', id: String(b.noteId) },
    ])
    expect(notes.getOrder('F').map(o => o.id)).toEqual([String(c.noteId), String(a.noteId), String(b.noteId)])
    // rename folder: order record migrates to new parent path.
    await notes.renameFolder('F', 'G')
    expect(notes.getOrder('G').map(o => o.id)).toEqual([String(c.noteId), String(a.noteId), String(b.noteId)])
    expect(notes.getOrder('F')).toEqual([])
  })
})

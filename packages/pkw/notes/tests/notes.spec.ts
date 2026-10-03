import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CorrelationId, NoteId, NoteUpdateConflictError, OperationId } from '@deepseek-ai/dsh-pkw-domain'
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
  it('leaves active notes and events unchanged when moving a folder into trash fails', async () => {
    const { notes, ctx, dir } = await boot()
    const note = await notes.create({ relativePath: 'work/a.md', markdown: '# keep active\n' })
    const eventsBefore = ctx.pkwEvents.list({ aggregateType: 'note', aggregateId: String(note.noteId) })
    const mover = notes as unknown as { moveFile(src: unknown, dst: unknown): Promise<void> }
    const spy = vi.spyOn(mover, 'moveFile').mockRejectedValueOnce(new Error('injected rename failure'))
    try {
      await expect(notes.trashFolder('work')).rejects.toThrow('injected rename failure')
      expect(notes.get(note.noteId)).toEqual(note)
      expect(await notes.listTrashFolders()).toEqual([])
      expect(ctx.pkwEvents.list({ aggregateType: 'note', aggregateId: String(note.noteId) })).toEqual(eventsBefore)
      expect(await readFile(join(dir, 'notes', 'work', 'a.md'), 'utf8')).toContain('# keep active')
    } finally {
      spy.mockRestore()
    }
  })

  it('retains the folder archive recovery entry if recording events fails after the physical move', async () => {
    const { notes, ctx, dir } = await boot()
    const note = await notes.create({ relativePath: 'work/a.md', markdown: '# recover me\n' })
    const spy = vi.spyOn(ctx.pkwEvents, 'commit').mockRejectedValueOnce(new Error('injected event storage failure'))
    try {
      await expect(notes.trashFolder('work')).rejects.toThrow('injected event storage failure')
    } finally {
      spy.mockRestore()
    }
    const entry = (await notes.listTrashFolders())[0]!
    expect(entry).toBeDefined()
    expect(await readFile(join(dir, 'archive', entry.archivedPath, 'a.md'), 'utf8')).toContain('# recover me')
    await notes.restoreFolder(entry.trashEntryId)
    expect((await notes.getDocument(note.noteId)).markdown).toContain('# recover me')
    expect(await notes.listTrashFolders()).toEqual([])
  })

  it('reads and reconciles the full binary after an external attachment grows', async () => {
    const { attachments, dir } = await boot()
    const attachment = await attachments.importFile({ content: Buffer.from('x'), filename: 'grow.txt', mimeType: 'text/plain' })
    const replacement = Buffer.from('external edit is much larger than the original')
    await writeFile(join(dir, attachment.relativePath), replacement)
    expect(Buffer.from(await attachments.open(attachment.id))).toEqual(replacement)
    const report = await attachments.reconcile()
    expect(report.decisions.map(x => x.changeKind)).toEqual(['attachment.updated'])
    expect(attachments.get(attachment.id)).toMatchObject({
      sizeBytes: replacement.length,
      sha256: createHash('sha256').update(replacement).digest('hex'),
      observedRevision: attachment.observedRevision + 1,
    })
    expect((await attachments.reconcile()).decisions).toEqual([])
  })

  it('accepts only one of two concurrent writes based on the same note snapshot, then releases the queue', async () => {
    const { notes } = await boot()
    const note = await notes.create({ relativePath: 'compare.md', markdown: '# original\n' })
    const guard = { expectedRevision: note.observedRevision, expectedContentHash: note.contentHash }
    const writes = await Promise.allSettled([
      notes.update(note.noteId, '# first\n', guard),
      notes.update(note.noteId, '# stale second\n', guard),
    ])
    expect(writes[0]!.status).toBe('fulfilled')
    expect(writes[1]).toMatchObject({ status: 'rejected', reason: { code: 'PKW_NOTE_CONFLICT' } })
    expect((await notes.getDocument(note.noteId)).markdown).toContain('# first')
    const latest = notes.get(note.noteId)!
    await notes.update(note.noteId, '# next valid save\n', { expectedRevision: latest.observedRevision, expectedContentHash: latest.contentHash })
    expect((await notes.getDocument(note.noteId)).markdown).toContain('# next valid save')
  })

  it('rejects concurrent creation of a second canonical file with an already owned NoteId', async () => {
    const { notes, dir } = await boot()
    const writes = await Promise.allSettled([
      notes.create({ relativePath: 'first.md', markdown: '---\nid: note_shared\n---\n\n# first\n' }),
      notes.create({ relativePath: 'second.md', markdown: '---\nid: note_shared\n---\n\n# second\n' }),
    ])
    expect(writes[0]!.status).toBe('fulfilled')
    expect(writes[1]).toMatchObject({ status: 'rejected' })
    expect(notes.list()).toHaveLength(1)
    expect(notes.get(NoteId('note_shared'))!.relativePath).toBe('first.md')
    await expect(readFile(join(dir, 'notes', 'second.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a stale conditional write when canonical bytes changed outside the service', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'external.md', markdown: '# original\n' })
    const external = `---\nid: ${note.noteId}\n---\n\n# edited externally\n`
    await writeFile(join(dir, 'notes', 'external.md'), external)
    await expect(notes.update(note.noteId, '# stale\n', {
      expectedRevision: note.observedRevision,
      expectedContentHash: note.contentHash,
    })).rejects.toBeInstanceOf(NoteUpdateConflictError)
    expect(await readFile(join(dir, 'notes', 'external.md'), 'utf8')).toBe(external)
    const refreshed = await notes.getDocument(note.noteId)
    await notes.update(note.noteId, '# saved after reading the external edit\n', {
      expectedRevision: refreshed.note.observedRevision,
      expectedContentHash: refreshed.note.contentHash,
    })
    expect((await notes.getDocument(note.noteId)).markdown).toContain('# saved after reading the external edit')
  })

  it('restores an individual note from its folder archive without touching another trash entry', async () => {
    const { notes } = await boot()
    const note = await notes.create({ relativePath: 'work/a.md', markdown: '# first\n' })
    const folder = await notes.trashFolder('work')
    await notes.restore(note.noteId)
    expect((await notes.getDocument(note.noteId)).markdown).toContain('# first')
    await notes.purgeFolder(folder.trashEntryId)
    expect(notes.get(note.noteId)!.deletedAt).toBeUndefined()
    expect((await notes.getDocument(note.noteId)).markdown).toContain('# first')
  })

  it('purges an individual note from a folder archive so restoring the folder cannot resurrect it', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'work/a.md', markdown: '# first\n' })
    const folder = await notes.trashFolder('work')
    await notes.purge(note.noteId)
    await notes.restoreFolder(folder.trashEntryId)
    await notes.reconcile()
    expect(notes.list({ includeDeleted: true })).toEqual([])
    await expect(readFile(join(dir, 'notes', 'work', 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes a folder rename with an in-flight save and keeps only one canonical note', async () => {
    const { notes, ctx, dir } = await boot()
    const note = await notes.create({ relativePath: 'work/a.md', markdown: '# original\n' })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writeText = ctx.fs.writeText.bind(ctx.fs)
    const spy = vi.spyOn(ctx.fs, 'writeText').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return writeText(...args)
    })
    try {
      const save = notes.update(note.noteId, '# saved\n')
      await entered.promise
      const move = notes.renameFolder('work', 'moved')
      release.resolve()
      await Promise.all([save, move])
      expect(notes.get(note.noteId)!.relativePath).toBe('moved/a.md')
      expect(await readFile(join(dir, 'notes', 'moved', 'a.md'), 'utf8')).toContain('# saved')
      await expect(readFile(join(dir, 'notes', 'work', 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      release.resolve()
      spy.mockRestore()
    }
  })

  it('restores only the identities belonging to the selected folder trash entry', async () => {
    const { notes } = await boot()
    const first = await notes.create({ relativePath: 'work/a.md', markdown: '# first\n' })
    const firstTrash = await notes.trashFolder('work')
    const second = await notes.create({ relativePath: 'work/a.md', markdown: '# second\n' })
    const secondTrash = await notes.trashFolder('work')
    await notes.restoreFolder(firstTrash.trashEntryId)
    expect(notes.get(first.noteId)!.deletedAt).toBeUndefined()
    expect(notes.get(second.noteId)!.deletedAt).toBeDefined()
    expect((await notes.getDocument(first.noteId)).markdown).toContain('# first')
    await notes.purgeFolder(secondTrash.trashEntryId)
    expect(notes.resolveByPath('work/a.md')!.noteId).toBe(first.noteId)
    expect(notes.get(second.noteId)).toBeUndefined()
  })

  it('refuses to overwrite an occupied note destination when moving or restoring', async () => {
    const { notes, dir } = await boot()
    const original = await notes.create({ relativePath: 'original.md', markdown: '# original\n' })
    const occupied = await notes.create({ relativePath: 'occupied.md', markdown: '# occupied\n' })
    const occupiedBytes = await readFile(join(dir, 'notes', 'occupied.md'))
    await expect(notes.move(original.noteId, 'occupied.md')).rejects.toThrow()
    expect(await readFile(join(dir, 'notes', 'occupied.md'))).toEqual(occupiedBytes)
    expect((await notes.getDocument(original.noteId)).markdown).toContain('# original')
    await notes.delete(original.noteId)
    const replacement = await notes.create({ relativePath: 'original.md', markdown: '# replacement\n' })
    await expect(notes.restore(original.noteId)).rejects.toThrow()
    expect((await notes.getDocument(replacement.noteId)).markdown).toContain('# replacement')
    expect(notes.get(original.noteId)!.deletedAt).toBeDefined()
    expect(notes.resolveByPath('occupied.md')!.noteId).toBe(occupied.noteId)
  })

  it('purging a trashed note preserves a different note that reused its path', async () => {
    const { notes, dir } = await boot()
    const old = await notes.create({ relativePath: 'reuse.md', markdown: '# old\n' })
    await notes.delete(old.noteId)
    const current = await notes.create({ relativePath: 'reuse.md', markdown: '# current\n' })
    const bytes = await readFile(join(dir, 'notes', 'reuse.md'))
    await notes.purge(old.noteId)
    expect(await readFile(join(dir, 'notes', 'reuse.md'))).toEqual(bytes)
    expect(notes.get(old.noteId)).toBeUndefined()
    expect(notes.resolveByPath('reuse.md')!.noteId).toBe(current.noteId)
  })

  it('rejects purging an active note without deleting its canonical file', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'active.md', markdown: '# keep\n' })
    await expect(notes.purge(note.noteId)).rejects.toThrow('not trashed')
    expect(await readFile(join(dir, 'notes', 'active.md'), 'utf8')).toContain('# keep')
    expect(notes.get(note.noteId)).toBeDefined()
  })

  it('refuses to replace an earlier archived note when its path is reused', async () => {
    const { notes, dir } = await boot()
    const old = await notes.create({ relativePath: 'reuse.md', markdown: '# old archive\n' })
    await notes.delete(old.noteId)
    const archived = await readFile(join(dir, 'archive', 'reuse.md'))
    const current = await notes.create({ relativePath: 'reuse.md', markdown: '# current\n' })
    await expect(notes.delete(current.noteId)).rejects.toThrow()
    expect(await readFile(join(dir, 'archive', 'reuse.md'))).toEqual(archived)
    expect((await notes.getDocument(current.noteId)).markdown).toContain('# current')
    expect(notes.get(current.noteId)!.deletedAt).toBeUndefined()
  })

  it('purging an old folder trash entry preserves notes in a recreated folder', async () => {
    const { notes, dir } = await boot()
    const old = await notes.create({ relativePath: 'work/a.md', markdown: '# old\n' })
    const entry = await notes.trashFolder('work')
    const current = await notes.create({ relativePath: 'work/a.md', markdown: '# current\n' })
    const bytes = await readFile(join(dir, 'notes', 'work', 'a.md'))
    await notes.purgeFolder(entry.trashEntryId)
    expect(await readFile(join(dir, 'notes', 'work', 'a.md'))).toEqual(bytes)
    expect(notes.get(current.noteId)).toBeDefined()
    expect(notes.resolveByPath('work/a.md')!.noteId).toBe(current.noteId)
    expect(notes.get(old.noteId)).toBeUndefined()
  })

  it('reconcile treats an external rename as the same active note and retains metadata', async () => {
    const { notes, dir } = await boot()
    const initial = await notes.create({ relativePath: 'before.md', markdown: '# retained\n', attachmentBacked: true })
    const note = await notes.update(initial.noteId, '# updated\n')
    await rename(join(dir, 'notes', 'before.md'), join(dir, 'notes', 'after.md'))
    const report = await notes.reconcile()
    const current = notes.get(note.noteId)!
    expect(current.deletedAt).toBeUndefined()
    expect(current.relativePath).toBe('after.md')
    expect(current.observedRevision).toBe(note.observedRevision)
    expect(current.attachmentBacked).toBe(true)
    expect(current.createdAt).toBe(note.createdAt)
    expect(notes.resolveByPath('before.md')).toBeUndefined()
    expect(notes.resolveByPath('after.md')!.noteId).toBe(note.noteId)
    expect(report.decisions.map(x => x.changeKind)).toEqual(['note.moved'])
    expect((await notes.reconcile()).decisions).toEqual([])
  })

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

  it('folder trash uses stable identity: trash → restore → trash again (no ENOTEMPTY)', async () => {
    const { notes } = await boot()
    await notes.createFolder('acceptance')
    const a = await notes.create({ relativePath: 'acceptance/a.md', markdown: '# a\n' })
    const e1 = await notes.trashFolder('acceptance')
    expect(e1.trashEntryId).toBeDefined()
    expect((await notes.listFolders()).includes('acceptance')).toBe(false)
    expect(notes.get(a.noteId)!.deletedAt).toBeDefined()
    await notes.restoreFolder(e1.trashEntryId)
    expect((await notes.listFolders()).includes('acceptance')).toBe(true)
    expect(notes.get(a.noteId)!.deletedAt).toBeUndefined()
    // second trash must succeed (no archive/<path> collision)
    const e2 = await notes.trashFolder('acceptance')
    expect(String(e2.trashEntryId)).not.toBe(String(e1.trashEntryId))
    await notes.purgeFolder(e2.trashEntryId)
    expect((await notes.listFolders()).includes('acceptance')).toBe(false)
    expect(notes.get(a.noteId)).toBeUndefined()
    expect(await notes.listTrashFolders()).toHaveLength(0)
  })

  it('two trash entries for the same recreated path are independent', async () => {
    const { notes } = await boot()
    await notes.createFolder('acceptance')
    await notes.create({ relativePath: 'acceptance/a.md', markdown: '# a\n' })
    const e1 = await notes.trashFolder('acceptance')
    await notes.createFolder('acceptance')
    await notes.create({ relativePath: 'acceptance/b.md', markdown: '# b\n' })
    const e2 = await notes.trashFolder('acceptance')
    const ids = (await notes.listTrashFolders()).map(e => String(e.trashEntryId)).sort()
    expect(ids).toEqual([String(e1.trashEntryId), String(e2.trashEntryId)].sort())
    // purging one must not affect the other
    await notes.purgeFolder(e1.trashEntryId)
    expect((await notes.listTrashFolders()).map(e => String(e.trashEntryId))).toEqual([String(e2.trashEntryId)])
  })

  it('restore conflicts when the original path is re-occupied', async () => {
    const { notes } = await boot()
    await notes.createFolder('acceptance')
    await notes.create({ relativePath: 'acceptance/a.md', markdown: '# a\n' })
    const e1 = await notes.trashFolder('acceptance')
    await notes.createFolder('acceptance')
    await expect(notes.restoreFolder(e1.trashEntryId)).rejects.toThrow('already exists')
  })

  it('trashes any folder (empty or nested) into a stable entry', async () => {
    const { notes } = await boot()
    await notes.createFolder('空')
    await notes.trashFolder('空')
    expect((await notes.listFolders()).includes('空')).toBe(false)
    await notes.createFolder('非空')
    await notes.create({ relativePath: '非空/sub/b.md', markdown: '# b\n' })
    await notes.trashFolder('非空')
    expect((await notes.listFolders()).includes('非空')).toBe(false)
    expect(await notes.listTrashFolders()).toHaveLength(2)
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

  it('delete is idempotent when the canonical file is externally removed', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'ghost.md', markdown: '# ghost\n' })
    await rm(join(dir, 'notes', 'ghost.md'))
    await notes.delete(note.noteId) // must NOT throw ENOENT
    expect(notes.get(note.noteId)!.deletedAt).toBeDefined()
    await notes.delete(note.noteId) // second delete: no-op
    expect(notes.get(note.noteId)!.deletedAt).toBeDefined()
  })

  it('getDocument relocates by NoteId when the file was externally moved', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'a.md', markdown: '# a\n' })
    const idStr = String(note.noteId)
    await rm(join(dir, 'notes', 'a.md'))
    await writeFile(join(dir, 'notes', 'moved.md'), '---\nid: ' + idStr + '\n---\n\n# a moved\n')
    const doc = await notes.getDocument(note.noteId) // should relocate to moved.md
    expect(doc.note.relativePath).toBe('moved.md')
    expect(doc.markdown).toContain('# a moved')
  })

  it('getDocument throws a distinct missing error when the file is truly gone', async () => {
    const { notes, dir } = await boot()
    const note = await notes.create({ relativePath: 'gone.md', markdown: '# gone\n' })
    await rm(join(dir, 'notes', 'gone.md'))
    await expect(notes.getDocument(note.noteId)).rejects.toThrow(/file is missing/)
  })

  it('listMissingNotes detects registry records whose file is missing', async () => {
    const { notes, dir } = await boot()
    const a = await notes.create({ relativePath: 'a.md', markdown: '# a\n' })
    await notes.create({ relativePath: 'b.md', markdown: '# b\n' })
    await rm(join(dir, 'notes', 'a.md'))
    const missing = await notes.listMissingNotes()
    expect(missing.map(m => m.noteId)).toEqual([String(a.noteId)])
  })
})

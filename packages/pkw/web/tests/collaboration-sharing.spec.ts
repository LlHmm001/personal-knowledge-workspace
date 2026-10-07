import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { replaceNoteId, splitFrontmatter } from '@deepseek-ai/dsh-pkw-notes'
import { AccessError, IdentityStore, type Space } from '../src/collaboration/identity.ts'
import { SharingService } from '../src/collaboration/sharing.ts'
import { createSpaceRuntime, type SpaceRuntime } from '../src/collaboration/runtime.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const PASSWORD = 'Synthetic sharing passphrase 2026!'
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { resolve, promise } }
class ContentDouble {
  notes = new Map<string, { markdown: string; relativePath: string }>()
  files = new Map<string, { bytes: Buffer; filename: string; mimeType: string; indexable: boolean }>()
  calls: string[] = []
  afterUpload?: () => void | Promise<void>
  failAfterUpload = false
  failCreateAfterWrite = false
  runtime: SpaceRuntime = { web: { call: (method: string, args: Record<string, unknown>) => this.call(method, args) } as unknown as SpaceRuntime['web'], routes: [], close: async () => {} }
  async call(method: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push(method)
    if (method === 'getNote') {
      const entry = this.notes.get(String(args.noteId))
      if (!entry) throw new Error('Unknown note')
      const { body, frontmatterRaw } = splitFrontmatter(entry.markdown)
      return { note: { noteId: args.noteId, contentHash: sha(entry.markdown.replace(/\r\n/g, '\n')), title: 'Synthetic title' }, markdown: entry.markdown, body, frontmatter: frontmatterRaw, attachments: [...body.matchAll(/\]\((?:\.\.\/)*attachments\/(att_[^/]+)\/[^)]+\)/g)].map(match => ({ attachmentId: match[1] })) }
    }
    if (method === 'getAttachment' || method === 'downloadAttachment') {
      const file = this.files.get(String(args.attachmentId))
      if (!file) throw new Error('Unknown attachment')
      return method === 'getAttachment' ? { attachment: { filename: file.filename, indexable: file.indexable } } : { attachmentId: args.attachmentId, filename: file.filename, mimeType: file.mimeType, contentBase64: file.bytes.toString('base64') }
    }
    if (method === 'uploadAttachment') {
      const attachmentId = 'att_copy' + this.files.size
      const filename = String(args.filename)
      this.files.set(attachmentId, { filename, bytes: Buffer.from(String(args.contentBase64), 'base64'), mimeType: String(args.mimeType), indexable: args.indexable !== false })
      if (this.afterUpload) await this.afterUpload()
      if (this.failAfterUpload) throw new Error('Injected lost upload acknowledgement')
      return { attachmentId, filename }
    }
    if (method === 'createNote') {
      const noteId = 'note_copy' + this.notes.size, relativePath = String(args.relativePath)
      if ([...this.notes.values()].some(note => note.relativePath === relativePath)) throw new Error('Path exists')
      this.notes.set(noteId, { relativePath, markdown: replaceNoteId(String(args.markdown), noteId) })
      if (this.failCreateAfterWrite) throw new Error('Injected lost create acknowledgement')
      return { noteId, relativePath }
    }
    throw new Error('Unimplemented test runtime method: ' + method)
  }
}
async function fixture(real = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-share-test-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const identity = await IdentityStore.open(join(root, 'identity.sqlite'))
  cleanups.push(async () => identity.close())
  await identity.bootstrap('owner', PASSWORD)
  const { session } = await identity.login('owner', PASSWORD)
  const privateSpace = identity.spaces(session.id).find(space => space.kind === 'private')!
  const team = identity.createTeam(session.id, 'Shared scope')
  const source = new ContentDouble(), target = new ContentDouble(), runtimes = new Map<string, SpaceRuntime>()
  const runtime = async (space: Space) => {
    if (!real) return space.id === privateSpace.id ? source.runtime : target.runtime
    if (!runtimes.has(space.id)) {
      const instance = await createSpaceRuntime(root, space)
      runtimes.set(space.id, instance); cleanups.push(() => instance.close())
    }
    return runtimes.get(space.id)!
  }
  const clock = { now: Date.UTC(2026, 9, 2) }, deps = { identity, runtime, dataPath: root, now: () => clock.now }
  const sharing = new SharingService(deps)
  source.notes.set('note_source', { markdown: '---\nid: note_source\ntitle: Original\ntags: [private]\n---\n# Private source\n[report](../../attachments/att_source/report.txt)\n[[Other private note]]\n', relativePath: 'folder/source.md' })
  source.files.set('att_source', { bytes: Buffer.from('ACTUAL REFERENCED FILE'), filename: 'report.txt', mimeType: 'text/plain', indexable: false })
  const input = { sourceSpaceId: privateSpace.id, targetSpaceId: team.id, noteId: 'note_source' }
  return { root, identity, session, privateSpace, team, source, target, deps, clock, sharing, input, runtime }
}

describe('explicit private-to-team copying', () => {
  it('copies only confirmed note/assets with new IDs using real isolated SQLite/filesystem runtimes', async () => {
    const f = await fixture(true), source = await f.runtime(f.privateSpace), target = await f.runtime(f.team)
    const attachment = await source.web.call('uploadAttachment', { filename: '资料 (1).txt', mimeType: 'text/plain', indexable: false, contentBase64: Buffer.from('ONLY REFERENCED ORIGINAL BYTES').toString('base64') }) as { attachmentId: string; filename: string }
    await source.web.call('uploadAttachment', { filename: 'not-shared.txt', mimeType: 'text/plain', contentBase64: Buffer.from('PRIVATE UNREFERENCED FILE').toString('base64') })
    await source.web.call('createNote', { relativePath: 'other.md', markdown: '# PRIVATE OTHER NOTE' })
    const markdown = '---\nid: __placeholder__\ntitle: A real private note\ntags: [one]\n---\n# Original\n[中文](../attachments/' + attachment.attachmentId + '/' + encodeURIComponent(attachment.filename).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16)) + ')\n[[other]]\n\n```txt\nattachments/att_sample/example.txt\n```\n'
    const note = await source.web.call('createNote', { relativePath: 'source.md', markdown }) as { noteId: string }
    const before = await source.web.call('getNote', { noteId: note.noteId }) as { markdown: string }
    const preview = await f.sharing.preview(f.session.id, { ...f.input, noteId: note.noteId })
    expect(preview.attachments.map(a => a.attachmentId)).toEqual([attachment.attachmentId])
    expect((await target.web.call('listNotes', {})) as unknown[]).toHaveLength(0)
    const result = await f.sharing.commit(f.session.id, preview.token)
    expect(result.status).toBe('complete'); expect(result.noteId).not.toBe(note.noteId)
    expect(result.copiedAttachmentIds).toHaveLength(1)
    expect(result.copiedAttachmentIds[0]).not.toBe(attachment.attachmentId)
    const copy = await target.web.call('getNote', { noteId: result.noteId! }) as { markdown: string; attachments: Array<{ attachmentId: string }> }
    expect(copy.markdown).toContain('# Original'); expect(copy.markdown).toContain('tags: [one]')
    expect(copy.markdown).toContain('[[other]]'); expect(copy.markdown).toContain('attachments/att_sample/example.txt')
    expect(copy.attachments.map(a => a.attachmentId)).toEqual(result.copiedAttachmentIds)
    expect(copy.markdown).not.toContain(attachment.attachmentId)
    expect((await source.web.call('getNote', { noteId: note.noteId }) as { markdown: string }).markdown).toBe(before.markdown)
    const copiedFile = await target.web.call('downloadAttachment', { attachmentId: result.copiedAttachmentIds[0]! }) as { contentBase64: string }
    expect(Buffer.from(copiedFile.contentBase64, 'base64').toString()).toBe('ONLY REFERENCED ORIGINAL BYTES')
    expect(await f.sharing.commit(f.session.id, preview.token)).toEqual(result)
    expect(await new SharingService(f.deps).commit(f.session.id, preview.token)).toEqual(result)
    expect(await target.web.call('listNotes', {})).toHaveLength(1)
    expect(await target.web.call('listAttachments', {})).toHaveLength(1)
    const receiptPath = join(f.root, 'shares', sha(preview.token) + '.json'), receipt = await readFile(receiptPath, 'utf8')
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600)
    expect(receipt).not.toContain(preview.token); expect(receipt).not.toContain('# Original'); expect(receipt).not.toContain('ONLY REFERENCED ORIGINAL BYTES')
  }, 40_000)

  it.each(['note', 'bytes', 'filename', 'deleted-note', 'missing-file'] as const)('requires a new preview when source %s changes, before target writes', async kind => {
    const f = await fixture(), preview = await f.sharing.preview(f.session.id, f.input)
    if (kind === 'note') f.source.notes.get('note_source')!.markdown += '\nNew private edit'
    else if (kind === 'bytes') f.source.files.get('att_source')!.bytes = Buffer.from('new bytes')
    else if (kind === 'filename') f.source.files.get('att_source')!.filename = 'changed.txt'
    else if (kind === 'deleted-note') f.source.notes.delete('note_source')
    else f.source.files.delete('att_source')
    await expect(f.sharing.commit(f.session.id, preview.token)).rejects.toMatchObject({ status: 409 })
    expect(f.target.calls).toEqual([])
    await expect(f.sharing.commit(f.session.id, preview.token)).rejects.toMatchObject({ status: 409 })
  }, 40_000)

  it('rejects other users, non-private sources, non-team targets, expired previews and changed roles', async () => {
    const f = await fixture(), preview = await f.sharing.preview(f.session.id, f.input)
    const invite = f.identity.invite(f.session.id, f.team.id, 'admin')
    await f.identity.register(invite.token, 'member', PASSWORD)
    const other = (await f.identity.login('member', PASSWORD)).session
    await expect(f.sharing.commit(other.id, preview.token)).rejects.toMatchObject({ status: 404 })
    await expect(f.sharing.preview(other.id, f.input)).rejects.toMatchObject({ status: 404 })
    await expect(f.sharing.preview(f.session.id, { ...f.input, sourceSpaceId: f.team.id })).rejects.toMatchObject({ status: 403 })
    await expect(f.sharing.preview(f.session.id, { ...f.input, targetSpaceId: f.privateSpace.id })).rejects.toMatchObject({ status: 403 })
    f.clock.now += 10 * 60_000
    await expect(f.sharing.commit(f.session.id, preview.token)).rejects.toMatchObject({ status: 409 })
    const newer = await f.sharing.preview(f.session.id, f.input)
    f.identity.transfer(f.session.id, f.team.id, other.id)
    await expect(f.sharing.commit(f.session.id, newer.token)).rejects.toMatchObject({ status: 409 })
    f.identity.setRole(other.id, f.team.id, f.session.id, null)
    await expect(f.sharing.commit(f.session.id, newer.token)).rejects.toMatchObject({ status: 404 })
    expect(f.target.calls).toEqual([])
  }, 40_000)

  it('records uncertain upload effects without duplicating them on retry or service restart', async () => {
    const f = await fixture(), preview = await f.sharing.preview(f.session.id, f.input)
    f.target.failAfterUpload = true
    const result = await f.sharing.commit(f.session.id, preview.token)
    expect(result.status).toBe('needs_review'); expect(f.target.files.size).toBe(1); expect(f.target.notes.size).toBe(0)
    expect(result.copiedAttachmentIds).toEqual([]) // acknowledgement was lost; never claim an unknown ID.
    expect(await f.sharing.commit(f.session.id, preview.token)).toEqual(result)
    expect(await new SharingService(f.deps).commit(f.session.id, preview.token)).toEqual(result)
    expect(f.target.files.size).toBe(1)
    const journal = JSON.parse(await readFile(join(f.root, 'shares', result.receiptId + '.json'), 'utf8'))
    expect(journal.operation).toEqual({ kind: 'upload', sourceId: 'att_source' })
  }, 40_000)

  it('records an uncertain created note with its unique path and never repeats create', async () => {
    const f = await fixture(), preview = await f.sharing.preview(f.session.id, f.input)
    f.target.failCreateAfterWrite = true
    const result = await f.sharing.commit(f.session.id, preview.token)
    expect(result.status).toBe('needs_review'); expect(result.copiedAttachmentIds).toHaveLength(1)
    expect(result.noteId).toBeUndefined(); expect([...f.target.notes.values()][0]!.relativePath).toBe(result.relativePath)
    expect(await new SharingService(f.deps).commit(f.session.id, preview.token)).toEqual(result)
    expect(f.target.notes.size).toBe(1); expect(f.target.files.size).toBe(1)
  }, 40_000)

  it('stops after source changes during copy and exposes only confirmed partial IDs', async () => {
    const f = await fixture(), preview = await f.sharing.preview(f.session.id, f.input)
    f.target.afterUpload = () => { f.source.notes.get('note_source')!.markdown += '\nChanged during copy' }
    const result = await f.sharing.commit(f.session.id, preview.token)
    expect(result.status).toBe('needs_review'); expect(result.copiedAttachmentIds).toHaveLength(1)
    expect(f.target.notes.size).toBe(0)
    expect((await new SharingService(f.deps).commit(f.session.id, preview.token)).status).toBe('needs_review')
    expect(f.target.files.size).toBe(1)
  }, 40_000)

  it('rejects concurrent confirmation, observes post-await session revocation and keeps a durable receipt', async () => {
    const f = await fixture(), preview = await f.sharing.preview(f.session.id, f.input), entered = deferred(), release = deferred()
    let active = true
    f.target.afterUpload = async () => { entered.resolve(); await release.promise }
    const pending = f.sharing.commit(f.session.id, preview.token, () => { if (!active) throw new AccessError(401, 'expired session') })
    await entered.promise
    await expect(f.sharing.commit(f.session.id, preview.token)).rejects.toMatchObject({ status: 409 })
    const recovered = await new SharingService(f.deps).commit(f.session.id, preview.token)
    expect(recovered.status).toBe('needs_review')
    const journal = JSON.parse(await readFile(join(f.root, 'shares', recovered.receiptId + '.json'), 'utf8'))
    expect(journal.state).toBe('copying'); expect(journal.operation).toEqual({ kind: 'upload', sourceId: 'att_source' })
    expect(f.target.files.size).toBe(1)
    active = false; release.resolve()
    await expect(pending).rejects.toMatchObject({ status: 401 })
    const result = await new SharingService(f.deps).commit(f.session.id, preview.token)
    expect(result.status).toBe('needs_review'); expect(result.copiedAttachmentIds).toHaveLength(1)
    expect(f.target.files.size).toBe(1); expect(f.target.notes.size).toBe(0)
  }, 40_000)

  it('preserves CRLF content and declines unsupported attachment forms instead of losing files', async () => {
    const f = await fixture()
    f.source.notes.get('note_source')!.markdown = f.source.notes.get('note_source')!.markdown.replaceAll('\n', '\r\n')
    const preview = await f.sharing.preview(f.session.id, f.input), copied = await f.sharing.commit(f.session.id, preview.token)
    expect(copied.status).toBe('complete')
    expect(f.target.notes.get(copied.noteId!)!.markdown).toContain('# Private source\r\n')
    f.source.notes.get('note_source')!.markdown += '\n<img src="../attachments/att_source/report.txt">'
    await expect(f.sharing.preview(f.session.id, f.input)).rejects.toMatchObject({ status: 400 })
    expect(f.target.files.size).toBe(1)
  }, 40_000)

  it('preserves optional link titles and repeated references while copying each attachment once', async () => {
    const f = await fixture()
    f.source.notes.get('note_source')!.markdown += '\n![second](../../attachments/att_source/report.txt#section "Quoted caption")\n'
    const preview = await f.sharing.preview(f.session.id, f.input)
    expect(preview.attachments).toHaveLength(1)
    const result = await f.sharing.commit(f.session.id, preview.token)
    expect(result.status).toBe('complete'); expect(f.target.files.size).toBe(1)
    expect(f.target.notes.get(result.noteId!)!.markdown).toContain('/report.txt#section "Quoted caption")')
  }, 40_000)
})

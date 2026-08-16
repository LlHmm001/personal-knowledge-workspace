import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { AttachmentId, EventId, NoteId } from '@deepseek-ai/dsh-pkw-domain'
import PkwEventStoreService from '../../events/src/index.ts'
import PkwWorkspaceService from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function boot() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', {
    list: async () => [],
    load: () => { throw new Error('event bodies must not be loaded') },
    inspect: () => { throw new Error('event bodies must not be inspected') },
  } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(PkwEventStoreService)
  await ctx.plugin(PkwWorkspaceService)
  return { ctx, workspace: ctx.pkwWorkspace }
}

async function newWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-'))
  dirs.push(dir)
  const { ctx, workspace } = await boot()
  const created = await ctx.workspaceRegistry.create(dir)
  const handle = workspace.forWorkspace(created.id)
  if (handle === undefined) throw new Error('workspace handle missing')
  return { ctx, workspace, handle, dir }
}

describe('pkw workspace core', () => {
  it('registers and opens a workspace', async () => {
    const { workspace, handle, dir } = await newWorkspace()
    expect(handle.root).toBe(await realpath(dir))
    expect(workspace.forWorkspace(handle.id)).toBe(handle)
    expect((await workspace.resolveForPath(dir))?.id).toBe(handle.id)
  })

  it('rejects path traversal (../ and absolute)', async () => {
    const { handle } = await newWorkspace()
    await expect(handle.resolve('../outside')).rejects.toThrow(/escapes workspace/)
    await expect(handle.resolve('/etc')).rejects.toThrow(/escapes workspace/)
  })

  it('keys attachment paths by AttachmentId, never by NoteId', async () => {
    const { handle } = await newWorkspace()
    const aid = AttachmentId('att-1')
    expect(handle.attachmentPath(aid, 'img.png')).toBe(join(handle.root, 'attachments', 'att-1', 'img.png'))
    expect(handle.attachmentPath(aid)).toBe(join(handle.root, 'attachments', 'att-1'))
    expect(handle.notePath('工作/Agent/a.md')).toBe(join(handle.root, 'notes', '工作/Agent/a.md'))
  })

  it('brands are compile-time only, so stable ids never re-encode', async () => {
    // Factories are identity casts: id stability means the string is preserved.
    expect(NoteId('n-1')).toBe('n-1')
    expect(AttachmentId('a-1')).toBe('a-1')
    expect(EventId('e-1')).toBe('e-1')
  })

  it('reads and writes files through ctx.fs (no node:fs in the service)', async () => {
    const { ctx, handle } = await newWorkspace()
    await mkdir(join(handle.root, 'notes'), { recursive: true })
    const target = await handle.resolve('notes/hello.md')
    await ctx.fs.writeText(target, '# hello')
    expect(await ctx.fs.readText(target)).toBe('# hello')
    // External edit round-trip through the filesystem is observable via ctx.fs.
    await writeFile(join(handle.root, 'notes', 'hello.md'), '# edited')
    expect(await ctx.fs.readText(await handle.resolve('notes/hello.md'))).toBe('# edited')
  })

  it('mints a normalized OperationContext (operationId/correlationId always present)', async () => {
    const { handle } = await newWorkspace()
    const opCtx = handle.newOperationContext({ type: 'agent', id: 'a1' })
    expect(opCtx.workspaceId).toBe(handle.id)
    expect(opCtx.actor).toEqual({ type: 'agent', id: 'a1' })
    expect(opCtx.operationId.length).toBeGreaterThan(0)
    expect(opCtx.correlationId.length).toBeGreaterThan(0)
    expect(opCtx.causationId).toBeUndefined()

    const withCorrelation = handle.newOperationContext({ type: 'user' }, { correlationId: 'given-corr' } as never)
    expect(withCorrelation.correlationId).toBe('given-corr')
  })
})

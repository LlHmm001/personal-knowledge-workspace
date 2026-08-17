/**
 * pkw_notes v1 → v2 migration tests: a v1 JSON fixture opens under the v2 spec,
 * preserving note_index + note_paths and adding an empty note_order; restart is
 * idempotent; a failing migration leaves the old file intact.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { noteDomainSpec, operationCommitRecord } from '@deepseek-ai/dsh-pkw-domain'
import type { OperationCommitRecord } from '@deepseek-ai/dsh-pkw-domain'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

function v1Fixture(): Record<string, unknown> {
  const ws = 'ws-migration'
  const note = (id: string, rel: string, title: string, deleted = false) => ({
    noteId: id,
    workspaceId: ws,
    relativePath: rel,
    title,
    tags: [],
    contentHash: 'h-' + id,
    observedRevision: 1,
    fileSize: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(deleted ? { deletedAt: '2026-01-02T00:00:00.000Z' } : {}),
  })
  return {
    unit: { name: 'pkw_notes', version: 1 },
    global: null,
    tables: {
      note_index: {
        note_root: note('note_root', 'root.md', 'Root'),
        note_nested: note('note_nested', '工作/项目A.md', 'Nested'),
        note_deleted: note('note_deleted', 'gone.md', 'Deleted', true),
      },
      note_paths: {
        'root.md': 'note_root',
        '工作/项目A.md': 'note_nested',
        'gone.md': 'note_deleted',
      },
    },
  }
}

async function bootJson(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return { ctx, facility }
}

describe('pkw_notes v1 → v3 migration', () => {
  it('preserves note_index/note_paths and adds empty note_order + folder_trash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pkw-mig-'))
    dirs.push(root)
    await writeFile(join(root, 'pkw_notes.json'), JSON.stringify(v1Fixture()))

    const { facility } = await bootJson(root)
    const domain = await facility.open(noteDomainSpec)

    const notes = domain.table('note_index')
    expect(notes.get('note_root' as never)?.relativePath).toBe('root.md')
    expect(notes.get('note_nested' as never)?.relativePath).toBe('工作/项目A.md')
    expect(notes.get('note_deleted' as never)?.deletedAt).toBeDefined()

    const paths = domain.table('note_paths')
    expect(paths.get('工作/项目A.md')).toBe('note_nested')

    const order = domain.table('note_order')
    expect([...order.entries()]).toHaveLength(0)

    const trash = domain.table('folder_trash')
    expect([...trash.entries()]).toHaveLength(0)

    // The file header is bumped to version 3 (migration materialized).
    const onDisk = JSON.parse(await readFile(join(root, 'pkw_notes.json'), 'utf8')) as { unit: { version: number } }
    expect(onDisk.unit.version).toBe(3)

    await domain.close()
  })

  it('is idempotent on restart (no version mismatch, data intact)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pkw-mig-'))
    dirs.push(root)
    await writeFile(join(root, 'pkw_notes.json'), JSON.stringify(v1Fixture()))

    const first = await bootJson(root)
    const d1 = await first.facility.open(noteDomainSpec)
    await d1.close()

    const second = await bootJson(root)
    const d2 = await second.facility.open(noteDomainSpec)
    expect(d2.table('note_index').get('note_root' as never)?.title).toBe('Root')
    expect([...d2.table('note_order').entries()]).toHaveLength(0)
    await d2.close()
  })

  it('a failing migration leaves the old file intact for a clean retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pkw-mig-'))
    dirs.push(root)
    const failingSpec = defineDomain({
      name: 'pkw_failing',
      version: 2,
      migrations: {
        1: { upgrade: () => { throw new Error('boom') } },
      },
      tables: { t: domainTable<string, OperationCommitRecord>(operationCommitRecord) },
    })
    await writeFile(join(root, 'pkw_failing.json'), JSON.stringify({
      unit: { name: 'pkw_failing', version: 1 },
      global: null,
      tables: { t: { a: { x: 'keep' } } },
    }))

    const { facility } = await bootJson(root)
    await expect(facility.open(failingSpec)).rejects.toThrow('boom')

    // The file is still v1 with the original record.
    const onDisk = JSON.parse(await readFile(join(root, 'pkw_failing.json'), 'utf8')) as { unit: { version: number }; tables: { t: Record<string, unknown> } }
    expect(onDisk.unit.version).toBe(1)
    expect(onDisk.tables.t.a).toEqual({ x: 'keep' })
  })
})

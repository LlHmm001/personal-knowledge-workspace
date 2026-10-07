/**
 * Current Harness storage contract, not an automatic migration promise.
 * Whole-unit v1/v2 media must reject without rewriting user state. The former
 * tests assumed an unsupported migrations hook; a real upgrade remains an
 * explicit, backed-up offline operation (see docs/DELIVERY_STATUS.md).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { noteDomainSpec } from '@deepseek-ai/dsh-pkw-domain'

const dirs: string[] = []
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
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
  cleanup.push(async () => { await backend.close(); await ctx.fiber.dispose() })
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  return facility
}

async function fixtureFile(version: number) {
  const root = await mkdtemp(join(tmpdir(), 'pkw-mig-'))
  dirs.push(root)
  const fixture = { ...v1Fixture(), unit: { name: 'pkw_notes', version } }
  const path = join(root, 'pkw_notes.json')
  const bytes = JSON.stringify(fixture)
  await writeFile(path, bytes)
  return { root, path, bytes }
}

describe('pkw_notes storage version and data preservation contract', () => {
  it.each([1, 2])('rejects JSON v%s without rewriting it, including after retry', async version => {
    const { root, path, bytes } = await fixtureFile(version)
    const facility = await bootJson(root)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(facility.open(noteDomainSpec)).rejects.toMatchObject({ code: 'version-mismatch' })
      expect(await readFile(path, 'utf8')).toBe(bytes)
    }
  })

  it('opens v3, preserves identities/paths/trash and empty added tables across restart', async () => {
    const { root } = await fixtureFile(3)
    for (let attempt = 0; attempt < 2; attempt++) {
      const facility = await bootJson(root)
      const domain = await facility.open(noteDomainSpec)
      expect(domain.table('note_index').get('note_root' as never)?.relativePath).toBe('root.md')
      expect(domain.table('note_index').get('note_nested' as never)?.title).toBe('Nested')
      expect(domain.table('note_index').get('note_deleted' as never)?.deletedAt).toBeDefined()
      expect(domain.table('note_paths').get('工作/项目A.md')).toBe('note_nested')
      expect([...domain.table('note_index').entries()]).toHaveLength(3)
      expect([...domain.table('note_order').entries()]).toHaveLength(0)
      expect([...domain.table('folder_trash').entries()]).toHaveLength(0)
      await domain.close()
    }
  })

  it('schema validation failure leaves the v3 JSON medium byte-for-byte intact', async () => {
    const { root, path } = await fixtureFile(3)
    const broken = JSON.stringify({ unit: { name: 'pkw_notes', version: 3 }, global: null, tables: { note_index: { note_broken: { noteId: 'note_broken', title: 'keep me' } } } })
    await writeFile(path, broken)
    const facility = await bootJson(root)
    await expect(facility.open(noteDomainSpec)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(path, 'utf8')).toBe(broken)
  })

  it('SQLite rejects an older domain and its original version remains readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pkw-mig-sqlite-'))
    dirs.push(root)
    const backend = new SqliteStorageBackend({ path: join(root, 'pkw.sqlite'), journalMode: 'wal' })
    cleanup.push(() => backend.close())
    const oldDescriptor = { ...descriptorOf(noteDomainSpec), version: 1, tables: ['note_index', 'note_paths'] }
    const old = await backend.kv.open(oldDescriptor)
    const fixture = v1Fixture() as { tables: Record<string, Record<string, unknown>> }
    for (const [table, rows] of Object.entries(fixture.tables)) {
      for (const [key, value] of Object.entries(rows)) await old.putRecord(table, key, value)
    }
    await old.close()
    await expect(backend.kv.open(descriptorOf(noteDomainSpec))).rejects.toMatchObject({ code: 'version-mismatch' })
    const reopened = await backend.kv.open(oldDescriptor)
    expect((await reopened.loadAll()).tables).toEqual(fixture.tables)
    await reopened.close()
  })
})

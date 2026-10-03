import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Storage from '@deepseek-ai/dsh-storage'
import { descriptorOf, DomainFacility, type Config as DomainConfig } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { attachmentDomainSpec, noteDomainSpec, pkwDomainSpec, taskDomainSpec } from '@deepseek-ai/dsh-pkw-domain'
import { weknoraSyncDomainSpec } from '../../weknora-sync/src/index.ts'

const harnessRoot = process.env.DSH_HARNESS_ROOT ?? '/opt/deepseek-harness'
if (!isAbsolute(harnessRoot)) throw new Error('DSH_HARNESS_ROOT must be absolute')
const pkwPatch = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const pkwDomains = [pkwDomainSpec, noteDomainSpec, attachmentDomainSpec, taskDomainSpec, weknoraSyncDomainSpec]

function composition() {
  // Use the host's actual YAML parser and include patch algorithm. Constructing
  // an equivalent object by hand would miss duplicate rows in installed bundles.
  const warnings: string[] = []
  const rows = composeEntries([
    loadOverlayPatches('pkw-test', join(harnessRoot, 'packages/bundle/base/cordis.patch.yml')),
    loadOverlayPatches('pkw-test', join(harnessRoot, 'packages/bundle/web-app/cordis.patch.yml')),
    loadOverlayPatches('pkw-test', pkwPatch),
  ], warning => warnings.push(warning))
  return { rows, warnings }
}

describe('PKW bundle on the DSH Web host', () => {
  it('composes one shared storage/domain/workspace service and preserves backend locations', () => {
    const { rows, warnings } = composition()
    expect(warnings).toEqual([])
    for (const id of ['storage', 'storage-domain', 'workspace', 'storage-json', 'storage-sqlite', 'pkw-events', 'pkw-workspace']) {
      expect(rows.filter(row => row.id === id), id).toHaveLength(1)
    }
    const ids = rows.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(rows.find(row => row.id === 'storage-json')?.config).toEqual({ root: { __jsExpr: "dshHomePath('storages')" } })
    expect(rows.find(row => row.id === 'storage-sqlite')?.config).toEqual({ path: { __jsExpr: "dshHomePath('pkw', 'pkw.sqlite')" } })
    expect(rows.find(row => row.id === 'workspace')).toMatchObject({ name: '@deepseek-ai/dsh-workspace' })
  })

  it('keeps the existing DSH workspace/cache in JSON while opening all five PKW domains in SQLite', async () => {
    const { rows } = composition()
    const config = rows.find(row => row.id === 'storage-domain')!.config as DomainConfig
    const names = pkwDomains.map(spec => spec.name).sort()
    expect(config.backend).toBe('json')
    expect(config.routes).toEqual(Object.fromEntries(names.map(name => [name, 'sqlite'])))
    expect(config.routes).not.toHaveProperty('workspace')

    const dir = await mkdtemp(join(tmpdir(), 'pkw-host-routing-'))
    const ctx = new Context()
    const json = new JsonStorageBackend(join(dir, 'storages'))
    const sqlitePath = join(dir, 'pkw.sqlite')
    const sqlite = new SqliteStorageBackend({ path: sqlitePath, journalMode: 'wal' })
    let facility: DomainFacility | undefined
    try {
      // A pre-existing host registry identity must remain reachable. This test
      // does not bootstrap a new registry or migrate any workspace into SQLite.
      const oldWorkspace = { path: dir, title: 'existing DSH workspace', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
      const existing = await json.kv.open(descriptorOf(workspaceDomainSpec))
      await existing.putRecord('workspaces', 'ws-preserved', oldWorkspace)
      await existing.setGlobal({ initialized: true, workspaceIds: ['ws-preserved'], archivedSessionIds: [] })
      await existing.close()

      await ctx.plugin(Storage)
      ctx.storage.backend.register('json', json)
      ctx.storage.backend.register('sqlite', sqlite)
      facility = new DomainFacility(ctx, config)
      ctx.storage.mount('domain', facility)
      const jsonOpen = vi.spyOn(json.kv, 'open')
      const sqliteOpen = vi.spyOn(sqlite.kv, 'open')
      const registry = await facility.open(workspaceDomainSpec)
      expect([...registry.table('workspaces').entries()]).toEqual([['ws-preserved', oldWorkspace]])
      expect(registry.global.get().workspaceIds).toEqual(['ws-preserved'])
      await facility.open(projectionCacheDomainSpec)
      for (const spec of pkwDomains) await facility.open(spec)

      expect(jsonOpen.mock.calls.map(([spec]) => spec.name).sort()).toEqual(['session_projcache', 'workspace'])
      expect(sqliteOpen.mock.calls.map(([spec]) => spec.name).sort()).toEqual(names)
      const db = new DatabaseSync(sqlitePath, { readOnly: true })
      try {
        expect(db.prepare('SELECT name FROM units ORDER BY name').all().map(row => row.name)).toEqual(names)
      } finally { db.close() }
    } finally {
      await facility?.closeAll()
      await Promise.all([json.close(), sqlite.close()])
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

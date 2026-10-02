import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { mkdir, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import PkwWebService from '../index.ts'
import type { Space } from './identity.ts'

export interface RetrievalConfig { baseUrl: string; kbId: string; apiKeyEnv: string }
export interface SpaceRuntime { web: PkwWebService; routes: WebRoute[]; close(): Promise<void> }

/** This context never opens a socket; only the authenticated gateway can dispatch its routes. */
export async function createSpaceRuntime(root: string, space: Space, retrieval?: RetrievalConfig): Promise<SpaceRuntime> {
  try {
    await lstat(join(root, 'recovery-pending.json'))
    throw new Error('Restored root is awaiting membership review; content runtimes cannot start')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!/^sp_[a-f0-9]{32}$/.test(space.id)) throw new Error('Invalid space identity')
  const directory = join(root, 'spaces', space.id)
  // Existing symlinks must not make two authorized runtimes share a canonical root.
  for (const path of [root, join(root, 'spaces'), directory, join(directory, 'workspace')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('Collaboration data directories must be canonical directories, not symlinks')
  }
  const workspace = join(directory, 'workspace')
  const database = join(directory, 'state.sqlite')
  try {
    if (!(await lstat(database)).isFile()) throw new Error('Invalid space database')
    const probe = new DatabaseSync(database, { readOnly: true })
    try {
      if (Number(probe.prepare('PRAGMA user_version').get()!.user_version) !== 1) throw new Error('Unsupported space database; use the verified migration tool')
      const versions: Record<string, number> = { workspace: 2, pkw: 1, pkw_notes: 3, pkw_attachments: 1, pkw_tasks: 1, pkw_weknora_sync: 3 }
      for (const row of probe.prepare('SELECT name,version FROM units').all()) {
        if (versions[String(row.name)] !== Number(row.version)) throw new Error('Unsupported space domain; preserve the database and use an explicit migration')
      }
    } finally { probe.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(join(workspace, 'notes'), { recursive: true, mode: 0o700 })
  await mkdir(join(workspace, 'attachments'), { recursive: true, mode: 0o700 })
  const ctx = new Context(), routes: WebRoute[] = []
  const backend = new SqliteStorageBackend({ path: database, journalMode: 'wal' })
  try {
    await ctx.plugin(Storage)
    ctx.storage.backend.register('sqlite', backend)
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('webServer', {
      register: (route: WebRoute) => { routes.push(route); return () => { const at = routes.indexOf(route); if (at !== -1) routes.splice(at, 1) } },
      registerUpgrade: () => { throw new Error('Space runtimes cannot expose WebSockets') },
      registerFallback: () => { throw new Error('Space runtimes cannot expose a fallback') },
      tapIndex: () => () => {},
    } as never)
    // The isolated PKW runtime owns no host conversation history.
    ctx.provide('sessionPersistence', { list: async () => [], load: async () => { throw new Error('PKW has no host session access') }, inspect: async () => { throw new Error('PKW has no host session access') } } as never)
    await ctx.plugin(WorkspaceRegistry)
    const registered = ctx.workspaceRegistry.list()
    if (registered.length > 1 || (registered.length === 1 && registered[0]!.path !== workspace)) throw new Error('Workspace registry does not match the isolated directory; use verified relocation/import, never create a new identity over old data')
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(Timer)
    const apiKey = retrieval ? process.env[retrieval.apiKeyEnv] : ''
    // Missing remote credentials must not prevent access to canonical local data.
    // The existing web diagnostics expose missing configuration and search falls back locally.
    await ctx.plugin(PkwWebService, {
      basePath: '/pkw/spaces/' + space.id, workspacePath: workspace, workspaceTitle: space.name,
      kbId: retrieval?.kbId ?? '', weknoraBaseUrl: retrieval?.baseUrl ?? '', weknoraApiKey: apiKey ?? '', weknoraApiKeyRef: '',
      pollMs: 10_000, retryBaseMs: 1000, retryMaxMs: 60_000, recoveryGraceAttempts: 3,
    })
    return { web: ctx.pkwWeb, routes, async close() { try { await ctx.fiber.dispose() } finally { await backend.close() } } }
  } catch (error) {
    try { await ctx.fiber.dispose() } finally { await backend.close() }
    throw error
  }
}

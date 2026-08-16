/**
 * Opt-in real WeKnora integration suite.
 *
 * Skipped unless a credential + a dedicated test KB are injected through the
 * environment (the API key is NEVER pasted into chat or committed):
 *   - WKNORA_API_KEY     (X-API-Key secret; prefer a Harness credential in real use)
 *   - WKNORA_TEST_KB_ID  (a dedicated test KB/namespace — this suite never creates
 *                         or deletes a KB, and only ever deletes knowledge objects
 *                         it created itself)
 *   - WKNORA_BASE_URL    (optional; defaults to the local instance)
 *
 * Every test cleans up only the knowledge objects it created (tracked ids).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WeKnoraError } from '@deepseek-ai/dsh-pkw-weknora'
import WeKnoraClient from '../../weknora/src/index.ts'

const baseUrl = process.env.WKNORA_BASE_URL ?? 'http://127.0.0.1:18088/api/v1'
const apiKey = process.env.WKNORA_API_KEY ?? ''
const kbId = process.env.WKNORA_TEST_KB_ID ?? ''
const hasCredential = apiKey !== '' && kbId !== ''

const createdIds = new Set<string>()
let client: WeKnoraClient | undefined

async function getClient(): Promise<WeKnoraClient> {
  if (client === undefined) {
    const ctx = new Context()
    await ctx.plugin(WeKnoraClient, { baseUrl, apiKey, apiKeyRef: '' })
    client = ctx.pkwWeKnora
  }
  return client
}

afterAll(async () => {
  if (client === undefined) return
  for (const id of [...createdIds]) {
    try { await client.deleteKnowledge(id) } catch { /* best effort: only our own test data */ }
  }
})

describe.skipIf(!hasCredential)('real WeKnora integration (opt-in)', () => {
  it('Manual create → list visibility → download round-trip', async () => {
    const c = await getClient()
    const content = '---\nid: pkw_it_manual\n---\n\n# integration\n\n中文 + emoji 🎉\n'
    const created = await c.createManualKnowledge(kbId, { title: 'pkw-it-manual', content })
    createdIds.add(created.id)
    expect(created.id).toBeDefined()

    const listed = await c.listKnowledge(kbId)
    expect(listed.some(item => item.id === created.id)).toBe(true)

    const downloaded = await c.readManualContent(created.id)
    expect(downloaded).toBe(content)
  })

  it('Manual update round-trips the new content', async () => {
    const c = await getClient()
    const created = await c.createManualKnowledge(kbId, { title: 'pkw-it-update', content: '---\nid: pkw_it_upd\n---\n\n# v1\n' })
    createdIds.add(created.id)
    const updated = await c.updateManualKnowledge(created.id, { title: 'pkw-it-update', content: '---\nid: pkw_it_upd\n---\n\n# v2\n' })
    expect(updated.id).toBe(created.id)
    expect(await c.readManualContent(created.id)).toBe('---\nid: pkw_it_upd\n---\n\n# v2\n')
  })

  it('File upload → duplicate_file 409 carries the existing KnowledgeId', async () => {
    const c = await getClient()
    const bytes = Buffer.from(`pkw integration file ${Date.now()}`)
    const uploaded = await c.uploadFile(kbId, { content: bytes, filename: 'pkw-it.txt', channel: 'pkw', mimeType: 'text/plain' })
    createdIds.add(uploaded.id)
    expect(uploaded.id).toBeDefined()
    expect(uploaded.file_hash).toBeDefined()

    let duplicateId: string | undefined
    try {
      await c.uploadFile(kbId, { content: bytes, filename: 'pkw-it.txt', channel: 'pkw', mimeType: 'text/plain' })
    } catch (error) {
      if (error instanceof WeKnoraError && error.kind === 'conflict') {
        duplicateId = error.duplicate?.id
      } else {
        throw error
      }
    }
    expect(duplicateId).toBe(uploaded.id)
  })

  it('parse status is a raw WeKnora status (not collapsed to "ready")', async () => {
    const c = await getClient()
    const created = await c.createManualKnowledge(kbId, { title: 'pkw-it-parse', content: '---\nid: pkw_it_parse\n---\n\n# parse\n' })
    createdIds.add(created.id)
    const knowledge = await c.getKnowledge(created.id)
    const raw = new Set(['pending', 'processing', 'finalizing', 'completed', 'failed', 'cancelled'])
    expect(raw.has(knowledge.parse_status ?? '')).toBe(true)
  })

  it('hybrid search returns chunks for the created knowledge', async () => {
    const c = await getClient()
    const created = await c.createManualKnowledge(kbId, { title: 'pkw-it-search', content: '---\nid: pkw_it_search\n---\n\n# searchable token\n' })
    createdIds.add(created.id)
    // Search visibility can lag parsing; poll briefly.
    let results: Array<{ knowledge_id: string }> = []
    for (let i = 0; i < 20; i += 1) {
      results = await c.hybridSearch(kbId, { query: 'searchable token', limit: 10 })
      if (results.some(r => r.knowledge_id === created.id)) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    expect(results.some(r => r.knowledge_id === created.id)).toBe(true)
  })
})

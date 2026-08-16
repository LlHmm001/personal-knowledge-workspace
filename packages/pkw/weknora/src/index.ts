/**
 * PKW WeKnora REST Adapter (`ctx.pkwWeKnora`).
 * Thin client over the real WeKnora 0.7.1 API, focused on what Sync/Retrieval need.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  baseUrl: string
  apiKey: string
}

export type WeKnoraErrorKind =
  | 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'validation'
  | 'rate_limit' | 'temporary' | 'server' | 'parse_failed' | 'cancelled'

export class WeKnoraError extends Error {
  constructor(
    message: string,
    readonly kind: WeKnoraErrorKind,
    readonly status: number,
    readonly body: unknown,
  ) { super(message); this.name = 'WeKnoraError' }
}

export interface ManualKnowledge {
  id: string
  title: string
  parse_status?: string
  channel?: string
}

export interface KnowledgeListItem {
  id: string
  title: string
  channel?: string
  source?: string
  parse_status?: string
}

export interface SearchChunk {
  id: string
  content: string
  knowledge_id: string
  chunk_index: number
  score: number
  knowledge_title?: string
  knowledge_source?: string
}

function classify(status: number, body: unknown): WeKnoraErrorKind {
  const code = typeof (body as { code?: string })?.code === 'string' ? (body as { code: string }).code : ''
  if (status === 401) return 'auth'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409 || code.startsWith('duplicate_')) return 'conflict'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (status === 400 || status === 422) return 'validation'
  return 'temporary'
}

export class WeKnoraClient extends Service {
  static Config: z<Config> = z.object({ baseUrl: z.string(), apiKey: z.string() })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwWeKnora')
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: { 'X-API-Key': this.config.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: unknown = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { message: text } }
    if (!res.ok) throw new WeKnoraError(`weknora ${method} ${path} → ${res.status}`, classify(res.status, json), res.status, json)
    return json as T
  }

  async createManualKnowledge(kbId: string, input: { title: string; content: string }): Promise<ManualKnowledge> {
    const r = await this.request<{ data: ManualKnowledge }>(
      'POST', `/knowledge-bases/${kbId}/knowledge/manual`,
      { title: input.title, content: input.content, channel: 'pkw' },
    )
    return r.data
  }

  async updateManualKnowledge(knowledgeId: string, input: { title: string; content: string }): Promise<ManualKnowledge> {
    const r = await this.request<{ data: ManualKnowledge }>(
      'PUT', `/knowledge/manual/${knowledgeId}`, { title: input.title, content: input.content, channel: 'pkw' },
    )
    return r.data
  }

  async readManualContent(knowledgeId: string): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/knowledge/${knowledgeId}/download`, { headers: { 'X-API-Key': this.config.apiKey } })
    if (!res.ok) throw new WeKnoraError(`download → ${res.status}`, 'not_found', res.status, {})
    return await res.text()
  }

  async listKnowledge(kbId: string): Promise<KnowledgeListItem[]> {
    const all: KnowledgeListItem[] = []
    const pageSize = 100
    let page = 1
    for (;;) {
      const r = await this.request<{ data: KnowledgeListItem[]; total?: number }>('GET', `/knowledge-bases/${kbId}/knowledge?page=${page}&page_size=${pageSize}`)
      const items = r.data ?? []
      if (items.length === 0) break
      all.push(...items)
      if (r.total !== undefined && all.length >= r.total) break
      page += 1
    }
    return all
  }

  async getKnowledge(knowledgeId: string): Promise<{ id: string; title: string; parse_status?: string }> {
    const r = await this.request<{ data: { id: string; title: string; parse_status?: string } }>('GET', `/knowledge/${knowledgeId}`)
    return r.data
  }

  async deleteKnowledge(knowledgeId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/knowledge/${knowledgeId}`)
  }

  async hybridSearch(kbId: string, query: string, limit = 10): Promise<SearchChunk[]> {
    const r = await this.request<{ data: SearchChunk[] }>('POST', `/knowledge-bases/${kbId}/hybrid-search`, { query, limit })
    return r.data ?? []
  }

  async listKnowledgeBases(): Promise<Array<{ id: string; name: string }>> {
    const r = await this.request<{ data: Array<{ id: string; name: string }> }>('GET', '/knowledge-bases')
    return r.data ?? []
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { pkwWeKnora: WeKnoraClient }
}

export default WeKnoraClient

/**
 * PKW WeKnora REST Adapter (`ctx.pkwWeKnora`).
 *
 * Thin client over the real WeKnora 0.7.1 API, focused on what Sync/Retrieval
 * need. Pure transport + typed errors: this layer never decides retry policy —
 * it reports WHAT happened (status/code/body) and, for uploads, the structured
 * `duplicate_file` payload with the existing KnowledgeId so callers can recover
 * without a blind re-upload.
 *
 * Credential contract: `apiKey` (string) is the pure DI/test mode; `apiKeyRef`
 * resolves through `ctx.credentials` per request so a changed credential reaches
 * the next operation without a restart. A missing credential raises a typed
 * `WeKnoraNotConfiguredError` — never a 401-retry loop. Secrets are never
 * embedded in error messages (see {@link redactSecrets}).
 *
 * @module @deepseek-ai/dsh-pkw-weknora
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { md5Bytes, remoteManualFingerprint } from './fingerprint.ts'

export { canonicalizeRemoteManualContent, md5Bytes, remoteManualFingerprint, sha256Bytes, sha256Text } from './fingerprint.ts'

export interface Config {
  baseUrl: string
  /** Pure DI/test mode: a literal key (empty string = unset). */
  apiKey: string
  /** Production mode: a credential reference resolved via `ctx.credentials` (empty string = unset). */
  apiKeyRef: string
}

export type WeKnoraErrorKind =
  | 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'validation'
  | 'rate_limit' | 'temporary' | 'server' | 'parse_failed' | 'cancelled'

/** Structured HTTP error. A structured response is always a KNOWN remote outcome. */
export class WeKnoraError extends Error {
  /** The normalized error body `code`, if any (e.g. `duplicate_file`). */
  readonly code: string
  /**
   * For a `duplicate_file` upload conflict: the existing Knowledge object the
   * server refused to duplicate. Its `.id` is the recovery primitive.
   */
  readonly duplicate?: FileKnowledge

  constructor(
    message: string,
    readonly kind: WeKnoraErrorKind,
    readonly status: number,
    readonly body: unknown,
    opts: { duplicate?: FileKnowledge } = {},
  ) {
    super(message)
    this.name = 'WeKnoraError'
    this.code = typeof (body as { code?: string } | null)?.code === 'string'
      ? (body as { code: string }).code
      : ''
    if (opts.duplicate !== undefined) this.duplicate = opts.duplicate
  }
}

/** Raised when the integration cannot reach WeKnora at all (no base URL / no credential). */
export class WeKnoraNotConfiguredError extends Error {
  constructor(readonly reason: 'missing_base_url' | 'missing_credential') {
    super(`weknora not configured: ${reason}`)
    this.name = 'WeKnoraNotConfiguredError'
  }
}

/** Full Knowledge entity (subset of fields Sync/Retrieval consume). */
export interface Knowledge {
  id: string
  title: string
  type?: string
  channel?: string
  source?: string
  parse_status?: string
  file_name?: string
  file_type?: string
  file_hash?: string
  file_size?: number
  error_message?: string
  knowledge_base_id?: string
}

/** Knowledge returned by file ingestion (`POST /knowledge-bases/:id/knowledge/file`). */
export interface FileKnowledge extends Knowledge {
  file_hash: string
  file_name: string
}

export interface ManualKnowledge extends Knowledge {}

export interface KnowledgeListItem {
  id: string
  title: string
  channel?: string
  source?: string
  parse_status?: string
}

/** A hybrid-search hit, mirroring WeKnora `SearchResult`. */
export interface SearchResultChunk {
  id: string
  content: string
  knowledge_id: string
  chunk_index: number
  score: number
  knowledge_title?: string
  knowledge_filename?: string
  knowledge_source?: string
  knowledge_channel?: string
  knowledge_base_id?: string
  match_type?: string
}

export interface SearchParams {
  query: string
  limit?: number
  knowledgeIds?: string[]
}

/** Secret-bearing substrings that must never survive into diagnostics. */
const SECRET_KEYS = ['x-api-key', 'authorization', 'api_key', 'apikey', 'token']

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

/** Replace any embedded secret material with a fixed marker. */
export function redactSecrets(input: string): string {
  let out = input
  for (const key of SECRET_KEYS) {
    // `key=value`, `key: value`, and `key: Bearer token` (scheme + secret) up to
    // the next whitespace/quote/bracket.
    const re = new RegExp(`(${key})(\\s*[:=]\\s*)([^\\s"',;}\\]&]+(?:\\s+[^\\s"',;}\\]&]+)?)`, 'gi')
    out = out.replace(re, (_m, name: string, sep: string) => `${name}${sep}[REDACTED]`)
  }
  return out
}

export class WeKnoraClient extends Service {
  static Config: z<Config> = z.object({
    baseUrl: z.string(),
    apiKey: z.string().default(''),
    apiKeyRef: z.string().default(''),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwWeKnora')
  }

  /** Whether a credential can currently be resolved (does not expose the value). */
  async credentialStatus(): Promise<'configured' | 'missing_base_url' | 'missing_credential'> {
    if (this.config.baseUrl.trim() === '') return 'missing_base_url'
    if (this.config.apiKey !== '') return 'configured'
    if (this.config.apiKeyRef !== '') {
      const provider = this.ctx.get('credentials')
      if (provider === undefined) return 'missing_credential'
      const resolved = await (provider as CredentialProvider).resolve(credentialRef(this.config.apiKeyRef))
      return resolved === undefined ? 'missing_credential' : 'configured'
    }
    return 'missing_credential'
  }

  private async resolveApiKey(): Promise<string> {
    if (this.config.apiKey !== '') return this.config.apiKey
    if (this.config.apiKeyRef !== '') {
      const provider = this.ctx.get('credentials') as CredentialProvider | undefined
      if (provider === undefined) throw new WeKnoraNotConfiguredError('missing_credential')
      const resolved = await provider.resolve(credentialRef(this.config.apiKeyRef))
      if (resolved === undefined) throw new WeKnoraNotConfiguredError('missing_credential')
      return resolved.value
    }
    throw new WeKnoraNotConfiguredError('missing_credential')
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const apiKey = await this.resolveApiKey()
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: unknown = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { message: text } }
    if (!res.ok) {
      throw new WeKnoraError(
        redactSecrets(`weknora ${method} ${path} → ${res.status}`),
        classify(res.status, json), res.status, json,
      )
    }
    return json as T
  }

  async createManualKnowledge(kbId: string, input: { title: string; content: string }): Promise<ManualKnowledge> {
    const r = await this.request<{ data: ManualKnowledge }>(
      'POST', `/knowledge-bases/${kbId}/knowledge/manual`,
      // `status: "publish"` is REQUIRED: without it WeKnora stores a draft
      // (parse_status "draft", not indexed/searchable).
      { title: input.title, content: input.content, channel: 'pkw', status: 'publish' },
    )
    return r.data
  }

  async updateManualKnowledge(knowledgeId: string, input: { title: string; content: string }): Promise<ManualKnowledge> {
    const r = await this.request<{ data: ManualKnowledge }>(
      'PUT', `/knowledge/manual/${knowledgeId}`,
      { title: input.title, content: input.content, channel: 'pkw', status: 'publish' },
    )
    return r.data
  }

  async readManualContent(knowledgeId: string): Promise<string> {
    const apiKey = await this.resolveApiKey()
    const res = await fetch(`${this.config.baseUrl}/knowledge/${knowledgeId}/download`, { headers: { 'X-API-Key': apiKey } })
    if (!res.ok) throw new WeKnoraError(`download → ${res.status}`, 'not_found', res.status, {})
    // Decode raw bytes WITHOUT BOM stripping so a leading UTF-8 BOM survives the
    // round-trip (matches WeKnora's verbatim byte streaming, unlike `res.text()`).
    const bytes = await res.arrayBuffer()
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
  }

  /** Multipart file upload. On a `duplicate_file` 409 the existing Knowledge is preserved on the error. */
  async uploadFile(
    kbId: string,
    input: { content: Uint8Array; filename: string; channel?: string; mimeType?: string; metadata?: Record<string, string> },
  ): Promise<FileKnowledge> {
    const apiKey = await this.resolveApiKey()
    const form = new FormData()
    form.set('file', new Blob([input.content as BlobPart], { type: input.mimeType ?? 'application/octet-stream' }), input.filename)
    if (input.channel !== undefined) form.set('channel', input.channel)
    if (input.metadata !== undefined) form.set('metadata', JSON.stringify(input.metadata))

    const res = await fetch(`${this.config.baseUrl}/knowledge-bases/${kbId}/knowledge/file`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: form,
    })
    const text = await res.text()
    let json: unknown = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { message: text } }
    if (!res.ok) {
      const duplicate = res.status === 409
        ? (json as { data?: FileKnowledge } | null)?.data
        : undefined
      throw new WeKnoraError(
        redactSecrets(`weknora upload → ${res.status}`),
        classify(res.status, json), res.status, json,
        { duplicate },
      )
    }
    return (json as { data: FileKnowledge }).data
  }

  async listKnowledge(kbId: string, opts: { source?: string } = {}): Promise<KnowledgeListItem[]> {
    const all: KnowledgeListItem[] = []
    const pageSize = 100
    let page = 1
    const sourceParam = opts.source !== undefined ? `&source=${encodeURIComponent(opts.source)}` : ''
    for (;;) {
      const r = await this.request<{ data: KnowledgeListItem[]; total?: number }>('GET', `/knowledge-bases/${kbId}/knowledge?page=${page}&page_size=${pageSize}${sourceParam}`)
      const items = r.data ?? []
      if (items.length === 0) break
      all.push(...items)
      if (r.total !== undefined && all.length >= r.total) break
      page += 1
    }
    return all
  }

  async getKnowledge(knowledgeId: string): Promise<Knowledge> {
    const r = await this.request<{ data: Knowledge }>('GET', `/knowledge/${knowledgeId}`)
    return r.data
  }

  async deleteKnowledge(knowledgeId: string): Promise<{ taskId?: string }> {
    // WeKnora DELETE is ASYNC: 200 only means the asynq task was enqueued; the
    // actual chunk/vector/keyword-index cleanup happens in a background worker.
    const r = await this.request<{ data?: { task_id?: string } }>('DELETE', `/knowledge/${knowledgeId}`)
    return { taskId: r.data?.task_id }
  }

  async reparseKnowledge(knowledgeId: string): Promise<Knowledge> {
    const r = await this.request<{ data: Knowledge }>('POST', `/knowledge/${knowledgeId}/reparse`, {})
    return r.data
  }

  async cancelParse(knowledgeId: string): Promise<Knowledge> {
    const r = await this.request<{ data: Knowledge }>('POST', `/knowledge/${knowledgeId}/cancel-parse`, {})
    return r.data
  }

  async hybridSearch(kbId: string, params: SearchParams): Promise<SearchResultChunk[]> {
    const r = await this.request<{ data: SearchResultChunk[] }>(
      'POST', `/knowledge-bases/${kbId}/hybrid-search`,
      {
        query_text: params.query,
        match_count: params.limit ?? 10,
        ...(params.knowledgeIds !== undefined ? { knowledge_ids: params.knowledgeIds } : {}),
      },
    )
    return r.data ?? []
  }

  async listKnowledgeBases(): Promise<Array<{ id: string; name: string }>> {
    const r = await this.request<{ data: Array<{ id: string; name: string }> }>('GET', '/knowledge-bases')
    return r.data ?? []
  }

  /** Fingerprint the exact Manual payload the adapter sends for the given content. */
  fingerprintManualContent(content: string): string {
    return remoteManualFingerprint(content)
  }

  /** MD5 of raw bytes, matching WeKnora's `file_hash` dedup key. */
  fingerprintFile(content: Uint8Array): string {
    return md5Bytes(content)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { pkwWeKnora: WeKnoraClient }
}

export default WeKnoraClient

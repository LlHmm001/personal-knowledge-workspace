/**
 * PKW Web MVP — Host Web Bridge + served browser UI.
 *
 * One dual-role Host plugin: it loads the PKW Core services (Notes, Attachments,
 * Workspace, Durable Events, WeKnora Sync/Retrieval) into the current Harness
 * process, then registers the `/pkw` HTTP surface on `ctx.webServer`:
 *   - GET  /pkw       → the browser UI (a self-contained page, no client bundle)
 *   - POST /pkw/api   → JSON RPC dispatcher over the PKW Core services
 *
 * The browser never touches SQLite, the Workspace filesystem, the WeKnora API
 * key, or WeKnora REST directly — every capability goes through these handlers.
 * Local Save is the synchronous UI contract; WeKnora Sync is asynchronous.
 *
 * @module @deepseek-ai/dsh-pkw-web
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { AttachmentId, NoteId } from '@deepseek-ai/dsh-pkw-domain'
import PkwEventStoreService from '@deepseek-ai/dsh-pkw-events'
import PkwWorkspaceService from '@deepseek-ai/dsh-pkw-workspace'
import NotesService from '@deepseek-ai/dsh-pkw-notes'
import AttachmentsService from '@deepseek-ai/dsh-pkw-attachments'
import WeKnoraClient from '@deepseek-ai/dsh-pkw-weknora'
import WeKnoraSyncService from '@deepseek-ai/dsh-pkw-weknora-sync'
import { renderPage } from './ui.ts'

export interface Config {
  /** Workspace root directory (notes/ + attachments/ live under it). */
  workspacePath: string
  /** Target WeKnora knowledge base id (the PKW mirror KB). */
  kbId: string
  /** WeKnora API base URL. */
  weknoraBaseUrl: string
  /** Credential ref for the WeKnora API key (production; '' = not configured). */
  weknoraApiKeyRef: string
  /** Literal API key for test / DI ('' = unset). */
  weknoraApiKey: string
  pollMs: number
  retryBaseMs: number
  retryMaxMs: number
  recoveryGraceAttempts: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { pkwWeb: PkwWebService }
}

type Json = Record<string, unknown>

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text) as Json
}

export class PkwWebService extends Service {
  static inject = ['storageDomain', 'fs', 'workspaceRegistry', 'webServer', 'timer']
  static Config: z<Config> = z.object({
    workspacePath: z.string(),
    kbId: z.string(),
    weknoraBaseUrl: z.string(),
    weknoraApiKeyRef: z.string().default(''),
    weknoraApiKey: z.string().default(''),
    pollMs: z.number().default(1000),
    retryBaseMs: z.number().default(1000),
    retryMaxMs: z.number().default(60000),
    recoveryGraceAttempts: z.number().default(3),
  })

  private workspaceId = ''

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'pkwWeb')
  }

  protected async [Service.init](): Promise<void> {
    const registry = this.ctx.workspaceRegistry
    const existing = await registry.resolveByPath(this.config.workspacePath)
    const ws = existing ?? await registry.create(this.config.workspacePath, 'PKW Personal Knowledge Workspace')
    this.workspaceId = String(ws.id)

    // PKW Core services, loaded into this plugin's fiber (browser never reaches them directly).
    await this.ctx.plugin(PkwEventStoreService)
    await this.ctx.plugin(PkwWorkspaceService)
    await this.ctx.plugin(NotesService, { workspaceId: this.workspaceId })
    await this.ctx.plugin(AttachmentsService, { workspaceId: this.workspaceId })
    await this.ctx.plugin(WeKnoraClient, {
      baseUrl: this.config.weknoraBaseUrl,
      apiKey: this.config.weknoraApiKey,
      apiKeyRef: this.config.weknoraApiKeyRef,
    })
    await this.ctx.plugin(WeKnoraSyncService, {
      kbId: this.config.kbId,
      workspaceId: this.workspaceId,
      pollMs: this.config.pollMs,
      retryBaseMs: this.config.retryBaseMs,
      retryMaxMs: this.config.retryMaxMs,
      recoveryGraceAttempts: this.config.recoveryGraceAttempts,
    })

    // Route surface. Disposers are owned by this fiber via ctx.effect.
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact', path: '/pkw', handler: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(renderPage())
      },
    }), 'pkw.web.page')

    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact', path: '/pkw/api', handler: (req, res) => {
        void this.handleApi(req, res)
      },
    }), 'pkw.web.api')
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody(req)
      const method = typeof body.method === 'string' ? body.method : ''
      const args = (body.args ?? {}) as Json
      const result = await this.call(method, args)
      json(res, 200, { ok: true, value: result })
    } catch (error) {
      json(res, 400, { ok: false, error: String(error instanceof Error ? error.message : error) })
    }
  }

  /** Stable UI-facing RPC entry (also the contract under test). */
  async call(method: string, args: Json): Promise<unknown> {
    switch (method) {
      case 'summary': return this.summary()
      case 'listNotes': return this.ctx.pkwNotes.list().map(n => ({
        noteId: String(n.noteId), relativePath: n.relativePath, title: n.title,
        tags: n.tags, updatedAt: n.updatedAt, observedRevision: n.observedRevision, deleted: n.deletedAt !== undefined,
      }))
      case 'getNote': {
        const noteId = NoteId(String(args.noteId))
        const doc = await this.ctx.pkwNotes.getDocument(noteId)
        const mapping = this.ctx.pkwWeKnoraSync.getMapping(noteId)
        return {
          note: { noteId: String(doc.note.noteId), relativePath: doc.note.relativePath, title: doc.note.title, tags: doc.note.tags, updatedAt: doc.note.updatedAt, observedRevision: doc.note.observedRevision },
          markdown: doc.markdown,
          attachments: doc.attachments.map(a => ({ attachmentId: String(a.attachmentId), relativePath: a.relativePath })),
          sync: mapping === undefined ? undefined : {
            knowledgeId: mapping.knowledgeId, kbId: this.config.kbId,
            syncState: mapping.syncState, remoteParseStatus: mapping.remoteParseStatus, updatedAt: mapping.updatedAt,
          },
        }
      }
      case 'createNote': {
        const rec = await this.ctx.pkwNotes.create({ relativePath: String(args.relativePath), markdown: String(args.markdown) })
        return { noteId: String(rec.noteId), relativePath: rec.relativePath }
      }
      case 'saveNote': {
        const rec = await this.ctx.pkwNotes.update(NoteId(String(args.noteId)), String(args.markdown))
        return { noteId: String(rec.noteId), updatedAt: rec.updatedAt, observedRevision: rec.observedRevision }
      }
      case 'moveNote': {
        const rec = await this.ctx.pkwNotes.move(NoteId(String(args.noteId)), String(args.relativePath))
        return { noteId: String(rec.noteId), relativePath: rec.relativePath }
      }
      case 'deleteNote': {
        await this.ctx.pkwNotes.delete(NoteId(String(args.noteId)))
        return { deleted: true }
      }
      case 'listAttachments': return this.ctx.pkwAttachments.list().map(a => ({
        attachmentId: String(a.id), filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
        observedRevision: a.observedRevision, createdAt: a.createdAt, deleted: a.deletedAt !== undefined,
      }))
      case 'uploadAttachment': {
        const content = Buffer.from(String(args.contentBase64), 'base64')
        const rec = await this.ctx.pkwAttachments.importFile({ content, filename: String(args.filename), mimeType: String(args.mimeType) })
        return { attachmentId: String(rec.id), filename: rec.filename, sizeBytes: rec.sizeBytes }
      }
      case 'deleteAttachment': {
        await this.ctx.pkwAttachments.remove(AttachmentId(String(args.attachmentId)))
        return { deleted: true }
      }
      case 'search': {
        return this.ctx.pkwWeKnoraSync.search(String(args.query), { limit: typeof args.limit === 'number' ? args.limit : 10 })
      }
      case 'syncNow': return this.ctx.pkwWeKnoraSync.drain().then(() => ({ drained: true }))
      case 'reconcile': return this.ctx.pkwWeKnoraSync.reconcile()
      case 'noteSyncInfo': {
        const mapping = this.ctx.pkwWeKnoraSync.getMapping(NoteId(String(args.noteId)))
        return mapping ?? null
      }
      default: throw new Error(`unknown pkw method: ${method}`)
    }
  }

  private async summary(): Promise<unknown> {
    const credential = await this.ctx.pkwWeKnora.credentialStatus()
    const integration = await this.ctx.pkwWeKnoraSync.integrationState()
    return {
      workspaceId: this.workspaceId,
      kbId: this.config.kbId,
      weknoraBaseUrl: this.config.weknoraBaseUrl,
      credential: credential,
      integration: integration,
      notes: this.ctx.pkwNotes.list().length,
      attachments: this.ctx.pkwAttachments.list().length,
      mappings: this.ctx.pkwWeKnoraSync.listMappings().length,
    }
  }
}

export default PkwWebService

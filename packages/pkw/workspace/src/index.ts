/**
 * PKW workspace core (`ctx.pkwWorkspace`).
 *
 * Reuses `ctx.workspaceRegistry` for identity, `ctx.fs` for file operations and
 * path containment, and hard-depends on `ctx.pkwEvents` (mutations must never
 * silently bypass the durable-history invariant). No `node:fs` usage.
 * @module @deepseek-ai/dsh-pkw-workspace
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import {
  CorrelationId,
  OperationId,
  type Actor,
  type AttachmentId,
  type OperationContext,
} from '@deepseek-ai/dsh-pkw-domain'

declare module '@deepseek-ai/cordis' {
  interface Context {
    pkwWorkspace: PkwWorkspace
  }
}

export interface WorkspaceHandle {
  readonly id: WorkspaceId
  readonly root: string
  resolve(rel: string): Promise<FsTarget>
  assertInside(target: FsTarget): Promise<void>
  notePath(rel: string): string
  attachmentPath(id: AttachmentId, rel?: string): string
  archivePath(rel?: string): string
  newOperationContext(actor: Actor, opts?: { correlationId?: ReturnType<typeof CorrelationId>; causationId?: string }): OperationContext
}

export interface PkwWorkspace {
  forWorkspace(id: WorkspaceId): WorkspaceHandle | undefined
  resolveForPath(path: string): Promise<WorkspaceHandle | undefined>
}

export class PkwWorkspaceService extends Service {
  static inject = ['workspaceRegistry', 'fs', 'pkwEvents']

  private readonly handles = new Map<WorkspaceId, WorkspaceHandle>()

  constructor(ctx: Context) {
    super(ctx, 'pkwWorkspace')
  }

  forWorkspace(id: WorkspaceId): WorkspaceHandle | undefined {
    const workspace = this.ctx.workspaceRegistry.get(id)
    if (workspace === undefined) return undefined
    let handle = this.handles.get(id)
    if (handle === undefined) {
      handle = new WorkspaceHandleImpl(this.ctx, workspace)
      this.handles.set(id, handle)
    }
    return handle
  }

  async resolveForPath(path: string): Promise<WorkspaceHandle | undefined> {
    const workspace = await this.ctx.workspaceRegistry.resolveByPath(path)
    if (workspace === undefined) return undefined
    return this.forWorkspace(workspace.id)
  }
}

class WorkspaceHandleImpl implements WorkspaceHandle {
  readonly id: WorkspaceId
  readonly root: string
  private rootTarget?: FsTarget

  constructor(private readonly ctx: Context, workspace: Workspace) {
    this.id = workspace.id
    this.root = workspace.path
  }

  private async ensureRoot(): Promise<FsTarget> {
    if (this.rootTarget === undefined) {
      this.rootTarget = await this.ctx.fs.resolve(this.root)
    }
    return this.rootTarget
  }

  async resolve(rel: string): Promise<FsTarget> {
    const root = await this.ensureRoot()
    // `resolve` (not `join`) keeps an absolute `rel` escaping the root instead
    // of silently relative-izing it; `contains` then rejects it.
    const target = await this.ctx.fs.resolve(posix.resolve(this.root, rel))
    this.assertContained(root, target)
    return target
  }

  async assertInside(target: FsTarget): Promise<void> {
    this.assertContained(await this.ensureRoot(), target)
  }

  private assertContained(root: FsTarget, target: FsTarget): void {
    if (!this.ctx.fs.contains(root, target)) {
      throw new Error(`pkw: path escapes workspace root '${this.root}'`)
    }
  }

  notePath(rel: string): string {
    return posix.join(this.root, 'notes', rel)
  }

  attachmentPath(id: AttachmentId, rel?: string): string {
    return rel === undefined
      ? posix.join(this.root, 'attachments', id)
      : posix.join(this.root, 'attachments', id, rel)
  }

  archivePath(rel?: string): string {
    return rel === undefined
      ? posix.join(this.root, 'archive')
      : posix.join(this.root, 'archive', rel)
  }

  newOperationContext(actor: Actor, opts?: { correlationId?: ReturnType<typeof CorrelationId>; causationId?: string }): OperationContext {
    const context: OperationContext = {
      workspaceId: this.id,
      actor,
      operationId: OperationId(randomUUID()),
      correlationId: opts?.correlationId ?? CorrelationId(randomUUID()),
    }
    if (opts?.causationId !== undefined) context.causationId = opts.causationId
    return context
  }
}

export default PkwWorkspaceService

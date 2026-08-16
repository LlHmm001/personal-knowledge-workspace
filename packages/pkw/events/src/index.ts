/**
 * PKW durable event store (`ctx.pkwEvents`).
 *
 * A commit is one atomic `commits.put(operationId, commit)` — the whole
 * `OperationCommit` (1..N events) is one record, so multi-event commits are
 * atomic under the storage layer's single-record durability and idempotent by
 * the persistent operationId key. The Cordis `pkw/event.committed` signal is
 * emitted only AFTER the durable write resolves; it is live signaling, never
 * the audit log.
 * @module @deepseek-ai/dsh-pkw-events
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import {
  EventId,
  pkwDomainSpec,
  type CommitRequest,
  type DomainEvent,
  type DomainEventView,
  type EventListFilter,
  type OperationCommit,
  type OperationCommitRecord,
  type OperationId,
  type PkwEventCommitted,
} from '@deepseek-ai/dsh-pkw-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

export class PkwEventStoreService extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<OperationId, OperationCommitRecord>
  /** Per-aggregate revision cursor (a counter, rebuilt from commits at startup). */
  private readonly cursors = new Map<string, number>()
  /** Serializes commits: the event store is the single writer of `commits`. */
  private operationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'pkwEvents')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(pkwDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'pkw.domainClose')
    this.table = domain.table('commits')
    this.rebuildCursors()
  }

  private rebuildCursors(): void {
    this.cursors.clear()
    for (const [, commit] of this.requireTable().entries()) {
      for (const event of commit.events) {
        const key = cursorKey(event.aggregateType, event.aggregateId)
        const current = this.cursors.get(key) ?? 0
        if (event.aggregateRevision > current) this.cursors.set(key, event.aggregateRevision)
      }
    }
  }

  commit(req: CommitRequest): Promise<OperationCommit> {
    return this.enqueue(async () => {
      if (req.events.length === 0) {
        throw new Error('pkw: a commit requires at least one event')
      }
      for (const input of req.events) {
        if (input.type.length === 0 || input.aggregateType.length === 0 || input.aggregateId.length === 0) {
          throw new Error('pkw: event type/aggregateType/aggregateId must be non-empty')
        }
      }

      const table = this.requireTable()
      // Durable idempotency: operationId is the persistent key — O(1) existence
      // check, no full-log dedupe rebuild.
      const existing = table.get(req.operationContext.operationId)
      if (existing !== undefined) return existing

      const committedAt = new Date().toISOString()
      // Compute revisions on a local copy so multiple events of one aggregate
      // within the SAME commit get consecutive revisions; commit it only after
      // the durable write succeeds.
      const nextCursors = new Map(this.cursors)
      const events: DomainEvent[] = req.events.map((input) => {
        const key = cursorKey(input.aggregateType, input.aggregateId)
        const revision = (nextCursors.get(key) ?? 0) + 1
        nextCursors.set(key, revision)
        return {
          eventId: EventId(randomUUID()),
          type: input.type,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          aggregateRevision: revision,
          createdAt: committedAt,
          payload: input.payload,
        }
      })

      const commit: OperationCommit = {
        operationId: req.operationContext.operationId,
        workspaceId: req.operationContext.workspaceId,
        actor: req.operationContext.actor,
        correlationId: req.operationContext.correlationId,
        ...(req.operationContext.causationId === undefined ? {} : { causationId: req.operationContext.causationId }),
        committedAt,
        events,
      }

      // THE atomic durable commit.
      await table.put(commit.operationId, commit)

      // Post-commit (non-authoritative): cursor update, then live signal.
      for (const [key, revision] of nextCursors) this.cursors.set(key, revision)
      const signal: PkwEventCommitted = {
        operationId: commit.operationId,
        correlationId: commit.correlationId,
        workspaceId: commit.workspaceId,
        events: events.map(event => ({
          eventId: event.eventId,
          type: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          aggregateRevision: event.aggregateRevision,
        })),
      }
      this.ctx.emit('pkw/event.committed', signal)

      return commit
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  get(operationId: OperationId): OperationCommit | undefined {
    return this.requireTable().get(operationId)
  }

  list(filter: EventListFilter = {}): DomainEventView[] {
    const views: DomainEventView[] = []
    for (const [, commit] of this.requireTable().entries()) {
      if (filter.workspaceId !== undefined && commit.workspaceId !== filter.workspaceId) continue
      for (const event of commit.events) {
        if (filter.aggregateType !== undefined && event.aggregateType !== filter.aggregateType) continue
        if (filter.aggregateId !== undefined && event.aggregateId !== filter.aggregateId) continue
        views.push({
          ...event,
          operationId: commit.operationId,
          workspaceId: commit.workspaceId,
          actor: commit.actor,
          correlationId: commit.correlationId,
          ...(commit.causationId === undefined ? {} : { causationId: commit.causationId }),
        })
      }
    }
    return views
  }

  private requireTable(): KvTable<OperationId, OperationCommitRecord> {
    if (this.table === undefined) throw new Error('pkw event store is not started yet')
    return this.table
  }
}

function cursorKey(aggregateType: string, aggregateId: string): string {
  return `${aggregateType}\u0000${aggregateId}`
}

export default PkwEventStoreService

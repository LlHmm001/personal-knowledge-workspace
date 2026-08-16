import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  CorrelationId,
  OperationId,
  type OperationContext,
  type PkwEventCommitted,
} from '@deepseek-ai/dsh-pkw-domain'
import PkwEventStoreService from '../src/index.ts'

/** Boot the real storage/storage-sqlite/storage-domain/events composition. */
async function boot() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(PkwEventStoreService)
  return { ctx, backend, fiber, store: ctx.pkwEvents }
}

function op(id: string, correlation = `corr-${id}`): OperationContext {
  return {
    workspaceId: WorkspaceId('ws-1'),
    actor: { type: 'agent', id: 'tester' },
    operationId: OperationId(id),
    correlationId: CorrelationId(correlation),
  }
}

describe('pkw durable event store', () => {
  it('appends and queries durable events', async () => {
    const { store } = await boot()
    const commit = await store.commit({
      operationContext: op('op-1'),
      events: [{ type: 'note.created', aggregateType: 'note', aggregateId: 'n1', payload: { title: 'hello' } }],
    })
    expect(commit.events).toHaveLength(1)
    expect(commit.events[0]!.aggregateRevision).toBe(1)
    expect(store.get(OperationId('op-1'))).toBeDefined()
    expect(store.list()).toHaveLength(1)
    expect(store.list({ aggregateType: 'note', aggregateId: 'n1' })).toHaveLength(1)
    expect(store.list({ aggregateType: 'task' })).toHaveLength(0)
  })

  it('commits 1..N events atomically under one operationId', async () => {
    const { store } = await boot()
    const commit = await store.commit({
      operationContext: op('op-multi'),
      events: [
        { type: 'note.moved', aggregateType: 'note', aggregateId: 'n1', payload: { from: 'a', to: 'b' } },
        { type: 'note.updated', aggregateType: 'note', aggregateId: 'n1', payload: { revision: 2 } },
      ],
    })
    expect(commit.events).toHaveLength(2)
    expect(commit.events[0]!.aggregateRevision).toBe(1)
    expect(commit.events[1]!.aggregateRevision).toBe(2)
    // Both events share the single commit key.
    expect(store.get(OperationId('op-multi'))?.events).toHaveLength(2)
  })

  it('propagates operation context into the record and the signal', async () => {
    const { ctx, store } = await boot()
    const signals: PkwEventCommitted[] = []
    ctx.on('pkw/event.committed', signal => { signals.push(signal) })

    const context: OperationContext = {
      workspaceId: WorkspaceId('ws-1'),
      actor: { type: 'user', id: 'u1' },
      operationId: OperationId('op-ctx'),
      correlationId: CorrelationId('corr-ctx'),
      causationId: 'cause-1',
    }
    await store.commit({
      operationContext: context,
      events: [{ type: 'fact.proposed', aggregateType: 'fact', aggregateId: 'f1', payload: {} }],
    })

    const got = store.get(OperationId('op-ctx'))!
    expect(got.workspaceId).toBe('ws-1')
    expect(got.actor).toEqual({ type: 'user', id: 'u1' })
    expect(got.correlationId).toBe('corr-ctx')
    expect(got.causationId).toBe('cause-1')

    expect(signals).toHaveLength(1)
    expect(signals[0]!.operationId).toBe('op-ctx')
    expect(signals[0]!.correlationId).toBe('corr-ctx')
    expect(signals[0]!.workspaceId).toBe('ws-1')
    expect(signals[0]!.events).toHaveLength(1)
  })

  it('rolls back: an invalid commit writes nothing and emits no signal', async () => {
    const { ctx, store } = await boot()
    const signals: PkwEventCommitted[] = []
    ctx.on('pkw/event.committed', signal => { signals.push(signal) })

    await expect(store.commit({ operationContext: op('op-empty'), events: [] })).rejects.toThrow()
    expect(store.list()).toHaveLength(0)
    expect(signals).toHaveLength(0)

    await expect(store.commit({
      operationContext: op('op-bad'),
      events: [{ type: '', aggregateType: 'note', aggregateId: 'n1', payload: {} }],
    })).rejects.toThrow()
    expect(store.list()).toHaveLength(0)
    expect(signals).toHaveLength(0)
  })

  it('keeps durable events across a service restart', async () => {
    const booted = await boot()
    await booted.store.commit({
      operationContext: op('op-restart'),
      events: [{ type: 'task.created', aggregateType: 'task', aggregateId: 't1', payload: {} }],
    })

    await booted.fiber.dispose()
    await booted.ctx.plugin(PkwEventStoreService)

    expect(booted.ctx.pkwEvents.get(OperationId('op-restart'))).toBeDefined()
    expect(booted.ctx.pkwEvents.list()).toHaveLength(1)
  })

  it('is idempotent on a duplicated operationId (no duplicate, no second signal)', async () => {
    const { ctx, store } = await boot()
    const signals: PkwEventCommitted[] = []
    ctx.on('pkw/event.committed', signal => { signals.push(signal) })

    const context = op('op-dup')
    const events = [{ type: 'task.created', aggregateType: 'task', aggregateId: 't1', payload: {} }]
    const first = await store.commit({ operationContext: context, events })
    const second = await store.commit({ operationContext: context, events })

    expect(first.operationId).toBe(second.operationId)
    expect(store.list()).toHaveLength(1)
    expect(signals).toHaveLength(1)
  })
})

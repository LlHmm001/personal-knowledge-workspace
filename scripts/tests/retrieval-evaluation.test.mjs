import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { captureRun, compareRuns, digest, evaluateRun, identityFromRpcResult, validateDataset } from '../evaluate-retrieval.mjs'

const query = (id, judgments, noAnswer = false) => ({ id, query: `synthetic private query ${id}`, judgments: judgments.map(([businessId, relevance]) => ({ businessId, relevance })), noAnswer, judgmentsComplete: true })
const dataset = queries => ({ schemaVersion: 1, datasetId: 'synthetic-v1', evidenceKind: 'synthetic', corpusVersion: 'synthetic-corpus-sha', workspaceId: 'synthetic-workspace', queries })
function run(ds, rows, extras = {}) {
  return { schemaVersion: 1, runId: 'baseline', datasetId: ds.datasetId, datasetSha256: digest(ds), corpusVersion: ds.corpusVersion, workspaceId: ds.workspaceId, limit: 10, createdAt: '2026-10-02T00:00:00.000Z', provenance: { codeVersion: 'code-sha', configVersion: 'config-digest', indexVersion: 'index-snapshot' },
    queries: rows.map((hits, i) => ({ queryId: ds.queries[i].id, status: 'ok', latencyMs: (i + 1) * 10, hits: hits.map(businessId => ({ businessId })) })), ...extras }
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)

test('precision uses fixed k; recall, reciprocal rank and graded nDCG match hand calculations', () => {
  const ds = dataset([query('q1', [['note:a', 3], ['note:b', 1]])])
  const report = evaluateRun(ds, run(ds, [['note:b', 'note:x', 'note:a']]), { k: [1, 3, 5] })
  near(report.metrics[1].answerable.precisionAtK, 1)
  near(report.metrics[1].answerable.recallAtK, 0.5)
  near(report.metrics[1].answerable.ndcgAtK, 1 / 7)
  near(report.metrics[3].answerable.precisionAtK, 2 / 3)
  near(report.metrics[3].answerable.recallAtK, 1)
  near(report.metrics[3].answerable.mrrAtK, 1)
  near(report.metrics[3].answerable.ndcgAtK, (1 + 7 / Math.log2(4)) / (7 + 1 / Math.log2(3)))
  near(report.metrics[5].answerable.precisionAtK, 2 / 5)
})

test('duplicates and unmapped remote hits retain rank slots and cannot inflate relevance', () => {
  const ds = dataset([query('q1', [['note:a', 2], ['note:b', 1]])])
  const report = evaluateRun(ds, run(ds, [[null, 'note:a', 'note:a', 'note:b']]), { k: [3, 4] })
  const at3 = report.queries[0].metrics[3]
  near(at3.precisionAtK, 1 / 3); near(at3.recallAtK, 0.5); near(at3.reciprocalRankAtK, 0.5)
  assert.equal(at3.duplicates, 1); assert.equal(at3.unmapped, 1)
  near(report.metrics[4].answerable.recallAtK, 1)
})

test('failed queries cannot become clean no-answer successes or disappear from answerable macro scores', () => {
  const ds = dataset([query('a', [['note:a', 1]]), query('error', [['note:b', 1]]), query('empty', [], true), query('noise', [], true), query('down', [], true)])
  const input = run(ds, [['note:a'], [], [], [null], []])
  input.queries[1] = { ...input.queries[1], status: 'error', errorCode: 'TIMEOUT' }
  input.queries[4] = { ...input.queries[4], status: 'error', errorCode: 'HTTP_ERROR' }
  const report = evaluateRun(ds, input, { k: [1] })
  near(report.metrics[1].answerable.recallAtK, 0.5)
  near(report.metrics[1].answerable.mrrAtK, 0.5)
  near(report.metrics[1].noAnswer.falsePositiveRateAtK, 1 / 3)
  near(report.metrics[1].noAnswer.emptySuccessRateAtK, 1 / 3)
  near(report.metrics[1].noAnswer.errorRate, 1 / 3)
  near(report.querySuccessRate, 3 / 5)
  assert.equal(report.queries[4].metrics[1].noAnswerFalsePositive, null)
  assert.equal(report.latency.all.p50Ms, 30); assert.equal(report.latency.all.p95Ms, 50)
  assert.equal(report.latency.successful.count, 3)
})

test('empty answerable results are zero; absent metric populations are null', () => {
  const ds = dataset([query('one', [['note:a', 1]])])
  const report = evaluateRun(ds, run(ds, [[]]), { k: [1] })
  assert.deepEqual(report.metrics[1].answerable, { count: 1, precisionAtK: 0, recallAtK: 0, mrrAtK: 0, ndcgAtK: 0 })
  assert.equal(report.metrics[1].noAnswer.falsePositiveRateAtK, null)
  const negative = dataset([query('none', [], true)])
  assert.equal(evaluateRun(negative, run(negative, [[]]), { k: [1] }).metrics[1].answerable.ndcgAtK, null)
})

test('RPC identity mirrors Note > Companion Note > Attachment without remote IDs', () => {
  assert.equal(identityFromRpcResult({ local: { entityType: 'note', entityId: 'user-supplied-stable-id' } }), 'note:user-supplied-stable-id')
  assert.equal(identityFromRpcResult({ local: { entityType: 'attachment', entityId: 'att_a', companionNoteId: 'note_c' } }), 'note:note_c')
  assert.equal(identityFromRpcResult({ local: { entityType: 'attachment', entityId: 'att_a' } }), 'attachment:att_a')
  assert.equal(identityFromRpcResult({ remote: { knowledgeId: 'remote-secret', score: 999 } }), null)
  assert.equal(identityFromRpcResult({ local: { entityType: 'knowledge', entityId: 'remote-id' } }), null)
  assert.equal(identityFromRpcResult({ local: { entityType: 'note' } }), null)
})

test('validates judgment intent and IDs instead of silently accepting mislabeled datasets', () => {
  for (const invalid of [
    dataset([]), dataset([query('a', [], false)]), dataset([query('a', [['note:a', 1]], true)]),
    dataset([query('a', [['knowledge:remote', 1]])]), dataset([query('a', [['note:a', 4]])]),
    dataset([query('a', [['note:a', 1], ['note:a', 2]])]), dataset([query('a', [['note:a', 1]]), query('a', [['note:b', 1]])]),
  ]) assert.throws(() => validateDataset(invalid))
  const ds = dataset([query('a', [['note:a', 1]])]); ds.queries[0].judgmentsComplete = false
  const report = evaluateRun(ds, run(ds, [['note:a']]), { k: [1] })
  assert.equal(report.judgmentsComplete, false)
  assert.ok(report.caveats.some(c => c.includes('provisional')))
  assert.equal(report.evidenceKind, 'synthetic')
})

test('comparison binds exact judgments/corpus/workspace and exposes per-query losses despite macro gains', () => {
  const ds = dataset([query('a', [['note:a', 1]]), query('b', [['note:b', 1]])])
  const before = run(ds, [['note:x', 'note:a'], ['note:b']])
  const after = run(ds, [['note:a'], []], { runId: 'candidate', provenance: { codeVersion: 'candidate-sha', configVersion: 'different-config', indexVersion: 'index-snapshot' } })
  const result = compareRuns(ds, before, after, { k: [1, 2] })
  near(result.delta.metrics[1].answerable.recallAtK, 0)
  near(result.delta.queries[1].metrics[1].recallAtK, -1)
  assert.match(result.decision, /not_automatically_approved/)
  for (const changed of [{ ...after, corpusVersion: 'other' }, { ...after, workspaceId: 'other' }, { ...after, datasetSha256: 'other' }, { ...after, queries: after.queries.slice(1) }]) assert.throws(() => compareRuns(ds, before, changed, { k: [1] }))
  const changedJudgment = structuredClone(ds); changedJudgment.queries[0].judgments[0].relevance = 3
  assert.throws(() => evaluateRun(changedJudgment, before, { k: [1] }), /does not match/)
  assert.throws(() => evaluateRun(ds, before, { k: [11] }), /Cutoffs/)
  assert.throws(() => evaluateRun(ds, { ...before, provenance: {} }, { k: [1] }), /codeVersion/)
})

test('capture exercises real loopback HTTP, explicit space path, headers, body timeout, redirects and privacy', async () => {
  let redirectFollowed = false
  const calls = []
  const server = createServer(async (req, res) => {
    if (req.url === '/redirect-target') { redirectFollowed = true; res.end('{}'); return }
    calls.push({ path: req.url, cookie: req.headers.cookie, method: req.method })
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); assert.equal(body.method, 'search'); assert.equal(body.args.limit, 2)
    const key = body.args.query
    if (key === 'timeout') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); return }
    if (key === 'http') { res.writeHead(401); res.end('private server diagnostic'); return }
    if (key === 'redirect') { res.writeHead(302, { Location: '/redirect-target' }); res.end(); return }
    if (key === 'malformed') { res.end('not JSON private content'); return }
    if (key === 'rpc') { res.end(JSON.stringify({ ok: false, error: 'private RPC diagnostic' })); return }
    res.end(JSON.stringify({ ok: true, value: { results: [{ local: { entityType: 'attachment', entityId: 'att_a', companionNoteId: 'note_a' }, remote: { content: 'private document body', score: 500 } }, { remote: { knowledgeId: 'remote-secret', snippet: 'private snippet' } }], trace: { query: 'private query trace', mainRaw: 9, final: 2, apiKey: 'secret-trace' } } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const ds = dataset(['ok', 'http', 'rpc', 'malformed', 'timeout', 'redirect'].map(id => ({ ...query(id, [], true), query: id })))
    const result = await captureRun(ds, { endpoint: `http://127.0.0.1:${server.address().port}/pkw/spaces/private/api`, runId: 'synthetic-http', codeVersion: 'sha', configVersion: 'cfg', indexVersion: 'idx', headers: { Cookie: 'private-session' }, limit: 2, timeoutMs: 250 })
    assert.deepEqual(result.queries.map(q => q.status), ['ok', 'error', 'error', 'error', 'error', 'error'])
    assert.deepEqual(result.queries.slice(1).map(q => q.errorCode), ['HTTP_ERROR', 'RPC_ERROR', 'INVALID_RESPONSE', 'TIMEOUT', 'TRANSPORT_ERROR'])
    assert.deepEqual(result.queries[0].hits, [{ businessId: 'note:note_a' }, { businessId: null }])
    assert.deepEqual(result.queries[0].trace, { mainRaw: 9, final: 2 })
    assert.equal(result.queries[0].mode, 'unknown'); assert.equal(result.queries[0].partial, null)
    assert.equal(redirectFollowed, false)
    assert.ok(calls.every(c => c.path === '/pkw/spaces/private/api' && c.method === 'POST' && c.cookie === 'private-session'))
    assert.doesNotMatch(JSON.stringify(result), /private document|private snippet|private query|private-session|private server|private RPC|remote-secret|secret-trace/)
    assert.equal(evaluateRun(ds, result, { k: [1, 2] }).errorCount, 5)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('capture preserves remote, partial processing and local fallback without storing warning text', async () => {
  const values = [
    { mode: 'remote', trace: { final: 0 } },
    { mode: 'remote', trace: { processingUnavailable: true, final: 0 } },
    { mode: 'local-keyword', trace: { skipped: 2, final: 0 }, warning: 'private operator diagnostic' },
    { trace: { final: 0 } },
    { mode: 'remote', trace: { processingUnavailable: 'true' } },
  ]
  let next = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    res.end(JSON.stringify({ ok: true, value: { results: [], ...values[next++] } }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const ds = dataset(values.map((_, index) => query(String(index), [], true)))
    const captured = await captureRun(ds, { endpoint: `http://127.0.0.1:${server.address().port}/pkw/api`, runId: 'modes', codeVersion: 'sha', configVersion: 'cfg', indexVersion: 'idx' })
    assert.deepEqual(captured.queries.slice(0, 4).map(q => [q.mode, q.partial]), [['remote', false], ['remote', true], ['local-keyword', true], ['unknown', null]])
    assert.equal(captured.queries[4].errorCode, 'INVALID_RESPONSE')
    assert.equal(captured.queries[1].trace.processingUnavailable, true)
    assert.doesNotMatch(JSON.stringify(captured), /private operator diagnostic/)
    const report = evaluateRun(ds, captured, { k: [1] })
    near(report.querySuccessRate, 0.8); near(report.retrievalScope.completeRemoteRate, 0.2)
    near(report.retrievalScope.remotePartialRate, 0.2); near(report.retrievalScope.localKeywordRate, 0.2)
    near(report.retrievalScope.unknownSuccessRate, 0.2); near(report.retrievalScope.partialRate, 0.4)
    near(report.retrievalScope.processingUnavailableRate, 0.2); near(report.retrievalScope.failedRate, 0.2)
    near(report.metrics[1].noAnswer.emptySuccessRateAtK, 0.8)
    near(report.metrics[1].noAnswer.completeRemoteEmptySuccessRateAtK, 0.2)
    near(report.metrics[1].noAnswer.partialEmptySuccessRateAtK, 0.4)
    near(report.metrics[1].noAnswer.unknownScopeEmptySuccessRateAtK, 0.2)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('scope rates include errors, preserve unknown legacy scope and reject contradictory flags', () => {
  const ds = dataset(['remote', 'partial', 'fallback', 'legacy', 'error'].map(id => query(id, [], true)))
  const input = run(ds, [[], [], [], [], []])
  Object.assign(input.queries[0], { mode: 'remote', partial: false })
  Object.assign(input.queries[1], { mode: 'remote', partial: true, trace: { processingUnavailable: true } })
  Object.assign(input.queries[2], { mode: 'local-keyword', partial: true })
  Object.assign(input.queries[4], { status: 'error', errorCode: 'RPC_ERROR' })
  const report = evaluateRun(ds, input, { k: [1] })
  for (const category of ['completeRemote', 'remotePartial', 'localKeyword', 'unknownSuccess', 'failed']) near(report.retrievalScope[category + 'Rate'], 0.2)
  assert.equal(report.queries[3].partial, null); assert.equal(report.queries[4].partial, null)
  assert.throws(() => evaluateRun(ds, { ...input, queries: input.queries.map((q, i) => i === 2 ? { ...q, partial: false } : q) }, { k: [1] }), /contradicts/)
  assert.throws(() => evaluateRun(ds, { ...input, queries: input.queries.map((q, i) => i === 1 ? { ...q, trace: { processingUnavailable: 'true' } } : q) }, { k: [1] }), /availability flag/)
})

test('comparison reveals fallback even when relevance and RPC success are unchanged', () => {
  const ds = dataset([query('one', [['note:a', 1]])]), baseline = run(ds, [['note:a']]), candidate = structuredClone(baseline)
  Object.assign(baseline.queries[0], { mode: 'remote', partial: false })
  Object.assign(candidate.queries[0], { mode: 'local-keyword', partial: true })
  const compared = compareRuns(ds, baseline, candidate, { k: [1] })
  near(compared.delta.metrics[1].answerable.recallAtK, 0); near(compared.delta.querySuccessRate, 0)
  near(compared.delta.retrievalScope.completeRemoteRate, -1); near(compared.delta.retrievalScope.localKeywordRate, 1)
  assert.equal(compared.delta.queries[0].modeAfter, 'local-keyword'); assert.equal(compared.delta.queries[0].partialAfter, true)
})

test('network collection is opt-in for remote HTTPS and rejects URLs carrying credentials', async () => {
  const ds = dataset([query('a', [], true)]), opts = { runId: 'x', codeVersion: 'x', configVersion: 'x', indexVersion: 'x' }
  for (const endpoint of ['https://example.org/pkw/api', 'http://example.org/pkw/api', 'http://user:secret@127.0.0.1/pkw/api', 'http://127.0.0.1/pkw/api?token=secret', 'http://127.0.0.1/pkw/api#secret']) {
    await assert.rejects(captureRun(ds, { ...opts, endpoint }))
  }
  await assert.rejects(captureRun(ds, { ...opts, endpoint: 'http://example.org/pkw/api', allowRemote: true }), /HTTPS/)
})

test('CLI evaluates and compares saved observations offline; preserves existing evidence and redacts invalid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-retrieval-'))
  const tool = resolve('scripts/evaluate-retrieval.mjs')
  const invoke = args => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
  try {
    const ds = dataset([query('a', [['note:a', 1]])]), input = run(ds, [['note:a']])
    const dsPath = join(dir, 'dataset.json'), runPath = join(dir, 'run.json'), reportPath = join(dir, 'report.json')
    await writeFile(dsPath, JSON.stringify(ds)); await writeFile(runPath, JSON.stringify(input))
    const evaluation = invoke(['evaluate', '--dataset', dsPath, '--run', runPath, '--out', reportPath, '--k', '1'])
    assert.equal(evaluation.status, 0, evaluation.stderr)
    const report = JSON.parse(await readFile(reportPath, 'utf8')); assert.equal(report.metrics[1].answerable.recallAtK, 1)
    assert.doesNotMatch(JSON.stringify(report) + evaluation.stdout, /synthetic private query/)
    const second = invoke(['evaluate', '--dataset', dsPath, '--run', runPath, '--out', reportPath, '--k', '1'])
    assert.equal(second.status, 1); assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report)
    const comparison = invoke(['compare', '--dataset', dsPath, '--baseline', runPath, '--candidate', runPath, '--out', join(dir, 'compare.json'), '--k', '1'])
    assert.equal(comparison.status, 0, comparison.stderr)
    await writeFile(dsPath, '{"query": "private-invalid-json"')
    const invalid = invoke(['evaluate', '--dataset', dsPath, '--run', runPath, '--out', join(dir, 'bad.json')])
    assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stderr, /private-invalid-json/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

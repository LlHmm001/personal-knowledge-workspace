#!/usr/bin/env node
// Read-only PKW search measurement. No indexing, canonical writes, or reranking.
import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'

const TRACE_FIELDS = ['mainRaw', 'processingRaw', 'afterBusiness', 'afterCanonical', 'afterRelevance', 'final']
const MODES = ['remote', 'local-keyword', 'unknown']
const ERRORS = new Set(['HTTP_ERROR', 'RPC_ERROR', 'INVALID_RESPONSE', 'TIMEOUT', 'TRANSPORT_ERROR'])
const fail = message => { throw new Error(message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const businessId = value => typeof value === 'string' && /^(note|attachment):[^\u0000-\u001f\u007f]+$/.test(value)
const canonicalJson = value => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')

export function validateDataset(dataset) {
  if (!object(dataset) || dataset.schemaVersion !== 1) fail('Dataset schemaVersion must be 1')
  for (const field of ['datasetId', 'corpusVersion', 'workspaceId']) if (!nonempty(dataset[field])) fail(`Dataset ${field} is required`)
  if (!['synthetic', 'authorized-corpus'].includes(dataset.evidenceKind)) fail('Dataset evidenceKind must be synthetic or authorized-corpus')
  if (!Array.isArray(dataset.queries) || dataset.queries.length === 0) fail('Dataset needs at least one query')
  const ids = new Set()
  for (const q of dataset.queries) {
    if (!object(q) || !nonempty(q.id) || ids.has(q.id)) fail('Query IDs must be nonempty and unique')
    ids.add(q.id)
    if (!nonempty(q.query) || typeof q.noAnswer !== 'boolean' || typeof q.judgmentsComplete !== 'boolean') fail(`Query ${q.id}: query/noAnswer/judgmentsComplete are required`)
    if (!Array.isArray(q.judgments)) fail(`Query ${q.id}: judgments must be an array`)
    const judged = new Set()
    for (const j of q.judgments) {
      if (!object(j) || !businessId(j.businessId) || judged.has(j.businessId)) fail(`Query ${q.id}: invalid or duplicate business ID`)
      if (!Number.isInteger(j.relevance) || j.relevance < 0 || j.relevance > 3) fail(`Query ${q.id}: relevance must be 0..3`)
      judged.add(j.businessId)
    }
    const relevant = q.judgments.filter(j => j.relevance > 0).length
    if (q.noAnswer ? relevant !== 0 : relevant === 0) fail(`Query ${q.id}: noAnswer conflicts with positive judgments`)
  }
  return dataset
}

function validateRun(dataset, run) {
  if (!object(run) || run.schemaVersion !== 1 || !nonempty(run.runId)) fail('Run schemaVersion/runId are required')
  if (run.datasetSha256 !== digest(dataset) || run.datasetId !== dataset.datasetId || run.corpusVersion !== dataset.corpusVersion || run.workspaceId !== dataset.workspaceId) fail('Run does not match this dataset/corpus/workspace')
  if (!Number.isInteger(run.limit) || run.limit < 1 || run.limit > 1000) fail('Run limit must be 1..1000')
  if (!object(run.provenance)) fail('Run provenance is required')
  for (const field of ['codeVersion', 'configVersion', 'indexVersion']) if (!nonempty(run.provenance[field])) fail(`Run provenance.${field} is required`)
  if (!nonempty(run.createdAt) || !Number.isFinite(Date.parse(run.createdAt))) fail('Run createdAt must be an ISO timestamp')
  if (!Array.isArray(run.queries) || run.queries.length !== dataset.queries.length) fail('Run must contain exactly one observation per query')
  const expected = new Set(dataset.queries.map(q => q.id)), found = new Set()
  for (const row of run.queries) {
    if (!object(row) || !expected.has(row.queryId) || found.has(row.queryId)) fail('Run query IDs must match the dataset exactly')
    found.add(row.queryId)
    if (!finite(row.latencyMs) || !['ok', 'error'].includes(row.status) || !Array.isArray(row.hits) || row.hits.length > run.limit) fail(`Run query ${row.queryId}: invalid status/latency/hits`)
    if (row.status === 'error' && (!ERRORS.has(row.errorCode) || row.hits.length !== 0)) fail(`Run query ${row.queryId}: invalid error observation`)
    if (row.mode !== undefined && !MODES.includes(row.mode)) fail(`Run query ${row.queryId}: invalid retrieval mode`)
    if (row.partial !== undefined && row.partial !== null && typeof row.partial !== 'boolean') fail(`Run query ${row.queryId}: invalid partial flag`)
    if (row.trace?.processingUnavailable !== undefined && typeof row.trace.processingUnavailable !== 'boolean') fail(`Run query ${row.queryId}: invalid processing availability flag`)
    if (row.partial === false && (row.mode === 'local-keyword' || row.trace?.processingUnavailable === true)) fail(`Run query ${row.queryId}: partial flag contradicts retrieval scope`)
    for (const hit of row.hits) if (!object(hit) || (hit.businessId !== null && !businessId(hit.businessId))) fail(`Run query ${row.queryId}: invalid hit identity`)
  }
  return run
}

/** Matches WeKnoraSyncService.businessKey; never substitutes a remote ID. */
export function identityFromRpcResult(result) {
  const local = result?.local
  if (!object(local)) return null
  const kind = local.entityType === 'attachment' && nonempty(local.companionNoteId) ? 'note' : local.entityType
  const id = local.entityType === 'attachment' && nonempty(local.companionNoteId) ? local.companionNoteId : local.entityId
  const key = `${kind}:${id}`
  return nonempty(id) && businessId(key) ? key : null
}

function cutoffs(input, limit) {
  if (!Array.isArray(input) || !input.length || input.some(k => !Number.isInteger(k) || k < 1 || k > limit)) fail(`Cutoffs must be integers from 1 to the run limit (${limit})`)
  return [...new Set(input)].sort((a, b) => a - b)
}

const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] : null
function latency(values) { return { count: values.length, meanMs: average(values), p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: values.length ? Math.max(...values) : null } }
function retrievalScope(row) {
  if (row.status === 'error') return { mode: 'unknown', partial: null, processingUnavailable: null }
  const mode = MODES.includes(row.mode) ? row.mode : 'unknown'
  const processingUnavailable = typeof row.trace?.processingUnavailable === 'boolean' ? row.trace.processingUnavailable : mode === 'remote' ? false : null
  const partial = mode === 'local-keyword' || processingUnavailable === true || row.partial === true ? true : mode === 'remote' ? false : null
  return { mode, partial, processingUnavailable }
}
function scopeSummary(queries) {
  const count = predicate => queries.filter(predicate).length
  const completeRemote = count(q => q.status === 'ok' && q.mode === 'remote' && q.partial === false)
  const remotePartial = count(q => q.status === 'ok' && q.mode === 'remote' && q.partial === true)
  const localKeyword = count(q => q.status === 'ok' && q.mode === 'local-keyword')
  const unknownSuccess = count(q => q.status === 'ok' && q.mode === 'unknown')
  const failed = count(q => q.status === 'error'), partial = count(q => q.partial === true), processingUnavailable = count(q => q.processingUnavailable === true)
  return { denominator: 'all queries', queryCount: queries.length, ...Object.fromEntries(Object.entries({ completeRemote, remotePartial, localKeyword, unknownSuccess, failed, partial, processingUnavailable }).flatMap(([key, value]) => [[key + 'Count', value], [key + 'Rate', value / queries.length]])) }
}

function scoreQuery(q, observation, k) {
  const judgments = new Map(q.judgments.map(j => [j.businessId, j.relevance]))
  const positives = q.judgments.filter(j => j.relevance > 0)
  const seen = new Set()
  let relevant = 0, firstRank = 0, dcg = 0, duplicates = 0, unmapped = 0, unjudged = 0
  const hits = observation.hits.slice(0, k)
  for (const [index, hit] of hits.entries()) {
    const id = hit.businessId
    if (id === null) { unmapped++; continue }
    if (seen.has(id)) { duplicates++; continue }
    seen.add(id)
    if (!judgments.has(id)) unjudged++
    const grade = judgments.get(id) ?? 0
    if (grade > 0) { relevant++; firstRank ||= index + 1; dcg += (2 ** grade - 1) / Math.log2(index + 2) }
  }
  const idcg = positives.map(j => j.relevance).sort((a, b) => b - a).slice(0, k).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0)
  // Failed answerable queries score zero; errors never count as successful abstention.
  return {
    precisionAtK: q.noAnswer ? null : relevant / k,
    recallAtK: q.noAnswer ? null : relevant / positives.length,
    reciprocalRankAtK: q.noAnswer ? null : (firstRank ? 1 / firstRank : 0),
    ndcgAtK: q.noAnswer ? null : dcg / idcg,
    noAnswerFalsePositive: q.noAnswer && observation.status === 'ok' ? hits.length > 0 : null,
    returned: hits.length, relevant, duplicates, unmapped, unjudged,
  }
}

export function evaluateRun(dataset, run, options = {}) {
  validateDataset(dataset); validateRun(dataset, run)
  const ks = cutoffs(options.k ?? [1, 5, 10], run.limit)
  const observations = new Map(run.queries.map(q => [q.queryId, q]))
  const queries = dataset.queries.map(q => {
    const row = observations.get(q.id)
    return { queryId: q.id, noAnswer: q.noAnswer, judgmentsComplete: q.judgmentsComplete, status: row.status, ...(row.status === 'error' ? { errorCode: row.errorCode } : {}), ...retrievalScope(row), latencyMs: row.latencyMs,
      metrics: Object.fromEntries(ks.map(k => [k, scoreQuery(q, row, k)])) }
  })
  const answerable = queries.filter(q => !q.noAnswer), noAnswer = queries.filter(q => q.noAnswer)
  const metrics = Object.fromEntries(ks.map(k => [k, {
    answerable: { count: answerable.length, precisionAtK: average(answerable.map(q => q.metrics[k].precisionAtK)), recallAtK: average(answerable.map(q => q.metrics[k].recallAtK)), mrrAtK: average(answerable.map(q => q.metrics[k].reciprocalRankAtK)), ndcgAtK: average(answerable.map(q => q.metrics[k].ndcgAtK)) },
    noAnswer: { count: noAnswer.length, falsePositiveRateAtK: average(noAnswer.map(q => q.metrics[k].noAnswerFalsePositive === true ? 1 : 0)), emptySuccessRateAtK: average(noAnswer.map(q => q.metrics[k].noAnswerFalsePositive === false ? 1 : 0)), errorRate: average(noAnswer.map(q => q.status === 'error' ? 1 : 0)),
      completeRemoteEmptySuccessRateAtK: average(noAnswer.map(q => q.metrics[k].noAnswerFalsePositive === false && q.mode === 'remote' && q.partial === false ? 1 : 0)),
      partialEmptySuccessRateAtK: average(noAnswer.map(q => q.metrics[k].noAnswerFalsePositive === false && q.partial === true ? 1 : 0)),
      unknownScopeEmptySuccessRateAtK: average(noAnswer.map(q => q.metrics[k].noAnswerFalsePositive === false && q.partial === null ? 1 : 0)) },
    diagnostics: { duplicateHits: queries.reduce((sum, q) => sum + q.metrics[k].duplicates, 0), unmappedHits: queries.reduce((sum, q) => sum + q.metrics[k].unmapped, 0), unjudgedHits: queries.reduce((sum, q) => sum + q.metrics[k].unjudged, 0) },
  }]))
  const errors = queries.filter(q => q.status === 'error').length
  return {
    schemaVersion: 1, kind: 'retrieval-evaluation', runId: run.runId, datasetId: dataset.datasetId, datasetSha256: digest(dataset), corpusVersion: dataset.corpusVersion, workspaceId: dataset.workspaceId,
    provenance: { codeVersion: run.provenance.codeVersion, configVersion: run.provenance.configVersion, indexVersion: run.provenance.indexVersion },
    createdAt: run.createdAt, evidenceKind: dataset.evidenceKind, provenanceVerification: 'operator-supplied; verify against installed artifact and configuration receipt', cutoffs: ks, queryCount: queries.length, errorCount: errors, querySuccessRate: (queries.length - errors) / queries.length,
    judgmentsComplete: queries.every(q => q.judgmentsComplete), retrievalScope: scopeSummary(queries),
    caveats: ['Metrics measure these judgments, not general production quality.', 'No-answer rates must be read together: false positives + successful empty + errors = 1.', 'Query success means an RPC response, not complete remote retrieval. Local-keyword fallback excludes attachment full text and semantics; partial/unknown empty results do not prove no answer exists.', ...(queries.some(q => !q.judgmentsComplete) ? ['Incomplete judgments: recall and nDCG are provisional; unjudged hits are scored zero.'] : [])],
    metrics, latency: { all: latency(queries.map(q => q.latencyMs)), successful: latency(queries.filter(q => q.status === 'ok').map(q => q.latencyMs)) }, queries,
  }
}

const delta = (baseline, candidate) => baseline === null || candidate === null ? null : candidate - baseline
export function compareRuns(dataset, baseline, candidate, options = {}) {
  const before = evaluateRun(dataset, baseline, options), after = evaluateRun(dataset, candidate, options)
  const metrics = Object.fromEntries(before.cutoffs.map(k => [k, {
    answerable: Object.fromEntries(['precisionAtK', 'recallAtK', 'mrrAtK', 'ndcgAtK'].map(name => [name, delta(before.metrics[k].answerable[name], after.metrics[k].answerable[name])])),
    noAnswer: Object.fromEntries(['falsePositiveRateAtK', 'emptySuccessRateAtK', 'errorRate', 'completeRemoteEmptySuccessRateAtK', 'partialEmptySuccessRateAtK', 'unknownScopeEmptySuccessRateAtK'].map(name => [name, delta(before.metrics[k].noAnswer[name], after.metrics[k].noAnswer[name])])),
  }]))
  return { schemaVersion: 1, kind: 'retrieval-comparison', datasetId: dataset.datasetId, datasetSha256: digest(dataset), baseline: before, candidate: after,
    delta: { convention: 'candidate minus baseline; higher quality/empty-success is better, lower false-positive/errors/latency is better', metrics,
      querySuccessRate: after.querySuccessRate - before.querySuccessRate,
      retrievalScope: Object.fromEntries(['completeRemoteRate', 'remotePartialRate', 'localKeywordRate', 'unknownSuccessRate', 'failedRate', 'partialRate', 'processingUnavailableRate'].map(key => [key, after.retrievalScope[key] - before.retrievalScope[key]])),
      p50Ms: delta(before.latency.all.p50Ms, after.latency.all.p50Ms), p95Ms: delta(before.latency.all.p95Ms, after.latency.all.p95Ms),
      queries: after.queries.map((q, i) => ({ queryId: q.queryId, statusBefore: before.queries[i].status, statusAfter: q.status, modeBefore: before.queries[i].mode, modeAfter: q.mode, partialBefore: before.queries[i].partial, partialAfter: q.partial,
        metrics: Object.fromEntries(before.cutoffs.map(k => [k, Object.fromEntries(['precisionAtK', 'recallAtK', 'reciprocalRankAtK', 'ndcgAtK'].map(name => [name, delta(before.queries[i].metrics[k][name], q.metrics[k][name])]))])) })) },
    decision: 'not_automatically_approved; inspect per-query regressions, judgment coverage, no-answer errors and version differences',
  }
}

function endpointUrl(endpoint, allowRemote) {
  let url
  try { url = new URL(endpoint) } catch { fail('Invalid endpoint URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('Endpoint must use HTTP(S) without embedded credentials, query, or fragment')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!local && (!allowRemote || url.protocol !== 'https:')) fail('Non-loopback endpoint requires explicit --allow-remote and HTTPS')
  return url
}

async function jsonResponse(response) {
  // Search RPC can contain raw snippets. Bound memory and never persist them.
  if (!response.body) fail('invalid response')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8 * 1024 * 1024) { await reader.cancel(); fail('response too large') }
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { reader.releaseLock() }
}

/** Sequential measurements against the existing search RPC; consumes queries, not documents. */
export async function captureRun(dataset, options) {
  validateDataset(dataset)
  const { endpoint, runId, codeVersion, configVersion, indexVersion, limit = 10, timeoutMs = 10000, headers = {}, allowRemote = false } = options
  const url = endpointUrl(endpoint, allowRemote)
  for (const [key, value] of Object.entries({ runId, codeVersion, configVersion, indexVersion })) if (!nonempty(value)) fail(`${key} is required`)
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) fail('Invalid limit (1..1000) or timeoutMs (1..300000)')
  if (!object(headers) || Object.entries(headers).some(([k, v]) => !nonempty(k) || typeof v !== 'string' || /[\r\n]/.test(k + v))) fail('Headers must be a string dictionary without newlines')
  const run = { schemaVersion: 1, runId, datasetId: dataset.datasetId, datasetSha256: digest(dataset), evidenceKind: dataset.evidenceKind, corpusVersion: dataset.corpusVersion, workspaceId: dataset.workspaceId, limit, createdAt: new Date().toISOString(), provenance: { codeVersion, configVersion, indexVersion }, queries: [] }
  for (const q of dataset.queries) {
    const start = performance.now(), controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let row
    try {
      const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'search', args: { query: q.query, limit } }), signal: controller.signal, redirect: 'error' })
      if (!response.ok) { await response.body?.cancel(); row = { status: 'error', errorCode: 'HTTP_ERROR', hits: [] } }
      else {
        let body
        try { body = await jsonResponse(response) } catch { if (controller.signal.aborted) throw new Error('timeout'); row = { status: 'error', errorCode: 'INVALID_RESPONSE', hits: [] } }
        if (body !== undefined) {
          if (object(body) && body.ok === false) row = { status: 'error', errorCode: 'RPC_ERROR', hits: [] }
          else if (!object(body) || body.ok !== true || !object(body.value) || !Array.isArray(body.value.results) || body.value.results.length > limit
            || (body.value.trace?.processingUnavailable !== undefined && typeof body.value.trace.processingUnavailable !== 'boolean')) row = { status: 'error', errorCode: 'INVALID_RESPONSE', hits: [] }
          else {
            const trace = Object.fromEntries(TRACE_FIELDS.filter(k => finite(body.value.trace?.[k])).map(k => [k, body.value.trace[k]]))
            if (typeof body.value.trace?.processingUnavailable === 'boolean') trace.processingUnavailable = body.value.trace.processingUnavailable
            row = { status: 'ok', mode: MODES.includes(body.value.mode) ? body.value.mode : 'unknown', hits: body.value.results.map(r => ({ businessId: identityFromRpcResult(r) })), trace }
            row.partial = retrievalScope(row).partial
          }
        }
      }
    } catch { row = { status: 'error', errorCode: controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR', hits: [] } }
    finally { clearTimeout(timer) }
    run.queries.push({ queryId: q.id, latencyMs: performance.now() - start, ...row })
  }
  return run
}

const HELP = `PKW retrieval evaluation (Node built-ins only)
  run --dataset FILE --endpoint http://127.0.0.1:PORT/pkw/api --run-id NAME
      --code-version SHA --config-version DIGEST --index-version SNAPSHOT --out FILE
      [--limit 10] [--timeout-ms 10000] [--headers-env ENV_NAME] [--allow-remote]
  evaluate --dataset FILE --run FILE --out FILE [--k 1,5,10]
  compare --dataset FILE --baseline FILE --candidate FILE --out FILE [--k 1,5,10]
No writes to PKW. Remote HTTPS requires explicit --allow-remote and authorization.
Reports contain IDs/metrics/version labels, not query text, snippets or credentials.
Output must be a new file. Exit 2 on captured query failures; reports are not release approval.`

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    dataset: { type: 'string' }, endpoint: { type: 'string' }, 'run-id': { type: 'string' }, 'code-version': { type: 'string' }, 'config-version': { type: 'string' }, 'index-version': { type: 'string' },
    out: { type: 'string' }, limit: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'headers-env': { type: 'string' }, 'allow-remote': { type: 'boolean' },
    run: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' }, k: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) { console.log(HELP); return 0 }
  const command = positionals[0]
  if (positionals.length !== 1 || !['run', 'evaluate', 'compare'].includes(command)) fail('Choose run, evaluate, or compare; see --help')
  if (!values.dataset || !values.out) fail('--dataset and --out are required')
  // Fail before sending any queries if the destination already exists.
  try { await lstat(values.out); fail('Output already exists; choose a new evidence file') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const load = async file => {
    if (!file) fail('Missing input file')
    const raw = await readFile(file, 'utf8')
    try { return JSON.parse(raw) } catch { fail('Input file is not valid JSON (contents omitted)') }
  }
  const dataset = await load(values.dataset), options = { k: (values.k ?? '1,5,10').split(',').map(Number) }
  let report
  if (command === 'run') {
    let headers = {}
    if (values['headers-env']) {
      const raw = process.env[values['headers-env']]
      try { headers = JSON.parse(raw ?? '') } catch { fail('Headers environment variable must contain a JSON object') }
    }
    report = await captureRun(dataset, { endpoint: values.endpoint, runId: values['run-id'], codeVersion: values['code-version'], configVersion: values['config-version'], indexVersion: values['index-version'], limit: Number(values.limit ?? 10), timeoutMs: Number(values['timeout-ms'] ?? 10000), headers, allowRemote: values['allow-remote'] })
  } else if (command === 'evaluate') report = evaluateRun(dataset, await load(values.run), options)
  else report = compareRuns(dataset, await load(values.baseline), await load(values.candidate), options)
  // Do not replace a dataset, previous evidence, or user's existing output.
  await writeFile(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const failures = command === 'run' ? report.queries.filter(q => q.status === 'error').length : command === 'evaluate' ? report.errorCount : report.baseline.errorCount + report.candidate.errorCount
  console.log(JSON.stringify({ kind: command, output: resolve(values.out), queryFailures: failures }))
  return failures ? 2 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code }).catch(error => { console.error(`Retrieval evaluation failed: ${error.message}`); process.exitCode = 1 })
}

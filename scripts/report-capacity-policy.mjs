#!/usr/bin/env node
/**
 * Capacity policy for release, rollback and failure-scene material — report only.
 *
 * This tool never deletes anything. It classifies what is on disk and prints the
 * reclaimable amount, so a human can decide. The policy it implements:
 *
 *   KEEP current      the release the running installation serves
 *   KEEP rollback     releases that are verified and compatible with current data
 *   KEEP scene        failure scenes and unclosed recovery transactions, with their
 *                     journals, inventories and receipts
 *   RECLAIM duplicate a tree whose full content (every file hash, permission bit,
 *                     symlink target and directory entry) is covered by a tree that
 *                     is itself KEEP. A shared entry point hash or a matching
 *                     package.json is not enough: the coverage check hashes
 *                     everything, exactly as scripts/cleanup-coverage.mjs does.
 *   UNKNOWN           anything it cannot classify is reported as KEEP
 *
 * Usage:
 *   node scripts/report-capacity-policy.mjs [--root DIR]... [--json] [--min-bytes N]
 *                                          [--scenes-retained N]
 */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  root: { type: 'string', multiple: true }, json: { type: 'boolean', default: false },
  'min-bytes': { type: 'string', default: String(64 * 1024 * 1024) },
  'scenes-retained': { type: 'string', default: '2' },
  'ignore-dir-mode': { type: 'boolean', default: false },
} })
const roots = (values.root ?? []).map(r => resolve(r))
if (roots.length === 0) {
  process.stderr.write('Usage: node scripts/report-capacity-policy.mjs --root DIR [--root DIR]... [--json]\n')
  process.exit(2)
}
const minBytes = Number(values['min-bytes'])
const scenesRetained = Number(values['scenes-retained'])

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Full-content inventory of one tree: path -> type/mode/target/hash. Also bytes. */
async function inventory(root) {
  const entries = new Map()
  let bytes = 0, files = 0, links = 0
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      const rel = relative(root, full)
      const st = await lstat(full).catch(() => null)
      if (!st) continue
      if (st.isSymbolicLink()) { entries.set(rel, { t: 'l', target: await readlink(full).catch(() => null) }); links += 1; continue }
      if (st.isDirectory()) { entries.set(rel, { t: 'd', mode: (st.mode & 0o7777).toString(8) }); await walk(full); continue }
      if (st.isFile()) {
        bytes += st.size; files += 1
        entries.set(rel, { t: 'f', mode: (st.mode & 0o7777).toString(8), hash: sha(await readFile(full).catch(() => Buffer.alloc(0))) })
      }
    }
  }
  await walk(root)
  return { entries, bytes, files, links }
}

/**
 * True when every entry of `candidate` exists in `keep` with identical content.
 * Permission bits are compared unless --ignore-dir-mode is set, in which case a
 * directory-mode difference is still *reported* rather than silently accepted.
 */
function covers(keep, candidate) {
  const differences = []
  for (const [rel, c] of candidate.entries) {
    const k = keep.entries.get(rel)
    if (!k) return { covered: false, differences: [`missing from retained tree: ${rel}`] }
    if (c.t !== k.t) return { covered: false, differences: [`type differs at ${rel}`] }
    if (c.t === 'l' && c.target !== k.target) return { covered: false, differences: [`symlink target differs at ${rel}`] }
    if (c.t === 'f' && c.hash !== k.hash) return { covered: false, differences: [`content differs at ${rel}`] }
    if (c.mode !== k.mode) {
      if (c.t === 'd' && values['ignore-dir-mode']) differences.push(`${rel}: mode ${c.mode} vs ${k.mode}`)
      else return { covered: false, differences: [`mode differs at ${rel}: ${c.mode} vs ${k.mode}`] }
    }
  }
  return { covered: true, differences }
}

/** Classify one directory: what kind of material is it, and who says so. */
async function classify(dir) {
  const receiptCandidates = ['receipt.json', 'report.json', 'MIGRATION.json']
  let receipt = null
  for (const name of receiptCandidates) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      receipt = { file: name, status: parsed.status ?? null, version: parsed.version ?? null }
      break
    } catch { receipt = { file: name, status: 'unparseable', version: null } }
  }
  const names = await readdir(dir).catch(() => [])
  const isScene = names.some(n => /^installation-recovery/.test(n)) || names.includes('previous-installation') || names.includes('journal.json')
  let version = receipt?.version ?? null
  if (!version) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) { try { version = JSON.parse(await readFile(manifest, 'utf8')).version ?? null } catch { /* ignore */ } }
  }
  if (!version) {
    const named = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(dir)
    if (named) version = named[1]
    else if (/\.dsh-install-(candidate|retained)-/.test(dir)) version = 'PKW 0.1.2-pkw.4 profile snapshot'
  }
  return { isScene, receipt, version }
}

const report = { generatedAt: new Date().toISOString(), roots, policy: {
  keep: ['current', 'verified-rollback', 'failure-scene-or-unclosed-transaction'],
  reclaim: 'only a full-content duplicate covered by a KEEP tree',
  unknown: 'reported as KEEP', scenesRetained, minBytes,
}, candidates: [] }

for (const root of roots) {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    // Follow one level of symlink: archives are often kept as links.
    const real = await lstat(dir).then(s => s.isSymbolicLink() ? readlink(dir).then(t => resolve(root, t)) : dir).catch(() => dir)
    const info = await inventory(real)
    if (info.bytes < minBytes) continue
    const { isScene, receipt, version } = await classify(real)
    report.candidates.push({ dir: real, bytes: info.bytes, files: info.files, links: info.links, version, receipt, isScene, entries: info.entries })
  }
}

// Decide what is retained, then look for full duplicates of the retained trees.
//
// Only a bounded number of failure scenes are *retained*. Scenes beyond the bound are
// not automatically deletable: they become reclaim candidates, and they are only
// reported as reclaimable when a retained tree covers them completely. Everything the
// policy cannot explain stays retained.
const sorted = report.candidates.sort((a, b) => b.bytes - a.bytes)
const scenes = sorted.filter(c => c.isScene).sort((a, b) => b.bytes - a.bytes)
const retainedScenes = scenes.slice(0, scenesRetained)
const surplusScenes = scenes.slice(scenesRetained)
const retained = [
  ...retainedScenes.map(c => ({ ...c, reason: 'failure-scene-or-unclosed-transaction' })),
  ...sorted.filter(c => !c.isScene).map(c => ({ ...c, reason: c.receipt?.status === 'passed' ? 'verified-release' : 'current-or-rollback-material' })),
]

const reclaimable = []
for (const candidate of surplusScenes) {
  for (const k of retained) {
    if (k.dir === candidate.dir) continue
    const verdict = covers(k, candidate)
    if (verdict.covered) {
      reclaimable.push({
        dir: candidate.dir, bytes: candidate.bytes, coveredBy: k.dir,
        reason: 'full-content duplicate of a retained failure scene',
        modeDifferences: verdict.differences.length,
        modeDifferenceExamples: verdict.differences.slice(0, 3),
      })
      break
    }
  }
}
/**
 * Scene metadata files are named after the recovery run, so two scenes never match
 * byte for byte even when the bulky payload they rescued is identical. Report the
 * payload separately: it is the part worth hundreds of megabytes, and it is the part
 * a decision actually turns on. Metadata is always treated as retained evidence.
 */
async function payloadOf(dir) {
  const candidate = join(dir, 'previous-installation')
  if (!existsSync(candidate)) return null
  return await inventory(candidate)
}
for (const scene of surplusScenes) {
  const coveringScene = retainedScenes.find(k => k.dir !== scene.dir)
  if (!coveringScene) continue
  const [mine, theirs] = [await payloadOf(scene.dir), await payloadOf(coveringScene.dir)]
  if (!mine || !theirs) continue
  const verdict = covers(theirs, mine)
  const entry = reclaimable.find(r => r.dir === scene.dir)
  const record = {
    dir: scene.dir, payloadDir: join(scene.dir, 'previous-installation'), bytes: mine.bytes,
    coveredBy: join(coveringScene.dir, 'previous-installation'),
    covered: verdict.covered, unaccountedFor: verdict.differences.slice(0, 3),
  }
  report.payloadCoverage = [...(report.payloadCoverage ?? []), record]
  if (verdict.covered && !entry) {
    reclaimable.push({ dir: record.payloadDir, bytes: mine.bytes, coveredBy: record.coveredBy,
      reason: 'payload is a full-content duplicate of a retained scene (metadata files stay retained)', modeDifferences: verdict.differences.length })
  }
}

report.retained = retained.map(k => ({ dir: k.dir, bytes: k.bytes, version: k.version, reason: k.reason, receiptStatus: k.receipt?.status ?? null, isScene: k.isScene }))
report.surplusScenes = surplusScenes.map(c => {
  const covered = reclaimable.find(r => r.dir === c.dir)
  return { dir: c.dir, bytes: c.bytes, verdict: covered ? 'reclaimable-duplicate' : 'retained-unexplained' }
})
report.reclaimable = reclaimable
report.totals = {
  scannedBytes: sorted.reduce((n, c) => n + c.bytes, 0),
  retainedBytes: retained.reduce((n, c) => n + c.bytes, 0),
  reclaimableBytes: reclaimable.reduce((n, c) => n + c.bytes, 0),
}
for (const c of report.candidates) delete c.entries

if (values.json) console.log(JSON.stringify(report, null, 2))
else {
  const mib = n => `${(n / 1048576).toFixed(0)} MiB`
  console.log(`scanned ${sorted.length} trees, ${mib(report.totals.scannedBytes)}`)
  console.log('\nRETAINED')
  for (const k of report.retained) console.log(`  ${mib(k.bytes).padStart(9)}  ${(k.version ?? '?').padEnd(26)} ${k.reason}  ${k.dir}`)
  if (report.surplusScenes.length) {
    console.log('\nSURPLUS SCENES (beyond the retained count)')
    for (const s of report.surplusScenes) console.log(`  ${mib(s.bytes).padStart(9)}  ${s.verdict}  ${s.dir}`)
  }
  console.log('\nRECLAIM (full-content duplicates only; nothing is deleted here)')
  if (reclaimable.length === 0) console.log('  none')
  for (const r of reclaimable) console.log(`  ${mib(r.bytes).padStart(9)}  ${r.dir}\n             covered by ${r.coveredBy}`)
  console.log(`\nreclaimable total: ${mib(report.totals.reclaimableBytes)}`)
  for (const r of reclaimable) {
    if (!r.modeDifferences) continue
    const examples = r.modeDifferenceExamples?.length ? ` (e.g. ${r.modeDifferenceExamples.join(', ')})` : ''
    console.log(`  note: ${r.dir} differs from its covering tree only in ${r.modeDifferences} directory modes${examples}`)
  }
}
process.exit(0)

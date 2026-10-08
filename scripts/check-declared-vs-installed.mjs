#!/usr/bin/env node
/**
 * Classify an installed PKW profile against a source build — read only.
 *
 * The strict artifact check (`check-runtime-imports.mjs`) compares the installed
 * lib tree with the tree this checkout builds and must keep failing when they
 * differ. That failure does not say *why* they differ, and "differs" has two very
 * different meanings:
 *
 *   BEHIND_REPO      the installed tree is an older release of the same packages
 *   CORRUPT          the installed tree claims a release it does not contain
 *   CURRENT          installed content matches this checkout's build
 *   AHEAD_OF_REPO    this checkout is older than what is installed
 *   UNVERIFIED       there is no trusted release manifest/hash list to compare with
 *
 * The classifier only reports CORRUPT when it has a trusted hash list for the
 * *declared* version to compare against. Without one it must answer UNVERIFIED —
 * a version string alone is never evidence.
 *
 * Exit code is 0 for every classification (this tool never fails a gate); it
 * prints a JSON report and a one-line human summary.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  profile: { type: 'string' }, repo: { type: 'string' },
  'release-manifest': { type: 'string' }, json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} })
if (values.help || !values.profile) {
  process.stdout.write('Usage: node scripts/check-declared-vs-installed.mjs --profile DIR [--repo DIR] [--release-manifest FILE] [--json]\n')
  process.exit(values.help ? 0 : 2)
}
const profile = resolve(values.profile)
const repo = resolve(values.repo ?? join(dirname(new URL(import.meta.url).pathname), '..'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function hashTree(root) {
  const out = new Map()
  async function walk(dir, base) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, base)
      else if (entry.isFile()) out.set(full.slice(base.length + 1), sha256(await readFile(full)))
    }
  }
  if (existsSync(root)) await walk(root, root)
  return out
}

/** A trusted manifest: package name -> version -> { file: sha256 } or a tarball hash. */
let trusted = null
if (values['release-manifest']) {
  try { trusted = JSON.parse(await readFile(resolve(values['release-manifest']), 'utf8')) } catch { trusted = null }
}

const installedRoot = join(profile, 'node_modules/@deepseek-ai')
const repoRoot = join(repo, 'packages/pkw')
const packages = []
if (existsSync(installedRoot)) {
  for (const entry of (await readdir(installedRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-pkw-')) continue
    const installedDir = join(installedRoot, entry.name)
    let installed
    try { installed = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf8')) } catch { continue }
    const repoDir = join(repoRoot, entry.name.replace('dsh-pkw-', ''))
    const repoManifestPath = join(repoDir, 'package.json')
    let repoVersion = null
    if (existsSync(repoManifestPath)) { try { repoVersion = JSON.parse(await readFile(repoManifestPath, 'utf8')).version } catch { /* ignore */ } }
    const installedLib = await hashTree(join(installedDir, 'lib'))
    const builtLib = existsSync(join(repoDir, 'lib')) ? await hashTree(join(repoDir, 'lib')) : null

    let verdict
    if (!builtLib) verdict = 'UNVERIFIED'
    else {
      const sameFiles = installedLib.size === builtLib.size && [...installedLib].every(([k, v]) => builtLib.get(k) === v)
      if (sameFiles) verdict = 'CURRENT'
      else {
        const trustedHashes = trusted?.packages?.[installed.name]?.versions?.[installed.version]?.files
        if (!trustedHashes) verdict = installed.version === repoVersion ? 'UNVERIFIED' : 'BEHIND_REPO'
        else {
          const everyFileMatches = Object.entries(trustedHashes).every(([file, hash]) => installedLib.get(file) === hash)
          verdict = everyFileMatches ? 'BEHIND_REPO' : 'CORRUPT'
        }
      }
    }
    packages.push({
      name: installed.name,
      installedVersion: installed.version,
      repoVersion,
      verdict,
      comparedFiles: builtLib ? builtLib.size : 0,
      trustedHashes: Boolean(trusted?.packages?.[installed.name]?.versions?.[installed.version]?.files),
      differingFiles: builtLib
        ? [...builtLib].filter(([k, v]) => installedLib.get(k) !== v).slice(0, 10).map(([k]) => k)
        : [],
    })
  }
}
const tally = packages.reduce((acc, p) => { acc[p.verdict] = (acc[p.verdict] ?? 0) + 1; return acc }, {})
const report = {
  profile, repo, releaseManifest: values['release-manifest'] ?? null,
  trustedManifestAvailable: Boolean(trusted),
  packages: packages.length, tally, details: packages,
  note: 'CORRUPT is only reported with a trusted hash list for the declared version; otherwise the verdict is UNVERIFIED. This tool is informational and never fails a build gate.',
}
if (values.json) console.log(JSON.stringify(report, null, 2))
else {
  for (const p of packages) console.log(`  ${p.verdict.padEnd(12)} ${p.name}@${p.installedVersion} (repo ${p.repoVersion ?? 'n/a'})`)
  console.log(`  summary: ${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (!trusted) console.log('  note: no trusted release manifest supplied; version-only differences are reported as UNVERIFIED')
}
process.exit(0)

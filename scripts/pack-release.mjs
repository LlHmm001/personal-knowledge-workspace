#!/usr/bin/env node
/**
 * Pack the built PKW packages into a release artifact directory.
 *
 * This produces the same material a site deploys: one directory per package, each holding one
 * tarball whose manifest declares the release version for the PKW packages and keeps the exact
 * version every Harness peer's own source tree declares. The result is what
 * `deploy/switch-release.mjs --artifact-dir` consumes and what a release receipt pins by digest.
 *
 * Everything it reads is inside the checkout: the built `lib` directories of the PKW packages,
 * so packing a release never touches an installation, a store or a serving service.
 *
 * Usage:
 *   node scripts/pack-release.mjs --artifact-dir DIR --version V [--json OUT]
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  'artifact-dir': { type: 'string' }, version: { type: 'string' }, json: { type: 'string' },
  'keep-work': { type: 'boolean', default: false },
  // Include the Harness peers a release needs, packed from a profile that already carries them.
  // Without this the tarballs alone are not installable offline: the peers are published by the
  // Harness release, and a site's registry does not carry them.
  'include-peers-from': { type: 'string' },
} })
if (!values['artifact-dir'] || !values.version) {
  process.stderr.write('Usage: node scripts/pack-release.mjs --artifact-dir DIR --version V [--json OUT]\n')
  process.exit(2)
}
const artifactDir = resolve(values['artifact-dir'])
const version = values.version
const workDir = join(artifactDir, '.pack-work')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const pkwRoot = join(repoRoot, 'packages/pkw')
const packageNames = (await readdir(pkwRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
if (packageNames.length === 0) throw new Error('no PKW packages found')

// The closure the tarballs declare: every peer package that must resolve inside an installation.
const peerNames = new Set()
for (const name of packageNames) {
  const manifest = JSON.parse(await readFile(join(pkwRoot, name, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {})) peerNames.add(dependency)
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) peerNames.add(dependency)
}
const peers = [...peerNames].filter(name => !packageNames.some(pkw => `@deepseek-ai/dsh-pkw-${pkw}` === name)).sort()
const peerVersions = new Map()
for (const peer of peers) {
  const manifestPath = join(repoRoot, 'node_modules', peer, 'package.json')
  if (!existsSync(manifestPath)) {
    // A peer the checkout does not carry cannot be pinned here; it is reported, not invented.
    peerVersions.set(peer, null)
    continue
  }
  peerVersions.set(peer, JSON.parse(await readFile(manifestPath, 'utf8')).version)
}

await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true, mode: 0o700 })
await mkdir(artifactDir, { recursive: true, mode: 0o700 })

const artifacts = []
/** Pack one package directory with a self-contained manifest. */
async function pack({ sourceDir, manifest, stampedVersion }) {
  const target = manifest.name.replace('@', '').replace('/', '__')
  const work = join(workDir, target)
  await mkdir(work, { recursive: true, mode: 0o700 })
  const skip = new Set(['node_modules', '.git', 'src', 'test', 'tests', '__tests__', 'coverage', 'dist', 'fixtures', 'tsconfig.json'])
  const declaredTopLevel = manifest.files ? new Set(manifest.files.map(pattern => String(pattern).split('/')[0])) : null
  const always = new Set(['package.json', 'LICENSE', 'README.md', 'cordis.yml', 'cordis.patch.yml'])
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    if (declaredTopLevel && !declaredTopLevel.has(entry.name) && !always.has(entry.name)) continue
    await cp(join(sourceDir, entry.name), join(work, entry.name), { recursive: true }).catch(() => {})
  }
  const rewritten = structuredClone(manifest)
  if (stampedVersion) rewritten.version = stampedVersion
  // Workspace protocol and file: specifiers cannot be installed from a tarball; the deployed
  // releases pin the closure by exact version instead.
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!rewritten[field]) continue
    for (const [dependency, spec] of Object.entries(rewritten[field])) {
      if (typeof spec === 'string' && (spec.startsWith('workspace:') || spec.startsWith('file:'))) {
        const local = packageNames.find(name => `@deepseek-ai/dsh-pkw-${name}` === dependency)
        rewritten[field][dependency] = local ? version : (peerVersions.get(dependency) ?? '*')
      }
    }
  }
  delete rewritten.scripts
  delete rewritten.devDependencies
  await writeFile(join(work, 'package.json'), JSON.stringify(rewritten, null, 2) + '\n')
  execFileSync('npm', ['pack', '--ignore-scripts', '--quiet'], { cwd: work, stdio: 'ignore' })
  const produced = (await readdir(work)).find(file => file.endsWith('.tgz'))
  if (!produced) throw new Error(`npm pack produced no tarball for ${manifest.name}`)
  const dir = join(artifactDir, target)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await cp(join(work, produced), join(dir, produced))
  // The unpacked contents are kept beside the tarball as well: the tarball is what a release
  // installs from, and the directory is what the release-source path reads to assemble a profile.
  for (const entry of await readdir(work, { withFileTypes: true })) {
    if (entry.name.endsWith('.tgz')) continue
    await cp(join(work, entry.name), join(dir, entry.name), { recursive: true })
  }
  const bytes = await readFile(join(dir, produced))
  artifacts.push({ name: rewritten.name, version: rewritten.version, tarball: join(dir, produced), sha256: sha256(bytes), bytes: bytes.length })
}

for (const name of packageNames) {
  const lib = join(pkwRoot, name, 'lib')
  if (!existsSync(lib)) throw new Error(`missing build output: ${lib} — run \`node scripts/build.mjs\` first`)
  const manifest = JSON.parse(await readFile(join(pkwRoot, name, 'package.json'), 'utf8'))
  await pack({ sourceDir: join(pkwRoot, name), manifest, stampedVersion: version })
}
// ── the Harness peers, packed from a profile that already resolved them ──────────────
const peersDirectory = values['include-peers-from'] ? resolve(values['include-peers-from'], 'node_modules/@deepseek-ai') : null
if (peersDirectory) {
  if (!existsSync(peersDirectory)) throw new Error(`--include-peers-from has no ${peersDirectory}`)
  for (const entry of await readdir(peersDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // The PKW packages are the release itself; everything else is a peer it depends on.
    if (entry.name.startsWith('dsh-pkw-')) continue
    const sourceDir = join(peersDirectory, entry.name)
    const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8'))
    await pack({ sourceDir, manifest, stampedVersion: null })
  }
}
if (!values['keep-work']) await rm(workDir, { recursive: true, force: true })

const receipt = {
  format: 'pkw-release-artifacts', version, artifactDir,
  source: { repo: repoRoot, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() },
  packedAt: new Date().toISOString(),
  packages: artifacts.length,
  artifacts,
  peersWithoutLocalManifest: peers.filter(peer => peerVersions.get(peer) === null),
}
if (values.json) await writeFile(resolve(values.json), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ version, packages: artifacts.length, artifactDir, unpinnedPeers: receipt.peersWithoutLocalManifest, json: values.json ?? null }, null, 2))

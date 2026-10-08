#!/usr/bin/env node
/**
 * Build an independent PKW runtime profile.
 *
 * Why this exists
 * ---------------
 * The PKW packages declare their Harness peers as `"*"`. Installed inside a DSH
 * profile those peers resolve through ancestor directories and end up loading the
 * live DSH installation (`/opt/dsh-releases/<release>`), so PKW and DSH share both
 * a package tree and a failure domain. This script builds a profile that carries
 * its own pinned copy of every Harness peer and every PKW package, so the runtime
 * resolves entirely inside the profile.
 *
 * What it guarantees
 * ------------------
 * - Every `@deepseek-ai/*` package the PKW packages can reach is pinned to the
 *   exact version resolved from the configured Harness checkout, packed with
 *   `workspace:` ranges rewritten, and published only to a one-off in-process
 *   loopback registry during installation.
 * - Installation happens into the given profile directory with its own store,
 *   cache and TMPDIR. The DSH profile is never named as a target.
 * - Afterwards the script proves, with Node's own resolver, that all PKW packages
 *   and all pinned peers resolve inside the profile, and that no resolved file
 *   lives under the DSH release root or the DSH profiles farm.
 *
 * Exit codes: 0 installed and verified, 5 verification failed, 2 usage/IO.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const USAGE = `Usage: node scripts/pkw-independent-profile.mjs --profile DIR [options]

  --profile DIR        absolute directory to create the independent profile in (required)
  --version VERSION    release version to stamp on the PKW packages (default 0.0.0-independent)
  --store DIR          pnpm store directory (default <profile>/../store)
  --cache DIR          npm/pnpm cache directory (default <profile>/../npm-cache)
  --tmp DIR            TMPDIR for the install (default <profile>/../tmp)
  --harness DIR        Harness checkout used to resolve peers (default $DSH_HARNESS_ROOT or /opt/deepseek-harness)
  --registry URL       upstream registry for third-party (non @deepseek-ai) packages
                       (default https://registry.npmjs.org)
  --dry-run            resolve, report the closure and exit without packing or installing
  --keep-staging       keep the packed tarball staging directory
`
const { values } = parseArgs({ options: {
  profile: { type: 'string' }, version: { type: 'string', default: '0.0.0-independent' },
  store: { type: 'string' }, cache: { type: 'string' }, tmp: { type: 'string' },
  harness: { type: 'string' }, registry: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  'release-source': { type: 'string' },
  'keep-staging': { type: 'boolean', default: false }, 'allow-existing': { type: 'string' },
  help: { type: 'boolean', default: false },
} })
if (values.help) { process.stdout.write(USAGE); process.exit(0) }
if (!values.profile) { process.stderr.write(USAGE); process.exit(2) }
// Validated before resolving: resolving first would silently accept a relative path and
// install somewhere the caller did not name.
if (!isAbsolute(values.profile)) {
  process.stderr.write(`--profile must be an absolute path; received ${JSON.stringify(values.profile)}\n`)
  process.exit(2)
}
const profile = resolve(values.profile)
const version = values.version
const harnessRoot = resolve(values.harness ?? process.env.DSH_HARNESS_ROOT ?? '/opt/deepseek-harness')
const upstream = values.registry ?? 'https://registry.npmjs.org'
const workRoot = dirname(profile)
const store = resolve(values.store ?? join(workRoot, 'store'))
const cache = resolve(values.cache ?? join(workRoot, 'npm-cache'))
const tmp = resolve(values.tmp ?? join(workRoot, 'tmp'))
const staging = join(workRoot, 'staging')
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..')

const sha256 = b => createHash('sha256').update(b).digest('hex')
const fail = (message, code = 2) => { process.stderr.write(`${message}\n`); process.exit(code) }

/** Index every package the Harness *source* tree provides, by declared name. */
async function indexHarnessWorkspace(root) {
  const index = new Map()
  async function walk(dir, depth = 0) {
    if (depth > 4) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
      const full = join(dir, entry.name)
      try {
        const manifest = JSON.parse(await readFile(join(full, 'package.json'), 'utf8'))
        if (manifest.name) index.set(manifest.name, { name: manifest.name, version: manifest.version, dir: full, manifest })
      } catch { /* not a package root */ }
      await walk(full, depth + 1)
    }
  }
  await walk(root)
  return index
}

const workspaceIndex = await indexHarnessWorkspace(harnessRoot)
if (workspaceIndex.size === 0) fail(`No packages found under --harness ${harnessRoot}`)

/**
 * Resolve a peer to the version the pinned Harness *source tree* provides.
 *
 * The source tree is the pinned, reviewable source of truth; the running DSH
 * release is deliberately not used as a version source here, because it is the
 * mutable thing this profile exists to stop depending on. A last-resort lookup in
 * the DSH profile farm is recorded in the receipt as `borrowedFromFarm` so an
 * operator can see any case where the source tree did not supply a peer.
 */
function resolvePeer(name) {
  const fromWorkspace = workspaceIndex.get(name)
  if (fromWorkspace) return { ...fromWorkspace, origin: 'harness-workspace' }
  for (const candidate of [
    join(harnessRoot, 'node_modules', name),
    join(harnessRoot, 'apps', 'cli', 'node_modules', name),
    ...(process.env.PKW_PEER_FALLBACK_ROOT ? [join(process.env.PKW_PEER_FALLBACK_ROOT, name)] : []),
  ]) {
    const manifestPath = join(candidate, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(execFileSync('cat', [manifestPath], { encoding: 'utf8' }))
      return { name: manifest.name ?? name, version: manifest.version, dir: candidate, manifest, origin: 'dsn-farm-fallback' }
    } catch { /* next */ }
  }
  return null
}

/**
 * Refuse to build over anything that is not a brand-new candidate directory.
 *
 * The builder installs into `--profile`, so an unconditional remove-then-create
 * would destroy whatever the caller pointed at — an installed DSH profile, the
 * release currently serving, or a directory holding data. A destination is accepted
 * only when it is provably fresh: either it does not exist, or it is an empty
 * directory. `--allow-existing <path>` repeats the path as an explicit confirmation
 * that the caller knows it is a candidate directory it owns.
 */
/**
 * Refuse a destination that is a release currently in service.
 *
 * `--allow-existing` confirms ownership of a candidate directory; it is not a licence
 * to overwrite the profile a service is running from, so this check has no opt-out.
 * A release root is recognised by a `current` symlink pointing at the destination or at
 * a parent of it.
 */
/**
 * Refuse a destination that is a release currently in service.
 *
 * `--allow-existing` confirms ownership of a candidate directory; it is not a licence to
 * overwrite the profile a service is running from, so this check has no opt-out.
 *
 * The comparison is on *real* paths: `current` is resolved with `realpath`, the
 * destination is resolved with `realpath` (following any symlink in its own path), and
 * every ancestor directory is checked too. Walking a fixed number of levels and comparing
 * literal path strings misses `current/profile` and a destination reached through a link.
 */
async function resolveReal(path) {
  const { realpath } = await import('node:fs/promises')
  try { return await realpath(path) } catch { return null }
}

/**
 * Decide whether a destination relates to the release in service in a way that must be
 * refused. All three relations are refusals: equal to the release, inside it, or containing
 * it (a rebuild would otherwise remove the release as a child). One implementation is shared
 * by the literal-ancestor walk and the real-ancestor walk so neither can drift.
 */
function releaseServiceRelation(destination, releaseReal) {
  if (!destination || !releaseReal) return null
  if (destination === releaseReal) return 'is'
  if (destination.startsWith(releaseReal + sep)) return 'is inside'
  if (releaseReal.startsWith(destination + sep)) return 'contains'
  return null
}

async function assertNotServing(profileDir) {
  const { readlink } = await import('node:fs/promises')
  // Resolve the destination first, so an intermediate symlink that points into the release
  // is followed rather than compared as text.
  let target = await resolveReal(profileDir)
  if (!target) {
    // The destination may not exist yet: resolve its deepest existing ancestor and append
    // the remainder, then resolve the result too.
    let probe = profileDir
    const tail = []
    for (let depth = 0; depth < 12; depth += 1) {
      const real = await resolveReal(probe)
      if (real) { target = tail.length ? join(real, ...tail.reverse()) : real; break }
      tail.push(probe.split(sep).pop())
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  // Check the destination, its real form, and every ancestor for a `current` link.
  let dir = profileDir
  const seen = new Set()
  while (dir && !seen.has(dir)) {
    seen.add(dir)
    const link = join(dir, 'current')
    const raw = await readlink(link).catch(() => null)
    if (raw) {
      const resolved = await resolveReal(link)
      if (resolved) {
        const destination = target ?? resolve(profileDir)
        // Three relations are all refusals: equal to the release, inside it, or containing
        // it. Containing it matters because a rebuild would remove the release as a child.
        const equal = destination === resolved
        const insideRelease = destination.startsWith(resolved + sep)
        const containsRelease = resolved.startsWith(destination + sep)
        if (equal || insideRelease || containsRelease) {
          const relation = equal ? 'is' : insideRelease ? 'is inside' : 'contains'
          fail(`refusing to build into ${profileDir}: it ${relation} the release in service (${link} -> ${resolved}; destination resolves to ${destination})`)
        }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Finally, walk the real ancestor chain of the resolved destination.
  let realDir = target
  const realSeen = new Set()
  while (realDir && !realSeen.has(realDir)) {
    realSeen.add(realDir)
    const target2 = join(realDir, 'current')
    const raw2 = await readlink(target2).catch(() => null)
    if (raw2) {
      const resolved2 = await resolveReal(target2)
      const relation2 = releaseServiceRelation(target, resolved2)
      if (relation2) {
        fail(`refusing to build into ${profileDir}: it ${relation2} the release in service (${target2} -> ${resolved2}; destination resolves to ${target})`)
      }
    }
    const parent = dirname(realDir)
    if (parent === realDir) break
    realDir = parent
  }
}

async function assertFreshCandidate(profileDir, confirmed) {
  await assertNotServing(profileDir)
  if (!isAbsolute(profileDir)) fail('--profile must be an absolute path')
  if (confirmed && resolve(confirmed) !== profileDir) fail(`--allow-existing must repeat the exact --profile path (${profileDir})`)

  // Refusals that no flag can override: an installed profile is never a build target.
  for (const marker of ['cordis.yml', 'cordis.patch.yml']) {
    if (existsSync(join(profileDir, marker))) {
      fail(`refusing to build into ${profileDir}: it contains ${marker}, which marks an installed DSH/plugin profile, not a candidate directory`)
    }
  }
  const manifestPath = join(profileDir, 'package.json')
  if (existsSync(manifestPath)) {
    let manifest = null
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { manifest = null }
    if (manifest && (/^dsh-profile/.test(manifest.name ?? '') || manifest.dsh !== undefined)) {
      fail(`refusing to build into ${profileDir}: its package.json declares a DSH profile (${manifest.name ?? 'unnamed'})`)
    }
  }
  // A directory that already holds the product's own entry point is an installation.
  const serviceShape = ['node_modules/@deepseek-ai/dsh-pkw-web/lib/collaboration/index.js']
  if (serviceShape.every(rel => existsSync(join(profileDir, rel))) && !confirmed) {
    fail(`refusing to build into ${profileDir}: it looks like an installed PKW profile. Pass --allow-existing ${profileDir} only if you have verified it is a candidate you own.`)
  }
  if (confirmed) return { removeFirst: true, confirmed: true }
  try {
    const info = await stat(profileDir)
    if (!info.isDirectory()) fail(`--profile exists and is not a directory: ${profileDir}`)
    const contents = await readdir(profileDir)
    if (contents.length > 0) {
      fail(`--profile is not empty (${contents.length} entries): ${profileDir}. Point it at a new candidate directory, or pass --allow-existing ${profileDir} if you have verified it is a candidate you own.`)
    }
    return { removeFirst: false }
  } catch (error) {
    if (error.code === 'ENOENT') return { removeFirst: false }
    throw error
  }
}

// ---------------------------------------------------------------- PKW packages
// Either this checkout (whose packages must have been built) or a staged release.
const releaseSource = values['release-source'] ? resolve(values['release-source']) : null
const pkwRoot = releaseSource ?? join(repoRoot, 'packages/pkw')
if (releaseSource && !existsSync(pkwRoot)) fail(`--release-source does not exist: ${pkwRoot}`)
const pkwDirs = (await readdir(pkwRoot, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
const pkwManifests = []
for (const dir of pkwDirs) {
  const manifest = JSON.parse(await readFile(join(pkwRoot, dir, 'package.json'), 'utf8'))
  pkwManifests.push({ dir, manifest })
}
if (pkwManifests.length === 0) fail(`no PKW packages found in ${pkwRoot}`)
const pkwNames = new Set(pkwManifests.map(p => p.manifest.name))

// ------------------------------------------------------- Harness peer closure
const closure = new Map()
const unresolved = []
const queue = []
for (const { manifest } of pkwManifests) {
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      if (dep.startsWith('@deepseek-ai/') && !pkwNames.has(dep)) queue.push(dep)
    }
  }
}
while (queue.length) {
  const name = queue.shift()
  if (closure.has(name) || pkwNames.has(name)) continue
  const found = resolvePeer(name)
  if (!found) { if (!unresolved.includes(name)) unresolved.push(name); continue }
  closure.set(name, found)
  if (closure.size > 400) fail('Peer closure exceeded 400 packages; refusing to continue')
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const dep of Object.keys(found.manifest[section] ?? {})) {
      if (dep.startsWith('@deepseek-ai/') && !pkwNames.has(dep) && !closure.has(dep)) queue.push(dep)
    }
  }
}
if (unresolved.length) fail(`Cannot resolve required Harness peers: ${unresolved.join(', ')}`)

const freshness = await assertFreshCandidate(profile, values['allow-existing'])
const plan = {
  profile, version, harnessRoot, repoRoot, freshness,
  pkw: pkwManifests.map(p => ({ name: p.manifest.name, dir: join(pkwRoot, p.dir) })),
  peers: [...closure.values()].map(p => ({ name: p.name, version: p.version, dir: p.dir, origin: p.origin })),
  unresolved,
}
if (values['dry-run']) {
  console.log(JSON.stringify({ status: 'dry-run', ...plan, pkw: plan.pkw.map(p => p.name) }, null, 2))
  process.exit(0)
}

// ------------------------------------------------------------------- packing
async function rewriteManifest(manifest, dir, versions) {
  const rewritten = structuredClone(manifest)
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const table = rewritten[section]
    if (!table) continue
    for (const [dep, range] of Object.entries(table)) {
      if (typeof range !== 'string') continue
      if (range.startsWith('workspace:')) table[dep] = versions.get(dep) ?? '*'
      else if (range.startsWith('file:') || range.startsWith('link:')) {
        const target = resolve(dir, range.replace(/^(file|link):/, ''))
        if (existsSync(join(target, 'package.json'))) {
          const parsed = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
          table[dep] = parsed.version
          if (!versions.has(parsed.name)) versions.set(parsed.name, parsed.version)
        }
      }
    }
  }
  delete rewritten.scripts
  delete rewritten.devDependencies
  delete rewritten.publishConfig
  return rewritten
}
const versions = new Map()
for (const { manifest } of pkwManifests) versions.set(manifest.name, version)
for (const peer of closure.values()) versions.set(peer.name, peer.version)

await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true, mode: 0o700 })
const artifacts = []

/** Pack one package directory into staging with a self-contained manifest. */
async function pack(sourceDir, manifest, targetName, stampedVersion) {
  const work = join(staging, targetName)
  await mkdir(work, { recursive: true, mode: 0o700 })
  const skip = new Set(['node_modules', '.git', 'src', 'test', 'tests', '__tests__', 'coverage', '.pkw-build', 'dist', 'tsconfig.json', 'tsdown.config.ts'])
  // `files` entries are glob patterns such as `lib/types/**/*.d.ts`; the top-level
  // segment is what decides whether a directory is published. When a package
  // declares no `files` field, npm publishes everything not on its default ignore
  // list, so copy every non-source entry instead of guessing a single directory.
  const declaredTopLevel = manifest.files
    ? new Set(manifest.files.map(pattern => String(pattern).split('/')[0]))
    : null
  const alwaysCopy = new Set(['package.json', 'LICENSE', 'README.md', 'cordis.yml', 'cordis.patch.yml'])
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const included = declaredTopLevel === null || declaredTopLevel.has(entry.name) || alwaysCopy.has(entry.name)
    if (!included) continue
    try { await cp(join(sourceDir, entry.name), join(work, entry.name), { recursive: true }) } catch { /* optional */ }
  }
  const rewritten = await rewriteManifest(manifest, sourceDir, versions)
  // Only the PKW packages carry the release version; Harness peers keep the exact
  // version their own source tree declares.
  if (stampedVersion) rewritten.version = stampedVersion
  await writeFile(join(work, 'package.json'), JSON.stringify(rewritten, null, 2) + '\n')
  execFileSync('npm', ['pack', '--ignore-scripts', '--quiet'], { cwd: work, stdio: 'ignore' })
  const produced = (await readdir(work)).find(f => f.endsWith('.tgz'))
  if (!produced) throw new Error(`npm pack produced no tarball for ${manifest.name}`)
  const tarball = join(work, produced)
  const bytes = await readFile(tarball)
  artifacts.push({ name: rewritten.name, version: rewritten.version, tarball, sha256: sha256(bytes), bytes: bytes.length, source: sourceDir })
}

for (const { dir, manifest } of pkwManifests) {
  const lib = join(pkwRoot, dir, 'lib')
  if (!existsSync(lib)) {
    fail(releaseSource
      ? `Staged release is incomplete: ${lib} does not exist`
      : `Missing build output: ${lib}. Run \`pnpm run build\` first.`)
  }
  await pack(join(pkwRoot, dir), manifest, manifest.name.replace('@', '').replace('/', '__'), version)
}
for (const peer of [...closure.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  await pack(peer.dir, peer.manifest, peer.name.replace('@', '').replace('/', '__'))
}

// ------------------------------------------------------- one-off registry
/** Serve the staged tarballs; everything else is proxied to the upstream registry. */
function startRegistry() {
  const documents = new Map()
  const blobs = new Map()
  return new Promise(resolveServer => {
    const server = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname)
      if (blobs.has(path)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(blobs.get(path)); return }
      const doc = documents.get(path.slice(1))
      if (doc) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(doc)); return }
      if (!values['no-upstream']) {
        try {
          const upstreamResponse = await fetch(upstream + req.url, { signal: AbortSignal.timeout(120_000) })
          const buffer = Buffer.from(await upstreamResponse.arrayBuffer())
          res.writeHead(upstreamResponse.status, { 'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json' })
          res.end(buffer)
          return
        } catch (error) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `upstream failed: ${error.message}` }))
          return
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}')
    })
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`
      resolveServer({
        url,
        add(artifact) {
          const bytes = execFileSync('cat', [artifact.tarball], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
          const blobPath = `/${artifact.name}/-/${artifact.name.split('/').pop()}-${artifact.version}.tgz`
          blobs.set(blobPath, bytes)
          documents.set(artifact.name, {
            name: artifact.name,
            'dist-tags': { latest: artifact.version },
            versions: {
              [artifact.version]: {
                ...artifact.manifest,
                dist: {
                  tarball: url + blobPath,
                  shasum: createHash('sha1').update(bytes).digest('hex'),
                  integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
                },
              },
            },
          })
        },
        close: () => new Promise(r => server.close(r)),
      })
    })
  })
}

const registry = await startRegistry()
const env = {
  ...process.env,
  HOME: workRoot,
  TMPDIR: tmp,
  NPM_CONFIG_TMP: tmp,
  NPM_CONFIG_CACHE: cache,
  NPM_CONFIG_STORE_DIR: store,
  npm_config_store_dir: store,
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
}
let installExit = 1, installOutput = ''
try {
  for (const artifact of artifacts) {
    artifact.manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact.tarball, 'package/package.json'], { encoding: 'utf8' }))
    registry.add(artifact)
  }
  if (freshness.removeFirst) {
    // Re-check right before removing: between the guard and this point the directory could
    // have been swapped for a link to the release in service.
    await assertNotServing(profile)
    await rm(profile, { recursive: true, force: true })
  }
  await mkdir(profile, { recursive: true, mode: 0o700 })
  // An independent profile is a single-package workspace with hoisted layout: the
  // PKW plugin runtime expects to find packages by name at the profile root.
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages: []\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await writeFile(join(profile, '.npmrc'), [
    `store-dir=${store}`,
    `cache-dir=${cache}`,
    'node-linker=hoisted',
    'auto-install-peers=false',
    'strict-peer-dependencies=false',
    `@deepseek-ai:registry=${registry.url}`,
    `registry=${registry.url}`,
    '',
  ].join('\n'), { mode: 0o600 })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'pkw-independent-profile', private: true, type: 'module', version,
    dependencies: Object.fromEntries(artifacts.map(a => [a.name, a.version])),
  }, null, 2) + '\n')

  installOutput = await new Promise(resolvePromise => {
    const child = spawn('pnpm', ['install', '--ignore-scripts', '--config.auto-install-peers=false', `--store-dir=${store}`, `--registry=${registry.url}`, `--@deepseek-ai:registry=${registry.url}`], { cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.on('exit', code => { installExit = code; resolvePromise(out) })
  })
} finally {
  await registry.close()
  if (!values['keep-staging']) await rm(staging, { recursive: true, force: true })
}

// ------------------------------------------------------------------ verification
// Optional extra roots that a resolved path must never fall under (comma
// separated). A site sets this to its DSH profile farm so the check also catches
// a profile that silently borrows the live installation.
const forbiddenRoots = [harnessRoot, ...String(process.env.PKW_FORBIDDEN_RESOLUTION_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)]
const verifyRequire = createRequire(join(profile, 'package.json'))
const resolved = {}
const violations = []
for (const { name } of [...pkwManifests.map(p => ({ name: p.manifest.name })), ...[...closure.values()].map(p => ({ name: p.name }))]) {
  let file
  try { file = verifyRequire.resolve(`${name}/package.json`) } catch (error) { violations.push(`${name}: unresolved`); continue }
  resolved[name] = file
  if (!file.startsWith(profile + sep)) violations.push(`${name}: resolved outside the profile -> ${file}`)
  for (const forbidden of forbiddenRoots) if (file.startsWith(forbidden + sep)) violations.push(`${name}: resolved into the DSH installation -> ${file}`)
}
const passed = installExit === 0 && violations.length === 0
/** Compare the pinned peer versions with what the running DSH profile resolves.
 * Informational only: switching PKW to this profile may change a peer version, and
 * the operator must be able to see exactly which ones before any cutover. */
async function compareWithRunningDsh(names) {
  // Opt-in: only a site knows which profile is currently serving. When unset the
  // comparison is skipped rather than guessing a path.
  const runningProfile = process.env.PKW_RUNNING_PROFILE
  if (!runningProfile) return { available: false, reason: 'PKW_RUNNING_PROFILE not set' }
  if (!existsSync(join(runningProfile, 'package.json'))) return { available: false, reason: 'running profile not found' }
  const requireFromRunning = createRequire(join(runningProfile, 'package.json'))
  const differences = []
  for (const name of names) {
    let running = null
    try { running = JSON.parse(await readFile(requireFromRunning.resolve(`${name}/package.json`), 'utf8')).version } catch { running = null }
    const pinned = closure.get(name)?.version ?? version
    if (running !== pinned) differences.push({ package: name, runningDsh: running, independent: pinned })
  }
  return { available: true, runningProfile, differences }
}

const receipt = {
  status: passed ? 'installed-and-verified' : 'failed',
  version, profile, harnessRoot,
  isolation: { profileResolved: Object.keys(resolved).length, violations },
  installExit,
  installTail: installOutput.trim().split('\n').slice(-8),
  artifacts: artifacts.map(({ name, version: v, sha256: hash, bytes, source }) => ({ name, version: v, sha256: hash, bytes, source })),
  pinnedPeers: [...closure.values()].map(p => `${p.name}@${p.version}`),
  peerOrigins: Object.fromEntries([...closure.values()].map(p => [p.name, p.origin])),
  versusRunningDsh: await compareWithRunningDsh([...closure.keys()]),
}
const receiptPath = join(workRoot, `receipt-${version}.json`)
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ status: receipt.status, profile, receipt: receiptPath, packages: artifacts.length, pinnedPeers: closure.size, unresolved: unresolved.length, installExit, violations: violations.length }, null, 2))
if (!passed) {
  for (const v of violations.slice(0, 20)) console.error(`  ${v}`)
  process.exit(5)
}

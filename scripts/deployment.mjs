import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const profileFiles = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', '.npmrc', 'node_modules']
export const sha256 = data => createHash('sha256').update(data).digest('hex')
export const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'))
export async function exists(path) { try { await access(path); return true } catch { return false } }

export function run(command, args, cwd = repoRoot) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) { resolvePromise(); return }
      const error = new Error(signal ? `${command} was terminated by ${signal}` : `${command} exited ${code}`)
      error.code = signal ? 'PKW_COMMAND_INTERRUPTED' : 'PKW_COMMAND_FAILED'
      error.exitCode = code
      error.signal = signal
      reject(error)
    })
  })
}

export function validateRegistry(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('PKW publishing requires a loopback registry without credentials in its URL')
  }
  return url.href.replace(/\/$/, '')
}

export function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version ?? '')) {
    throw new Error('Provide a fresh immutable --version (for example 0.1.1-pkw.1)')
  }
  return version
}

export async function packageList() {
  const root = join(repoRoot, 'packages/pkw')
  const names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()
  return Promise.all(names.map(async name => ({ dir: join(root, name), manifest: await jsonFile(join(root, name, 'package.json')) })))
}

/** Produce an immutable release outside the checkout; workspace ranges are pinned. */
export async function stagePackages(root, version, registry, execute = run) {
  const packages = await packageList()
  const artifacts = []
  for (const pkg of packages) {
    const dir = join(root, pkg.manifest.name.split('/')[1])
    await mkdir(dir, { recursive: true })
    const manifest = structuredClone(pkg.manifest)
    manifest.version = version
    delete manifest.scripts
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (range.startsWith('workspace:')) manifest.dependencies[name] = version
    }
    for (const filename of manifest.files) {
      await cp(join(pkg.dir, filename), join(dir, filename), { recursive: true })
    }
    await cp(join(repoRoot, 'LICENSE'), join(dir, 'LICENSE'))
    manifest.license = 'Apache-2.0'
    await writeFile(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    // Force only the approved loopback registry for this scope, even if the
    // machine has a different scope configured in the user's npmrc.
    await writeFile(join(dir, '.npmrc'), `@deepseek-ai:registry=${registry}\n`, { mode: 0o600 })
    await execute('npm', ['pack', '--ignore-scripts', '--quiet'], dir)
    const tarballs = (await readdir(dir)).filter(name => name.endsWith('.tgz'))
    if (tarballs.length !== 1) throw new Error(`Expected one packed artifact for ${manifest.name}`)
    const tarball = join(dir, tarballs[0])
    artifacts.push({ name: manifest.name, version, dir, tarball, sha256: sha256(await readFile(tarball)) })
  }
  return artifacts
}

/** A changed production UI cannot be overwritten without an exact-hash review. */
export async function checkUiReview(profile, reviewPath) {
  const installed = join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/ui.js')
  if (!await exists(installed)) throw new Error('Existing profile PKW ui.js is required; this command upgrades an installed profile')
  const productionSha256 = sha256(await readFile(installed))
  const builtSha256 = sha256(await readFile(join(repoRoot, 'packages/pkw/web/lib/ui.js')))
  if (productionSha256 === builtSha256) return { productionSha256, builtSha256, identical: true }
  if (!reviewPath) throw new Error('Production ui.js differs: supply --ui-review after auditing its manual patches (P0-3)')
  const review = await jsonFile(reviewPath)
  const sourceSha256 = sha256(await readFile(join(repoRoot, 'packages/pkw/web/src/ui.ts')))
  if (review.productionSha256 !== productionSha256 || review.sourceSha256 !== sourceSha256 || !Array.isArray(review.changes) || !review.changes.length || review.changes.some(c => typeof c !== 'string' || !c.trim())) {
    throw new Error('UI review must bind the current production/source hashes and enumerate reviewed changes')
  }
  return { productionSha256, builtSha256, sourceSha256, changes: review.changes }
}

/** Snapshot only the package installation, never canonical workspaces or DBs. */
export async function snapshotProfile(profile, backup) {
  await mkdir(backup, { recursive: true, mode: 0o700 })
  for (const name of profileFiles) {
    const source = join(profile, name)
    if (await exists(source)) await cp(source, join(backup, name), { recursive: true, verbatimSymlinks: true })
  }
}

export async function restoreProfile(profile, backup) {
  for (const name of profileFiles) {
    await rm(join(profile, name), { recursive: true, force: true })
    if (await exists(join(backup, name))) await cp(join(backup, name), join(profile, name), { recursive: true, verbatimSymlinks: true })
  }
}

/** Record the exact installed host entry artifacts; do not upgrade Harness peers. */
export async function hostFingerprint(profile) {
  const names = new Set((await packageList()).flatMap(p => Object.keys(p.manifest.peerDependencies ?? {})))
  const require = createRequire(join(profile, 'package.json'))
  const result = {}
  for (const name of [...names].sort()) {
    const entry = require.resolve(name)
    result[name] = sha256(await readFile(entry))
  }
  return result
}

/** A login page, SPA fallback, or HTTP 200 with ok:false is not acceptance. */
export async function verifyHttp(baseUrl, attempts = 15, expectedVersion) {
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('--url must be an HTTP(S) origin without credentials, query or path')
  }
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      const page = await fetch(new URL('/pkw', base), { redirect: 'error', signal: AbortSignal.timeout(5000) })
      if (!page.ok) throw new Error(`/pkw returned HTTP ${page.status}`)
      if (!(await page.text()).includes('<title>PKW — Personal Knowledge Workspace</title>')) throw new Error('/pkw did not return the PKW page')
      if (expectedVersion && page.headers.get('x-pkw-version') !== expectedVersion) throw new Error('/pkw is not serving the installed release; restart may not have completed')
      const response = await fetch(new URL('/pkw/api', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'summary', args: {} }), redirect: 'error', signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`/pkw/api summary returned HTTP ${response.status}`)
      const rpc = await response.json()
      if (rpc.ok !== true || typeof rpc.value?.workspaceId !== 'string' || !rpc.value.workspaceId || !Number.isInteger(rpc.value.notes) || !Number.isInteger(rpc.value.attachments)) {
        throw new Error('/pkw/api summary failed its business contract')
      }
      return { page: 'passed', summaryRpc: 'passed', servingVersion: page.headers.get('x-pkw-version'), verifiedAt: new Date().toISOString() }
    } catch (error) { lastError = error }
    if (i + 1 < attempts) await delay(1000)
  }
  throw new Error('PKW post-restart verification failed', { cause: lastError })
}

export async function validateHook(path, name) {
  if (!path || !isAbsolute(path)) throw new Error(`${name} must name an absolute executable hook (no shell command strings)`)
  await access(path, 1)
  return resolve(path)
}

/** Bounded cause tree for private receipts; never serialize commands, bodies or stacks. */
export function deploymentErrorDetails(error, seen = new Set(), depth = 0) {
  if (depth > 5 || seen.has(error)) return { name: 'TruncatedError' }
  seen.add(error)
  const message = String(error?.message ?? error)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:["']?)(?:password|token|api[_-]?key|secret|cookie|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1[redacted]')
    .slice(0, 2000)
  const result = { name: error?.name ?? 'Error', message }
  if (/^[A-Z][A-Z0-9_]{0,80}$/.test(error?.code ?? '')) result.code = error.code
  if (error?.recovery) result.recovery = {
    phase: ['stop', 'restore', 'start', 'verify', 'complete'].includes(error.recovery.phase) ? error.recovery.phase : 'unknown',
    profileRestored: error.recovery.profileRestored === true,
    serviceRestarted: error.recovery.serviceRestarted === true,
    verified: error.recovery.verified === true,
  }
  if (error?.cause !== undefined) result.cause = deploymentErrorDetails(error.cause, seen, depth + 1)
  if (error instanceof AggregateError) result.errors = [...error.errors].slice(0, 8).map(e => deploymentErrorDetails(e, seen, depth + 1))
  return result
}

/**
 * Fingerprint the *content* of the packages a release install replaces.
 *
 * `package.json` and the lockfile are deliberately not part of this: an install is
 * supposed to rewrite them, so including them would make every legitimate install
 * look like external drift. What must not change behind the deployment's back is the
 * package content itself, which is what this hashes.
 */
export async function profileInputDigest(profile, packageNames) {
  const names = packageNames ?? (await readdir(join(profile, 'node_modules/@deepseek-ai')).catch(() => [])).filter(n => n.startsWith('dsh-pkw-'))
  const parts = []
  for (const name of [...names].sort()) {
    const dir = join(profile, 'node_modules/@deepseek-ai', name)
    const files = []
    async function walk(current, base) {
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) await walk(full, base)
        else if (entry.isFile()) files.push(`${full.slice(base.length + 1)}:${sha256(await readFile(full))}`)
      }
    }
    await walk(dir, dir)
    if (files.length === 0) { parts.push(`${name}:absent`); continue }
    parts.push(`${name}:${sha256(files.sort().join('\n'))}`)
  }
  return sha256(parts.join('\n'))
}

/**
 * Install the release into the profile *without* stopping the service first.
 *
 * Rationale: stopping the service and only then discovering that the profile
 * cannot be installed leaves a stopped service and no rollback material. Doing the
 * install first keeps the previous release serving for the whole preparation
 * phase; a failure here is reported and nothing is stopped.
 *
 * The result is adopted by `activate()` only if the profile inputs are unchanged
 * between preparation and adoption, so the snapshot still captures a comparable
 * state and a concurrent writer cannot slip an unnoticed change past the check.
 */
export async function prepareInstall({ profile, artifacts, registry, storeDir, packageNames, allowFreshRelease = false }, execute = run) {
  const before = await profileInputDigest(profile, packageNames)
  const args = ['add', '--save-exact', '--ignore-scripts', '--config.auto-install-peers=false', `--registry=${registry}`, `--@deepseek-ai:registry=${registry}`]
  if (storeDir) args.push(`--store-dir=${storeDir}`)
  // A fresh release is newer than any release-age policy can satisfy. A site that
  // enforces such a policy opts out explicitly for the release it is deploying,
  // rather than the deployment quietly ignoring the policy for everything.
  if (allowFreshRelease) args.push('--config.minimum-release-age=0')
  args.push(...artifacts.map(p => `${p.name}@${p.version}`))
  await execute('pnpm', args, profile)
  await execute(process.execPath, [join(repoRoot, 'scripts/check-runtime-imports.mjs'), '--profile', profile, '--version', artifacts[0].version], profile)
  // Sampled AFTER the install: the install is expected to change the packages, and
  // what adoption has to detect is a change made *since* this point.
  const preparedDigest = await profileInputDigest(profile, packageNames)
  return { inputDigest: before, preparedDigest, installedAt: new Date().toISOString() }
}

/** Rollback installation on failure, and do not report success if recovery fails.
 * A custom verifier must enforce the deployment's real page/business contract
 * for BOTH activation and rollback; the default remains the strict HTTP probe.
 *
 * options.prepared, when present, is the result of `prepareInstall()`: the install
 * has already happened with the service still up, so this call snapshots the
 * restored profile first and then only switches.
 */
export async function activate({ profile, backup, artifacts, registry, stop, start, url, beforeHost, prepared, verify: configuredVerify }, execute = run, verify = configuredVerify === undefined ? verifyHttp : configuredVerify) {
  // Existing deployment adapters supply options.verify. Never silently ignore
  // their authenticated probe or choose between two different verifiers.
  if (configuredVerify !== undefined && verify !== configuredVerify) throw new TypeError('Conflicting deployment verifiers: use options.verify or the third argument')
  if (typeof verify !== 'function') throw new TypeError('Deployment verifier must be a function')
  let snapshotted = false
  try {
    await execute(stop, [], profile)
    await snapshotProfile(profile, backup)
    snapshotted = true
    if (prepared) {
      // The install ran while the service was still serving. If the package content
      // changed after that point, something wrote the profile behind our back, and
      // adopting it would snapshot an unknown state.
      const now = await profileInputDigest(profile, prepared.packageNames)
      const expected = prepared.preparedDigest ?? prepared.inputDigest
      if (now !== expected) throw new Error('Package content changed between preparation and adoption; refusing to adopt an unknown snapshot')
    } else {
      await execute('pnpm', ['add', '--save-exact', '--ignore-scripts', '--config.auto-install-peers=false', `--registry=${registry}`, `--@deepseek-ai:registry=${registry}`, ...artifacts.map(p => `${p.name}@${p.version}`)], profile)
    }
    const afterHost = await hostFingerprint(profile)
    if (JSON.stringify(beforeHost) !== JSON.stringify(afterHost)) throw new Error('Harness peer entries changed during profile install')
    if (!prepared) await execute(process.execPath, [join(repoRoot, 'scripts/check-runtime-imports.mjs'), '--profile', profile, '--version', artifacts[0].version], profile)
    await execute(start, [], profile)
    return await verify(url, 15, artifacts[0].version)
  } catch (error) {
    const recovery = { phase: 'stop', profileRestored: false, serviceRestarted: false, verified: false }
    try {
      if (snapshotted) {
        await execute(stop, [], profile)
        recovery.phase = 'restore'
        await restoreProfile(profile, backup)
        recovery.profileRestored = true
      }
      recovery.phase = 'start'
      await execute(start, [], profile)
      recovery.serviceRestarted = true
      recovery.phase = 'verify'
      await verify(url)
      recovery.verified = true
      recovery.phase = 'complete'
    } catch (rollbackError) {
      const failure = new AggregateError([error, rollbackError], `Deployment failed; rollback ${recovery.phase} failed; backup: ${backup}`)
      failure.code = 'PKW_ROLLBACK_FAILED'
      failure.recovery = recovery
      throw failure
    }
    const failure = new Error(`Deployment failed; ${snapshotted ? 'prior profile restored and verified' : 'prior service restarted and verified (snapshot not completed)'}. Backup: ${backup}`, { cause: error })
    failure.code = 'PKW_DEPLOYMENT_ROLLED_BACK'
    failure.recovery = recovery
    throw failure
  }
}

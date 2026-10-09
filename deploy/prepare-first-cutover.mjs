#!/usr/bin/env node
/** Prepare immutable independent runtime files only. Never activate, open data, or manage services. */
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, statfs, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { packageList } from '../scripts/deployment.mjs'
import { readReleaseArtifacts, verifyArtifactPayload } from './site/rehearsal-artifacts.mjs'
import { createArtifactRunner } from './site/rehearsal-reference.mjs'
import { runOwned, requireCommand } from './rehearse-matrix.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '0.1.9-pkw.1'
const STARTUP_FILES = ['scripts/serve-collaboration.mjs', 'scripts/listener-startup.mjs', 'scripts/root-lock.mjs']
const MAX_FILE = 128 * 1024 * 1024
const protectedRoots = ['/root/.dsh', '/opt/deepseek-harness', '/opt/dsh-releases', '/etc/systemd/system', '/root/pkw-upgrade-2026-10-02', '/LlHmm9527/pkw-delivery-v3']
const inside = (root, value) => value === root || value.startsWith(root + sep)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `PKW_PREPARE_${code}` }) }
const identity = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].map(String)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('PATH', `${label} must be absolute`)
  const path = resolve(value), s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path) fail('PATH', `${label} must be a canonical directory`)
  return path
}

async function regularFile(path, limit = MAX_FILE) {
  if (await realpath(path) !== resolve(path)) fail('PATH', 'Regular file traverses a symbolic link')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(limit)) fail('FILE', 'Expected a bounded regular file')
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true })
    if (bytes.length !== Number(before.size) || !same(identity(before), identity(after))) fail('DRIFT', 'File changed during inspection')
    return { bytes, info: before }
  } finally { await handle.close() }
}

async function readJson(path) {
  if (await realpath(path) !== path) fail('PATH', 'Evidence must not traverse a symbolic link')
  const { bytes } = await regularFile(path, 16 * 1024 * 1024)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('EVIDENCE', 'Evidence is not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('EVIDENCE', 'Evidence must be an object')
  return { value, sha256: digest(bytes) }
}

/** Fingerprints include bytes, modes and equivalent internal link destinations; never follow directories through links. */
export async function snapshotTree(root) {
  root = await canonicalDirectory(root, 'Profile tree')
  const entries = [], identities = []
  let bytes = 0
  async function walk(path) {
    if (entries.length >= 200000) fail('TREE', 'Profile has too many entries')
    const s = await lstat(path, { bigint: true }), name = relative(root, path), mode = Number(s.mode & 0o7777n)
    const item = { name, mode }
    if (s.isDirectory()) {
      if (await realpath(path) !== path) fail('PATH', 'Directory traverses a symbolic link')
      item.kind = 'directory'; entries.push(item)
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry))
      if (!same(identity(s), identity(await lstat(path, { bigint: true })))) fail('DRIFT', 'Directory changed during inspection')
    } else if (s.isFile()) {
      const value = await regularFile(path)
      if (!same(identity(s), identity(value.info))) fail('DRIFT', 'File identity changed during inspection')
      Object.assign(item, { kind: 'file', size: value.bytes.length, sha256: digest(value.bytes) })
      bytes += value.bytes.length; entries.push(item)
    } else if (s.isSymbolicLink()) {
      const rawTarget = await readlink(path), target = await realpath(path)
      if (!inside(root, target)) fail('LINK', 'Profile link escapes its source tree')
      Object.assign(item, { kind: 'symlink', target: relative(root, target) }); entries.push(item)
      identities.push({ name, rawTarget })
      if (!same(identity(s), identity(await lstat(path, { bigint: true })))) fail('DRIFT', 'Link changed during inspection')
    } else fail('TYPE', 'Profile contains a special file')
    identities.push({ name, identity: identity(s) })
  }
  await walk(root)
  return { entries, bytes, sha256: digest(JSON.stringify(entries)), identitySha256: digest(JSON.stringify(identities)) }
}

/** Exclusive byte copies, never hardlinks; links are rebased inside the independent destination. */
export async function copyProfileTree(source, target, before = undefined) {
  source = await canonicalDirectory(source, 'Source profile')
  before ??= await snapshotTree(source)
  await canonicalDirectory(dirname(target), 'Destination parent')
  await mkdir(target, { mode: 0o700 })
  for (const entry of before.entries) {
    if (entry.name === '') continue
    const from = join(source, entry.name), to = join(target, entry.name)
    if (!inside(source, from) || !inside(target, to)) fail('PATH', 'Profile member leaves its root')
    if (entry.kind === 'directory') await mkdir(to, { mode: 0o700 })
    else if (entry.kind === 'file') {
      const { bytes, info } = await regularFile(from)
      if (digest(bytes) !== entry.sha256 || bytes.length !== entry.size || Number(info.mode & 0o7777n) !== entry.mode) fail('DRIFT', 'Source file changed before copying')
      await writeFile(to, bytes, { flag: 'wx', mode: 0o600 }); await chmod(to, entry.mode)
    } else if (entry.kind === 'symlink') {
      const targetPath = join(target, entry.target)
      await symlink(relative(dirname(to), targetPath) || '.', to)
    } else fail('TYPE', 'Unknown profile entry type')
  }
  for (const entry of [...before.entries].reverse()) if (entry.kind === 'directory') await chmod(join(target, entry.name), entry.mode)
  const after = await snapshotTree(source), copied = await snapshotTree(target)
  if (before.sha256 !== after.sha256 || before.identitySha256 !== after.identitySha256) fail('DRIFT', 'Source profile changed while copying')
  if (before.sha256 !== copied.sha256) fail('COPY', 'Copied profile bytes, modes or links differ')
  return { source: after, copied }
}

function matrixEvidence(value, version, matrixRoot) {
  if (value.status !== 'three-rehearsals-verified' || value.version !== version || value.work !== matrixRoot) fail('EVIDENCE', 'Matrix is not a completed matching rehearsal')
  const kinds = ['positive', 'breakwrite', 'mode']
  if (!Array.isArray(value.cases) || value.cases.length !== kinds.length) fail('EVIDENCE', 'Matrix must contain exactly three verified cases')
  for (const [index, kind] of kinds.entries()) {
    const item = value.cases.find(entry => entry?.kind === kind), run = item?.execution
    if (!item || item.work !== join(matrixRoot, kind) || item.status !== 'verified' || item.ok !== true || item.cleanupConfirmed !== true || item.lifecycleOk !== true || item.cleanup?.ok !== true || item.cleanup?.confirmed !== true || item.cleanup?.error || !run || run.code !== (index === 0 ? 0 : 1) || run.signal !== null || run.error !== null || run.interrupted !== false || run.timedOut !== false || run.groupCleanup?.confirmed !== true) fail('EVIDENCE', `Matrix ${kind} evidence is not verified`)
  }
  return value.cases.find(item => item.kind === 'positive')
}

function compareArtifacts(evidence, artifacts) {
  if (!Array.isArray(evidence) || evidence.length !== artifacts.length) fail('ARTIFACT', 'Matrix artifact inventory differs from the release')
  const seen = new Set()
  for (const record of evidence) {
    const actual = artifacts.find(item => item.name === record?.name)
    if (!actual || seen.has(record.name) || ['name', 'version', 'sha256', 'bytes'].some(key => record[key] !== actual[key])) fail('ARTIFACT', 'Artifact does not match the passed matrix')
    seen.add(record.name)
  }
}

async function startupFingerprints(root) {
  const files = []
  for (const name of STARTUP_FILES) {
    const { bytes, info } = await regularFile(join(root, name))
    files.push({ name, bytes: bytes.length, sha256: digest(bytes), mode: Number(info.mode & 0o7777n) })
  }
  return files
}

function unitPath(path) {
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').includes('..')) fail('UNIT_PATH', 'Unsafe systemd draft path')
  return path
}

async function checkRuntimeDefault({ profile, work, node, signal }) {
  const env = { PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`, HOME: join(work, 'home'), LANG: 'C.UTF-8', TMPDIR: join(work, 'tmp'), XDG_CACHE_HOME: join(work, 'cache'), NODE_DISABLE_COMPILE_CACHE: '1' }
  const result = await runOwned(node, [join(repo, 'scripts/check-profile-selfcontained.mjs'), '--profile', profile, '--require-runtime-import', '--trace-imports'], { cwd: work, env, signal, timeoutMs: 120000, graceMs: 5000, log: join(work, 'logs/runtime-check.log'), label: 'prepared-profile-runtime' })
  requireCommand(result, 'Prepared profile runtime check')
  if (result.groupCleanup?.confirmed !== true) fail('RUNTIME', 'Runtime checker cleanup was not confirmed')
  return { ok: true, exitCode: result.code, cleanupConfirmed: true }
}

/** All injectable seams are library-only test seams; the CLI always uses production validators. */
export async function prepareFirstCutover({ workDir, matrixRoot, artifactDir, version = VERSION, checkout = repo, node = process.execPath, signal }, { checkRuntime = checkRuntimeDefault, createRunner = createArtifactRunner, expectedNames } = {}) {
  if (version !== VERSION) fail('VERSION', `Only reviewed candidate ${VERSION} is supported`)
  const sourceCheckout = await canonicalDirectory(checkout, 'Checkout')
  matrixRoot = await canonicalDirectory(matrixRoot, 'Matrix root')
  artifactDir = await canonicalDirectory(artifactDir, 'Artifacts')
  for (const source of [sourceCheckout, matrixRoot, artifactDir]) for (const root of protectedRoots) if (inside(root, source) || inside(source, root)) fail('OVERLAP', 'Preparation inputs overlap production paths')
  if (typeof workDir !== 'string' || !isAbsolute(workDir)) fail('PATH', 'Work directory must be absolute')
  const work = join(await canonicalDirectory(dirname(resolve(workDir)), 'Work parent'), basename(resolve(workDir)))
  for (const source of [sourceCheckout, matrixRoot, artifactDir, ...protectedRoots]) if (inside(source, work) || inside(work, source)) fail('OVERLAP', 'Work directory overlaps source or production paths')
  unitPath(work); unitPath(node)
  const evidencePath = join(matrixRoot, 'matrix-report.json'), evidence = await readJson(evidencePath)
  const positive = matrixEvidence(evidence.value, version, matrixRoot)
  const reference = evidence.value.reference
  if (reference?.runnerRoot !== join(matrixRoot, 'runner') || reference.basis !== 'verified-release-artifacts' || reference.version !== version) fail('RUNNER', 'Passed matrix runner reference is missing or inconsistent')
  const matrixRunner = await canonicalDirectory(reference.runnerRoot, 'Matrix runner')
  const startup = await startupFingerprints(sourceCheckout)
  if (!same(startup, await startupFingerprints(matrixRunner))) fail('RUNNER', 'Startup scripts differ from the passed matrix runner')
  const sourceProfile = await canonicalDirectory(join(positive.work, 'root/releases', version, 'profile'), 'Successful candidate profile')
  if (!inside(matrixRoot, sourceProfile)) fail('PATH', 'Candidate profile is outside the matrix')
  const names = expectedNames ?? (await packageList()).map(item => item.manifest.name)
  if ((!expectedNames && names.length !== 10) || !names.length || new Set(names).size !== names.length) fail('ARTIFACT', 'Release package identities must be complete and unique')
  const artifacts = await readReleaseArtifacts(artifactDir, version, names)
  compareArtifacts(evidence.value.artifacts?.new, artifacts)
  await verifyArtifactPayload(sourceProfile, artifacts)
  const before = await snapshotTree(sourceProfile)
  const filesystem = await statfs(dirname(work)), required = before.bytes * 2 + 512 * 1024 * 1024
  if (filesystem.bavail * filesystem.bsize < required) fail('SPACE', 'Insufficient data-disk space for preparation and reserve')
  await mkdir(work, { mode: 0o700 })
  const report = { status: 'PREPARING', work, version, artifactDir, checkout: sourceCheckout, nodeExecutable: node, servicesStarted: false, servicesChanged: false, dataAccessed: false, activated: false, currentCreated: false, productionAcceptance: 'not_run', sourceProfile, matrix: { path: evidencePath, sha256: evidence.sha256 }, space: { available: filesystem.bavail * filesystem.bsize, required }, actualPreviousVersion: '0.1.2-pkw.4', previousVersionCompatibility: 'not_verified_by_the_0.1.7_rehearsal' }
  const reportPath = join(work, 'preparation-report.json')
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  try {
    if (signal?.aborted) fail('INTERRUPTED', 'Preparation interrupted')
    for (const path of ['releases', `releases/${version}`, 'drafts', 'tmp', 'home', 'cache', 'logs']) await mkdir(join(work, path), { mode: 0o700 })
    const release = join(work, 'releases', version), profile = join(release, 'profile')
    const copied = await copyProfileTree(sourceProfile, profile, before)
    report.profile = { path: profile, bytes: copied.copied.bytes, sha256: copied.copied.sha256, entries: copied.copied.entries.length, sourceUnchanged: true, hardlinksCreated: false, installerMetadata: 'retained-from-rehearsal; future installs must use a new candidate', productionEnvironmentVerified: false }
    report.artifacts = artifacts.map(({ name, version, sha256, bytes }) => ({ name, version, sha256, bytes }))
    report.payload = await verifyArtifactPayload(profile, artifacts)
    if (signal?.aborted) fail('INTERRUPTED', 'Preparation interrupted before runner creation')
    const runnerRoot = join(release, 'runner')
    report.runner = await createRunner(sourceCheckout, runnerRoot, artifacts)
    if (!same(startup, await startupFingerprints(runnerRoot))) fail('RUNNER', 'Prepared startup scripts differ from reviewed inputs')
    const runnerBefore = await snapshotTree(runnerRoot)
    report.runner = { ...report.runner, startupFiles: startup, treeSha256: runnerBefore.sha256, bytes: runnerBefore.bytes }
    report.runtime = await checkRuntime({ profile, work, node, signal })
    if (report.runtime?.ok !== true) fail('RUNTIME', 'Prepared runtime was not verified')
    const runnerAfter = await snapshotTree(runnerRoot)
    if (runnerAfter.sha256 !== runnerBefore.sha256 || runnerAfter.identitySha256 !== runnerBefore.identitySha256 || !same(startup, await startupFingerprints(sourceCheckout)) || !same(startup, await startupFingerprints(matrixRunner))) fail('DRIFT', 'Startup inputs or prepared runner changed during preparation')
    const after = await snapshotTree(sourceProfile)
    if (after.sha256 !== before.sha256 || after.identitySha256 !== before.identitySha256) fail('DRIFT', 'Source profile changed during preparation')
    if ((await snapshotTree(profile)).sha256 !== copied.copied.sha256) fail('DRIFT', 'Prepared profile changed during runtime inspection')
    if ((await readJson(evidencePath)).sha256 !== evidence.sha256) fail('DRIFT', 'Matrix evidence changed during preparation')
    await verifyArtifactPayload(profile, artifacts)
    if (signal?.aborted) fail('INTERRUPTED', 'Preparation interrupted before draft creation')
    const current = unitPath(join(work, 'current')), config = '/root/pkw-upgrade-2026-10-02/config/collaboration.production.json'
    const draft = `[Service]\nWorkingDirectory=${current}/profile\nExecStart=\nExecStart=${node} ${current}/runner/scripts/serve-collaboration.mjs --profile ${current}/profile --config ${config} --port 3081 --drain-timeout-ms 25000\n`
    const draftPath = join(work, 'drafts/50-pkw-independent.conf')
    await writeFile(draftPath, draft, { flag: 'wx', mode: 0o600 })
    report.draft = { path: draftPath, sha256: digest(draft), installed: false, expectedUnitSha256: '4fdf72f6c4e12e27d736d0331fcdd9dcecbc86e58f158e74f9ab7b6bb270f6a1', rollback: 'Remove only this subsequently installed owned drop-in after stopping and confirming the candidate; preserve original unit, config, credentials and data. Actual previous-version compatibility remains unverified.' }
    if (signal?.aborted) fail('INTERRUPTED', 'Preparation interrupted before completion')
    report.status = 'PREPARED_NOT_ACTIVATED'
    await save()
    if (signal?.aborted) fail('INTERRUPTED', 'Preparation interrupted while recording completion')
    return report
  } catch (error) {
    report.status = 'PREPARATION_STOPPED'; report.error = { code: error.code ?? 'UNKNOWN', message: error.message }; report.sceneRetained = true
    await save(); throw Object.assign(error, { report, reportPath })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort()
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['work-dir', 'matrix-root', 'artifact-dir', 'version'].map(name => [name, { type: 'string' }])) })
    for (const name of ['work-dir', 'matrix-root', 'artifact-dir']) if (!values[name]) fail('USAGE', `Required --${name}`)
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || !values['work-dir'].startsWith('/LlHmm9527/')) fail('USAGE', 'Run as root on Linux using a new data-disk work directory')
    const report = await prepareFirstCutover({ workDir: values['work-dir'], matrixRoot: values['matrix-root'], artifactDir: values['artifact-dir'], version: values.version, signal: controller.signal })
    console.log(JSON.stringify(report))
  } catch (error) {
    console.log(JSON.stringify({ status: 'PREPARATION_STOPPED', code: error.code ?? 'UNKNOWN', message: error.message, evidence: error.reportPath ?? null, servicesStarted: false, servicesChanged: false, dataAccessed: false }))
    process.exitCode = 1
  } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop) }
}

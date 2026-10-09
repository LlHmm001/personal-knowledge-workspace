#!/usr/bin/env node
// Serial, isolated rehearsal of a real predecessor artifact set and three verdicts.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, open, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { packageList } from '../scripts/deployment.mjs'
import { startLoopbackRegistry } from './site/loopback-registry.mjs'
import { readReleaseArtifacts, verifyArtifactPayload } from './site/rehearsal-artifacts.mjs'
import { assertRehearsalVerdict } from './site/rehearsal-verdict.mjs'
import { createArtifactRunner } from './site/rehearsal-reference.mjs'
import { inspectPnpmStore, copyPnpmStore } from './site/rehearsal-store.mjs'
import { preparePackageManager } from './site/rehearsal-package-manager.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inside = (root, value) => value === root || value.startsWith(root + sep)
const emit = value => console.log(JSON.stringify(value))
const failure = (code, message) => Object.assign(new Error(message), { code })

/** Drain both streams, retain private logs, and bound the process group we created. */
export async function runOwned(command, args, { cwd, env, log, timeoutMs = 600_000, graceMs = 60_000, signal, onProgress = emit, label = 'command' }) {
  const output = await open(log, 'wx', 0o600)
  let child, timer, escalation, killTimer, detachTimer, beat, interrupted = false, exited = false, closed = false, settleDone
  let timedOut = false, interruptionReason = null
  const stopActions = []
  let code = null, terminationSignal = null, spawnError = null, tail = '', stdout = ''
  const started = Date.now()
  const stopGroup = sig => {
    if (!child?.pid) return
    const action = { scope: 'group', signal: sig, elapsedMs: Date.now() - started }
    stopActions.push(action)
    try { process.kill(-child.pid, sig); action.sent = true } catch (error) { action.error = error.code ?? 'UNKNOWN'; if (error.code !== 'ESRCH') spawnError ??= error }
  }
  const progress = () => onProgress({ phase: label, state: interrupted ? 'stopping' : 'running', running: !interrupted, timedOut, elapsedSeconds: Math.floor((Date.now() - started) / 1000) })
  const abort = (reason = 'signal') => {
    if (interrupted || closed) return
    interrupted = true
    interruptionReason = reason
    timedOut = reason === 'timeout'
    try { progress() } catch (error) { spawnError ??= error }
    if (!exited) {
      const action = { scope: 'child', signal: 'SIGTERM', elapsedMs: Date.now() - started }
      stopActions.push(action)
      try { action.sent = child?.kill('SIGTERM') ?? false } catch (error) { action.error = error.code ?? 'UNKNOWN'; spawnError ??= error }
    }
    escalation = setTimeout(() => {
      stopGroup('SIGTERM')
      killTimer = setTimeout(() => {
        stopGroup('SIGKILL')
        detachTimer = setTimeout(() => {
          if (closed) return
          spawnError ??= failure('PKW_MATRIX_CLEANUP_UNKNOWN', 'Owned process group did not close after SIGKILL')
          child.unref(); child.stdout.destroy(); child.stderr.destroy(); settleDone()
        }, 5000)
      }, 5000)
    }, graceMs)
  }
  const abortFromSignal = () => abort('signal')
  try {
    if (signal?.aborted) throw failure('PKW_MATRIX_INTERRUPTED', 'Interrupted before starting a command')
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const done = new Promise(resolveDone => {
      settleDone = resolveDone
      child.once('error', error => { spawnError = error })
      child.once('exit', (status, sig) => { exited = true; code = status; terminationSignal = sig })
      child.once('close', () => { closed = true; resolveDone() })
    })
    // Synchronous writes are bounded by each delivered pipe chunk; no unbounded log queue.
    const { writeSync } = await import('node:fs')
    const capture = (chunk, isStdout = false) => {
      try { for (let offset = 0; offset < chunk.length;) offset += writeSync(output.fd, chunk, offset) } catch (error) { spawnError ??= error; abort('capture-error') }
      tail = (tail + chunk.toString()).slice(-65536)
      if (isStdout) stdout = (stdout + chunk.toString()).slice(-65536)
    }
    child.stdout.on('data', chunk => capture(chunk, true)); child.stderr.on('data', chunk => capture(chunk))
    signal?.addEventListener('abort', abortFromSignal, { once: true })
    if (signal?.aborted) abortFromSignal()
    timer = setTimeout(() => abort('timeout'), timeoutMs)
    beat = setInterval(() => { try { progress() } catch (error) { spawnError ??= error; abort('progress-error') } }, 10_000)
    await done
    clearTimeout(escalation); clearTimeout(killTimer); clearTimeout(detachTimer)
    let groupState
    const groupPresent = () => {
      if (!child.pid) { groupState = { known: true, present: false }; return false }
      try { process.kill(-child.pid, 0); groupState = { known: true, present: true }; return true } catch (error) {
        if (error.code === 'ESRCH') { groupState = { known: true, present: false }; return false }
        groupState = { known: false, present: null, error: error.code ?? 'UNKNOWN' }
        spawnError ??= error; return true
      }
    }
    if (groupPresent()) {
      spawnError ??= failure('PKW_MATRIX_DESCENDANTS', 'The command left members in its owned process group')
      stopGroup('SIGTERM')
      for (let i = 0; i < 20 && groupPresent(); i++) await new Promise(done => setTimeout(done, 50))
      if (groupPresent()) {
        stopGroup('SIGKILL')
        for (let i = 0; i < 100 && groupPresent(); i++) await new Promise(done => setTimeout(done, 50))
      }
    }
    groupPresent()
    return { code, signal: terminationSignal, error: spawnError ? (spawnError.code ?? 'PKW_MATRIX_PROCESS_ERROR') : null,
      interrupted, timedOut, interruptionReason, stopActions, elapsedMs: Date.now() - started, timeoutMs,
      groupCleanup: { ...groupState, closed, confirmed: closed && groupState.known && groupState.present === false },
      tail, stdout, pid: child.pid ?? null }
  } finally {
    clearTimeout(timer); clearTimeout(escalation); clearTimeout(killTimer); clearTimeout(detachTimer); clearInterval(beat)
    signal?.removeEventListener('abort', abortFromSignal)
    await output.close()
  }
}

/** Keep process evidence without copying stdout, which may contain private credentials. */
export function caseExecutionEvidence(kind, work, result) {
  const { code, signal, error, interrupted, timedOut, interruptionReason, stopActions, elapsedMs, timeoutMs, groupCleanup, pid } = result
  return { kind, work, status: 'unverified', execution: { code, signal, error, interrupted, timedOut, interruptionReason, stopActions, elapsedMs, timeoutMs, groupCleanup, pid } }
}

/** A deadline is not cleanup failure when both process and listener absence were confirmed. */
export function assertCaseExecution(entry) {
  const result = entry.execution
  if (result.groupCleanup?.confirmed !== true || ['PKW_MATRIX_DESCENDANTS', 'PKW_MATRIX_CLEANUP_UNKNOWN'].includes(result.error)) {
    throw failure('PKW_MATRIX_CLEANUP', `${entry.kind}: owned process-group cleanup was not cleanly confirmed; scene retained`)
  }
  if (entry.reportError) throw failure('PKW_MATRIX_REPORT', `${entry.kind}: rehearsal report could not be read; execution evidence and scene retained`)
  if (entry.lifecycleOk !== true || entry.cleanup?.ok !== true || entry.cleanup?.confirmed !== true || entry.cleanup?.error) {
    throw failure('PKW_MATRIX_CLEANUP', `${entry.kind}: owned listener cleanup was not confirmed; scene retained`)
  }
  if (result.timedOut) throw failure('PKW_MATRIX_TIMEOUT', `${entry.kind}: rehearsal exceeded its execution deadline; owned-child cleanup confirmed and scene retained`)
  if (result.signal || result.error || result.interrupted) throw failure('PKW_MATRIX_EXECUTION', `${entry.kind}: rehearsal execution failed; owned-child cleanup confirmed and scene retained`)
}

export function requireCommand(result, label) {
  if (result.code !== 0 || result.signal !== null || result.error || result.interrupted) {
    throw failure('PKW_MATRIX_COMMAND_FAILED', `${label} failed (exit=${result.code}, signal=${result.signal}, error=${result.error}, interrupted=${result.interrupted}); see its private log`)
  }
}

const freePort = () => new Promise((done, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : done(port)) })
})

export async function treeBytes(root, { rejectLinks = false } = {}) {
  let bytes = 0
  async function walk(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      if (rejectLinks) throw failure('PKW_MATRIX_STORE_LINK', `Private cache sources cannot contain symbolic links: ${path}`)
      if (!inside(root, await realpath(path))) throw failure('PKW_MATRIX_SOURCE_LINK', `Source link escapes its root: ${path}`)
    } else if (info.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name))
    } else if (info.isFile()) bytes += info.size
    else throw failure('PKW_MATRIX_SOURCE_TYPE', `Unsupported source entry: ${path}`)
  }
  await walk(root)
  return bytes
}

export async function runMatrix(values, { signal } = {}) {
  const requestedWork = resolve(values['work-dir'])
  const work = join(await realpath(dirname(requestedWork)), basename(requestedWork))
  const paths = {}
  for (const key of ['profile-source', 'data-source', 'old-artifact-dir', 'artifact-dir', 'store-source']) {
    paths[key] = await realpath(resolve(values[key]))
    if (inside(paths[key], work) || inside(work, paths[key])) throw failure('PKW_MATRIX_PATH_OVERLAP', 'New work directory must be separate from all inputs')
  }
  if (inside(repo, work) || inside(work, repo)) throw failure('PKW_MATRIX_PATH_OVERLAP', 'Work directory must be outside the checkout')
  if (values.version === values['old-version']) throw failure('PKW_MATRIX_VERSION', 'Candidate and predecessor versions must differ')
  // Exclusive creation: never reuse a previous scene or any saved PID from it.
  await mkdir(work, { mode: 0o700 })
  const report = { status: 'preparing', work, version: values.version, oldVersion: values['old-version'], cases: [] }
  const save = () => writeFile(join(work, 'matrix-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const dirs = Object.fromEntries(['tmp', 'logs', 'cache', 'config', 'staging'].map(name => [name, join(work, name)]))
  for (const dir of Object.values(dirs)) await mkdir(dir, { mode: 0o700 })
  for (const name of ['npm-user', 'npm-global']) await writeFile(join(dirs.config, name), '', { mode: 0o600 })
  const sourcePackageManager = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).packageManager
  const selectedPm = await preparePackageManager({ work, sourcePackageManager,
    pnpmBin: values['pnpm-bin'], pnpmVersion: values['pnpm-version'] })
  const packageManager = selectedPm.packageManager
  report.packageManagerSelection = selectedPm.evidence
  await writeFile(join(work, 'package.json'), JSON.stringify({ private: true, packageManager }) + '\n', { mode: 0o600 })
  const env = { PATH: selectedPm.path,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}), LANG: 'C.UTF-8',
    TMPDIR: dirs.tmp, SQLITE_TMPDIR: dirs.tmp, NODE_DISABLE_COMPILE_CACHE: '1',
    XDG_CACHE_HOME: dirs.cache, XDG_CONFIG_HOME: dirs.config, npm_config_cache: dirs.cache,
    npm_config_userconfig: join(dirs.config, 'npm-user'), npm_config_globalconfig: join(dirs.config, 'npm-global'),
    COREPACK_HOME: join(dirs.cache, 'corepack'), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_DEFAULT_TO_LATEST: '0', COREPACK_ENABLE_AUTO_PIN: '0',
    npm_config_update_notifier: 'false', CI: 'true' }
  let logNumber = 0
  const execute = async (command, args, label, cwd = work, timeoutMs) => {
    emit({ phase: label })
    const result = await runOwned(command, args, { cwd, env, signal, label, timeoutMs, log: join(dirs.logs, `${++logNumber}-${label}.log`) })
    requireCommand(result, label)
    return result.stdout
  }
  let registry
  try {
    const expectedNames = (await packageList()).map(item => item.manifest.name)
    const old = await readReleaseArtifacts(paths['old-artifact-dir'], values['old-version'], expectedNames, { receiptPath: join(dirname(paths['old-artifact-dir']), 'receipt.json') })
    const newer = await readReleaseArtifacts(paths['artifact-dir'], values.version, expectedNames, { receiptPath: join(dirname(paths['artifact-dir']), 'receipt.json') })
    report.artifacts = { old: old.map(({ name, version, sha256, bytes }) => ({ name, version, sha256, bytes })), new: newer.map(({ name, version, sha256, bytes }) => ({ name, version, sha256, bytes })) }
    const sizes = {}
    for (const key of ['profile-source', 'data-source']) sizes[key] = await treeBytes(paths[key])
    const storePlan = await inspectPnpmStore(paths['store-source'])
    sizes['store-source'] = storePlan.bytes
    const space = await statfs(work)
    const required = 2 * 1024 ** 3 + 8 * sizes['profile-source'] + 4 * sizes['data-source'] + sizes['store-source']
    report.space = { available: space.bavail * space.bsize, required, sources: sizes }
    if (report.space.available < required) throw failure('PKW_MATRIX_SPACE', 'Insufficient data-disk space for three retained rehearsals')
    await execute(process.execPath, [join(repo, 'scripts/check-profile-selfcontained.mjs'), '--profile', paths['profile-source'], '--require-runtime-import', '--trace-imports'], 'support-profile-check')
    const pnpmVersion = (await execute('pnpm', ['--version'], 'package-manager')).trim()
    if (`pnpm@${pnpmVersion}` !== packageManager) throw failure('PKW_MATRIX_PM', `Expected ${packageManager}, observed ${pnpmVersion}`)
    report.packageManager = packageManager
    const store = join(work, 'store')
    const storePath = (await execute('pnpm', ['store', 'path', '--store-dir', store], 'store-path')).trim()
    if (!isAbsolute(storePath) || !inside(store, resolve(storePath)) || storePath.includes('\n')) throw failure('PKW_MATRIX_STORE', 'pnpm did not return a private store path')
    await mkdir(dirname(storePath), { recursive: true, mode: 0o700 })
    report.store = await copyPnpmStore(paths['store-source'], storePath)
    emit({ phase: 'private-store-content-ready', selected: report.store.selected, excluded: report.store.excluded, indexPolicy: report.store.indexPolicy, linksCopied: 0 })

    // Own immutable copies of exactly the ten checked artifacts, for both versions.
    for (const [label, artifacts] of [['old', old], ['new', newer]]) {
      for (const item of artifacts) {
        const dest = join(work, `${label}-packages`, item.name.split('/')[1])
        await mkdir(dest, { recursive: true, mode: 0o700 })
        const target = join(dest, 'package.tgz')
        await cp(item.tarball, target, { errorOnExist: true, force: false })
        if (createHash('sha256').update(await readFile(target)).digest('hex') !== item.sha256) throw failure('PKW_MATRIX_ARTIFACT_DRIFT', 'Artifact changed while being copied')
        item.tarball = target
      }
    }
    emit({ phase: 'artifact-reference' })
    report.reference = await createArtifactRunner(repo, join(work, 'runner'), newer)
    registry = await startLoopbackRegistry({ upstream: 'https://registry.npmjs.org', scopedUpstream: '' })
    for (const item of old) await registry.add(item.tarball)
    const peers = []
    const scope = join(paths['profile-source'], 'node_modules/@deepseek-ai')
    for (const entry of (await readdir(scope)).sort()) {
      if (entry.startsWith('dsh-pkw-')) continue
      const source = join(scope, entry)
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
      if (manifest.name !== `@deepseek-ai/${entry}`) throw failure('PKW_MATRIX_PEER', 'Unexpected support package identity')
      const staged = join(dirs.staging, entry)
      await cp(source, staged, { recursive: true, dereference: true, errorOnExist: true, force: false })
      await execute('npm', ['pack', '--ignore-scripts', '--quiet'], `pack-${entry}`, staged)
      const tarballs = (await readdir(staged)).filter(name => name.endsWith('.tgz'))
      if (tarballs.length !== 1) throw failure('PKW_MATRIX_PEER', 'Support package did not produce exactly one tarball')
      await registry.add(join(staged, tarballs[0]))
      peers.push({ name: manifest.name, version: manifest.version })
    }
    const oldProfile = join(work, 'old-profile')
    await mkdir(oldProfile, { mode: 0o700 })
    await writeFile(join(oldProfile, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager, name: 'pkw-rehearsal-predecessor', dependencies: Object.fromEntries([...old, ...peers].map(item => [item.name, item.version])) }) + '\n', { mode: 0o600 })
    await writeFile(join(oldProfile, 'pnpm-workspace.yaml'), 'packages: []\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 })
    await writeFile(join(oldProfile, '.npmrc'), `node-linker=hoisted\nauto-install-peers=false\nstrict-peer-dependencies=false\nregistry=${registry.url}\n@deepseek-ai:registry=${registry.url}\nstore-dir=${store}\n`, { mode: 0o600 })
    await execute('pnpm', ['install', '--ignore-scripts', '--config.auto-install-peers=false', '--config.minimum-release-age=0', `--store-dir=${store}`, `--registry=${registry.url}`, `--@deepseek-ai:registry=${registry.url}`], 'assemble-predecessor', oldProfile)
    await verifyArtifactPayload(oldProfile, old)
    await execute(process.execPath, [join(repo, 'scripts/check-profile-selfcontained.mjs'), '--profile', oldProfile, '--require-runtime-import', '--trace-imports'], 'predecessor-runtime-check')
    await registry.close(); registry = null
    report.predecessor = { profile: oldProfile, payloadVerified: true, packages: old.length, peers: peers.length }
    await save()

    let expectedMode
    for (const kind of ['positive', 'breakwrite', 'mode']) {
      if (signal?.aborted) throw failure('PKW_MATRIX_INTERRUPTED', 'Interrupted between cases')
      const caseDir = join(work, kind), port = await freePort()
      const args = [join(report.reference.runnerRoot, 'deploy/rehearse-release.mjs'), '--work-dir', caseDir,
        '--profile-source', oldProfile, '--data-source', paths['data-source'],
        '--artifact-dir', join(work, 'new-packages'), '--version', values.version, '--old-version', values['old-version'],
        '--store-dir', store, '--port', String(port), '--bootstrap-username', 'owner',
        '--owner-password', randomBytes(24).toString('hex'), '--set-owner-password', '--force-verify-failure', '--write-during-serve']
      if (kind === 'breakwrite') args.push('--break-write', 'note-parent')
      if (kind === 'mode') args.push('--expect-mode', expectedMode)
      emit({ phase: kind, work: caseDir })
      const result = await runOwned(process.execPath, args, { cwd: report.reference.runnerRoot, env, signal, label: kind, log: join(dirs.logs, `${kind}.log`) })
      const entry = caseExecutionEvidence(kind, caseDir, result)
      report.cases.push(entry)
      // Save the command's outcome even when it died before writing a usable report.
      await save()
      let recorded
      try {
        recorded = JSON.parse(await readFile(join(caseDir, 'report.json'), 'utf8'))
        if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) throw failure('PKW_MATRIX_REPORT_SHAPE', 'Rehearsal report is not an object')
        entry.cleanup = recorded.cleanup ?? null
        entry.lifecycleOk = recorded.exit?.lifecycleOk ?? null
      } catch (error) { entry.reportError = { code: error.code ?? null, message: error.message } }
      await save()
      assertCaseExecution(entry)
      const verdict = assertRehearsalVerdict({ kind, exitCode: result.code, report: recorded, oldVersion: values['old-version'], expectedMode: kind === 'mode' ? expectedMode : undefined })
      if (kind === 'positive') expectedMode = recorded.phases.writtenDuringServe.attachmentBaseline.mode === '600' ? '644' : '600'
      Object.assign(entry, verdict, { status: 'verified', cleanupConfirmed: true })
      await save(); emit({ phase: `${kind}-verified`, exitCode: result.code, cleanupConfirmed: true })
    }
    report.status = 'three-rehearsals-verified'
    return report
  } catch (error) {
    report.status = 'stopped'
    report.error = { code: error.code ?? null, message: error.message, ...(error.problems ? { problems: error.problems } : {}) }
    throw error
  } finally { if (registry) await registry.close(); await save(); emit({ status: report.status, cases: report.cases, error: report.error ?? null, evidence: join(work, 'matrix-report.json') }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ['work-dir', 'profile-source', 'data-source', 'old-artifact-dir', 'artifact-dir', 'old-version', 'version', 'store-source']
  const { values } = parseArgs({ options: Object.fromEntries([...names, 'pnpm-bin', 'pnpm-version'].map(name => [name, { type: 'string' }])) })
  for (const name of names) if (!values[name]) throw new Error(`Required --${name}`)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  try { await runMatrix(values, { signal: controller.signal }) }
  catch (error) { emit({ status: 'MATRIX_STOP', code: error.code ?? null, message: error.message }); process.exitCode = 1 }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}

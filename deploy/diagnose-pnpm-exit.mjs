#!/usr/bin/env node
// Installation-only diagnostic. No application process, credentials or data root.
import { cp, lstat, mkdir, readFile, readdir, realpath, statfs, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { packageList } from '../scripts/deployment.mjs'
import { runOwned, requireCommand, treeBytes } from './rehearse-matrix.mjs'
import { copyPnpmStore, inspectPnpmStore } from './site/rehearsal-store.mjs'
import { readReleaseArtifacts, verifyArtifactPayload } from './site/rehearsal-artifacts.mjs'
import { startLoopbackRegistry } from './site/loopback-registry.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const reject = (code, message) => Object.assign(new Error(message), { code })
const emit = value => console.log(JSON.stringify(value))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Parse the private log, not its tail: later installer output must not erase Done evidence. */
export async function readExitTraces(path) {
  const result = { records: [], malformed: 0, omitted: 0 }
  const prefix = '[PKW_PNPM_EXIT_TRACE] '
  const fields = ['schema', 'phase', 'elapsedMs', 'pid', 'ppid', 'node', 'executable', 'pnpmModule', 'resources', 'resourceTotal', 'resourceTypesOmitted', 'handles', 'handleTotal', 'handleOmitted', 'requests', 'requestTotal', 'requestOmitted', 'unavailable', 'exitCode', 'allocations', 'allocationTracked', 'allocationOmitted', 'allocationLimit', 'allocationDropped', 'allocationOverflow', 'allocationErrors', 'metadataTruncated']
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.startsWith(prefix)) continue
    if (Buffer.byteLength(line) > 8192) { result.malformed++; continue }
    try {
      const value = JSON.parse(line.slice(prefix.length))
      if (!value || value.schema !== 1 || !Number.isInteger(value.pid) || typeof value.phase !== 'string') throw new Error('invalid trace')
      if (result.records.length >= 24) { result.omitted++; continue }
      result.records.push(Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])))
    } catch { result.malformed++ }
  }
  return result
}

async function canonical(path) {
  const absolute = resolve(path), info = await lstat(absolute)
  if (!info.isDirectory() || await realpath(absolute) !== absolute) throw reject('PKW_PROBE_PATH', 'Input directories must be canonical directories')
  return absolute
}

export async function diagnosePnpmExit(values, { signal, onProgress = emit, registryOptions = {} } = {}) {
  const work = resolve(values['work-dir'])
  const inputs = Object.fromEntries(await Promise.all(['scene-dir', 'old-artifact-dir', 'artifact-dir'].map(async key => [key, await canonical(values[key])])) )
  const parent = await canonical(dirname(work))
  if (Object.values(inputs).some(path => inside(path, work) || inside(work, path))) throw reject('PKW_PROBE_PATH', 'Diagnostic output must not overlap input directories')
  const pnpm = resolve(values['pnpm-bin'])
  if (!isAbsolute(values['pnpm-bin']) || !(await lstat(await realpath(pnpm))).isFile()) throw reject('PKW_PROBE_PNPM', 'An absolute pnpm executable is required')
  await mkdir(work, { mode: 0o700 }) // Exclusive ownership; never reuse an earlier probe.
  const report = { diagnosticOnly: true, servicesStarted: false, installationSwitched: false, sourceScene: inputs['scene-dir'],
    node: { version: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch },
    pnpm: { path: pnpm, realpath: await realpath(pnpm), sha256: digest(await readFile(pnpm)) }, commands: [] }
  const save = () => writeFile(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const dirs = Object.fromEntries(['tmp', 'config', 'cache', 'logs'].map(key => [key, join(work, key)]))
  let registry, phase = 'preflight'
  try {
    for (const dir of Object.values(dirs)) await mkdir(dir, { mode: 0o700 })
    for (const name of ['user', 'global']) await writeFile(join(dirs.config, name), '', { mode: 0o600 })
    const env = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}), LANG: 'C.UTF-8', CI: 'true',
      TMPDIR: dirs.tmp, SQLITE_TMPDIR: dirs.tmp, NODE_DISABLE_COMPILE_CACHE: '1',
      XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache, npm_config_cache: dirs.cache,
      npm_config_userconfig: join(dirs.config, 'user'), npm_config_globalconfig: join(dirs.config, 'global'),
      COREPACK_HOME: join(dirs.cache, 'corepack'), COREPACK_DEFAULT_TO_LATEST: '0',
      COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_update_notifier: 'false',
      NODE_OPTIONS: `--require=${JSON.stringify(join(repo, 'deploy/site/pnpm-exit-trace.cjs'))}` }
    const command = async (label, args, cwd, timeoutMs) => {
      phase = label; onProgress({ phase })
      const result = await runOwned(pnpm, args, { cwd, env, timeoutMs, graceMs: 2000, signal,
        label, onProgress, log: join(dirs.logs, `${label}.log`) })
      const { stdout, tail, ...evidence } = result
      const entry = { label, ...evidence }
      report.commands.push(entry)
      await save() // Keep the real outcome even if diagnostic log parsing fails.
      try {
        entry.traces = await readExitTraces(join(dirs.logs, `${label}.log`))
        for (const trace of entry.traces.records) onProgress({ phase: label, trace })
      } catch (error) { entry.traceReadError = { code: error.code ?? 'PKW_TRACE_READ_FAILED' } }
      await save()
      requireCommand(result, label)
      return stdout.trim()
    }
    const names = (await packageList()).map(pkg => pkg.manifest.name)
    const old = await readReleaseArtifacts(inputs['old-artifact-dir'], values['old-version'], names)
    const newer = await readReleaseArtifacts(inputs['artifact-dir'], values.version, names)
    const source = await canonical(join(inputs['scene-dir'], 'old-profile'))
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    if (manifest.packageManager !== 'pnpm@11.7.0' || !manifest.dependencies || typeof manifest.dependencies !== 'object') throw reject('PKW_PROBE_MANIFEST', 'Expected the assembled pnpm 11.7.0 predecessor manifest')
    for (const pkg of old) if (manifest.dependencies[pkg.name] !== pkg.version) throw reject('PKW_PROBE_MANIFEST', 'Predecessor dependencies do not match its verified artifacts')
    await verifyArtifactPayload(source, old)
    const storeSource = await canonical(join(inputs['scene-dir'], 'store/v11'))
    const plan = await inspectPnpmStore(storeSource)
    const profileBytes = await treeBytes(source)
    const capacity = await statfs(parent)
    const neededBytes = plan.bytes + 3 * profileBytes + 512 * 1024 * 1024
    if (capacity.bavail * capacity.bsize < neededBytes) throw reject('PKW_PROBE_SPACE', 'Insufficient free space for the independent store and profile copies')
    report.capacity = { neededBytes, availableBytes: capacity.bavail * capacity.bsize }
    const beforeManifest = digest(await readFile(join(source, 'package.json')))
    const pmVersion = await command('pnpm-version', ['--version'], repo, 30_000)
    if (pmVersion !== '11.7.0') throw reject('PKW_PROBE_PNPM', 'pnpm must report exactly 11.7.0')
    report.pnpm.version = pmVersion
    phase = 'copy-private-store'; onProgress({ phase })
    await mkdir(join(work, 'store'), { mode: 0o700 })
    report.store = await copyPnpmStore(storeSource, join(work, 'store/v11'))
    signal?.throwIfAborted()

    phase = 'support-artifacts'; onProgress({ phase })
    const readSupport = async root => {
      const support = [], staging = await canonical(root)
      for (const name of await readdir(staging)) {
        const dir = await canonical(join(staging, name))
        for (const filename of (await readdir(dir)).filter(name => name.endsWith('.tgz'))) {
          const path = join(dir, filename), info = await lstat(path)
          if (!info.isFile() || await realpath(path) !== path || info.size > 128 * 1024 * 1024) throw reject('PKW_PROBE_SUPPORT', 'Support tarballs must be bounded regular files')
          support.push({ path, sha256: digest(await readFile(path)) })
        }
      }
      return support
    }
    const oldSupport = await readSupport(join(inputs['scene-dir'], 'staging'))
    const newSupport = await readSupport(join(inputs['scene-dir'], 'positive/support'))
    const previous = JSON.parse(await readFile(join(inputs['scene-dir'], 'positive/report.json'), 'utf8'))
    if (previous.oldVersion !== values['old-version'] || previous.version !== values.version || previous.supportArtifacts !== newSupport.length) throw reject('PKW_PROBE_SUPPORT', 'Support inputs do not match the failed rehearsal report')
    const peers = Object.keys(manifest.dependencies).filter(name => !names.includes(name))
    const openRegistry = async (artifacts, support, complete) => {
      const handle = await startLoopbackRegistry({ upstream: 'https://registry.npmjs.org', scopedUpstream: '', ...registryOptions })
      registry = handle // Retain ownership even if validation below throws.
      const seen = new Set()
      for (const item of support) {
        const record = await handle.add(item.path)
        if (record.sha256 !== item.sha256 || !peers.includes(record.name) || record.version !== manifest.dependencies[record.name] || seen.has(record.name)) throw reject('PKW_PROBE_SUPPORT', 'Support tarballs do not exactly match predecessor peers')
        seen.add(record.name)
      }
      if (complete && seen.size !== peers.length) throw reject('PKW_PROBE_SUPPORT', 'Support tarballs are incomplete')
      for (const item of artifacts) {
        const record = await handle.add(item.tarball)
        if (record.name !== item.name || record.version !== item.version || record.sha256 !== item.sha256) throw reject('PKW_PROBE_ARTIFACT', 'Release artifact changed after verification')
      }
      return [...seen]
    }
    const store = join(work, 'store')
    const flags = url => ['--ignore-scripts', '--config.auto-install-peers=false', `--registry=${url}`, `--@deepseek-ai:registry=${url}`, `--store-dir=${store}`, '--config.minimum-release-age=0']
    const oldProfile = join(work, 'old-profile'), candidate = join(work, 'candidate')
    await mkdir(oldProfile, { mode: 0o700 })
    await writeFile(join(oldProfile, 'package.json'), JSON.stringify({ private: true, type: 'module', name: 'pkw-exit-probe', packageManager: manifest.packageManager, dependencies: manifest.dependencies }) + '\n', { mode: 0o600 })
    await writeFile(join(oldProfile, 'pnpm-workspace.yaml'), 'packages: []\nnodeLinker: hoisted\nautoInstallPeers: false\n', { mode: 0o600 })
    await openRegistry(old, oldSupport, true)
    await command('install-old', ['install', ...flags(registry.url)], oldProfile, 120_000)
    phase = 'verify-old-payload'
    await verifyArtifactPayload(oldProfile, old)
    await registry.close(); registry = null
    await cp(oldProfile, candidate, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
    const addPeers = await openRegistry(newer, newSupport, false)
    const targets = [...newer.map(item => `${item.name}@${item.version}`), ...addPeers.map(name => `${name}@${manifest.dependencies[name]}`)]
    report.addTargets = targets
    await command('add-new', ['add', '--save-exact', ...flags(registry.url), ...targets], candidate, 60_000)
    phase = 'verify-new-payload'
    await verifyArtifactPayload(candidate, newer)
    await verifyArtifactPayload(oldProfile, old)
    if (digest(await readFile(join(source, 'package.json'))) !== beforeManifest) throw reject('PKW_PROBE_SOURCE_CHANGED', 'Source manifest changed during diagnostic')
    report.status = 'pnpm-add-exited-normally'
    report.payloadsVerified = true
  } catch (error) {
    report.status = 'pnpm-exit-probe-stopped'
    report.error = { phase, code: error.code ?? null, message: error.message }
  } finally {
    await registry?.close()
    await save()
  }
  onProgress({ status: report.status, error: report.error ?? null, diagnosticOnly: true, servicesStarted: false,
    commands: report.commands.map(({ label, code, signal, timedOut, groupCleanup }) => ({ label, code, signal, timedOut, cleanupConfirmed: groupCleanup?.confirmed })), report: join(work, 'report.json') })
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: Object.fromEntries(['work-dir', 'scene-dir', 'old-artifact-dir', 'artifact-dir', 'old-version', 'version', 'pnpm-bin'].map(key => [key, { type: 'string' }])) })
  if (Object.keys(values).length !== 7) throw new Error('Supply work-dir, scene-dir, old-artifact-dir, artifact-dir, old-version, version and pnpm-bin')
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal)
  try {
    const report = await diagnosePnpmExit(values, { signal: controller.signal })
    process.exitCode = report.status === 'pnpm-add-exited-normally' ? 0 : 1
  } catch (error) { console.error(JSON.stringify({ status: 'PKW_EXIT_PROBE_STOP', code: error.code, message: error.message })); process.exitCode = 1 }
  finally { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal) }
}

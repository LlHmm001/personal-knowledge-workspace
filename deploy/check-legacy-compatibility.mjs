#!/usr/bin/env node
/** Exact installed legacy -> prepared candidate -> exact legacy, on exclusively new synthetic data. */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { snapshotTree } from './prepare-first-cutover.mjs'
import { createCompatProcess } from './site/legacy-compat-process.mjs'
import { createLegacyCompatClient } from './site/legacy-compat-client.mjs'

const runFile = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = (code, message) => Object.assign(new Error(message), { code: `PKW_LEGACY_${code}` })
export const SITE = Object.freeze({
  prepared: '/LlHmm9527/pkw-first-stage-O43TIw/runtime',
  oldProfile: '/root/.dsh/profiles/web',
  oldRunner: '/LlHmm9527/pkw-delivery-v3/repo/scripts/serve-collaboration.mjs',
  oldRunnerSha256: '33eb260743563c4b83bdcd55d15be936f1ee0bfe484c6f8fe268bc4c9cb1617e',
  oldManifestSha256: '17f61fd4c022707e5df627218404374140cd0a5233367e3ff99826abe4cdcbe1',
  profileSha256: '06f957837b4d4dca1c366f18217cfe72aa0840156cb46c0c0301896dd9431e2b',
  runnerSha256: '8c3fabd29aa8d21a97749f12b32e8f782b566b766ecb639b34c09d68c48a075f',
  oldVersion: '0.1.2-pkw.4', newVersion: '0.1.9-pkw.1',
})
const packageNames = ['attachments', 'base', 'domain', 'events', 'notes', 'tasks', 'web', 'weknora', 'weknora-sync', 'workspace']

async function file(path, max = 2_097_152) {
  if (await realpath(path) !== path) throw fail('PATH', 'Code/evidence file is not canonical')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > max) throw fail('FILE', 'Code/evidence must be a bounded regular file')
    const buffer = Buffer.alloc(max + 1)
    let length = 0
    while (length < buffer.length) {
      const value = await handle.read(buffer, length, buffer.length - length, length)
      if (!value.bytesRead) break
      length += value.bytesRead
    }
    const after = await handle.stat()
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail('DRIFT', 'Code/evidence changed while inspected')
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}
async function absent(path) {
  try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
function safeError(error) {
  // Application response bodies, child output and credentials stay in private evidence.
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'PKW_LEGACY_UNKNOWN'
  const detail = error?.details
  return { code, message: code.startsWith('PKW_') ? String(error.message).slice(0, 600) : 'Operation failed; private scene retained',
    ...(detail && { stage: detail.stage, status: detail.status, reason: detail.reason }) }
}

/** Code and unit metadata only. No environment, live config, credentials, lock or database reads. */
export async function observeLiveBaseline() {
  if ((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== 'd80e20a0-b2e2-49f5-9c6c-611d49d50fe8') throw fail('BOOT_CHANGED', 'Server boot identity changed')
  if (hash(await file('/etc/systemd/system/pkw-collaboration.service')) !== '4fdf72f6c4e12e27d736d0331fcdd9dcecbc86e58f158e74f9ab7b6bb270f6a1') throw fail('UNIT_CHANGED', 'Production unit bytes changed')
  const output = {}
  const expected = {
    'pkw-collaboration.service': [1608174, '851263033', 'db2b538bbf1d1c9a79edb93cb52f9699317433d1abce0fd645de8de7001f07aa'],
    'deepseek-harness.service': [1585972, '851055080', '1242c76bf0cebfd964a79b3769677be7957fadd6896cac88f7704987c75d3d3d'],
  }
  const fields = ['Id', 'MainPID', 'ControlPID', 'NRestarts', 'ActiveState', 'SubState', 'DropInPaths']
  for (const [name, [pid, ticks, cmdhash]] of Object.entries(expected)) {
    const { stdout } = await runFile('/usr/bin/systemctl', ['show', name, '--no-pager', ...fields.flatMap(key => ['--property', key])], { timeout: 5000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
    const observed = {}
    for (const line of stdout.trimEnd().split('\n')) {
      const at = line.indexOf('='), key = line.slice(0, at)
      if (at < 1 || !fields.includes(key) || Object.hasOwn(observed, key)) throw fail('UNIT_UNREADABLE', 'Unit state cannot be established')
      observed[key] = line.slice(at + 1)
    }
    if (fields.some(key => !Object.hasOwn(observed, key)) || observed.Id !== name || observed.MainPID !== String(pid) || observed.ControlPID !== '0' || observed.NRestarts !== '0' || observed.ActiveState !== 'active' || observed.SubState !== 'running' || name === 'pkw-collaboration.service' && observed.DropInPaths !== '') throw fail('LIVE_CHANGED', 'Live service state differs from the returned baseline')
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
    if (raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/)[19] !== ticks || hash(await readFile(`/proc/${pid}/cmdline`)) !== cmdhash) throw fail('PROCESS_CHANGED', 'Live process identity changed')
    output[name] = { pid, startTicks: ticks, NRestarts: 0, state: 'active/running' }
  }
  return output
}

export async function inspectCompatibilityInputs() {
  const profile = join(SITE.prepared, 'releases', SITE.newVersion, 'profile')
  const runnerRoot = join(SITE.prepared, 'releases', SITE.newVersion, 'runner')
  const prepared = JSON.parse(await file(join(SITE.prepared, 'preparation-report.json')))
  if (prepared.status !== 'PREPARED_NOT_ACTIVATED' || prepared.work !== SITE.prepared || prepared.version !== SITE.newVersion || prepared.profile?.path !== profile || prepared.runner?.runnerRoot !== runnerRoot || prepared.profile?.sha256 !== SITE.profileSha256 || prepared.runner?.treeSha256 !== SITE.runnerSha256 || prepared.runtime?.ok !== true || prepared.activated !== false || prepared.servicesStarted !== false || prepared.currentCreated !== false || !await absent(join(SITE.prepared, 'current'))) throw fail('PREPARED_CHANGED', 'Prepared candidate evidence changed or was activated')
  const freshProfile = await snapshotTree(profile), freshRunner = await snapshotTree(runnerRoot)
  if (freshProfile.sha256 !== SITE.profileSha256 || freshRunner.sha256 !== SITE.runnerSha256) throw fail('PREPARED_CHANGED', 'Prepared code no longer matches its returned digest')
  if (hash(await file(SITE.oldRunner)) !== SITE.oldRunnerSha256 || hash(await file(join(SITE.oldProfile, 'package.json'))) !== SITE.oldManifestSha256) throw fail('LEGACY_CHANGED', 'Installed legacy entry or manifest differs from the returned baseline')
  const oldPackages = []
  for (const suffix of packageNames) {
    const name = `@deepseek-ai/dsh-pkw-${suffix}`
    const dir = await realpath(join(SITE.oldProfile, 'node_modules', name))
    if (!(dir.startsWith('/root/.dsh/profiles/') || dir.startsWith('/opt/dsh-releases/'))) throw fail('LEGACY_PATH', 'Legacy package is outside the recorded installation/release roots')
    const bytes = await file(join(dir, 'package.json')), pkg = JSON.parse(bytes)
    const expectedVersion = suffix === 'weknora' ? '0.1.0' : SITE.oldVersion
    if (pkg.name !== name || pkg.version !== expectedVersion) throw fail('LEGACY_VERSION', 'Actual installed mixed package versions changed')
    const tree = await snapshotTree(join(dir, 'lib'))
    oldPackages.push({ name, version: pkg.version, directory: dir, manifestSha256: hash(bytes), libSha256: tree.sha256, identitySha256: tree.identitySha256 })
  }
  return { old: { runner: SITE.oldRunner, profile: SITE.oldProfile, version: SITE.oldVersion, packages: oldPackages },
    candidate: { runner: join(runnerRoot, 'scripts/serve-collaboration.mjs'), profile, version: SITE.newVersion,
      profileSha256: freshProfile.sha256, runnerSha256: freshRunner.sha256,
      profileIdentitySha256: freshProfile.identitySha256, runnerIdentitySha256: freshRunner.identitySha256 } }
}

/** Sequentially acquire and relinquish the same synthetic writer; failure never advances to another instance. */
export async function runCompatibilityScenario({ inputs, work, dataRoot, config, port, username, password, signal, report, save = async () => {}, progress = () => {} },
  { processFactory = createCompatProcess, clientFactory = createLegacyCompatClient } = {}) {
  let oldFixture, newFixture
  const phases = [['legacy-write', inputs.old], ['candidate-read-write', inputs.candidate], ['legacy-read-back', inputs.old]]
  for (const [name, input] of phases) {
    if (signal?.aborted) throw fail('INTERRUPTED', 'Compatibility was interrupted before the next writer')
    const phase = { name, version: input.version, status: 'starting' }
    report.phases.push(phase); await save(); progress({ phase: name, status: 'starting' })
    const manager = processFactory({ ...input, work, dataRoot, config, port, password, signal })
    let failure
    try {
      phase.start = await manager.start()
      if (signal?.aborted) throw fail('INTERRUPTED', 'Compatibility was interrupted after startup')
      const client = await clientFactory({ origin: `http://127.0.0.1:${port}`, username, password, dataRoot, signal })
      phase.auth = await client.authenticate(input.version, oldFixture?.spaceId)
      if (name === 'legacy-write') {
        oldFixture = await client.writeFixture({ label: 'legacy' }); phase.written = oldFixture
      } else if (name === 'candidate-read-write') {
        phase.oldRead = await client.verifyFixture(oldFixture)
        newFixture = await client.writeFixture({ label: 'candidate' }); phase.written = newFixture
      } else {
        phase.oldRead = await client.verifyFixture(oldFixture)
        phase.newRead = await client.verifyFixture(newFixture)
      }
      if (signal?.aborted) throw fail('INTERRUPTED', 'Compatibility was interrupted before phase completion')
      phase.status = 'business-verified'
    } catch (error) { failure = error; phase.error = safeError(error); phase.status = 'failed' }
    finally {
      try { phase.stop = await manager.stop() } catch (error) { phase.stop = { ok: false, cleanupConfirmed: false, error: safeError(error) } }
      if (phase.stop.ok !== true || phase.stop.cleanupConfirmed !== true) {
        phase.status = 'failed'
        failure ??= fail('STOP_UNCONFIRMED', 'Synthetic listener did not stop cleanly; no subsequent writer will start')
      }
      phase.process = manager.state()
      await save(); progress({ phase: name, status: phase.status, cleanupConfirmed: phase.stop.cleanupConfirmed === true })
    }
    if (failure) throw failure
    phase.status = 'passed'; await save()
  }
  return { oldFixture, newFixture }
}

async function unusedPort() {
  const server = createServer()
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  const port = server.address().port
  await new Promise((yes, no) => server.close(error => error ? no(error) : yes()))
  return port
}

export async function checkLegacyCompatibility({ workDir, signal, progress = () => {} }, dependencies = {}) {
  const observe = dependencies.observe ?? observeLiveBaseline
  const inspect = dependencies.inspect ?? inspectCompatibilityInputs
  const work = resolve(workDir ?? '')
  // CLI supplies this exact fresh layout. No user-selected data/config/installed paths.
  if (!/^\/LlHmm9527\/pkw-legacy-compat-[a-zA-Z0-9]+\/run$/.test(work) && !dependencies.allowTestWork) throw fail('WORK_SCOPE', 'Use a fresh compatibility handoff directory')
  if (await realpath(dirname(work)) !== dirname(work) || !await absent(work)) throw fail('WORK_EXISTS', 'Compatibility work must not exist; existing scenes are preserved')
  const before = await observe(), inputs = await inspect()
  if (signal?.aborted) throw fail('INTERRUPTED', 'Interrupted before fresh data creation')
  await mkdir(work, { mode: 0o700 })
  const reportPath = join(work, 'compatibility-report.json')
  const report = { status: 'RUNNING', work, sourceSha: /^[a-f0-9]{40}$/.test(process.env.PKW_COMPAT_SOURCE_SHA ?? '') ? process.env.PKW_COMPAT_SOURCE_SHA : null, oldVersion: inputs.old.version, newVersion: inputs.candidate.version,
    syntheticOnly: true, productionDataAccessed: false, productionConfigAccessed: false, servicesChanged: false,
    productionAcceptance: 'not_run', inputs, baselineBefore: before, phases: [], sceneRetained: true }
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  let failure
  try {
    await save()
    const dataRoot = join(work, 'data'), config = join(work, 'collaboration.json')
    await mkdir(dataRoot, { mode: 0o700 })
    const port = await (dependencies.unusedPort ?? unusedPort)(), username = 'compat-owner', password = randomBytes(32).toString('base64url')
    await writeFile(config, JSON.stringify({ dataPath: dataRoot, publicOrigin: `http://127.0.0.1:${port}`, bootstrapUsername: username, bootstrapPasswordEnv: 'PKW_COMPAT_BOOTSTRAP' }) + '\n', { flag: 'wx', mode: 0o600 })
    // Own newly generated credentials, never production credentials. Retained privately for diagnosis.
    await writeFile(join(work, 'synthetic-credentials.json'), JSON.stringify({ username, password }) + '\n', { flag: 'wx', mode: 0o600 })
    report.dataRoot = dataRoot; report.port = port
    await runCompatibilityScenario({ inputs, work, dataRoot, config, port, username, password, signal, report, save, progress }, dependencies)
  } catch (error) { failure = error; report.error = safeError(error) }
  finally {
    try {
      report.baselineAfter = await observe()
      report.inputsUnchanged = same(inputs, await inspect())
      report.liveBaselineUnchanged = same(before, report.baselineAfter)
      if (!report.inputsUnchanged || !report.liveBaselineUnchanged) throw fail('DRIFT', 'Prepared/legacy code or live process baseline changed')
    } catch (error) { report.finalCheckError = safeError(error); failure ??= error }
    report.cleanupConfirmed = report.phases.every(phase => phase.stop?.cleanupConfirmed === true)
    if (signal?.aborted) failure ??= fail('INTERRUPTED', 'Compatibility run was interrupted')
    report.status = failure ? 'LEGACY_COMPATIBILITY_STOPPED' : 'LEGACY_SYNTHETIC_COMPATIBILITY_PASSED'
    if (failure && !report.error) report.error = safeError(failure)
    await save()
  }
  if (failure) throw Object.assign(failure, { report, reportPath })
  return { ...report, reportPath }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const deadline = setTimeout(interrupt, 360_000)
  try {
    const { values } = parseArgs({ options: { 'work-dir': { type: 'string' } } })
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.version !== 'v22.23.1' || process.execPath !== '/root/.hermes/node/bin/node') throw fail('PLATFORM', 'Use the recorded Linux/root Node 22.23.1 executable')
    const result = await checkLegacyCompatibility({ workDir: values['work-dir'], signal: controller.signal, progress: value => console.log(JSON.stringify(value)) })
    console.log(JSON.stringify({ status: result.status, evidence: result.reportPath, versions: [result.oldVersion, result.newVersion, result.oldVersion], phases: result.phases.map(p => ({ name: p.name, status: p.status, version: p.version, cleanupConfirmed: p.stop.cleanupConfirmed })), cleanupConfirmed: result.cleanupConfirmed, liveBaselineUnchanged: result.liveBaselineUnchanged, inputsUnchanged: result.inputsUnchanged, syntheticOnly: true, productionAcceptance: 'not_run' }))
  } catch (error) {
    console.log(JSON.stringify({ status: 'LEGACY_COMPATIBILITY_STOPPED', error: safeError(error), evidence: error.reportPath ?? null, cleanupConfirmed: error.report?.cleanupConfirmed ?? null, syntheticOnly: true, productionAcceptance: 'not_run' }))
    process.exitCode = 1
  } finally { clearTimeout(deadline); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
}

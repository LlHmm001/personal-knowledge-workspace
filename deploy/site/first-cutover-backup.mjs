/** Confirm an offline, integrity-bound directory backup using the prepared runner's existing tool. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runOwned } from '../rehearse-matrix.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const fail = (code, message) => Object.assign(new Error(message), { code: `PKW_FIRST_BACKUP_${code}` })
const hex = value => /^[a-f0-9]{64}$/.test(value ?? '')
async function absent(path) { try { await lstat(path); return false } catch (e) { if (e.code === 'ENOENT') return true; throw e } }
async function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw fail('PATH', 'Expected a canonical directory')
  return path
}
async function regularBytes(path, max = 32 * 1024 * 1024) {
  if (await realpath(path) !== path) throw fail('PATH', 'Backup evidence/tool file traverses a symlink')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > max) throw fail('FILE', 'Expected a bounded regular evidence/tool file')
    const value = await file.readFile(), after = await file.stat()
    if (value.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('DRIFT', 'Evidence/tool changed while read')
    return value
  } finally { await file.close() }
}
const worker = `
import { pathToFileURL } from 'node:url';
try {
  const api=await import(pathToFileURL(process.argv[2]).href),command=process.argv[3],options=JSON.parse(process.argv[4]);
  const method={backup:'backupCollaboration',verify:'verifyCollaboration','verify-source':'verifyCollaborationSource'}[command];
  if(!method)throw new Error('unexpected operation');
  const result=await api[method](options);
  console.log(JSON.stringify({ok:true,operation:result.operation,backup:result.backup,manifestSha256:result.manifestSha256,
    sourceFingerprint:result.sourceFingerprint,byteIntegrity:result.byteIntegrity,sqliteIntegrity:result.sqliteIntegrity,
    sourceUnchanged:result.sourceUnchanged,keepWritersStopped:result.keepWritersStopped,
    ready:result.analysis?.readiness?.preflightChecksPassed===true}));
} catch(error) {
  console.log(JSON.stringify({ok:false,error:{kind:typeof error.kind==='string'?error.kind:'IO',code:typeof error.code==='string'?error.code:null}}));
  process.exitCode=1;
}
`

export async function coldBackupForFirstCutover({ dataRoot, output, work, toolRoot, node = process.execPath, signal,
  timeoutMs = 600_000, graceMs = 15_000, onProgress = () => {} } = {}, { confirmStopped, runCommand = runOwned } = {}) {
  if (typeof confirmStopped !== 'function') throw fail('STOP_REQUIRED', 'A fresh service-stop probe is required')
  await canonical(dataRoot); await canonical(toolRoot); await canonical(dirname(work)); await canonical(dirname(output))
  for (const path of [work, output, node]) if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw fail('PATH', 'Expected absolute canonical destination/executable paths')
  for (const [a, b] of [[dataRoot, output], [dataRoot, work], [toolRoot, output], [toolRoot, work], [work, output]]) if (inside(a, b) || inside(b, a)) throw fail('OVERLAP', 'Source, backup, tool and private worker directories must be separate')
  if (!await absent(work) || !await absent(output)) throw fail('EXISTS', 'Backup and private worker destinations must be new; existing paths are preserved')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000 || !Number.isFinite(graceMs) || graceMs < 1 || graceMs > 60_000) throw fail('DEADLINE', 'Invalid owned worker deadline')
  const tool = join(toolRoot, 'scripts/collaboration-backup.mjs'), preservation = join(toolRoot, 'scripts/data-preservation.mjs')
  const toolDigests = { backup: hash(await regularBytes(tool)), preservation: hash(await regularBytes(preservation)) }
  const report = { ok: false, backupRoot: output, dataRoot, backupFormat: 'directory-with-integrity-manifest', work, toolDigests,
    sourceVerified: false, cleanupConfirmed: false, servicesChanged: false, databaseRestored: false, runs: [], stopEvidence: [] }
  const requireStopped = async stage => {
    if (signal?.aborted) throw fail('INTERRUPTED', 'Backup was interrupted')
    const state = await confirmStopped(stage)
    report.stopEvidence.push({ stage, state })
    if (state?.known !== true || state.stopped !== true) throw fail('STOP_UNCONFIRMED', 'The service is not confirmed stopped; no backup action is allowed')
    if (!await absent(join(dataRoot, 'gateway.lock'))) throw fail('LOCK_PRESENT', 'A gateway lock remains; it is preserved and never stolen')
  }
  await requireStopped('before-backup-work')
  await mkdir(work, { mode: 0o700 })
  const reportPath = join(work, 'backup-evidence.json'), workerPath = join(work, 'backup-worker.mjs')
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  let failure
  try {
    for (const name of ['home', 'tmp', 'cache', 'logs']) await mkdir(join(work, name), { mode: 0o700 })
    await writeFile(workerPath, worker, { flag: 'wx', mode: 0o600 })
    const env = { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: join(work, 'home'), DSH_HOME: join(work, 'home/.dsh'),
      TMPDIR: join(work, 'tmp'), SQLITE_TMPDIR: join(work, 'tmp'), XDG_CACHE_HOME: join(work, 'cache'),
      XDG_CONFIG_HOME: join(work, 'home/.config'), LANG: 'C', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1' }
    const execute = async (command, options) => {
      await requireStopped(`before-${command}`)
      const log = join(work, 'logs', `${command}.log`)
      const evidence = { operation: command, log, execution: { groupCleanup: { confirmed: false } }, lockAbsent: false }
      report.runs.push(evidence); await save()
      const result = await runCommand(node, [workerPath, tool, command, JSON.stringify(options)], { cwd: work, env, log, signal, timeoutMs, graceMs, label: `cold-${command}`, onProgress })
      const { stdout, tail, ...execution } = result
      evidence.execution = execution; evidence.lockAbsent = await absent(join(dataRoot, 'gateway.lock'))
      await save()
      if (result.code !== 0 || result.signal !== null || result.error || result.interrupted || result.timedOut || result.groupCleanup?.confirmed !== true || result.groupCleanup?.closed !== true || result.groupCleanup?.present !== false || !evidence.lockAbsent) throw fail('WORKER_FAILED', 'Cold-backup worker did not exit cleanly or release its own lock/group; inspect private evidence')
      let value
      try { value = JSON.parse(stdout) } catch { throw fail('REPORT', 'Cold-backup worker did not return one complete JSON report') }
      if (!value || value.ok !== true || value.operation !== command || value.backup !== output || !hex(value.manifestSha256) || !hex(value.sourceFingerprint)) throw fail('REPORT', 'Cold-backup worker evidence is incomplete or belongs to another backup')
      if (command !== 'backup' && (value.manifestSha256 !== report.manifestSha256 || value.sourceFingerprint !== report.sourceFingerprint || value.ready !== true || value.byteIntegrity !== 'passed' || value.sqliteIntegrity !== 'passed')) throw fail('VERIFY', 'Backup bytes, SQLite content or readiness were not verified against the retained manifest')
      if (command === 'verify-source' && (value.sourceUnchanged !== true || value.keepWritersStopped !== true)) throw fail('SOURCE', 'The stopped source was not verified unchanged')
      evidence.result = value; await save()
      return value
    }
    const created = await execute('backup', { dataRoot, output, offlineConfirmed: true })
    const bytes = await regularBytes(join(output, 'manifest.json'))
    let manifest
    try { manifest = JSON.parse(bytes) } catch { throw fail('MANIFEST', 'Backup manifest is not valid JSON') }
    if (hash(bytes) !== created.manifestSha256 || manifest.format !== 'pkw-collaboration-backup' || manifest.version !== 1 || manifest.status !== 'complete' || manifest.sourceRoot !== dataRoot || manifest.offlineConfirmed !== true || manifest.sourceInventory?.fingerprint !== created.sourceFingerprint || !Array.isArray(manifest.payload) || !Array.isArray(manifest.databases)) throw fail('MANIFEST', 'Backup manifest does not match the completed source capture')
    report.manifestSha256 = created.manifestSha256; report.sourceFingerprint = created.sourceFingerprint
    await execute('verify', { backup: output, manifestSha256: report.manifestSha256, requireReady: true })
    await execute('verify-source', { backup: output, manifestSha256: report.manifestSha256, offlineConfirmed: true, requireReady: true })
    if (hash(await regularBytes(join(output, 'manifest.json'))) !== report.manifestSha256 || hash(await regularBytes(tool)) !== toolDigests.backup || hash(await regularBytes(preservation)) !== toolDigests.preservation) throw fail('DRIFT', 'Backup manifest or backup tool changed during verification')
    report.sourceVerified = true
  } catch (error) { failure = error; report.error = { code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'PKW_FIRST_BACKUP_UNKNOWN', message: 'Cold backup was not accepted; private evidence and any completed backup are retained' } }
  finally {
    try { await requireStopped('after-backup'); report.cleanupConfirmed = report.runs.every(run => run.execution.groupCleanup?.confirmed === true && run.lockAbsent === true) } catch (error) { failure ??= error; report.cleanupError = { code: error.code ?? 'PKW_FIRST_BACKUP_STOP_UNKNOWN' } }
    report.ok = !failure && report.sourceVerified && report.cleanupConfirmed
    await save()
  }
  if (failure) throw Object.assign(failure, { report, reportPath })
  if (!report.ok) throw Object.assign(fail('INCOMPLETE', 'Cold backup did not meet all acceptance conditions'), { report, reportPath })
  return { ...report, reportPath }
}

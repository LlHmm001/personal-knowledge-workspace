#!/usr/bin/env node
// Configuration-only incident recovery. Never opens or migrates a data store.
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, lstatSync, chmodSync, chownSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'

const bundleNames = new Set(['@deepseek-ai/dsh-pkw-base', '@deepseek-ai/dsh-extension-pkw'])
const pkwDomains = new Set(['pkw', 'pkw_notes', 'pkw_attachments', 'pkw_tasks', 'pkw_weknora_sync'])
const sqliteName = '@deepseek-ai/dsh-storage-sqlite'
const isPkw = row => (typeof row.name === 'string' && (row.name.startsWith('@deepseek-ai/dsh-pkw-') || row.name === '@deepseek-ai/dsh-extension-pkw')) || /^pkw(?:-|$)/.test(row.id ?? '')
const disabled = row => row.disabled === true
const confirmedEnvironmentPath = '/LlHmm9527/memory-hub/state/keys/agent-journal.env'
const injectionKey = name => /^(?:LD_|DYLD_)/.test(name) || ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'].includes(name)

export function entriesIn(rows) {
  if (!Array.isArray(rows)) throw new Error('Config must be an entry list')
  const result = []
  function visit(group) {
    const seen = new Set()
    for (const row of group) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') throw new Error('Unexpected loader entry structure')
      if (seen.has(row.id)) throw new Error(`Duplicate loader id remains: ${row.id}`)
      seen.add(row.id)
      result.push(row)
      if (row.group && Array.isArray(row.config)) visit(row.config)
    }
  }
  visit(rows)
  return result
}

export function recoveryManifest(manifest) {
  const next = structuredClone(manifest)
  const bundles = next.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every(value => typeof value === 'string')) throw new Error('Unexpected profile bundle list')
  if (!bundles.includes('@deepseek-ai/dsh-pkw-base')) throw new Error('PKW base is not in this profile; do not guess another configuration')
  next.dsh.profile.bundles = bundles.filter(name => !bundleNames.has(name))
  return next
}

export function recoveryOverrides(rows) {
  const entries = entriesIn(rows)
  const domain = entries.find(row => row.id === 'storage-domain')
  if (!domain || domain.name !== '@deepseek-ai/dsh-storage-domain' || domain.config?.backend !== 'json') throw new Error('Expected original DSH JSON storage; manual verification required')
  const routes = domain.config.routes ?? {}
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error('Unexpected storage routes')
  if (Object.entries(routes).some(([name, backend]) => !pkwDomains.has(name) && backend !== 'json')) throw new Error('Non-PKW storage routing requires manual verification')
  const targets = entries.filter(isPkw)
  for (const row of entries) {
    if (row.name !== sqliteName || disabled(row)) continue
    const path = row.config?.path
    const text = typeof path === 'string' ? path : path?.__jsExpr
    if (typeof text !== 'string' || !/(?:[\\/]pkw(?:[\\/.-]|$)|dshHomePath\(\s*['"]pkw['"])/.test(text)) throw new Error('Unrecognized SQLite backend; keep service stopped')
    targets.push(row)
  }
  return targets.map(row => ({ id: row.id, ...(typeof row.name === 'string' ? { name: row.name } : {}), disabled: true }))
}

export function jsonStorageConfig(rows) {
  const matches = []
  function visit(group) {
    if (!Array.isArray(group)) throw new Error('Config must be an entry list')
    for (const row of group) {
      if (row?.id === 'storage-json') matches.push(row)
      if (row?.group && Array.isArray(row.config)) visit(row.config)
    }
  }
  visit(rows) // The original incident tree contains duplicate non-JSON entries.
  const row = matches[0]
  if (matches.length !== 1 || row.name !== '@deepseek-ai/dsh-storage-json' || row.disabled) throw new Error('Original JSON adapter must remain unique and enabled')
  const root = row.config?.root
  if (!(typeof root === 'string' && root.trim() || typeof root?.__jsExpr === 'string' && root.__jsExpr.trim())) throw new Error('Original JSON storage root is missing')
  // Only the known home expression or an absolute literal can be checked without evaluation.
  if (typeof root === 'string' ? !root.startsWith('/') : !/^dshHomePath\(\s*(['"])storages\1\s*\)$/.test(root.__jsExpr)) throw new Error('Custom JSON root expression requires manual verification')
  return structuredClone(row.config)
}

export function verifyRecovery(rows, originalJsonConfig) {
  const entries = entriesIn(rows)
  for (const [id, name] of [['storage', '@deepseek-ai/dsh-storage'], ['storage-json', '@deepseek-ai/dsh-storage-json'], ['storage-domain', '@deepseek-ai/dsh-storage-domain'], ['workspace', '@deepseek-ai/dsh-workspace']]) {
    const matches = entries.filter(row => row.id === id)
    if (matches.length !== 1 || matches[0].name !== name || matches[0].disabled || entries.filter(row => row.name === name).length !== 1) throw new Error(`Host service must remain unique and enabled: ${id}`)
    if (!rows.includes(matches[0]) || matches[0].group || matches[0].isolate != null && Object.keys(matches[0].isolate).length) throw new Error(`Host service scope requires manual verification: ${id}`)
  }
  const actualJsonConfig = jsonStorageConfig(rows)
  if (originalJsonConfig !== undefined && !isDeepStrictEqual(actualJsonConfig, originalJsonConfig)) throw new Error('Original JSON adapter configuration changed; keep service stopped')
  recoveryOverrides(rows) // Check JSON and non-PKW routes without changing them.
  if (entries.some(row => isPkw(row) && !disabled(row))) throw new Error('A PKW entry is still enabled')
  if (entries.some(row => row.name === sqliteName && !disabled(row))) throw new Error('A SQLite backend is still enabled; manual verification required')
  return { loaderIdsUnique: true, hostStorage: 'json', ...(originalJsonConfig !== undefined ? { originalJsonConfigPreserved: true } : {}), hostWorkspacePreserved: true, pkwPaused: true }
}

function atomicWrite(path, bytes, originalStat) {
  const temporary = path + `.pkw-recovery-${process.pid}`
  writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
  chmodSync(temporary, originalStat?.mode ?? 0o600)
  if (originalStat) chownSync(temporary, originalStat.uid, originalStat.gid)
  renameSync(temporary, path)
}

export function restoreConfigSnapshots(snapshots) {
  const failures = []
  for (const { path, bytes, stat } of snapshots) {
    try {
      if (bytes !== undefined) atomicWrite(path, bytes, stat)
      else if (existsSync(path)) unlinkSync(path)
    } catch { failures.push(path) }
  }
  return { configsRestored: failures.length === 0, ...(failures.length ? { failedPaths: failures } : {}) }
}

export function parseServiceEnvironment(text) {
  // systemctl uses quoted assignments for spaces. Refuse complex escapes instead of evaluating them.
  if (text.includes('\\')) throw new Error('Escaped service environment requires manual verification')
  const words = [], result = {}
  let word = '', quote = ''
  for (const char of text) {
    if (quote) { if (char === quote) quote = ''; else word += char }
    else if (char === '"' || char === "'") quote = char
    else if (/\s/.test(char)) { if (word) { words.push(word); word = '' } }
    else word += char
  }
  if (quote) throw new Error('Quoted service environment requires manual verification')
  if (word) words.push(word)
  for (const assignment of words) {
    const match = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/s.exec(assignment)
    if (!match) throw new Error('Service environment format requires manual verification')
    result[match[1]] = match[2]
  }
  return result
}

export function recoveryEnvironment(managerText, unitText, properties) {
  if (!['', 'root'].includes(properties.User) || properties.WorkingDirectory !== '/opt/deepseek-harness') throw new Error('Service user or working directory changed; manual verification required')
  if (properties.Group && properties.Group !== 'root') throw new Error('Service group requires manual verification')
  confirmedEnvironmentFile(properties.EnvironmentFiles ?? '')
  for (const name of ['PassEnvironment', 'UnsetEnvironment', 'PAMName', 'RootDirectory', 'RootImage', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem']) {
    if (properties[name]) throw new Error(`Service ${name} requires manual verification`)
  }
  if (!['', 'no'].includes(properties.DynamicUser)) throw new Error('Dynamic service user requires manual verification')
  const environment = { ...parseServiceEnvironment(managerText), ...parseServiceEnvironment(unitText) }
  return validateEffectiveEnvironment(environment)
}

export function validateEffectiveEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.entries(environment).some(([name, value]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) || typeof value !== 'string' || value.includes('\0'))) throw new Error('Effective environment format requires manual verification')
  for (const [name, expected] of [['HOME', '/root'], ['DSH_HOME', '/root/.dsh'], ['PWD', '/opt/deepseek-harness']]) {
    if (environment[name] !== undefined && environment[name] !== expected) throw new Error(`Service ${name} requires manual verification`)
  }
  if (Object.entries(environment).some(([name, value]) => value && injectionKey(name))) throw new Error('Service runtime injection requires manual verification')
  return { PATH: '/usr/local/bin:/usr/bin:/bin', ...environment, HOME: '/root', DSH_HOME: '/root/.dsh' }
}

export function confirmedEnvironmentFile(property) {
  if (!property) return undefined
  if (property !== confirmedEnvironmentPath + ' (ignore_errors=no)') throw new Error('Service EnvironmentFiles differ from the confirmed mandatory file; manual verification required')
  return confirmedEnvironmentPath
}

export function inspectEnvironmentFile(bytes) {
  // Only validate a narrow syntax subset; systemd itself will interpret the values.
  // This also prevents invalid assignments (which systemd may journal) and startup
  // injection from taking effect before the Node collector's first instruction.
  if (!Buffer.isBuffer(bytes) || bytes.length > 262144) throw new Error('Environment file size requires manual verification')
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('Environment file encoding requires manual verification')
  let content
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('Environment file encoding requires manual verification') }
  if (content.includes('\0') || content.includes('\uFEFF')) throw new Error('Environment file encoding requires manual verification')
  const names = []
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim() || /^[ \t]*[#;]/.test(line)) continue
    const match = /^[ \t]*([A-Za-z_][A-Za-z_0-9]*)[ \t]*=(.*)$/.exec(line)
    if (!match || /[\\\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) throw new Error(`Environment file syntax requires manual verification at line ${index + 1}`)
    const [, name, raw] = match
    if (injectionKey(name)) throw new Error(`Environment file runtime injection requires manual verification at line ${index + 1}`)
    const value = raw.trim()
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0] || value.slice(1, -1).includes(value[0])) throw new Error(`Environment file quotes require manual verification at line ${index + 1}`)
    } else if (/["']/.test(value)) throw new Error(`Environment file quotes require manual verification at line ${index + 1}`)
    names.push(name)
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), variables: names.length }
}

export function environmentFileIdentity(info) {
  if (!info.isFile() || info.uid !== 0 || info.mode & 0o022 || info.size > 262144) throw new Error('Environment file ownership or permissions require manual verification')
  return Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeMs', 'ctimeMs'].map(name => [name, info[name]]))
}

export function serializeProbeBaseEnvironment(environment) {
  const rows = []
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== 'string' || /[\r\n\0\\]/.test(value) || value.includes('"') && value.includes("'")) throw new Error('Base environment quoting requires manual verification')
    const quote = value.includes('"') ? "'" : '"'
    rows.push(`${name}=${quote}${value}${quote}`)
  }
  const bytes = Buffer.from(rows.join('\n') + '\n')
  inspectEnvironmentFile(bytes)
  return bytes
}

export function collectEffectiveEnvironment({ baseFile, sourceSnapshot, unitName }, execute = execFileSync) {
  if (![baseFile, sourceSnapshot].every(path => typeof path === 'string' && path.startsWith('/') && !/[\s%\\]/.test(path)) || !/^pkw-dsh-env-[a-z0-9-]+$/.test(unitName)) throw new Error('Environment probe paths require manual verification')
  const args = ['--system', '--pipe', '--wait', '--collect', '--quiet', '--service-type=exec', `--unit=${unitName}`, '--description=PKW recovery environment check', '--property=User=root', '--property=Group=root', '--property=WorkingDirectory=/opt/deepseek-harness', '--property=RuntimeMaxSec=20s', '--property=TimeoutStopSec=5s', `--property=EnvironmentFile=${baseFile}`, `--property=EnvironmentFile=${sourceSnapshot}`, '/usr/local/bin/node', '--input-type=module', '-e', 'process.stdout.write(JSON.stringify(process.env))']
  let raw
  try {
    raw = execute('systemd-run', args, { encoding: 'utf8', timeout: 35000, maxBuffer: 524288, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' } })
  } catch {
    // Never serialize a child-process exception: it may contain secret stdout/stderr.
    throw new Error('Systemd environment probe failed; no configuration was changed')
  } finally {
    // Stop only this tool's own transient probe, including after client timeout.
    try { execute('systemctl', ['stop', unitName + '.service'], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }) } catch {}
  }
  let environment
  try { environment = JSON.parse(raw) }
  catch { throw new Error('Systemd environment probe returned an invalid result') }
  return validateEffectiveEnvironment(environment)
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('Usage: node recover-dsh-without-pkw.mjs --apply')
  if (process.getuid?.() !== 0) throw new Error('Run in the server root terminal')
  const unit = 'deepseek-harness.service', harness = '/opt/deepseek-harness', profile = '/root/.dsh/profiles/web'
  const state = execFileSync('systemctl', ['show', unit, '-p', 'ActiveState', '--value'], { encoding: 'utf8' }).trim()
  if (!['inactive', 'failed'].includes(state)) throw new Error('Stop deepseek-harness.service before recovery')
  const command = execFileSync('systemctl', ['show', unit, '-p', 'ExecStart', '--value'], { encoding: 'utf8' })
  const expected = 'argv[]=/usr/local/bin/node --import tsx/esm /opt/deepseek-harness/apps/cli/src/bin.ts web --host 127.0.0.1 --port 3080 --trusted-host ddmind.duckdns.org ;'
  if (!command.includes(expected)) throw new Error('Service command changed; verify its real profile and overlays first')
  const serviceProperty = name => execFileSync('systemctl', ['show', unit, '-p', name, '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const propertyNames = ['User', 'Group', 'WorkingDirectory', 'EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment', 'PAMName', 'RootDirectory', 'RootImage', 'DynamicUser', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem']
  const properties = Object.fromEntries(propertyNames.map(name => [name, serviceProperty(name)]))
  if (execFileSync('ss', ['-ltnH', 'sport = :3080'], { encoding: 'utf8' }).trim()) throw new Error('Port 3080 is occupied; identify the running writer first')
  const serviceEnvironment = execFileSync('systemctl', ['show', unit, '-p', 'Environment', '--value'], { encoding: 'utf8' })
  const managerEnvironment = execFileSync('systemctl', ['show-environment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  let environment = recoveryEnvironment(managerEnvironment, serviceEnvironment, properties)
  const environmentPath = confirmedEnvironmentFile(properties.EnvironmentFiles)
  let environmentBytes, environmentEvidence, environmentIdentity
  if (environmentPath) {
    const info = lstatSync(environmentPath)
    environmentIdentity = environmentFileIdentity(info)
    environmentBytes = readFileSync(environmentPath)
    if (!isDeepStrictEqual(environmentFileIdentity(lstatSync(environmentPath)), environmentIdentity)) throw new Error('Environment file changed while reading')
    environmentEvidence = { path: environmentPath, ...inspectEnvironmentFile(environmentBytes) }
  }
  const yaml = createRequire(join(harness, 'vendor/include/package.json'))('js-yaml')
  const expression = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: value => typeof value === 'string', construct: value => ({ __jsExpr: value }), predicate: value => typeof value?.__jsExpr === 'string', represent: value => value.__jsExpr })
  const schema = yaml.JSON_SCHEMA.extend(expression) // Parse and preserve expressions; never evaluate them.
  const manifestFile = join(profile, 'package.json'), patchFile = join(profile, 'cordis.patch.yml'), generatedFile = join(profile, 'cordis.yml')
  if ([manifestFile, patchFile, generatedFile].some(path => existsSync(path) && lstatSync(path).isSymbolicLink())) throw new Error('Configuration uses symlinks; preserve their targets with manual recovery')
  const manifestBytes = readFileSync(manifestFile), patchExists = existsSync(patchFile)
  const patchBytes = patchExists ? readFileSync(patchFile) : Buffer.from('[]\n')
  const manifestStat = statSync(manifestFile), patchStat = patchExists ? statSync(patchFile) : undefined
  const snapshots = [{ path: manifestFile, bytes: manifestBytes, stat: manifestStat }, { path: patchFile, bytes: patchExists ? patchBytes : undefined, stat: patchStat }, { path: generatedFile, bytes: existsSync(generatedFile) ? readFileSync(generatedFile) : undefined, stat: existsSync(generatedFile) ? statSync(generatedFile) : undefined }]
  const backup = `/root/dsh-config-recovery-${new Date().toISOString().replace(/[^0-9]/g, '')}-${process.pid}`
  mkdirSync(backup, { mode: 0o700 })
  for (const [file, label] of [[manifestFile, 'package.json'], [patchFile, 'cordis.patch.yml'], [join(profile, 'cordis.yml'), 'generated-cordis.yml'], ['/root/.dsh/cordis.patch.yml', 'home-cordis.patch.yml']]) {
    if (existsSync(file)) { copyFileSync(file, join(backup, label)); chmodSync(join(backup, label), 0o600) }
  }
  const parsePrivate = (label, parse) => {
    try { return parse() }
    catch (error) {
      const log = join(backup, label + '-parse-error.log')
      writeFileSync(log, String(error.stack ?? error), { mode: 0o600 })
      throw new Error(`Configuration parsing failed; private error log: ${log}`)
    }
  }
  const manifest = parsePrivate('manifest', () => JSON.parse(manifestBytes))
  const nextManifest = recoveryManifest(manifest)
  const patches = parsePrivate('profile-patch', () => yaml.load(patchBytes.toString(), { schema })) ?? []
  if (!Array.isArray(patches)) throw new Error('Profile patch must be an array')
  const records = { profile, state, backup, removedBundles: [...bundleNames].filter(name => manifest.dsh.profile.bundles.includes(name)) }
  const assertOriginalInputs = () => {
    if (!['inactive', 'failed'].includes(serviceProperty('ActiveState')) || serviceProperty('ExecStart') !== command.trim() || propertyNames.some(name => serviceProperty(name) !== properties[name]) || serviceProperty('Environment') !== serviceEnvironment.trim() || execFileSync('systemctl', ['show-environment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) !== managerEnvironment) throw new Error('Service configuration changed during recovery')
    if (environmentPath && (!isDeepStrictEqual(environmentFileIdentity(lstatSync(environmentPath)), environmentIdentity) || !readFileSync(environmentPath).equals(environmentBytes) || !isDeepStrictEqual(environmentFileIdentity(lstatSync(environmentPath)), environmentIdentity))) throw new Error('Original environment file changed during recovery')
  }
  if (environmentPath) {
    const sourceSnapshot = join(backup, 'agent-journal.env'), baseFile = join(backup, 'probe-base.env')
    writeFileSync(sourceSnapshot, environmentBytes, { mode: 0o600, flag: 'wx' })
    writeFileSync(baseFile, serializeProbeBaseEnvironment(environment), { mode: 0o600, flag: 'wx' })
    environment = collectEffectiveEnvironment({ baseFile, sourceSnapshot, unitName: `pkw-dsh-env-${process.pid}-${Date.now()}` })
    assertOriginalInputs()
    records.environmentFile = environmentEvidence
    records.environmentProbe = 'systemd-fixed-snapshot-verified'
  }
  // Match CLI startup's environment preflight without calling boot or opening any data store.
  const environmentProbe = `import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot';
    import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
    loadLayeredEnv('dsh', process.cwd(), () => { throw new Error('Environment file is unreadable') });
    if (resolveDshHome() !== '/root/.dsh' || process.cwd() !== '/opt/deepseek-harness' || process.env.HOME !== '/root'
      || process.env.PWD !== undefined && process.env.PWD !== process.cwd()) throw new Error('Runtime home or cwd differs');
    process.stdout.write('environment-verified');`
  try {
    const probe = execFileSync('/usr/local/bin/node', ['--import', 'tsx/esm', '--input-type=module', '-e', environmentProbe], { cwd: harness, timeout: 45000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: environment })
    if (probe !== 'environment-verified') throw new Error('Unexpected environment probe output')
  } catch (error) {
    const log = join(backup, 'environment-error.log')
    writeFileSync(log, String(error.stderr ?? error.message), { mode: 0o600 })
    throw new Error(`Runtime environment preflight failed; private error log: ${log}`)
  }
  const dump = label => {
    try {
      const content = execFileSync('/usr/local/bin/node', ['--import', 'tsx/esm', join(harness, 'apps/cli/src/bin.ts'), 'web', '--dump-config'], { cwd: harness, timeout: 45000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: environment })
      writeFileSync(join(backup, label + '.yml'), content, { mode: 0o600 })
      return yaml.load(content, { schema })
    } catch (error) {
      writeFileSync(join(backup, label + '-error.log'), String(error.stderr ?? error.message), { mode: 0o600 })
      throw new Error(`Offline config dump failed; private error log: ${join(backup, label + '-error.log')}`)
    }
  }
  let changed = false
  try {
    assertOriginalInputs()
    changed = true // CLI dump may rewrite generated cordis.yml, even when it subsequently fails.
    const originalJsonConfig = jsonStorageConfig(dump('before'))
    atomicWrite(manifestFile, JSON.stringify(nextManifest, null, 2) + '\n', manifestStat)
    const overrides = recoveryOverrides(dump('without-pkw-bundles'))
    if (overrides.length) atomicWrite(patchFile, yaml.dump([...patches, ...overrides], { schema, noRefs: true }), patchStat)
    const checks = verifyRecovery(dump('effective'), originalJsonConfig)
    assertOriginalInputs()
    writeFileSync(join(backup, 'receipt.json'), JSON.stringify({ ...records, disabledIds: overrides.map(row => row.id), checks, status: 'configuration-verified-service-not-started' }, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ ...records, disabledIds: overrides.map(row => row.id), checks, status: 'configuration-verified-service-not-started' }, null, 2))
  } catch (error) {
    const restoration = changed ? restoreConfigSnapshots(snapshots) : { configsRestored: true }
    console.error(JSON.stringify({ status: 'recovery-stopped', backup, ...restoration, error: error.message }))
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ status: 'recovery-stopped', error: error.message })); process.exitCode = 1 })

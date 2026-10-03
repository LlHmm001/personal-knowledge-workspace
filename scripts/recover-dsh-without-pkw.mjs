#!/usr/bin/env node
// Configuration-only incident recovery. Never opens or migrates a data store.
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, lstatSync, chmodSync, chownSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'

const bundleNames = new Set(['@deepseek-ai/dsh-pkw-base', '@deepseek-ai/dsh-extension-pkw'])
const pkwDomains = new Set(['pkw', 'pkw_notes', 'pkw_attachments', 'pkw_tasks', 'pkw_weknora_sync'])
const sqliteName = '@deepseek-ai/dsh-storage-sqlite'
const isPkw = row => (typeof row.name === 'string' && (row.name.startsWith('@deepseek-ai/dsh-pkw-') || row.name === '@deepseek-ai/dsh-extension-pkw')) || /^pkw(?:-|$)/.test(row.id ?? '')
const disabled = row => row.disabled === true

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
  for (const name of ['EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment', 'PAMName', 'RootDirectory', 'RootImage', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem']) {
    if (properties[name]) throw new Error(`Service ${name} requires manual verification`)
  }
  if (!['', 'no'].includes(properties.DynamicUser)) throw new Error('Dynamic service user requires manual verification')
  const environment = { ...parseServiceEnvironment(managerText), ...parseServiceEnvironment(unitText) }
  for (const [name, expected] of [['HOME', '/root'], ['DSH_HOME', '/root/.dsh'], ['PWD', '/opt/deepseek-harness']]) {
    if (environment[name] !== undefined && environment[name] !== expected) throw new Error(`Service ${name} requires manual verification`)
  }
  if (Object.entries(environment).some(([name, value]) => value && (/^LD_/.test(name) || ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'].includes(name)))) throw new Error('Service runtime injection requires manual verification')
  return { PATH: '/usr/local/bin:/usr/bin:/bin', ...environment, HOME: '/root', DSH_HOME: '/root/.dsh' }
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
  const propertyNames = ['User', 'WorkingDirectory', 'EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment', 'PAMName', 'RootDirectory', 'RootImage', 'DynamicUser', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem']
  const properties = Object.fromEntries(propertyNames.map(name => [name, serviceProperty(name)]))
  if (execFileSync('ss', ['-ltnH', 'sport = :3080'], { encoding: 'utf8' }).trim()) throw new Error('Port 3080 is occupied; identify the running writer first')
  const serviceEnvironment = execFileSync('systemctl', ['show', unit, '-p', 'Environment', '--value'], { encoding: 'utf8' })
  const managerEnvironment = execFileSync('systemctl', ['show-environment'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const environment = recoveryEnvironment(managerEnvironment, serviceEnvironment, properties)
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
    changed = true // CLI dump may rewrite generated cordis.yml, even when it subsequently fails.
    const originalJsonConfig = jsonStorageConfig(dump('before'))
    atomicWrite(manifestFile, JSON.stringify(nextManifest, null, 2) + '\n', manifestStat)
    const overrides = recoveryOverrides(dump('without-pkw-bundles'))
    if (overrides.length) atomicWrite(patchFile, yaml.dump([...patches, ...overrides], { schema, noRefs: true }), patchStat)
    const checks = verifyRecovery(dump('effective'), originalJsonConfig)
    writeFileSync(join(backup, 'receipt.json'), JSON.stringify({ ...records, disabledIds: overrides.map(row => row.id), checks, status: 'configuration-verified-service-not-started' }, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify({ ...records, disabledIds: overrides.map(row => row.id), checks, status: 'configuration-verified-service-not-started' }, null, 2))
  } catch (error) {
    const restoration = changed ? restoreConfigSnapshots(snapshots) : { configsRestored: true }
    console.error(JSON.stringify({ status: 'recovery-stopped', backup, ...restoration, error: error.message }))
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ status: 'recovery-stopped', error: error.message })); process.exitCode = 1 })

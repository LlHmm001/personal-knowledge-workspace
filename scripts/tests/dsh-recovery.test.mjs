import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, chmodSync, mkdirSync, symlinkSync, unlinkSync, renameSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoveryManifest, recoveryOverrides, verifyRecovery, jsonStorageConfig, restoreConfigSnapshots, parseServiceEnvironment, recoveryEnvironment, confirmedEnvironmentFile, inspectEnvironmentFile, serializeProbeBaseEnvironment, collectEffectiveEnvironment, environmentFileIdentity, runtimeDirectoryIdentity, assertRuntimeDirectories, runtimeEnvironmentProbe, runtimePreflightFailure } from '../recover-dsh-without-pkw.mjs'

const host = () => [
  { id: 'storage', name: '@deepseek-ai/dsh-storage' },
  { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: { __jsExpr: "dshHomePath('storages')" } } },
  { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
  { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  { id: 'memory-projects', name: '@dsh-memory/memory-projects', config: { keep: 'original' } },
]

test('recovery detaches only PKW bundles and keeps installed packages and other configuration', () => {
  const manifest = { name: 'server-web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-extension-pkw', 'dsh-graphstudio', '@deepseek-ai/dsh-pkw-base'], patchReload: 'live' } }, dependencies: { '@deepseek-ai/dsh-pkw-base': '0.1.1-pkw.1', 'private-customization': 'keep' }, privateSettings: { sentinel: 'preserve' } }
  const before = structuredClone(manifest)
  const result = recoveryManifest(manifest)
  assert.deepEqual(result.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-graphstudio'])
  assert.deepEqual(manifest, before)
  result.dsh.profile.bundles = before.dsh.profile.bundles
  assert.deepEqual(result, before)
  assert.throws(() => recoveryManifest({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }), /not in this profile/)
})

test('recovery pauses remaining PKW services and their known adapter without evaluating expressions', () => {
  const rows = [...host(), { id: 'pkw-notes', name: '@deepseek-ai/dsh-pkw-notes' }, { id: 'pkw-ui', name: '@deepseek-ai/dsh-extension-pkw' }, { id: 'storage-sqlite', name: '@deepseek-ai/dsh-storage-sqlite', config: { path: { __jsExpr: "dshHomePath('pkw', 'pkw.sqlite')" } } }]
  const before = structuredClone(rows)
  const patches = recoveryOverrides(rows)
  assert.deepEqual(patches.map(row => row.id), ['pkw-notes', 'pkw-ui', 'storage-sqlite'])
  assert.deepEqual(rows, before)
  const effective = rows.map(row => ({ ...row, ...patches.find(patch => patch.id === row.id) }))
  assert.equal(verifyRecovery(effective).pkwPaused, true)
  assert.deepEqual(effective.filter(row => row.id === 'memory-projects'), before.filter(row => row.id === 'memory-projects'))
})

test('recovery rejects disabled duplicates and a later patch that reactivates PKW', () => {
  assert.throws(() => verifyRecovery([...host(), { id: 'storage', name: '@deepseek-ai/dsh-storage', disabled: true }]), /Duplicate loader/)
  assert.throws(() => verifyRecovery([...host(), { id: 'renamed-storage', name: '@deepseek-ai/dsh-storage' }]), /unique and enabled/)
  assert.throws(() => verifyRecovery([...host(), { id: 'pkw-notes', name: '@deepseek-ai/dsh-pkw-notes' }]), /still enabled/)
})

test('recovery never changes a non-PKW storage route or guesses another SQLite database', () => {
  for (const domain of [{ backend: 'sqlite' }, { backend: 'json', routes: { workspace: 'sqlite' } }, { backend: 'json', routes: { session_projcache: 'sqlite' } }]) {
    const rows = host().map(row => row.id === 'storage-domain' ? { ...row, config: domain } : row)
    assert.throws(() => recoveryOverrides(rows), /manual verification/)
  }
  assert.throws(() => recoveryOverrides([...host(), { id: 'storage-sqlite', name: '@deepseek-ai/dsh-storage-sqlite', config: { path: '/root/another-database.sqlite' } }]), /Unrecognized SQLite/)
})

test('recovery checks nested group IDs and preserves original host services', () => {
  const rows = [...host(), { id: 'custom-group', name: 'cordis:group', group: true, config: [{ id: 'pkw-helper', name: '/root/custom-pkw.mjs', disabled: true }] }]
  assert.equal(verifyRecovery(rows).hostWorkspacePreserved, true)
  rows.at(-1).config.push({ id: 'pkw-helper', name: '/root/second.mjs', disabled: true })
  assert.throws(() => verifyRecovery(rows), /Duplicate loader/)
  assert.throws(() => verifyRecovery(host().map(row => row.id === 'workspace' ? { ...row, disabled: true } : row)), /must remain unique/)
})

test('recovery rejects a missing or disabled JSON adapter and any change to its original root', () => {
  const original = jsonStorageConfig([...host(), { id: 'storage', name: '@deepseek-ai/dsh-storage' }])
  assert.equal(verifyRecovery(host(), original).originalJsonConfigPreserved, true)
  assert.throws(() => verifyRecovery(host().filter(row => row.id !== 'storage-json')), /unique and enabled/)
  assert.throws(() => verifyRecovery(host().map(row => row.id === 'storage-json' ? { ...row, disabled: true } : row)), /unique and enabled/)
  assert.throws(() => verifyRecovery(host().map(row => row.id === 'storage-json' ? { ...row, config: { root: '/root/new-empty-storages' } } : row), original), /configuration changed/)
  assert.throws(() => jsonStorageConfig(host().map(row => row.id === 'storage-json' ? { ...row, config: { root: { __jsExpr: 'process.env.OTHER_HOME' } } } : row)), /manual verification/)
})

test('failure rollback restores generated config bytes and modes, including before-dump side effects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pkw-config-rollback-'))
  try {
    const generated = join(directory, 'cordis.yml'), addedPatch = join(directory, 'cordis.patch.yml')
    writeFileSync(generated, '# original generated file\n[]\n', { mode: 0o640 })
    const snapshot = { path: generated, bytes: readFileSync(generated), stat: statSync(generated) }
    writeFileSync(generated, '[]\n')
    chmodSync(generated, 0o600)
    writeFileSync(addedPatch, '- id: paused\n')
    const result = restoreConfigSnapshots([snapshot, { path: addedPatch, bytes: undefined }])
    assert.equal(result.configsRestored, true)
    assert.deepEqual(readFileSync(generated), snapshot.bytes)
    assert.equal(statSync(generated).mode & 0o777, 0o640)
    assert.equal(existsSync(addedPatch), false)
    const partial = restoreConfigSnapshots([{ path: join(directory, 'absent', 'package.json'), bytes: Buffer.from('{}\n') }, snapshot])
    assert.equal(partial.configsRestored, false)
    assert.equal(partial.failedPaths.length, 1)
    assert.deepEqual(readFileSync(generated), snapshot.bytes)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('recovery uses verified service environment rather than the interactive shell', () => {
  const properties = { User: 'root', WorkingDirectory: '/opt/deepseek-harness', DynamicUser: 'no' }
  const environment = recoveryEnvironment('LANG=C.UTF-8\nDSH_HOME=/root/.dsh', '"PLAIN_SETTING=a b" HOME=/root', properties)
  assert.equal(environment.PLAIN_SETTING, 'a b')
  assert.equal(environment.LANG, 'C.UTF-8')
  assert.equal(environment.DSH_HOME, '/root/.dsh')
  for (const change of [{ User: 'someone' }, { WorkingDirectory: '/another' }, { EnvironmentFiles: '/root/private-env' }, { PassEnvironment: 'DSH_HOME' }, { DynamicUser: 'yes' }, { RootDirectory: '/other-root' }]) {
    assert.throws(() => recoveryEnvironment('', '', { ...properties, ...change }), /manual verification/)
  }
  for (const text of ['HOME=/another', 'DSH_HOME=/other', 'PWD=/somewhere', 'NODE_OPTIONS=--require=other', 'LD_PRELOAD=/other.so']) {
    assert.throws(() => recoveryEnvironment(text, '', properties), /manual verification/)
  }
  assert.deepEqual(parseServiceEnvironment('A="two words" B=literal$(no-execution)'), { A: 'two words', B: 'literal$(no-execution)' })
  assert.throws(() => parseServiceEnvironment('PRIVATE_VALUE="unterminated'), error => !error.message.includes('PRIVATE_VALUE') && /manual verification/.test(error.message))
  assert.throws(() => parseServiceEnvironment('PRIVATE_VALUE=escaped\\value'), error => !error.message.includes('PRIVATE_VALUE') && /manual verification/.test(error.message))
})

const confirmedFile = '/LlHmm9527/memory-hub/state/keys/agent-journal.env'

test('environment file support is limited to the confirmed mandatory path and root service', () => {
  assert.equal(confirmedEnvironmentFile(''), undefined)
  assert.equal(confirmedEnvironmentFile(confirmedFile + ' (ignore_errors=no)'), confirmedFile)
  for (const value of [confirmedFile + ' (ignore_errors=yes)', confirmedFile + ' (ignore_errors=no) /root/extra.env (ignore_errors=no)', '/root/other.env (ignore_errors=no)']) {
    assert.throws(() => confirmedEnvironmentFile(value), /manual verification/)
  }
  const properties = { User: 'root', Group: 'root', WorkingDirectory: '/opt/deepseek-harness', DynamicUser: 'no', EnvironmentFiles: confirmedFile + ' (ignore_errors=no)' }
  assert.equal(recoveryEnvironment('', '', properties).DSH_HOME, '/root/.dsh')
  assert.throws(() => recoveryEnvironment('', '', { ...properties, Group: 'another' }), /manual verification/)
})

test('environment file validation rejects injection and malformed records before starting any collector', () => {
  const sentinel = 'fixture-private-value'
  const bytes = Buffer.from('# keep private\nAGENT_JOURNAL_KEY="' + sentinel + '"\nLITERAL=$(no-execution)\nLABEL=\'some words\'\nEMPTY=\n')
  assert.equal(inspectEnvironmentFile(bytes).variables, 4)
  for (const content of ['NODE_OPTIONS=--require=fixture\n', 'LD_PRELOAD=/tmp/fixture.so\n', 'NODE_PATH=/other\n', 'INVALID NAME=' + sentinel + '\n', 'KEY="' + sentinel + '\n', 'KEY=some\\\nthing\n', 'KEY=two"quotes\n', 'KEY=\0' + sentinel]) {
    assert.throws(() => inspectEnvironmentFile(Buffer.from(content)), error => /manual verification/.test(error.message) && !error.message.includes(sentinel) && !error.message.includes('--require'))
  }
  assert.throws(() => inspectEnvironmentFile(Buffer.from([0xff])), /encoding/)
  assert.throws(() => inspectEnvironmentFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('KEY=fixture\n')])), /encoding/)
  assert.throws(() => inspectEnvironmentFile(Buffer.alloc(262145)), /size/)
})

test('private base layer preserves simple values and refuses ambiguous serialization without revealing values', () => {
  const environment = { HOME: '/root', LABEL: 'two words', SHELL_LOOKING: '$(must-stay-literal)', QUOTE: 'some"text', EMPTY: '' }
  const bytes = serializeProbeBaseEnvironment(environment)
  assert.equal(inspectEnvironmentFile(bytes).variables, 5)
  assert.ok(bytes.toString().includes("QUOTE='some\"text'"))
  for (const secret of ['fixture-secret\nsecond-line', 'fixture-secret\\escape', 'fixture-secret\'and"both']) {
    assert.throws(() => serializeProbeBaseEnvironment({ PRIVATE_KEY: secret }), error => !error.message.includes('fixture-secret'))
  }
})

test('systemd capture uses private ordered files and inherited pipes while keeping secret values out of argv', () => {
  const sentinel = 'fixture-private-file-value'
  const calls = []
  const result = collectEffectiveEnvironment({ baseFile: '/root/private/base.env', sourceSnapshot: '/root/private/source.env', unitName: 'pkw-dsh-env-fixture' }, (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'systemctl') return ''
    assert.equal(command, 'systemd-run')
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.ok(args.includes('--pipe') && args.includes('--wait') && args.includes('--collect'))
    assert.ok(args.indexOf('--property=EnvironmentFile=/root/private/base.env') < args.indexOf('--property=EnvironmentFile=/root/private/source.env'))
    assert.ok(!JSON.stringify({ args, options }).includes(sentinel))
    // The native collector result is authoritative: its file value must not be
    // overwritten later by a lower-priority value from the original unit.
    return JSON.stringify({ HOME: '/root', DSH_HOME: '/root/.dsh', PRIVATE_KEY: sentinel })
  })
  assert.equal(result.PRIVATE_KEY, sentinel)
  assert.deepEqual(calls.at(-1).args, ['stop', 'pkw-dsh-env-fixture.service'])
  assert.ok(!JSON.stringify(calls).includes(sentinel))
})

test('collector failure or malformed output never exposes secret stdout or stderr and cleans its own unit', () => {
  for (const outcome of ['exception', 'malformed', 'wrong-home', 'injection']) {
    const calls = [], sentinel = 'fixture-private-result'
    assert.throws(() => collectEffectiveEnvironment({ baseFile: '/root/private/base.env', sourceSnapshot: '/root/private/source.env', unitName: 'pkw-dsh-env-failure' }, (command, args) => {
      calls.push({ command, args })
      if (command === 'systemctl') return ''
      if (outcome === 'exception') throw Object.assign(new Error(sentinel), { stdout: sentinel, stderr: sentinel })
      if (outcome === 'malformed') return sentinel
      if (outcome === 'wrong-home') return JSON.stringify({ HOME: '/wrong', PRIVATE_KEY: sentinel })
      return JSON.stringify({ HOME: '/root', NODE_OPTIONS: sentinel })
    }), error => !error.message.includes(sentinel))
    assert.deepEqual(calls.at(-1), { command: 'systemctl', args: ['stop', 'pkw-dsh-env-failure.service'] })
  }
})

test('environment identity rejects symlinks, unsafe ownership and permissions and detects identical-byte replacement', () => {
  const info = { isFile: () => true, uid: 0, gid: 0, mode: 0o100600, size: 20, dev: 1, ino: 10, mtimeMs: 1, ctimeMs: 1 }
  const before = environmentFileIdentity(info)
  assert.notDeepEqual(environmentFileIdentity({ ...info, ino: 11 }), before)
  assert.notDeepEqual(environmentFileIdentity({ ...info, mode: 0o100640 }), before)
  for (const change of [{ isFile: () => false }, { uid: 1000 }, { mode: 0o100622 }, { size: 262145 }]) {
    assert.throws(() => environmentFileIdentity({ ...info, ...change }), /manual verification/)
  }
})

test('runtime directory checks accept Node physical cwd and logical PWD through a release symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pkw-recovery-cwd-'))
  try {
    const release = join(directory, 'release'), logical = join(directory, 'harness')
    mkdirSync(release)
    symlinkSync(release, logical)
    const expected = runtimeDirectoryIdentity(logical)
    const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD}))'], { cwd: logical, env: { PWD: logical }, encoding: 'utf8' }))
    assert.notEqual(child.cwd, logical) // Reproduces the old preflight's false rejection.
    assert.notEqual(child.pwd, child.cwd)
    assert.equal(child.cwd, expected.canonical)
    assert.doesNotThrow(() => assertRuntimeDirectories(logical, expected, child.cwd, child.pwd))
    assert.doesNotThrow(() => assertRuntimeDirectories(logical, expected, child.cwd, undefined))
    for (const pwd of ['', join(directory, 'absent'), directory]) {
      assert.throws(() => assertRuntimeDirectories(logical, expected, child.cwd, pwd), /PKW_RECOVERY_CWD_MISMATCH/)
    }
    const file = join(directory, 'not-a-directory')
    writeFileSync(file, '')
    assert.throws(() => runtimeDirectoryIdentity(file), /not a directory/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('runtime snapshot rejects a switched release link and replacement at the same physical path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pkw-recovery-switch-'))
  try {
    const first = join(directory, 'release-a'), second = join(directory, 'release-b'), logical = join(directory, 'harness')
    mkdirSync(first); mkdirSync(second); symlinkSync(first, logical)
    const expected = runtimeDirectoryIdentity(logical)
    unlinkSync(logical); symlinkSync(second, logical)
    assert.throws(() => assertRuntimeDirectories(logical, expected, expected.canonical, undefined), /PKW_RECOVERY_CWD_MISMATCH/)
    unlinkSync(logical); symlinkSync(first, logical)
    renameSync(first, join(directory, 'old-release-a')); mkdirSync(first)
    assert.equal(runtimeDirectoryIdentity(logical).canonical, expected.canonical)
    assert.notEqual(runtimeDirectoryIdentity(logical).ino, expected.ino)
    assert.throws(() => assertRuntimeDirectories(logical, expected, first, logical), /PKW_RECOVERY_CWD_MISMATCH/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('generated runtime preflight executes symlink checks and keeps home and post-layer guards', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pkw-recovery-probe-'))
  try {
    const release = join(directory, 'release'), logical = join(directory, 'harness')
    mkdirSync(release); symlinkSync(release, logical)
    for (const [name, source] of [
      ['dsh-app-boot', "import { writeFileSync } from 'node:fs'; if (process.env.FIXTURE_IMPORT_MARKER) writeFileSync(process.env.FIXTURE_IMPORT_MARKER, 'imported'); export function loadLayeredEnv() { if (process.env.FIXTURE_LAYER_CHANGES_PWD) process.env.PWD = process.env.FIXTURE_LAYER_CHANGES_PWD; }"],
      ['dsh-home-paths', 'export function resolveDshHome() { return process.env.DSH_HOME; }'],
    ]) {
      const path = join(release, 'node_modules', '@deepseek-ai', name)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
      writeFileSync(join(path, 'index.js'), source)
    }
    const probe = runtimeEnvironmentProbe(logical, runtimeDirectoryIdentity(logical))
    const env = { HOME: '/root', DSH_HOME: '/root/.dsh', PWD: logical }
    const run = changes => execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: logical, env: { ...env, ...changes }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(run({}), 'environment-verified')
    assert.throws(() => run({ HOME: '/wrong' }), error => runtimePreflightFailure(error) === 'PKW_RECOVERY_HOME_MISMATCH')
    assert.throws(() => run({ DSH_HOME: '/wrong' }), error => runtimePreflightFailure(error) === 'PKW_RECOVERY_HOME_MISMATCH')
    assert.throws(() => run({ PWD: directory }), error => runtimePreflightFailure(error) === 'PKW_RECOVERY_CWD_MISMATCH')
    assert.throws(() => run({ FIXTURE_LAYER_CHANGES_PWD: directory }), error => runtimePreflightFailure(error) === 'PKW_RECOVERY_CWD_MISMATCH')
    const replacement = join(directory, 'replacement'), marker = join(directory, 'import-marker')
    cpSync(release, replacement, { recursive: true })
    unlinkSync(logical); symlinkSync(replacement, logical)
    assert.throws(() => run({ FIXTURE_IMPORT_MARKER: marker }), error => runtimePreflightFailure(error) === 'PKW_RECOVERY_CWD_MISMATCH')
    assert.equal(existsSync(marker), false) // Reject before importing another release's Harness modules.
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('runtime failure categories retain empty-stderr codes without exposing private child output', () => {
  const secret = 'fixture-private-diagnostic-value'
  for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS']) {
    assert.equal(runtimePreflightFailure({ code, stderr: Buffer.alloc(0), message: secret }), code)
  }
  assert.equal(runtimePreflightFailure({ stderr: secret + ' only the launching environment may set' }), 'ENV_BOOTSTRAP_REJECTED')
  assert.equal(runtimePreflightFailure({ stderr: secret + ' does not provide an export named' }), 'MODULE_EXPORT_MISSING')
  assert.equal(runtimePreflightFailure({ code: secret, stderr: secret, message: secret }), 'UNCLASSIFIED')
})

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { compareInstallationManifests, installationFiles, installationInventory,
  parseRestoreOptions, restoreInstallation, verifyCandidateLinks,
  verifyCopiedInstallation } from '../restore-dsh-installation-snapshot.mjs';

const moduleUrl = new URL('../restore-dsh-installation-snapshot.mjs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = path => hash(fs.readFileSync(path));
const exists = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const inside = (root, path) => path === root || path.startsWith(root + '/');
const fault = code => Object.assign(new Error(code), { code });
const hostNames = Array.from({ length: 12 }, (_, i) => `@example/host-${String(i).padStart(2, '0')}`);

function temporaryRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dsh-installation-restore-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(path, contents, mode = 0o644) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, contents, { mode });
}

function packageFixture(directory, name, generation) {
  write(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }));
  const dependency = name === hostNames[7]
    ? `import { identity as dependencyIdentity } from ${JSON.stringify(hostNames[8])};\nexport { dependencyIdentity };\n` : '';
  write(join(directory, 'index.js'), dependency + `export const identity = {};\nexport const generation = ${JSON.stringify(generation)};\n`);
  write(join(directory, 'bin', 'tool.mjs'), 'export const tool = true;\n', 0o755);
}

function copyMembers(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of installationFiles) {
    if (exists(join(source, name))) fs.cpSync(join(source, name), join(destination, name), {
      recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
    });
  }
}

function fixture(t) {
  const root = temporaryRoot(t), profile = join(root, 'profiles', 'web');
  const backup = join(root, 'data', 'backup'), workRoot = join(root, 'data', 'evidence');
  fs.mkdirSync(workRoot, { recursive: true });
  const manifest = { name: 'example-profile', private: true, type: 'module',
    dependencies: { ...Object.fromEntries(hostNames.map(name => [name, '1.0.0'])),
      '@deepseek-ai/dsh-pkw-web': '0.1.0-pkw.1' },
    dsh: { profile: { bundles: ['@example/host-bundle'], patchReload: 'live' } } };
  write(join(profile, 'package.json'), JSON.stringify(manifest));
  write(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# historical installation\n');
  write(join(profile, '.npmrc'), 'auto-install-peers=false\n', 0o600);
  for (const [i, name] of hostNames.entries()) {
    packageFixture(join(i < 8 ? profile : dirname(profile), 'node_modules', name), name, 'historical');
  }
  write(join(profile, 'node_modules', '.modules.yaml'), 'nodeLinker: hoisted\n');
  write(join(profile, 'node_modules', '.pnpm', 'fixture-store', 'index.js'), 'export const internalLink = true;\n');
  fs.symlinkSync('.pnpm/fixture-store', join(profile, 'node_modules', 'relative-store'));
  fs.symlinkSync('../../node_modules/' + hostNames[8], join(profile, 'node_modules', 'parent-link'));
  const require = createRequire(join(profile, 'package.json'));
  const beforeHost = Object.fromEntries(hostNames.map(name => [name, hashFile(require.resolve(name))]));
  copyMembers(profile, backup);

  const currentManifest = structuredClone(manifest);
  currentManifest.dependencies['@deepseek-ai/dsh-pkw-web'] = '0.2.0-pkw.1';
  write(join(profile, 'package.json'), JSON.stringify(currentManifest));
  write(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# interrupted candidate installation\n');
  write(join(profile, 'package-lock.json'), '{"name":"interrupted-installation"}\n');
  for (const name of hostNames.slice(0, 8)) packageFixture(join(profile, 'node_modules', name), name, 'current');
  write(join(profile, 'cordis.patch.yml'), '- id: host-example\n  disabled: false\n');
  write(join(profile, 'cordis.yml'), '[]\n');
  write(join(profile, 'pnpm-workspace.yaml'), 'packages: [.]\nnodeLinker: hoisted\n');
  write(join(profile, 'state.sqlite'), Buffer.from('fixture database bytes: never opened or restored'));
  write(join(profile, 'workspace', 'note.md'), '# Existing user note\n');
  write(join(profile, 'workspace', 'attachment.bin'), Buffer.from([0, 1, 2, 255]));
  const receipt = join(root, 'data', 'receipt.json');
  write(receipt, JSON.stringify({ profile, beforeHost, status: 'activating' }), 0o600);
  const options = { profile, backup, workRoot, receipt,
    currentManifestHash: hashFile(join(profile, 'package.json')),
    currentLockHash: hashFile(join(profile, 'pnpm-lock.yaml')),
    backupManifestHash: hashFile(join(backup, 'package.json')),
    backupLockHash: hashFile(join(backup, 'pnpm-lock.yaml')) };
  const protectedNames = ['cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'state.sqlite', 'workspace'];
  return { root, profile, backup, workRoot, receipt, beforeHost, options, protectedNames,
    original: installationInventory(profile), historical: installationInventory(backup),
    protectedBefore: installationInventory(profile, protectedNames) };
}

// This child imports fixture libraries only. It never invokes the CLI or a
// plugin, connects to a service, runs a package manager, or opens a database.
function runtimeProbe(profile, expected) {
  const code = `
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const profile = ${JSON.stringify(profile)}, expected = ${JSON.stringify(expected)};
    const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const require = createRequire(profile + '/package.json'), hosts = [], modules = new Map();
    for (const [name, sha256] of Object.entries(expected)) {
      const path = require.resolve(name), real = fs.realpathSync(path);
      assert.equal(hash(real), sha256, name);
      hosts.push({name, path, real, sha256});
      modules.set(name, await import(pathToFileURL(real).href));
    }
    assert.equal(modules.get(${JSON.stringify(hostNames[7])}).dependencyIdentity,
      modules.get(${JSON.stringify(hostNames[8])}).identity, 'parent fallback must share one ESM module instance');
    const inputs = ['package.json', 'pnpm-lock.yaml', '.npmrc', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml']
      .filter(name => fs.existsSync(profile + '/' + name)).map(name => [profile + '/' + name, hash(profile + '/' + name)]);
    process.stdout.write(JSON.stringify({hosts, configuration:{inputs}}));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', stdio: 'pipe', timeout: 10000,
  }));
}

function hooksFor(f, overrides = {}) {
  const calls = { state: 0, writers: 0, space: [], runtime: [], recheck: [], phases: [] };
  const hooks = {
    checkState() { calls.state++; },
    checkWriters() { calls.writers++; },
    checkSpace(candidateBytes, savedBytes) { calls.space.push([candidateBytes, savedBytes]); },
    async checkRuntime(profile, expected) {
      calls.runtime.push(profile);
      assert.equal(dirname(profile), dirname(f.profile), 'candidate must preserve the original parent fallback');
      assert.deepEqual(expected, f.beforeHost);
      return runtimeProbe(profile, expected);
    },
    recheckRuntime(report, ignoredRoot) {
      calls.recheck.push(ignoredRoot);
      for (const row of report.hosts) {
        if (ignoredRoot && inside(ignoredRoot, row.path)) continue;
        assert.equal(fs.realpathSync(row.path), row.real);
        assert.equal(hashFile(row.real), row.sha256);
      }
      for (const [path, expected] of report.configuration.inputs) {
        if (ignoredRoot && inside(ignoredRoot, path)) continue;
        assert.equal(hashFile(path), expected);
      }
    },
    progress(phase, evidence) { calls.phases.push([phase, evidence]); },
    ...overrides,
  };
  return { hooks, calls };
}

function assertProtected(f) {
  assert.deepEqual(installationInventory(f.profile, f.protectedNames), f.protectedBefore);
}

function assertOriginalObjects(f, directory) {
  const inventory = installationInventory(directory);
  assert.equal(inventory.sha256, f.original.sha256);
  const before = new Map(f.original.identities.map(row => [row[0], row]));
  for (const row of inventory.identities) {
    const previous = before.get(row[0]);
    assert.deepEqual(row.slice(1, 5), previous.slice(1, 5), 'original inode, size and mtime must survive rename');
  }
}

test('restoration module can be parsed and imported without running system commands', () => {
  execFileSync(process.execPath, ['--check', fileURLToPath(moduleUrl)], { stdio: 'pipe' });
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(moduleUrl.href)}); process.stdout.write('import-only');`], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(output, 'import-only');
});

test('manifest comparison permits only PKW version changes and leaves both inputs untouched', t => {
  const f = fixture(t);
  const current = JSON.parse(fs.readFileSync(join(f.profile, 'package.json')));
  const backup = JSON.parse(fs.readFileSync(join(f.backup, 'package.json')));
  const before = structuredClone([current, backup]);
  compareInstallationManifests(current, backup);
  assert.deepEqual([current, backup], before);
  for (const [mutate, code] of [
    [m => { m.dsh.profile.patchReload = 'startup'; }, 'HOST_MANIFEST_CONFIGURATION_CHANGED'],
    [m => { m.dsh.profile.bundles.push('@example/other-host'); }, 'HOST_MANIFEST_CONFIGURATION_CHANGED'],
    [m => { m.dependencies[hostNames[0]] = '2.0.0'; }, 'HOST_MANIFEST_CONFIGURATION_CHANGED'],
    [m => { m.scripts = { start: 'unexpected' }; }, 'HOST_MANIFEST_CONFIGURATION_CHANGED'],
    [m => { delete m.dependencies['@deepseek-ai/dsh-pkw-web']; }, 'PKW_DEPENDENCY_SET_CHANGED'],
    [m => { m.dependencies['@deepseek-ai/dsh-pkw-notes'] = '1.0.0'; }, 'PKW_DEPENDENCY_SET_CHANGED'],
  ]) {
    const changed = structuredClone(current); mutate(changed);
    assert.throws(() => compareInstallationManifests(changed, backup), { code });
  }
});

test('invalid manifests and enabled PKW bundles cannot authorize an installation restore', () => {
  for (const manifest of [null, [], {}, { dependencies: [] },
    { dependencies: { '@example/host': 123 }, dsh: { profile: { bundles: [] } } },
    { dependencies: { '@deepseek-ai/dsh-pkw-web': 123 }, dsh: { profile: { bundles: [] } } },
  ]) assert.throws(() => compareInstallationManifests(manifest, manifest), { code: 'INVALID_MANIFEST' });
  for (const name of ['@deepseek-ai/dsh-pkw-base', '@deepseek-ai/dsh-extension-pkw']) {
    const manifest = { dependencies: {}, dsh: { profile: { bundles: [name] } } };
    assert.throws(() => compareInstallationManifests(manifest, manifest), { code: 'PKW_STILL_BUNDLED' });
  }
});

test('inventory retains literal links without following them and binds content, type and mode', t => {
  const root = temporaryRoot(t), installation = join(root, 'installation');
  write(join(installation, 'package.json'), '{}\n');
  fs.symlinkSync('../not-present', join(installation, 'node_modules'));
  const before = installationInventory(installation);
  assert.deepEqual(before.rows.find(row => row.path === 'node_modules'), {
    path: 'node_modules', type: 'link', target: '../not-present', mode: fs.lstatSync(join(installation, 'node_modules')).mode & 0o7777,
    uid: process.getuid(), gid: process.getgid(),
  });
  assert.equal(before.bytes, 3);
  fs.chmodSync(join(installation, 'package.json'), 0o600);
  assert.notEqual(installationInventory(installation).sha256, before.sha256);
  for (const member of ['', '..', '../outside', '/absolute']) {
    assert.throws(() => installationInventory(installation, [member]), { code: 'INVALID_INSTALLATION_MEMBER' });
  }
});

test('copy verification rejects content or mode drift and shared source inodes', t => {
  const root = temporaryRoot(t), source = join(root, 'source'), target = join(root, 'target');
  write(join(source, 'package.json'), '{}\n');
  fs.mkdirSync(target);
  const inventory = installationInventory(source);
  fs.linkSync(join(source, 'package.json'), join(target, 'package.json'));
  assert.throws(() => verifyCopiedInstallation(source, target, inventory), { code: 'INSTALLATION_COPY_SHARED_INODE' });
  fs.unlinkSync(join(target, 'package.json'));
  fs.copyFileSync(join(source, 'package.json'), join(target, 'package.json'));
  assert.equal(verifyCopiedInstallation(source, target, inventory).sha256, inventory.sha256);
  fs.chmodSync(join(target, 'package.json'), 0o600);
  assert.throws(() => verifyCopiedInstallation(source, target, inventory), { code: 'INSTALLATION_COPY_MISMATCH' });
  fs.chmodSync(join(target, 'package.json'), 0o644);
  fs.writeFileSync(join(target, 'package.json'), '{"changed":true}\n');
  assert.throws(() => verifyCopiedInstallation(source, target, inventory), { code: 'INSTALLATION_COPY_MISMATCH' });
});

test('candidate links allow local relative packages and shared fallback but reject live, backup and indirect aliases', t => {
  const f = fixture(t), candidate = join(dirname(f.profile), 'candidate');
  copyMembers(f.backup, candidate);
  verifyCandidateLinks(candidate, f.profile, f.backup, installationInventory(candidate));
  const alias = join(f.root, 'alias-to-live');
  fs.symlinkSync(f.profile, alias);
  const link = join(candidate, 'node_modules', 'borrowed');
  for (const target of [join(f.profile, 'node_modules'), join(f.backup, 'node_modules'),
    relative(dirname(link), join(f.profile, 'node_modules')), join(alias, 'node_modules')]) {
    fs.symlinkSync(target, link);
    assert.throws(() => verifyCandidateLinks(candidate, f.profile, f.backup, installationInventory(candidate)),
      { code: 'CANDIDATE_LINK_BORROWS_INSTALLATION' }, target);
    fs.unlinkSync(link);
  }
});

test('successful restore verifies all twelve peers at both locations while preserving original objects and user data', async t => {
  const f = fixture(t), { hooks, calls } = hooksFor(f);
  assert.throws(() => createRequire(join(f.backup, 'package.json')).resolve(hostNames[8]), { code: 'MODULE_NOT_FOUND' });
  const result = await restoreInstallation(f.options, hooks);
  assert.equal(result.status, 'installation-restored-verified');
  assert.equal(result.servicesStarted, false);
  assert.equal(result.databasesRestored, false);
  assert.equal(result.pnpmWorkspacePreserved, true);
  assert.equal(installationInventory(f.profile).sha256, f.historical.sha256);
  assertOriginalObjects(f, result.retainedOriginal);
  assert.equal(installationInventory(join(result.evidence, 'previous-installation')).sha256, f.original.sha256);
  verifyCopiedInstallation(f.backup, f.profile, f.historical);
  assert.deepEqual(installationInventory(f.backup), f.historical);
  assertProtected(f);
  assert.deepEqual(calls.runtime, [result.candidate, f.profile]);
  assert.ok(calls.recheck.includes(result.candidate), 'post-switch check must exclude moved candidate inputs only');
  assert.deepEqual(calls.space[0], [f.historical.bytes, f.original.bytes]);
  assert.ok(calls.space.length >= 2);
  assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
  assert.equal(exists(join(f.profile, 'package-lock.json')), false, 'a current-only install member is retained elsewhere');
  assert.equal(fs.readlinkSync(join(f.profile, 'node_modules', 'relative-store')), '.pnpm/fixture-store');
  const journal = JSON.parse(fs.readFileSync(join(result.evidence, 'journal.json')));
  assert.equal(journal.status, result.status);
  assert.equal(journal.steps.length, 9);
  assert.ok(journal.steps.every(step => step.state === 'done'));
});

for (const mask of [0o077, 0o022]) {
  test(`complete restoration preserves exact metadata under child umask ${mask.toString(8)}`, () => {
    // Changing umask in this test worker would affect concurrent filesystem tests.
    // Links are created under the child's mask: unlike Linux, macOS stores a
    // symlink mode that can vary with umask. This does not claim to repair old
    // macOS link modes created under a different mask.
    const code = `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs';
      import { createHash } from 'node:crypto';
      import { execFileSync } from 'node:child_process';
      import { createRequire } from 'node:module';
      import { tmpdir } from 'node:os';
      import { dirname, join } from 'node:path';
      import { installationFiles, installationInventory, restoreInstallation,
        verifyCopiedInstallation } from ${JSON.stringify(moduleUrl.href)};
      const hash = ${hash}, hashFile = ${hashFile}, exists = ${exists}, inside = ${inside};
      const hostNames = ${JSON.stringify(hostNames)};
      ${[temporaryRoot, write, packageFixture, copyMembers, fixture, runtimeProbe,
        hooksFor, assertProtected, assertOriginalObjects].map(fn => fn.toString()).join('\n')}
      process.umask(${mask});
      const cleanup = [], f = fixture({ after(fn) { cleanup.push(fn); } });
      try {
        for (const directory of [f.profile, f.backup]) {
          const modules = join(directory, 'node_modules'), varied = join(modules, 'permission-fixture');
          fs.mkdirSync(varied); fs.mkdirSync(join(varied, 'empty'));
          fs.writeFileSync(join(varied, 'plain.txt'), 'metadata fixture\\n');
          fs.writeFileSync(join(varied, 'run.mjs'), 'export const runnable = true;\\n');
          fs.symlinkSync('plain.txt', join(varied, 'raw-link'));
          fs.chmodSync(modules, 0o755);
          fs.chmodSync(varied, 0o755);
          fs.chmodSync(join(varied, 'empty'), 0o750);
          fs.chmodSync(join(varied, 'plain.txt'), 0o644);
          fs.chmodSync(join(varied, 'run.mjs'), 0o755);
        }
        f.original = installationInventory(f.profile);
        f.historical = installationInventory(f.backup);
        const { hooks, calls } = hooksFor(f);
        const result = await restoreInstallation(f.options, hooks);
        assert.equal(result.status, 'installation-restored-verified');
        assert.equal(installationInventory(f.profile).sha256, f.historical.sha256);
        assert.deepEqual(installationInventory(f.backup), f.historical);
        assertOriginalObjects(f, result.retainedOriginal);
        assertProtected(f);
        verifyCopiedInstallation(f.backup, f.profile, f.historical);
        assert.deepEqual(calls.runtime, [result.candidate, f.profile]);
        for (const directory of [f.profile, result.retainedOriginal,
          join(result.evidence, 'previous-installation')]) {
          const rows = installationInventory(directory).rows;
          for (const [name, mode] of [['', 0o755], ['/empty', 0o750], ['/plain.txt', 0o644], ['/run.mjs', 0o755]]) {
            assert.equal(rows.find(row => row.path === 'node_modules/permission-fixture' + name).mode, mode);
          }
          assert.equal(fs.readlinkSync(join(directory, 'node_modules/permission-fixture/raw-link')), 'plain.txt');
        }
        assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
        process.stdout.write(JSON.stringify({status: result.status, mask: process.umask().toString(8)}));
      } finally { for (const fn of cleanup.reverse()) fn(); }
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-'], {
      input: code, encoding: 'utf8', stdio: 'pipe', timeout: 20000,
    }));
    assert.deepEqual(result, { status: 'installation-restored-verified', mask: mask.toString(8) });
  });
}

for (let failedStep = 1; failedStep <= 9; failedStep++) {
  test(`failure before rename ${failedStep} reverses completed renames without replacing original files`, async t => {
    const f = fixture(t);
    let count = 0;
    const { hooks } = hooksFor(f, { beforeRename(step) {
      const pointer = JSON.parse(fs.readFileSync(join(f.profile, '.dsh-install-recovery.lock', 'transaction.json')));
      const journal = JSON.parse(fs.readFileSync(pointer.journal));
      assert.equal(journal.steps.at(-1).state, 'planned');
      assert.equal(journal.steps.at(-1).from, step.from);
      assert.equal(exists(step.from), true, 'journal must be durable before renaming the source');
      if (++count === failedStep) throw fault('TEST_RENAME_FAILURE');
    } });
    let error;
    await assert.rejects(restoreInstallation(f.options, hooks), e => {
      error = e; return e.code === 'TEST_RENAME_FAILURE';
    });
    assert.equal(count, failedStep);
    assert.equal(error.recoveryStatus, 'stopped-original-installation-retained');
    assertOriginalObjects(f, f.profile);
    assertProtected(f);
    assert.deepEqual(installationInventory(f.backup), f.historical);
    assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
    const journal = JSON.parse(fs.readFileSync(join(error.evidence, 'journal.json')));
    assert.equal(journal.status, error.recoveryStatus);
    assert.ok(exists(journal.candidate));
    assert.ok(exists(journal.retained));
  });
}

test('a failing final runtime check rolls back the entire switch and retains all evidence', async t => {
  const f = fixture(t), { hooks } = hooksFor(f);
  const originalRuntime = hooks.checkRuntime;
  hooks.checkRuntime = async (profile, expected) => {
    const report = await originalRuntime(profile, expected);
    if (profile === f.profile) throw fault('TEST_FINAL_RUNTIME_FAILURE');
    return report;
  };
  await assert.rejects(restoreInstallation(f.options, hooks), e => {
    assert.equal(e.recoveryStatus, 'stopped-original-installation-retained');
    return e.code === 'TEST_FINAL_RUNTIME_FAILURE';
  });
  assertOriginalObjects(f, f.profile);
  assertProtected(f);
  assert.deepEqual(installationInventory(f.backup), f.historical);
});

test('an external fallback change after candidate verification blocks the switch', async t => {
  const f = fixture(t), { hooks } = hooksFor(f);
  const runtime = hooks.checkRuntime;
  hooks.checkRuntime = async (...args) => {
    const report = await runtime(...args);
    fs.appendFileSync(join(dirname(f.profile), 'node_modules', hostNames[8], 'index.js'), '// external change\n');
    return report;
  };
  await assert.rejects(restoreInstallation(f.options, hooks), e => e.recoveryStatus === 'stopped-original-installation-retained');
  assertOriginalObjects(f, f.profile);
  assertProtected(f);
});

for (const kind of ['backup', 'candidate', 'receipt', 'current-metadata', 'configuration']) {
  test(`${kind} drift after candidate verification is rejected without applying the candidate`, async t => {
    const f = fixture(t), { hooks } = hooksFor(f), runtime = hooks.checkRuntime;
    const expectedCode = { backup: 'BACKUP_INSTALLATION_CHANGED', candidate: 'CANDIDATE_INSTALLATION_CHANGED',
      receipt: 'DEPLOYMENT_RECEIPT_CHANGED', 'current-metadata': 'CURRENT_INSTALLATION_CHANGED',
      configuration: 'LIVE_CONFIGURATION_CHANGED' }[kind];
    hooks.checkRuntime = async (candidate, expected) => {
      const report = await runtime(candidate, expected);
      if (kind === 'backup') fs.appendFileSync(join(f.backup, 'node_modules', hostNames[0], 'index.js'), '// changed\n');
      if (kind === 'candidate') fs.appendFileSync(join(candidate, 'node_modules', hostNames[0], 'index.js'), '// changed\n');
      if (kind === 'receipt') fs.appendFileSync(f.receipt, '\n');
      if (kind === 'configuration') fs.appendFileSync(join(f.profile, 'cordis.patch.yml'), '# external change\n');
      if (kind === 'current-metadata') {
        const path = join(f.profile, 'node_modules', hostNames[0], 'index.js'), s = fs.statSync(path);
        fs.utimesSync(path, s.atime, new Date(s.mtimeMs + 10000));
      }
      return report;
    };
    await assert.rejects(restoreInstallation(f.options, hooks), { code: expectedCode });
    assert.equal(installationInventory(f.profile).sha256, f.original.sha256);
    if (kind !== 'configuration') assertProtected(f);
  });
}

test('a work root inside backup node_modules is rejected without altering the backup', async t => {
  const f = fixture(t), workRoot = join(f.backup, 'node_modules', 'recovery-work');
  fs.mkdirSync(workRoot);
  const beforeBackup = installationInventory(f.backup);
  const { hooks, calls } = hooksFor(f);
  await assert.rejects(restoreInstallation({ ...f.options, workRoot }, hooks), { code: 'OVERLAPPING_RECOVERY_PATHS' });
  assert.deepEqual(installationInventory(f.backup), beforeBackup);
  assert.deepEqual(installationInventory(f.profile), f.original);
  assert.deepEqual(fs.readdirSync(workRoot), []);
  assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
  assert.equal(calls.state, 0, 'overlap must be rejected before staging or running recovery hooks');
  assertProtected(f);
});

test('a work root that contains the live profile is rejected before creating recovery artifacts', async t => {
  const f = fixture(t), workRoot = dirname(f.profile);
  const beforeChildren = fs.readdirSync(workRoot).sort();
  const { hooks, calls } = hooksFor(f);
  await assert.rejects(restoreInstallation({ ...f.options, workRoot }, hooks), { code: 'OVERLAPPING_RECOVERY_PATHS' });
  assert.deepEqual(fs.readdirSync(workRoot).sort(), beforeChildren);
  assert.deepEqual(installationInventory(f.profile), f.original);
  assert.deepEqual(installationInventory(f.backup), f.historical);
  assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
  assert.equal(calls.state, 0, 'overlap must be rejected before staging or running recovery hooks');
  assertProtected(f);
});

test('all four observed installation hashes are required before staging or acquiring a transaction lock', async t => {
  const f = fixture(t);
  for (const name of ['currentManifestHash', 'currentLockHash', 'backupManifestHash', 'backupLockHash']) {
    for (const value of [undefined, '0'.repeat(64)]) {
      const { hooks } = hooksFor(f);
      await assert.rejects(restoreInstallation({ ...f.options, [name]: value }, hooks), { code: 'OBSERVED_INSTALLATION_CHANGED' });
      assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
      assert.deepEqual(fs.readdirSync(f.workRoot), []);
    }
  }
  assertOriginalObjects(f, f.profile);
  assertProtected(f);
});

test('space, service-state and writer guard failures leave live installation metadata untouched', async t => {
  const f = fixture(t), before = installationInventory(f.profile);
  for (const name of ['checkSpace', 'checkState', 'checkWriters']) {
    const { hooks } = hooksFor(f, { [name]() { throw fault('TEST_PRECONDITION'); } });
    await assert.rejects(restoreInstallation(f.options, hooks), { code: 'TEST_PRECONDITION' });
    assert.deepEqual(installationInventory(f.profile), before);
    assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
  }
  assertProtected(f);
});

test('an existing transaction lock is never removed or reused by a second invocation', async t => {
  const f = fixture(t), lock = join(f.profile, '.dsh-install-recovery.lock');
  write(join(lock, 'transaction.json'), '{"journal":"/example/private/interrupted-journal.json"}\n', 0o600);
  const bytes = fs.readFileSync(join(lock, 'transaction.json'));
  await assert.rejects(restoreInstallation(f.options, hooksFor(f).hooks), { code: 'RECOVERY_TRANSACTION_EXISTS' });
  assert.deepEqual(fs.readFileSync(join(lock, 'transaction.json')), bytes);
  assertOriginalObjects(f, f.profile);
  assertProtected(f);
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
});

test('a writer appearing during a failed switch prevents unsafe reverse renames and retains its recovery lock', async t => {
  const f = fixture(t);
  let blocked = false, steps = 0;
  const { hooks } = hooksFor(f, {
    checkWriters() { if (blocked) throw fault('TEST_WRITER_ACTIVE'); },
    beforeRename() { if (++steps === 2) { blocked = true; throw fault('TEST_SWITCH_INTERRUPTED'); } },
  });
  let error;
  await assert.rejects(restoreInstallation(f.options, hooks), e => { error = e; return e.code === 'TEST_SWITCH_INTERRUPTED'; });
  assert.equal(error.recoveryStatus, 'manual-recovery-required');
  const pointer = JSON.parse(fs.readFileSync(join(f.profile, '.dsh-install-recovery.lock', 'transaction.json')));
  const journal = JSON.parse(fs.readFileSync(pointer.journal));
  assert.equal(journal.status, 'manual-recovery-required');
  assert.equal(journal.revertCode, 'TEST_WRITER_ACTIVE');
  const originalPackage = fs.statSync(join(journal.retained, 'package.json'));
  assert.equal(originalPackage.ino, f.original.identities.find(row => row[0] === 'package.json')[2]);
  assert.equal(exists(join(f.profile, 'package.json')), false);
  assertProtected(f);
  assert.deepEqual(installationInventory(f.backup), f.historical);
});

test('a destination created immediately before rename is retained without overwriting it or the parked original', async t => {
  const f = fixture(t), marker = 'an external writer created this destination\n';
  let steps = 0, blockedStep;
  const { hooks } = hooksFor(f, { beforeRename(step) {
    if (++steps === 2) {
      blockedStep = step;
      assert.equal(step.to, join(f.profile, 'package.json'));
      fs.writeFileSync(step.to, marker, { flag: 'wx' });
    }
  } });
  let error;
  await assert.rejects(restoreInstallation(f.options, hooks), e => {
    error = e; return e.code === 'RENAME_IDENTITY_CHANGED';
  });
  assert.equal(steps, 2);
  assert.equal(error.recoveryStatus, 'manual-recovery-required');
  const pointer = JSON.parse(fs.readFileSync(join(f.profile, '.dsh-install-recovery.lock', 'transaction.json')));
  const journal = JSON.parse(fs.readFileSync(pointer.journal));
  assert.equal(journal.revertCode, 'REVERT_IDENTITY_CHANGED');
  assert.equal(journal.steps.at(-1).state, 'planned');
  assert.equal(fs.readFileSync(blockedStep.to, 'utf8'), marker);
  assert.equal(hashFile(blockedStep.from), f.options.backupManifestHash);
  assert.equal(hashFile(join(journal.retained, 'package.json')), f.options.currentManifestHash);
  assert.equal(fs.statSync(join(journal.retained, 'package.json')).ino,
    f.original.identities.find(row => row[0] === 'package.json')[2]);
  assertProtected(f);
  assert.deepEqual(installationInventory(f.backup), f.historical);
});

for (const guard of ['checkState', 'checkWriters']) {
  test(`${guard} is rechecked after the pre-rename hook and blocks unsafe forward and reverse renames`, async t => {
    const f = fixture(t);
    let blocked = false, steps = 0, blockedStep;
    const { hooks } = hooksFor(f, {
      [guard]() { if (blocked) throw fault('TEST_CONCURRENT_ACTIVITY'); },
      beforeRename(step) {
        if (++steps === 4) { blocked = true; blockedStep = step; }
      },
    });
    let error;
    await assert.rejects(restoreInstallation(f.options, hooks), e => {
      error = e; return e.code === 'TEST_CONCURRENT_ACTIVITY';
    });
    assert.equal(steps, 4);
    assert.equal(error.recoveryStatus, 'manual-recovery-required');
    const pointer = JSON.parse(fs.readFileSync(join(f.profile, '.dsh-install-recovery.lock', 'transaction.json')));
    const journal = JSON.parse(fs.readFileSync(pointer.journal));
    assert.equal(journal.revertCode, 'TEST_CONCURRENT_ACTIVITY');
    assert.deepEqual(journal.steps.map(step => step.state), ['done', 'done', 'done', 'planned']);
    assert.equal(exists(blockedStep.to), false, 'the blocked rename must not run');
    assert.equal(hashFile(blockedStep.from), f.options.backupLockHash);
    assert.equal(hashFile(join(journal.retained, 'package.json')), f.options.currentManifestHash);
    assert.equal(hashFile(join(journal.retained, 'pnpm-lock.yaml')), f.options.currentLockHash);
    assertProtected(f);
    assert.deepEqual(installationInventory(f.backup), f.historical);
  });
}

test('an abruptly terminated isolated worker leaves the journal and original objects recoverable', t => {
  const f = fixture(t);
  const code = `
    import { restoreInstallation } from ${JSON.stringify(moduleUrl.href)};
    let count = 0;
    await restoreInstallation(${JSON.stringify(f.options)}, {
      checkState(){}, checkWriters(){}, checkSpace(){},
      async checkRuntime(){ return {hosts:[],configuration:{inputs:[]}}; }, recheckRuntime(){},
      beforeRename(){ if (++count === 2) process.kill(process.pid, 'SIGKILL'); }
    });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL');
  const lock = join(f.profile, '.dsh-install-recovery.lock');
  const pointer = JSON.parse(fs.readFileSync(join(lock, 'transaction.json')));
  const journal = JSON.parse(fs.readFileSync(pointer.journal));
  assert.equal(journal.status, 'switching');
  assert.equal(journal.steps.at(-1).state, 'planned');
  assert.equal(journal.steps[0].state, 'done');
  assert.equal(hashFile(join(journal.retained, 'package.json')), f.options.currentManifestHash);
  assert.equal(hashFile(join(journal.candidate, 'package.json')), f.options.backupManifestHash);
  assertProtected(f);
  assert.deepEqual(installationInventory(f.backup), f.historical);
});

const cliArgs = ['--profile', '/root/.dsh/profiles/web', '--harness', '/opt/deepseek-harness',
  '--backup', '/example/data/backup', '--receipt', '/example/data/receipt.json', '--work-root', '/example/data/work',
  '--helper', '/example/helper.mjs', '--resume-script', '/example/resume.mjs', '--profile-snapshot', '/example/snapshot',
  ...['resume-sha256', 'current-manifest-sha256', 'current-lock-sha256', 'backup-manifest-sha256', 'backup-lock-sha256']
    .flatMap(name => ['--' + name, 'a'.repeat(64)])];

test('CLI requires explicit immutable hashes and canonical absolute paths', () => {
  assert.equal(parseRestoreOptions(cliArgs)['backup-lock-sha256'], 'a'.repeat(64));
  for (let index = 0; index < cliArgs.length; index += 2) {
    const flag = cliArgs[index];
    assert.throws(() => parseRestoreOptions(cliArgs.filter((_, i) => i !== index && i !== index + 1)), { code: 'INVALID_RESTORE_OPTIONS' }, flag);
    const invalid = [...cliArgs]; invalid[index + 1] = flag.endsWith('sha256') ? 'A'.repeat(64) : '/example/../other';
    assert.throws(() => parseRestoreOptions(invalid), { code: 'INVALID_RESTORE_OPTIONS' }, flag);
  }
  const otherProfile = [...cliArgs]; otherProfile[1] = '/example/different-profile';
  assert.throws(() => parseRestoreOptions(otherProfile), { code: 'UNSUPPORTED_SERVICE_PROFILE' });
});

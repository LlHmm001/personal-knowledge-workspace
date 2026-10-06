import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { installationFiles, installationInventory, planCandidateLinkRelocations,
  applyCandidateLinkRelocations, recheckCandidateLinkRelocations,
  restoreInstallation, verifyCandidateLinks } from '../restore-dsh-installation-snapshot.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hashFile = path => digest(fs.readFileSync(path));
const present = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const packageName = '@example/fallback-package';
const directPackage = '@example/local-package';

function write(path, content, mode = 0o644) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path, content, { mode });
  fs.chmodSync(path, mode);
}

function packageTree(path, name, generation = 'release') {
  write(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }));
  write(join(path, 'index.js'), `export const generation = ${JSON.stringify(generation)};\n`);
  write(join(path, 'lib', 'secondary.js'), 'export const secondary = true;\n');
}

function copyMembers(source, destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of installationFiles) if (present(join(source, name))) {
    fs.cpSync(join(source, name), join(destination, name), {
      recursive: true, dereference: false, verbatimSymlinks: true,
      preserveTimestamps: true, filter: () => true,
    });
  }
}

function replaceLink(path, target) {
  if (present(path)) fs.unlinkSync(path);
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  fs.symlinkSync(target, path);
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dsh-fallback-relocation-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profiles', 'web'), backup = join(root, 'data', 'backup');
  const workRoot = join(root, 'data', 'work'), candidate = join(dirname(profile), '.fixture-candidate');
  const harnessRelease = join(root, 'releases', 'release-a');
  const target = join(harnessRelease, 'packages', 'client', 'fallback-package');
  const sourceTarget = join(profile, '.dsh-module-fallback', 'node_modules', packageName);
  const linkPath = join('node_modules', packageName);
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  packageTree(target, packageName);
  packageTree(join(profile, 'node_modules', directPackage), directPackage, 'historical');
  replaceLink(sourceTarget, target);
  replaceLink(join(profile, linkPath), sourceTarget);
  const manifest = { name: 'isolated-restore-fixture', private: true, type: 'module',
    dependencies: { [packageName]: '1.0.0', [directPackage]: '1.0.0', '@deepseek-ai/dsh-pkw-web': '0.1.2-pkw.4' },
    dsh: { profile: { bundles: ['@example/host-bundle'] } } };
  write(join(profile, 'package.json'), JSON.stringify(manifest));
  write(join(profile, 'pnpm-lock.yaml'), '# original fixture lock\n');
  write(join(profile, '.npmrc'), 'auto-install-peers=false\n', 0o600);
  copyMembers(profile, backup);
  copyMembers(backup, candidate);
  manifest.dependencies['@deepseek-ai/dsh-pkw-web'] = '0.1.7-pkw.1';
  write(join(profile, 'package.json'), JSON.stringify(manifest));
  write(join(profile, 'pnpm-lock.yaml'), '# interrupted fixture lock\n');
  packageTree(join(profile, 'node_modules', directPackage), directPackage, 'current');
  write(join(profile, 'cordis.patch.yml'), '- id: fixture-host\n');
  write(join(profile, 'cordis.yml'), '[]\n');
  write(join(profile, 'pnpm-workspace.yaml'), 'packages: [.]\n');
  write(join(profile, 'notes', 'existing.md'), '# Existing data\n');
  write(join(profile, 'state.sqlite'), 'Never opened fixture database\n');
  const beforeHost = { [packageName]: hashFile(join(target, 'index.js')),
    [directPackage]: hashFile(join(backup, 'node_modules', directPackage, 'index.js')) };
  const receipt = join(root, 'data', 'receipt.json');
  write(receipt, JSON.stringify({ profile, beforeHost }), 0o600);
  const inventory = installationInventory(candidate);
  const options = { profile, backup, workRoot, receipt, harnessRelease,
    currentManifestHash: hashFile(join(profile, 'package.json')), currentLockHash: hashFile(join(profile, 'pnpm-lock.yaml')),
    backupManifestHash: hashFile(join(backup, 'package.json')), backupLockHash: hashFile(join(backup, 'pnpm-lock.yaml')) };
  return { root, profile, backup, candidate, harnessRelease, target, sourceTarget, linkPath,
    inventory, options, beforeHost, original: installationInventory(profile), historical: installationInventory(backup),
    protectedNames: ['cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'notes', 'state.sqlite'] };
}

const plan = f => planCandidateLinkRelocations({ candidate: f.candidate, profile: f.profile,
  backup: f.backup, inventory: installationInventory(f.candidate), harnessRelease: f.harnessRelease });

test('exact same-name fallback links relocate only in the candidate to one canonical release package', t => {
  const f = fixture(t), before = installationInventory(f.candidate);
  assert.throws(() => verifyCandidateLinks(f.candidate, f.profile, f.backup, before), { code: 'CANDIDATE_LINK_BORROWS_INSTALLATION' });
  const relocation = plan(f);
  assert.equal(relocation.links.length, 1);
  assert.equal(relocation.links[0].path, f.linkPath);
  assert.equal(relocation.links[0].packageName, packageName);
  assert.equal(relocation.links[0].sourceTarget, f.sourceTarget);
  assert.equal(relocation.links[0].target, f.target);
  assert.equal(fs.readlinkSync(join(f.candidate, f.linkPath)), f.sourceTarget, 'planning is read-only');
  assert.equal(fs.readlinkSync(join(f.backup, f.linkPath)), f.sourceTarget);
  applyCandidateLinkRelocations(f.candidate, relocation);
  const after = installationInventory(f.candidate);
  assert.equal(after.sha256, relocation.expected.sha256);
  assert.equal(fs.realpathSync(join(f.candidate, f.linkPath)), f.target);
  assert.equal(fs.readlinkSync(join(f.profile, f.linkPath)), f.sourceTarget, 'production link remains literal and untouched');
  assert.deepEqual(installationInventory(f.backup), f.historical, 'backup bytes and identities remain unchanged');
  assert.deepEqual(installationInventory(f.profile), f.original, 'production installation remains unchanged');
  const mapped = new Map(after.rows.map(row => [row.path, row]));
  for (const row of before.rows) {
    assert.deepEqual(mapped.get(row.path), row.path === f.linkPath ? { ...row, target: f.target } : row,
      'only the approved raw target may differ; mode, UID/GID and all other rows stay exact');
  }
  verifyCandidateLinks(f.candidate, f.profile, f.backup, after);
  recheckCandidateLinkRelocations(relocation);
});

for (const kind of ['different-name', 'nested', 'normal-live', 'backup', 'unrelated', 'dot-dot', 'double-separator']) {
  test(`a ${kind} borrowing link cannot acquire a fallback relocation exemption`, t => {
    const f = fixture(t);
    let path = join(f.candidate, f.linkPath), target;
    if (kind === 'different-name') target = join(f.profile, '.dsh-module-fallback', 'node_modules', '@example', 'other-package');
    if (kind === 'normal-live') target = join(f.profile, 'node_modules', directPackage);
    if (kind === 'backup') target = join(f.backup, 'node_modules', directPackage);
    if (kind === 'unrelated') target = join(f.profile, 'notes');
    if (kind === 'nested') { path = join(f.candidate, 'node_modules', 'nested', 'node_modules', packageName); target = f.sourceTarget; }
    if (kind === 'dot-dot') target = f.sourceTarget + '/../fallback-package';
    if (kind === 'double-separator') target = f.sourceTarget.replace('/.dsh-module-fallback/', '//.dsh-module-fallback/');
    replaceLink(path, target);
    const before = installationInventory(f.candidate);
    assert.throws(() => { const p = plan(f); applyCandidateLinkRelocations(f.candidate, p);
      verifyCandidateLinks(f.candidate, f.profile, f.backup, installationInventory(f.candidate)); },
    { code: 'CANDIDATE_LINK_BORROWS_INSTALLATION' });
    assert.equal(fs.readlinkSync(path), target);
    assert.equal(installationInventory(f.candidate).sha256, before.sha256,
      'all borrowing links must be classified before any approved mapping is applied');
  });
}

for (const kind of ['outside-release', 'real-live', 'real-backup', 'indirect-live', 'name-mismatch', 'writable-directory']) {
  test(`a fallback resolving to ${kind} is rejected before candidate edits`, t => {
    const f = fixture(t);
    if (kind === 'outside-release') {
      const outside = join(f.root, 'external', 'same-name'); packageTree(outside, packageName); replaceLink(f.sourceTarget, outside);
    } else if (kind === 'real-live') {
      const live = join(f.profile, 'node_modules', 'same-name-independent'); packageTree(live, packageName); replaceLink(f.sourceTarget, live);
    } else if (kind === 'real-backup') {
      const saved = join(f.backup, 'node_modules', 'same-name-independent'); packageTree(saved, packageName); replaceLink(f.sourceTarget, saved);
    } else if (kind === 'indirect-live') {
      const live = join(f.profile, 'node_modules', 'same-name-independent'); packageTree(live, packageName);
      fs.renameSync(f.target, f.target + '-original'); fs.symlinkSync(live, f.target);
    } else if (kind === 'name-mismatch') {
      write(join(f.target, 'package.json'), JSON.stringify({ name: '@example/not-the-same-package', main: 'index.js' }));
    } else fs.chmodSync(f.target, 0o777);
    const before = installationInventory(f.candidate);
    const code = kind === 'name-mismatch' ? 'FALLBACK_PACKAGE_NAME_CHANGED'
      : kind === 'writable-directory' ? 'FALLBACK_TARGET_INVALID' : 'FALLBACK_TARGET_OUTSIDE_RELEASE';
    assert.throws(() => plan(f), { code });
    assert.equal(installationInventory(f.candidate).sha256, before.sha256);
  });
}

for (const kind of ['content', 'target-inode', 'source-alias', 'release-inode']) {
  test(`approved fallback ${kind} drift is rejected on recheck`, t => {
    const f = fixture(t), relocation = plan(f);
    if (kind === 'content') fs.appendFileSync(join(f.target, 'lib', 'secondary.js'), '// drift away from the checked package tree\n');
    if (kind === 'target-inode') {
      fs.renameSync(f.target, f.target + '-original'); fs.cpSync(f.target + '-original', f.target, { recursive: true, filter: () => true });
    }
    if (kind === 'source-alias') {
      const other = join(f.harnessRelease, 'packages', 'client', 'other-copy'); packageTree(other, packageName); replaceLink(f.sourceTarget, other);
    }
    if (kind === 'release-inode') {
      fs.renameSync(f.harnessRelease, f.harnessRelease + '-original');
      fs.cpSync(f.harnessRelease + '-original', f.harnessRelease, { recursive: true, filter: () => true });
    }
    const code = { content: 'FALLBACK_PACKAGE_CHANGED', 'target-inode': 'FALLBACK_TARGET_CHANGED',
      'source-alias': 'FALLBACK_SOURCE_TARGET_CHANGED', 'release-inode': 'FALLBACK_RELEASE_CHANGED' }[kind];
    assert.throws(() => recheckCandidateLinkRelocations(relocation), { code });
    assert.equal(fs.readlinkSync(join(f.candidate, f.linkPath)), f.sourceTarget, 'rechecks are read-only');
  });
}

test('ordinary internal relative links are preserved without using the fallback exemption', t => {
  const f = fixture(t), internal = join(f.candidate, 'node_modules', 'ordinary-relative');
  replaceLink(internal, relative(dirname(internal), join(f.candidate, 'node_modules', directPackage)));
  const before = fs.readlinkSync(internal), relocation = plan(f);
  applyCandidateLinkRelocations(f.candidate, relocation);
  assert.equal(fs.readlinkSync(internal), before);
  verifyCandidateLinks(f.candidate, f.profile, f.backup, installationInventory(f.candidate));
});

for (const rootKind of ['profile', 'backup']) {
  test(`links inside a mapped package still cannot borrow the ${rootKind} installation`, t => {
    const f = fixture(t);
    const borrowed = join(f.target, 'lib', 'borrowed-package');
    fs.symlinkSync(join(f[rootKind], 'node_modules', directPackage), borrowed);
    const before = installationInventory(f.candidate);
    assert.throws(() => plan(f), { code: 'CANDIDATE_LINK_BORROWS_INSTALLATION' });
    assert.equal(installationInventory(f.candidate).sha256, before.sha256);
    assert.equal(fs.readlinkSync(borrowed), join(f[rootKind], 'node_modules', directPackage));
  });
}

test('fallback relocation requires an explicit canonical release even when the source resolves', t => {
  const f = fixture(t), before = installationInventory(f.candidate);
  assert.throws(() => planCandidateLinkRelocations({ candidate: f.candidate, profile: f.profile,
    backup: f.backup, inventory: before }), { code: 'FALLBACK_RELOCATION_REQUIRES_HARNESS' });
  assert.equal(installationInventory(f.candidate).sha256, before.sha256);
});

function hooksFor(f, overrides = {}) {
  const calls = [];
  const hooks = {
    checkState() {}, checkWriters() {}, checkSpace() {},
    async checkRuntime(profile, expected) {
      const require = createRequire(join(profile, 'package.json'));
      const hosts = Object.entries(expected).map(([name, sha256]) => {
        const path = require.resolve(name), real = fs.realpathSync(path);
        assert.equal(hashFile(real), sha256);
        return { name, path, real, sha256 };
      });
      calls.push({ profile, target: fs.realpathSync(join(profile, f.linkPath)) });
      return { hosts, configuration: { inputs: [] } };
    },
    recheckRuntime(report, movedCandidate) {
      for (const row of report.hosts) {
        if (movedCandidate && (row.path === movedCandidate || row.path.startsWith(movedCandidate + '/'))) continue;
        assert.equal(hashFile(row.real), row.sha256);
      }
    },
    ...overrides,
  };
  return { hooks, calls };
}

test('the whole transaction permits only recorded link-target changes and uses the same package in candidate and final checks', async t => {
  const f = fixture(t), protectedBefore = installationInventory(f.profile, f.protectedNames);
  const { hooks, calls } = hooksFor(f);
  const result = await restoreInstallation(f.options, hooks);
  assert.equal(result.status, 'installation-restored-verified');
  assert.equal(result.servicesStarted, false);
  assert.equal(result.databasesRestored, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target, f.target);
  assert.equal(calls[1].profile, f.profile);
  assert.equal(calls[1].target, calls[0].target, 'candidate and final install must resolve one bound physical package');
  assert.equal(fs.readlinkSync(join(f.profile, f.linkPath)), f.target);
  const final = installationInventory(f.profile), beforeRows = new Map(f.historical.rows.map(row => [row.path, row]));
  for (const row of final.rows) {
    const old = beforeRows.get(row.path);
    assert.deepEqual(row, row.path === f.linkPath ? { ...old, target: f.target } : old);
  }
  assert.deepEqual(installationInventory(f.backup), f.historical);
  assert.deepEqual(installationInventory(f.profile, f.protectedNames), protectedBefore);
  assert.equal(installationInventory(result.retainedOriginal).sha256, f.original.sha256);
  const journal = JSON.parse(fs.readFileSync(join(result.evidence, 'journal.json')));
  assert.equal(journal.linkRelocations.links.length, 1);
  assert.equal(journal.linkRelocations.links[0].sourceTarget, f.sourceTarget);
});

test('fallback content drift during the final probe reverses the installation switch and retains the original', async t => {
  const f = fixture(t), { hooks } = hooksFor(f, {
    async checkRuntime(profile, expected) {
      const probe = hooksFor(f).hooks;
      const report = await probe.checkRuntime(profile, expected);
      if (profile === f.profile) fs.appendFileSync(join(f.target, 'lib', 'secondary.js'), '// final drift\n');
      return report;
    },
  });
  await assert.rejects(restoreInstallation(f.options, hooks), e => e.recoveryStatus === 'stopped-original-installation-retained');
  assert.equal(installationInventory(f.profile).sha256, f.original.sha256);
  assert.equal(fs.readlinkSync(join(f.profile, f.linkPath)), f.sourceTarget);
  assert.deepEqual(installationInventory(f.backup), f.historical);
});

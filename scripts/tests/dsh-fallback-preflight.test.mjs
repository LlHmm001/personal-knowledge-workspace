import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { auditFallbackLinkTargets, fallbackAuditSummary, installationFiles,
  installationInventory, restoreInstallation } from '../restore-dsh-installation-snapshot.mjs';

const hashFile = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const exists = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const names = ['@example/one', '@example/two', '@example/three'];

function write(path, contents, mode = 0o644) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path, contents, { mode }); fs.chmodSync(path, mode);
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dsh-fallback-preflight-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profiles', 'web'), backup = join(root, 'data', 'backup');
  const workRoot = join(root, 'data', 'work'), harnessRelease = join(root, 'releases', 'release-a');
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const targets = Object.fromEntries(names.map(name => [name, join(harnessRelease, 'packages', name)]));
  for (const name of names) {
    const target = targets[name], sourceTarget = join(profile, '.dsh-module-fallback', 'node_modules', name);
    write(join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    write(join(target, 'index.js'), 'module.exports = { fixture: true };\n');
    write(join(target, 'lib', 'secondary.js'), 'module.exports = true;\n');
    fs.mkdirSync(dirname(sourceTarget), { recursive: true, mode: 0o755 });
    fs.symlinkSync(target, sourceTarget);
    const link = join(profile, 'node_modules', name);
    fs.mkdirSync(dirname(link), { recursive: true, mode: 0o755 }); fs.symlinkSync(sourceTarget, link);
  }
  const manifest = { name: 'preflight-test-profile', private: true,
    dependencies: { ...Object.fromEntries(names.map(name => [name, '1.0.0'])), '@deepseek-ai/dsh-pkw-web': '0.1.2-pkw.4' },
    dsh: { profile: { bundles: ['@example/host-bundle'] } } };
  write(join(profile, 'package.json'), JSON.stringify(manifest));
  write(join(profile, 'pnpm-lock.yaml'), '# previous install\n');
  write(join(profile, '.npmrc'), 'auto-install-peers=false\n', 0o600);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const name of installationFiles) if (exists(join(profile, name))) fs.cpSync(join(profile, name), join(backup, name), {
    recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, filter: () => true,
  });
  manifest.dependencies['@deepseek-ai/dsh-pkw-web'] = '0.1.7-pkw.1';
  write(join(profile, 'package.json'), JSON.stringify(manifest));
  write(join(profile, 'pnpm-lock.yaml'), '# interrupted install\n');
  write(join(profile, 'cordis.patch.yml'), '- id: preserved-host\n');
  write(join(profile, 'cordis.yml'), '[]\n');
  write(join(profile, 'pnpm-workspace.yaml'), 'packages: [.]\n');
  write(join(profile, 'state.sqlite'), 'Untouched fixture database\n');
  const beforeHost = Object.fromEntries(names.map(name => [name, hashFile(join(targets[name], 'index.js'))]));
  const receipt = join(root, 'data', 'receipt.json'); write(receipt, JSON.stringify({ profile, beforeHost }), 0o600);
  const options = { profile, backup, workRoot, receipt, harnessRelease,
    currentManifestHash: hashFile(join(profile, 'package.json')), currentLockHash: hashFile(join(profile, 'pnpm-lock.yaml')),
    backupManifestHash: hashFile(join(backup, 'package.json')), backupLockHash: hashFile(join(backup, 'pnpm-lock.yaml')) };
  return { root, profile, backup, workRoot, harnessRelease, targets, options,
    original: installationInventory(profile), historical: installationInventory(backup) };
}

const audit = f => auditFallbackLinkTargets({ profile: f.profile, backup: f.backup,
  inventory: installationInventory(f.backup), harnessRelease: f.harnessRelease });

function inertHooks(overrides = {}) {
  return { checkState() {}, checkWriters() {}, checkSpace() {},
    checkRuntime() { throw Object.assign(new Error('UNEXPECTED_RUNTIME_PROBE'), { code: 'UNEXPECTED_RUNTIME_PROBE' }); },
    recheckRuntime() {}, ...overrides };
}

test('successful fallback preflight reads every target without allocating or changing source objects', t => {
  const f = fixture(t), beforeProfile = installationInventory(f.profile);
  const beforeBackup = installationInventory(f.backup), beforeRelease = installationInventory(f.harnessRelease, ['packages']);
  const parents = fs.readdirSync(dirname(f.profile)).sort();
  const result = audit(f);
  assert.equal(result.version, 1);
  assert.equal(result.links.length, 3);
  assert.deepEqual(result.failures, []);
  for (const link of result.links) {
    assert.equal(link.target, f.targets[link.packageName]);
    assert.match(link.targetTreeHash, /^[a-f0-9]{64}$/);
    assert.ok(link.targetIdentity);
  }
  assert.deepEqual(installationInventory(f.profile), beforeProfile);
  assert.deepEqual(installationInventory(f.backup), beforeBackup);
  assert.deepEqual(installationInventory(f.harnessRelease, ['packages']), beforeRelease);
  assert.deepEqual(fs.readdirSync(dirname(f.profile)).sort(), parents);
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
});

test('fallback preflight aggregates all target failures instead of stopping at the first', t => {
  const f = fixture(t);
  fs.chmodSync(f.targets[names[0]], 0o775);
  write(join(f.targets[names[1]], 'package.json'), JSON.stringify({ name: '@example/wrong-name' }));
  const outside = join(f.root, 'outside'); fs.mkdirSync(outside, { mode: 0o755 });
  const sourceTarget = join(f.profile, '.dsh-module-fallback', 'node_modules', names[2]);
  fs.unlinkSync(sourceTarget); fs.symlinkSync(outside, sourceTarget);
  const result = audit(f), codes = Object.fromEntries(result.failures.map(item => [item.packageName, item.code]));
  assert.equal(result.links.length, 0);
  assert.equal(result.failures.length, 3);
  assert.deepEqual(codes, { [names[0]]: 'FALLBACK_TARGET_INVALID', [names[2]]: 'FALLBACK_TARGET_OUTSIDE_RELEASE',
    [names[1]]: 'FALLBACK_PACKAGE_NAME_CHANGED' });
  for (const item of result.failures) assert.equal(item.path, join('node_modules', item.packageName));
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
});

test('missing canonical release produces one structured failure for every exact fallback link', t => {
  const f = fixture(t);
  const result = auditFallbackLinkTargets({ profile: f.profile, backup: f.backup, inventory: f.historical });
  assert.equal(result.links.length, 0);
  assert.equal(result.failures.length, 3);
  assert.ok(result.failures.every(item => item.code === 'FALLBACK_RELOCATION_REQUIRES_HARNESS'));
  assert.deepEqual(installationInventory(f.backup), f.historical);
});

test('parser failures and CLI summaries reveal only bounded structured error codes', t => {
  const f = fixture(t), secret = 'DO_NOT_PRINT_FIXTURE_SECRET';
  write(join(f.targets[names[0]], 'package.json'), secret);
  const result = audit(f);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'FALLBACK_PREFLIGHT_FAILED');
  assert.equal(JSON.stringify(result).includes(secret), false);
  const summary = fallbackAuditSummary(result);
  assert.equal(summary.matched, 3); assert.equal(summary.failed, 1);
  assert.deepEqual(Object.keys(summary.failures[0]).sort(), ['code', 'packageName']);
  assert.equal(JSON.stringify(summary).includes(f.root), false);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  const many = fallbackAuditSummary({ links: [], failures: Array.from({ length: 50 }, (_, index) => ({
    path: '/private/fixture/' + index, packageName: '@example/' + index, code: 'TEST_FAILURE',
  })) });
  assert.equal(many.matched, 50); assert.equal(many.failed, 50); assert.equal(many.failures.length, 32);
});

test('strict group-write rejection happens before creating evidence, a candidate, a lock, or installation copies', async t => {
  const f = fixture(t);
  for (const name of names) fs.chmodSync(f.targets[name], 0o775);
  const parentBefore = fs.readdirSync(dirname(f.profile)).sort();
  const original = installationInventory(f.profile), historical = installationInventory(f.backup);
  const targetBefore = installationInventory(f.harnessRelease, ['packages']);
  let progressCalls = 0;
  await assert.rejects(restoreInstallation(f.options, inertHooks({ progress() { progressCalls++; } })), error => {
    assert.equal(error.code, 'FALLBACK_TARGET_INVALID');
    assert.equal(error.evidence, undefined);
    assert.equal(error.fallbackPreflight.failures.length, 3);
    assert.ok(error.fallbackPreflight.failures.every(item => item.code === 'FALLBACK_TARGET_INVALID'));
    return true;
  });
  assert.equal(progressCalls, 0);
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
  assert.deepEqual(fs.readdirSync(dirname(f.profile)).sort(), parentBefore);
  assert.equal(exists(join(f.profile, '.dsh-install-recovery.lock')), false);
  assert.deepEqual(installationInventory(f.profile), original);
  assert.deepEqual(installationInventory(f.backup), historical);
  assert.deepEqual(installationInventory(f.harnessRelease, ['packages']), targetBefore);
});

test('ordinary production borrowing links gain no exemption from a successful fallback preflight', async t => {
  const f = fixture(t), borrowed = join(f.backup, 'node_modules', 'ordinary-borrowing');
  fs.symlinkSync(join(f.profile, 'node_modules'), borrowed);
  const result = audit(f);
  assert.equal(result.links.length, 3); assert.deepEqual(result.failures, []);
  assert.ok(result.links.every(link => link.path !== 'node_modules/ordinary-borrowing'));
  const original = installationInventory(f.profile), historical = installationInventory(f.backup);
  let runtimeCalls = 0;
  await assert.rejects(restoreInstallation(f.options, inertHooks({ checkRuntime() { runtimeCalls++; } })), error => {
    assert.equal(error.code, 'CANDIDATE_LINK_BORROWS_INSTALLATION');
    assert.equal(error.recoveryStatus, 'stopped-original-installation-retained');
    assert.equal(JSON.parse(fs.readFileSync(join(error.evidence, 'journal.json'))).steps.length, 0);
    return true;
  });
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(installationInventory(f.profile), original);
  assert.deepEqual(installationInventory(f.backup), historical);
  assert.equal(fs.readlinkSync(borrowed), join(f.profile, 'node_modules'));
});

test('a package changed after early preflight is still rejected after copying and before candidate execution', async t => {
  const f = fixture(t), beforeProfile = installationInventory(f.profile), beforeBackup = installationInventory(f.backup);
  let mutated = false, runtimeCalls = 0;
  await assert.rejects(restoreInstallation(f.options, inertHooks({
    progress(phase) {
      if (phase === 'preparing' && !mutated) {
        mutated = true; fs.appendFileSync(join(f.targets[names[0]], 'lib', 'secondary.js'), '// post-preflight fixture change\n');
      }
    },
    checkRuntime() { runtimeCalls++; },
  })), error => {
    assert.equal(error.code, 'FALLBACK_PACKAGE_CHANGED');
    assert.equal(error.recoveryStatus, 'stopped-original-installation-retained');
    assert.equal(JSON.parse(fs.readFileSync(join(error.evidence, 'journal.json'))).steps.length, 0);
    return true;
  });
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(installationInventory(f.profile), beforeProfile);
  assert.deepEqual(installationInventory(f.backup), beforeBackup);
});

test('successful early fallback preflight does not suppress later candidate installation content mismatch', async t => {
  const f = fixture(t), beforeProfile = installationInventory(f.profile), beforeBackup = installationInventory(f.backup);
  await assert.rejects(restoreInstallation(f.options, inertHooks({
    async checkRuntime(candidate) {
      fs.appendFileSync(join(candidate, '.npmrc'), '# unexpected candidate edit\n');
      return { hosts: [], configuration: { inputs: [] } };
    },
  })), error => {
    assert.equal(error.code, 'CANDIDATE_INSTALLATION_CHANGED');
    assert.equal(error.recoveryStatus, 'stopped-original-installation-retained');
    assert.equal(JSON.parse(fs.readFileSync(join(error.evidence, 'journal.json'))).steps.length, 0);
    return true;
  });
  assert.deepEqual(installationInventory(f.profile), beforeProfile);
  assert.deepEqual(installationInventory(f.backup), beforeBackup);
});

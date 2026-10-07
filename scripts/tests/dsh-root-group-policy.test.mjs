import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertRootGroupDirectoryPolicy, validateRootGroupDirectoryEvidence,
  recheckRootGroupDirectoryEvidence, rootGroupDirectoryAllows, installationFiles, installationInventory,
  parseRestoreOptions, restoreInstallation } from '../restore-dsh-installation-snapshot.mjs';

const hashFile = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');

// These are explicitly synthetic Linux observation records. They test policy
// decisions, not macOS execution of Linux NSS, /proc, or getxattr syscalls.
function linuxEvidence() {
  const harnessRelease = '/opt/fixture-harness/release-a';
  const parent = harnessRelease + '/packages', client = parent + '/client';
  const targets = [client + '/ui-one', client + '/ui-two'];
  const paths = [parent, client, ...targets];
  const context = { paths, harnessRelease, targets };
  const directories = ['/', '/opt', '/opt/fixture-harness', harnessRelease, ...paths].map((path, index) => ({
    path, dev: 1, ino: 100 + index, mode: paths.includes(path) ? 0o775 : 0o755,
    uid: 0, gid: 0, aclAccess: 'absent', aclDefault: 'absent',
  }));
  const sources = ['/etc/nsswitch.conf', '/etc/passwd', '/etc/group'].map((path, index) => ({
    path, sha256: String(index + 1).repeat(64), dev: 1, ino: 200 + index,
    mode: 0o644, uid: 0, gid: 0, size: 123 + index, mtimeNs: '1000000', ctimeNs: '2000000',
  }));
  const evidence = { version: 1, listed: [...paths], directories, sources,
    nss: { passwd: ['files', 'systemd'], group: ['files', 'systemd'] },
    rootAccount: { name: 'root', uid: 0, gid: 0 }, rootGroup: { name: 'root', gid: 0, members: [] },
    accountsWithRootGroup: [], processesWithRootGroup: [], unreadableProcesses: [] };
  return { context, evidence };
}

const errorCode = error => typeof error?.code === 'string';

test('exact opt-in directories and complete clean observation preserve source modes and input evidence', () => {
  const { context, evidence } = linuxEvidence(), before = structuredClone({ context, evidence });
  const policy = validateRootGroupDirectoryEvidence(context, evidence);
  assert.equal(policy.version, 1);
  assert.ok(policy.context);
  assert.ok(policy.directories);
  assert.deepEqual({ context, evidence }, before, 'validation must not chmod, normalize, or mutate the observed records');
  for (const path of context.paths) assert.equal(evidence.directories.find(row => row.path === path).mode, 0o775);
  recheckRootGroupDirectoryEvidence(policy, structuredClone(evidence));
});

for (const initgroups of [['files'], ['files', 'systemd']]) {
  test(`explicit initgroups ${initgroups.join(' ')} remains part of the bound NSS observation`, () => {
    const f = linuxEvidence(); f.evidence.nss.initgroups = initgroups;
    const policy = validateRootGroupDirectoryEvidence(f.context, f.evidence);
    assert.deepEqual(policy.nss.initgroups, initgroups);
    const next = structuredClone(f.evidence); delete next.nss.initgroups;
    assert.throws(() => recheckRootGroupDirectoryEvidence(policy, next), { code: 'ROOT_GROUP_NSS_CHANGED' });
  });
}

test('dynamic supplementary-group NSS cannot authorize the exception', () => {
  const f = linuxEvidence(); f.evidence.nss.initgroups = ['files', 'ldap'];
  assert.throws(() => validateRootGroupDirectoryEvidence(f.context, f.evidence), { code: 'ROOT_GROUP_NSS_UNSUPPORTED' });
});

const unsafeEvidence = {
  'unlisted group-writable ancestor': f => { f.evidence.directories.find(row => row.path === '/opt/fixture-harness').mode = 0o775; },
  'nonzero target GID': f => { f.evidence.directories.at(-1).gid = 10; },
  'world-writable target': f => { f.evidence.directories.at(-1).mode = 0o777; },
  'nonroot target UID': f => { f.evidence.directories.at(-1).uid = 1000; },
  'unexpected target mode': f => { f.evidence.directories.at(-1).mode = 0o755; },
  'setgid target mode': f => { f.evidence.directories.at(-1).mode = 0o2775; },
  'access ACL': f => { f.evidence.directories.at(-1).aclAccess = 'present'; },
  'default ACL': f => { f.evidence.directories.at(-1).aclDefault = 'present'; },
  'unreadable ACL': f => { f.evidence.directories.at(-1).aclAccess = 'unknown'; },
  'nonroot account in root group': f => { f.evidence.accountsWithRootGroup = [{ name: 'fixture-user', uid: 1000, groups: [0, 1000] }]; },
  'nonroot filesystem UID process in root group': f => { f.evidence.processesWithRootGroup = [{ pid: 123, tid: 124, fsuid: 1000, fsgid: 0, groups: [0] }]; },
  'unreadable process thread': f => { f.evidence.unreadableProcesses = [{ pid: 123, tid: 124, code: 'EACCES' }]; },
  'explicit root group member': f => { f.evidence.rootGroup.members = ['fixture-user']; },
  'different root account': f => { f.evidence.rootAccount.uid = 1000; },
  'different root group': f => { f.evidence.rootGroup.gid = 1000; },
  'dynamic passwd NSS': f => { f.evidence.nss.passwd = ['files', 'ldap']; },
  'dynamic group NSS': f => { f.evidence.nss.group = ['files', 'sss']; },
  'missing group source fingerprint': f => { f.evidence.sources = f.evidence.sources.filter(row => row.path !== '/etc/group'); },
  'nonroot account source owner': f => { f.evidence.sources[1].uid = 1000; },
  'writable account source': f => { f.evidence.sources[1].mode = 0o666; },
  'missing directory record': f => { f.evidence.directories.pop(); },
  'different observed directory path': f => { f.evidence.directories.at(-1).path = f.context.harnessRelease + '/unrelated'; },
  'incomplete opt-in observation': f => { f.evidence.listed.pop(); },
};

for (const [name, mutate] of Object.entries(unsafeEvidence)) {
  test(`${name} cannot authorize the root-group write exception`, () => {
    const f = linuxEvidence(); mutate(f);
    assert.throws(() => validateRootGroupDirectoryEvidence(f.context, f.evidence), errorCode);
  });
}

for (const name of ['root directory', 'release root', 'unrelated directory', 'duplicate directory']) {
  test(`opt-in scope rejects ${name}`, () => {
    const f = linuxEvidence();
    const extra = name === 'root directory' ? '/' : name === 'release root' ? f.context.harnessRelease
      : name === 'duplicate directory' ? f.context.paths[0] : f.context.harnessRelease + '/unrelated';
    f.context.paths.push(extra); f.evidence.listed.push(extra);
    if (!f.evidence.directories.some(row => row.path === extra)) f.evidence.directories.push({
      path: extra, dev: 1, ino: 300, mode: 0o775, uid: 0, gid: 0, aclAccess: 'absent', aclDefault: 'absent',
    });
    assert.throws(() => validateRootGroupDirectoryEvidence(f.context, f.evidence), errorCode);
  });
}

for (const kind of ['directory inode', 'directory device', 'directory mode', 'source digest', 'source inode', 'source timestamp',
  'NSS order', 'accounts', 'threads', 'ACL', 'path']) {
  test(`repeat observation rejects ${kind} drift against the bound policy`, () => {
    const f = linuxEvidence(), policy = validateRootGroupDirectoryEvidence(f.context, f.evidence);
    const next = structuredClone(f.evidence);
    if (kind === 'directory inode') next.directories.at(-1).ino++;
    if (kind === 'directory device') next.directories.at(-1).dev++;
    if (kind === 'directory mode') next.directories.at(-1).mode = 0o755;
    if (kind === 'source digest') next.sources[0].sha256 = 'a'.repeat(64);
    if (kind === 'source inode') next.sources[0].ino++;
    if (kind === 'source timestamp') next.sources[0].ctimeNs = '3000000';
    if (kind === 'NSS order') next.nss.passwd = ['systemd', 'files'];
    if (kind === 'accounts') next.accountsWithRootGroup = [{ name: 'fixture-user', uid: 1000 }];
    if (kind === 'threads') next.processesWithRootGroup = [{ pid: 123, tid: 124, fsuid: 1000, groups: [0] }];
    if (kind === 'ACL') next.directories.at(-1).aclAccess = 'present';
    if (kind === 'path') next.directories.at(-1).path = f.context.harnessRelease + '/other';
    assert.throws(() => recheckRootGroupDirectoryEvidence(policy, next), errorCode);
  });
}

test('an explicit observer is called afresh and cannot reuse a previously clean result after actor drift', () => {
  const f = linuxEvidence(); let calls = 0;
  const observer = context => {
    assert.deepEqual(context, f.context); calls++;
    const next = structuredClone(f.evidence);
    if (calls > 1) next.processesWithRootGroup = [{ pid: 123, fsuid: 1000, groups: [0] }];
    return next;
  };
  const policy = assertRootGroupDirectoryPolicy(f.context, undefined, observer);
  assert.equal(calls, 1);
  assert.throws(() => assertRootGroupDirectoryPolicy(f.context, policy, observer), errorCode);
  assert.equal(calls, 2);
});

test('the exception matches only an explicitly approved physical directory with its exact identity', () => {
  const f = linuxEvidence(), policy = validateRootGroupDirectoryEvidence(f.context, f.evidence);
  const path = f.context.paths.at(-1), observed = f.evidence.directories.find(row => row.path === path);
  const identity = Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid'].map(key => [key, observed[key]]));
  assert.equal(rootGroupDirectoryAllows(policy, path, identity), true);
  assert.equal(rootGroupDirectoryAllows(undefined, path, identity), false, 'without explicit policy the default remains strict');
  assert.equal(rootGroupDirectoryAllows(policy, f.context.harnessRelease, identity), false);
  assert.equal(rootGroupDirectoryAllows(policy, path + '/child', identity), false, 'the exception does not spread to child directories');
  for (const change of [{ dev: identity.dev + 1 }, { ino: identity.ino + 1 }, { mode: 0o777 }, { uid: 1000 }, { gid: 1000 }]) {
    assert.equal(rootGroupDirectoryAllows(policy, path, { ...identity, ...change }), false);
  }
});

test('validated policy retains an independent evidence snapshot rather than a mutable caller reference', () => {
  const f = linuxEvidence(), policy = validateRootGroupDirectoryEvidence(f.context, f.evidence);
  const original = structuredClone(policy);
  f.context.paths[0] = '/opt/unrelated'; f.evidence.sources[0].sha256 = 'f'.repeat(64);
  f.evidence.directories.at(-1).ino++; f.evidence.rootGroup.members.push('fixture-user');
  assert.deepEqual(policy, original);
});

const cli = ['--profile', '/root/.dsh/profiles/web', '--backup', '/data/backup', '--receipt', '/data/receipt.json',
  '--work-root', '/data/work', '--harness', '/opt/deepseek-harness', '--helper', '/data/helper.mjs',
  '--resume-script', '/data/resume.mjs', '--profile-snapshot', '/data/snapshot',
  ...['resume-sha256', 'current-manifest-sha256', 'current-lock-sha256', 'backup-manifest-sha256', 'backup-lock-sha256']
    .flatMap(name => ['--' + name, 'a'.repeat(64)])];

test('CLI opt-in uses explicit repeatable directory names and a real boolean check-only flag', () => {
  const paths = linuxEvidence().context.paths;
  const parsed = parseRestoreOptions([...cli, '--check-only', ...paths.flatMap(path => ['--root-group-writable-dir', path])]);
  assert.equal(parsed['check-only'], true);
  assert.deepEqual(parsed['root-group-writable-dir'], paths);
});

for (const flag of ['--root-group-proof', '--root-group-evidence-file', '--root-group-proof-ok', '--skip-root-group-check']) {
  test(`CLI cannot forge live observation with ${flag}`, () => {
    assert.throws(() => parseRestoreOptions([...cli, flag, '/data/forged-proof.json']));
  });
}

function write(path, contents, mode = 0o644) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path, contents, { mode }); fs.chmodSync(path, mode);
}
function filesystemFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dsh-root-group-policy-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profiles', 'web'), backup = join(root, 'data', 'backup'), workRoot = join(root, 'data', 'work');
  const harnessRelease = join(root, 'release'), name = '@example/fallback', target = join(harnessRelease, 'packages', 'fallback');
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  write(join(target, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  write(join(target, 'index.js'), 'module.exports = true;\n');
  const sourceTarget = join(profile, '.dsh-module-fallback', 'node_modules', name);
  fs.mkdirSync(dirname(sourceTarget), { recursive: true, mode: 0o755 }); fs.symlinkSync(target, sourceTarget);
  const link = join(profile, 'node_modules', name);
  fs.mkdirSync(dirname(link), { recursive: true, mode: 0o755 }); fs.symlinkSync(sourceTarget, link);
  const manifest = { name: 'actual-filesystem-fixture', private: true,
    dependencies: { [name]: '1.0.0', '@deepseek-ai/dsh-pkw-web': '0.1.2-pkw.4' }, dsh: { profile: { bundles: ['@example/host'] } } };
  write(join(profile, 'package.json'), JSON.stringify(manifest)); write(join(profile, 'pnpm-lock.yaml'), '# old\n');
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const component of installationFiles) if (fs.existsSync(join(profile, component))) fs.cpSync(join(profile, component), join(backup, component), {
    recursive: true, dereference: false, verbatimSymlinks: true, filter: () => true,
  });
  manifest.dependencies['@deepseek-ai/dsh-pkw-web'] = '0.1.7-pkw.1';
  write(join(profile, 'package.json'), JSON.stringify(manifest)); write(join(profile, 'pnpm-lock.yaml'), '# current\n');
  const receipt = join(root, 'data', 'receipt.json');
  write(receipt, JSON.stringify({ profile, beforeHost: { [name]: hashFile(join(target, 'index.js')) } }), 0o600);
  const options = { profile, backup, workRoot, receipt, harnessRelease,
    currentManifestHash: hashFile(join(profile, 'package.json')), currentLockHash: hashFile(join(profile, 'pnpm-lock.yaml')),
    backupManifestHash: hashFile(join(backup, 'package.json')), backupLockHash: hashFile(join(backup, 'pnpm-lock.yaml')) };
  const hooks = { checkState() {}, checkWriters() {}, checkSpace() {},
    checkRuntime() { throw new Error('a no-copy preflight must not boot or import runtime libraries'); },
    recheckRuntime() {}, progress() { throw new Error('a no-copy preflight must not allocate or copy'); } };
  return { root, profile, backup, workRoot, target, options, hooks };
}

test('default filesystem policy still rejects 0775 before any evidence or installation copies', async t => {
  const f = filesystemFixture(t); fs.chmodSync(f.target, 0o775);
  const original = installationInventory(f.profile), backup = installationInventory(f.backup), parents = fs.readdirSync(dirname(f.profile));
  await assert.rejects(restoreInstallation(f.options, f.hooks), { code: 'FALLBACK_TARGET_INVALID' });
  assert.deepEqual(fs.readdirSync(f.workRoot), []);
  assert.deepEqual(fs.readdirSync(dirname(f.profile)), parents);
  assert.deepEqual(installationInventory(f.profile), original); assert.deepEqual(installationInventory(f.backup), backup);
  assert.equal(fs.lstatSync(f.target).mode & 0o7777, 0o775, 'rejecting a directory must never tighten its source permissions');
});

test('strict safe targets can use check-only without boot, copying, or transaction artifacts', async t => {
  const f = filesystemFixture(t), original = installationInventory(f.profile), backup = installationInventory(f.backup);
  const parents = fs.readdirSync(dirname(f.profile));
  const result = await restoreInstallation({ ...f.options, checkOnly: true }, f.hooks);
  assert.ok(result);
  assert.deepEqual(fs.readdirSync(f.workRoot), []); assert.deepEqual(fs.readdirSync(dirname(f.profile)), parents);
  assert.deepEqual(installationInventory(f.profile), original); assert.deepEqual(installationInventory(f.backup), backup);
});

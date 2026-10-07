import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { candidateErrorDetails, checkCandidate, parseCandidateOptions } from '../check-dsh-installation-candidate.mjs';
import { installationInventory } from '../restore-dsh-installation-snapshot.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => digest(fs.readFileSync(path));
const script = name => fileURLToPath(new URL('../' + name, import.meta.url));
const libraries = ['@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-host-webserver'];
const hostNames = [...libraries, ...Array.from({ length: 7 }, (_, i) => '@example/host-' + i)];
function write(path, value, mode = 0o644) {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path, value, { mode }); fs.chmodSync(path, mode);
}
function json(path, value, mode = 0o600) { write(path, JSON.stringify(value), mode); }
function allBytes(root) {
  return installationInventory(root, fs.readdirSync(root).sort()).sha256;
}

function fixture(t, directoryApi = true) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dsh-candidate-check-'))), cwd = process.cwd();
  t.after(() => { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });
  const profile = join(root, 'profiles', 'web'), backup = join(root, 'data', 'backup');
  const candidate = join(root, 'profiles', '.dsh-install-candidate-ABC123'), evidence = join(root, 'data', 'evidence');
  const snapshot = join(root, 'data', 'snapshot'), harness = join(root, 'harness'), bundle = join(harness, 'bundle');
  for (const path of [profile, backup, candidate, evidence, snapshot, harness]) fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const manifest = { name: 'fixture-profile', type: 'module', private: true,
    dependencies: Object.fromEntries(hostNames.map(name => [name, '1.0.0'])), dsh: { profile: { bundles: ['@example/bundle'] } } };
  for (const path of [profile, backup, candidate, snapshot]) json(join(path, 'package.json'), manifest);
  for (const path of [profile, backup, candidate]) {
    write(join(path, 'pnpm-lock.yaml'), '# fixture\n');
    for (const name of hostNames) {
      const dir = join(path, 'node_modules', name);
      json(join(dir, 'package.json'), { name, version: '1.0.0', type: 'module', main: 'index.js' }, 0o644);
      write(join(dir, 'index.js'), `export const marker = ${JSON.stringify(name)};\n`);
    }
  }
  for (const path of [profile, candidate]) {
    json(join(path, 'cordis.patch.yml'), []); json(join(path, 'cordis.yml'), []);
    write(join(path, 'pnpm-workspace.yaml'), 'packages: [.]\n');
  }
  json(join(snapshot, 'generated-cordis.yml'), []); json(join(snapshot, 'cordis.patch.yml'), []);
  const rows = libraries.map((name, i) => ({ id: ['storage', 'storage-json', 'storage-domain', 'workspace', 'host-webserver'][i], name,
    ...(i === 1 ? { config: { root: '/fixture/storage' } } : i === 2 ? { config: { backend: 'json' } } : {}) }));
  json(join(bundle, 'package.json'), { name: '@example/bundle', dsh: { bundle: { patch: 'cordis.patch.yml' } } }, 0o644);
  json(join(bundle, 'cordis.patch.yml'), rows, 0o644);
  json(join(harness, 'apps/cli/package.json'), { private: true }, 0o644);
  const bootDir = join(harness, 'node_modules', '@deepseek-ai/dsh-app-boot');
  json(join(bootDir, 'package.json'), { name: '@deepseek-ai/dsh-app-boot', type: 'module', main: 'index.js' }, 0o644);
  write(join(bootDir, 'index.js'), `import * as fs from 'node:fs';\nimport {join} from 'node:path';\n
    export const readProfileManifest = (_bin, path) => JSON.parse(fs.readFileSync(join(path,'package.json')));
    export const resolveBundleDir = () => ${JSON.stringify(bundle)};
    export const loadOverlayPatches = (_bin,path) => JSON.parse(fs.readFileSync(path));
    export const loadOptionalPatches = (_bin,path) => fs.existsSync(path) ? loadOverlayPatches(_bin,path) : undefined;
    export const composeEntries = layers => layers.flat();
    ${directoryApi ? `export const loadProfileDirectory = (_bin,path) => ({layers:[{patches:loadOverlayPatches(_bin,join(${JSON.stringify(bundle)},'cordis.patch.yml'))}],patches:loadOverlayPatches(_bin,join(path,'cordis.patch.yml'))});` : ''}
  `);
  const yamlDir = join(harness, 'vendor/include/node_modules/js-yaml');
  json(join(yamlDir, 'package.json'), { name: 'js-yaml', main: 'index.cjs' }, 0o644);
  write(join(yamlDir, 'index.cjs'), "module.exports={Type:class{},JSON_SCHEMA:{extend(){return {}}},load:buffer=>JSON.parse(buffer.toString())};\n");
  const receipt = join(root, 'data', 'receipt.json'), beforeHost = Object.fromEntries(hostNames.map(name => [name, fileHash(join(candidate, 'node_modules', name, 'index.js'))]));
  json(receipt, { profile, beforeHost });
  const expected = installationInventory(candidate);
  json(join(evidence, 'candidate-expected-inventory.json'), expected);
  const journal = { status: 'stopped-original-installation-retained', errorCode: 'INSTALLATION_RUNTIME_CHECK_FAILED',
    steps: [], installationOnly: true, serviceStarted: false, databaseRestored: false, relocationState: 'applied',
    candidate, profile, backup, receiptHash: fileHash(receipt), candidateExpectedHash: expected.sha256,
    originalHash: installationInventory(profile).sha256, backupHash: installationInventory(backup).sha256,
    linkRelocations: { candidate, profile, backup, links: [], harnessRelease: null } };
  json(join(evidence, 'journal.json'), journal);
  const helper = script('recover-dsh-without-pkw.mjs'), resume = script('resume-dsh-existing-install.mjs');
  const restore = script('restore-dsh-installation-snapshot.mjs');
  const options = { evidence, candidate, profile, backup, receipt, harness, helper, 'helper-sha256': fileHash(helper),
    'resume-script': resume, 'resume-sha256': fileHash(resume), 'restore-script': restore, 'restore-sha256': fileHash(restore),
    'profile-snapshot': snapshot, 'boot-sha256': fileHash(join(bootDir, 'index.js')) };
  process.chdir(harness);
  return { root, options, journal, bootDir, snapshot, candidate, profile, backup, evidence, receipt };
}

test('retained candidate uses the real configuration verifier and all 12 host entries without changing the fixture', async t => {
  const f = fixture(t), before = allBytes(f.root);
  const result = await checkCandidate(f.options);
  assert.equal(result.status, 'CANDIDATE_RUNTIME_PASSED'); assert.equal(result.hosts, 12);
  assert.equal(result.diagnosticOnly, true); assert.equal(result.installationSwitched, false); assert.equal(result.servicesStarted, false);
  assert.match(result.inputsSha256, /^[a-f0-9]{64}$/); assert.ok(result.configurationInputs > 0);
  assert.equal(allBytes(f.root), before);
});

test('the real runtime path accepts the observed Harness API shape without loadProfileDirectory or loadProfile', async t => {
  const f = fixture(t, false), before = allBytes(f.root);
  const result = await checkCandidate(f.options);
  assert.equal(result.status, 'CANDIDATE_RUNTIME_PASSED'); assert.equal(result.hosts, 12);
  assert.equal(allBytes(f.root), before);
});

test('read-only runtime fingerprints do not introduce stricter permissions for existing 0664 code inputs', async t => {
  const f = fixture(t);
  fs.chmodSync(join(f.bootDir, 'index.js'), 0o664);
  fs.chmodSync(join(f.options.harness, 'bundle', 'cordis.patch.yml'), 0o664);
  for (const root of [f.profile, f.backup, f.candidate]) fs.chmodSync(join(root, 'node_modules', hostNames[0], 'index.js'), 0o664);
  const expected = installationInventory(f.candidate);
  json(join(f.evidence, 'candidate-expected-inventory.json'), expected);
  Object.assign(f.journal, { candidateExpectedHash: expected.sha256,
    originalHash: installationInventory(f.profile).sha256, backupHash: installationInventory(f.backup).sha256 });
  json(join(f.evidence, 'journal.json'), f.journal);
  const before = allBytes(f.root);
  assert.equal((await checkCandidate(f.options)).status, 'CANDIDATE_RUNTIME_PASSED');
  assert.equal(allBytes(f.root), before);
});

for (const kind of ['journal state', 'renames', 'candidate path', 'receipt', 'candidate contents', 'current contents', 'backup contents', 'copied configuration', 'source tool hash', 'boot hash']) {
  test(`refuses changed ${kind} without repairing or writing the candidate`, async t => {
    const f = fixture(t), o = { ...f.options };
    if (kind === 'journal state') f.journal.status = 'manual-recovery-required';
    if (kind === 'renames') f.journal.steps.push({ state: 'reverted' });
    if (kind === 'candidate path') f.journal.candidate += '-other';
    if (kind === 'receipt') json(f.receipt, { profile: f.profile, beforeHost: {} });
    if (kind === 'candidate contents') fs.appendFileSync(join(f.candidate, 'node_modules', hostNames[0], 'index.js'), '// candidate drift');
    if (kind === 'current contents') fs.appendFileSync(join(f.profile, 'pnpm-lock.yaml'), '# drift');
    if (kind === 'backup contents') fs.appendFileSync(join(f.backup, 'pnpm-lock.yaml'), '# drift');
    if (kind === 'copied configuration') json(join(f.candidate, 'cordis.patch.yml'), [{ secret: 'DO_NOT_OUTPUT_SECRET' }]);
    if (kind === 'source tool hash') o['restore-sha256'] = 'f'.repeat(64);
    if (kind === 'boot hash') o['boot-sha256'] = 'f'.repeat(64);
    json(join(f.evidence, 'journal.json'), f.journal);
    const before = allBytes(f.root);
    await assert.rejects(checkCandidate(o));
    assert.equal(allBytes(f.root), before);
  });
}

test('configuration-verifier rejection is returned with only structured diagnostics', async t => {
  const f = fixture(t);
  json(join(f.snapshot, 'cordis.patch.yml'), [{ id: 'workspace', name: '@deepseek-ai/dsh-workspace', config: { secret: 'DO_NOT_OUTPUT_SECRET' } }]);
  const before = allBytes(f.root);
  await assert.rejects(checkCandidate(f.options), error => {
    const publicResult = candidateErrorDetails(error);
    assert.equal(JSON.stringify(publicResult).includes('DO_NOT_OUTPUT_SECRET'), false);
    assert.ok(publicResult.code); return true;
  });
  assert.equal(allBytes(f.root), before);
});

test('runtime input drift during the real verifier call cannot return a passing diagnosis', async t => {
  const f = fixture(t), wrapper = join(f.root, 'probe-resume-wrapper.mjs');
  write(wrapper, `import * as fs from 'node:fs';\nimport * as R from ${JSON.stringify(pathToFileURL(f.options['resume-script']).href)};\n
    export async function verifyResumeConfiguration(...args) {
      const result = await R.verifyResumeConfiguration(...args);
      fs.appendFileSync(${JSON.stringify(join(f.candidate, 'node_modules', hostNames[0], 'index.js'))}, '// external runtime drift');
      return result;
    }\n`);
  const options = { ...f.options, 'resume-script': wrapper, 'resume-sha256': fileHash(wrapper) };
  await assert.rejects(checkCandidate(options), { code: 'CANDIDATE_INPUT_CHANGED' });
  assert.equal(installationInventory(f.profile).sha256, f.journal.originalHash);
  assert.equal(installationInventory(f.backup).sha256, f.journal.backupHash);
});

test('diagnostics retain allowed identifiers, packages and stack coordinates without raw messages', () => {
  const e = new TypeError("boot.loadProfileDirectory is not a function; SECRET_VALUE; Cannot find package '@example/missing'");
  e.stack = 'TypeError: SECRET_VALUE\n    at verifyResumeConfiguration (file:///tmp/safe-resume.mjs:189:18)';
  const result = candidateErrorDetails(e);
  assert.deepEqual(result.identifierErrors, [{ kind: 'not-a-function', identifier: 'boot.loadProfileDirectory' }]);
  assert.deepEqual(result.missingPackages, ['@example/missing']);
  assert.deepEqual(result.stackLocations, [{ path: 'file:///tmp/safe-resume.mjs', line: 189, column: 18 }]);
  assert.equal(JSON.stringify(result).includes('SECRET_VALUE'), false);
  const named = candidateErrorDetails(new SyntaxError("The requested module 'SECRET_VALUE' does not provide an export named 'ExpectedName'"));
  assert.deepEqual(named.identifierErrors, [{ kind: 'missing-export', identifier: 'ExpectedName' }]);
  assert.equal(JSON.stringify(named).includes('SECRET_VALUE'), false);
});

test('CLI requires every exact hash and rejects write/start options', () => {
  const keys = ['evidence', 'candidate', 'profile', 'backup', 'receipt', 'harness', 'helper', 'helper-sha256',
    'resume-script', 'resume-sha256', 'restore-script', 'restore-sha256', 'profile-snapshot', 'boot-sha256'];
  const args = keys.flatMap(key => ['--' + key, key.endsWith('sha256') ? 'a'.repeat(64) : '/fixture/' + key]);
  assert.ok(parseCandidateOptions(args));
  assert.throws(() => parseCandidateOptions(args.slice(0, -2)));
  assert.throws(() => parseCandidateOptions([...args, '--apply']));
  assert.throws(() => parseCandidateOptions([...args, '--start']));
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { inspectStartupFile, observeResumeReadiness, parseResumeOptions, recognizedStartHooks, snapshotHostBundles,
  snapshotHostPatches, snapshotWorkspace, startupAction, verifyResumeConfiguration, writerProcessName } from '../resume-dsh-existing-install.mjs';

const exe = '/example/bin/node', script = '/example/ops/session-check.mjs';
const hook = `{ path=${exe} ; argv[]=${exe} ${script} ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
const args = ['--profile', '/root/.dsh/profiles/web', '--harness', '/opt/deepseek-harness',
  '--helper', '/example/recovery-helper.mjs', '--baseline', '/example/baseline',
  '--receipt', '/example/receipt.json', '--data-disk', '/example/data',
  '--trusted-host', 'example.invalid'];

test('resume module can be parsed and imported without starting services or opening server files', () => {
  const path = fileURLToPath(new URL('../resume-dsh-existing-install.mjs', import.meta.url));
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../resume-dsh-existing-install.mjs', import.meta.url).href)}); process.stdout.write('import-only');`], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(output, 'import-only');
});

test('configuration verification rejects missing read-only boot APIs before reading profile files', async () => {
  const required = ['readProfileManifest', 'resolveBundleDir', 'loadOverlayPatches', 'loadOptionalPatches', 'composeEntries'];
  for (const name of required) {
    for (const value of [undefined, 'not-a-function']) {
      const boot = Object.fromEntries(required.map(key => [key, () => { throw new Error('must not run'); }]));
      boot[name] = value;
      await assert.rejects(verifyResumeConfiguration({}, { boot, yaml: {}, H: {} }), { code: 'HOST_BOOT_API_UNSUPPORTED' });
    }
  }
});

test('site inputs stay in arguments and the inspected profile must match the existing web unit', () => {
  assert.equal(parseResumeOptions(args)['trusted-host'], 'example.invalid');
  assert.throws(() => parseResumeOptions(args.map(x => x === '/root/.dsh/profiles/web' ? '/example/other-profile' : x)), { code: 'UNSUPPORTED_SERVICE_PROFILE' });
  assert.throws(() => parseResumeOptions(args.map(x => x === '/example/data' ? 'relative' : x)), { code: 'INVALID_DATA_DISK' });
  assert.throws(() => parseResumeOptions(args.map(x => x === 'example.invalid' ? 'example.invalid --patch other' : x)), { code: 'INVALID_TRUSTED_HOST' });
  assert.throws(() => parseResumeOptions([...args, '--start-pre-exe', exe]), { code: 'INVALID_START_PRE' });
});

test('original startup hook is allowed only with the explicitly bound executable and script', () => {
  assert.equal(recognizedStartHooks('', '', undefined, undefined), true);
  assert.equal(recognizedStartHooks(hook, '', exe, script), true);
  assert.equal(recognizedStartHooks(hook, '', undefined, undefined), false);
  assert.equal(recognizedStartHooks(hook.replace(script, script + ' --repair-all'), '', exe, script), false);
  assert.equal(recognizedStartHooks(hook.replace(exe, '/bin/sh'), '', exe, script), false);
  assert.equal(recognizedStartHooks(hook + ' ' + hook, '', exe, script), false);
  assert.equal(recognizedStartHooks(hook.replace('ignore_errors=yes', 'ignore_errors=no'), '', exe, script), false);
  assert.equal(recognizedStartHooks(hook, hook, exe, script), false);
});

test('active or activating services are observed without a second start request', () => {
  for (const state of ['inactive', 'failed']) assert.equal(startupAction(state), 'start');
  for (const state of ['active', 'activating']) assert.equal(startupAction(state), 'observe');
  for (const state of ['deactivating', 'reloading', 'unknown']) assert.equal(startupAction(state), 'stop');
});

function readinessFixture({ states = ['active'], responses = ['401'], requestMs = 0 } = {}) {
  let time = 0, reads = 0, requests = 0;
  const budgets = [], sleeps = [];
  const hooks = {
    now: () => time,
    sleep: async ms => { sleeps.push(ms); time += ms; },
    readState: async budget => {
      assert.ok(budget > 0);
      return states[Math.min(reads++, states.length - 1)];
    },
    probeHttp: async budget => {
      budgets.push(budget);
      time += Math.min(requestMs, budget);
      const response = responses[Math.min(requests++, responses.length - 1)];
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { hooks, budgets, sleeps, time: () => time, reads: () => reads };
}

test('a listening HTTP server returning 404 waits for two consecutive active accepted homepage responses', async () => {
  const f = readinessFixture({ responses: ['404', '401', '401'] });
  const result = await observeResumeReadiness(f.hooks);
  assert.deepEqual(result, { ready: true, reason: 'READY', state: 'active', http: '401', attempts: 3, elapsedMs: 2000 });
  assert.equal(f.reads(), 6, 'each HTTP response is followed by an active-state check');
});

test('persistent 404 or unavailable transport exhausts one budget without declaring success', async () => {
  for (const response of ['404', '000', new Error('transport unavailable')]) {
    const f = readinessFixture({ responses: [response] });
    const result = await observeResumeReadiness(f.hooks, { timeoutMs: 2500, intervalMs: 1000 });
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'READINESS_TIMEOUT');
    assert.equal(result.attempts, 3);
    assert.equal(f.time(), 2500);
    assert.deepEqual(f.sleeps, [1000, 1000, 500]);
  }
});

test('a process exiting during HTTP cannot be ready and stable stopped states end observation early', async () => {
  const f = readinessFixture({ states: ['active', 'failed', 'inactive'], responses: ['401'] });
  const result = await observeResumeReadiness(f.hooks);
  assert.deepEqual(result, { ready: false, reason: 'SERVICE_STOPPED', state: 'inactive', http: '000', attempts: 1, elapsedMs: 1000 });
});

test('slow HTTP requests receive the remaining budget and late success cannot pass', async () => {
  const f = readinessFixture({ responses: ['401'], requestMs: 1000 });
  const result = await observeResumeReadiness(f.hooks, { timeoutMs: 2200, intervalMs: 500, probeTimeoutMs: 1000 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'READINESS_TIMEOUT');
  assert.deepEqual(f.budgets, [1000, 700]);
  assert.equal(f.time(), 2200);
  assert.equal(f.reads(), 3, 'no extra state request is issued after the deadline');
});

test('crossing a millisecond deadline cannot pass a zero command timeout that would disable the limit', async () => {
  let clockReads = 0;
  const commands = [];
  const result = await observeResumeReadiness({
    now: () => clockReads++ < 2 ? 0 : 1,
    sleep: async () => assert.fail('no time remains for sleeping'),
    readState: async budget => { commands.push(['state', budget]); assert.ok(budget > 0); return 'active'; },
    probeHttp: async budget => { commands.push(['http', budget]); assert.ok(budget > 0); return '401'; },
  }, { timeoutMs: 1 });
  assert.equal(result.reason, 'READINESS_TIMEOUT');
  assert.deepEqual(commands, [['state', 1]]);

  for (let timeoutMs = 1; timeoutMs <= 10; timeoutMs++) {
    let ticks = 0;
    const assertBudget = budget => assert.ok(budget >= 1 && budget <= timeoutMs);
    await observeResumeReadiness({
      now: () => ticks++,
      sleep: async ms => { ticks += ms; },
      readState: async budget => { assertBudget(budget); return 'active'; },
      probeHttp: async budget => { assertBudget(budget); return '401'; },
    }, { timeoutMs, intervalMs: 1, probeTimeoutMs: 1 });
  }
});

test('transient startup states and a failed HTTP round reset readiness', async () => {
  const f = readinessFixture({ states: ['inactive', 'activating', 'active'], responses: ['401', '404', '401', '401'] });
  const result = await observeResumeReadiness(f.hooks, { timeoutMs: 10000 });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 4);
  assert.equal(result.elapsedMs, 5000);
  assert.equal(result.http, '401');
});

test('package managers are checked even when Linux comm includes their action', () => {
  for (const name of ['node', 'npm', 'npm run start', 'pnpm install', 'pnpm add', 'cp', 'python3']) {
    assert.equal(writerProcessName(name), true, name);
  }
  for (const name of ['systemd', 'postgres', 'systemd-resolve', 'npm-exporter']) {
    assert.equal(writerProcessName(name), false, name);
  }
});

const protectedExe = '/example/private/runtime/bin/node';
const protectedOptions = { role: 'executable', privateDirectory: '/example/private', approvedOwner: '1100:1100' };
function startupFixture() {
  const rows = new Map();
  for (const [index, path] of ['/', '/example', '/example/private', '/example/private/runtime',
    '/example/private/runtime/bin', protectedExe, script].entries()) {
    const isFile = path === protectedExe || path === script;
    const ownedRuntime = path.startsWith('/example/private/runtime');
    rows.set(path, { dev: 1, ino: index + 1, mode: (isFile ? 0o100000 : 0o040000)
        | (path === '/example/private' || path === script ? 0o700 : 0o755),
      uid: ownedRuntime ? 1100 : 0, gid: ownedRuntime ? 1100 : 0,
      nlink: 1, size: 4096, mtimeMs: 10, ctimeMs: 10,
      isFile: () => isFile, isDirectory: () => !isFile, isSymbolicLink: () => false });
  }
  const io = { statSync: p => rows.get(p), lstatSync: p => rows.get(p), realpathSync: p => p };
  return { rows, io };
}

test('protected executable approval is paired, numeric and limited to a real descendant', () => {
  const base = [...args, '--start-pre-exe', protectedExe, '--start-pre-script', script];
  const approved = [...base, '--protected-executable-dir', '/example/private', '--protected-executable-owner', '1100:1100'];
  assert.equal(parseResumeOptions(approved)['protected-executable-owner'], '1100:1100');
  for (const extra of [
    ['--protected-executable-dir', '/example/private'],
    ['--protected-executable-owner', '1100:1100'],
    ['--protected-executable-dir', '/', '--protected-executable-owner', '1100:1100'],
    ['--protected-executable-dir', '/example/private/../private', '--protected-executable-owner', '1100:1100'],
    ['--protected-executable-dir', '/example/private', '--protected-executable-owner', '0:0'],
    ['--protected-executable-dir', '/example/private', '--protected-executable-owner', '1100:4294967295'],
    ['--protected-executable-dir', '/example/priv', '--protected-executable-owner', '1100:1100'],
  ]) assert.throws(() => parseResumeOptions([...base, ...extra]), { code: 'INVALID_PROTECTED_EXECUTABLE' });
});

test('existing protected layout accepts only the explicitly approved executable owner', () => {
  const { io } = startupFixture();
  assert.equal(inspectStartupFile(protectedExe, protectedOptions, io).length, 6);
  assert.equal(inspectStartupFile(script, { role: 'script' }, io).length, 1);
  assert.throws(() => inspectStartupFile(protectedExe, { role: 'executable' }, io), { code: 'START_HOOK_FILE_UNSAFE' });
  assert.throws(() => inspectStartupFile(protectedExe, { ...protectedOptions, role: 'script' }, io), { code: 'START_HOOK_FILE_UNSAFE' });
  assert.throws(() => inspectStartupFile(protectedExe, { ...protectedOptions, approvedOwner: '1101:1101' }, io), { code: 'START_HOOK_PATH_OWNER_CHANGED' });
  assert.throws(() => inspectStartupFile(protectedExe, { ...protectedOptions, privateDirectory: '/example/priv' }, io), { code: 'PROTECTED_DIRECTORY_NOT_ANCESTOR' });
});

test('protected layout rejects unsafe ancestor permissions, owners, links and executable identity', () => {
  const cases = [
    ['/example/private', { mode: 0o040755 }, 'PROTECTED_DIRECTORY_NOT_PRIVATE'],
    ['/example/private', { uid: 1100, gid: 1100 }, 'START_HOOK_ANCESTOR_OWNER_CHANGED'],
    ['/example', { mode: 0o040777 }, 'START_HOOK_PATH_WRITABLE'],
    ['/example/private/runtime', { mode: 0o040775 }, 'START_HOOK_PATH_WRITABLE'],
    ['/example/private/runtime', { uid: 1101, gid: 1101 }, 'START_HOOK_PATH_OWNER_CHANGED'],
    ['/example/private/runtime/bin', { isSymbolicLink: () => true }, 'START_HOOK_PATH_TYPE_CHANGED'],
    [protectedExe, { isSymbolicLink: () => true }, 'START_HOOK_PATH_TYPE_CHANGED'],
    [protectedExe, { nlink: 2 }, 'PROTECTED_EXECUTABLE_IDENTITY_CHANGED'],
    [protectedExe, { mode: 0o100700 }, 'PROTECTED_EXECUTABLE_IDENTITY_CHANGED'],
    [protectedExe, { gid: 1101 }, 'START_HOOK_PATH_OWNER_CHANGED'],
  ];
  for (const [path, change, code] of cases) {
    const { io, rows } = startupFixture();
    Object.assign(rows.get(path), change);
    assert.throws(() => inspectStartupFile(protectedExe, protectedOptions, io), { code }, path);
  }
  const { io } = startupFixture();
  io.realpathSync = () => '/example/other/node';
  assert.throws(() => inspectStartupFile(protectedExe, protectedOptions, io), { code: 'START_HOOK_CANONICAL_PATH_CHANGED' });
});

test('startup evidence records file and ancestor changes for the final recheck', () => {
  const { io, rows } = startupFixture();
  const before = inspectStartupFile(protectedExe, protectedOptions, io);
  assert.deepEqual(before, inspectStartupFile(protectedExe, protectedOptions, io));
  rows.get('/example/private/runtime').ctimeMs++;
  assert.notDeepEqual(before, inspectStartupFile(protectedExe, protectedOptions, io));
  rows.get('/example/private/runtime').ctimeMs--;
  rows.get(protectedExe).ino++;
  assert.notDeepEqual(before, inspectStartupFile(protectedExe, protectedOptions, io));
});

function option(base, name, value) {
  const next = [...base], index = next.indexOf(name);
  if (index !== -1) next.splice(index, 2);
  if (value !== undefined) next.push(name, value);
  return next;
}

const envHash = 'a'.repeat(64), rootHash = 'b'.repeat(64);
const snapshotArgs = [...option(args, '--baseline'),
  '--profile-snapshot', '/example/private/profile-snapshot',
  '--snapshot-env-sha256', envHash, '--snapshot-root-sha256', rootHash];

test('snapshot mode binds an explicit source and both hashes without requiring a recovery baseline', () => {
  const before = [...snapshotArgs];
  const parsed = parseResumeOptions(snapshotArgs);
  assert.equal(parsed.baseline, undefined);
  assert.equal(parsed['profile-snapshot'], '/example/private/profile-snapshot');
  assert.equal(parsed['snapshot-env-sha256'], envHash);
  assert.equal(parsed['snapshot-root-sha256'], rootHash);
  assert.deepEqual(snapshotArgs, before);
  assert.equal(parseResumeOptions(args).baseline, '/example/baseline');
});

test('exactly one historical source is required and snapshot hashes cannot decorate baseline mode', () => {
  assert.throws(() => parseResumeOptions(option(args, '--baseline')), { code: 'INVALID_BASELINE_SOURCE' });
  assert.throws(() => parseResumeOptions([...snapshotArgs, '--baseline', '/example/baseline']), { code: 'INVALID_BASELINE_SOURCE' });
  for (const name of ['--snapshot-env-sha256', '--snapshot-root-sha256']) {
    assert.throws(() => parseResumeOptions([...args, name, envHash]), { code: 'INVALID_SNAPSHOT_HASHES' }, name);
  }
});

test('snapshot mode rejects missing, nonhex, uppercase and inexact-length hash bindings', () => {
  for (const name of ['--snapshot-env-sha256', '--snapshot-root-sha256']) {
    for (const value of [undefined, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), envHash + '\n']) {
      assert.throws(() => parseResumeOptions(option(snapshotArgs, name, value)),
        { code: 'INVALID_SNAPSHOT_HASHES' }, `${name}: ${JSON.stringify(value)}`);
    }
  }
});

test('snapshot source paths follow the same absolute-path restrictions as recovery baselines', () => {
  for (const value of ['relative/snapshot', '/example/with space', '/example/%snapshot', '/example/with\\separator']) {
    assert.throws(() => parseResumeOptions(option(snapshotArgs, '--profile-snapshot', value)),
      { code: 'INVALID_PROFILE_SNAPSHOT' }, value);
  }
});

const hostBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
function manifestFixture() {
  const oldManifest = {
    private: true,
    dsh: { profile: { bundles: [...hostBundles, '@deepseek-ai/dsh-pkw-base', '@deepseek-ai/dsh-extension-pkw'] } },
    dependencies: {
      '@deepseek-ai/dsh-base': 'file:/example/harness/base',
      '@deepseek-ai/dsh-web-app': 'file:/example/harness/web',
      '@example/host-extension': '1.0.0',
      '@deepseek-ai/dsh-pkw-web': '0.1.0-pkw.1',
      '@deepseek-ai/dsh-extension-pkw': '0.1.0-pkw.1',
    },
  };
  const currentManifest = structuredClone(oldManifest);
  currentManifest.dsh.profile = { bundles: [...hostBundles], patchReload: 'live' };
  currentManifest.dependencies['@deepseek-ai/dsh-pkw-web'] = '0.2.0-pkw.1';
  currentManifest.dependencies['@deepseek-ai/dsh-extension-pkw'] = '0.2.0-pkw.1';
  return { oldManifest, currentManifest };
}

test('historical host bundles permit only PKW dependency-version changes without rewriting either manifest', () => {
  const { oldManifest, currentManifest } = manifestFixture();
  const oldBefore = structuredClone(oldManifest), currentBefore = structuredClone(currentManifest);
  const actual = snapshotHostBundles(oldManifest, currentManifest);
  assert.deepEqual(actual, hostBundles);
  actual.push('@example/unrelated');
  assert.deepEqual(oldManifest, oldBefore);
  assert.deepEqual(currentManifest, currentBefore);
  assert.equal(Object.hasOwn(oldManifest.dsh.profile, 'patchReload'), false);
});

test('unknown historical PKW bundles and any currently enabled PKW bundle reject recovery', () => {
  {
    const { oldManifest, currentManifest } = manifestFixture();
    oldManifest.dsh.profile.bundles.push('@deepseek-ai/dsh-pkw-extra');
    assert.throws(() => snapshotHostBundles(oldManifest, currentManifest), { code: 'SNAPSHOT_PKW_BUNDLE_UNSUPPORTED' });
  }
  for (const name of ['@deepseek-ai/dsh-pkw-base', '@deepseek-ai/dsh-extension-pkw', '@deepseek-ai/dsh-pkw-extra']) {
    const { oldManifest, currentManifest } = manifestFixture();
    currentManifest.dsh.profile.bundles.push(name);
    assert.throws(() => snapshotHostBundles(oldManifest, currentManifest), { code: 'SNAPSHOT_PKW_STILL_BUNDLED' }, name);
  }
});

test('host bundle membership and order cannot change under a PKW-only recovery', () => {
  for (const bundles of [[...hostBundles].reverse(), hostBundles.slice(0, 1), [...hostBundles, '@example/new-host']]) {
    const { oldManifest, currentManifest } = manifestFixture();
    currentManifest.dsh.profile.bundles = bundles;
    assert.throws(() => snapshotHostBundles(oldManifest, currentManifest), { code: 'SNAPSHOT_HOST_BUNDLES_CHANGED' });
  }
});

test('changing, adding or removing a non-PKW dependency rejects the historical comparison', () => {
  for (const mutate of [
    deps => { deps['@example/host-extension'] = '2.0.0'; },
    deps => { deps['@deepseek-ai/dsh-base'] = 'file:/example/other-harness/base'; },
    deps => { deps['@example/added'] = '1.0.0'; },
    deps => { delete deps['@example/host-extension']; },
  ]) {
    const { oldManifest, currentManifest } = manifestFixture();
    mutate(currentManifest.dependencies);
    assert.throws(() => snapshotHostBundles(oldManifest, currentManifest), { code: 'SNAPSHOT_HOST_DEPENDENCIES_CHANGED' });
  }
});

test('malformed historical or current manifest structures cannot become a host baseline', () => {
  for (const side of ['oldManifest', 'currentManifest']) {
    for (const mutate of [
      manifest => { delete manifest.dsh.profile.bundles; },
      manifest => { manifest.dsh.profile.bundles.push(hostBundles[0]); },
      manifest => { manifest.dsh.profile.bundles[0] = ' ' + hostBundles[0]; },
      manifest => { manifest.dependencies = []; },
      manifest => { delete manifest.dependencies; },
      manifest => { manifest.dependencies['@example/host-extension'] = null; },
    ]) {
      const fixture = manifestFixture();
      mutate(fixture[side]);
      assert.throws(() => snapshotHostBundles(fixture.oldManifest, fixture.currentManifest),
        { code: 'INVALID_SNAPSHOT_MANIFEST' }, side);
    }
  }
});

test('snapshot patch filtering preserves host overrides, mixed inserts and inert JS expressions', () => {
  const expression = { __jsExpr: "(() => { throw new Error('must-not-execute'); })()" };
  const jsonPatch = { id: 'storage-json', config: { root: expression } };
  const domainPatch = { id: 'storage-domain', config: { backend: 'json', routes: { workspace: 'json' } } };
  const workspacePatch = { id: 'workspace', config: { defaultWorkspace: 'workspace_example' } };
  const hostInsert = { id: 'host-extra', name: '@example/host-extra', config: { expression } };
  const prefixLookalike = { id: 'pkwish', name: '@example/pkw-tool', config: { enabled: true } };
  const nestedHost = { id: 'nested-host', name: '@example/nested-host' };
  const patches = [jsonPatch, domainPatch, workspacePatch,
    { id: 'pkw-sync', config: { enabled: false } },
    { id: 'custom-attachment', name: '@deepseek-ai/dsh-pkw-attachments', config: {} },
    { id: 'custom-extension', name: '@deepseek-ai/dsh-extension-pkw' },
    { insert: [hostInsert, { id: 'pkw-notes', name: '@deepseek-ai/dsh-pkw-notes' }, prefixLookalike,
      { id: 'host-group', group: true, config: [nestedHost, { id: 'pkw-nested', name: '@deepseek-ai/dsh-pkw-tasks' }] }] },
  ];
  const before = structuredClone(patches);
  const actual = snapshotHostPatches(patches);
  assert.deepEqual(actual, [jsonPatch, domainPatch, workspacePatch,
    { insert: [hostInsert, prefixLookalike, { id: 'host-group', group: true, config: [nestedHost] }] }]);
  assert.deepEqual(patches, before);
  actual[0].config.root.__jsExpr = 'changed-only-in-result';
  assert.deepEqual(patches, before);
});

test('a PKW-targeted patch cannot silently discard a host insertion', () => {
  const hostInsert = { id: 'host-extra', name: '@example/host-extra' };
  for (const target of [{ id: 'pkw-web' }, { name: '@deepseek-ai/dsh-pkw-web' }]) {
    const patches = [{ ...target, insert: [{ id: 'pkw-only', name: '@deepseek-ai/dsh-pkw-notes' }, hostInsert] }];
    const before = structuredClone(patches);
    assert.throws(() => snapshotHostPatches(patches), { code: 'SNAPSHOT_MIXED_PKW_PATCH' });
    assert.deepEqual(patches, before);
  }
  assert.deepEqual(snapshotHostPatches([{ id: 'pkw-web', insert: [{ id: 'pkw-only' }] }]), []);
});

test('snapshot patch filtering rejects malformed containers instead of treating them as an empty layer', () => {
  for (const patches of [undefined, null, {}, [null], [[]], [{ insert: {} }]]) {
    assert.throws(() => snapshotHostPatches(patches), { code: 'INVALID_SNAPSHOT_PATCHES' });
  }
});

function workspaceRow() {
  return { id: 'workspace', name: '@deepseek-ai/dsh-workspace',
    config: { root: { __jsExpr: "dshHomePath('example-workspace')" } } };
}

test('a unique enabled root workspace is preserved as a detached comparison snapshot', () => {
  const workspace = workspaceRow(), rows = [{ id: 'unrelated', name: '@example/plugin' }, workspace];
  const before = structuredClone(rows);
  const actual = snapshotWorkspace(rows);
  assert.deepEqual(actual, workspace);
  actual.config.root.__jsExpr = 'changed-only-in-result';
  assert.deepEqual(rows, before);
  assert.deepEqual(snapshotWorkspace([{ ...workspace, disabled: false, isolate: {} }]),
    { ...workspace, disabled: false, isolate: {} });
});

test('missing, duplicate, disabled, nested or isolated workspace services cannot authorize startup', () => {
  for (const rows of [undefined, {}, [],
    [workspaceRow(), workspaceRow()],
    [workspaceRow(), { ...workspaceRow(), id: 'second-workspace' }],
    [{ ...workspaceRow(), disabled: true }],
    [{ ...workspaceRow(), name: '@example/replacement-workspace' }],
    [{ ...workspaceRow(), id: 'renamed-workspace' }],
    [{ id: 'group', group: true, config: [workspaceRow()] }],
    [{ ...workspaceRow(), group: true, config: [] }],
    [{ ...workspaceRow(), isolate: { workspace: true } }],
  ]) assert.throws(() => snapshotWorkspace(rows), { code: 'INVALID_SNAPSHOT_WORKSPACE' });
});

test('conflicting host and PKW identities cannot disappear through snapshot filtering', () => {
  for (const row of [
    { id: 'storage-json', name: '@deepseek-ai/dsh-pkw-web' },
    { id: 'pkw-storage', name: '@deepseek-ai/dsh-storage-json' },
  ]) {
    for (const patches of [[row], [{ insert: [row] }]]) {
      const before = structuredClone(patches);
      assert.throws(() => snapshotHostPatches(patches), { code: 'SNAPSHOT_MIXED_PKW_PATCH' });
      assert.deepEqual(patches, before);
    }
  }
});

test('removing a PKW group rejects host descendants at any nested config or insert level', () => {
  const host = { id: 'host-child', name: '@example/host-child' };
  for (const descendant of [host,
    { id: 'pkw-child', group: true, config: [host] },
    { id: 'pkw-child', insert: [host] },
  ]) {
    const row = { id: 'pkw-group', group: true, config: [descendant] };
    for (const patches of [[row], [{ insert: [row] }]]) {
      assert.throws(() => snapshotHostPatches(patches), { code: 'SNAPSHOT_MIXED_PKW_PATCH' });
    }
  }
  const onlyPkw = { id: 'pkw-group', group: true, config: [
    { id: 'pkw-child', insert: [{ id: 'pkw-leaf' }] },
    { id: 'pkw-nested', group: true, config: [{ name: '@deepseek-ai/dsh-pkw-notes' }] },
  ] };
  assert.deepEqual(snapshotHostPatches([onlyPkw]), []);
  assert.deepEqual(snapshotHostPatches([{ insert: [onlyPkw] }]), [{ insert: [] }]);
});

test('historical relative plugin names remain anchored to the original profile location', () => {
  const originalFile = '/example/live-profile/cordis.patch.yml';
  const patches = [{ id: 'existing-target', name: './assertion-name.mjs', insert: [
    { id: 'local-plugin', name: './relative-plugin.mjs' },
    { id: 'host-group', group: true, config: [{ id: 'nested-local', name: '../shared/plugin.mjs' }] },
  ] }];
  const before = structuredClone(patches);
  const actual = snapshotHostPatches(patches, originalFile);
  assert.equal(actual[0].name, './assertion-name.mjs', 'target assertions must remain literal');
  assert.equal(actual[0].insert[0].name, pathToFileURL('/example/live-profile/relative-plugin.mjs').href);
  assert.equal(actual[0].insert[1].config[0].name, pathToFileURL('/example/shared/plugin.mjs').href);
  assert.deepEqual(patches, before);
});

async function fixtureTreeFingerprint(root) {
  const rows = [];
  async function visit(path) {
    const info = await lstat(path), name = relative(root, path) || '.';
    if (info.isDirectory()) {
      rows.push([name, 'directory', info.mode & 0o7777]);
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else {
      assert.equal(info.isFile(), true, `Unexpected fixture file type: ${name}`);
      rows.push([name, 'file', info.mode & 0o7777, createHash('sha256').update(await readFile(path)).digest('hex')]);
    }
  }
  await visit(root);
  return rows;
}

test('real Harness reconstructs a saved profile without installing, evaluating plugins or changing fixture files',
  { skip: !process.env.DSH_RESUME_TEST_HARNESS }, async t => {
    const harness = process.env.DSH_RESUME_TEST_HARNESS;
    assert.equal(isAbsolute(harness), true, 'DSH_RESUME_TEST_HARNESS must be an absolute Harness path');
    const harnessRequire = createRequire(join(harness, 'apps/cli/package.json'));
    const boot = await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
    const legacyBoot = { ...boot, loadProfile() { throw new Error('loadProfile may write and must never be called'); } };
    delete legacyBoot.loadProfileDirectory;
    assert.equal(legacyBoot.loadProfileDirectory, undefined);
    const yaml = createRequire(join(harness, 'vendor/include/package.json'))('js-yaml');
    const H = await import('../recover-dsh-without-pkw.mjs');
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-harness-'));
    const marker = Symbol.for(`dsh-resume-fixture-imports:${root}`);
    const profile = join(root, 'current-profile'), snapshot = join(root, 'saved-profile');
    const install = join(root, 'install'), installAnchor = join(install, 'package.json');
    const homePatchFile = join(root, 'home', 'cordis.patch.yml');
    const libraries = ['@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json',
      '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-host-webserver'];
    const bundleName = '@example/host-bundle';
    const bundle = join(profile, 'node_modules', bundleName);
    const hostPatch = `- id: storage-json
  config:
    root: !!js dshHomePath('storages')
- id: workspace
  config:
    label: saved-workspace
- insert:
    - id: local-extra
      name: ./relative-plugin.mjs
`;
    const oldPatch = hostPatch + `- id: pkw-notes
  config:
    enabled: false
`;
    const homePatch = '- id: host-webserver\n  config:\n    port: 4567\n';
    const options = { profile, installAnchor, snapshot, homePatchFile };
    try {
      for (const path of [profile, snapshot, install, join(root, 'home'), bundle]) await mkdir(path, { recursive: true });
      await writeFile(installAnchor, JSON.stringify({ name: '@example/fixture-install', private: true }));
      const currentManifest = { private: true, type: 'module',
        dependencies: Object.fromEntries([bundleName, ...libraries].map(name => [name, '1.0.0'])),
        dsh: { profile: { bundles: [bundleName], patchReload: 'live' } } };
      const oldManifest = structuredClone(currentManifest);
      oldManifest.dsh.profile.bundles.push('@deepseek-ai/dsh-pkw-base');
      oldManifest.dependencies['@deepseek-ai/dsh-pkw-base'] = '0.1.0-pkw.1';
      delete oldManifest.dsh.profile.patchReload;
      await writeFile(join(profile, 'package.json'), JSON.stringify(currentManifest));
      await writeFile(join(snapshot, 'package.json'), JSON.stringify(oldManifest));
      await writeFile(join(profile, 'cordis.patch.yml'), hostPatch);
      await writeFile(join(snapshot, 'cordis.patch.yml'), oldPatch);
      await writeFile(join(snapshot, 'generated-cordis.yml'), '[]\n');
      await writeFile(homePatchFile, homePatch);
      await writeFile(join(snapshot, 'home-cordis.patch.yml'), homePatch);
      await writeFile(join(profile, 'relative-plugin.mjs'), "throw new Error('composition must not import or activate plugins');\n");
      await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: bundleName, type: 'module',
        version: '1.0.0', main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
      await writeFile(join(bundle, 'index.js'), "throw new Error('composition must not import bundle entry');\n");
      await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: /example/default-storage
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
      config:
        label: bundle-workspace
    - id: host-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        port: 4566
`);
      for (const name of libraries) {
        const path = join(profile, 'node_modules', name);
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }));
        await writeFile(join(path, 'index.js'),
          `const key = Symbol.for(${JSON.stringify(Symbol.keyFor(marker))});\n`
          + `(globalThis[key] ??= new Set()).add(${JSON.stringify(name)});\nexport const fixtureLibrary = true;\n`);
      }
      await assert.rejects(lstat(join(snapshot, 'node_modules')), { code: 'ENOENT' });
      assert.throws(() => boot.resolveBundleDir('dsh', '@deepseek-ai/dsh-pkw-base', installAnchor, profile),
        /cannot resolve profile bundle/, 'the historical PKW bundle is intentionally not installed');

      for (const [apiLabel, publicBoot] of [['modern public APIs', boot], ['legacy public APIs without loadProfileDirectory', legacyBoot]]) {
        await t.test(`reconstructs through ${apiLabel} with original layer semantics and relative-plugin anchor`, async () => {
          const before = await fixtureTreeFingerprint(root), compositions = [];
          let manifestReads = 0;
          const inspectedBoot = { ...publicBoot, readProfileManifest(...args) {
            manifestReads++;
            return publicBoot.readProfileManifest(...args);
          }, composeEntries(layers, warn) {
            const rows = boot.composeEntries(layers, warn);
            compositions.push(structuredClone(rows));
            return rows;
          } };
          const nativeProfile = boot.loadProfileDirectory('dsh', profile, installAnchor);
          const oracleWarnings = [];
          const oracleRows = boot.composeEntries([...nativeProfile.layers.map(layer => layer.patches), nativeProfile.patches,
            boot.loadOptionalPatches('dsh', homePatchFile) ?? []], warning => oracleWarnings.push(warning));
          assert.deepEqual(oracleWarnings, []);
          const result = await verifyResumeConfiguration(options, { boot: inspectedBoot, yaml, H });
          assert.equal(manifestReads, 1, 'the official read-only manifest validator must run');
          assert.equal(result.sourceKind, 'saved-profile-inputs-current-host-bundles');
          assert.equal(compositions.length, 2);
          assert.deepEqual(compositions[0], oracleRows, 'public API composition must match the directory reader layer order');
          for (const rows of compositions) {
            assert.equal(rows.find(row => row.id === 'local-extra').name, pathToFileURL(join(profile, 'relative-plugin.mjs')).href);
            assert.equal(rows.some(row => row.id === 'pkw-notes'), false);
            assert.deepEqual(rows.find(row => row.id === 'storage-json').config.root, { __jsExpr: "dshHomePath('storages')" });
            assert.equal(rows.find(row => row.id === 'workspace').config.label, 'saved-workspace');
          }
          assert.deepEqual([...globalThis[marker]].sort(), [...libraries].sort(), 'all five installed library entries were imported');
          assert.ok(result.inputs.some(([path]) => path === join(bundle, 'cordis.patch.yml')));
          assert.ok(result.inputs.some(([path]) => path === join(snapshot, 'package.json')));
          assert.equal(result.inputs.some(([path]) => path.startsWith(join(snapshot, 'node_modules'))), false);
          assert.deepEqual(await fixtureTreeFingerprint(root), before);
        });
      }

      await t.test('legacy API rejects invalid manifests and patchReload without normalizing or writing them', async () => {
        const manifestFile = join(profile, 'package.json');
        for (const [value, rejection] of [
          [[], /must hold a JSON object/],
          [{ ...currentManifest, dsh: { profile: { ...currentManifest.dsh.profile, patchReload: 'sometimes' } } }, { code: 'INVALID_PROFILE_PATCH_RELOAD' }],
          [{ ...currentManifest, dsh: { profile: { ...currentManifest.dsh.profile, bundles: bundleName } } }, { code: 'INVALID_PROFILE_BUNDLES' }],
        ]) {
          await writeFile(manifestFile, JSON.stringify(value));
          try {
            const before = await fixtureTreeFingerprint(root);
            await assert.rejects(verifyResumeConfiguration(options, { boot: legacyBoot, yaml, H }), rejection);
            assert.deepEqual(await fixtureTreeFingerprint(root), before);
          } finally { await writeFile(manifestFile, JSON.stringify(currentManifest)); }
        }
      });

      await t.test('legacy API accepts default and startup patchReload without persisting defaults', async () => {
        const manifestFile = join(profile, 'package.json');
        for (const patchReload of [undefined, 'startup']) {
          const manifest = structuredClone(currentManifest);
          if (patchReload === undefined) delete manifest.dsh.profile.patchReload;
          else manifest.dsh.profile.patchReload = patchReload;
          await writeFile(manifestFile, JSON.stringify(manifest));
          try {
            const before = await fixtureTreeFingerprint(root);
            await verifyResumeConfiguration(options, { boot: legacyBoot, yaml, H });
            assert.deepEqual(await fixtureTreeFingerprint(root), before);
          } finally { await writeFile(manifestFile, JSON.stringify(currentManifest)); }
        }
      });

      await t.test('manifest parser output must match the bound file rather than silently normalize it', async () => {
        const before = await fixtureTreeFingerprint(root);
        const changedBoot = { ...legacyBoot, readProfileManifest(...args) {
          const manifest = boot.readProfileManifest(...args);
          manifest.dsh.profile.bundles = [];
          return manifest;
        } };
        await assert.rejects(verifyResumeConfiguration(options, { boot: changedBoot, yaml, H }), { code: 'BUNDLE_FILES_CHANGED_DURING_CHECK' });
        assert.deepEqual(await fixtureTreeFingerprint(root), before);
      });

      for (const [title, changedPatch, rejection] of [
        ['rejects a different historical JSON root', oldPatch.replace("root: !!js dshHomePath('storages')", 'root: /example/different-storage'),
          { code: 'JSON_STORAGE_CONFIG_CHANGED' }],
        ['rejects different historical workspace configuration', oldPatch.replace('label: saved-workspace', 'label: other-workspace'),
          { code: 'WORKSPACE_CONFIG_CHANGED' }],
      ]) {
        await t.test(title, async () => {
          await writeFile(join(snapshot, 'cordis.patch.yml'), changedPatch);
          try {
            const before = await fixtureTreeFingerprint(root);
            for (const api of [boot, legacyBoot]) {
              await assert.rejects(verifyResumeConfiguration(options, { boot: api, yaml, H }), rejection);
            }
            assert.deepEqual(await fixtureTreeFingerprint(root), before);
          } finally { await writeFile(join(snapshot, 'cordis.patch.yml'), oldPatch); }
        });
      }
      await t.test('rejects a missing historical home layer when a current home patch exists', async () => {
        await rm(join(snapshot, 'home-cordis.patch.yml'));
        const before = await fixtureTreeFingerprint(root);
        for (const api of [boot, legacyBoot]) {
          await assert.rejects(verifyResumeConfiguration(options, { boot: api, yaml, H }), { code: 'SNAPSHOT_HOME_LAYER_MISSING' });
        }
        assert.deepEqual(await fixtureTreeFingerprint(root), before);
      });
    } finally {
      delete globalThis[marker];
      await rm(root, { recursive: true, force: true });
    }
  });

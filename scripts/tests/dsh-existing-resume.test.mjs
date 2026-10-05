import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectStartupFile, parseResumeOptions, recognizedStartHooks, startupAction, writerProcessName } from '../resume-dsh-existing-install.mjs';

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

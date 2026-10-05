import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseResumeOptions, recognizedStartHooks, startupAction, writerProcessName } from '../resume-dsh-existing-install.mjs';

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

#!/usr/bin/env node
// Resume an existing DSH installation after an interrupted deployment.
// Site paths are supplied privately by the caller. Never reinstall packages,
// replace configuration, restore databases, or start the PKW service.
import * as fs from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual as equal, parseArgs } from 'node:util';


export function parseResumeOptions(args) {
  const options = Object.fromEntries([
    'profile', 'harness', 'helper', 'baseline', 'receipt', 'data-disk',
    'trusted-host', 'start-pre-exe', 'start-pre-script',
  ].map(name => [name, { type: 'string' }]));
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  for (const name of ['profile', 'harness', 'helper', 'baseline', 'receipt', 'data-disk']) {
    if (!values[name] || !isAbsolute(values[name]) || /[\s%\\]/.test(values[name])) {
      throw Object.assign(new Error('Invalid path option'), { code: 'INVALID_' + name.toUpperCase().replaceAll('-', '_') });
    }
  }
  if (!/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(values['trusted-host'] ?? '')) {
    throw Object.assign(new Error('Invalid host option'), { code: 'INVALID_TRUSTED_HOST' });
  }
  if (values.profile !== '/root/.dsh/profiles/web' || values.harness !== '/opt/deepseek-harness') {
    throw Object.assign(new Error('Existing service profile differs'), { code: 'UNSUPPORTED_SERVICE_PROFILE' });
  }
  const pre = [values['start-pre-exe'], values['start-pre-script']];
  if (pre.some(Boolean) && !pre.every(p => p && isAbsolute(p) && !/[\s%\\]/.test(p))) {
    throw Object.assign(new Error('Invalid startup hook options'), { code: 'INVALID_START_PRE' });
  }
  return values;
}

export function startupAction(state) {
  if (['inactive', 'failed'].includes(state)) return 'start';
  if (['active', 'activating'].includes(state)) return 'observe';
  return 'stop';
}

export function writerProcessName(comm) {
  return /^(?:node|cp|rsync|rm|mv|tar|bash|sh|python3?)$|^(?:npm|pnpm)(?:\s|$)/.test(comm);
}

export function recognizedStartHooks(pre, post, executable, script) {
  if (post) return false;
  if (!pre) return true;
  if (!executable || !script) return false;
  const commands = [...pre.matchAll(/\{ path=([^;]+?) ; argv\[\]=([^;]*?) ; ignore_errors=(yes|no) ;/g)];
  return commands.length === 1 && (pre.match(/\{ path=/g) ?? []).length === 1
    && commands[0].index === 0 && pre.endsWith(' }')
    && commands[0][1] === executable && commands[0][2] === executable + ' ' + script
    && commands[0][3] === 'yes';
}

async function resume(options) {
  const { profile, harness, helper, baseline, receipt: receiptFile } = options;
  const host = options['trusted-host'];
  const unit = 'deepseek-harness.service', pkwUnit = 'pkw-collaboration.service';
  let preflightPassed = false;
let check = 'identity', target = '/', evidence;
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const need = (ok, code) => { if (!ok) fail(code); };
const sha = b => createHash('sha256').update(b).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
const prop = (name, service = unit) => run('systemctl', ['show', service, '--property=' + name, '--value']).trim();
function reviewStartHooks(pre, post) {
  const executable = options['start-pre-exe'];
  const script = options['start-pre-script'];
  const commands = [...pre.matchAll(/\{ path=([^;]+?) ; argv\[\]=([^;]*?) ; ignore_errors=(yes|no) ;/g)];
  const known = recognizedStartHooks(pre, post, executable, script);
  if (!known) {
    console.log(JSON.stringify({ startPrePresent: !!pre, startPostPresent: !!post,
      knownSessionHealCommand: known, preExecutablePaths: commands.map(x => x[1]),
      preSha256: sha(pre), postSha256: sha(post) }));
    fail('UNIT_START_HOOK_UNKNOWN');
  }
  for (const path of pre ? [executable, script] : []) {
    const info = fs.statSync(path);
    need(info.isFile() && info.uid === 0 && !(info.mode & 0o022), 'START_HOOK_FILE_UNSAFE');
  }
  return pre ? [executable, script] : [];
}
function writers() {
  const units = run('systemctl', ['list-units', '--type=service', '--state=active,activating', '--no-legend', '--plain', '--no-pager']);
  const active = units.split('\n').find(x => /^\S*pkw\S*(deploy|upgrade|rehears)\S*\.service\s/.test(x.trimStart()));
  if (active) { console.log(JSON.stringify({ activeDeploymentUnit: active.trim().split(/\s+/)[0] })); fail('DEPLOY_UNIT_ACTIVE'); }
  for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x) && Number(x) !== process.pid)) {
    let args, cwd, comm;
    try {
      comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (!writerProcessName(comm)) continue;
      args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      cwd = fs.realpathSync(`/proc/${pid}/cwd`);
    } catch (e) {
      if (['ENOENT', 'ESRCH'].includes(e.code)) continue;
      console.log(JSON.stringify({ unknownWriterPid: Number(pid), comm, code: e.code }));
      fail('WRITER_CHECK_UNREADABLE');
    }
    const inProfile = cwd === profile || cwd.startsWith(profile + '/') || args.includes(profile);
    const installer = writerProcessName(comm);
    const deploy = /(?:run-production\.sh|deploy-site\.mjs|deploy-pkw\.mjs|run-rehearsal[^ ]*\.sh)/.test(args);
    if (deploy || inProfile && installer) {
      console.log(JSON.stringify({ writerPid: Number(pid), comm, cwd }));
      fail('PROFILE_WRITER_ACTIVE');
    }
  }
}
try {
  need(process.getuid() === 0 && (fs.statSync('/').mode & 0o777) === 0o755, 'ROOT_IDENTITY_CHANGED');
  need(fs.statfsSync('/').bavail * fs.statfsSync('/').bsize > 1024 ** 3, 'SYSTEM_DISK_LOW');
  check = 'writers'; target = profile; writers();
  check = 'unit'; target = unit;
  need(['failed', 'inactive'].includes(prop('ActiveState')), 'DSH_STATE_CHANGED');
  need(prop('ActiveState', pkwUnit) === 'inactive', 'PKW_NOT_STOPPED');
  const command = prop('ExecStart');
  need(command.includes(`argv[]=/usr/local/bin/node --import tsx/esm ${harness}/apps/cli/src/bin.ts web --host 127.0.0.1 --port 3080 --trusted-host ${host} ;`), 'UNIT_ENTRY_CHANGED');
  const startPre = prop('ExecStartPre'), startPost = prop('ExecStartPost');
  const startHookFiles = reviewStartHooks(startPre, startPost);
  need(!run('ss', ['-ltnH', 'sport = :3080']).trim(), 'PORT_3080_BUSY');
  check = 'helper'; target = helper;
  need(sha(fs.readFileSync(helper)) === '4371a15bfd6c61e388f05c1cf7c3a1bebc8dac775dba01e5f5f5216a9ae7e250', 'HELPER_HASH_CHANGED');
  const H = await import(pathToFileURL(helper).href);
  const names = ['User', 'Group', 'WorkingDirectory', 'EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment', 'PAMName', 'RootDirectory', 'RootImage', 'DynamicUser', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem'];
  const properties = Object.fromEntries(names.map(k => [k, prop(k)]));
  const unitEnv = prop('Environment'), managerEnv = run('systemctl', ['show-environment']);
  let environment = H.recoveryEnvironment(managerEnv, unitEnv, properties);
  check = 'verified-baseline'; target = baseline;
  const old = JSON.parse(fs.readFileSync(join(baseline, 'receipt.json'), 'utf8'));
  need(old.status === 'configuration-verified-service-not-started' && old.checks?.hostStorage === 'json', 'BASELINE_NOT_VERIFIED');
  const envPath = H.confirmedEnvironmentFile(properties.EnvironmentFiles);
  need(envPath && old.environmentFile?.path === envPath, 'ENVIRONMENT_SOURCE_CHANGED');
  const envBytes = fs.readFileSync(envPath);
  H.environmentFileIdentity(fs.lstatSync(envPath));
  need(H.inspectEnvironmentFile(envBytes).sha256 === old.environmentFile.sha256, 'ENVIRONMENT_HASH_CHANGED');
  check = 'host-hashes'; target = receiptFile;
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  need(receipt.profile === profile && receipt.beforeHost && Object.keys(receipt.beforeHost).length > 0, 'HOST_BASELINE_MISSING');
  const require = createRequire(join(profile, 'package.json'));
  const entries = [];
  for (const [name, expected] of Object.entries(receipt.beforeHost)) {
    target = name; const entry = require.resolve(name);
    need(sha(fs.readFileSync(entry)) === expected, 'HOST_HASH_CHANGED');
    entries.push(entry);
  }
  check = 'inputs'; target = profile;
  const monitoredInputs = [join(profile, 'package.json'), join(profile, 'pnpm-lock.yaml'), join(profile, 'cordis.patch.yml'), '/root/.dsh/cordis.patch.yml', envPath, helper, join(baseline, 'effective.yml'), ...entries, ...startHookFiles];
  const fingerprint = () => monitoredInputs.map(p => [p, fs.existsSync(p) ? sha(fs.readFileSync(p)) : null]);
  const before = fingerprint(), identity = H.runtimeDirectoryIdentity(harness);
  const disk = options['data-disk'];
  need(fs.realpathSync(disk) === disk && fs.statSync(disk).dev !== fs.statSync('/').dev, 'DATA_MOUNT_CHANGED');
  evidence = fs.mkdtempSync(join(disk, 'pkw-dsh-resume-')); fs.chmodSync(evidence, 0o700);
  const baseFile = join(evidence, 'base.env'), sourceSnapshot = join(evidence, 'service.env');
  fs.writeFileSync(baseFile, H.serializeProbeBaseEnvironment(environment), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(sourceSnapshot, envBytes, { mode: 0o600, flag: 'wx' });
  environment = H.collectEffectiveEnvironment({ baseFile, sourceSnapshot, unitName: `pkw-dsh-env-${process.pid}-${Date.now()}` });
  check = 'runtime-config'; target = profile;
  const code = H.runtimeEnvironmentProbe(harness, identity) + `
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const { isDeepStrictEqual } = await import('node:util');
    const H = await import(${JSON.stringify(pathToFileURL(helper).href)});
    const boot = await import('@deepseek-ai/dsh-app-boot');
    const p = boot.loadProfileDirectory('dsh', ${JSON.stringify(profile)}, ${JSON.stringify(join(identity.canonical, 'apps/cli/package.json'))});
    const warnings = [];
    const rows = boot.composeEntries([...p.layers.map(x => x.patches), p.patches, boot.loadOptionalPatches('dsh', '/root/.dsh/cordis.patch.yml') ?? []], x => warnings.push(x));
    if (warnings.length) throw new Error('CONFIG_PATCH_WARNING');
    const yaml = createRequire(${JSON.stringify(join(identity.canonical, 'vendor/include/package.json'))})('js-yaml');
    const js = new yaml.Type('tag:yaml.org,2002:js', {kind:'scalar', construct: v => ({__jsExpr:v})});
    const baseline = yaml.load(readFileSync(${JSON.stringify(join(baseline, 'effective.yml'))}, 'utf8'), {schema:yaml.JSON_SCHEMA.extend(js)});
    H.verifyRecovery(rows, H.jsonStorageConfig(baseline));
    if (!isDeepStrictEqual(rows.find(x => x.id === 'workspace'), baseline.find(x => x.id === 'workspace'))) throw new Error('WORKSPACE_CONFIG_CHANGED');
    const profileRequire = createRequire(${JSON.stringify(join(profile, 'package.json'))});
    for (const name of ['@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-host-webserver']) {
      const { pathToFileURL } = await import('node:url');
      await import(pathToFileURL(profileRequire.resolve(name)).href);
    }
    process.stdout.write(' config-verified');
  `;
  try {
    const result = execFileSync('/usr/local/bin/node', ['--import', 'tsx/esm', '--input-type=module', '-e', code], { cwd: identity.canonical, env: environment, timeout: 30000, encoding: 'utf8', maxBuffer: 524288, stdio: ['ignore', 'pipe', 'pipe'] });
    need(result === 'environment-verified config-verified', 'PROBE_OUTPUT_CHANGED');
  } catch (e) {
    fs.writeFileSync(join(evidence, 'probe-error.log'), e.stderr ?? String(e.code ?? 'PROBE_FAILED'), { mode: 0o600 });
    const category = ['CONFIG_PATCH_WARNING', 'WORKSPACE_CONFIG_CHANGED'].find(x => String(e.stderr).includes(x));
    fail(category ?? H.runtimePreflightFailure(e));
  }
  check = 'final-recheck'; target = profile; writers();
  H.assertRuntimeDirectories(harness, identity, harness, undefined);
  need(equal(before, fingerprint()), 'FILES_CHANGED_DURING_CHECK');
  reviewStartHooks(prop('ExecStartPre'), prop('ExecStartPost'));
  need(prop('ExecStart') === command && prop('ExecStartPre') === startPre && prop('ExecStartPost') === startPost && names.every(k => prop(k) === properties[k]) && prop('Environment') === unitEnv && run('systemctl', ['show-environment']) === managerEnv, 'UNIT_CHANGED_DURING_CHECK');
  need(['failed', 'inactive'].includes(prop('ActiveState')) && prop('ActiveState', pkwUnit) === 'inactive', 'SERVICE_STATE_CHANGED');
  console.log('DSH_PREFLIGHT_OK; no configuration or database was replaced.');
  preflightPassed = true;
} catch (e) {
  console.error(JSON.stringify({ status: 'STOP', check, target, code: e.code ?? 'CHECK_FAILED', ...(evidence ? { privateEvidence: evidence } : {}) }));
  process.exitCode = 1;
}
  if (preflightPassed) {
    try {
      const action = startupAction(prop('ActiveState'));
      if (action === 'start') {
        run('systemctl', ['reset-failed', unit]);
        run('systemctl', ['start', '--no-block', unit]);
        console.log('DSH_START_REQUESTED_ONCE');
      } else if (action === 'observe') {
        console.log('DSH_ALREADY_STARTING_OR_RUNNING; observing only.');
      } else { fail('SERVICE_STATE_CHANGED'); }
      for (let round = 0; round < 25; round++) {
        if (run('ss', ['-ltnH', 'sport = :3080']).trim()) break;
        if (round >= 2 && ['failed', 'inactive'].includes(prop('ActiveState'))) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(JSON.stringify({ status: 'START_OR_OBSERVE_FAILED', code: e.code ?? 'CHECK_FAILED' }));
      process.exitCode = 1;
    }
  }
  try {
    console.log(run('systemctl', ['show', unit, pkwUnit, '--property=Id', '--property=ActiveState', '--property=SubState', '--property=MainPID', '--property=ExecMainStatus']).trim());
    console.log(run('ss', ['-ltnH', '( sport = :3080 or sport = :3081 )']).trim());
    let http = '000';
    try {
      http = run('/usr/bin/curl', ['-q', '-sS', '--noproxy', '*', '--connect-timeout', '3', '--max-time', '5', '-H', 'Host: ' + host, '-o', '/dev/null', '-w', '%{http_code}', 'http://127.0.0.1:3080/']).trim();
    } catch { /* No raw curl errors or unrelated credentials are printed. */ }
    console.log('DSH HTTP=' + http);
    const state = prop('ActiveState');
    if (state === 'activating') console.log('DSH_STILL_STARTING; do not repeat the command or resume deployment.');
    if (state !== 'active' || !['200', '301', '302', '303', '307', '308', '401', '403'].includes(http)) process.exitCode = 1;
  } catch (e) {
    console.error(JSON.stringify({ status: 'OBSERVATION_FAILED', code: e.code ?? 'CHECK_FAILED' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await resume(parseResumeOptions(process.argv.slice(2))); }
  catch (e) {
    console.error(JSON.stringify({ status: 'STOP', code: e.code ?? 'CHECK_FAILED' }));
    process.exitCode = 1;
  }
}

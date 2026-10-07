#!/usr/bin/env node
// Resume an existing DSH installation after an interrupted deployment.
// Site paths are supplied privately by the caller. Never reinstall packages,
// replace configuration, restore databases, or start the PKW service.
import * as fs from 'node:fs';
import { join, isAbsolute, resolve, dirname, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual as equal, parseArgs } from 'node:util';


export function parseResumeOptions(args) {
  const options = Object.fromEntries([
    'profile', 'harness', 'helper', 'baseline', 'receipt', 'data-disk',
    'trusted-host', 'start-pre-exe', 'start-pre-script',
    'protected-executable-dir', 'protected-executable-owner',
    'profile-snapshot', 'snapshot-env-sha256', 'snapshot-root-sha256',
  ].map(name => [name, { type: 'string' }]));
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  if (Boolean(values.baseline) === Boolean(values['profile-snapshot'])) {
    throw Object.assign(new Error('Choose exactly one historical source'), { code: 'INVALID_BASELINE_SOURCE' });
  }
  for (const name of ['profile', 'harness', 'helper', 'receipt', 'data-disk', values.baseline ? 'baseline' : 'profile-snapshot']) {
    if (!values[name] || !isAbsolute(values[name]) || /[\s%\\]/.test(values[name])) {
      throw Object.assign(new Error('Invalid path option'), { code: 'INVALID_' + name.toUpperCase().replaceAll('-', '_') });
    }
  }
  const snapshotHashes = [values['snapshot-env-sha256'], values['snapshot-root-sha256']];
  if (values['profile-snapshot'] ? !snapshotHashes.every(x => /^[a-f0-9]{64}$/.test(x ?? '')) : snapshotHashes.some(x => x !== undefined)) {
    throw Object.assign(new Error('Snapshot hashes must be explicitly supplied'), { code: 'INVALID_SNAPSHOT_HASHES' });
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
  const privateDir = values['protected-executable-dir'], owner = values['protected-executable-owner'];
  if (privateDir !== undefined || owner !== undefined) {
    const ids = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(owner ?? '');
    const validIds = ids && Number(ids[1]) > 0 && ids.slice(1).every(x => Number(x) < 4294967295);
    const below = privateDir && pre[0] ? relative(privateDir, pre[0]) : '';
    if (!privateDir || !isAbsolute(privateDir) || resolve(privateDir) !== privateDir || privateDir === '/'
        || /[\s%\\]/.test(privateDir) || !validIds || !pre.every(Boolean)
        || !below || isAbsolute(below) || below === '..' || below.startsWith('../')) {
      throw Object.assign(new Error('Invalid protected executable options'), { code: 'INVALID_PROTECTED_EXECUTABLE' });
    }
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

const snapshotPkwBundles = new Set(['@deepseek-ai/dsh-pkw-base', '@deepseek-ai/dsh-extension-pkw']);
const snapshotPkwName = name => typeof name === 'string' && (name.startsWith('@deepseek-ai/dsh-pkw-') || name === '@deepseek-ai/dsh-extension-pkw');
const snapshotPkwEntry = row => snapshotPkwName(row?.name) || /^pkw(?:-|$)/.test(row?.id ?? '');
const snapshotHostIds = new Set(['storage', 'storage-json', 'storage-domain', 'workspace', 'host-webserver']);
const snapshotHostNames = new Set(['@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-host-webserver']);
const snapshotHostEntry = row => snapshotHostIds.has(row?.id) || snapshotHostNames.has(row?.name);
const snapshotError = code => { throw Object.assign(new Error(code), { code }); };

export function snapshotHostBundles(oldManifest, currentManifest) {
  const lists = [oldManifest, currentManifest].map(m => m?.dsh?.profile?.bundles);
  if (lists.some(list => !Array.isArray(list) || !list.every(x => typeof x === 'string' && x.trim() === x && x)
      || new Set(list).size !== list.length)) snapshotError('INVALID_SNAPSHOT_MANIFEST');
  if (lists[0].some(name => snapshotPkwName(name) && !snapshotPkwBundles.has(name))) snapshotError('SNAPSHOT_PKW_BUNDLE_UNSUPPORTED');
  if (lists[1].some(snapshotPkwName)) snapshotError('SNAPSHOT_PKW_STILL_BUNDLED');
  const host = lists[0].filter(name => !snapshotPkwBundles.has(name));
  if (!equal(host, lists[1])) snapshotError('SNAPSHOT_HOST_BUNDLES_CHANGED');
  const deps = m => {
    if (!m.dependencies || typeof m.dependencies !== 'object' || Array.isArray(m.dependencies)
        || Object.values(m.dependencies).some(x => typeof x !== 'string')) snapshotError('INVALID_SNAPSHOT_MANIFEST');
    return Object.fromEntries(Object.entries(m.dependencies).filter(([name]) => !snapshotPkwName(name)));
  };
  if (!equal(deps(oldManifest), deps(currentManifest))) snapshotError('SNAPSHOT_HOST_DEPENDENCIES_CHANGED');
  return host;
}

// A historical PKW layer is excluded only from the comparison tree. Host
// overrides are retained; the production tree is never filtered or changed.
export function snapshotHostPatches(patches, originalFile) {
  if (!Array.isArray(patches)) snapshotError('INVALID_SNAPSHOT_PATCHES');
  const checkRemoval = row => {
    if (snapshotHostEntry(row)) snapshotError('SNAPSHOT_MIXED_PKW_PATCH');
    for (const children of [row?.insert, row?.group ? row.config : undefined]) {
      if (children === undefined) continue;
      if (!Array.isArray(children)) snapshotError('INVALID_SNAPSHOT_PATCHES');
      for (const child of children) {
        if (!snapshotPkwEntry(child)) snapshotError('SNAPSHOT_MIXED_PKW_PATCH');
        checkRemoval(child);
      }
    }
  };
  const inserts = rows => {
    if (!Array.isArray(rows)) snapshotError('INVALID_SNAPSHOT_PATCHES');
    const result = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) snapshotError('INVALID_SNAPSHOT_PATCHES');
      if (snapshotPkwEntry(row)) { checkRemoval(row); continue; }
      const next = structuredClone(row);
      if (originalFile && typeof next.name === 'string' && (isAbsolute(next.name) || next.name.startsWith('./') || next.name.startsWith('../'))) {
        next.name = pathToFileURL(resolve(dirname(originalFile), next.name)).href;
      }
      if (next.group && Array.isArray(next.config)) next.config = inserts(next.config);
      result.push(next);
    }
    return result;
  };
  const result = [];
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) snapshotError('INVALID_SNAPSHOT_PATCHES');
    if (snapshotPkwEntry(patch)) {
      checkRemoval(patch);
      continue;
    }
    const next = structuredClone(patch);
    if (next.insert !== undefined) next.insert = inserts(next.insert);
    result.push(next);
  }
  return result;
}

export function snapshotWorkspace(rows) {
  if (!Array.isArray(rows)) snapshotError('INVALID_SNAPSHOT_WORKSPACE');
  const matches = [];
  const visit = list => { for (const row of list) {
    if (row?.id === 'workspace' || row?.name === '@deepseek-ai/dsh-workspace') matches.push(row);
    if (row?.group && Array.isArray(row.config)) visit(row.config);
  } };
  visit(rows);
  const row = matches[0];
  if (matches.length !== 1 || !rows.includes(row) || row.id !== 'workspace'
      || row.name !== '@deepseek-ai/dsh-workspace' || row.disabled || row.group
      || row.isolate != null && Object.keys(row.isolate).length) snapshotError('INVALID_SNAPSHOT_WORKSPACE');
  return structuredClone(row);
}

/** Compose configuration without CLI boot, link repair, installs or writes. */
export async function verifyResumeConfiguration({ profile, installAnchor, baselineFile, snapshot, homePatchFile }, { boot, yaml, H }) {
  // Older supported Harness releases expose these readers but do not export
  // loadProfileDirectory. Do not substitute loadProfile: it can initialize or
  // normalize the profile on disk before returning the same configuration.
  for (const name of ['readProfileManifest', 'resolveBundleDir', 'loadOverlayPatches', 'loadOptionalPatches', 'composeEntries']) {
    if (typeof boot?.[name] !== 'function') snapshotError('HOST_BOOT_API_UNSUPPORTED');
  }
  const watched = new Map();
  const watch = path => {
    const bytes = fs.readFileSync(path), hash = createHash('sha256').update(bytes).digest('hex');
    if (watched.has(path) && watched.get(path) !== hash) snapshotError('BUNDLE_FILES_CHANGED_DURING_CHECK');
    watched.set(path, hash);
    return bytes;
  };
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: v => ({ __jsExpr: v }) });
  const schema = yaml.JSON_SCHEMA.extend(js);
  const parse = path => yaml.load(watch(path), { schema });
  const manifestPath = join(profile, 'package.json');
  const manifestBytes = watch(manifestPath);
  const currentManifest = boot.readProfileManifest('dsh', profile);
  if (!equal(currentManifest, JSON.parse(manifestBytes))) snapshotError('BUNDLE_FILES_CHANGED_DURING_CHECK');
  watch(manifestPath);
  const bundles = currentManifest.dsh?.profile?.bundles ?? [];
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string' || !name || name.trim() !== name)) {
    snapshotError('INVALID_PROFILE_BUNDLES');
  }
  const patchReload = currentManifest.dsh?.profile?.patchReload;
  if (patchReload !== undefined && patchReload !== 'live' && patchReload !== 'startup') snapshotError('INVALID_PROFILE_PATCH_RELOAD');
  const bundlePatch = name => {
    const dir = boot.resolveBundleDir('dsh', name, installAnchor, profile);
    const manifest = JSON.parse(watch(join(dir, 'package.json'))), declared = manifest.dsh?.bundle?.patch;
    if (typeof declared !== 'string' || !declared || isAbsolute(declared)) snapshotError('SNAPSHOT_BUNDLE_PATCH_INVALID');
    const path = resolve(dir, declared), below = relative(dir, path);
    if (!below || below === '..' || below.startsWith('../') || isAbsolute(below)) snapshotError('SNAPSHOT_BUNDLE_PATCH_INVALID');
    watch(path);
    return path;
  };
  const layers = bundles.map(name => boot.loadOverlayPatches('dsh', bundlePatch(name)));
  const profilePatch = join(profile, 'cordis.patch.yml');
  const hasProfilePatch = fs.existsSync(profilePatch);
  if (hasProfilePatch) watch(profilePatch);
  if (fs.existsSync(homePatchFile)) watch(homePatchFile);
  const profilePatches = hasProfilePatch ? boot.loadOverlayPatches('dsh', profilePatch) : [];
  const warnings = [];
  const rows = boot.composeEntries([...layers, profilePatches,
    boot.loadOptionalPatches('dsh', homePatchFile) ?? []], x => warnings.push(x));
  if (warnings.length) snapshotError('CONFIG_PATCH_WARNING');
  let historicalRows;
  if (snapshot) {
    const oldManifest = JSON.parse(watch(join(snapshot, 'package.json')));
    const bundles = snapshotHostBundles(oldManifest, currentManifest);
    const emptyRoot = parse(join(snapshot, 'generated-cordis.yml'));
    if (!Array.isArray(emptyRoot) || emptyRoot.length) snapshotError('SNAPSHOT_ROOT_NOT_EMPTY');
    const layers = bundles.map(name => boot.loadOverlayPatches('dsh', bundlePatch(name)));
    const oldPatches = snapshotHostPatches(parse(join(snapshot, 'cordis.patch.yml')), join(profile, 'cordis.patch.yml'));
    const homePath = join(snapshot, 'home-cordis.patch.yml');
    if (!fs.existsSync(homePath) && fs.existsSync(homePatchFile)) snapshotError('SNAPSHOT_HOME_LAYER_MISSING');
    const oldHome = fs.existsSync(homePath) ? snapshotHostPatches(parse(homePath), homePatchFile) : [];
    const historicalWarnings = [];
    historicalRows = boot.composeEntries([...layers, oldPatches, oldHome], x => historicalWarnings.push(x));
    if (historicalWarnings.length) snapshotError('SNAPSHOT_PATCH_WARNING');
  } else {
    historicalRows = parse(baselineFile);
  }
  try { H.verifyRecovery(rows, H.jsonStorageConfig(historicalRows)); }
  catch (e) {
    if (String(e.message).startsWith('Original JSON adapter configuration changed')) snapshotError('JSON_STORAGE_CONFIG_CHANGED');
    throw e;
  }
  if (!equal(snapshotWorkspace(rows), snapshotWorkspace(historicalRows))) snapshotError('WORKSPACE_CONFIG_CHANGED');
  const profileRequire = createRequire(join(profile, 'package.json'));
  for (const name of ['@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-host-webserver']) {
    const entry = profileRequire.resolve(name);
    watch(entry);
    await import(pathToFileURL(entry).href);
  }
  for (const [path, expected] of watched) {
    if (createHash('sha256').update(fs.readFileSync(path)).digest('hex') !== expected) snapshotError('BUNDLE_FILES_CHANGED_DURING_CHECK');
  }
  return { sourceKind: snapshot ? 'saved-profile-inputs-current-host-bundles' : 'verified-effective-config', inputs: [...watched] };
}

function fileIdentity(path, info) {
  return { path, dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid,
    gid: info.gid, nlink: info.nlink, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

// The explicit owner exception applies only to the original executable, never
// to its script. It inspects the existing layout without changing ownership.
export function inspectStartupFile(path, { role, privateDirectory, approvedOwner } = {}, io = fs) {
  const reject = (code, at, info) => {
    throw Object.assign(new Error(code), { code, details: { path: at,
      ...(info ? { uid: info.uid, gid: info.gid, mode: (info.mode & 0o7777).toString(8),
        nlink: info.nlink, regularFile: info.isFile(), directory: info.isDirectory() } : {}) } });
  };
  const protectedExecutable = role === 'executable' && (privateDirectory !== undefined || approvedOwner !== undefined);
  if (!protectedExecutable) {
    const info = io.statSync(path);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022)) reject('START_HOOK_FILE_UNSAFE', path, info);
    return [fileIdentity(path, info)];
  }
  const ids = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(approvedOwner ?? '');
  if (!ids || Number(ids[1]) <= 0 || ids.slice(1).some(x => Number(x) >= 4294967295)
      || !privateDirectory || !isAbsolute(privateDirectory) || resolve(privateDirectory) !== privateDirectory
      || privateDirectory === '/' || !isAbsolute(path) || resolve(path) !== path) {
    reject('INVALID_PROTECTED_EXECUTABLE', path);
  }
  const owner = ids.slice(1).map(Number), chain = [];
  for (let at = path; ; at = dirname(at)) {
    chain.unshift(at);
    if (at === '/') break;
  }
  const privateIndex = chain.indexOf(privateDirectory);
  if (privateIndex < 0 || privateIndex >= chain.length - 1) reject('PROTECTED_DIRECTORY_NOT_ANCESTOR', path);
  const identities = chain.map((at, index) => {
    const info = io.lstatSync(at), last = index === chain.length - 1;
    if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) {
      reject('START_HOOK_PATH_TYPE_CHANGED', at, info);
    }
    if (info.mode & 0o022) reject('START_HOOK_PATH_WRITABLE', at, info);
    if (index <= privateIndex && (info.uid !== 0 || info.gid !== 0)) reject('START_HOOK_ANCESTOR_OWNER_CHANGED', at, info);
    if (index === privateIndex && (info.mode & 0o7777) !== 0o700) reject('PROTECTED_DIRECTORY_NOT_PRIVATE', at, info);
    if (index > privateIndex && !((info.uid === 0 && info.gid === 0) || (info.uid === owner[0] && info.gid === owner[1]))) {
      reject('START_HOOK_PATH_OWNER_CHANGED', at, info);
    }
    if (last && (info.uid !== owner[0] || info.gid !== owner[1] || (info.mode & 0o7777) !== 0o755 || info.nlink !== 1)) {
      reject('PROTECTED_EXECUTABLE_IDENTITY_CHANGED', at, info);
    }
    return fileIdentity(at, info);
  });
  if (io.realpathSync(path) !== path) reject('START_HOOK_CANONICAL_PATH_CHANGED', path);
  return identities;
}

async function resume(options) {
  const { profile, harness, helper, baseline, receipt: receiptFile } = options;
  const snapshot = options['profile-snapshot'];
  const host = options['trusted-host'];
  const unit = 'deepseek-harness.service', pkwUnit = 'pkw-collaboration.service';
  let preflightPassed = false;
let check = 'identity', target = '/', evidence;
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const need = (ok, code) => { if (!ok) fail(code); };
const sha = b => createHash('sha256').update(b).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
const prop = (name, service = unit) => run('systemctl', ['show', service, '--property=' + name, '--value']).trim();
const present = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const snapshotIdentity = paths => paths.map(path => {
  const info = fs.lstatSync(path), directory = path === snapshot;
  need(fs.realpathSync(path) === path && (directory ? info.isDirectory() : info.isFile())
    && info.uid === 0 && info.gid === 0 && (info.mode & 0o7777) === (directory ? 0o700 : 0o600)
    && (directory || info.nlink === 1), 'SNAPSHOT_FILE_IDENTITY_UNSAFE');
  return fileIdentity(path, info);
});
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
  if (!pre) return { files: [], identities: [] };
  return { files: [executable, script], identities: [
    ...inspectStartupFile(executable, { role: 'executable',
      privateDirectory: options['protected-executable-dir'], approvedOwner: options['protected-executable-owner'] }),
    ...inspectStartupFile(script, { role: 'script' }),
  ] };
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
  const startHookEvidence = reviewStartHooks(startPre, startPost);
  need(!run('ss', ['-ltnH', 'sport = :3080']).trim(), 'PORT_3080_BUSY');
  check = 'helper'; target = helper;
  need(sha(fs.readFileSync(helper)) === '4371a15bfd6c61e388f05c1cf7c3a1bebc8dac775dba01e5f5f5216a9ae7e250', 'HELPER_HASH_CHANGED');
  const H = await import(pathToFileURL(helper).href);
  const names = ['User', 'Group', 'WorkingDirectory', 'EnvironmentFiles', 'PassEnvironment', 'UnsetEnvironment', 'PAMName', 'RootDirectory', 'RootImage', 'DynamicUser', 'BindPaths', 'BindReadOnlyPaths', 'TemporaryFileSystem'];
  const properties = Object.fromEntries(names.map(k => [k, prop(k)]));
  const unitEnv = prop('Environment'), managerEnv = run('systemctl', ['show-environment']);
  let environment = H.recoveryEnvironment(managerEnv, unitEnv, properties);
  const envPath = H.confirmedEnvironmentFile(properties.EnvironmentFiles);
  need(envPath, 'ENVIRONMENT_SOURCE_CHANGED');
  const envBytes = fs.readFileSync(envPath);
  H.environmentFileIdentity(fs.lstatSync(envPath));
  let historicalFile, historicalInputs, snapshotPaths = [], initialSnapshotIdentity;
  if (baseline) {
    check = 'verified-baseline'; target = baseline;
    const old = JSON.parse(fs.readFileSync(join(baseline, 'receipt.json'), 'utf8'));
    need(old.status === 'configuration-verified-service-not-started' && old.checks?.hostStorage === 'json', 'BASELINE_NOT_VERIFIED');
    need(old.environmentFile?.path === envPath, 'ENVIRONMENT_SOURCE_CHANGED');
    need(H.inspectEnvironmentFile(envBytes).sha256 === old.environmentFile.sha256, 'ENVIRONMENT_HASH_CHANGED');
    historicalFile = join(baseline, 'effective.yml');
    historicalInputs = [join(baseline, 'receipt.json'), historicalFile];
  } else {
    check = 'profile-snapshot'; target = snapshot;
    const home = join(snapshot, 'home-cordis.patch.yml');
    snapshotPaths = [snapshot, ...['package.json', 'cordis.patch.yml', 'generated-cordis.yml', 'agent-journal.env'].map(name => join(snapshot, name)), ...(present(home) ? [home] : [])];
    initialSnapshotIdentity = snapshotIdentity(snapshotPaths);
    need(sha(fs.readFileSync(join(snapshot, 'agent-journal.env'))) === options['snapshot-env-sha256']
      && H.inspectEnvironmentFile(envBytes).sha256 === options['snapshot-env-sha256'], 'ENVIRONMENT_HASH_CHANGED');
    need(sha(fs.readFileSync(join(snapshot, 'generated-cordis.yml'))) === options['snapshot-root-sha256'], 'SNAPSHOT_ROOT_HASH_CHANGED');
    need(present(home) || !present('/root/.dsh/cordis.patch.yml'), 'SNAPSHOT_HOME_LAYER_MISSING');
    snapshotHostBundles(JSON.parse(fs.readFileSync(join(snapshot, 'package.json'), 'utf8')), JSON.parse(fs.readFileSync(join(profile, 'package.json'), 'utf8')));
    historicalInputs = snapshotPaths.filter(path => path !== snapshot);
  }
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
  const monitoredInputs = [join(profile, 'package.json'), join(profile, 'pnpm-lock.yaml'), join(profile, 'cordis.patch.yml'), '/root/.dsh/cordis.patch.yml', envPath, helper, ...historicalInputs, ...entries, ...startHookEvidence.files];
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
    const H = await import(${JSON.stringify(pathToFileURL(helper).href)});
    const R = await import(${JSON.stringify(import.meta.url)});
    const boot = await import('@deepseek-ai/dsh-app-boot');
    const yaml = createRequire(${JSON.stringify(join(identity.canonical, 'vendor/include/package.json'))})('js-yaml');
    const report = await R.verifyResumeConfiguration(${JSON.stringify({ profile, installAnchor: join(identity.canonical, 'apps/cli/package.json'), baselineFile: historicalFile, snapshot, homePatchFile: '/root/.dsh/cordis.patch.yml' })}, { boot, yaml, H });
    process.stdout.write(' config-verified ' + JSON.stringify(report));
  `;
  let configEvidence;
  try {
    const result = execFileSync('/usr/local/bin/node', ['--import', 'tsx/esm', '--input-type=module', '-e', code], { cwd: identity.canonical, env: environment, timeout: 30000, encoding: 'utf8', maxBuffer: 524288, stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = 'environment-verified config-verified ';
    need(result.startsWith(prefix), 'PROBE_OUTPUT_CHANGED');
    configEvidence = JSON.parse(result.slice(prefix.length));
    need(Array.isArray(configEvidence.inputs) && configEvidence.inputs.every(row => Array.isArray(row) && row.length === 2
      && typeof row[0] === 'string' && isAbsolute(row[0]) && /^[a-f0-9]{64}$/.test(row[1])), 'PROBE_OUTPUT_CHANGED');
    fs.writeFileSync(join(evidence, 'configuration-evidence.json'), JSON.stringify(configEvidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    fs.writeFileSync(join(evidence, 'probe-error.log'), e.stderr ?? String(e.code ?? 'PROBE_FAILED'), { mode: 0o600 });
    const category = ['CONFIG_PATCH_WARNING', 'WORKSPACE_CONFIG_CHANGED', 'JSON_STORAGE_CONFIG_CHANGED', 'SNAPSHOT_PATCH_WARNING',
      'SNAPSHOT_ROOT_NOT_EMPTY', 'SNAPSHOT_BUNDLE_PATCH_INVALID', 'SNAPSHOT_HOME_LAYER_MISSING',
      'INVALID_SNAPSHOT_WORKSPACE', 'INVALID_SNAPSHOT_PATCHES', 'SNAPSHOT_MIXED_PKW_PATCH',
      'BUNDLE_FILES_CHANGED_DURING_CHECK'].find(x => String(e.stderr).includes(x));
    fail(category ?? H.runtimePreflightFailure(e));
  }
  check = 'final-recheck'; target = profile; writers();
  H.assertRuntimeDirectories(harness, identity, harness, undefined);
  need(equal(before, fingerprint()), 'FILES_CHANGED_DURING_CHECK');
  need(configEvidence.inputs.every(([path, expected]) => sha(fs.readFileSync(path)) === expected), 'BUNDLE_FILES_CHANGED_DURING_CHECK');
  if (snapshot) need(equal(initialSnapshotIdentity, snapshotIdentity(snapshotPaths)), 'SNAPSHOT_CHANGED_DURING_CHECK');
  need(equal(startHookEvidence, reviewStartHooks(prop('ExecStartPre'), prop('ExecStartPost'))), 'START_HOOK_CHANGED_DURING_CHECK');
  need(prop('ExecStart') === command && prop('ExecStartPre') === startPre && prop('ExecStartPost') === startPost && names.every(k => prop(k) === properties[k]) && prop('Environment') === unitEnv && run('systemctl', ['show-environment']) === managerEnv, 'UNIT_CHANGED_DURING_CHECK');
  need(['failed', 'inactive'].includes(prop('ActiveState')) && prop('ActiveState', pkwUnit) === 'inactive', 'SERVICE_STATE_CHANGED');
  console.log(JSON.stringify({ status: 'DSH_PREFLIGHT_OK', sourceKind: configEvidence.sourceKind, privateEvidence: evidence, configurationReplaced: false, databaseRestored: false }));
  preflightPassed = true;
} catch (e) {
  console.error(JSON.stringify({ status: 'STOP', check, target: e.details?.path ?? (typeof e.path === 'string' ? e.path : target), code: e.code ?? 'CHECK_FAILED', ...(e.details ? { details: e.details } : {}), ...(evidence ? { privateEvidence: evidence } : {}) }));
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

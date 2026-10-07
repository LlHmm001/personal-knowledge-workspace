#!/usr/bin/env node
// Read-only diagnosis of a retained candidate. Passing never authorizes a
// switch or service start, and this tool does not repair or copy anything.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal, parseArgs } from 'node:util';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const optionsList = ['evidence', 'candidate', 'profile', 'backup', 'receipt', 'harness', 'helper', 'helper-sha256',
  'resume-script', 'resume-sha256', 'restore-script', 'restore-sha256', 'profile-snapshot', 'boot-sha256'];
const configurationFiles = ['cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml'];

export function candidateErrorDetails(error) {
  const names = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'YAMLException']);
  const message = typeof error?.message === 'string' ? error.message : '';
  const identifiers = [...message.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*) is not a function\b/g)]
    .map(match => ({ kind: 'not-a-function', identifier: match[1].slice(0, 128) }));
  for (const match of message.matchAll(/does not provide an export named ['"]([A-Za-z_$][A-Za-z0-9_$]*)['"]/g)) {
    identifiers.push({ kind: 'missing-export', identifier: match[1].slice(0, 128) });
  }
  const missingPackages = [...message.matchAll(/Cannot find package ['"]((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)['"]/g)]
    .map(match => match[1].slice(0, 128));
  const stackLocations = [];
  for (const line of String(error?.stack ?? '').split('\n').slice(0, 40)) {
    if (!/^\s+at /.test(line)) continue;
    const match = /((?:file:\/\/\/|\/)[A-Za-z0-9_@./-]+):(\d{1,8}):(\d{1,8})\)?$/.exec(line);
    if (match && match[1].length <= 400) stackLocations.push({ path: match[1], line: Number(match[2]), column: Number(match[3]) });
  }
  return { name: names.has(error?.name) ? error.name : 'Error',
    code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_-]{0,79}$/.test(error.code) ? error.code : 'CANDIDATE_RUNTIME_CHECK_FAILED',
    identifierErrors: identifiers.slice(0, 8), missingPackages: [...new Set(missingPackages)].slice(0, 8),
    stackLocations: stackLocations.slice(0, 12) };
}

export function parseCandidateOptions(args) {
  const { values } = parseArgs({ args, options: Object.fromEntries(optionsList.map(name => [name, { type: 'string' }])),
    strict: true, allowPositionals: false });
  for (const name of optionsList) {
    const value = values[name];
    need(typeof value === 'string' && (name.endsWith('sha256') ? /^[a-f0-9]{64}$/.test(value)
      : isAbsolute(value) && resolve(value) === value && value !== '/' && !/[\s%\\\0]/.test(value)), 'INVALID_CANDIDATE_OPTIONS');
  }
  return values;
}

function identity(info) {
  return { dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, gid: info.gid,
    size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

/** Uses the exact runtime path, with fixed imported tool hashes; no injected probe. */
export async function checkCandidate(o) {
  const owner = process.getuid();
  const files = new Map(), directories = new Map();
  const watch = (path, expected, strict = true) => {
    const info = fs.lstatSync(path);
    need(info.isFile() && (!strict || info.uid === owner && !(info.mode & 0o022)), 'CANDIDATE_INPUT_UNSAFE');
    const bytes = fs.readFileSync(path), digest = hash(bytes), observed = { identity: identity(info), digest };
    need(!expected || digest === expected, 'CANDIDATE_TOOL_HASH_CHANGED');
    need(!files.has(path) || equal(files.get(path), observed), 'CANDIDATE_INPUT_CHANGED');
    files.set(path, observed); return bytes;
  };
  const directory = (path, privateRoot = false) => {
    const info = fs.lstatSync(path);
    need(info.isDirectory() && fs.realpathSync(path) === path && info.uid === owner
      && !(info.mode & 0o022) && (!privateRoot || (info.mode & 0o077) === 0), 'CANDIDATE_DIRECTORY_UNSAFE');
    directories.set(path, identity(info));
  };
  for (const path of [o.evidence, o.candidate, o.profile, o.backup, o['profile-snapshot']]) directory(path,
    path === o.evidence || path === o.candidate);
  need(dirname(o.candidate) === dirname(o.profile) && o.candidate !== o.profile
    && /^\.dsh-install-candidate-[A-Za-z0-9]+$/.test(o.candidate.slice(dirname(o.candidate).length + 1)), 'CANDIDATE_PATH_CHANGED');
  const canonical = fs.realpathSync(o.harness);
  directory(canonical);
  need(fs.realpathSync(process.cwd()) === canonical, 'CANDIDATE_CWD_CHANGED');
  for (const [path, expected] of [[o.helper, o['helper-sha256']], [o['resume-script'], o['resume-sha256']],
    [o['restore-script'], o['restore-sha256']]]) watch(path, expected);
  const T = await import(pathToFileURL(o['restore-script']).href);
  for (const name of ['installationInventory', 'verifyCandidateLinks', 'recheckCandidateLinkRelocations', 'assertRootGroupDirectoryPolicy']) {
    need(typeof T[name] === 'function', 'CANDIDATE_TOOL_API_UNSUPPORTED');
  }
  const journal = JSON.parse(watch(join(o.evidence, 'journal.json')));
  need(journal.status === 'stopped-original-installation-retained' && journal.errorCode === 'INSTALLATION_RUNTIME_CHECK_FAILED'
    && Array.isArray(journal.steps) && journal.steps.length === 0 && journal.installationOnly === true
    && journal.serviceStarted === false && journal.databaseRestored === false
    && journal.relocationState === 'applied', 'CANDIDATE_JOURNAL_STATE_CHANGED');
  need(journal.candidate === o.candidate && journal.profile === o.profile && journal.backup === o.backup, 'CANDIDATE_JOURNAL_PATH_CHANGED');
  const receiptBytes = watch(o.receipt);
  need(hash(receiptBytes) === journal.receiptHash, 'CANDIDATE_RECEIPT_CHANGED');
  const receipt = JSON.parse(receiptBytes);
  need(receipt.profile === o.profile && receipt.beforeHost && Object.keys(receipt.beforeHost).length > 0
    && Object.values(receipt.beforeHost).every(value => /^[a-f0-9]{64}$/.test(value)), 'CANDIDATE_HOST_BASELINE_INVALID');
  const expected = JSON.parse(watch(join(o.evidence, 'candidate-expected-inventory.json')));
  need(Array.isArray(expected.rows) && hash(JSON.stringify(expected.rows)) === expected.sha256
    && expected.sha256 === journal.candidateExpectedHash, 'CANDIDATE_EXPECTED_INVENTORY_CHANGED');
  const original = T.installationInventory(o.profile), historical = T.installationInventory(o.backup), candidate = T.installationInventory(o.candidate);
  need(original.sha256 === journal.originalHash && historical.sha256 === journal.backupHash
    && candidate.sha256 === expected.sha256, 'CANDIDATE_INSTALLATION_CHANGED');
  const config = T.installationInventory(o.profile, configurationFiles);
  need(T.installationInventory(o.candidate, configurationFiles).sha256 === config.sha256, 'CANDIDATE_CONFIGURATION_CHANGED');
  const plan = journal.linkRelocations;
  need(plan?.candidate === o.candidate && plan.profile === o.profile && plan.backup === o.backup
    && Array.isArray(plan.links) && (!plan.links.length || plan.harnessRelease === canonical), 'CANDIDATE_FALLBACK_PLAN_CHANGED');
  const rootGroup = () => {
    if (journal.rootGroupPolicy) T.assertRootGroupDirectoryPolicy(journal.rootGroupPolicy.context, journal.rootGroupPolicy);
    need(equal(plan.rootGroupPolicy, journal.rootGroupPolicy), 'CANDIDATE_ROOT_GROUP_POLICY_CHANGED');
  };
  const fallback = () => { rootGroup(); T.verifyCandidateLinks(o.candidate, o.profile, o.backup, candidate); T.recheckCandidateLinkRelocations(plan); };
  const bookend = () => {
    for (const [path, observed] of files) {
      need(equal(identity(fs.lstatSync(path)), observed.identity) && hash(fs.readFileSync(path)) === observed.digest, 'CANDIDATE_INPUT_CHANGED');
    }
    for (const [path, observed] of directories) {
      need(fs.realpathSync(path) === path && equal(identity(fs.lstatSync(path)), observed), 'CANDIDATE_DIRECTORY_CHANGED');
    }
    for (const [path, initial] of [[o.profile, original], [o.backup, historical], [o.candidate, candidate]]) {
      const current = T.installationInventory(path);
      need(current.sha256 === initial.sha256 && equal(current.identities, initial.identities), 'CANDIDATE_INSTALLATION_CHANGED');
    }
    need(T.installationInventory(o.profile, configurationFiles).sha256 === config.sha256
      && T.installationInventory(o.candidate, configurationFiles).sha256 === config.sha256, 'CANDIDATE_CONFIGURATION_CHANGED');
    fallback();
  };
  fallback();
  // Historical inputs are fingerprinted before runtime parsing, including the
  // optional home layer. No input contents are included in the public result.
  for (const name of ['package.json', 'generated-cordis.yml', 'cordis.patch.yml', 'home-cordis.patch.yml']) {
    const path = join(o['profile-snapshot'], name);
    if (fs.existsSync(path)) watch(path);
  }
  const homePatchFile = join(dirname(dirname(o.profile)), 'cordis.patch.yml');
  if (fs.existsSync(homePatchFile)) watch(homePatchFile);
  let result, runtimeError;
  try {
    const require = createRequire(join(o.candidate, 'package.json')), hosts = [];
    for (const [name, sha256] of Object.entries(receipt.beforeHost)) {
      const entry = require.resolve(name), real = fs.realpathSync(entry);
      need(hash(watch(real, undefined, false)) === sha256, 'HOST_HASH_CHANGED');
      hosts.push({ name, real, sha256 });
    }
    const installAnchor = join(canonical, 'apps/cli/package.json'), installation = createRequire(installAnchor);
    const bootEntry = fs.realpathSync(installation.resolve('@deepseek-ai/dsh-app-boot'));
    watch(bootEntry, o['boot-sha256'], false);
    const boot = await import(pathToFileURL(bootEntry).href);
    const yaml = createRequire(join(canonical, 'vendor/include/package.json'))('js-yaml');
    const H = await import(pathToFileURL(o.helper).href), R = await import(pathToFileURL(o['resume-script']).href);
    need(typeof R.verifyResumeConfiguration === 'function', 'CANDIDATE_TOOL_API_UNSUPPORTED');
    const configuration = await R.verifyResumeConfiguration({ profile: o.candidate, installAnchor,
      snapshot: o['profile-snapshot'], homePatchFile }, { boot, yaml, H });
    need(Array.isArray(configuration.inputs), 'CANDIDATE_CONFIGURATION_REPORT_INVALID');
    for (const [path, sha256] of configuration.inputs) watch(path, sha256, false);
    result = { status: 'CANDIDATE_RUNTIME_PASSED', hosts: hosts.length, configurationInputs: configuration.inputs.length,
      inputsSha256: hash(JSON.stringify([...files].map(([path, value]) => [path, value.digest]).sort())),
      servicesStarted: false, installationSwitched: false, diagnosticOnly: true };
  } catch (error) { runtimeError = error; }
  bookend();
  if (runtimeError) throw runtimeError;
  return result;
}

async function main() {
  try {
    need(process.getuid() === 0, 'CANDIDATE_REQUIRES_ROOT');
    console.log(JSON.stringify(await checkCandidate(parseCandidateOptions(process.argv.slice(2)))));
  } catch (error) {
    console.error(JSON.stringify({ status: 'CANDIDATE_CHECK_STOP', ...candidateErrorDetails(error), diagnosticOnly: true }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

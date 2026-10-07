#!/usr/bin/env node
// Restore installation artifacts only. Site paths and observed hashes are
// supplied by the caller; this tool never starts services or restores data.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as equal, parseArgs } from 'node:util';

export const installationFiles = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', '.npmrc', 'node_modules'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const present = path => { try { fs.lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const below = (root, path) => { const p = relative(root, path); return p === '' || p !== '..' && !p.startsWith('../') && !isAbsolute(p); };

export function compareInstallationManifests(current, backup) {
  const pkw = name => name.startsWith('@deepseek-ai/dsh-pkw-') || name === '@deepseek-ai/dsh-extension-pkw';
  const normalize = value => {
    need(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_MANIFEST');
    const copy = structuredClone(value);
    need(copy.dependencies && typeof copy.dependencies === 'object' && !Array.isArray(copy.dependencies), 'INVALID_MANIFEST');
    need(Object.values(copy.dependencies).every(range => typeof range === 'string'), 'INVALID_MANIFEST');
    for (const name of Object.keys(copy.dependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-pkw-') || name === '@deepseek-ai/dsh-extension-pkw') delete copy.dependencies[name];
    }
    return copy;
  };
  need(equal(normalize(current), normalize(backup)), 'HOST_MANIFEST_CONFIGURATION_CHANGED');
  need(equal(Object.keys(current.dependencies).filter(pkw).sort(), Object.keys(backup.dependencies).filter(pkw).sort()), 'PKW_DEPENDENCY_SET_CHANGED');
  need(Array.isArray(current.dsh?.profile?.bundles)
    && !current.dsh.profile.bundles.some(name => name.startsWith('@deepseek-ai/dsh-pkw-') || name === '@deepseek-ai/dsh-extension-pkw'), 'PKW_STILL_BUNDLED');
}

/** Never follow a symlink while inventorying or copying an installation. */
export function installationInventory(root, names = installationFiles) {
  const rows = [], identities = [], rootDev = fs.statSync(root).dev;
  let bytes = 0;
  const visit = name => {
    need(rows.length < 150000, 'INSTALLATION_TOO_MANY_FILES');
    const path = join(root, name), s = fs.lstatSync(path);
    need(s.dev === rootDev, 'INSTALLATION_MOUNT_BOUNDARY');
    const row = { path: name, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid };
    identities.push([name, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    if (s.isSymbolicLink()) { row.type = 'link'; row.target = fs.readlinkSync(path); }
    else if (s.isDirectory()) {
      row.type = 'directory'; rows.push(row);
      for (const child of fs.readdirSync(path).sort()) visit(join(name, child));
      return;
    } else if (s.isFile()) {
      need(s.size <= 256 * 1024 ** 2, 'INSTALLATION_FILE_TOO_LARGE');
      row.type = 'file'; row.bytes = s.size; row.sha256 = sha(fs.readFileSync(path)); bytes += s.size;
    } else need(false, 'INSTALLATION_SPECIAL_FILE');
    rows.push(row);
  };
  for (const name of names) {
    need(name && !isAbsolute(name) && below(root, join(root, name)), 'INVALID_INSTALLATION_MEMBER');
    if (present(join(root, name))) visit(name); else rows.push({ path: name, type: 'absent' });
  }
  return { rows, identities, bytes, sha256: sha(JSON.stringify(rows)) };
}

function durableJson(path, value) {
  const temp = path + '.next';
  const fd = fs.openSync(temp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, path); syncDir(dirname(path));
}
function syncDir(path) { const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function copyInstallation(source, destination) {
  for (const name of installationFiles) {
    if (present(join(source, name))) fs.cpSync(join(source, name), join(destination, name), {
      recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false,
      // The native recursive branch applies the caller's umask to directories.
      // A filter selects the branch that restores each source mode explicitly.
      // Ownership, content and link checks below remain exact and mandatory.
      filter: () => true
    });
  }
}
function checkDirectory(path) {
  need(fs.realpathSync(path) === path && fs.lstatSync(path).isDirectory(), 'DIRECTORY_PATH_CHANGED');
}

export function verifyCopiedInstallation(source, destination, sourceInventory) {
  const copied = installationInventory(destination);
  need(copied.sha256 === sourceInventory.sha256, 'INSTALLATION_COPY_MISMATCH');
  const ids = new Map(sourceInventory.identities.map(x => [x[0], x]));
  for (const [name, dev, inode] of copied.identities) {
    const original = ids.get(name);
    need(!original || original[1] !== dev || original[2] !== inode, 'INSTALLATION_COPY_SHARED_INODE');
  }
  for (const row of copied.rows.filter(x => x.type === 'file')) {
    const fd = fs.openSync(join(destination, row.path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  for (const row of [...copied.rows].reverse().filter(x => x.type === 'directory')) syncDir(join(destination, row.path));
  syncDir(destination);
  return copied;
}

/** A candidate may use the normal shared Harness fallback, never live profile packages. */
export function verifyCandidateLinks(candidate, liveProfile, backup, inventory) {
  for (const row of inventory.rows.filter(x => x.type === 'link')) {
    const target = resolve(dirname(join(candidate, row.path)), row.target);
    need(!below(liveProfile, target) && !below(backup, target), 'CANDIDATE_LINK_BORROWS_INSTALLATION');
    // Resolve the deepest existing parent as well, detecting indirect aliases.
    let at = target;
    while (!present(at) && dirname(at) !== at) at = dirname(at);
    const real = fs.realpathSync(at);
    need(!below(liveProfile, real) && !below(backup, real), 'CANDIDATE_LINK_BORROWS_INSTALLATION');
  }
}

const directoryIdentity = info => ({ dev: info.dev, ino: info.ino,
  mode: info.mode & 0o7777, uid: info.uid, gid: info.gid });
const membershipSources = ['/etc/group', '/etc/nsswitch.conf', '/etc/passwd'];
function rootGroupContext({ paths, harnessRelease, targets }) {
  const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path
    && path !== '/' && !/[\s%\\\0]/.test(path);
  need(canonical(harnessRelease) && Array.isArray(paths) && paths.length > 0 && paths.length <= 64
    && paths.every(canonical) && new Set(paths).size === paths.length
    && Array.isArray(targets) && targets.length > 0 && targets.length <= 256 && targets.every(canonical),
  'ROOT_GROUP_POLICY_SCOPE_INVALID');
  need(targets.every(path => path !== harnessRelease && below(harnessRelease, path))
    && paths.every(path => path !== harnessRelease && below(harnessRelease, path)
      && targets.some(target => below(path, target))), 'ROOT_GROUP_POLICY_SCOPE_INVALID');
  return { paths: [...paths].sort(), harnessRelease, targets: [...new Set(targets)].sort() };
}
function rootGroupAncestorPaths(paths) {
  const result = new Set();
  for (let path of paths) {
    for (;;) { result.add(path); if (dirname(path) === path) break; path = dirname(path); }
  }
  return [...result].sort();
}

/** Pure evidence validation; the production CLI always obtains evidence from the Linux observer. */
export function validateRootGroupDirectoryEvidence(context, evidence) {
  context = rootGroupContext(context);
  need(evidence?.version === 1 && Array.isArray(evidence.listed)
    && equal([...evidence.listed].sort(), context.paths) && Array.isArray(evidence.directories)
    && Array.isArray(evidence.sources), 'ROOT_GROUP_AUDIT_INVALID');
  const ancestors = rootGroupAncestorPaths(context.paths);
  const directories = [...evidence.directories].sort((a, b) => a.path.localeCompare(b.path));
  need(equal(directories.map(row => row.path).sort(), ancestors), 'ROOT_GROUP_ANCESTORS_INCOMPLETE');
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  for (const row of directories) {
    need(['dev', 'ino', 'mode', 'uid', 'gid'].every(key => integer(row[key]))
      && row.mode <= 0o7777, 'ROOT_GROUP_AUDIT_INVALID');
    need(row.aclAccess === 'absent' && row.aclDefault === 'absent', 'ROOT_GROUP_ACL_NOT_ABSENT');
    need(row.uid === 0 && !(row.mode & 0o002) && (row.path !== '/' || row.mode === 0o755),
      'ROOT_GROUP_ANCESTOR_UNSAFE');
    if (context.paths.includes(row.path)) {
      need(row.gid === 0 && row.mode === 0o775, 'ROOT_GROUP_DIRECTORY_NOT_APPROVED');
    } else need(!(row.mode & 0o020), 'ROOT_GROUP_UNLISTED_GROUP_WRITE');
  }
  const allowedNss = value => equal(value, ['files']) || equal(value, ['files', 'systemd']);
  need(allowedNss(evidence.nss?.passwd) && allowedNss(evidence.nss?.group)
    && (evidence.nss.initgroups === undefined || allowedNss(evidence.nss.initgroups)), 'ROOT_GROUP_NSS_UNSUPPORTED');
  need(evidence.rootAccount?.name === 'root' && evidence.rootAccount.uid === 0 && evidence.rootAccount.gid === 0,
    'ROOT_GROUP_ROOT_ACCOUNT_INVALID');
  need(evidence.rootGroup?.name === 'root' && evidence.rootGroup.gid === 0
    && Array.isArray(evidence.rootGroup.members) && evidence.rootGroup.members.length === 0,
  'ROOT_GROUP_ROOT_GROUP_INVALID');
  for (const [key, code] of [['accountsWithRootGroup', 'ROOT_GROUP_ACCOUNT_MEMBERSHIP_UNSAFE'],
    ['processesWithRootGroup', 'ROOT_GROUP_PROCESS_MEMBERSHIP_UNSAFE'], ['unreadableProcesses', 'ROOT_GROUP_PROCESS_UNREADABLE']]) {
    need(Array.isArray(evidence[key]), 'ROOT_GROUP_AUDIT_INVALID'); need(evidence[key].length === 0, code);
  }
  const sources = [...evidence.sources].sort((a, b) => a.path.localeCompare(b.path));
  need(equal(sources.map(row => row.path), membershipSources), 'ROOT_GROUP_MEMBERSHIP_SOURCES_INVALID');
  for (const row of sources) {
    need(['dev', 'ino', 'mode', 'uid', 'gid', 'size'].every(key => integer(row[key])) && row.size <= 4 * 1024 ** 2
      && /^[a-f0-9]{64}$/.test(row.sha256) && /^\d+$/.test(row.mtimeNs) && /^\d+$/.test(row.ctimeNs)
      && row.uid === 0 && !(row.mode & 0o022), 'ROOT_GROUP_MEMBERSHIP_SOURCES_INVALID');
  }
  return { version: 1, context, directories: structuredClone(directories), sources: structuredClone(sources),
    nss: structuredClone(evidence.nss), rootAccount: structuredClone(evidence.rootAccount),
    rootGroup: structuredClone(evidence.rootGroup) };
}

export function recheckRootGroupDirectoryEvidence(policy, evidence) {
  const next = validateRootGroupDirectoryEvidence(policy.context, evidence);
  need(equal(next.sources, policy.sources), 'ROOT_GROUP_MEMBERSHIP_SOURCE_CHANGED');
  need(equal(next.directories, policy.directories), 'ROOT_GROUP_DIRECTORY_CHANGED');
  need(equal(next.nss, policy.nss), 'ROOT_GROUP_NSS_CHANGED');
  return next;
}

export function rootGroupDirectoryAllows(policy, path, identity) {
  if (!policy?.context.paths.includes(path) || identity.uid !== 0 || identity.gid !== 0 || identity.mode !== 0o775) return false;
  const observed = policy.directories.find(row => row.path === path);
  return Boolean(observed && equal(directoryIdentity(observed), identity));
}

const rootGroupObserverSource = String.raw`
import errno, grp, hashlib, json, os, pwd, stat, sys
def fail(code):
    print(json.dumps({'ok': False, 'code': code})); sys.exit(0)
if sys.platform != 'linux': fail('ROOT_GROUP_AUDIT_PLATFORM_UNSUPPORTED')
if os.geteuid() != 0: fail('ROOT_GROUP_AUDIT_REQUIRES_ROOT')
try:
    context = json.loads(sys.argv[1]); paths = context['paths']
    source_paths = ['/etc/group', '/etc/nsswitch.conf', '/etc/passwd']
    def read_source(path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022 or before.st_size > 4194304:
                fail('ROOT_GROUP_MEMBERSHIP_SOURCES_INVALID')
            data = b''
            while True:
                part = os.read(fd, 65536)
                if not part: break
                data += part
                if len(data) > 4194304: fail('ROOT_GROUP_MEMBERSHIP_SOURCES_INVALID')
            after = os.fstat(fd)
            keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
            if any(getattr(before, k) != getattr(after, k) for k in keys): fail('ROOT_GROUP_MEMBERSHIP_SOURCE_CHANGED')
            row = dict(path=path, dev=after.st_dev, ino=after.st_ino, mode=stat.S_IMODE(after.st_mode),
                uid=after.st_uid, gid=after.st_gid, size=after.st_size, mtimeNs=str(after.st_mtime_ns),
                ctimeNs=str(after.st_ctime_ns), sha256=hashlib.sha256(data).hexdigest())
            return row, data.decode('utf-8')
        finally: os.close(fd)
    initial = {p: read_source(p) for p in source_paths}
    nss = {}
    for line in initial['/etc/nsswitch.conf'][1].splitlines():
        line = line.split('#', 1)[0].strip()
        if ':' not in line: continue
        key, value = line.split(':', 1)
        if key in ('passwd', 'group', 'initgroups'):
            if key in nss: fail('ROOT_GROUP_NSS_UNSUPPORTED')
            nss[key] = value.split()
    if any(nss.get(k) not in (['files'], ['files', 'systemd']) for k in ('passwd', 'group')):
        fail('ROOT_GROUP_NSS_UNSUPPORTED')
    if 'initgroups' in nss and nss['initgroups'] not in (['files'], ['files', 'systemd']): fail('ROOT_GROUP_NSS_UNSUPPORTED')
    roots = [line.split(':') for line in initial['/etc/passwd'][1].splitlines() if line.startswith('root:')]
    if len(roots) != 1 or len(roots[0]) != 7 or roots[0][2:4] != ['0', '0']: fail('ROOT_GROUP_ROOT_ACCOUNT_INVALID')
    groups = [line.split(':') for line in initial['/etc/group'][1].splitlines() if line.startswith('root:')]
    if len(groups) != 1 or len(groups[0]) != 4 or groups[0][2] != '0' or groups[0][3]: fail('ROOT_GROUP_ROOT_GROUP_INVALID')
    account_violations = []
    accounts = pwd.getpwall(); all_groups = grp.getgrall()
    if len(accounts) > 100000 or len(all_groups) > 100000: fail('ROOT_GROUP_AUDIT_LIMIT')
    for account in accounts:
        if account.pw_uid != 0 and 0 in os.getgrouplist(account.pw_name, account.pw_gid):
            account_violations.append({'uid': account.pw_uid, 'gid': account.pw_gid})
    for group in all_groups:
        if group.gr_gid == 0:
            for member in group.gr_mem:
                if pwd.getpwnam(member).pw_uid != 0: account_violations.append({'gid': 0})
    ancestors = set()
    for path in paths:
        while True:
            ancestors.add(path)
            parent = os.path.dirname(path)
            if parent == path: break
            path = parent
    directories = []
    for path in sorted(ancestors):
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or os.path.realpath(path) != path: fail('ROOT_GROUP_DIRECTORY_NOT_CANONICAL')
        row = dict(path=path, dev=info.st_dev, ino=info.st_ino, mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid)
        for field, attribute in [('aclAccess', 'system.posix_acl_access'), ('aclDefault', 'system.posix_acl_default')]:
            try:
                os.getxattr(path, attribute, follow_symlinks=False); row[field] = 'present'
            except OSError as error:
                if error.errno != errno.ENODATA: fail('ROOT_GROUP_ACL_UNKNOWN')
                row[field] = 'absent'
        directories.append(row)
    unsafe_processes = []; unreadable = []; tasks_checked = 0
    vanished = (errno.ENOENT, errno.ESRCH)
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try: tasks = os.listdir('/proc/' + pid + '/task')
        except OSError as error:
            if error.errno not in vanished: unreadable.append({'pid': int(pid)})
            continue
        for tid in tasks:
            if not tid.isdigit(): continue
            tasks_checked += 1
            if tasks_checked > 200000: fail('ROOT_GROUP_AUDIT_LIMIT')
            try:
                with open('/proc/' + pid + '/task/' + tid + '/status', encoding='utf-8', errors='replace') as stream: status = stream.read(65537)
                fields = {line.split(':', 1)[0]: line.split(':', 1)[1].split() for line in status.splitlines() if ':' in line}
                uid = [int(x) for x in fields['Uid']]; gid = [int(x) for x in fields['Gid']]
                supplemental = [int(x) for x in fields['Groups']]
                if len(status) > 65536 or len(uid) != 4 or len(gid) != 4: raise ValueError('status')
                if uid[3] != 0 and (gid[3] == 0 or 0 in supplemental): unsafe_processes.append({'pid': int(pid), 'tid': int(tid)})
            except OSError as error:
                if error.errno not in vanished: unreadable.append({'pid': int(pid), 'tid': int(tid)})
            except (ValueError, KeyError, UnicodeError): unreadable.append({'pid': int(pid), 'tid': int(tid)})
    for path in source_paths:
        if read_source(path)[0] != initial[path][0]: fail('ROOT_GROUP_MEMBERSHIP_SOURCE_CHANGED')
    print(json.dumps({'ok': True, 'evidence': {'version': 1, 'listed': paths, 'directories': directories,
        'sources': [initial[p][0] for p in source_paths], 'nss': nss,
        'rootAccount': {'name': 'root', 'uid': 0, 'gid': 0}, 'rootGroup': {'name': 'root', 'gid': 0, 'members': []},
        'accountsWithRootGroup': account_violations, 'processesWithRootGroup': unsafe_processes,
        'unreadableProcesses': unreadable}}))
except Exception:
    fail('ROOT_GROUP_AUDIT_FAILED')
`;

export function observeRootGroupDirectories(context) {
  context = rootGroupContext(context);
  let result;
  try {
    result = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', rootGroupObserverSource, JSON.stringify(context)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 256 * 1024,
    }));
  } catch { throw Object.assign(new Error('ROOT_GROUP_AUDIT_FAILED'), { code: 'ROOT_GROUP_AUDIT_FAILED' }); }
  need(result?.ok === true, typeof result?.code === 'string' && /^ROOT_GROUP_[A-Z_]+$/.test(result.code)
    ? result.code : 'ROOT_GROUP_AUDIT_FAILED');
  return result.evidence;
}

export function assertRootGroupDirectoryPolicy(context, previousPolicy, observer = observeRootGroupDirectories) {
  context = rootGroupContext(context);
  if (previousPolicy) need(equal(previousPolicy.context, context), 'ROOT_GROUP_POLICY_CONTEXT_CHANGED');
  const evidence = observer(context);
  return previousPolicy ? recheckRootGroupDirectoryEvidence(previousPolicy, evidence)
    : validateRootGroupDirectoryEvidence(context, evidence);
}

function protectedPhysicalDirectory(path, code, policy) {
  need(isAbsolute(path) && resolve(path) === path && fs.realpathSync.native(path) === path, code);
  const info = fs.lstatSync(path);
  need(info.isDirectory() && [0, process.getuid()].includes(info.uid)
    && (!(info.mode & 0o022) || rootGroupDirectoryAllows(policy, path, directoryIdentity(info))), code);
  return directoryIdentity(info);
}
function fallbackPackageInventory(target, profile, backup) {
  const inventory = installationInventory(target, fs.readdirSync(target).sort());
  // This binds this package's files and literal links, not its transitive
  // dependency closure. Links inside the package may not borrow an installation.
  verifyCandidateLinks(target, profile, backup, inventory);
  return inventory;
}
function exactFallbackPackage(row, profile) {
  if (row.type !== 'link') return;
  const match = /^node_modules\/((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$/.exec(row.path);
  if (match && row.target === join(profile, '.dsh-module-fallback', 'node_modules', match[1])) return match[1];
}

/** Read-only target audit, usable before allocating a candidate or copying any tree. */
export function auditFallbackLinkTargets({ profile, backup, inventory, harnessRelease, rootGroupPolicy }) {
  const links = [], failures = [];
  let harnessIdentity;
  for (const row of inventory.rows.filter(x => x.type === 'link')) {
    const packageName = exactFallbackPackage(row, profile);
    if (!packageName) continue;
    try {
      need(typeof harnessRelease === 'string', 'FALLBACK_RELOCATION_REQUIRES_HARNESS');
      harnessIdentity ??= protectedPhysicalDirectory(harnessRelease, 'FALLBACK_RELEASE_INVALID', rootGroupPolicy);
      need(!below(profile, harnessRelease) && !below(backup, harnessRelease), 'FALLBACK_RELEASE_INVALID');
      const target = fs.realpathSync.native(row.target);
      need(target !== harnessRelease && below(harnessRelease, target), 'FALLBACK_TARGET_OUTSIDE_RELEASE');
      const targetIdentity = protectedPhysicalDirectory(target, 'FALLBACK_TARGET_INVALID', rootGroupPolicy);
      const packageFile = join(target, 'package.json');
      need(fs.lstatSync(packageFile).isFile(), 'FALLBACK_PACKAGE_INVALID');
      need(JSON.parse(fs.readFileSync(packageFile, 'utf8')).name === packageName, 'FALLBACK_PACKAGE_NAME_CHANGED');
      const targetInventory = fallbackPackageInventory(target, profile, backup);
      links.push({ path: row.path, packageName, sourceTarget: row.target, target,
        targetIdentity, targetTreeHash: targetInventory.sha256, targetTreeBytes: targetInventory.bytes });
    } catch (error) {
      // Keep diagnostics structured: parser messages can contain file contents.
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
        ? error.code : 'FALLBACK_PREFLIGHT_FAILED';
      failures.push({ path: row.path, packageName, code });
    }
  }
  return { version: 1, profile, backup, harnessRelease: links.length || failures.length ? harnessRelease ?? null : null,
    harnessIdentity: harnessIdentity ?? null, rootGroupPolicy, links, failures };
}

function requireFallbackLinkAudit(audit) {
  if (audit.failures.length) throw Object.assign(new Error(audit.failures[0].code), {
    code: audit.failures[0].code, fallbackPreflight: audit,
  });
}

export function fallbackAuditSummary(audit) {
  return { matched: audit.links.length + audit.failures.length, failed: audit.failures.length,
    failures: audit.failures.slice(0, 32).map(({ packageName, code }) => ({ packageName, code })) };
}

/** Plan only exact, same-name profile fallback links; never modify their source. */
export function planCandidateLinkRelocations({ candidate, profile, backup, inventory, harnessRelease, rootGroupPolicy }) {
  for (const path of [candidate, profile, backup]) checkDirectory(path);
  for (const root of [profile, backup]) {
    need(!below(root, candidate) && !below(candidate, root), 'OVERLAPPING_RECOVERY_PATHS');
  }
  const actual = installationInventory(candidate);
  need(actual.sha256 === inventory.sha256, 'CANDIDATE_INSTALLATION_CHANGED');
  const audit = auditFallbackLinkTargets({ profile, backup, inventory, harnessRelease, rootGroupPolicy });
  requireFallbackLinkAudit(audit);
  const rows = structuredClone(inventory.rows), links = audit.links.map(link => ({ ...link,
    candidateLinkIdentity: directoryIdentity(fs.lstatSync(join(candidate, link.path))) }));
  const approved = new Map(links.map(link => [link.path, link.target]));
  for (const row of rows) if (approved.has(row.path)) row.target = approved.get(row.path);
  const expected = { rows, bytes: inventory.bytes, sha256: sha(JSON.stringify(rows)) };
  // Unrecognized production/backup references still fail the original guard.
  // Validation of the entire plan precedes every candidate write.
  verifyCandidateLinks(candidate, profile, backup, expected);
  return { version: 1, candidate, profile, backup, originalHash: actual.sha256,
    harnessRelease: audit.harnessRelease, harnessIdentity: audit.harnessIdentity, rootGroupPolicy,
    links, expected };
}

export function recheckCandidateLinkRelocations(plan) {
  if (!plan.links.length) return;
  need(equal(protectedPhysicalDirectory(plan.harnessRelease, 'FALLBACK_RELEASE_CHANGED', plan.rootGroupPolicy), plan.harnessIdentity),
    'FALLBACK_RELEASE_CHANGED');
  for (const link of plan.links) {
    need(fs.realpathSync.native(link.sourceTarget) === link.target, 'FALLBACK_SOURCE_TARGET_CHANGED');
    need(equal(protectedPhysicalDirectory(link.target, 'FALLBACK_TARGET_CHANGED', plan.rootGroupPolicy), link.targetIdentity),
      'FALLBACK_TARGET_CHANGED');
    const inventory = fallbackPackageInventory(link.target, plan.profile, plan.backup);
    need(inventory.sha256 === link.targetTreeHash, 'FALLBACK_PACKAGE_CHANGED');
  }
}

/** Only a fresh candidate is changed; exact metadata and source inventories remain authoritative. */
export function applyCandidateLinkRelocations(candidate, plan) {
  need(candidate === plan.candidate && installationInventory(candidate).sha256 === plan.originalHash,
    'CANDIDATE_INSTALLATION_CHANGED');
  recheckCandidateLinkRelocations(plan);
  for (const [index, link] of plan.links.entries()) {
    const path = join(candidate, link.path), info = fs.lstatSync(path);
    need(info.isSymbolicLink() && equal(directoryIdentity(info), link.candidateLinkIdentity)
      && fs.readlinkSync(path) === link.sourceTarget, 'FALLBACK_CANDIDATE_LINK_CHANGED');
    const temp = path + `.pkw-relocation-${process.pid}-${index}`;
    fs.symlinkSync(link.target, temp);
    const created = fs.lstatSync(temp);
    need(created.uid === info.uid && created.gid === info.gid && (created.mode & 0o7777) === (info.mode & 0o7777),
      'FALLBACK_LINK_METADATA_CHANGED');
    need(equal(directoryIdentity(fs.lstatSync(path)), link.candidateLinkIdentity)
      && fs.readlinkSync(path) === link.sourceTarget, 'FALLBACK_CANDIDATE_LINK_CHANGED');
    fs.renameSync(temp, path); syncDir(dirname(path));
  }
  need(installationInventory(candidate).sha256 === plan.expected.sha256, 'CANDIDATE_INSTALLATION_CHANGED');
  verifyCandidateLinks(candidate, plan.profile, plan.backup, plan.expected);
  recheckCandidateLinkRelocations(plan);
  return plan.expected;
}

/**
 * A journal precedes every rename. Interrupted transactions retain original
 * objects and a lock; a subsequent invocation refuses to overwrite that state.
 * In-process failures reverse only renames whose actual filesystem identity
 * matches this transaction, and never delete a production component.
 */
export async function restoreInstallation(options, hooks) {
  const { profile, backup, workRoot } = options;
  for (const path of [profile, backup, workRoot]) checkDirectory(path);
  for (const [a, b] of [[profile, backup], [profile, workRoot], [backup, workRoot]]) {
    need(!below(a, b) && !below(b, a), 'OVERLAPPING_RECOVERY_PATHS');
  }
  hooks.checkState(); hooks.checkWriters();
  const receiptBytes = fs.readFileSync(options.receipt), receipt = JSON.parse(receiptBytes);
  need(receipt.profile === profile && receipt.beforeHost && Object.keys(receipt.beforeHost).length > 0
    && Object.values(receipt.beforeHost).every(x => /^[a-f0-9]{64}$/.test(x)), 'INVALID_HOST_BASELINE');
  const observed = [[profile, 'package.json', options.currentManifestHash], [profile, 'pnpm-lock.yaml', options.currentLockHash],
    [backup, 'package.json', options.backupManifestHash], [backup, 'pnpm-lock.yaml', options.backupLockHash]];
  for (const [root, name, expected] of observed) {
    const info = fs.lstatSync(join(root, name));
    need(info.isFile() && info.uid === process.getuid() && !(info.mode & 0o022), 'INSTALLATION_MANIFEST_IDENTITY_CHANGED');
    need(/^[a-f0-9]{64}$/.test(expected ?? '') && sha(fs.readFileSync(join(root, name))) === expected, 'OBSERVED_INSTALLATION_CHANGED');
  }
  compareInstallationManifests(JSON.parse(fs.readFileSync(join(profile, 'package.json'))), JSON.parse(fs.readFileSync(join(backup, 'package.json'))));
  for (const name of ['package.json', 'pnpm-lock.yaml', 'node_modules']) need(present(join(backup, name)), 'BACKUP_INSTALLATION_MEMBER_MISSING');
  for (const root of [profile, backup]) need(fs.lstatSync(join(root, 'node_modules')).isDirectory(), 'INSTALLATION_MODULES_NOT_DIRECTORY');
  const original = installationInventory(profile), historical = installationInventory(backup);
  hooks.checkSpace(historical.bytes, original.bytes);
  const monitored = ['cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml'];
  const configBefore = installationInventory(profile, monitored);
  const lock = join(profile, '.dsh-install-recovery.lock');
  need(!present(lock), 'RECOVERY_TRANSACTION_EXISTS');
  const requestedRootGroupDirs = options.rootGroupWritableDirs ?? [];
  need(Array.isArray(requestedRootGroupDirs), 'ROOT_GROUP_POLICY_SCOPE_INVALID');
  need(options.checkOnly === undefined || typeof options.checkOnly === 'boolean', 'INVALID_RESTORE_OPTIONS');
  let rootGroupPolicy;
  const observeRootGroup = hooks.observeRootGroupDirectories ?? observeRootGroupDirectories;
  if (requestedRootGroupDirs.length) {
    const targets = historical.rows.filter(row => exactFallbackPackage(row, profile))
      .map(row => fs.realpathSync.native(row.target));
    rootGroupPolicy = assertRootGroupDirectoryPolicy({ paths: requestedRootGroupDirs,
      harnessRelease: options.harnessRelease, targets }, undefined, observeRootGroup);
  }
  const recheckRootGroup = () => {
    if (rootGroupPolicy) assertRootGroupDirectoryPolicy(rootGroupPolicy.context, rootGroupPolicy, observeRootGroup);
  };
  const fallbackPreflight = auditFallbackLinkTargets({ profile, backup, inventory: historical,
    harnessRelease: options.harnessRelease, rootGroupPolicy });
  requireFallbackLinkAudit(fallbackPreflight);
  recheckRootGroup();
  if (options.checkOnly) {
    recheckCandidateLinkRelocations(fallbackPreflight);
    hooks.checkState(); hooks.checkWriters();
    return { status: 'PREFLIGHT_PASSED', checkOnly: true, fallbackTargets: fallbackPreflight.links.length,
      rootGroupDirectories: requestedRootGroupDirs.length, servicesStarted: false, databasesRestored: false };
  }
  const evidence = fs.mkdtempSync(join(workRoot, 'installation-recovery-'));
  fs.chmodSync(evidence, 0o700);
  const candidate = fs.mkdtempSync(join(dirname(profile), '.dsh-install-candidate-'));
  fs.chmodSync(candidate, 0o700);
  const retained = fs.mkdtempSync(join(dirname(profile), '.dsh-install-retained-'));
  fs.chmodSync(retained, 0o700);
  const journalFile = join(evidence, 'journal.json');
  const journal = { status: 'preparing', profile, backup, candidate, retained,
    startedAt: new Date().toISOString(), originalHash: original.sha256, backupHash: historical.sha256,
    receiptHash: sha(receiptBytes), fallbackPreflight, rootGroupPolicy, steps: [],
    installationOnly: true, serviceStarted: false, databaseRestored: false };
  if (present(lock)) {
    durableJson(journalFile, { ...journal, status: 'stopped-existing-transaction' });
    throw Object.assign(new Error('RECOVERY_TRANSACTION_EXISTS'), { code: 'RECOVERY_TRANSACTION_EXISTS', evidence });
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  durableJson(join(lock, 'transaction.json'), { journal: journalFile });
  const save = () => { durableJson(journalFile, journal); hooks.progress?.(journal.status, evidence); };
  save();
  const completed = [];
  const renameStep = step => {
    hooks.beforeRename?.(step);
    recheckRootGroup();
    hooks.checkState(); hooks.checkWriters();
    const source = fs.lstatSync(step.from);
    need(source.dev === step.dev && source.ino === step.inode && !present(step.to), 'RENAME_IDENTITY_CHANGED');
    fs.renameSync(step.from, step.to); completed.push(step);
    syncDir(dirname(step.from)); syncDir(dirname(step.to));
    step.state = 'done'; save();
  };
  let committed = false;
  try {
    const saved = join(evidence, 'previous-installation'); fs.mkdirSync(saved, { mode: 0o700 });
    copyInstallation(profile, saved); verifyCopiedInstallation(profile, saved, original);
    durableJson(join(evidence, 'previous-inventory.json'), original);
    copyInstallation(backup, candidate); const staged = verifyCopiedInstallation(backup, candidate, historical);
    recheckRootGroup();
    recheckCandidateLinkRelocations(fallbackPreflight);
    const relocationPlan = planCandidateLinkRelocations({ candidate, profile, backup, inventory: staged,
      harnessRelease: options.harnessRelease, rootGroupPolicy });
    const { expected, ...relocationReceipt } = relocationPlan;
    durableJson(join(evidence, 'candidate-expected-inventory.json'), expected);
    journal.linkRelocations = relocationReceipt; journal.candidateExpectedHash = expected.sha256;
    journal.relocationState = 'planned'; save();
    applyCandidateLinkRelocations(candidate, relocationPlan);
    journal.relocationState = 'applied'; save();
    for (const name of monitored) {
      if (present(join(profile, name))) fs.cpSync(join(profile, name), join(candidate, name), { dereference: false, verbatimSymlinks: true });
    }
    journal.status = 'candidate-check'; save();
    recheckRootGroup();
    recheckCandidateLinkRelocations(relocationPlan);
    const candidateReport = await hooks.checkRuntime(candidate, receipt.beforeHost);
    recheckRootGroup();
    recheckCandidateLinkRelocations(relocationPlan);
    durableJson(join(evidence, 'candidate-check.json'), candidateReport);
    hooks.checkState(); hooks.checkWriters(); hooks.checkSpace(0, 0);
    need(sha(fs.readFileSync(options.receipt)) === sha(receiptBytes), 'DEPLOYMENT_RECEIPT_CHANGED');
    need(equal(installationInventory(profile).identities, original.identities)
      && installationInventory(profile).sha256 === original.sha256, 'CURRENT_INSTALLATION_CHANGED');
    need(equal(installationInventory(backup).identities, historical.identities)
      && installationInventory(backup).sha256 === historical.sha256, 'BACKUP_INSTALLATION_CHANGED');
    need(installationInventory(candidate).sha256 === expected.sha256, 'CANDIDATE_INSTALLATION_CHANGED');
    need(installationInventory(profile, monitored).sha256 === configBefore.sha256, 'LIVE_CONFIGURATION_CHANGED');
    hooks.recheckRuntime(candidateReport);
    journal.status = 'switching'; save();
    for (const name of installationFiles) {
      const old = join(profile, name), parked = join(retained, name), next = join(candidate, name);
      if (present(old)) {
        const s = fs.lstatSync(old), step = { from: old, to: parked, dev: s.dev, inode: s.ino, state: 'planned' };
        journal.steps.push(step); save(); renameStep(step);
      }
      if (present(next)) {
        const s = fs.lstatSync(next), step = { from: next, to: old, dev: s.dev, inode: s.ino, state: 'planned' };
        journal.steps.push(step); save(); renameStep(step);
      }
    }
    need(installationInventory(profile).sha256 === expected.sha256, 'FINAL_INSTALLATION_MISMATCH');
    need(installationInventory(profile, monitored).sha256 === configBefore.sha256, 'LIVE_CONFIGURATION_CHANGED');
    hooks.checkState(); hooks.checkWriters(); hooks.recheckRuntime(candidateReport, candidate);
    journal.status = 'final-runtime-check'; save();
    recheckRootGroup();
    recheckCandidateLinkRelocations(relocationPlan);
    const finalReport = await hooks.checkRuntime(profile, receipt.beforeHost);
    recheckRootGroup();
    recheckCandidateLinkRelocations(relocationPlan);
    durableJson(join(evidence, 'final-check.json'), finalReport);
    hooks.recheckRuntime(finalReport); hooks.checkState(); hooks.checkWriters();
    need(installationInventory(profile).sha256 === expected.sha256
      && installationInventory(profile, monitored).sha256 === configBefore.sha256, 'FINAL_FILES_CHANGED');
    recheckRootGroup();
    journal.status = 'installation-restored-verified'; journal.finishedAt = new Date().toISOString(); save();
    committed = true;
    fs.unlinkSync(join(lock, 'transaction.json')); fs.rmdirSync(lock); syncDir(profile);
    return { status: journal.status, evidence, retainedOriginal: retained, candidate,
      servicesStarted: false, databasesRestored: false, pnpmWorkspacePreserved: true };
  } catch (error) {
    journal.errorCode = error.code ?? 'RECOVERY_CHECK_FAILED'; journal.status = 'reverting';
    try { save(); } catch { /* Retain filesystem objects even if journal storage fails. */ }
    try {
      // An external writer or restarted service makes a reverse rename unsafe.
      // A failed root-group audit blocks forward use of the candidate, not
      // restoration of the original objects under the original rollback guards.
      hooks.checkState(); hooks.checkWriters();
      for (const step of [...completed].reverse()) {
        hooks.checkState(); hooks.checkWriters();
        const at = fs.lstatSync(step.to);
        need(at.dev === step.dev && at.ino === step.inode && !present(step.from), 'REVERT_IDENTITY_CHANGED');
        fs.renameSync(step.to, step.from); syncDir(dirname(step.to)); syncDir(dirname(step.from));
        step.state = 'reverted'; save();
      }
      need(installationInventory(profile).sha256 === original.sha256, 'REVERT_INSTALLATION_MISMATCH');
      journal.status = 'stopped-original-installation-retained'; save();
      fs.unlinkSync(join(lock, 'transaction.json')); fs.rmdirSync(lock); syncDir(profile);
    } catch (revertError) {
      journal.status = 'manual-recovery-required'; journal.revertCode = revertError.code ?? 'REVERT_FAILED';
      try { save(); } catch { /* The lock's transaction pointer remains the recovery entry point. */ }
    }
    throw Object.assign(error, { evidence, recoveryStatus: journal.status });
  } finally {
    // No installation tree is deleted, including failed candidates or retained originals.
    if (!committed) hooks.progress?.('recovery-stopped', evidence);
  }
}

const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'], ...options
});
const property = (unit, name) => run('systemctl', ['show', unit, '--property=' + name, '--value']).trim();

export function parseRestoreOptions(args) {
  const names = ['profile', 'backup', 'receipt', 'work-root', 'harness', 'helper', 'resume-script', 'profile-snapshot',
    'resume-sha256', 'current-manifest-sha256', 'current-lock-sha256', 'backup-manifest-sha256', 'backup-lock-sha256'];
  const options = { ...Object.fromEntries(names.map(name => [name, { type: 'string' }])),
    'root-group-writable-dir': { type: 'string', multiple: true }, 'check-only': { type: 'boolean', default: false } };
  const { values } = parseArgs({ args, options, strict: true, allowPositionals: false });
  for (const name of names) {
    const value = values[name];
    need(typeof value === 'string' && (name.endsWith('sha256') ? /^[a-f0-9]{64}$/.test(value) :
      isAbsolute(value) && resolve(value) === value && value !== '/' && !/[\s%\\]/.test(value)), 'INVALID_RESTORE_OPTIONS');
  }
  const rootGroupDirs = values['root-group-writable-dir'] ?? [];
  need(rootGroupDirs.length <= 64 && new Set(rootGroupDirs).size === rootGroupDirs.length
    && rootGroupDirs.every(path => isAbsolute(path) && resolve(path) === path && path !== '/' && !/[\s%\\\0]/.test(path)),
  'INVALID_RESTORE_OPTIONS');
  need(values.profile === '/root/.dsh/profiles/web' && values.harness === '/opt/deepseek-harness', 'UNSUPPORTED_SERVICE_PROFILE');
  return values;
}

async function main() {
  let evidence;
  try {
    const o = parseRestoreOptions(process.argv.slice(2));
    need(process.getuid() === 0 && (fs.statSync('/').mode & 0o7777) === 0o755, 'ROOT_IDENTITY_CHANGED');
    checkDirectory(o['work-root']);
    const workInfo = fs.statSync(o['work-root']);
    need(workInfo.uid === 0 && (workInfo.mode & 0o077) === 0, 'WORK_ROOT_NOT_PRIVATE');
    need(workInfo.dev !== fs.statSync('/').dev, 'WORK_ROOT_NOT_ON_DATA_DISK');
    const canonical = fs.realpathSync(o.harness);
    const releaseIdentity = fs.statSync(canonical);
    need(sha(fs.readFileSync(o.helper)) === '4371a15bfd6c61e388f05c1cf7c3a1bebc8dac775dba01e5f5f5216a9ae7e250', 'HELPER_HASH_CHANGED');
    need(sha(fs.readFileSync(o['resume-script'])) === o['resume-sha256'], 'RESUME_SCRIPT_HASH_CHANGED');
    const runtimeSources = [o.helper, o['resume-script']].map(path => [path, sha(fs.readFileSync(path))]);
    const sharedFallback = installationInventory(dirname(o.profile), ['node_modules']);
    const checkState = () => {
      need(['inactive', 'failed'].includes(property('deepseek-harness.service', 'ActiveState'))
        && property('pkw-collaboration.service', 'ActiveState') === 'inactive', 'SERVICES_NOT_STOPPED');
      need(!run('ss', ['-ltnH', '( sport = :3080 or sport = :3081 )']).trim(), 'SERVICE_PORT_BUSY');
      need(fs.realpathSync(o.harness) === canonical, 'HARNESS_RELEASE_CHANGED');
      const now = fs.statSync(canonical);
      need(now.dev === releaseIdentity.dev && now.ino === releaseIdentity.ino, 'HARNESS_RELEASE_REPLACED');
      for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')) {
        const target = line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, value) => String.fromCharCode(parseInt(value, 8)));
        for (const root of [o.profile, o.backup]) {
          for (const name of installationFiles) need(!below(join(root, name), target), 'INSTALLATION_MOUNT_BOUNDARY');
        }
      }
    };
    const checkWriters = () => {
      const units = run('systemctl', ['list-units', '--type=service', '--state=active,activating', '--no-legend', '--plain', '--no-pager']);
      need(!units.split('\n').some(line => /^\S*pkw\S*(deploy|upgrade|rehears)\S*\.service\s/.test(line.trimStart())), 'DEPLOYMENT_UNIT_ACTIVE');
      for (const pid of fs.readdirSync('/proc').filter(x => /^\d+$/.test(x) && Number(x) !== process.pid)) {
        try {
          const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
          if (!/^(?:node|cp|rsync|rm|mv|tar|bash|sh|python3?)$|^(?:npm|pnpm)(?:\s|$)/.test(comm)) continue;
          const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '), cwd = fs.realpathSync(`/proc/${pid}/cwd`);
          need(!(cwd === o.profile || cwd.startsWith(o.profile + '/') || args.includes(o.profile)
            || /(?:deploy-site\.mjs|deploy-pkw\.mjs|run-production\.sh|run-rehearsal[^ ]*\.sh)/.test(args)), 'PROFILE_WRITER_ACTIVE');
        } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
      }
    };
    const checkSpace = (candidateBytes, savedBytes) => {
      const free = path => { const s = fs.statfsSync(path); return s.bavail * s.bsize; };
      need(free(o.profile) > 5 * 1024 ** 3 + candidateBytes * 1.15 + 64 * 1024 ** 2, 'SYSTEM_DISK_RECOVERY_BUDGET_LOW');
      need(free(o['work-root']) > 10 * 1024 ** 3 + savedBytes * 1.15 + 64 * 1024 ** 2, 'DATA_DISK_RECOVERY_BUDGET_LOW');
    };
    const checkRuntime = async (profile, expected) => {
      const code = `
        import * as fs from 'node:fs';
        import { createHash } from 'node:crypto';
        import { createRequire } from 'node:module';
        import { pathToFileURL } from 'node:url';
        const profile = ${JSON.stringify(profile)}, expected = ${JSON.stringify(expected)};
        const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        const require = createRequire(profile + '/package.json'), hosts = [];
        for (const [name, sha256] of Object.entries(expected)) {
          const path = require.resolve(name), real = fs.realpathSync(path);
          if (hash(real) !== sha256) throw Object.assign(new Error('HOST_HASH_CHANGED'), {code:'HOST_HASH_CHANGED'});
          hosts.push({name, path, real, sha256});
        }
        const installation = createRequire(${JSON.stringify(join(canonical, 'apps/cli/package.json'))});
        const boot = await import(pathToFileURL(installation.resolve('@deepseek-ai/dsh-app-boot')).href);
        const yaml = createRequire(${JSON.stringify(join(canonical, 'vendor/include/package.json'))})('js-yaml');
        const H = await import(${JSON.stringify(pathToFileURL(o.helper).href)});
        const R = await import(${JSON.stringify(pathToFileURL(o['resume-script']).href)});
        const configuration = await R.verifyResumeConfiguration({profile,
          installAnchor:${JSON.stringify(join(canonical, 'apps/cli/package.json'))},
          snapshot:${JSON.stringify(o['profile-snapshot'])}, homePatchFile:'/root/.dsh/cordis.patch.yml'}, {boot,yaml,H});
        process.stdout.write('INSTALLATION_VERIFIED ' + JSON.stringify({hosts, configuration}));
      `;
      try {
        const result = run('/usr/local/bin/node', ['--import', 'tsx/esm', '--input-type=module', '-e', code], {
          cwd: canonical, timeout: 45000, maxBuffer: 1024 ** 2,
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'].includes(key)))
        });
        need(result.startsWith('INSTALLATION_VERIFIED '), 'RUNTIME_PROBE_OUTPUT_CHANGED');
        return JSON.parse(result.slice('INSTALLATION_VERIFIED '.length));
      } catch (e) {
        if (evidence) fs.writeFileSync(join(evidence, 'runtime-error.log'), e.stderr ?? String(e.code ?? 'RUNTIME_CHECK_FAILED'), { mode: 0o600 });
        throw Object.assign(new Error('INSTALLATION_RUNTIME_CHECK_FAILED'), {code:'INSTALLATION_RUNTIME_CHECK_FAILED'});
      }
    };
    const recheckRuntime = (report, movedCandidate) => {
      const fallbackNow = installationInventory(dirname(o.profile), ['node_modules']);
      need(fallbackNow.sha256 === sharedFallback.sha256 && equal(fallbackNow.identities, sharedFallback.identities), 'SHARED_FALLBACK_CHANGED');
      for (const [path, hash] of runtimeSources) need(sha(fs.readFileSync(path)) === hash, 'RUNTIME_SOURCE_CHANGED');
      for (const row of report.hosts) {
        if (!movedCandidate || !below(movedCandidate, row.path)) {
          need(fs.realpathSync(row.path) === row.real && sha(fs.readFileSync(row.real)) === row.sha256, 'HOST_FALLBACK_CHANGED');
        }
      }
      for (const [path, hash] of report.configuration.inputs) {
        if (!movedCandidate || !below(movedCandidate, path)) need(sha(fs.readFileSync(path)) === hash, 'CONFIGURATION_INPUT_CHANGED');
      }
    };
    const result = await restoreInstallation({ profile: o.profile, backup: o.backup, receipt: o.receipt, workRoot: o['work-root'],
      harnessRelease: canonical, rootGroupWritableDirs: o['root-group-writable-dir'] ?? [], checkOnly: o['check-only'],
      currentManifestHash: o['current-manifest-sha256'], currentLockHash: o['current-lock-sha256'],
      backupManifestHash: o['backup-manifest-sha256'], backupLockHash: o['backup-lock-sha256'] }, {
      checkState, checkWriters, checkSpace, checkRuntime, recheckRuntime,
      observeRootGroupDirectories,
      progress: (phase, directory) => { evidence = directory; console.log(JSON.stringify({ phase, privateEvidence: directory })); }
    });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(JSON.stringify({ status: 'RESTORE_STOP', code: e.code ?? 'RECOVERY_CHECK_FAILED',
      recoveryStatus: e.recoveryStatus, privateEvidence: e.evidence ?? evidence,
      fallbackPreflight: e.fallbackPreflight ? fallbackAuditSummary(e.fallbackPreflight) : undefined }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

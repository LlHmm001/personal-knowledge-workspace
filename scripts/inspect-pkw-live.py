#!/usr/bin/env python3
"""Read-only inventory for the first PKW independent-runtime migration.

No service actions, HTTP, database opens, configuration writes or secret output.
Library collect() accepts fixture readers; CLI is restricted to Linux/root.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

UNITS = ('pkw-collaboration.service', 'deepseek-harness.service')
FIELDS = ('Id LoadState ActiveState SubState MainPID ControlPID NRestarts ControlGroup '
          'FragmentPath DropInPaths User Group WorkingDirectory EnvironmentFiles Restart '
          'KillMode KillSignal SendSIGKILL TimeoutStopUSec PartOf BindsTo Requires Wants Conflicts PropagatesStopTo '
          'StopWhenUnneeded').split()
HOOKS = ('ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost')
PKW_NAMES = ['@deepseek-ai/dsh-pkw-' + n for n in
             ('base', 'domain', 'events', 'notes', 'attachments', 'workspace', 'web',
              'tasks', 'weknora', 'weknora-sync')]
PEER_NAMES = ('@deepseek-ai/dsh-session', '@deepseek-ai/dsh-storage', '@deepseek-ai/cordis')


class InventoryError(Exception):
    def __init__(self, code):
        self.code = code


def require(ok, code):
    if not ok:
        raise InventoryError(code)


def bounded_read(path, limit=2097152):
    real = Path(path).resolve(strict=True)
    fd = os.open(real, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode), 'NOT_REGULAR_FILE')
        require(before.st_size <= limit, 'FILE_TOO_LARGE')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        after = os.fstat(fd)
        require(len(data) <= limit, 'FILE_TOO_LARGE')
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'FILE_CHANGED')
        return data
    finally:
        os.close(fd)


def read_json(path, limit=2097152):
    value = json.loads(bounded_read(path, limit))
    require(isinstance(value, dict), 'JSON_NOT_OBJECT')
    return value


def safe_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 4096 and
            not any(ord(c) < 32 for c in value), 'INVALID_PATH')
    path = Path(value)
    require(path.is_absolute(), 'PATH_NOT_ABSOLUTE')
    return path


def metadata(path, digest=False):
    path = Path(path)
    try:
        st = path.lstat()
    except FileNotFoundError:
        return {'path': str(path), 'exists': False}
    real = path.resolve(strict=True)
    out = {'path': str(path), 'realpath': str(real), 'exists': True,
           'kind': 'symlink' if stat.S_ISLNK(st.st_mode) else 'directory' if stat.S_ISDIR(st.st_mode)
           else 'file' if stat.S_ISREG(st.st_mode) else 'other',
           'uid': st.st_uid, 'gid': st.st_gid, 'mode': oct(stat.S_IMODE(st.st_mode)),
           'bytes': st.st_size, 'device': st.st_dev, 'inode': st.st_ino, 'mtimeNs': st.st_mtime_ns}
    if stat.S_ISLNK(st.st_mode):
        target = real.stat()
        out['resolvedTarget'] = {'uid': target.st_uid, 'gid': target.st_gid, 'mode': oct(stat.S_IMODE(target.st_mode))}
    if digest:
        out['sha256'] = hashlib.sha256(bounded_read(path)).hexdigest()
    return out


def read_unit(name):
    require(name in UNITS, 'UNIT_NOT_ALLOWED')
    args = ['/usr/bin/systemctl', 'show', name, '--no-pager']
    for key in FIELDS + list(HOOKS):
        args.extend(['--property', key])
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=5, check=False, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    require(result.returncode == 0, 'SYSTEMCTL_FAILED')
    require(len(result.stdout) <= 262144, 'UNIT_OUTPUT_TOO_LARGE')
    values = {}
    for line in result.stdout.decode('utf-8', 'strict').splitlines():
        key, sep, value = line.partition('=')
        require(sep and key in FIELDS + list(HOOKS) and key not in values, 'UNIT_OUTPUT_INVALID')
        values[key] = value
    require(all(key in values for key in ('Id', 'ActiveState', 'MainPID', 'ControlPID', 'NRestarts')),
            'UNIT_OUTPUT_INCOMPLETE')
    return values


def du_bytes(path):
    try:
        result = subprocess.run(['/usr/bin/du', '-s', '-x', '-B1', '--', str(path)],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=12, check=False, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        require(result.returncode == 0, 'DU_FAILED')
        first = result.stdout.split(b'\t', 1)[0].decode('ascii', 'strict')
        require(first.isdecimal(), 'DU_OUTPUT_INVALID')
        return {'known': True, 'bytes': int(first)}
    except Exception as error:
        return {'known': False, 'code': error_code(error)}


def error_code(error):
    return getattr(error, 'code', None) if isinstance(error, InventoryError) else type(error).__name__


def unit_safe(raw, expected_id=None):
    require(isinstance(raw, dict), 'UNIT_OUTPUT_INVALID')
    require(expected_id is None or raw.get('Id') == expected_id, 'UNIT_ID_MISMATCH')
    require(all(isinstance(raw[key], str) and len(raw[key]) <= 16384
                for key in FIELDS + list(HOOKS) if key in raw), 'UNIT_VALUE_INVALID')
    out = {key: raw[key] for key in FIELDS if key in raw}
    for key in ('MainPID', 'ControlPID', 'NRestarts'):
        value = out.get(key, '')
        require(isinstance(value, str) and value.isdecimal(), 'UNIT_PID_INVALID')
        out[key] = int(value)
    out['hooksPresent'] = {key: bool(raw.get(key)) for key in HOOKS}
    return out


def proc_snapshot(proc_root, pid):
    require(isinstance(pid, int) and pid > 0, 'MAIN_PROCESS_NOT_RUNNING')
    root = proc_root / str(pid)
    text = bounded_read(root / 'stat', 65536).decode()
    fields = text[text.rfind(')') + 2:].split()
    require(len(fields) > 19 and fields[19].isdecimal(), 'PROC_STAT_INVALID')
    cmd = bounded_read(root / 'cmdline', 65536)
    boot = bounded_read(proc_root / 'sys/kernel/random/boot_id', 128).decode().strip()
    require(bool(re.fullmatch(r'[0-9a-fA-F-]{36}', boot)), 'BOOT_ID_INVALID')
    return {'pid': pid, 'bootId': boot, 'startTicks': fields[19], 'cmdlineSha256': hashlib.sha256(cmd).hexdigest()}, cmd


def parse_listener(cmd, cwd, exe):
    require(cmd.endswith(b'\0'), 'CMDLINE_INVALID')
    args = cmd[:-1].decode('utf-8', 'strict').split('\0')
    require(len(args) >= 2 and Path(args[0]).name in ('node', 'nodejs') and
            Path(exe).name in ('node', 'nodejs'), 'NOT_DIRECT_NODE_LISTENER')
    runner = Path(args[1])
    runner = (cwd / runner).resolve(strict=True)
    require(runner.name == 'serve-collaboration.mjs', 'NOT_DIRECT_NODE_LISTENER')
    values = {}
    i = 2
    while i < len(args):
        key, sep, value = args[i].partition('=')
        require(key in ('--profile', '--config', '--port', '--drain-timeout-ms') and key not in values,
                'UNRECOGNIZED_OR_DUPLICATE_ARGUMENT')
        if not sep:
            i += 1
            require(i < len(args), 'MISSING_ARGUMENT')
            value = args[i]
        values[key] = value
        i += 1
    require('--profile' in values and '--config' in values, 'MISSING_ARGUMENT')
    out = {'runner': str(runner)}
    for key in ('profile', 'config'):
        value = values['--' + key]
        require(value and not any(ord(c) < 32 for c in value), 'INVALID_PATH')
        path = Path(value)
        out[key] = str(safe_path(str(path if path.is_absolute() else cwd / path)))
    for key, default, maximum in (('port', '3081', 65535), ('drain-timeout-ms', None, 86400000)):
        value = values.get('--' + key, default)
        require(value is None or value.isdecimal() and 1 <= int(value) <= maximum, 'INVALID_NUMBER_ARGUMENT')
        out[key] = int(value) if value is not None else None
    out['drainSource'] = 'argument' if '--drain-timeout-ms' in values else 'environment-or-default-not-read'
    return out


def config_safe(config):
    data = safe_path(config.get('dataPath'))
    real = data.resolve(strict=True)
    require(real.is_dir(), 'DATA_ROOT_NOT_DIRECTORY')
    url = config.get('publicOrigin')
    require(isinstance(url, str) and len(url) <= 4096, 'INVALID_PUBLIC_ORIGIN')
    parsed = urlsplit(url)
    require(parsed.scheme in ('http', 'https') and parsed.hostname and parsed.port != 0, 'INVALID_PUBLIC_ORIGIN')
    host = '[' + parsed.hostname + ']' if ':' in parsed.hostname else parsed.hostname
    origin = parsed.scheme + '://' + host + (':' + str(parsed.port) if parsed.port else '')
    env = config.get('bootstrapPasswordEnv', 'PKW_BOOTSTRAP_PASSWORD')
    valid_env = lambda value: isinstance(value, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', value)
    require(valid_env(env), 'INVALID_BOOTSTRAP_ENV_NAME')
    retrieval = config.get('retrieval', {})
    require(isinstance(retrieval, dict) and len(retrieval) <= 10000, 'INVALID_RETRIEVAL')
    names = []
    for item in retrieval.values():
        require(isinstance(item, dict) and valid_env(item.get('apiKeyEnv')), 'INVALID_RETRIEVAL_ENV_NAME')
        remote = item.get('baseUrl')
        require(isinstance(remote, str) and len(remote) <= 4096 and
                isinstance(item.get('kbId'), str) and bool(item['kbId']), 'INVALID_RETRIEVAL')
        remote_url = urlsplit(remote)
        require(remote_url.scheme in ('http', 'https') and remote_url.hostname and
                not (remote_url.username or remote_url.password or remote_url.query or remote_url.fragment),
                'INVALID_RETRIEVAL')
        names.append(item['apiKeyEnv'])
    return {'dataPath': str(data), 'canonicalDataPath': str(real), 'dataPathIsCanonical': data == real,
            'publicOrigin': origin, 'publicOriginHadRemovedComponents': bool(parsed.username or parsed.password or
              parsed.query or parsed.fragment or parsed.path not in ('', '/')),
            'bootstrapPasswordEnv': env, 'retrievalCount': len(retrieval), 'retrievalApiKeyEnvNames': sorted(set(names))}


def package_info(profile, name):
    found = None
    for ancestor in (profile, *profile.parents):
        candidate = ancestor / 'node_modules' / name
        if os.path.lexists(candidate):
            found = candidate
            break
    require(found is not None, 'PACKAGE_NOT_FOUND')
    real = found.resolve(strict=True)
    manifest = read_json(real / 'package.json')
    version = manifest.get('version')
    require(manifest.get('name') == name and isinstance(version, str) and
            re.fullmatch(r'[0-9A-Za-z._+\-]{1,100}', version), 'PACKAGE_MANIFEST_INVALID')
    return {'name': name, 'version': version, 'path': str(found), 'realpath': str(real),
            'outsideProfile': not (real == profile or profile in real.parents)}


def collect(unit_reader=read_unit, proc_root=Path('/proc'), du_reader=du_bytes):
    report = {'status': 'INVENTORY_COLLECTED', 'servicesChanged': False, 'productionAcceptance': 'not_run',
              'units': {}, 'processes': {}, 'files': {}, 'issues': [], 'stability': {'checked': False}}
    def attempt(label, fn):
        try:
            return fn()
        except Exception as error:
            report['issues'].append({'at': label, 'code': error_code(error)})
            return None
    def file_at(label, path, digest=True):
        report['files'][label] = attempt(label, lambda: metadata(path, digest))
    baseline = {}
    for name in UNITS:
        unit = attempt(name, lambda name=name: unit_safe(unit_reader(name), name))
        report['units'][name] = unit
        if not unit:
            continue
        for key in ('FragmentPath',):
            if unit.get(key):
                attempt(key, lambda: file_at(name + '/' + key, safe_path(unit[key])))
        for key in ('DropInPaths', 'EnvironmentFiles'):
            raw = unit.get(key, '')
            if key == 'EnvironmentFiles':
                raw = re.sub(r' \(ignore_errors=(?:yes|no)\)', '', raw)
            for index, item in enumerate(raw.split()):
                attempt(key, lambda item=item, index=index: file_at(name + '/' + key + '/' + str(index),
                                                                   safe_path(item), key != 'EnvironmentFiles'))
        snapshot = attempt(name + '/process', lambda: proc_snapshot(proc_root, unit['MainPID']))
        if snapshot:
            baseline[name] = snapshot[0]
            report['processes'][name] = snapshot[0]
    unit = report['units'].get(UNITS[0])
    if unit and UNITS[0] in baseline:
        def inspect_listener():
            root = proc_root / str(unit['MainPID'])
            cwd, exe = safe_path(os.readlink(root / 'cwd')), safe_path(os.readlink(root / 'exe'))
            _, cmd = proc_snapshot(proc_root, unit['MainPID'])
            listener = parse_listener(cmd, cwd, exe)
            report['listener'] = listener | {'cwd': str(cwd), 'exe': str(exe)}
            status = bounded_read(root / 'status', 65536).decode()
            for line in status.splitlines():
                key, _, value = line.partition(':')
                if key in ('Uid', 'Gid', 'Groups'):
                    require(all(x.isdecimal() for x in value.split()), 'PROC_CREDENTIALS_INVALID')
                    report['listener'][key] = [int(x) for x in value.split()]
            profile = safe_path(listener['profile']).resolve(strict=True)
            file_at('runner', listener['runner'])
            config_before = metadata(listener['config'])
            config_bytes = bounded_read(listener['config'])
            config_after = metadata(listener['config'])
            require(config_before == config_after, 'CONFIG_CHANGED')
            report['files']['config'] = config_after | {'sha256': hashlib.sha256(config_bytes).hexdigest()}
            config_raw = json.loads(config_bytes)
            require(isinstance(config_raw, dict), 'JSON_NOT_OBJECT')
            for name in ('package.json', 'pnpm-lock.yaml', '.npmrc', 'pnpm-workspace.yaml'):
                file_at('profile/' + name, profile / name)
            manager = read_json(profile / 'package.json').get('packageManager')
            require(manager is None or isinstance(manager, str) and
                    bool(re.fullmatch(r'(?:pnpm|npm|yarn)@[0-9][0-9A-Za-z.+_-]{0,180}', manager)), 'PACKAGE_MANAGER_INVALID')
            report['installedOnDisk'] = {'loadedRuntimeVerified': False, 'profile': str(profile),
                                         'packageManager': manager, 'packages': []}
            for name in PKW_NAMES + list(PEER_NAMES):
                item = attempt('package/' + name, lambda name=name: package_info(profile, name))
                if item:
                    report['installedOnDisk']['packages'].append(item)
            config = config_safe(config_raw)
            report['configuration'] = config
            data = Path(config['canonicalDataPath'])
            report['data'] = {'root': metadata(data)}
            report['data'].update({name: attempt('data/' + name, lambda name=name: metadata(data / name))
                              for name in ('identity.sqlite', 'spaces', 'gateway.lock', 'recovery-pending.json')})
            if os.path.lexists(data / 'gateway.lock'):
                lock = read_json(data / 'gateway.lock', 8192)
                require(isinstance(lock.get('pid'), int) and not isinstance(lock['pid'], bool) and lock['pid'] > 0,
                        'LOCK_PID_INVALID')
                created = lock.get('createdAt')
                require(created is None or isinstance(created, str) and bool(re.fullmatch(r'[0-9TZ:+.\-]{1,50}', created)),
                        'LOCK_TIMESTAMP_INVALID')
                report['data']['lockRecord'] = {'pid': lock['pid'], 'createdAt': created,
                                              'matchesObservedMainPID': lock['pid'] == unit['MainPID']}
            report['sizes'] = {}
            for name, path in (('profile', profile), ('dataRoot', data)):
                size = attempt('size/' + name, lambda path=path: du_reader(path))
                valid = isinstance(size, dict) and size.get('known') is True and type(size.get('bytes')) is int and size['bytes'] >= 0
                report['sizes'][name] = {'known': True, 'bytes': size['bytes']} if valid else {'known': False}
                if not valid:
                    report['issues'].append({'at': 'size/' + name, 'code': 'SIZE_UNKNOWN'})
            report['filesystems'] = []
            for path in dict.fromkeys(('/', '/LlHmm9527', str(data))):
                def fs_info(path=path):
                    s = os.statvfs(path)
                    return {'path': path, 'totalBytes': s.f_blocks * s.f_frsize,
                            'availableBytes': s.f_bavail * s.f_frsize, 'availableInodes': s.f_favail}
                report['filesystems'].append(attempt('filesystem', fs_info))
        attempt('listener', inspect_listener)
    changed, recheck_known = False, len(baseline) == len(UNITS)
    for name in UNITS:
        after = attempt(name + '/recheck', lambda name=name: unit_safe(unit_reader(name), name))
        before = report['units'].get(name)
        recheck_known = recheck_known and before is not None and after is not None
        if before and after and any(before.get(k) != after.get(k) for k in
                                    ('MainPID', 'ControlPID', 'NRestarts', 'ActiveState', 'SubState')):
            changed = True
        if name in baseline:
            final = attempt(name + '/process-recheck', lambda name=name: proc_snapshot(proc_root, baseline[name]['pid']))
            recheck_known = recheck_known and final is not None
            if final and final[0] != baseline[name]:
                changed = True
    report['stability'] = {'attempted': True, 'checked': recheck_known, 'known': recheck_known,
                           'changed': changed if recheck_known else None, 'scope': 'observed unit PIDs and process identities only'}
    report['status'] = 'INVENTORY_CHANGED' if changed else 'INVENTORY_INCOMPLETE' if report['issues'] else 'INVENTORY_COLLECTED'
    return report


if __name__ == '__main__':
    if len(sys.argv) != 1 or sys.platform != 'linux' or os.geteuid() != 0:
        print(json.dumps({'status': 'INVENTORY_REFUSED', 'code': 'LINUX_ROOT_NO_ARGUMENTS_REQUIRED', 'servicesChanged': False}))
        sys.exit(2)
    result = collect()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result['status'] == 'INVENTORY_COLLECTED' else 1)

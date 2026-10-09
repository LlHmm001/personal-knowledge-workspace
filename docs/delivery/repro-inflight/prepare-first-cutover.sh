#!/usr/bin/env bash
# Prepare code and a unit draft only; no service action, database, or credentials.
set -euo pipefail
umask 077
pkw_sha=${1:-}
[[ "$pkw_sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'Expected full reviewed commit SHA.\n' >&2; exit 2; }
[[ $(id -u) == 0 && $(uname -s) == Linux ]] || { printf 'Run in the Linux server root terminal.\n' >&2; exit 2; }
for pkw_tool in git python3; do command -v "$pkw_tool" >/dev/null; done
test -x /usr/local/bin/node
test -d /LlHmm9527

# Match the returned inventory before allocating a candidate, and again afterwards.
pkw_baseline() {
python3 -I -S -B - <<'PY'
import hashlib, json, os, stat, subprocess, sys
from pathlib import Path
files = {
'/etc/systemd/system/pkw-collaboration.service': '4fdf72f6c4e12e27d736d0331fcdd9dcecbc86e58f158e74f9ab7b6bb270f6a1',
'/LlHmm9527/pkw-delivery-v3/repo/scripts/serve-collaboration.mjs': '33eb260743563c4b83bdcd55d15be936f1ee0bfe484c6f8fe268bc4c9cb1617e',
'/root/pkw-upgrade-2026-10-02/config/collaboration.production.json': '26fedc373da3637817af19acfbd623068f5d1bbfb3b0ab401140828045807266',
'/root/.dsh/profiles/web/package.json': '17f61fd4c022707e5df627218404374140cd0a5233367e3ff99826abe4cdcbe1',
'/root/.dsh/profiles/web/pnpm-lock.yaml': '6aa251a9febc4b5958e032f73d998d9ddaf651b299a26d606ee8bd03e10d67e8',
'/root/.dsh/profiles/web/.npmrc': 'e49d41a709b28b110d9d4810659f2f24a10f2f7556fa01726482a1b489c21759',
'/root/.dsh/profiles/web/pnpm-workspace.yaml': '148f239d32bc5db64a8e96864a5289fe6a9267e164a53fbe10b977b211f0df0c',
}
units = {
'pkw-collaboration.service': (1608174, '851263033', 'db2b538bbf1d1c9a79edb93cb52f9699317433d1abce0fd645de8de7001f07aa'),
'deepseek-harness.service': (1585972, '851055080', '1242c76bf0cebfd964a79b3769677be7957fadd6896cac88f7704987c75d3d3d'),
}
try:
    if Path('/proc/sys/kernel/random/boot_id').read_text().strip() != 'd80e20a0-b2e2-49f5-9c6c-611d49d50fe8':
        raise ValueError('BOOT_CHANGED')
    for name, expected in files.items():
        p = Path(name)
        s = p.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_size > 2097152 or p.resolve(strict=True) != p:
            raise ValueError('BASELINE_FILE_TYPE_CHANGED')
        if hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise ValueError('BASELINE_FILE_HASH_CHANGED')
    fields = ['Id', 'MainPID', 'ControlPID', 'NRestarts', 'ActiveState', 'SubState', 'DropInPaths']
    observed = {}
    for name, (pid, ticks, cmdhash) in units.items():
        args = ['/usr/bin/systemctl', 'show', name, '--no-pager']
        for key in fields: args.extend(['--property', key])
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=5, check=False, env={'PATH':'/usr/bin:/bin', 'LC_ALL':'C'})
        if r.returncode != 0: raise ValueError('UNIT_UNOBSERVABLE')
        values = {}
        for line in r.stdout.decode().splitlines():
            key, sep, value = line.partition('=')
            if not sep or key not in fields or key in values: raise ValueError('UNIT_INVALID')
            values[key] = value
        if (values.get('Id') != name or values.get('MainPID') != str(pid) or
            values.get('ControlPID') != '0' or values.get('NRestarts') != '0' or
            values.get('ActiveState') != 'active' or values.get('SubState') != 'running'):
            raise ValueError('LIVE_SERVICE_CHANGED')
        if name == 'pkw-collaboration.service' and values.get('DropInPaths') != '':
            raise ValueError('PKW_DROPIN_CHANGED')
        proc = Path('/proc') / str(pid)
        raw = (proc / 'stat').read_text()
        if raw[raw.rfind(')') + 2:].split()[19] != ticks:
            raise ValueError('PROCESS_IDENTITY_CHANGED')
        if hashlib.sha256((proc / 'cmdline').read_bytes()).hexdigest() != cmdhash:
            raise ValueError('PROCESS_ENTRY_CHANGED')
        observed[name] = {'pid':pid, 'NRestarts':0, 'state':'active/running'}
    print(json.dumps({'status':'LIVE_BASELINE_UNCHANGED', 'services':observed, 'servicesChanged':False}))
except Exception as error:
    code = str(error) if type(error) is ValueError else type(error).__name__
    print(json.dumps({'status':'PREPARATION_BASELINE_STOP', 'code':code, 'servicesChanged':False}))
    sys.exit(1)
PY
}

pkw_baseline
pkw_work=$(mktemp -d /LlHmm9527/pkw-first-stage-XXXXXX)
printf '独立候选准备目录：%s\n' "$pkw_work"
trap 'pkw_rc=$?; printf "本轮退出码=%s；保留 %s，不会执行切换\n" "$pkw_rc" "$pkw_work"' EXIT

git init -q "$pkw_work/repo"
git -C "$pkw_work/repo" remote add origin https://github.com/LlHmm001/personal-knowledge-workspace.git
git -C "$pkw_work/repo" fetch --quiet --depth=1 origin "$pkw_sha"
test "$(git -C "$pkw_work/repo" rev-parse FETCH_HEAD)" = "$pkw_sha"
git -C "$pkw_work/repo" checkout --quiet --detach FETCH_HEAD
printf '准备工具源码 SHA：%s\n' "$pkw_sha"
set +e
env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS \
  /usr/local/bin/node "$pkw_work/repo/deploy/prepare-first-cutover.mjs" \
  --work-dir "$pkw_work/runtime" \
  --matrix-root /LlHmm9527/pkw-codex-rehearsal-SC6951/run \
  --artifact-dir /LlHmm9527/.pkw-deployments/0.1.9-pkw.1/packages \
  --version 0.1.9-pkw.1
pkw_prepare_rc=$?
pkw_baseline
pkw_baseline_rc=$?
set -e
if [[ "$pkw_baseline_rc" != 0 ]]; then exit "$pkw_baseline_rc"; fi
exit "$pkw_prepare_rc"

#!/usr/bin/env bash
# Installation-only verification in a fresh directory; not a full rehearsal.
# Uses a private, integrity-checked pnpm. No system pnpm/config or service changes.
set -euo pipefail
umask 077
pkw_sha=${1:-}
[[ "$pkw_sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'Expected complete source SHA.\n' >&2; exit 2; }
test -x /usr/local/bin/node
test -d /LlHmm9527/pkw-codex-rehearsal-YNdx2n/run
pkw_work=$(mktemp -d /LlHmm9527/pkw-pnpm-fixed-XXXXXX)
printf '独立 pnpm 安装验证目录：%s\n' "$pkw_work"
trap 'pkw_rc=$?; printf "安装验证退出码=%s；请保留 %s\n" "$pkw_rc" "$pkw_work"; systemctl show deepseek-harness.service pkw-collaboration.service -p Id -p ActiveState -p SubState -p MainPID -p NRestarts || true' EXIT

curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 120 \
  'https://registry.npmjs.org/pnpm/-/pnpm-11.23.0.tgz' -o "$pkw_work/pnpm-11.23.0.tgz"
python3 -B - "$pkw_work/pnpm-11.23.0.tgz" "$pkw_work/tool" <<'PY'
import base64, hashlib, hmac, json, os, shutil, sys, tarfile
from pathlib import Path

archive, target = map(Path, sys.argv[1:])
expected = '8ACC5bKDoZm3Tgedoo0VXACP4jL0TIoG6n3foBTs9xn8Ni95DsxnsoEG3awq+yTEmpoHkVnaVgss59Hpjv0Rrw=='
digest = hashlib.sha512()
with archive.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
if not hmac.compare_digest(base64.b64encode(digest.digest()).decode('ascii'), expected):
    raise SystemExit('PNPM_ARCHIVE_INTEGRITY_MISMATCH')

# Validate every member before creating the extraction directory. No links,
# devices, traversal, duplicate destinations, or file/directory collisions.
with tarfile.open(archive, 'r:gz') as bundle:
    members = bundle.getmembers()
    seen, total = {}, 0
    for member in members:
        name = member.name[:-1] if member.name.endswith('/') else member.name
        parts = name.split('/')
        if (not parts or parts[0] != 'package' or
                any(part in ('', '.', '..') for part in parts) or
                '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)):
            raise SystemExit('PNPM_ARCHIVE_PATH_REJECTED')
        if not (member.isfile() or member.isdir()):
            raise SystemExit('PNPM_ARCHIVE_TYPE_REJECTED')
        if name in seen or (len(parts) == 1 and not member.isdir()):
            raise SystemExit('PNPM_ARCHIVE_DUPLICATE_OR_ROOT_REJECTED')
        if member.size < 0 or member.size > 128 * 1024 * 1024:
            raise SystemExit('PNPM_ARCHIVE_MEMBER_TOO_LARGE')
        total += member.size
        if total > 512 * 1024 * 1024 or len(members) > 10000:
            raise SystemExit('PNPM_ARCHIVE_TOO_LARGE')
        seen[name] = member
    for name in seen:
        parts = name.split('/')
        for end in range(1, len(parts)):
            ancestor = seen.get('/'.join(parts[:end]))
            if ancestor is not None and not ancestor.isdir():
                raise SystemExit('PNPM_ARCHIVE_FILE_PARENT_REJECTED')
    entry = seen.get('package/bin/pnpm.mjs')
    if entry is None or not entry.isfile():
        raise SystemExit('PNPM_ARCHIVE_ENTRY_MISSING')

    os.mkdir(target, 0o700)  # Exclusive: never reuse or overwrite an earlier tool.
    for name, member in seen.items():
        destination = target.joinpath(*name.split('/'))
        if member.isdir():
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        source = bundle.extractfile(member)
        if source is None:
            raise SystemExit('PNPM_ARCHIVE_FILE_UNREADABLE')
        with source, destination.open('xb') as output:
            shutil.copyfileobj(source, output)
        if destination.stat().st_size != member.size:
            raise SystemExit('PNPM_ARCHIVE_FILE_SIZE_MISMATCH')
        destination.chmod(0o700 if member.mode & 0o111 else 0o600)
    # The validated launcher is the only executable used below.
    target.joinpath('package/bin/pnpm.mjs').chmod(0o700)
print(json.dumps({'status': 'PNPM_ARCHIVE_VERIFIED', 'version': '11.23.0',
                  'files': sum(m.isfile() for m in members), 'unpackedBytes': total}))
PY

git init -q "$pkw_work/repo"
git -C "$pkw_work/repo" remote add origin https://github.com/LlHmm001/personal-knowledge-workspace.git
git -C "$pkw_work/repo" fetch --quiet --depth=1 origin "$pkw_sha"
test "$(git -C "$pkw_work/repo" rev-parse FETCH_HEAD)" = "$pkw_sha"
git -C "$pkw_work/repo" checkout --quiet --detach FETCH_HEAD
env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS \
  /usr/local/bin/node "$pkw_work/repo/deploy/diagnose-pnpm-exit.mjs" \
  --work-dir "$pkw_work/run" \
  --scene-dir /LlHmm9527/pkw-codex-rehearsal-YNdx2n/run \
  --old-artifact-dir /LlHmm9527/.pkw-deployments/0.1.7-pkw.1/packages \
  --artifact-dir /LlHmm9527/.pkw-deployments/0.1.9-pkw.1/packages \
  --old-version 0.1.7-pkw.1 --version 0.1.9-pkw.1 \
  --pnpm-bin "$pkw_work/tool/package/bin/pnpm.mjs" --pnpm-version 11.23.0

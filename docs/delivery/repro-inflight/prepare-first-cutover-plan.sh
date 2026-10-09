#!/usr/bin/env bash
# Prepare a reviewable first-cutover plan and read existing account content only.
# The Node orchestrator owns bounded live checks. This wrapper performs no service action.
set -euo pipefail
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin
pkw_sha=${1:-}
if [[ $# != 1 || ! "$pkw_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Expected one complete reviewed source commit SHA.\n' >&2
  exit 2
fi
if [[ $(id -u) != 0 || $(uname -s) != Linux ]]; then
  printf 'Run in the Linux server root terminal.\n' >&2
  exit 2
fi
for pkw_tool in curl python3 mktemp; do command -v "$pkw_tool" >/dev/null; done
test -x /usr/local/bin/node
test -d /LlHmm9527

# Do not let inherited loader/preload configuration run during even the version check.
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH
unset PYTHONPATH PYTHONHOME
/usr/local/bin/node --input-type=module -e '
if (process.version !== "v22.23.1" || process.execPath !== "/root/.hermes/node/bin/node" || process.platform !== "linux" || process.arch !== "x64") {
  console.error(JSON.stringify({status:"FIRST_CUTOVER_PREPARE_BOOTSTRAP_STOP",code:"NODE_RUNTIME_CHANGED"}));
  process.exitCode = 2;
}
'

# A heredoc on stdin is fine, but an actual SSH/root controlling terminal is required.
python3 -I -S -B - <<'TTY'
import os
try:
    fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
    try:
        if not os.isatty(fd):
            raise RuntimeError('not a terminal')
    finally:
        os.close(fd)
except Exception:
    raise SystemExit('FIRST_CUTOVER_TTY_REQUIRED')
TTY

pkw_work=$(mktemp -d /LlHmm9527/pkw-first-cutover-XXXXXX)
printf '首次切换预检目录：%s\n' "$pkw_work"
trap 'pkw_rc=$?; printf "本轮退出码=%s；请保留 %s\n" "$pkw_rc" "$pkw_work"' EXIT

curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 120 \
  --proto '=https' --proto-redir '=https' --max-filesize 33554432 \
  "https://codeload.github.com/LlHmm001/personal-knowledge-workspace/tar.gz/$pkw_sha" \
  -o "$pkw_work/source.tar.gz"

python3 -I -S -B - "$pkw_work/source.tar.gz" "$pkw_work/repo" "$pkw_sha" <<'PY'
import json, os, shutil, sys, tarfile
from pathlib import Path

archive, target = map(Path, sys.argv[1:3])
sha = sys.argv[3]
prefix = 'personal-knowledge-workspace-' + sha
if archive.stat().st_size > 33554432:
    raise SystemExit('SOURCE_ARCHIVE_TOO_LARGE')
with tarfile.open(archive, 'r:gz') as bundle:
    members = bundle.getmembers()
    seen, total = {}, 0
    if len(members) > 10000:
        raise SystemExit('SOURCE_ARCHIVE_TOO_MANY_ENTRIES')
    for member in members:
        name = member.name[:-1] if member.name.endswith('/') else member.name
        parts = name.split('/')
        if (not parts or parts[0] != prefix or any(part in ('', '.', '..') for part in parts)
                or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)):
            raise SystemExit('SOURCE_ARCHIVE_PATH_REJECTED')
        if not (member.isfile() or member.isdir()):
            raise SystemExit('SOURCE_ARCHIVE_TYPE_REJECTED')
        if name in seen or (len(parts) == 1 and not member.isdir()):
            raise SystemExit('SOURCE_ARCHIVE_DUPLICATE_OR_ROOT_REJECTED')
        if member.size < 0 or member.size > 16777216:
            raise SystemExit('SOURCE_ARCHIVE_MEMBER_TOO_LARGE')
        total += member.size
        if total > 67108864:
            raise SystemExit('SOURCE_ARCHIVE_TOO_LARGE')
        seen[name] = member
    for name in seen:
        parts = name.split('/')
        for end in range(1, len(parts)):
            parent = seen.get('/'.join(parts[:end]))
            if parent is not None and not parent.isdir():
                raise SystemExit('SOURCE_ARCHIVE_FILE_PARENT_REJECTED')
    entry = seen.get(prefix + '/deploy/first-cutover.mjs')
    if entry is None or not entry.isfile():
        raise SystemExit('SOURCE_ARCHIVE_ENTRY_MISSING')
    os.mkdir(target, 0o700)
    for name, member in seen.items():
        parts = name.split('/')[1:]
        if not parts:
            continue
        destination = target.joinpath(*parts)
        if member.isdir():
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        source = bundle.extractfile(member)
        if source is None:
            raise SystemExit('SOURCE_ARCHIVE_FILE_UNREADABLE')
        with source, destination.open('xb') as output:
            shutil.copyfileobj(source, output)
        if destination.stat().st_size != member.size:
            raise SystemExit('SOURCE_ARCHIVE_FILE_SIZE_MISMATCH')
        destination.chmod(0o700 if member.mode & 0o111 else 0o600)
print(json.dumps({'status':'FIRST_CUTOVER_SOURCE_READY', 'sourceSha':sha,
                  'files':sum(member.isfile() for member in members), 'bytes':total}))
PY

printf '首次切换预检源码 SHA：%s\n' "$pkw_sha"
printf '仅预检与现有账号读取，不停服；账号密码只保存在本机私有目录。\n'
printf '请输入你平时登录 PKW 网页的现有账号；不会创建账号、重置密码或使用默认 bootstrap 口令。\n'
python3 -I -S -B - "$pkw_work/credentials.json" <<'CREDENTIALS'
import getpass, json, os, re, stat, sys, warnings
from pathlib import Path

path = Path(sys.argv[1])
try:
    parent = path.parent
    info = parent.lstat()
    if (parent.resolve(strict=True) != parent or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise ValueError('private directory changed')
    with open('/dev/tty', 'r', encoding='utf-8') as terminal_input, \
            open('/dev/tty', 'w', encoding='utf-8', buffering=1) as terminal:
        if not terminal_input.isatty() or not terminal.isatty():
            raise ValueError('controlling terminal missing')
        terminal.write('PKW 现有账号：')
        terminal.flush()
        username = terminal_input.readline()
        if not username:
            raise EOFError()
        username = username.rstrip('\r\n')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}', username):
            raise ValueError('invalid account format')
        # Never allow getpass to fall back to echoed stdin (which is this heredoc).
        warnings.simplefilter('error', getpass.GetPassWarning)
        password = getpass.getpass('PKW 现有密码（输入不显示）：', stream=terminal)
    if not password or len(password) > 8192:
        raise ValueError('empty or overlong password')
    encoded = (json.dumps({'username':username, 'password':password}, ensure_ascii=False) + '\n').encode('utf-8')
    if len(encoded) > 16384:
        raise ValueError('credentials exceed bounded size')
    # Exclusive creation: an existing file/link is never overwritten or reused.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        os.fchmod(output.fileno(), 0o600)
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    del password, encoded
    print(json.dumps({'status':'PRIVATE_EXISTING_CREDENTIALS_READY', 'mode':'0600'}))
except KeyboardInterrupt:
    raise SystemExit('FIRST_CUTOVER_CREDENTIAL_INPUT_CANCELLED')
except Exception:
    # Exception strings may include typed values; never echo them to the report.
    raise SystemExit('FIRST_CUTOVER_CREDENTIAL_INPUT_STOP')
CREDENTIALS

# There is deliberately no outer timeout: the Node command owns bounded preflight.
set +e
PKW_FIRST_CUTOVER_SOURCE_SHA="$pkw_sha" /usr/local/bin/node \
  "$pkw_work/repo/deploy/first-cutover.mjs" prepare \
  --work-dir "$pkw_work/plan" --credentials-file "$pkw_work/credentials.json"
pkw_rc=$?
set -e
exit "$pkw_rc"

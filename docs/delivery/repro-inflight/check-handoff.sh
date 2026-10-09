#!/usr/bin/env bash
# Usage: bash check-handoff.sh NEW_EVIDENCE_DIR ORIGINAL_REPO [NODE_BIN]
# Private evidence and local tests only. No installation, deployment, cleanup or real-profile race.
set -euo pipefail
umask 077
if [[ $# -lt 2 || $# -gt 3 ]]; then echo 'Usage: bash check-handoff.sh NEW_EVIDENCE_DIR ORIGINAL_REPO [NODE_BIN]' >&2; exit 2; fi
if [[ $1 != /* || $2 != /* ]]; then echo 'Evidence and original repository paths must be absolute.' >&2; exit 2; fi
handoff_evidence=$1
handoff_original=$2
handoff_node=${3:-node}
handoff_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS PKW_TEST_GATE_FILE PKW_TEST_ENTRY_FILE PKW_TEST_LISTENER_EXIT PKW_TEST_PROFILE PKW_TEST_DATA_ROOT
export NODE_DISABLE_COMPILE_CACHE=1
python3 - "$handoff_evidence" "$handoff_original" "$handoff_repo" <<'PY'
import hashlib, json, os, pathlib, re, stat, subprocess, sys
evidence, original, repo = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:])
requested = pathlib.Path(sys.argv[1]).absolute()
if os.path.lexists(requested): raise SystemExit('Evidence path already exists; nothing changed.')
if not original.is_dir(): raise SystemExit('Original repository directory is missing.')
if any(os.path.commonpath([str(evidence), str(p)]) == str(p) for p in (original, repo)):
    raise SystemExit('Evidence must be outside both repositories.')
os.mkdir(evidence, 0o700)
os.mkdir(evidence / 'tmp', 0o700)
def save(name, data, **meta):
    if isinstance(data, str): data = data.encode()
    with open(evidence / name, 'xb') as out: out.write(data)
    os.chmod(evidence / name, 0o600)
    print(json.dumps(dict(file=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest(), **meta)), flush=True)
def capture(name, command, emit=None):
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20, check=False)
        save(name, result.stdout, exitCode=result.returncode)
        if result.returncode == 0 and emit:
            text = result.stdout.decode(errors='replace')
            if emit == 'head' and re.fullmatch(r'[0-9a-f]{40,64}\n?', text): print(json.dumps({name: text.strip()}), flush=True)
            elif emit == 'disk': print(json.dumps({'disk': text.splitlines()}), flush=True)
            elif emit == 'services':
                allowed = {'Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'Result', 'ExecMainStatus', 'NRestarts'}
                print(json.dumps({'services': [line for line in text.splitlines() if line.partition('=')[0] in allowed]}), flush=True)
    except subprocess.TimeoutExpired as error: save(name, error.stdout or b'', status='timeout')
    except OSError as error: save(name, json.dumps({'errno': error.errno}), status='unavailable')
def git(where, *args): return ['git', '--no-optional-locks', '-C', str(where), '-c', 'core.fsmonitor=false', *args]
capture('original-head.txt', git(original, 'rev-parse', 'HEAD'), 'head')
capture('original-status.txt', git(original, 'status', '--short', '--untracked-files=normal'))
capture('original-diff-stat.txt', git(original, 'diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD'))
capture('serve.binary.patch', git(original, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', 'scripts/serve-collaboration.mjs'))
capture('new-head.txt', git(repo, 'rev-parse', 'HEAD'), 'head')
capture('new-status.txt', git(repo, 'status', '--short', '--untracked-files=normal'))
hashes = []
for label, path in [('original-serve', original / 'scripts/serve-collaboration.mjs'), ('new-serve', repo / 'scripts/serve-collaboration.mjs'), ('startup-module', repo / 'scripts/listener-startup.mjs'), ('race-runner', repo / 'docs/delivery/repro-inflight/lock-race.mjs')]:
    try:
        data = path.read_bytes(); hashes.append(dict(file=label, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
    except OSError as error: hashes.append(dict(file=label, errno=error.errno))
save('source-hashes.json', json.dumps(hashes, indent=2) + '\n')
print(json.dumps({'sourceHashes': hashes}), flush=True)
capture('disk-space.txt', ['df', '-hT' if sys.platform.startswith('linux') else '-h', '/', str(original), str(evidence)], 'disk')
if sys.platform.startswith('linux'):
    fields = 'Id,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus,NRestarts'
    capture('services.txt', ['systemctl', 'show', 'deepseek-harness.service', 'pkw-collaboration.service', '--property=' + fields], 'services')
    names = {'lock-race.mjs', 'rehearse-release.mjs', 'serve-collaboration.mjs', 'pkw-shutdown.test.mjs', 'inflight-signal.test.mjs', 'target-systemd.test.mjs', 'e2e-switch.test.mjs'}
    rows, unreadable = [], 0
    for directory in pathlib.Path('/proc').iterdir():
        if not directory.name.isdigit(): continue
        try:
            before = (directory / 'stat').read_text(); state = before[before.rfind(')') + 2:].split()
            argv = (directory / 'cmdline').read_bytes().decode(errors='replace').split('\0')
            scripts = [a for a in argv if pathlib.PurePosixPath(a).name in names]
            if not scripts: continue
            paths = {}
            for i, arg in enumerate(argv):
                for flag in ('--config', '--profile'):
                    if arg == flag and i + 1 < len(argv): paths[flag[2:]] = argv[i + 1]
                    elif arg.startswith(flag + '='): paths[flag[2:]] = arg[len(flag) + 1:]
            after = (directory / 'stat').read_text(); current = after[after.rfind(')') + 2:].split()
            if state[19] == current[19]: rows.append(dict(pid=int(directory.name), ppid=int(state[1]), startTicks=state[19], scripts=scripts, paths=paths))
        except FileNotFoundError: pass
        except (OSError, ValueError, IndexError): unreadable += 1
    inventory = dict(processes=rows, unreadable=unreadable, inventoryOnly=True, authorizedToStop=False)
    save('process-inventory.json', json.dumps(inventory, indent=2) + '\n')
    print(json.dumps(inventory), flush=True)
else: save('linux-metadata.json', json.dumps(dict(status='skipped', platform=sys.platform, reason='Linux service and proc metadata unavailable')) + '\n', status='skipped', platform=sys.platform)
for name in ('RACE-clean.log', 'FINAL-cx-positive.log', 'FINAL-cx-breakwrite.log', 'FINAL-cx-mode.log'):
    try:
        fd = os.open('/tmp/' + name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode): raise OSError('Not a regular log file')
            source.seek(max(0, info.st_size - 65536)); data = source.read(65536)
        text = data.decode(errors='replace')
        codes = sorted(set(re.findall(r'\b(?:ERR_|PKW_)[A-Z0-9_]+\b', text)))[:20]
        race = re.findall(r'one writer and one refusal with code [0-9]+: [0-9]+/[0-9]+ rounds', text) if name == 'RACE-clean.log' else []
        save(name + '.tail', data, status='copied', sourceBytes=info.st_size, errorCodes=codes, **({'raceSummary': race[-1]} if race else {}))
    except OSError as error: print(json.dumps(dict(file=name, status='not-copied', errno=error.errno)), flush=True)
PY
handoff_evidence=$(cd -- "$handoff_evidence" && pwd -P)
export TMPDIR="$handoff_evidence/tmp"
cd -- "$handoff_repo"
if "$handoff_node" --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; console.log('node:sqlite available')" > "$handoff_evidence/sqlite-check.log" 2>&1; then handoff_rc=0; else handoff_rc=$?; fi
printf '%s\n' "$handoff_rc" > "$handoff_evidence/sqlite-check.exit-code"
printf 'node:sqlite exit=%s\n' "$handoff_rc"
if [[ $handoff_rc -ne 0 ]]; then exit "$handoff_rc"; fi
if "$handoff_node" --test-reporter=tap --test scripts/tests/listener-startup.test.mjs scripts/tests/lock-race-runner.test.mjs > "$handoff_evidence/tests.log" 2>&1; then handoff_rc=0; else handoff_rc=$?; fi
printf '%s\n' "$handoff_rc" > "$handoff_evidence/tests.exit-code"
python3 - "$handoff_evidence/tests.log" <<'PY' || printf 'Test summary unavailable; see private tests.log\n'
import re, sys
with open(sys.argv[1], 'rb') as source:
    source.seek(0, 2); source.seek(max(0, source.tell() - 8192)); text = source.read(8192).decode(errors='replace')
lines = [line for line in text.splitlines() if re.fullmatch(r'# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [0-9]+(?:\.[0-9]+)?', line)]
print('\n'.join(lines[-8:]) if lines else 'Test summary unavailable; see private tests.log')
PY
printf 'Local tests exit=%s; private evidence: %s\n' "$handoff_rc" "$handoff_evidence"
exit "$handoff_rc"

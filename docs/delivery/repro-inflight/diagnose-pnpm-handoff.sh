#!/usr/bin/env bash
# Installation-only probe, in a fresh directory. No application data or service start.
set -euo pipefail
umask 077
pkw_sha=${1:-}
[[ "$pkw_sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'Expected complete source SHA.\n' >&2; exit 2; }
test -x /usr/local/bin/node
test -x /usr/local/bin/pnpm
test -d /LlHmm9527/pkw-codex-rehearsal-YNdx2n/run
pkw_work=$(mktemp -d /LlHmm9527/pkw-pnpm-exit-XXXXXX)
printf '安装退出诊断目录：%s\n' "$pkw_work"
trap 'pkw_rc=$?; printf "诊断退出码=%s；请保留 %s\n" "$pkw_rc" "$pkw_work"; systemctl show deepseek-harness.service pkw-collaboration.service -p Id -p ActiveState -p SubState -p MainPID -p NRestarts || true' EXIT
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
  --pnpm-bin /usr/local/bin/pnpm

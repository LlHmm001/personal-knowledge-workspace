#!/usr/bin/env bash
# The caller supplies the reviewed immutable commit; all work stays in a fresh data-disk directory.
set -euo pipefail
umask 077
pkw_sha=${1:-}
if [[ ! "$pkw_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Expected the complete reviewed commit SHA.\n' >&2
  exit 2
fi
if [[ $(id -u) != 0 ]]; then
  printf 'Run in the server root terminal.\n' >&2
  exit 2
fi
for pkw_tool in git npm pnpm; do command -v "$pkw_tool" >/dev/null; done
test -x /usr/local/bin/node
test -d /LlHmm9527
pkw_work=$(mktemp -d /LlHmm9527/pkw-codex-rehearsal-XXXXXX)
printf '串行演练目录：%s\n' "$pkw_work"
trap 'pkw_rc=$?; printf "本轮退出码=%s；请保留 %s\n" "$pkw_rc" "$pkw_work"; systemctl show deepseek-harness.service pkw-collaboration.service -p Id -p ActiveState -p SubState -p MainPID -p NRestarts || true' EXIT
git init -q "$pkw_work/repo"
git -C "$pkw_work/repo" remote add origin https://github.com/LlHmm001/personal-knowledge-workspace.git
git -C "$pkw_work/repo" fetch --quiet --depth=1 origin "$pkw_sha"
test "$(git -C "$pkw_work/repo" rev-parse FETCH_HEAD)" = "$pkw_sha"
git -C "$pkw_work/repo" checkout --quiet --detach FETCH_HEAD
printf '源码 SHA：%s\n' "$pkw_sha"
env -u NODE_OPTIONS -u NODE_PATH -u NODE_EXTRA_CA_CERTS \
  /usr/local/bin/node "$pkw_work/repo/deploy/rehearse-matrix.mjs" \
  --work-dir "$pkw_work/run" \
  --profile-source /LlHmm9527/pkw-independent/profile \
  --data-source /LlHmm9527/pkw-independent/fixtures/lifecycle-1 \
  --old-artifact-dir /LlHmm9527/.pkw-deployments/0.1.7-pkw.1/packages \
  --artifact-dir /LlHmm9527/.pkw-deployments/0.1.9-pkw.1/packages \
  --old-version 0.1.7-pkw.1 --version 0.1.9-pkw.1 \
  --store-source /LlHmm9527/pkw-independent/store/v11

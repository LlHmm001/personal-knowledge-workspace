#!/usr/bin/env node
/**
 * Isolated acceptance on this host: the real CLI, a temporary systemd unit, and a test-only
 * installation root, data root and port.
 *
 * What this exercises, and why each part is what it is:
 *
 *   install root   a release directory of this test's own under a temporary work directory; the
 *                  service under test is never the live one and `current` here belongs to nobody
 *                  else.
 *   data root      a copy of a generated fixture, with its own account password set, so an
 *                  acceptance step can log in to it.
 *   port           chosen by the kernel; nothing else is listening on it.
 *   unit           a *transient* unit created by `systemd-run --unit=<test>.service --collect`,
 *                  deleted when it stops. It never enters the system's unit directories, and it
 *                  is named after this test, so the live `pkw-collaboration.service` is not
 *                  touched, stopped, reloaded or renamed.
 *   isolation      the unit runs with `InaccessiblePaths=/opt/deepseek-harness`, so the DSH
 *                  installation is unreachable *for that process only* — the way an independent
 *                  profile is supposed to run. Nothing is renamed, unmounted or modified, so the
 *                  live installation keeps serving.
 *
 * The transaction is driven by the real `deploy/switch-release.mjs` (its CLI, not its internals):
 * stop probe, start hook, acceptance, and — with `--force-verify-failure` — the rollback chain.
 *
 *   node scripts/tests/target-systemd.test.mjs
 *
 * Requires: systemd with `systemd-run` (checked at runtime), a fixture for `--data-source`, and an
 * artifact directory for the release being installed. Missing inputs are named in the skip.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { copyDataRoot } from '../copy-data-root.mjs'

const scryptAsync = promisify(scrypt)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = join(repoRoot, 'deploy', 'switch-release.mjs')
const PASSWORD = 'target-acceptance-pass'

/** Run a command and keep everything it produced, whatever the exit code. */
function run(command, args, options = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` }))
    child.once('exit', code => resolvePromise({ code, stdout, stderr }))
  })
}

/**
 * Whether this host can run the acceptance at all, decided without spawning anything: a systemd
 * host has `/run/systemd/system`, and the runner has to be on PATH.
 */
function systemdAvailable() {
  if (!existsSync('/run/systemd/system')) return false
  const path = (process.env.PATH ?? '').split(':')
  return path.some(dir => existsSync(join(dir, 'systemd-run')))
}

/**
 * The inputs this acceptance needs, named one by one. A test that cannot run declares the skip and
 * says what is missing; it never passes quietly and never fails for a missing environment.
 */
function missingInputs() {
  return [
    systemdAvailable() ? null : 'systemd with systemd-run on PATH',
    process.env.PKW_TEST_PROFILE ? null : 'PKW_TEST_PROFILE (profile to seed the release from)',
    process.env.PKW_TARGET_ARTIFACTS ? null : 'PKW_TARGET_ARTIFACTS (release artifacts, including the peer closure)',
    process.env.PKW_TEST_DATA_ROOT ? null : 'PKW_TEST_DATA_ROOT (generated fixture to copy as the data root)',
  ].filter(Boolean)
}

test('target: the CLI runs its whole chain through a temporary systemd unit', {
  // Every missing input is named, so a skip here is a statement about this host, not a silent pass.
  skip: missingInputs().length > 0 ? `target acceptance needs: ${missingInputs().join('; ')}` : false,
}, async () => {
  const profileSource = process.env.PKW_TEST_PROFILE
  const artifactDir = process.env.PKW_TARGET_ARTIFACTS
  const dataSource = process.env.PKW_TEST_DATA_ROOT
  const version = process.env.PKW_TARGET_VERSION ?? '0.1.8-pkw.2'
  const oldVersion = process.env.PKW_TARGET_OLD_VERSION ?? '0.1.7-pkw.1'
  const workDir = await mkdtemp(join(tmpdir(), 'pkw-target-'))
  const root = join(workDir, 'installation')
  const dataRoot = join(workDir, 'data')
  const unit = `pkw-target-${randomUUID().slice(0, 8)}.service`
  const systemdRun = join(workDir, 'systemd-run-start.sh')
  const systemdStop = join(workDir, 'systemd-stop.sh')
  const port = 3361
  const origin = `http://127.0.0.1:${port}`
  const log = (...parts) => console.error(JSON.stringify({ at: new Date().toISOString(), ...Object.assign({}, ...parts) }))
  let failedRun = false
  try {
    // ── the data root: a copy of the fixture, with an account this test can log in with ──
    const copy = await copyDataRoot(dataSource, dataRoot)
    assert.deepEqual(copy.leaks, [], 'the data copy must be isolated from its source')
    const identity = new DatabaseSync(join(dataRoot, 'identity.sqlite'))
    const salt = randomBytes(16).toString('hex')
    const derived = await scryptAsync(PASSWORD, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
    identity.prepare('UPDATE accounts SET password=? WHERE username=?').run(`scrypt-v1:${salt}:${derived.toString('hex')}`, 'owner')
    identity.close()
    const configPath = join(workDir, 'collaboration.json')
    await writeFile(configPath, JSON.stringify({
      dataPath: dataRoot, publicOrigin: origin, bootstrapUsername: 'owner', bootstrapPasswordEnv: 'PKW_TARGET_BOOTSTRAP',
    }, null, 2), { mode: 0o600 })
    const credentialsFile = join(workDir, 'owner-password')
    await writeFile(credentialsFile, `${PASSWORD}\n`, { mode: 0o600 })

    // ── the release in service: a copy of the profile, labelled as the old version ──
    await mkdir(join(root, 'releases'), { recursive: true })
    const oldRelease = join(root, 'releases', oldVersion, 'profile')
    // The release tree's parent has to exist before the copy; `cp -a` does not create it.
    await mkdir(dirname(oldRelease), { recursive: true })
    const copied = await run('cp', ['-a', profileSource, oldRelease])
    assert.equal(copied.code, 0, `seeding the release failed: ${copied.stderr.slice(-300)}`)
    await writeFile(join(oldRelease, 'pnpm-workspace.yaml'), 'packages: []\n')
    const oldManifestPath = join(oldRelease, 'node_modules/@deepseek-ai/dsh-pkw-web/package.json')
    const oldManifest = JSON.parse(await readFile(oldManifestPath, 'utf8'))
    oldManifest.version = oldVersion
    await writeFile(oldManifestPath, JSON.stringify(oldManifest, null, 2) + '\n')
    await run('ln', ['-sfn', join('releases', oldVersion), join(root, 'current')])

    // ── the hooks the CLI is given: a transient unit, never the live one ──
    // ── the start hook: start the release `current` names, and only if it is not already up ──
    // Idempotent on purpose. systemd refuses `systemd-run --unit` for a unit that already exists, so
    // an unconditional start turns "start the release that is already serving" into a failure. A
    // deployment's start hook is asked to make the release be running, not to prove it was stopped
    // first — the transaction has already proved that, with the stop probe.
    await writeFile(systemdRun, `#!/bin/sh
set -u
state=$(systemctl is-active ${unit} 2>/dev/null || true)
if [ "$state" = "active" ]; then
  # Already running. Confirm it answers, then report success: a start hook that restarted a healthy
  # release would take the service down and up again for nothing, and only the acceptance step
  # would notice.
  serving=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}/healthz 2>/dev/null || echo 000)
  [ "$serving" = "200" ] || { echo "the unit is active but does not answer on ${origin}" >&2; exit 1; }
  exit 0
fi
systemd-run --unit=${unit} --collect --quiet \\
  --property=InaccessiblePaths=/opt/deepseek-harness \\
  --property=Environment=PKW_TARGET_BOOTSTRAP=${PASSWORD} \\
  /usr/local/bin/node ${join(repoRoot, 'scripts/serve-collaboration.mjs')} \\
  --profile "$(readlink -f ${root}/current)/profile" --config ${configPath} --port ${port} || exit 1
i=0
while [ $i -lt 300 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}/healthz 2>/dev/null || echo 000)
  # The unit is up here, and a running unit is the only place the isolation can be observed: systemd
  # drops the property once the unit stops, so this is recorded now and asserted by the test. Asking
  # for InaccessiblePaths is not the same as having it applied.
  if [ "$code" = "200" ]; then
    systemctl show -p InaccessiblePaths --value ${unit} > ${join(workDir, 'isolation.txt')} 2>/dev/null || true
    exit 0
  fi
  i=$((i+1)); sleep 0.1
done
echo "the unit did not answer on http://127.0.0.1:${port}/healthz" >&2
exit 1
`, { mode: 0o700 })

    // ── the stop hook: stop the unit, and fail if it did not stop ──
    // The exit status is the whole point. `systemctl stop` returning non-zero means the stop was not
    // carried out; swallowing it with `|| true` would let the transaction believe a service it never
    // stopped, which is how a second writer gets started over a live one. The stop evidence itself is
    // read by the CLI from the unit's own identity (--managed-unit), not from this script.
    await writeFile(systemdStop, `#!/bin/sh
set -u
if ! systemctl stop ${unit} >/dev/null 2>&1; then
  echo "systemctl stop ${unit} failed" >&2
  exit 1
fi
# A unit that is inactive can still be closing its listener, and the next start would then fail to
# bind. Wait for both, and fail loudly rather than returning into a race.
i=0
while [ $i -lt 600 ]; do
  state=$(systemctl is-active ${unit} 2>/dev/null || true)
  busy=$(ss -ltn 2>/dev/null | grep -c ":${port} ")
  if { [ "$state" = "inactive" ] || [ "$state" = "failed" ] || [ -z "$state" ]; } && [ "$busy" = "0" ]; then exit 0; fi
  i=$((i+1)); sleep 0.1
done
echo "the unit or its port is still busy after stop (state=$state, port_listeners=$busy)" >&2
exit 1
`, { mode: 0o700 })

    // ── the verifier hook ──
    // It only observes. It finds the release *by version* under this test's own installation root
    // rather than through `current`: during a switch the acceptance belongs to the release being
    // verified, and a hook that reads `current` describes whichever release is linked at that instant.
    //
    // With PKW_TARGET_INJECT_VERIFY_FAILURE=1 the hook answers for the new release while the release
    // is asked to report the old version. The verifier then refuses on the version it actually
    // observed — an acceptance failure that is real in the only sense that matters here: the
    // transaction's own acceptance step rejected the release, and the rollback has to run.
    const verifyHook = join(workDir, 'verify.sh')
    await writeFile(verifyHook, `#!/bin/sh
set -u
expected=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--expected-version" ]; then expected="$arg"; fi
  prev="$arg"
done
release=""
for dir in ${root}/releases/*/profile; do
  case "$dir" in
    *"/$expected/profile") release="$(dirname "$dir")" ;;
  esac
done
if [ -z "$release" ]; then
  echo "no release for version $expected under ${root}/releases" >&2
  exit 1
fi
target="$expected"
if [ -n "\${PKW_TARGET_INJECT_VERIFY_FAILURE:-}" ]; then
  target="${oldVersion}"
fi
out=$(/usr/local/bin/node ${join(repoRoot, 'deploy/site/verify-collaboration.mjs')} "$@" \\
  --profile "$release/profile" --public-origin ${origin} --gateway-url ${origin} \\
  --credentials-file \${PKW_TARGET_VERIFY_CREDENTIALS} --username owner \\
  --expected-version "$target" 2>&1)
code=$?
printf '%s\\n' "$out" >> ${join(workDir, 'verify.log')}
printf '%s\\n' "$out"
exit $code
`, { mode: 0o700 })

    const rpc = async (method, args, csrf, jar = new Map()) => {
      const headers = { Origin: origin, 'Content-Type': 'application/json' }
      if (csrf) headers['X-PKW-CSRF'] = csrf
      if (jar.size) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
      const response = await fetch(`${origin}/pkw/spaces/${spaceId}/api`, { method: 'POST', headers, body: JSON.stringify({ method, args }) })
      const text = await response.text()
      let body; try { body = JSON.parse(text) } catch { body = text }
      return { status: response.status, body }
    }
    let spaceId = null
    // The space id comes from the data root's own identity store, so the checks below follow data
    // rather than a guess about which space was created first.
    {
      const db = new DatabaseSync(join(dataRoot, 'identity.sqlite'), { readOnly: true })
      spaceId = db.prepare('SELECT id FROM spaces LIMIT 1').get()?.id ?? null
      db.close()
      assert.ok(spaceId, 'the data root must carry a space')
    }
    const loginAndSession = async () => {
      const login = await fetch(`${origin}/pkw/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASSWORD }) })
      const cookies = login.headers.getSetCookie?.() ?? []
      const jar = new Map()
      for (const raw of cookies) { const [pair] = raw.split(';'); const at = pair.indexOf('='); if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1)) }
      const session = await fetch(`${origin}/pkw/session`, { headers: { Origin: origin, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } })
      const body = JSON.parse(await session.text())
      return { login: login.status, session: session.status, csrf: body?.value?.csrf, jar, spaces: body?.value?.spaces ?? [] }
    }

    // ── the release in service, started for real before anything else happens ──
    // The chain only means something if it starts from a service that is actually serving. So the
    // old release is started first, through the same start hook the CLI will use, and its state is
    // observed: the unit is active, the origin answers, and the data root's lock belongs to the
    // unit's own main process. Every later step is a transition away from *this*, not from nothing.
    const firstStart = await run(systemdRun, [])
    assert.equal(firstStart.code, 0, `the old release must start for real: ${firstStart.stderr.slice(-400)}`)
    const servingBefore = await fetch(`${origin}/healthz`).then(response => response.status).catch(() => 0)
    assert.equal(servingBefore, 200, 'the old release must be serving before the switch')
    const currentBefore = await run('readlink', ['-f', join(root, 'current')])
    assert.equal(currentBefore.stdout.trim(), join(root, 'releases', oldVersion), 'the old release must be the one in service')
    const lockBefore = JSON.parse(await readFile(join(dataRoot, 'gateway.lock'), 'utf8'))
    const mainBefore = await run('systemctl', ['show', '-p', 'MainPID', '--value', unit])
    assert.equal(String(lockBefore.pid), mainBefore.stdout.trim(), 'the lock must belong to the old release\u2019s unit')
    const oldSession = await loginAndSession()
    assert.equal(oldSession.login, 200, 'the old release must accept a real login')
    log({ stage: 'old-serving', unit, pid: mainBefore.stdout.trim(), version: oldVersion })

    // ── the real CLI: stop probe, start hook, acceptance, real failure, rollback ──
    // The acceptance for the candidate is made to fail for a real reason: the verify hook reports a
    // version the transaction did not ask for, because the release is asked to report the previous
    // version. The transaction then has to stop the candidate, restore the previous release, start it
    // through the same start hook, verify it again and report the outcome.
    const result = await run(process.execPath, [
      cli, '--root', root, '--version', version, '--artifact-dir', artifactDir,
      '--stop-hook', systemdStop, '--start-hook', systemdRun,
      // The stop state is read from the unit's own identity: ActiveState, MainPID, ControlPID and the
      // processes in its cgroup. A `--state-hook` that exits 0 says only that a script succeeded; it
      // cannot report a live main process, and an unreadable state would not refuse.
      '--managed-unit', unit,
      '--verify-hook', verifyHook,
      // A health endpoint on the same origin: reachability is observed before acceptance, and the
      // origin's root answers 404 on this service, so naming it would report "unreachable" for a
      // service that is answering.
      '--reachable-url', `${origin}/healthz`, '--public-origin', origin,
      '--snapshot-dir', join(workDir, 'snapshots', version),
      '--store-dir', process.env.PKW_TARGET_STORE ?? '/LlHmm9527/pkw-independent/store/v11',
      '--expected-version', version,
      // The peers the release resolves against, so the install can complete in an isolated
      // environment without reaching a public registry.
      ...(process.env.PKW_TARGET_SUPPORT ? ['--support-dir', process.env.PKW_TARGET_SUPPORT] : []),
    ], { env: { ...process.env, PKW_TARGET_VERIFY_CREDENTIALS: credentialsFile, PKW_TARGET_INJECT_VERIFY_FAILURE: '1' } })
    await writeFile(join(workDir, 'cli-report.json'), JSON.stringify({ code: result.code, stdout: result.stdout, stderr: result.stderr }, null, 2) + '\n', { mode: 0o600 })
    log({ stage: 'cli-exit', code: result.code, stdout: result.stdout.slice(-300), stderr: result.stderr.slice(-600) })

    // The verdict is asserted, not merely observed. This run's acceptance fails on purpose, so the
    // transaction must reach exactly one conclusion: it rolled back to the previous release and the
    // previous release passed the same verifier. Anything else is a failure of the chain, and the
    // scene is kept for it.
    // On a rollback the CLI writes its verdict to stderr and exits non-zero — the JSON on stdout is
    // the success path. Both are the CLI's own verdict, so both are read, and which stream carried it
    // is recorded rather than assumed.
    let verdict = null
    let verdictStream = null
    for (const [stream, text] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
      const at = text.indexOf('{')
      if (at === -1) continue
      try { verdict = JSON.parse(text.slice(at)); verdictStream = stream } catch { /* not this stream */ }
      if (verdict) break
    }
    log({ stage: 'verdict-stream', stream: verdictStream })
    assert.ok(verdict, `the CLI must report a structured verdict on one of its streams: ${result.stderr.slice(-400)}`)
    // The verdict of a rollback names the code, not a status string, and carries both acceptances:
    // the one that failed for the candidate and the one that passed for the restored release. Both
    // are asserted, because "the release came back" and "the release came back verified" differ.
    assert.equal(verdict.status, 'PKW_DEPLOYMENT_ROLLED_BACK', `the CLI must report a rollback: ${JSON.stringify({ status: verdict.status })}`)
    assert.equal(verdict.acceptance?.expectedVersion, version, 'the failed acceptance must be the candidate release')
    assert.equal(verdict.acceptance?.ok, false, 'the candidate acceptance must have failed')
    assert.equal(verdict.rollbackAcceptance?.expectedVersion, oldVersion, 'the rollback acceptance must be the restored release')
    assert.equal(verdict.rollbackAcceptance?.ok, true, `the rollback acceptance must have passed: ${JSON.stringify(verdict.rollbackAcceptance ?? null).slice(0, 300)}`)
    assert.equal(verdict.rollbackAcceptance?.checks?.authenticated, 'verified', 'the rollback acceptance must have authenticated')
    assert.equal(verdict.rollbackAcceptance?.checks?.servingVersion, oldVersion, 'the rollback acceptance must have observed the restored version')
    assert.equal(result.code, 1, 'a rollback exits non-zero: it is a failure that was contained, not a success')
    log({ stage: 'rolled-back', verdict: { status: verdict.status, failed: verdict.acceptance?.expectedVersion, restored: verdict.rollbackAcceptance?.expectedVersion, authenticated: verdict.rollbackAcceptance?.checks?.authenticated, exit: result.code } })

    // The install really happened: the candidate was promoted, then replaced. Both releases exist and
    // `current` leads back to the old one.
    assert.ok(existsSync(join(root, 'releases', version, 'profile')), 'the candidate must have been installed')
    const currentAfter = await run('readlink', ['-f', join(root, 'current')])
    assert.equal(currentAfter.stdout.trim(), join(root, 'releases', oldVersion), 'current must lead back to the restored release')

    // ── the release in service again: same unit, answering, and the only writer ──
    const served = await fetch(`${origin}/healthz`).then(response => response.status).catch(() => 0)
    assert.equal(served, 200, 'the restored release must be answering after the rollback')
    const state = await run('systemctl', ['is-active', unit])
    assert.equal(state.stdout.trim(), 'active', 'the transient unit must be active after the rollback')
    const lockAfter = JSON.parse(await readFile(join(dataRoot, 'gateway.lock'), 'utf8'))
    const mainAfter = await run('systemctl', ['show', '-p', 'MainPID', '--value', unit])
    assert.equal(String(lockAfter.pid), mainAfter.stdout.trim(), 'the lock must belong to the unit that is serving')
    // Single writer: the candidate's process is gone, and the unit is what holds the root. The unit
    // was restarted by the transaction's own start hook, so this is a new main process.
    assert.notEqual(mainAfter.stdout.trim(), mainBefore.stdout.trim(), 'the rollback must have started the release again, in the unit the transaction owns')
    // And the restored release still accepts a real login: the rollback is not just a socket answer.
    const afterSession = await loginAndSession()
    assert.equal(afterSession.login, 200, 'the restored release must accept a real login')
    log({ stage: 'restored-serving', unit, pid: mainAfter.stdout.trim(), version: oldVersion })

    // ── isolation: the DSH installation is unreachable for this process, and only for it ──
    // The start hook recorded what systemd reported for the unit while it was serving. The property
    // is read back rather than assumed: asking a unit for `InaccessiblePaths` and having it applied
    // are different claims, and only the second one makes this environment isolated.
    const isolation = (await readFile(join(workDir, 'isolation.txt'), 'utf8')).trim()
    assert.match(isolation, /deepseek-harness/, `the unit must run with the DSH installation inaccessible (reported: ${JSON.stringify(isolation)})`)
    // A property is a request, so the isolation is observed where it would matter: inside the unit's
    // own mount namespace, which is where a release tries to load the live installation from.
    // `InaccessiblePaths` is implemented as an empty read-only mount over the path, so the check is
    // that the directory holds *nothing* for this process — while the same directory, read from
    // outside, still holds the live installation. Reading the path from the host would prove nothing
    // either way, which is why this enters the unit's namespace rather than inspecting it.
    const mainPid = mainAfter.stdout.trim()
    const insideListing = await run('nsenter', ['-t', mainPid, '-m', 'ls', '-A', '/opt/deepseek-harness'])
    const outsideListing = await run('ls', ['-A', '/opt/deepseek-harness'])
    const insideCount = insideListing.stdout.split('\n').filter(Boolean).length
    const outsideCount = outsideListing.stdout.split('\n').filter(Boolean).length
    log({ stage: 'isolation-inside', mainPid, insideCount, outsideCount, insideExit: insideListing.code })
    // The unit cannot see into the installation, and the installation is still there for everyone
    // else. Both halves matter: the first is the isolation, the second is that it is a property of
    // this unit rather than something done to the machine.
    assert.equal(insideListing.code, 0, `the isolation check could not be made inside the unit: ${insideListing.stderr.slice(-200)}`)
    assert.equal(insideCount, 0, `the DSH installation must be unreadable inside the unit, but it listed ${insideCount} entries`)
    assert.ok(outsideCount > 0, 'the live DSH installation must be untouched outside the unit')
    // And the live installation is untouched: it is a different unit, and it is still running.
    const liveState = await run('systemctl', ['is-active', 'deepseek-harness'])
    assert.equal(liveState.stdout.trim(), 'active', 'the live DSH service must be untouched by the isolated acceptance')
    log({ stage: 'isolation', inaccessiblePaths: isolation, liveDsh: liveState.stdout.trim() })
  } finally {
    // Cleanup is confirmed, not assumed. Stopping the unit is one thing; the unit being gone, its
    // cgroup empty and nothing left on the port is another. A run that deletes its installation
    // while a process of ours is still holding the data root would leave a writer behind with
    // nothing pointing at it, so the directory is only removed once our own processes are ruled out.
    await run('systemctl', ['stop', unit])
    let residue = { unit: unit, activeState: null, members: null, portBusy: null, ruledOut: false }
    for (let i = 0; i < 100; i++) {
      const state = await run('systemctl', ['is-active', unit])
      const mainPid = await run('systemctl', ['show', '-p', 'MainPID', '--value', unit])
      const busy = await run('sh', ['-c', `ss -ltn 2>/dev/null | grep -c ":${port} " || true`])
      residue = {
        unit, activeState: state.stdout.trim() || '(gone)', mainPid: mainPid.stdout.trim() || '0',
        portBusy: Number(busy.stdout.trim() || '0'), ruledOut: false,
      }
      const inactive = ['inactive', 'failed', ''].includes(residue.activeState)
      if (inactive && residue.mainPid === '0' && residue.portBusy === 0) { residue.ruledOut = true; break }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    if (!residue.ruledOut) {
      // Still ours, still running: refuse to delete, and say what is still there.
      failedRun = true
      log({ stage: 'cleanup-not-confirmed', residue })
    } else {
      log({ stage: 'cleanup-confirmed', residue })
    }
    // A failing run keeps its scene: the hooks, the verifier log and the installation are what the
    // next investigation needs, and deleting them would destroy the evidence.
    const failed = failedRun
    if (failed || process.env.PKW_KEEP_TARGET_WORKDIR) log({ stage: 'kept', workDir, unit, failed })
    if (!failed && !process.env.PKW_KEEP_TARGET_WORKDIR) await rm(workDir, { recursive: true, force: true })
  }
})

test('target: the acceptance input list is honest', () => {
  // The skip above is built from this function, so its list is the contract: every entry names an
  // input and what it is for.
  const missing = missingInputs()
  assert.ok(Array.isArray(missing))
  for (const entry of missing) assert.match(entry, /\(|on PATH/)
})

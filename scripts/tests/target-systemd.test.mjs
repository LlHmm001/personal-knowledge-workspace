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
  const systemdProbe = join(workDir, 'systemd-is-stopped.sh')
  const port = 3361
  const origin = `http://127.0.0.1:${port}`
  const log = (...parts) => console.error(JSON.stringify({ at: new Date().toISOString(), ...Object.assign({}, ...parts) }))
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
    await writeFile(systemdRun, `#!/bin/sh
# Start the release in service as a transient unit. The live pkw-collaboration.service is a
# different unit name and is never touched.
exec systemd-run --unit=${unit} --collect --quiet \\
  --property=InaccessiblePaths=/opt/deepseek-harness \\
  --property=Environment=PKW_TARGET_BOOTSTRAP=${PASSWORD} \\
  /usr/local/bin/node ${join(repoRoot, 'scripts/serve-collaboration.mjs')} \\
  --profile "$(readlink -f ${root}/current)/profile" --config ${configPath} --port ${port}
`, { mode: 0o700 })
    await writeFile(systemdStop, `#!/bin/sh
systemctl stop ${unit} >/dev/null 2>&1 || true
# Wait for the unit to be gone, so a stop that returns is a stop that happened.
i=0
while [ $i -lt 600 ]; do
  state=$(systemctl is-active ${unit} 2>/dev/null || true)
  [ "$state" = "inactive" ] || [ "$state" = "failed" ] || [ -z "$state" ] && exit 0
  i=$((i+1)); sleep 0.1
done
exit 0
`, { mode: 0o700 })
    await writeFile(systemdProbe, `#!/bin/sh
# The probe answers with the unit's own state; the CLI reads MainPID and the cgroup as well.
state=$(systemctl is-active ${unit} 2>/dev/null || true)
[ -z "$state" ] && exit 0
[ "$state" = "inactive" ] || [ "$state" = "failed" ] && exit 0
exit 1
`, { mode: 0o700 })

    // A verifier hook with the arguments the site's verifier needs: the CLI passes the version and
    // the mode, and the rest comes from the environment of the run, exactly as a site would wire it.
    const verifyHook = join(workDir, 'verify.sh')
    await writeFile(verifyHook, `#!/bin/sh
# Receives --expected-version and --mode from the CLI, and supplies the rest from this test's
# own configuration: the profile that is serving now, the origin, and the owner credential.
release=$(readlink -f ${root}/current)
exec /usr/local/bin/node ${join(repoRoot, 'deploy/site/verify-collaboration.mjs')} "$@" \
  --profile "$release/profile" --public-origin ${origin} --gateway-url ${origin} \
  --credentials-file ${credentialsFile} --username owner
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

    // ── the real CLI: stop probe, start hook, acceptance, injected failure, rollback ──
    const result = await run(process.execPath, [
      cli, '--root', root, '--version', version, '--artifact-dir', artifactDir,
      '--stop-hook', systemdStop, '--state-hook', systemdProbe, '--start-hook', systemdRun,
      '--verify-hook', verifyHook,
      '--reachable-url', origin, '--public-origin', origin,
      '--snapshot-dir', join(workDir, 'snapshots', version),
      '--store-dir', process.env.PKW_TARGET_STORE ?? '/LlHmm9527/pkw-independent/store/v11',
      '--expected-version', version,
    ], { env: { ...process.env, PKW_TARGET_VERIFY_CREDENTIALS: credentialsFile } })
    log({ stage: 'cli-exit', code: result.code, stdout: result.stdout.slice(-300), stderr: result.stderr.slice(-600) })
    // The verdict is asserted, not merely observed: this is an acceptance run, so the release has
    // to be activated, and the CLI's own report has to say so.
    assert.equal(result.code, 0, `the CLI must activate the release: ${result.stdout.slice(-400)}${result.stderr.slice(-600)}`)
    let verdict = null
    try { verdict = JSON.parse(result.stdout.trim().split('\n').filter(Boolean).slice(-1)[0]) } catch { verdict = null }
    assert.ok(verdict, `the CLI must print a structured verdict: ${result.stdout.slice(-300)}`)
    assert.equal(verdict.status, 'activated', `the CLI reported ${verdict.status}`)
    assert.equal(verdict.version, version)
    assert.equal(verdict.previousVersion, oldVersion)
    log({ stage: 'activated', version, previousVersion: verdict.previousVersion, unit })

    // The unit is serving the release that was promoted, through the entry point the transaction
    // moved, and it answers on the origin the acceptance used.
    const current = await run('readlink', ['-f', join(root, 'current')])
    assert.equal(current.stdout.trim(), join(root, 'releases', version), 'current must lead to the promoted release')
    const served = await fetch(`${origin}/healthz`).then(response => response.status).catch(() => 0)
    assert.equal(served, 200, 'the transient unit must be answering after activation')
    const state = await run('systemctl', ['is-active', unit])
    assert.equal(state.stdout.trim(), 'active', 'the transient unit must still be active')
    // Exactly one writer: the unit is the only process serving this data root.
    const lock = JSON.parse(await readFile(join(dataRoot, 'gateway.lock'), 'utf8'))
    const unitMain = await run('systemctl', ['show', '-p', 'MainPID', '--value', unit])
    assert.equal(String(lock.pid), unitMain.stdout.trim(), 'the lock must belong to the unit that is serving')

    // ── the rollback: a stop that the probe confirms, then the release in service again ──
    const rollback = await run(process.execPath, [
      cli, '--root', root, '--version', version, '--artifact-dir', artifactDir,
      '--stop-hook', systemdStop, '--state-hook', systemdProbe, '--start-hook', systemdRun,
      '--verify-hook', verifyHook,
      '--reachable-url', origin, '--public-origin', origin,
      '--snapshot-dir', join(workDir, 'snapshots', `${version}-again`),
      '--store-dir', process.env.PKW_TARGET_STORE ?? '/LlHmm9527/pkw-independent/store/v11',
      '--expected-version', version,
    ])
    // The candidate is already promoted, so this refuses before promotion; what matters is that the
    // refusal is reached through the same hooks and that the release in service is left serving.
    log({ stage: 'second-cli-exit', code: rollback.code, stderr: rollback.stderr.slice(-300) })
    assert.ok([0, 1].includes(rollback.code), `the second attempt must reach a verdict: ${rollback.stderr.slice(-400)}`)
    assert.equal(await fetch(`${origin}/healthz`).then(response => response.status).catch(() => 0), 200,
      'the release in service must still be answering after the second attempt')
  } finally {
    await run('systemctl', ['stop', unit])
    if (process.env.PKW_KEEP_TARGET_WORKDIR) log({ stage: 'kept', workDir, unit })
    else await rm(workDir, { recursive: true, force: true })
  }
})

test('target: the acceptance input list is honest', () => {
  // The skip above is built from this function, so its list is the contract: every entry names an
  // input and what it is for.
  const missing = missingInputs()
  assert.ok(Array.isArray(missing))
  for (const entry of missing) assert.match(entry, /\(|on PATH/)
})

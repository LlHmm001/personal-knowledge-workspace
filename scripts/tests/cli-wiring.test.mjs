/**
 * The deployment CLI's own wiring, on injected observations and temporary directories only.
 *
 * Two things are checked here that the unit tests cannot check on their own:
 *
 *   - the CLI refuses to start at all when it cannot observe what it must observe, and the refusal
 *     happens before anything is created or read;
 *   - the stop evidence the CLI builds is what the transaction acts on, so an unreadable identity
 *     or a leftover process in the unit's cgroup stops the deployment instead of letting it repoint
 *     the entry point and start the previous release.
 *
 * There is no live systemd, no live service and no production path anywhere in this file.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { probeSystemdStopState } from '../../deploy/site/systemd-stop-state.mjs'
import { switchRelease, currentRelease, profileVersion, assertAcceptance } from '../../deploy/switch-release.mjs'
import { makeSyntheticProfile } from './helpers/synthetic.mjs'

const run = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = join(repoRoot, 'deploy/switch-release.mjs')

const VERSION = '0.1.8-pkw.9'
const OLD_VERSION = '0.1.2-pkw.4'
const UNIT = 'synthetic-pkw.service'

/** Run the CLI and capture its exit code and streams, whatever they are. */
async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { encoding: 'utf8' })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** The arguments a real site would pass, with every path under a temporary directory. */
function cliArgs({ root, artifactDir, version = VERSION, extra = [] }) {
  return [
    '--root', root, '--version', version, '--artifact-dir', artifactDir,
    '--stop-hook', '/bin/true', '--start-hook', '/bin/true', '--verify-hook', '/bin/true',
    '--managed-unit', UNIT, ...extra,
  ]
}

test('CLI: a missing --reachable-url is refused before anything is created or read', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-cli-'))
  const root = join(workspace, 'installation')
  const artifactDir = join(workspace, 'artifacts-that-do-not-exist')
  try {
    const result = await runCli(cliArgs({ root, artifactDir }))
    assert.equal(result.code, 2, `unexpected exit ${result.code}: ${result.stderr}`)
    assert.match(result.stderr, /--reachable-url is required/)
    // The refusal is a refusal, not a failed deployment attempt: no installation was created.
    await assert.rejects(() => readdir(root), /ENOENT/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('CLI: an origin that disagrees with --public-origin is refused before anything is created', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-cli-'))
  const root = join(workspace, 'installation')
  const artifactDir = join(workspace, 'artifacts-that-do-not-exist')
  try {
    // A different port is a different service, even on the same host.
    const result = await runCli(cliArgs({
      root, artifactDir,
      extra: ['--reachable-url', 'http://127.0.0.1:3081/pkw', '--public-origin', 'http://127.0.0.1:9999'],
    }))
    assert.equal(result.code, 2, `unexpected exit ${result.code}: ${result.stderr}`)
    assert.match(result.stderr, /must name the same origin \(http:\/\/127\.0\.0\.1:3081 vs http:\/\/127\.0\.0\.1:9999\)/)
    await assert.rejects(() => readdir(root), /ENOENT/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('CLI: a health endpoint on the public origin is accepted, because the paths differ only', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-cli-'))
  const root = join(workspace, 'installation')
  try {
    // The reported defect: a health check path on the same host and port was refused because the
    // whole URL was compared as a string. It must pass the origin check and fail later, on the
    // artifacts that do not exist, which proves the guard let it through.
    const result = await runCli(cliArgs({
      root, artifactDir: join(workspace, 'artifacts-that-do-not-exist'),
      extra: ['--reachable-url', 'http://127.0.0.1:3081/healthz', '--public-origin', 'http://127.0.0.1:3081'],
    }))
    assert.notEqual(result.code, 2, `the origin guard refused a same-origin health URL: ${result.stderr}`)
    assert.doesNotMatch(result.stderr, /must name the same origin/)
    // It got as far as reading the artifact directory, which is all this test needs to know.
    assert.match(result.stderr, /ENOENT|artifacts-that-do-not-exist/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('CLI: a --reachable-url that is not a URL is refused', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-cli-'))
  const root = join(workspace, 'installation')
  try {
    const result = await runCli(cliArgs({
      root, artifactDir: join(workspace, 'none'),
      extra: ['--reachable-url', 'not-a-url'],
    }))
    assert.equal(result.code, 2, `unexpected exit ${result.code}: ${result.stderr}`)
    assert.match(result.stderr, /is not a URL this deployment can probe/)
    await assert.rejects(() => readdir(root), /ENOENT/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('CLI: a missing stop state probe is still refused before anything is created', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pkw-cli-'))
  const root = join(workspace, 'installation')
  try {
    const result = await runCli([
      '--root', root, '--version', VERSION, '--artifact-dir', join(workspace, 'none'),
      '--stop-hook', '/bin/true', '--start-hook', '/bin/true', '--verify-hook', '/bin/true',
      '--reachable-url', 'http://127.0.0.1:3081/pkw',
    ])
    assert.equal(result.code, 2, `unexpected exit ${result.code}: ${result.stderr}`)
    assert.match(result.stderr, /a stop state probe is required/)
    await assert.rejects(() => readdir(root), /ENOENT/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

/** A release layout the transaction can act on, with no install work needed. */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pkw-cli-root-'))
  const oldProfile = join(root, 'releases', OLD_VERSION, 'profile')
  await makeSyntheticProfile({ version: OLD_VERSION, root: oldProfile })
  for (const [name, content] of Object.entries({ 'package.json': `{"name":"dsh-pkw-profile","version":"${OLD_VERSION}"}\n`, 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n', '.npmrc': 'registry=https://registry.npmjs.org/\n' })) {
    await writeFile(join(oldProfile, name), content)
  }
  await mkdir(join(root, 'releases'), { recursive: true })
  await symlink(join('releases', OLD_VERSION), join(root, 'current'))
  return { root, oldProfile }
}

/** Install the candidate by writing the new version into its manifests, like pnpm would. */
async function fakeInstall({ profile }) {
  const scope = join(profile, 'node_modules/@deepseek-ai')
  for (const entry of await readdir(scope)) {
    const manifestPath = join(scope, entry, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.version = VERSION
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await writeFile(join(scope, entry, 'lib/index.js'), `export const version = '${VERSION}'\n`)
  }
}

/**
 * The transaction driven by the stop evidence the CLI builds, with systemctl replaced by a table.
 * `members` is what the unit's cgroup is said to hold.
 */
async function switchWithEvidence({ root, systemctl, members, alive = [] }) {
  let started = 0
  let stopped = 0
  const report = await switchRelease({
    root, version: VERSION, artifacts: [], registry: 'http://127.0.0.1:1',
    snapshotDir: join(root, 'snapshots', VERSION),
    deps: { prepareInstall: fakeInstall },
    hooks: {
      stop: async () => { stopped += 1 },
      start: async () => { started += 1 },
      verify: async ({ expectedRelease }) => ({
        ok: true, enforcing: true,
        checks: { authenticated: 'verified', servingVersion: await profileVersion(join(expectedRelease, 'profile')) },
      }),
      reachable: async () => ({ reachable: true, status: 200 }),
      isStopped: () => probeSystemdStopState({
        unit: UNIT,
        runCommand: async args => systemctl(args),
        readMembers: async () => ({ members, notes: [] }),
        // The kernel's answer, stubbed: the listed pids exist, everything else is gone with ESRCH.
        kill: (pid, signal) => {
          if (alive.includes(pid)) return true
          const error = new Error(`kill ESRCH ${pid}`)
          error.code = 'ESRCH'
          throw error
        },
      }),
    },
  }).then(value => ({ ok: true, report: value }), error => ({ ok: false, error }))
  return { ...report, started, stopped }
}

const showOk = ({ activeState = 'inactive', mainPid = '0', controlPid = '0' } = {}) => ({
  stdout: `ActiveState=${activeState}\nMainPID=${mainPid}\nControlPID=${controlPid}\nControlGroup=/system.slice/${UNIT}\n`,
  stderr: '', code: 0,
})

test('CLI wiring: a unit that reports inactive with a clean identity lets the switch proceed', async () => {
  const { root } = await makeRoot()
  try {
    const result = await switchWithEvidence({
      root,
      systemctl: async args => args[0] === 'is-active' ? { stdout: '', stderr: 'inactive\n', code: 3 } : showOk(),
      members: [],
      alive: [],
    })
    assert.equal(result.ok, true, `the switch refused: ${result.error?.message}`)
    assert.equal(result.report.status, 'activated')
    assert.equal(await currentRelease(root), join(root, 'releases', VERSION))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI wiring: a leftover process in the unit cgroup stops the deployment instead of repointing', async () => {
  const { root } = await makeRoot()
  try {
    // The unit is inactive and its MainPID and ControlPID are 0, yet a process it started is
    // still in its cgroup. The CLI's evidence says "not stopped", and the transaction must obey.
    const result = await switchWithEvidence({
      root,
      systemctl: async args => args[0] === 'is-active' ? { stdout: '', stderr: 'inactive\n', code: 3 } : showOk(),
      members: [424242],
      alive: [424242],
    })
    assert.equal(result.ok, false, 'a live writer must refuse the deployment')
    // The stop hook itself succeeded; what failed is the evidence that no writer is alive, and the
    // code names that rather than blaming the hook.
    assert.equal(result.error.code, 'PKW_STOP_NOT_CONFIRMED')
    assert.equal(result.error.report.stopState.probeOutcome, 'still-running')
    assert.equal(result.error.report.status, 'failed-before-promotion')
    assert.equal(result.error.report.stopState.stopped, false)
    assert.match(result.error.report.previousRestore.reason, /was not stopped/)
    // The entry point was not moved and the release in service was not started a second time.
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION))
    assert.equal(result.started, 0, 'no release may be started while a writer is alive')
    assert.equal(result.stopped, 1, 'the stop is requested once and never retried')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI wiring: an unreadable unit identity stops the deployment as unknown', async () => {
  const { root } = await makeRoot()
  try {
    // systemctl could not be run: the identity of the unit is unknown, which is not "stopped".
    const result = await switchWithEvidence({
      root,
      systemctl: async () => ({ stdout: '', stderr: 'Failed to connect to bus: Permission denied', code: 1 }),
      members: [],
      alive: [],
    })
    assert.equal(result.ok, false, 'an unknown stop state must refuse the deployment')
    assert.equal(result.error.report.status, 'failed-before-promotion')
    assert.equal(result.error.report.stopState.known, false)
    assert.equal(result.error.report.stopState.stopped, false)
    assert.equal(result.error.report.stopState.probeOutcome, 'unknown')
    assert.match(result.error.report.stopState.reason, /Permission denied/)
    assert.equal(await currentRelease(root), join(root, 'releases', OLD_VERSION))
    assert.equal(result.started, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI wiring: a unit that is still active stops the deployment', async () => {
  const { root } = await makeRoot()
  try {
    const result = await switchWithEvidence({
      root,
      systemctl: async args => args[0] === 'is-active' ? { stdout: 'active\n', stderr: '', code: 0 } : showOk({ activeState: 'active', mainPid: '4242' }),
      members: [4242],
      alive: [4242],
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.report.stopState.stopped, false)
    assert.equal(result.error.report.stopState.probeOutcome, 'still-running')
    assert.match(result.error.report.stopState.reason, /is not stopped|still running|active/)
    assert.equal(result.started, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI wiring: a verifier that prints success and then exits non-zero is refused', async () => {
  const { root } = await makeRoot()
  let started = 0
  try {
    // The acceptance probe the CLI builds is given a verifier whose payload is perfect and whose
    // process failed. This is the shape the reported defect had.
    const { probeAcceptance } = await import('../../deploy/site/collaboration-acceptance.mjs')
    const report = JSON.stringify({ ok: true, enforcing: true, checks: { authenticated: 'verified', servingVersion: VERSION, noteReadable: true } })
    const acceptance = await probeAcceptance({
      url: 'http://127.0.0.1:3081/pkw', hook: '/verifier', expectedVersion: VERSION,
      fetchImpl: async () => ({ status: 200 }),
      runVerifier: async () => ({ stdout: report, stderr: '', code: 1, error: null }),
    })
    assert.equal(acceptance.ok, false, 'a success payload from a failed process is not acceptance')
    assert.equal(acceptance.run.failure, 'the verifier exited 1')
    assert.throws(() => assertAcceptance(acceptance, { expectedVersion: VERSION, label: 'activation verification' }))

    // And the transaction refuses the same result, so the deployment cannot be reported as
    // activated on the strength of it.
    const switched = await switchRelease({
      root, version: VERSION, artifacts: [], registry: 'http://127.0.0.1:1',
      snapshotDir: join(root, 'snapshots', VERSION), deps: { prepareInstall: fakeInstall },
      hooks: {
        stop: async () => {}, start: async () => { started += 1 },
        verify: async () => acceptance,
        isStopped: async () => ({ known: true, stopped: true, source: 'injected' }),
        reachable: async () => ({ reachable: true, status: 200 }),
      },
    }).then(value => ({ ok: true, report: value }), error => ({ ok: false, error }))
    assert.equal(switched.ok, false, 'the deployment must not activate on a failed verifier run')
    assert.notEqual(switched.error.report.status, 'activated')
    assert.equal(switched.error.report.verification, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

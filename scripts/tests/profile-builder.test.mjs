/**
 * Profile-builder safety tests.
 *
 * The builder installs into whatever `--profile` names, so it must refuse anything
 * that is not a brand-new candidate. No flag may make it build into an installed
 * profile, and a non-empty directory is never removed on its behalf.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const builder = join(repoRoot, 'scripts/pkw-independent-profile.mjs')
// Guard behaviour needs no Harness: every refusal happens before the source tree is
// read. Buildability is a separate concern and is only exercised where a Harness
// checkout exists, so the guard tests are self-contained and never skip.
// The builder reads a Harness *source tree*. A real one is private, so this test
// generates a synthetic equivalent: the twelve peer packages the PKW manifests declare,
// with the entry points the builder packs. Nothing here needs a checkout or a network,
// so the guard tests always run instead of skipping.
const REAL_HARNESS = process.env.DSH_HARNESS_ROOT
let DSH_HARNESS_ROOT = REAL_HARNESS
const noHarness = false

async function invoke(profile, extraArgs = [], harnessRoot = DSH_HARNESS_ROOT) {
  try {
    const { stdout } = await run(process.execPath, [builder, '--profile', profile, '--dry-run', '--harness', harnessRoot, ...extraArgs], {
      encoding: 'utf8', env: { ...process.env },
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code ?? 1, stderr: `${error.stderr ?? ''}${error.stdout ?? ''}` }
  }
}

test('builder: a non-empty directory is refused and left untouched', { skip: noHarness }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-'))
  try {
    const keep = join(dir, 'precious-file')
    await writeFile(keep, 'must survive\n')
    const { code, stderr } = await invoke(dir, [], DSH_HARNESS_ROOT)
    assert.notEqual(code, 0, 'a non-empty profile must be refused')
    assert.match(stderr, /not empty/)
    assert.equal(await readFile(keep, 'utf8'), 'must survive\n', 'the refusal must not delete anything')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: an installed DSH profile is refused even with --allow-existing', { skip: noHarness }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-dsh-'))
  try {
    await writeFile(join(dir, 'cordis.yml'), 'plugins: []\n')
    await writeFile(join(dir, 'cordis.patch.yml'), 'patches: []\n')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2))
    for (const args of [[], ['--allow-existing', dir]]) {
      const { code, stderr } = await invoke(dir, args, DSH_HARNESS_ROOT)
      assert.notEqual(code, 0, `an installed DSH profile must be refused (args: ${args.join(' ') || 'none'})`)
      assert.match(stderr, /refusing to build into/)
    }
    assert.equal(await readFile(join(dir, 'cordis.yml'), 'utf8'), 'plugins: []\n', 'the profile files must be untouched')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: a DSH profile declared through its manifest is refused', { skip: noHarness }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-manifest-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }, null, 2))
    const { code, stderr } = await invoke(dir, [], DSH_HARNESS_ROOT)
    assert.notEqual(code, 0)
    assert.match(stderr, /declares a DSH profile/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: an existing PKW installation is refused without explicit confirmation', { skip: noHarness }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-installed-'))
  try {
    const lib = join(dir, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/collaboration')
    await mkdir(lib, { recursive: true })
    await writeFile(join(lib, 'index.js'), 'export const CollaborationGateway = {}\n')
    const { code, stderr } = await invoke(dir, [], DSH_HARNESS_ROOT)
    assert.notEqual(code, 0, 'an installed PKW profile must not be rebuilt implicitly')
    assert.match(stderr, /looks like an installed PKW profile/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: --allow-existing must repeat the exact path it confirms', { skip: noHarness }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-confirm-'))
  try {
    const other = join(dirname(dir), 'some-other-directory')
    const { code, stderr } = await invoke(dir, ['--allow-existing', other], DSH_HARNESS_ROOT)
    assert.notEqual(code, 0)
    assert.match(stderr, /must repeat the exact --profile path/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: the release in service is refused even with --allow-existing', { skip: noHarness }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-builder-serving-'))
  try {
    const release = join(root, 'releases', '0.1.9-pkw.1')
    await mkdir(join(release, 'profile'), { recursive: true })
    await symlink(join('releases', '0.1.9-pkw.1'), join(root, 'current'))
    for (const args of [[], ['--allow-existing', join(release, 'profile')]]) {
      const { code, stderr } = await invoke(join(release, 'profile'), args, DSH_HARNESS_ROOT)
      assert.notEqual(code, 0, `the release in service must be refused (args: ${args.join(' ') || 'none'})`)
      assert.match(stderr, /release in service/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('builder: an empty candidate directory is accepted by the guard stage', { skip: noHarness }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-fresh-'))
  try {
    const { code, stdout, stderr } = await invoke(dir, [], DSH_HARNESS_ROOT)
    // With a real Harness the plan is produced; without one the builder must fail on the
    // *harness* check, never on the guard.
    if (code === 0) {
      const plan = JSON.parse(stdout)
      assert.equal(plan.freshness.removeFirst, false)
      assert.ok(relative(repoRoot, plan.profile).startsWith('..'), 'the plan must name the candidate that was passed')
    } else {
      assert.match(stderr, /No packages found under --harness/, 'the guard must not be what refused an empty candidate')
    }
    assert.deepEqual(await readdir(dir), [], 'a dry run must not write anything')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: a path that does not exist yet is accepted by the guard stage', { skip: noHarness }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-missing-'))
  try {
    const target = join(dir, 'brand-new-candidate')
    const { code, stdout, stderr } = await invoke(target, [], DSH_HARNESS_ROOT)
    if (code === 0) assert.ok(JSON.parse(stdout).freshness !== undefined)
    else assert.match(stderr, /No packages found under --harness/, 'the guard must not be what refused a new path')
    assert.equal((await readdir(dir)).length, 0, 'a dry run must not create the candidate')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── self-contained guard coverage: these must hold in any environment ──────────

test.before(async () => {
  if (!DSH_HARNESS_ROOT || !existsSync(join(DSH_HARNESS_ROOT, 'packages'))) {
    const { makeSyntheticHarness } = await import('./helpers/synthetic-harness.mjs')
    DSH_HARNESS_ROOT = await makeSyntheticHarness()
  }
})

test('builder: refuses without --profile and before touching any destination', async () => {
  try {
    await run(process.execPath, [builder], { encoding: 'utf8' })
    assert.fail('the builder must require --profile')
  } catch (error) {
    assert.match(`${error.stderr ?? ''}${error.stdout ?? ''}`, /Usage|--profile is required/)
  }
})

test('builder: a relative --profile is refused', async () => {
  try {
    await run(process.execPath, [builder, '--profile', 'relative/candidate', '--dry-run'], { encoding: 'utf8' })
    assert.fail('a relative profile path must be refused')
  } catch (error) {
    const text = `${error.stderr ?? ''}${error.stdout ?? ''}`
    assert.ok(/absolute|No packages found/.test(text), `unexpected refusal reason: ${text.slice(0, 200)}`)
    return
  }
  assert.fail('a relative profile path must not be accepted')
})

test('builder: an unreadable destination is never deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-unreadable-'))
  try {
    const nested = join(dir, 'nested', 'deeper')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'file'), 'x')
    const { code } = await invoke(dir, ['--allow-existing', 'some/other/path'])
    assert.notEqual(code, 0)
    assert.deepEqual(await readdir(join(dir, 'nested')), ['deeper'], 'nothing may be removed by a refused invocation')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

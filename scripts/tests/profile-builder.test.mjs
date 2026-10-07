/**
 * Profile-builder safety tests.
 *
 * The builder installs into whatever `--profile` names, so it must refuse anything
 * that is not a brand-new candidate. No flag may make it build into an installed
 * profile, and a non-empty directory is never removed on its behalf.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const builder = join(repoRoot, 'scripts/pkw-independent-profile.mjs')
const DSH_HARNESS_ROOT = process.env.DSH_HARNESS_ROOT ?? '/opt/deepseek-harness'

async function invoke(profile, extraArgs = []) {
  try {
    const { stdout } = await run(process.execPath, [builder, '--profile', profile, '--dry-run', ...extraArgs], {
      encoding: 'utf8', env: { ...process.env, DSH_HARNESS_ROOT },
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code ?? 1, stderr: `${error.stderr ?? ''}${error.stdout ?? ''}` }
  }
}

test('builder: a non-empty directory is refused and left untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-'))
  try {
    const keep = join(dir, 'precious-file')
    await writeFile(keep, 'must survive\n')
    const { code, stderr } = await invoke(dir)
    assert.notEqual(code, 0, 'a non-empty profile must be refused')
    assert.match(stderr, /not empty/)
    assert.equal(await readFile(keep, 'utf8'), 'must survive\n', 'the refusal must not delete anything')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: an installed DSH profile is refused even with --allow-existing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-dsh-'))
  try {
    await writeFile(join(dir, 'cordis.yml'), 'plugins: []\n')
    await writeFile(join(dir, 'cordis.patch.yml'), 'patches: []\n')
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2))
    for (const args of [[], ['--allow-existing', dir]]) {
      const { code, stderr } = await invoke(dir, args)
      assert.notEqual(code, 0, `an installed DSH profile must be refused (args: ${args.join(' ') || 'none'})`)
      assert.match(stderr, /refusing to build into/)
    }
    assert.equal(await readFile(join(dir, 'cordis.yml'), 'utf8'), 'plugins: []\n', 'the profile files must be untouched')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: a DSH profile declared through its manifest is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-manifest-'))
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }, null, 2))
    const { code, stderr } = await invoke(dir)
    assert.notEqual(code, 0)
    assert.match(stderr, /declares a DSH profile/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: an existing PKW installation is refused without explicit confirmation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-installed-'))
  try {
    const lib = join(dir, 'node_modules/@deepseek-ai/dsh-pkw-web/lib/collaboration')
    await mkdir(lib, { recursive: true })
    await writeFile(join(lib, 'index.js'), 'export const CollaborationGateway = {}\n')
    const { code, stderr } = await invoke(dir)
    assert.notEqual(code, 0, 'an installed PKW profile must not be rebuilt implicitly')
    assert.match(stderr, /looks like an installed PKW profile/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: --allow-existing must repeat the exact path it confirms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-confirm-'))
  try {
    const other = join(dirname(dir), 'some-other-directory')
    const { code, stderr } = await invoke(dir, ['--allow-existing', other])
    assert.notEqual(code, 0)
    assert.match(stderr, /must repeat the exact --profile path/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: an empty candidate directory is accepted and reported as fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-fresh-'))
  try {
    const { code, stdout } = await invoke(dir)
    assert.equal(code, 0, `an empty candidate must be accepted: ${stdout}`)
    const plan = JSON.parse(stdout)
    assert.equal(plan.freshness.removeFirst, false)
    assert.deepEqual(await readdir(dir), [], 'a dry run must not write anything')
    assert.ok(relative(repoRoot, plan.profile).startsWith('..'), 'the plan must name the candidate that was passed')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('builder: a path that does not exist yet is accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-builder-missing-'))
  try {
    const target = join(dir, 'brand-new-candidate')
    const { code, stdout } = await invoke(target)
    assert.equal(code, 0, `a not-yet-created candidate must be accepted: ${stdout}`)
    assert.equal((await readdir(dir)).length, 0, 'a dry run must not create the candidate')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

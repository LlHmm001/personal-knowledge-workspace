import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { resolveInstalledPackage, validatePackedHostEntries } from '../check-packed-host-composition.mjs'

const script = fileURLToPath(new URL('../check-packed-host-composition.mjs', import.meta.url))
const packageName = '@deepseek-ai/dsh-pkw-base'
const pkwDomains = ['pkw', 'pkw_notes', 'pkw_attachments', 'pkw_tasks', 'pkw_weknora_sync']
function validRows() {
  return [
    { id: 'storage', name: '@deepseek-ai/dsh-storage' },
    { id: 'storage-json', name: '@deepseek-ai/dsh-storage-json', config: { root: { __jsExpr: "dshHomePath('storages')" } } },
    { id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json', routes: Object.fromEntries(pkwDomains.map(name => [name, 'sqlite'])) } },
    { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
    { id: 'storage-sqlite', name: '@deepseek-ai/dsh-storage-sqlite', config: { path: { __jsExpr: "dshHomePath('pkw', 'pkw.sqlite')" } } },
    { id: 'pkw-events', name: '@deepseek-ai/dsh-pkw-events' },
    { id: 'pkw-workspace', name: '@deepseek-ai/dsh-pkw-workspace' },
  ]
}

test('packed composition validation accepts the intended boundary without executing expression nodes', () => {
  const rows = validRows()
  rows.push({ id: 'unrelated-host-plugin', name: 'host-plugin', config: { probe: { __jsExpr: 'throw new Error("expression must stay literal")' } } })
  const before = structuredClone(rows)
  const report = validatePackedHostEntries(rows)
  assert.equal(report.defaultBackend, 'json')
  assert.equal(report.workspaceBackend, 'json')
  assert.deepEqual(Object.keys(report.pkwRoutes).sort(), [...pkwDomains].sort())
  assert.deepEqual(rows, before)
})

test('duplicate IDs fail even when disabled or hidden inside a group', () => {
  for (const id of ['storage', 'storage-domain', 'workspace']) {
    const rows = validRows(), repeated = { ...rows.find(row => row.id === id), disabled: true }
    assert.throws(() => validatePackedHostEntries([...rows, repeated]), /Duplicate loader entry id/)
    assert.throws(() => validatePackedHostEntries([...rows, { id: 'group', name: 'group', group: true, config: [repeated] }]), /Duplicate loader entry id/)
  }
})

test('renaming a second shared service or moving it into an isolated scope cannot pass', () => {
  const rows = validRows()
  assert.throws(() => validatePackedHostEntries([...rows, { id: 'pkw-storage', name: '@deepseek-ai/dsh-storage' }]), /Duplicate shared service implementation/)
  rows.find(row => row.id === 'workspace').isolate = { workspaceRegistry: true }
  assert.throws(() => validatePackedHostEntries(rows), /isolated service realm/)
  const grouped = validRows(), storage = grouped.shift()
  grouped.push({ id: 'group', name: 'group', group: true, config: [storage] })
  assert.throws(() => validatePackedHostEntries(grouped), /shared root service/)
})

test('warnings, missing services, disabled services and a wrong plugin identity are blockers', () => {
  assert.throws(() => validatePackedHostEntries(validRows(), ['patch: missing target']), /patch warnings/)
  assert.throws(() => validatePackedHostEntries(validRows().filter(row => row.id !== 'workspace')), /Missing host composition row/)
  for (const disabled of [true, { __jsExpr: 'true' }]) {
    const rows = validRows(); rows.find(row => row.id === 'storage-domain').disabled = disabled
    assert.throws(() => validatePackedHostEntries(rows), /must be enabled/)
  }
  const wrong = validRows(); wrong.find(row => row.id === 'storage').name = 'other-storage'
  assert.throws(() => validatePackedHostEntries(wrong), /Unexpected service/)
})

test('default backend changes, missing PKW domains, wildcard routes and workspace rerouting fail', () => {
  const variants = [
    config => { config.backend = 'sqlite' },
    config => { delete config.routes.pkw_tasks },
    config => { config.routes.pkw_notes = 'json' },
    config => { config.routes = { 'pkw_*': 'sqlite' } },
    config => { config.routes.workspace = 'sqlite' },
    config => { config.routes.session_projcache = 'sqlite' },
  ]
  for (const modify of variants) {
    const rows = validRows(); modify(rows.find(row => row.id === 'storage-domain').config)
    assert.throws(() => validatePackedHostEntries(rows), /JSON|five PKW domains/)
  }
  for (const id of ['storage-json', 'storage-sqlite']) {
    const rows = validRows(); rows.find(row => row.id === id).config = { path: '/new/empty/location' }
    assert.throws(() => validatePackedHostEntries(rows), /location changed/)
  }
})

test('package lookup accepts a pnpm layout, rejects an external PKW source symlink, and never runs package code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pkw-packed-resolve-'))
  try {
    const profile = join(root, 'profile'), installed = join(profile, 'node_modules/.pnpm/base/node_modules', packageName)
    const manifest = { name: packageName, type: 'module', exports: { '.': './lib/index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }
    await mkdir(join(installed, 'lib'), { recursive: true })
    await writeFile(join(installed, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(installed, 'lib/index.js'), 'throw new Error("must not run PKW code")')
    const link = join(profile, 'node_modules', packageName)
    await mkdir(dirname(link), { recursive: true })
    await symlink(installed, link)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true }))
    const result = await resolveInstalledPackage(profile, packageName, { requireLocal: true })
    assert.equal(result.manifest.name, packageName)
    assert.equal(result.directory, await realpath(installed))
    assert.equal(await readFile(join(installed, 'lib/index.js'), 'utf8'), 'throw new Error("must not run PKW code")')

    const external = join(root, 'source'), otherProfile = join(root, 'other-profile')
    await mkdir(join(external, 'lib'), { recursive: true })
    await writeFile(join(external, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(external, 'lib/index.js'), 'throw new Error("must not run source code")')
    await mkdir(join(otherProfile, 'node_modules/@deepseek-ai'), { recursive: true })
    await writeFile(join(otherProfile, 'package.json'), '{}')
    await symlink(external, join(otherProfile, 'node_modules', packageName))
    await assert.rejects(resolveInstalledPackage(otherProfile, packageName, { requireLocal: true }), /external source symlink/)
    // Host packages may legitimately be linked to the immutable Harness checkout.
    assert.equal((await resolveInstalledPackage(otherProfile, packageName)).directory, await realpath(external))
    await assert.rejects(resolveInstalledPackage('relative-profile', packageName), /must be absolute/)
    await assert.rejects(resolveInstalledPackage(profile, '@deepseek-ai/not-installed'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CLI help needs no installed runtime and missing profile fails without fallback', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [script, '--help'])
  assert.match(stdout, /without activating plugins/)
  await assert.rejects(promisify(execFile)(process.execPath, [script]), error => error.code === 1 && /--profile is required/.test(error.stderr))
})

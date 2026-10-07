/** Validate shipped bundle composition without starting DSH or opening user data. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-pkw-base']
const routes = Object.freeze(Object.fromEntries(['pkw', 'pkw_notes', 'pkw_attachments', 'pkw_tasks', 'pkw_weknora_sync'].map(name => [name, 'sqlite'])))
const required = Object.freeze({
  storage: '@deepseek-ai/dsh-storage',
  'storage-json': '@deepseek-ai/dsh-storage-json',
  'storage-domain': '@deepseek-ai/dsh-storage-domain',
  workspace: '@deepseek-ai/dsh-workspace',
  'storage-sqlite': '@deepseek-ai/dsh-storage-sqlite',
  'pkw-events': '@deepseek-ai/dsh-pkw-events',
  'pkw-workspace': '@deepseek-ai/dsh-pkw-workspace',
})

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/** Resolve from this installed profile, with no fallback to PKW repository files. */
export async function resolveInstalledPackage(profile, name, { requireLocal = false } = {}) {
  assert.ok(isAbsolute(profile), '--profile must be absolute')
  const require = createRequire(join(profile, 'package.json'))
  const entry = require.resolve(name)
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    let manifest
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (manifest?.name === name) {
      directory = await realpath(directory)
      if (requireLocal) {
        const profileRoot = await realpath(profile)
        assert.ok(inside(join(profileRoot, 'node_modules'), directory), `${name} must come from the profile's installed packages, not an external source symlink`)
      }
      return { directory, entry, manifest }
    }
    if (directory === dirname(directory)) throw new Error(`Installed package root not found: ${name}`)
  }
}

/** Fail on composition defects even when the loader dump can still print them. */
export function validatePackedHostEntries(rows, warnings = []) {
  assert.deepEqual(warnings, [], 'Host bundle composition emitted patch warnings')
  const byId = new Map()
  function visit(entries) {
    assert.ok(Array.isArray(entries), 'Loader entries must be an array')
    for (const row of entries) {
      assert.ok(row && typeof row === 'object' && typeof row.id === 'string' && row.id, 'Every shipped loader row needs a stable id')
      assert.ok(!byId.has(row.id), `Duplicate loader entry id: ${row.id}`)
      byId.set(row.id, row)
      if (row.group) visit(row.config)
    }
  }
  visit(rows)
  for (const [id, name] of Object.entries(required)) {
    const row = byId.get(id)
    assert.ok(row, `Missing host composition row: ${id}`)
    assert.equal(row.name, name, `Unexpected service for ${id}`)
    assert.equal([...byId.values()].filter(candidate => candidate.name === name).length, 1, `Duplicate shared service implementation: ${name}`)
    assert.ok(row.disabled === undefined || row.disabled === null || row.disabled === false, `${id} must be enabled`)
    assert.ok(!row.group && rows.includes(row), `${id} must remain a shared root service`)
    assert.ok(row.isolate == null || Object.keys(row.isolate).length === 0, `${id} must not introduce an isolated service realm`)
  }
  const domain = byId.get('storage-domain').config
  assert.equal(domain?.backend, 'json', 'DSH default domains must remain on JSON')
  assert.deepEqual(domain.routes, routes, 'Exactly the five PKW domains must route to SQLite; workspace must keep the host route')
  assert.deepEqual(byId.get('storage-json').config, { root: { __jsExpr: "dshHomePath('storages')" } }, 'Host JSON location changed')
  assert.deepEqual(byId.get('storage-sqlite').config, { path: { __jsExpr: "dshHomePath('pkw', 'pkw.sqlite')" } }, 'PKW SQLite location changed')
  return { rows: byId.size, sharedServices: Object.keys(required), defaultBackend: 'json', workspaceBackend: 'json', pkwRoutes: { ...routes } }
}

export async function checkPackedHostComposition({ profile }) {
  assert.ok(isAbsolute(profile), '--profile must be absolute')
  // Import the real host implementation. loadOverlayPatches keeps !!js literal;
  // composeEntries delegates to the same include algorithm used during boot.
  const appBoot = await resolveInstalledPackage(profile, '@deepseek-ai/dsh-app-boot')
  const { loadOverlayPatches, composeEntries } = await import(pathToFileURL(appBoot.entry).href)
  assert.equal(typeof loadOverlayPatches, 'function', 'Host app-boot lacks patch parsing')
  assert.equal(typeof composeEntries, 'function', 'Host app-boot lacks bundle composition')
  const layers = [], artifacts = []
  for (const name of bundles) {
    const pkg = await resolveInstalledPackage(profile, name, { requireLocal: name === '@deepseek-ai/dsh-pkw-base' })
    const declaration = pkg.manifest.dsh?.bundle?.patch
    assert.ok(typeof declaration === 'string' && declaration, `${name} has no bundle patch declaration`)
    const patch = await realpath(resolve(pkg.directory, declaration))
    assert.ok(inside(pkg.directory, patch), `${name} bundle patch escapes its installed package`)
    const bytes = await readFile(patch)
    artifacts.push({ name, version: pkg.manifest.version, patchSha256: createHash('sha256').update(bytes).digest('hex') })
    layers.push(loadOverlayPatches('pkw-packed-host-check', patch))
  }
  const warnings = []
  const composition = validatePackedHostEntries(composeEntries(layers, warning => warnings.push(warning)), warnings)
  return { status: 'passed', artifacts, ...composition, boundaries: { pluginActivation: 'not run', userProfileOverlays: 'not read', canonicalData: 'not opened' } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('node scripts/check-packed-host-composition.mjs --profile /absolute/installed-profile\nChecks installed PKW + DSH Web bundle composition without activating plugins or reading user overlays/data.')
  else {
    if (!values.profile) throw new Error('--profile is required')
    console.log(JSON.stringify(await checkPackedHostComposition({ profile: values.profile }), null, 2))
  }
}

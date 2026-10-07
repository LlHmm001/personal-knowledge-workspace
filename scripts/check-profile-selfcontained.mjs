#!/usr/bin/env node
/**
 * Prove an installed profile is self-contained.
 *
 * This is the check that matters for an independent runtime and it needs no private
 * Harness: it uses Node's own resolver from the profile and asserts that every PKW
 * package and every Harness peer resolves *inside* the profile, that nothing resolves
 * into a DSH installation or a DSH profile farm, and that the collaboration entry point
 * can be imported and read its own version.
 *
 * Exit 0 when self-contained, 5 when a resolved path leaves the profile.
 */
import { createRequire } from 'node:module'
import { readdir, realpath, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  profile: { type: 'string' },
  // Importing the entry point exercises the peer closure. It needs peers that really
  // implement their API, so it is separate from the resolution check, which is the part
  // that can be proven with a synthetic closure.
  'require-runtime-import': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} })
if (values.help || !values.profile) {
  process.stdout.write('Usage: node scripts/check-profile-selfcontained.mjs --profile DIR\n')
  process.exit(values.help ? 0 : 2)
}
const profile = resolve(values.profile)
const scopeDir = join(profile, 'node_modules/@deepseek-ai')
if (!existsSync(scopeDir)) {
  console.error(`not an installed profile: ${scopeDir} does not exist`)
  process.exit(2)
}
const require = createRequire(join(profile, 'package.json'))
const names = (await readdir(scopeDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => `@deepseek-ai/${e.name}`)

// Roots a resolved path must never fall under: a host installation or its farm.
const forbidden = String(process.env.PKW_FORBIDDEN_RESOLUTION_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
const violations = []
const outside = []
let checked = 0
for (const name of names) {
  let entry
  try { entry = await realpath(require.resolve(`${name}/package.json`)) } catch (error) { violations.push(`${name}: unresolved (${error.code ?? error.message})`); continue }
  checked += 1
  if (!entry.startsWith(profile + sep)) outside.push(`${name} -> ${entry}`)
  for (const root of forbidden) if (entry.startsWith(root + sep)) violations.push(`${name} resolves into a host installation -> ${entry}`)
}

// The runtime entry point resolves inside the profile; importing it additionally proves
// the peer closure implements what the entry point uses.
const webEntry = await realpath(require.resolve('@deepseek-ai/dsh-pkw-web/lib/collaboration/index.js'))
// webEntry is <pkg>/lib/collaboration/index.js, so the package root is three levels up.
const declared = JSON.parse(await readFile(join(dirname(dirname(dirname(webEntry))), 'package.json'), 'utf8')).version
let runtimeEntry = 'resolution-only'
if (values['require-runtime-import']) {
  try {
    const gatewayModule = await import(pathToFileURL(webEntry).href)
    if (typeof gatewayModule.CollaborationGateway?.open !== 'function') violations.push('CollaborationGateway.open is not exported by the installed entry point')
    const renderModule = await import(pathToFileURL(await realpath(require.resolve('@deepseek-ai/dsh-pkw-web/lib/lute.js'))).href)
    if (typeof renderModule.renderMarkdownToHtml !== 'function') violations.push('renderMarkdownToHtml is not exported by the installed entry point')
    runtimeEntry = 'imported'
  } catch (error) {
    violations.push(`the installed entry point could not be imported: ${error.message}`)
    runtimeEntry = 'not-importable'
  }
}

const result = {
  profile, packages: checked, expected: names.length,
  outsideProfile: outside, violations,
  entryPoint: webEntry, declaredVersion: declared, runtimeEntry,
  forbiddenRoots: forbidden,
}
console.log(JSON.stringify(result, null, 2))
if (violations.length || outside.length) process.exit(5)
console.log(`OK: ${checked} packages resolve inside the profile; entry point declares ${declared}; runtime entry ${runtimeEntry}`)

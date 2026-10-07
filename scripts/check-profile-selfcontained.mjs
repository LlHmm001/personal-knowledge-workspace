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
 * With `--trace-imports` it goes further: it installs module resolution hooks, imports the
 * collaboration entry point, and records every file the runtime actually loads. Anything
 * loaded from outside the profile — a transitive peer resolved through an ancestor
 * directory, for instance — is a violation, because that is the borrowing this exists to
 * prevent.
 *
 * Exit 0 when self-contained, 5 when a resolved path leaves the profile.
 */
import { createRequire } from 'node:module'
import { lstat, readdir, realpath, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  profile: { type: 'string' },
  // Importing the entry point exercises the peer closure. It needs peers that really
  // implement their API, so it is separate from the resolution check, which is the part
  // that can be proven with a synthetic closure.
  'require-runtime-import': { type: 'boolean', default: false },
  'trace-imports': { type: 'boolean', default: false },
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
// Symlinked packages count too: a profile whose packages are links into a host
// installation looks installed but is not self-contained.
const names = (await readdir(scopeDir, { withFileTypes: true }))
  .filter(e => e.isDirectory() || e.isSymbolicLink())
  .map(e => `@deepseek-ai/${e.name}`)
// The packages a runtime must actually have. A profile missing one is not usable even if
// everything it does contain resolves inside it.
const REQUIRED = ['@deepseek-ai/dsh-pkw-web', '@deepseek-ai/dsh-pkw-workspace', '@deepseek-ai/cordis']
const missingRequired = REQUIRED.filter(name => !names.includes(name))
if (missingRequired.length) {
  console.error(JSON.stringify({ profile, missingRequired }, null, 2))
  process.exit(5)
}

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
  // A link that leaves the profile is a violation even when the resolved package exists.
  const linkPath = join(scopeDir, name.slice('@deepseek-ai/'.length))
  const info = await lstat(linkPath).catch(() => null)
  if (info?.isSymbolicLink()) {
    const target = await realpath(linkPath).catch(() => null)
    const resolvedTarget = target ? await realpath(join(target, 'package.json')).catch(() => target) : null
    if (!resolvedTarget || !resolvedTarget.startsWith(profile + sep)) {
      violations.push(`${name} is a symlink leaving the profile -> ${resolvedTarget ?? 'dangling'}`)
    }
  }
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

// ── optional: follow what the runtime actually loads ────────────────────────────
// Done in a fresh subprocess: hooks registered after an import in this process would miss
// every module that import already cached.
let tracedImports = null
if (values['trace-imports']) {
  const { spawn } = await import('node:child_process')
  const traceScript = join(dirname(fileURLToPath(import.meta.url)), 'tests/helpers/trace-imports.mjs')
  const output = await new Promise(resolvePromise => {
    const child = spawn(process.execPath, [traceScript, '--profile', profile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.once('exit', () => resolvePromise(out))
  })
  try { tracedImports = JSON.parse(output.trim().split('\n').filter(Boolean).slice(-1)[0]) } catch { tracedImports = { error: output.slice(-300) } }
  if (tracedImports?.importError) violations.push(`the entry point could not be imported: ${tracedImports.importError}`)
  for (const file of tracedImports?.outside ?? []) violations.push(`the runtime loaded a file from outside the profile -> ${file}`)
}

const result = {
  profile, packages: checked, expected: names.length,
  outsideProfile: outside, violations,
  entryPoint: webEntry, declaredVersion: declared, runtimeEntry,
  tracedImports: tracedImports ? { loaded: tracedImports.loaded ?? null, outside: tracedImports.outside ?? [], error: tracedImports.error ?? null } : null,
  forbiddenRoots: forbidden,
}
console.log(JSON.stringify(result, null, 2))
if (violations.length || outside.length) process.exit(5)
console.log(`OK: ${checked} packages resolve inside the profile; entry point declares ${declared}; runtime entry ${runtimeEntry}${tracedImports ? `; traced imports outside the profile: ${(tracedImports.outside ?? []).length}` : ''}`)

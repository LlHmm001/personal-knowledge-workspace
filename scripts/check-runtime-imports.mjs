/**
 * Pre-deploy runtime import smoke. Import every PKW package entry through the
 * REAL Node/tsx production resolution boundary (harness root `node_modules` +
 * the bind-mounted workspace tree) — not tsconfig paths, not hoisting. Fails
 * fast with exit 1 if any runtime dependency is undeclared or unlinked, which
 * is exactly the class of failure (ERR_MODULE_NOT_FOUND) that took 3080 down.
 *
 * Run from the harness root so tsx resolves `@deepseek-ai/*` against the same
 * node_modules the production `dsh web` process uses:
 *
 *   cd /opt/deepseek-harness
 *   node --import tsx/esm /LlHmm9527/Personal\ Knowledge\ Workspace/scripts/check-runtime-imports.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..', 'packages', 'pkw')
const entries = ['domain', 'events', 'workspace', 'notes', 'attachments', 'weknora', 'weknora-sync', 'tasks', 'web']

let failed = false
for (const name of entries) {
  const mod = join(pkgRoot, name, 'src', 'index.ts')
  try {
    await import(mod)
    console.log(`OK   ${name}`)
  } catch (error) {
    failed = true
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failed) {
  console.error('runtime import smoke FAILED')
  process.exit(1)
}
console.log('runtime import smoke PASSED')

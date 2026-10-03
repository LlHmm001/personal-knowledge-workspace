import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packageList, run, sha256 } from './deployment.mjs'

async function snapshot() {
  const hashes = {}
  for (const pkg of await packageList()) {
    async function visit(path, rel = '') {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const key = join(rel, entry.name)
        if (entry.isDirectory()) await visit(join(path, entry.name), key)
        else hashes[`${pkg.manifest.name}/${key}`] = sha256(await readFile(join(path, entry.name)))
      }
    }
    await visit(join(pkg.dir, 'lib'))
  }
  return hashes
}
await run('pnpm', ['build'])
const first = await snapshot()
const packages = await packageList()
const stale = join(packages[0].dir, 'lib/stale-output.js')
await writeFile(stale, 'throw new Error("stale build output")')
await run('pnpm', ['build'])
assert.deepEqual(await snapshot(), first, 'Repeated builds differ or retained stale output')
console.log(`PASS: ${packages.length} packages, ${Object.keys(first).length} emitted files identical; stale output removed`)

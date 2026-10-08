#!/usr/bin/env node
/**
 * Trace what the collaboration entry point loads, from a process that has loaded nothing.
 *
 * Registering resolution hooks and importing afterwards does not work in the same process:
 * `--require-runtime-import` may already have imported the entry point, so its transitive
 * dependencies are cached and the hooks never see them. This file is spawned fresh, so the
 * hooks are in place before the first module is resolved.
 *
 * Usage: node trace-imports.mjs --profile DIR   (prints JSON on stdout)
 */
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'
import { readdir, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { profile: { type: 'string' } } })
if (!values.profile) { process.stderr.write('Usage: node trace-imports.mjs --profile DIR\n'); process.exit(2) }
const profile = await realpath(resolve(values.profile))
const loaded = []
const record = url => {
  if (typeof url !== 'string' || !url.startsWith('file:')) return
  let file
  try { file = fileURLToPath(url) } catch { return }
  if (!loaded.includes(file)) loaded.push(file)
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    if (result?.url) record(result.url)
    // An ancestor directory resolution is exactly the borrowing under test.
    return result
  },
  load(url, context, nextLoad) {
    record(url)
    return nextLoad(url, context)
  },
})

const require = createRequire(join(profile, 'package.json'))
const entry = await realpath(require.resolve('@deepseek-ai/dsh-pkw-web/lib/collaboration/index.js'))
let importError = null
try { await import(pathToFileURL(entry).href) } catch (error) { importError = error.message }

const outside = loaded.filter(file => !file.startsWith(profile + sep))
console.log(JSON.stringify({ ok: outside.length === 0 && !importError, profile, entry, loaded: loaded.length, outside, importError }, null, 2))
process.exit(outside.length === 0 && !importError ? 0 : 5)

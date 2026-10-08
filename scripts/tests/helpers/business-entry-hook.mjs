#!/usr/bin/env node
/**
 * Observe, and optionally hold, one business method of the PKW web service — before it runs.
 *
 * The listener's observation gate sits in front of `gateway.handle()`, which proves that a request
 * was accepted and queued, not that the business logic was reached. For "a request was in flight"
 * that distinction matters: a request parked before the gateway is a request nobody has started
 * work on, and a drain that finishes it proves only that the queue emptied.
 *
 * This preload hooks the service's own `call()` — the single entry point every RPC method goes
 * through — and records, in the same JSON-lines shape the gate uses, the request as it enters the
 * business method. When a hold is configured and the method matches, the call is held until the
 * release file appears, so a test can put the signal *inside* the business operation.
 *
 * It is a preload rather than a change to the product: nothing in `packages/` knows it exists, and
 * without `PKW_TEST_ENTRY_FILE` it does nothing at all.
 *
 * Configuration, as JSON in `PKW_TEST_ENTRY_FILE`:
 *   { "path": "<absolute ledger file>", "method": "saveNoteBody", "hold": true,
 *     "release": "<absolute release file>", "expect": "note.save" }
 *
 * Usage:
 *   node --import <this file> scripts/serve-collaboration.mjs --profile ... --config ... --port N
 */
import { createRequire } from 'node:module'
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const configPath = process.env.PKW_TEST_ENTRY_FILE
const settings = (() => {
  if (!configPath) return null
  try { return JSON.parse(readFileSync(configPath, 'utf8')) } catch { return null }
})()

/** The installed `@deepseek-ai/dsh-pkw-web` package, found from the profile the listener will use. */
function resolvePkwWeb(from) {
  let dir = from
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh-pkw-web', 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // A profile can also be a pnpm layout, where the package lives under a content-addressed name.
  const scope = join(from, 'node_modules', '@deepseek-ai')
  if (existsSync(scope)) {
    for (const entry of readdirSync(scope)) {
      if (entry !== 'dsh-pkw-web') continue
      const candidate = join(scope, entry, 'package.json')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

if (settings) {
  const profile = process.argv[process.argv.indexOf('--profile') + 1] ?? process.cwd()
  const manifest = resolvePkwWeb(profile)
  if (!manifest) {
    // Not silence: a test that asked for business-entry observation and got none would report a
    // pass on an observation that was never made.
    process.stderr.write(`${JSON.stringify({ status: 'entry-hook-failed', reason: `no installed dsh-pkw-web found from ${profile}` })}\n`)
    process.exit(6)
  }
  const require = createRequire(manifest)
  const mod = require('@deepseek-ai/dsh-pkw-web')
  const Service = mod.default ?? mod.PkwWebService
  if (Service?.prototype?.call === undefined) {
    process.stderr.write(`${JSON.stringify({ status: 'entry-hook-failed', reason: 'the package exposes no service class with a call() method' })}\n`)
    process.exit(6)
  }
  const record = entry => { try { appendFileSync(settings.path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`) } catch { /* the test stopped watching */ } }
  const original = Service.prototype.call
  Service.prototype.call = async function call(method, args) {
    if (method === settings.method) {
      record({ event: 'business-entered', method, noteId: args?.noteId ?? null, pid: process.pid })
      if (settings.hold && settings.release) {
        const deadline = Date.now() + 60_000
        while (!existsSync(settings.release) && Date.now() < deadline) {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
        }
        record({ event: 'business-released', method, pid: process.pid })
      }
    }
    return original.call(this, method, args)
  }
}

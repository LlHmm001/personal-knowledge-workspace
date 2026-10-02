#!/usr/bin/env node
/** Offline password recovery: reads a password from an environment variable, preserves all content and roles. */
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lstat, open, realpath, unlink } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { profile: { type: 'string' }, 'data-root': { type: 'string' }, username: { type: 'string' }, 'password-env': { type: 'string' }, 'offline-confirmed': { type: 'boolean', default: false }, help: { type: 'boolean' } } })
if (values.help) { console.log('node scripts/recover-account.mjs --profile ABS --data-root ABS --username ACCOUNT --password-env VARIABLE_NAME --offline-confirmed'); process.exit(0) }
if (!values.profile || !values.username || !values['data-root'] || !isAbsolute(values['data-root']) || !values['offline-confirmed']) throw new Error('An installed profile, canonical data root, account name and --offline-confirmed are required')
const variable = values['password-env']
if (!variable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) || !process.env[variable]) throw new Error('Provide the name of a populated password environment variable; never pass a password as a command argument')
const root = resolve(values['data-root'])
if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error('Use a canonical existing data root')
if (!(await lstat(join(root, 'identity.sqlite'))).isFile()) throw new Error('Existing identity.sqlite is required')
const lockPath = join(root, 'gateway.lock'), lock = await open(lockPath, 'wx', 0o600)
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, operation: 'password-recovery', at: new Date().toISOString() }) + '\n'); await lock.sync()
  const require = createRequire(join(resolve(values.profile), 'package.json'))
  const { IdentityStore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pkw-web/lib/collaboration/identity.js')).href)
  const store = await IdentityStore.open(join(root, 'identity.sqlite'))
  try { await store.resetPassword(values.username, process.env[variable]) } finally { store.close() }
  console.log(JSON.stringify({ status: 'complete', operation: 'password-recovery', allAccountSessions: 'revoked', contentAndMemberships: 'unchanged' }))
} finally {
  const held = await lock.stat(); await lock.close()
  const current = await lstat(lockPath)
  if (current.ino !== held.ino) throw new Error('Recovery lock changed; inspect manually')
  await unlink(lockPath)
}

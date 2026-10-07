#!/usr/bin/env node
import { backupData, DataError, EXIT, inspectData, restoreData, verifyBackup, verifySource } from './data-preservation.mjs'

const commands = { inspect: inspectData, backup: backupData, verify: verifyBackup, 'verify-source': verifySource, restore: restoreData }
const help = {
  tool: 'pkw-data', version: 1,
  commands: {
    inspect: '--workspace ABS --state ABS',
    backup: '--workspace ABS --state ABS --output NEW_ABS_DIR --offline-confirmed',
    verify: '--backup ABS [--manifest-sha256 HEX] [--require-ready]',
    'verify-source': '--backup ABS [--manifest-sha256 HEX] [--require-ready]',
    restore: '--backup ABS --target NEW_ABS_DIR [--manifest-sha256 HEX] [--require-ready]',
  },
  exitCodes: EXIT,
  note: 'All existing data belongs to its existing owner private space. Stop every writer before backup and keep them stopped through verify-source and cutover. Restore only creates a new isolated copy. Old schemas are preserved, never guessed or upgraded. Successful preservation is not target runtime acceptance.',
}
const allowed = { inspect: ['workspace', 'state'], backup: ['workspace', 'state', 'output', 'offline-confirmed'], verify: ['backup', 'manifest-sha256', 'require-ready'], 'verify-source': ['backup', 'manifest-sha256', 'require-ready'], restore: ['backup', 'target', 'manifest-sha256', 'require-ready'] }
try {
  const [command, ...args] = process.argv.slice(2)
  if (command === '--help' || command === 'help') console.log(JSON.stringify({ ok: true, exitCode: EXIT.OK, ...help }, null, 2))
  else {
    if (!commands[command]) throw new DataError('USAGE', 'Unknown command; run pkw-data.mjs --help')
    const options = {}, seen = new Set()
    for (let index = 0; index < args.length; index++) {
      const flag = args[index].replace(/^--/, '')
      if (!args[index].startsWith('--') || !allowed[command].includes(flag) || seen.has(flag)) throw new DataError('USAGE', 'Unknown or repeated option', { option: args[index] })
      seen.add(flag)
      const key = flag.replace(/-([a-z])/g, (_, character) => character.toUpperCase())
      if (flag === 'offline-confirmed' || flag === 'require-ready') options[key] = true
      else {
        const value = args[++index]
        if (!value || value.startsWith('--')) throw new DataError('USAGE', `Missing value for --${flag}`)
        options[key] = value
      }
    }
    if (options.manifestSha256 && !/^[0-9a-f]{64}$/.test(options.manifestSha256)) throw new DataError('USAGE', 'manifest-sha256 must be 64 lowercase hexadecimal characters')
    const result = await commands[command](options)
    console.log(JSON.stringify({ ok: true, exitCode: EXIT.OK, ...result }, null, 2))
  }
} catch (error) {
  const exitCode = error instanceof DataError ? error.exitCode : EXIT.IO
  console.log(JSON.stringify({ ok: false, exitCode, error: { kind: error instanceof DataError ? error.kind : 'IO', message: error.message, ...(error instanceof DataError ? { details: error.details } : { code: error.code ?? null }) } }, null, 2))
  process.exitCode = exitCode
}

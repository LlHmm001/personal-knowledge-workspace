/** Read-only target inventory. Never opens user notes, databases or credentials. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

async function installedPackage(require, name) {
  const entry = require.resolve(name)
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    try {
      const manifest = await readJson(join(directory, 'package.json'))
      if (manifest.name === name) {
        return { directory, name, version: manifest.version, entrySha256: digest(await readFile(entry)) }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (directory === dirname(directory)) throw new Error('Package root was not found')
  }
}

export async function inspectProfile(profile, harness) {
  if (!isAbsolute(profile)) throw new Error('--profile must be an absolute existing profile directory')
  // Parse only to confirm this is an installed profile; never return its config.
  const manifest = await readJson(join(profile, 'package.json'))
  if (!manifest.dependencies?.['@deepseek-ai/dsh-pkw-web']) throw new Error('Profile does not declare dsh-pkw-web')
  const require = createRequire(join(profile, 'package.json'))
  const expected = []
  const hostNames = new Set()
  for (const entry of await readdir(join(root, 'packages/pkw'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkg = await readJson(join(root, 'packages/pkw', entry.name, 'package.json'))
    expected.push(pkg.name)
    for (const name of Object.keys(pkg.peerDependencies ?? {})) hostNames.add(name)
  }
  const report = {
    capturedAt: new Date().toISOString(), nodeVersion: process.version,
    pkw: [], host: [], uiArtifacts: [], harness: null,
    boundaries: { canonicalData: 'not opened', credentials: 'not opened', service: 'not restarted', uiContents: 'hashes only; not copied' },
  }
  let web
  for (const name of [...expected.sort(), ...[...hostNames].sort()]) {
    const group = expected.includes(name) ? report.pkw : report.host
    try {
      const pkg = await installedPackage(require, name)
      if (name === '@deepseek-ai/dsh-pkw-web') web = pkg
      const { directory, ...metadata } = pkg
      group.push(metadata)
    } catch {
      group.push({ name, status: 'unresolved from profile' })
    }
  }
  if (web) {
    for (const filename of (await readdir(join(web.directory, 'lib'))).sort()) {
      if (filename !== 'ui.js' && !/^ui\.js\.bak-[\w.-]+$/.test(filename)) continue
      const bytes = await readFile(join(web.directory, 'lib', filename))
      report.uiArtifacts.push({ filename, bytes: bytes.length, sha256: digest(bytes) })
    }
  }
  if (harness) {
    if (!isAbsolute(harness)) throw new Error('--harness must be an absolute directory')
    const pkg = await readJson(join(harness, 'package.json'))
    let commit = null
    try {
      const top = execFileSync('git', ['-C', harness, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (resolve(top) === resolve(harness)) commit = execFileSync('git', ['-C', harness, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { /* Release archives do not prove a source commit. */ }
    report.harness = { name: pkg.name, version: pkg.version, commit }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { profile: { type: 'string' }, harness: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('node scripts/inspect-profile.mjs --profile /absolute/profile [--harness /absolute/harness]\nPrints installed versions and UI hashes. Does not copy code, configuration or user data.')
  else {
    if (!values.profile) throw new Error('--profile is required')
    console.log(JSON.stringify(await inspectProfile(values.profile, values.harness), null, 2))
  }
}

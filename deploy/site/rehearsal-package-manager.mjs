/** Select one package manager for an isolated rehearsal and every nested install. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

const reject = message => { throw Object.assign(new Error(message), { code: 'PKW_MATRIX_PM' }) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"

export async function preparePackageManager({ work, sourcePackageManager, pnpmBin, pnpmVersion, node = process.execPath, basePath = process.env.PATH }) {
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(sourcePackageManager ?? '')) reject('A fixed source pnpm version is required')
  if (typeof node !== 'string' || !isAbsolute(node)) reject('The Node executable must be an absolute path')
  const inheritedPath = basePath ?? '/usr/local/bin:/usr/bin:/bin'
  const explicitBin = pnpmBin !== undefined
  const explicitVersion = pnpmVersion !== undefined
  if (!explicitBin && !explicitVersion) {
    return { packageManager: sourcePackageManager, path: [dirname(node), inheritedPath].join(delimiter),
      evidence: { mode: 'source-pinned', sourcePackageManager, packageManager: sourcePackageManager,
        version: sourcePackageManager.slice('pnpm@'.length), node } }
  }
  if (!explicitBin || !explicitVersion) reject('Private pnpm requires both --pnpm-bin and --pnpm-version')
  if (pnpmVersion !== '11.23.0') reject('The reviewed private pnpm version is 11.23.0')
  if (typeof pnpmBin !== 'string' || !isAbsolute(pnpmBin)) reject('Private pnpm must be an absolute canonical file path')
  const entry = await realpath(pnpmBin)
  if (entry !== pnpmBin || !(await lstat(pnpmBin)).isFile()) reject('Private pnpm must be an absolute canonical regular file')
  const nodePath = await realpath(node)
  if (!(await lstat(nodePath)).isFile()) reject('The Node executable must be a regular file')
  const workPath = resolve(work)
  if (await realpath(workPath) !== workPath || !(await lstat(workPath)).isDirectory()) reject('The rehearsal work directory must be canonical')

  const entrySha256 = sha256(await readFile(entry))
  const bin = join(workPath, 'bin'), launcher = join(bin, 'pnpm')
  // A mismatch must stop the install. It must never download or run the old pin.
  const bytes = Buffer.from(`#!/bin/sh\nexec ${quote(nodePath)} ${quote(entry)} --pm-on-fail=error "$@"\n`)
  await mkdir(bin, { mode: 0o700 })
  await writeFile(launcher, bytes, { flag: 'wx', mode: 0o700 })
  const packageManager = `pnpm@${pnpmVersion}`
  return { packageManager, path: [bin, dirname(nodePath), inheritedPath].join(delimiter),
    evidence: { mode: 'private-pinned', sourcePackageManager, packageManager, version: pnpmVersion,
      node: nodePath, pnpmBin: entry, entrySha256, launcher, launcherSha256: sha256(bytes), pmOnFail: 'error' } }
}

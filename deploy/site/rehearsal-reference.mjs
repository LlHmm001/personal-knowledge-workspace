/** Build a disposable runner whose lib baseline is verified release bytes, not a source compilation. */
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { readArtifactFiles } from './rehearsal-artifacts.mjs'

const PKW = /^@deepseek-ai\/dsh-pkw-[a-z0-9][a-z0-9-]*$/
const MAX_FILE = 128 * 1024 * 1024
const reject = message => { throw Object.assign(new Error(message), { code: 'PKW_REHEARSAL_REFERENCE_INVALID' }) }
const inside = (root, path) => path === root || path.startsWith(root + sep)
const excluded = name => ['.git', 'node_modules', 'lib'].includes(name) || name.startsWith('.pkw-')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function canonicalDirectory(path, label) {
  const absolute = resolve(path), info = await lstat(absolute)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) reject(`${label} must be a canonical directory`)
  return absolute
}

async function sourceFile(path) {
  if (await realpath(path) !== path) reject('Checkout file traverses a symbolic link')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > MAX_FILE) reject('Checkout entries must be bounded regular files or directories')
    const bytes = await file.readFile(), after = await file.stat()
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject('Checkout file changed while being copied')
    return { bytes, mode: before.mode & 0o777 }
  } finally { await file.close() }
}

async function manifestAt(path) {
  const { bytes } = await sourceFile(path)
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { reject('Checkout package manifest is not valid JSON') }
  if (!manifest || typeof manifest !== 'object' || !PKW.test(manifest.name ?? '')) reject('Checkout PKW package name is invalid')
  return { manifest, bytes }
}

async function copyCheckout(source, destination) {
  await canonicalDirectory(source, 'Checkout subtree')
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excluded(entry.name)) continue
    const from = join(source, entry.name), to = join(destination, entry.name)
    if (entry.isSymbolicLink()) reject('Checkout symbolic links are unsupported')
    if (entry.isDirectory()) {
      await mkdir(to, { mode: 0o700 })
      await copyCheckout(from, to)
    } else if (entry.isFile()) {
      const { bytes, mode } = await sourceFile(from)
      await writeFile(to, bytes, { flag: 'wx', mode: 0o600 })
      await chmod(to, mode)
    } else reject('Checkout special files are unsupported')
  }
}

/** Never changes the checkout or tarballs. On failure a newly created runner is retained. */
export async function createArtifactRunner(checkout, freshTarget, newArtifacts) {
  const source = await canonicalDirectory(checkout, 'Checkout'), runnerRoot = resolve(freshTarget)
  await canonicalDirectory(dirname(runnerRoot), 'Runner parent')
  if (inside(source, runnerRoot) || inside(runnerRoot, source)) reject('Runner and checkout must not overlap')
  try { await lstat(runnerRoot); reject('Runner target already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Array.isArray(newArtifacts) || newArtifacts.length === 0) reject('Verified new artifacts are required')

  const packageRoot = join(source, 'packages/pkw')
  await canonicalDirectory(packageRoot, 'Checkout package root')
  const packages = new Map()
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) reject('Checkout package root must contain package directories only')
    const path = join(packageRoot, entry.name)
    await canonicalDirectory(path, 'Checkout package')
    const item = await manifestAt(join(path, 'package.json'))
    if (packages.has(item.manifest.name)) reject('Checkout has duplicate PKW package names')
    packages.set(item.manifest.name, { directory: entry.name, manifestSha256: hash(item.bytes) })
  }
  if (packages.size !== newArtifacts.length) reject('Artifacts must exactly cover checkout PKW packages')
  const selected = [], seen = new Set(), versions = new Set()
  for (const artifact of newArtifacts) {
    if (!artifact || !packages.has(artifact.name) || seen.has(artifact.name)) reject('Artifact names do not match checkout PKW packages')
    seen.add(artifact.name); versions.add(artifact.version)
    const payload = await readArtifactFiles(artifact)
    const files = [...payload.files].filter(([name]) => name.startsWith('lib/'))
    if (!files.length || !payload.files.has('lib/index.js')) reject(`Artifact has no runtime lib/index.js: ${artifact.name}`)
    selected.push({ artifact, sourcePackage: packages.get(artifact.name), files })
  }
  if (versions.size !== 1) reject('Artifact runner requires a single release version')

  // Exclusive creation is the ownership boundary. No existing target is cleared or reused.
  await mkdir(runnerRoot, { mode: 0o700 })
  await copyCheckout(source, runnerRoot)
  const results = []
  for (const { artifact, sourcePackage, files } of selected) {
    const targetPackage = join(runnerRoot, 'packages/pkw', sourcePackage.directory)
    const copiedManifest = await sourceFile(join(targetPackage, 'package.json'))
    if (hash(copiedManifest.bytes) !== sourcePackage.manifestSha256) reject('Checkout package manifest changed during runner creation')
    const directories = new Set([targetPackage])
    for (const [name, bytes] of files) {
      const parts = name.split('/'), target = join(targetPackage, ...parts)
      if (!inside(targetPackage, target)) reject('Artifact lib path leaves its source package')
      let parent = targetPackage
      for (const segment of parts.slice(0, -1)) {
        parent = join(parent, segment)
        if (!directories.has(parent)) { await mkdir(parent, { mode: 0o700 }); directories.add(parent) }
      }
      await writeFile(target, bytes, { flag: 'wx', mode: 0o644 })
      if (hash((await sourceFile(target)).bytes) !== hash(bytes)) reject('Written artifact reference differs from release payload')
    }
    results.push({ name: artifact.name, version: artifact.version, sourceDirectory: sourcePackage.directory, artifactSha256: artifact.sha256, libFiles: files.length })
  }
  const report = { runnerRoot, basis: 'verified-release-artifacts', compiled: false, version: [...versions][0], packages: results }
  await writeFile(join(runnerRoot, '.pkw-artifact-reference.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return report
}

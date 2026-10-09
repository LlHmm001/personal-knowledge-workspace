/** Seed pnpm package bytes only; the private package manager rebuilds its own index. */
import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const inside = (root, path) => path === root || path.startsWith(root + sep)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

async function regularTree(path) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) fail('PKW_MATRIX_STORE_LINK', `Package cache payload contains a symbolic link: ${path}`)
  if (info.isFile()) return info.size
  if (!info.isDirectory()) fail('PKW_MATRIX_STORE_TYPE', `Unsupported cache entry: ${path}`)
  let bytes = 0
  for (const entry of await readdir(path)) bytes += await regularTree(join(path, entry))
  return bytes
}

async function canonicalDir(path) {
  const absolute = resolve(path), info = await lstat(absolute)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) {
    fail('PKW_MATRIX_STORE_PATH', 'Store directories must be canonical real directories')
  }
  return absolute
}

export async function inspectPnpmStore(source) {
  const sourceRoot = await canonicalDir(source)
  const files = join(sourceRoot, 'files')
  const bytes = await regularTree(files)
  if (!(await lstat(files)).isDirectory()) fail('PKW_MATRIX_STORE_TYPE', 'pnpm v11 files must be a directory')
  return {
    sourceRoot, bytes, selected: ['files'], indexPolicy: 'rebuild-in-private-store',
    // Do not open source SQLite: even a readOnly connection may create/update WAL/SHM.
    // projects/ intentionally links to other projects; no excluded entry is traversed.
    excluded: (await readdir(sourceRoot)).filter(name => name !== 'files').sort(),
  }
}

export async function copyPnpmStore(source, destination) {
  const plan = await inspectPnpmStore(source), targetRoot = resolve(destination)
  if (inside(plan.sourceRoot, targetRoot) || inside(targetRoot, plan.sourceRoot)) {
    fail('PKW_MATRIX_STORE_PATH', 'Private and source stores must not overlap')
  }
  await canonicalDir(dirname(targetRoot))
  // Never overwrite or silently adopt a partially copied cache.
  await mkdir(targetRoot, { mode: 0o700 })
  await cp(join(plan.sourceRoot, 'files'), join(targetRoot, 'files'), {
    recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true,
  })
  // Recheck what was copied; a link introduced during the copy cannot pass.
  await regularTree(targetRoot)
  return { ...plan, targetRoot, linksCopied: 0 }
}

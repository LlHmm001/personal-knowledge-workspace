#!/usr/bin/env node
/**
 * Copy a collaboration data root into a target directory, self-contained.
 *
 * Two properties matter and a plain `cp` provides neither:
 *
 *   1. **Consistency.** SQLite databases are copied with SQLite's own snapshot
 *      (`VACUUM INTO`). Copying the files and then deleting the WAL does not make a
 *      consistent copy: the WAL holds committed rows, so deleting it silently drops
 *      committed work.
 *   2. **Isolation.** A copy that still names the source will write the source's files.
 *      Only *declared* path fields are remapped — never free text — so note bodies and
 *      titles that happen to contain a similar string are left byte-identical, and
 *      permission bits are preserved.
 *
 * The snapshot is written directly to its final destination; nothing is written to a
 * temporary directory and moved afterwards, so every absolute path in the result was
 * remapped for the destination it now lives in.
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Path-valued columns/keys that must be remapped.
 * Keys are matched inside JSON values; columns are matched by name. Anything not listed
 * here is copied verbatim, which is what keeps note text out of the rewriting.
 */
export const PATH_KEYS = Object.freeze([
  { table: 'u_workspace_workspaces', jsonKey: 'path' },
  { table: 'u_pkw_attachments_attachments', jsonKey: 'absolutePath' },
  { table: 'u_pkw_weknora_sync_processing', jsonKey: 'filePath' },
])
/** Absolute path columns stored as plain text rather than JSON. */
export const PATH_COLUMNS = Object.freeze(['path', 'absolutepath', 'filepath', 'rootpath'])

/** Remap one string only when it actually names the source root. */
export function remapPath(value, sourceRoot, targetRoot) {
  if (typeof value !== 'string' || !value.includes(sourceRoot)) return { value, changed: false }
  // Replace the source prefix specifically, not every occurrence anywhere in the text.
  const prefix = value.startsWith(sourceRoot) ? sourceRoot : null
  if (!prefix) return { value, changed: false }
  return { value: targetRoot + value.slice(prefix.length), changed: true }
}

/** Remap only the declared path fields inside a JSON document, leaving everything else. */
export function remapJsonDocument(raw, sourceRoot, targetRoot, jsonKeys) {
  let doc
  try { doc = JSON.parse(raw) } catch { return { raw, changed: false, remapped: [] } }
  const remapped = []
  for (const key of jsonKeys) {
    if (!Object.prototype.hasOwnProperty.call(doc, key)) continue
    const result = remapPath(doc[key], sourceRoot, targetRoot)
    if (result.changed) { remapped.push({ key, from: doc[key], to: result.value }); doc[key] = result.value }
  }
  return { raw: JSON.stringify(doc), changed: remapped.length > 0, remapped }
}

/**
 * Copy `sourceRoot` into `targetRoot` (which must not already exist).
 * Returns { targetRoot, rewritten, leaks, databases }.
 */
export async function copyDataRoot(sourceRoot, targetRoot, options = {}) {
  if (existsSync(targetRoot)) {
    const entries = await readdir(targetRoot)
    if (entries.length > 0) throw new Error(`target directory is not empty (${entries.length} entries): ${targetRoot}`)
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o700 })

  const snapshot = async (from, to) => {
    await mkdir(join(to, '..'), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(from, { readOnly: true })
    try { await db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`) } finally { db.close() }
    const mode = (await stat(from)).mode & 0o777
    const { chmod } = await import('node:fs/promises')
    await chmod(to, mode)
  }

  const rewritten = []
  const databases = []
  if (existsSync(join(sourceRoot, 'identity.sqlite'))) {
    await snapshot(join(sourceRoot, 'identity.sqlite'), join(targetRoot, 'identity.sqlite'))
    databases.push('identity.sqlite')
  }
  const spacesDir = join(sourceRoot, 'spaces')
  for (const space of await readdir(spacesDir, { withFileTypes: true }).catch(() => [])) {
    if (!space.isDirectory()) continue
    const from = join(spacesDir, space.name)
    const to = join(targetRoot, 'spaces', space.name)
    await mkdir(to, { recursive: true, mode: 0o700 })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      // A WAL or SHM belongs to a live writer and must never be copied: the snapshot
      // already carries its committed content.
      if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm') || entry.name === 'state.sqlite' || entry.name === 'gateway.lock') continue
      await cp(join(from, entry.name), join(to, entry.name), { recursive: true, preserveTimestamps: true })
    }
    if (!existsSync(join(from, 'state.sqlite'))) continue
    await snapshot(join(from, 'state.sqlite'), join(to, 'state.sqlite'))
    databases.push(join('spaces', space.name, 'state.sqlite'))

    const db = new DatabaseSync(join(to, 'state.sqlite'))
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name))
      for (const spec of PATH_KEYS) {
        if (!tables.includes(spec.table)) continue
        for (const row of db.prepare(`SELECT rowid AS rid, value FROM "${spec.table}"`).all()) {
          const result = remapJsonDocument(row.value, sourceRoot, targetRoot, [spec.jsonKey])
          if (!result.changed) continue
          db.prepare(`UPDATE "${spec.table}" SET value=? WHERE rowid=?`).run(result.raw, row.rid)
          for (const item of result.remapped) rewritten.push({ table: spec.table, key: item.key, from: item.from, to: item.to })
        }
      }
      for (const table of tables) {
        for (const column of db.prepare(`PRAGMA table_info("${table}")`).all().map(c => String(c.name))) {
          if (!PATH_COLUMNS.includes(column.toLowerCase())) continue
          for (const row of db.prepare(`SELECT rowid AS rid, "${column}" AS value FROM "${table}" WHERE typeof("${column}")='text'`).all()) {
            const result = remapPath(row.value, sourceRoot, targetRoot)
            if (!result.changed) continue
            db.prepare(`UPDATE "${table}" SET "${column}"=? WHERE rowid=?`).run(result.value, row.rid)
            rewritten.push({ table, key: column, from: row.value, to: result.value })
          }
        }
      }
    } finally { db.close() }
  }

  const leaks = await findLeaks(sourceRoot, targetRoot)
  return { targetRoot, rewritten, leaks, databases }
}

/**
 * Any file, database path field or symlink inside the copy that still names the source.
 *
 * Links are resolved with `realpath`, so a *relative* link or a link that points at
 * another link which finally reaches the source is caught as well: comparing the link's
 * literal text alone would miss both.
 */
export async function findLeaks(sourceRoot, targetRoot) {
  const leaks = []
  const { readlink, realpath } = await import('node:fs/promises')
  const sourceReal = await realpath(sourceRoot).catch(() => sourceRoot)
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const literal = await readlink(full).catch(() => '')
        const resolved = await realpath(full).catch(() => null)
        if (literal.includes(sourceRoot) || (resolved && (resolved === sourceReal || resolved.startsWith(sourceReal + sep)))) {
          leaks.push({ path: full, target: literal, resolved: resolved ?? 'dangling' })
        }
        continue
      }
      // A real subdirectory reached through a link must be walked too, because the copy
      // may contain the source tree behind a perfectly ordinary-looking directory.
      const real = await realpath(full).catch(() => null)
      if (real && real !== full && (real === sourceReal || real.startsWith(sourceReal + sep))) {
        leaks.push({ path: full, target: 'directory-resolves-into-source', resolved: real })
        continue
      }
      if (entry.isDirectory()) { await walk(full); continue }
      if (entry.name.endsWith('.sqlite')) {
        const db = new DatabaseSync(full, { readOnly: true })
        try {
          for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name))) {
            for (const column of db.prepare(`PRAGMA table_info("${table}")`).all().map(c => String(c.name))) {
              for (const row of db.prepare(`SELECT "${column}" AS value FROM "${table}" WHERE typeof("${column}")='text'`).all()) {
                if (typeof row.value === 'string' && row.value.includes(sourceRoot)) leaks.push({ path: full, table, column })
              }
            }
          }
        } catch { /* not a database we can read */ } finally { db.close() }
        continue
      }
      const bytes = await readFile(full).catch(() => null)
      if (bytes && bytes.includes(Buffer.from(sourceRoot))) leaks.push({ path: full })
    }
  }
  await walk(targetRoot)
  return leaks
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(resolve(process.argv[1])).href) {
  const [source, target] = process.argv.slice(2)
  if (!source || !target) { process.stderr.write('Usage: node scripts/copy-data-root.mjs SOURCE TARGET\n'); process.exit(2) }
  const result = await copyDataRoot(resolve(source), resolve(target))
  console.log(JSON.stringify({ target: result.targetRoot, databases: result.databases.length, rewritten: result.rewritten.length, leaks: result.leaks.length }, null, 2))
  if (result.leaks.length) { console.error('copy is not self-contained'); process.exit(1) }
}

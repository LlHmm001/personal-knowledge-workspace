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
 * Resolve a declared writable path field and confirm it lands inside the copy.
 *
 * A field can be remapped and still point outside — through a symlink, or because the
 * value was an alias of the source rather than the literal source path. Remapping alone is
 * therefore not enough: the *final target* has to be checked.
 */
export async function assertWritablePathInsideCopy(value, targetRoot, sourceRoot) {
  const { realpath } = await import('node:fs/promises')
  const problems = []
  const targetReal = await realpath(targetRoot).catch(() => targetRoot)
  if (typeof value !== 'string' || value === '') return { ok: true, problems }
  if (value.includes(sourceRoot)) problems.push({ value, reason: 'names-the-source' })
  if (!value.startsWith(targetRoot) && !value.startsWith(targetReal)) problems.push({ value, reason: 'outside-the-copy' })
  // Resolve the deepest existing ancestor: a write path may not exist yet.
  let probe = value
  let real = null
  for (let depth = 0; depth < 12; depth += 1) {
    real = await realpath(probe).catch(() => null)
    if (real) break
    const parent = join(probe, '..')
    if (parent === probe) break
    probe = parent
  }
  if (real && !(real === targetReal || real.startsWith(targetReal + sep))) {
    problems.push({ value, resolved: real, reason: 'resolves-outside-the-copy' })
  }
  if (real && real !== value) {
    // The value resolves somewhere other than itself. That is only acceptable when the
    // resolved location is still inside the copy; a link inside the copy that points back
    // at the source would otherwise be invisible to a literal prefix comparison.
    const sourceReal = await realpath(sourceRoot).catch(() => sourceRoot)
    if (real === sourceReal || real.startsWith(sourceReal + sep)) {
      problems.push({ value, resolved: real, reason: 'alias-resolves-into-the-source' })
    }
  }
  return { ok: problems.length === 0, problems, resolved: real }
}

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

/**
 * Remap one path field, deciding by its *real* location rather than its text.
 *
 * A field may name the source directly, or reach it through a symlink, or point at a
 * directory that no longer exists. Comparing prefixes alone cannot tell those apart, and a
 * literal prefix rewrite of an alias produces a path that exists nowhere — the reference is
 * silently lost.
 *
 * `workspaceMap` maps a source workspace directory to its counterpart in the copy, so an
 * aliased workspace path lands on the copied workspace.
 */
export function remapPathReal(value, sourceRoot, targetRoot, resolved, workspaceMap = new Map()) {
  if (typeof value !== 'string' || value === '') return { value, changed: false, reason: 'empty' }
  for (const [sourceWorkspace, targetWorkspace] of workspaceMap) {
    if (resolved && (resolved === sourceWorkspace || resolved.startsWith(sourceWorkspace + sep))) {
      return { value: targetWorkspace + resolved.slice(sourceWorkspace.length), changed: true, reason: 'remapped-by-real-location' }
    }
    if (value === sourceWorkspace || value.startsWith(sourceWorkspace + sep)) {
      return { value: targetWorkspace + value.slice(sourceWorkspace.length), changed: true, reason: 'remapped-by-literal-prefix' }
    }
  }
  if (resolved && (resolved === sourceRoot || resolved.startsWith(sourceRoot + sep))) {
    return { value: targetRoot + resolved.slice(sourceRoot.length), changed: true, reason: 'remapped-by-real-location-from-root' }
  }
  const literal = remapPath(value, sourceRoot, targetRoot)
  if (literal.changed) return { ...literal, reason: 'remapped-by-literal-prefix-from-root' }
  return { value, changed: false, reason: 'not-a-source-path' }
}

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
export async function copyDataRoot(sourceRootInput, targetRootInput, options = {}) {
  // Normalise both roots first: the mapping and every leak decision compare real locations,
  // so a symlinked source or target must not change the answer.
  const { realpath } = await import('node:fs/promises')
  const sourceRoot = await realpath(resolve(sourceRootInput)).catch(() => resolve(sourceRootInput))
  if (existsSync(targetRootInput)) {
    const entries = await readdir(resolve(targetRootInput))
    if (entries.length > 0) throw new Error(`target directory is not empty (${entries.length} entries): ${resolve(targetRootInput)}`)
  }
  await mkdir(resolve(targetRootInput), { recursive: true, mode: 0o700 })
  // The target is normalised through the filesystem as well, so that the real roots returned here
  // are the same ones every decision below was made with. A caller that configures a runtime with
  // a different spelling of the same directory would otherwise be configuring a different answer.
  const targetRoot = await realpath(resolve(targetRootInput)).catch(() => resolve(targetRootInput))

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
  // source workspace directory -> its counterpart in the copy, used to remap by real location
  const workspaceMap = new Map()
  const sourceSpaces = join(sourceRoot, 'spaces')
  for (const space of await readdir(sourceSpaces, { withFileTypes: true }).catch(() => [])) {
    if (!space.isDirectory()) continue
    workspaceMap.set(join(sourceSpaces, space.name, 'workspace'), join(targetRoot, 'spaces', space.name, 'workspace'))
  }
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
          let doc
          try { doc = JSON.parse(row.value) } catch { continue }
          if (!(spec.jsonKey in doc) || typeof doc[spec.jsonKey] !== 'string') continue
          const original = doc[spec.jsonKey]
          const resolved = await import('node:fs/promises').then(m => m.realpath(original).catch(() => null))
          const result = remapPathReal(original, sourceRoot, targetRoot, resolved, workspaceMap)
          if (!result.changed) continue
          doc[spec.jsonKey] = result.value
          db.prepare(`UPDATE "${spec.table}" SET value=? WHERE rowid=?`).run(JSON.stringify(doc), row.rid)
          rewritten.push({ table: spec.table, key: spec.jsonKey, from: original, to: result.value, how: result.reason })
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

  const writableProblems = await findWritableProblems({ sourceRoot, targetRoot })

  const leaks = await findLeaks(sourceRoot, targetRoot)
  // ── the isolation gate, decided here rather than by each caller ────────────────
  // Every caller of this function needs the same answer: a copy that still names the source, or
  // whose declared write paths reach outside itself, may never be served. Deciding it inside the
  // library means a caller cannot forget to ask, and cannot start a runtime on a copy that failed
  // the check. The scene is preserved: the copy stays on disk exactly as it was produced, with the
  // findings attached to the error, and nothing is cleaned up.
  refuseIfNotIsolated({ sourceRoot, targetRoot, leaks, writableProblems, databases, rewritten })
  return { sourceRoot, targetRoot, rewritten, leaks, databases, writableProblems }
}

/** The library's own isolation refusal, carrying the findings and the roots they were made about. */
export function refuseIfNotIsolated({ sourceRoot, targetRoot, leaks, writableProblems, databases = [], rewritten = [] }) {
  if (leaks.length === 0 && writableProblems.length === 0) return
  const failure = new Error(`the copy in ${targetRoot} is not isolated from ${sourceRoot}: ${leaks.length} leak(s), ${writableProblems.length} writable path problem(s)`)
  failure.code = 'PKW_COPY_NOT_ISOLATED'
  failure.sourceRoot = sourceRoot
  failure.targetRoot = targetRoot
  failure.leaks = leaks
  failure.writableProblems = writableProblems
  failure.databases = databases
  failure.rewritten = rewritten
  throw failure
}

/**
 * Re-check a data root that already exists, instead of trusting that it was checked before.
 *
 * A copy that fails the gate is deliberately left on disk so the failure can be inspected — and
 * that preserved copy is exactly what a second run of the same work directory would find. Its
 * presence proves nothing about whether it is isolated: it may be the very copy that was refused.
 * So an existing root is verified again, in full, before anything is configured against it, and a
 * root that fails is refused again rather than reused.
 *
 * `sourceRoot` must be the same source the copy was made from; when it is unknown the caller
 * cannot re-verify and must not reuse the directory at all.
 */
export async function verifyExistingCopy(sourceRootInput, targetRootInput) {
  if (!sourceRootInput) {
    const unknown = new Error(`cannot verify the data root ${targetRootInput}: the source it was copied from is unknown, so reuse cannot be justified`)
    unknown.code = 'PKW_COPY_SOURCE_UNKNOWN'
    unknown.targetRoot = resolve(targetRootInput)
    throw unknown
  }
  const { realpath } = await import('node:fs/promises')
  const sourceRoot = await realpath(resolve(sourceRootInput)).catch(() => resolve(sourceRootInput))
  const targetRoot = await realpath(resolve(targetRootInput)).catch(() => resolve(targetRootInput))
  const leaks = await findLeaks(sourceRoot, targetRoot)
  const writableProblems = await findWritableProblems({ sourceRoot, targetRoot })
  refuseIfNotIsolated({ sourceRoot, targetRoot, leaks, writableProblems })
  return { sourceRoot, targetRoot, leaks, writableProblems, reused: true }
}

/** True when a thrown copy failure is the library's own isolation refusal. */
export function isNotIsolated(error) {
  return Boolean(error) && error.code === 'PKW_COPY_NOT_ISOLATED'
}

/**
 * Every declared writable path field that does not resolve inside the copy.
 *
 * A field may be remapped and still reach outside — through a symlink, or because the value never
 * named the source to begin with. Used both when a copy is produced and when an existing root is
 * re-verified, so the two cannot drift apart.
 */
export async function findWritableProblems({ sourceRoot, targetRoot }) {
  const problems = []
  for (const spec of PATH_KEYS) {
    for (const space of await readdir(join(targetRoot, 'spaces'), { withFileTypes: true }).catch(() => [])) {
      if (!space.isDirectory()) continue
      const dbPath = join(targetRoot, 'spaces', space.name, 'state.sqlite')
      if (!existsSync(dbPath)) continue
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name))
        if (!tables.includes(spec.table)) continue
        for (const row of db.prepare(`SELECT rowid AS rid, value FROM "${spec.table}"`).all()) {
          let doc
          try { doc = JSON.parse(row.value) } catch { continue }
          if (!(spec.jsonKey in doc)) continue
          const check = await assertWritablePathInsideCopy(doc[spec.jsonKey], targetRoot, sourceRoot)
          if (!check.ok) problems.push({ table: spec.table, key: spec.jsonKey, rowid: row.rid, ...check })
        }
      } finally { db.close() }
    }
  }
  return problems
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
        const targetRealRoot = await realpath(targetRoot).catch(() => targetRoot)
        if (literal.includes(sourceRoot) || (resolved && (resolved === sourceReal || resolved.startsWith(sourceReal + sep)))) {
          leaks.push({ path: full, target: literal, resolved: resolved ?? 'dangling' })
        } else if (resolved && !(resolved === targetRealRoot || resolved.startsWith(targetRealRoot + sep))) {
          // A link that escapes the copy entirely is a leak too: a write through it lands
          // outside the tree the caller thinks it owns.
          leaks.push({ path: full, target: literal, resolved, reason: 'escapes-the-copy' })
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
  try {
    const result = await copyDataRoot(resolve(source), resolve(target))
    console.log(JSON.stringify({ target: result.targetRoot, databases: result.databases.length, rewritten: result.rewritten.length, leaks: 0 }, null, 2))
  } catch (error) {
    // The copy is left in place for inspection; only the verdict is reported.
    console.error(JSON.stringify({
      status: error.code ?? 'failed', message: error.message,
      target: error.targetRoot ?? resolve(target), preserved: true,
      leaks: (error.leaks ?? []).slice(0, 3), writableProblems: (error.writableProblems ?? []).slice(0, 3),
    }, null, 2))
    process.exit(1)
  }
}

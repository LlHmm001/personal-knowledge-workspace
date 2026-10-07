/**
 * Synthetic fixtures for the deployment tests.
 *
 * Everything here is generated: no test reads a production profile, a production data
 * root, or any site path. The data root is built the way the product builds one —
 * an identity store with a known owner, a space with a workspace — so the tests
 * exercise real code rather than a mock, and every writable path inside the copy
 * points at the copy.
 */
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'

const scrypt = promisify(scryptCallback)

export const SYNTHETIC_PASSWORD = 'synthetic-test-passphrase-only'

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
  return `scrypt-v1:${salt}:${derived.toString('hex')}`
}

/** Create an identity store + one private space + one note, entirely synthetic. */
export async function makeSyntheticDataRoot({ owner = 'owner', noteBody = '# synthetic note\n\nbody\n', attachment = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pkw-synth-data-'))
  const userId = `usr_${randomBytes(16).toString('hex')}`
  const spaceId = `sp_${randomBytes(16).toString('hex')}`
  const workspaceId = randomUUID()
  const noteId = `note_${randomBytes(6).toString('hex')}`

  // The identity schema must match what the gateway validates, including the
  // user_version marker: a schema it rejects is not a usable fixture.
  const identity = new DatabaseSync(join(root, 'identity.sqlite'))
  identity.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE accounts(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
    CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('private','team')), ownerId TEXT NOT NULL REFERENCES accounts(id));
    CREATE UNIQUE INDEX one_private_space ON spaces(ownerId) WHERE kind='private';
    CREATE TABLE members(spaceId TEXT NOT NULL REFERENCES spaces(id), userId TEXT NOT NULL REFERENCES accounts(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')), PRIMARY KEY(spaceId,userId));
    CREATE TABLE invitations(hash TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES spaces(id), role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), createdBy TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
    CREATE TABLE sessions(hash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES accounts(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL, seen INTEGER NOT NULL);
    CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, spaceId TEXT, action TEXT NOT NULL, subject TEXT NOT NULL);
  `)
  identity.prepare('INSERT INTO accounts(id,username,password) VALUES(?,?,?)').run(userId, owner, await hashPassword(SYNTHETIC_PASSWORD))
  identity.prepare('INSERT INTO spaces(id,name,kind,ownerId) VALUES(?,?,?,?)').run(spaceId, 'synthetic space', 'private', userId)
  identity.prepare('INSERT INTO members(spaceId,userId,role) VALUES(?,?,?)').run(spaceId, userId, 'owner')
  identity.close()

  const spaceDir = join(root, 'spaces', spaceId)
  const workspaceDir = join(spaceDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 })
  const relativePath = 'synthetic/note.md'
  await mkdir(join(workspaceDir, 'synthetic'), { recursive: true, mode: 0o700 })
  await writeFile(join(workspaceDir, relativePath), noteBody)
  const contentHash = createHash('sha256').update(noteBody).digest('hex')

  const state = new DatabaseSync(join(spaceDir, 'state.sqlite'))
  state.exec(`
    CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
    CREATE TABLE u_workspace_workspaces (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE u_pkw_notes_note_index (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE u_pkw_notes_note_paths (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE u_pkw_commits (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE u_pkw_attachments_attachments (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE u_pkw_tasks_tasks (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `)
  for (const [name, version] of [['workspace', 2], ['pkw', 1], ['pkw_notes', 3], ['pkw_attachments', 1], ['pkw_tasks', 1], ['pkw_weknora_sync', 3]]) {
    state.prepare('INSERT INTO units VALUES(?,?)').run(name, version)
  }
  // The workspace path is absolute in the product's own schema; a copy that keeps the
  // source path would write to the source, which is exactly what tests must detect.
  state.prepare('INSERT INTO u_workspace_workspaces VALUES(?,?)').run(workspaceId, JSON.stringify({
    path: workspaceDir, title: 'synthetic workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }))
  state.prepare('INSERT INTO u_pkw_notes_note_index VALUES(?,?)').run(noteId, JSON.stringify({
    noteId, workspaceId, relativePath, title: 'note', tags: [], contentHash, observedRevision: 1,
    fileSize: Buffer.byteLength(noteBody), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }))
  state.prepare('INSERT INTO u_pkw_notes_note_paths VALUES(?,?)').run(relativePath, JSON.stringify(noteId))
  state.prepare('INSERT INTO u_pkw_commits VALUES(?,?)').run(`note.created:${noteId}`, JSON.stringify({ operationId: `note.created:${noteId}`, workspaceId, actor: { type: 'user', id: userId } }))
  if (attachment) {
    const attachmentId = `att_${randomBytes(6).toString('hex')}`
    const attachmentDir = join(workspaceDir, 'attachments', attachmentId)
    await mkdir(attachmentDir, { recursive: true, mode: 0o700 })
    const bytes = Buffer.from('synthetic attachment payload\n')
    await writeFile(join(attachmentDir, 'payload.bin'), bytes)
    state.prepare('INSERT INTO u_pkw_attachments_attachments VALUES(?,?)').run(attachmentId, JSON.stringify({
      attachmentId, workspaceId, relativePath: `attachments/${attachmentId}/payload.bin`, title: 'payload.bin',
      mimeType: 'application/octet-stream', size: bytes.length, contentHash: createHash('sha256').update(bytes).digest('hex'),
      revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }))
  }
  state.close()
  return { root, spaceId, workspaceId, noteId, relativePath, contentHash, userId }
}

/**
 * Copy a data root the way a rehearsal must: a consistent database snapshot, and every
 * absolute path that pointed at the source rewritten to the copy.
 *
 * The WAL file is not copied, and it is not deleted from a plain copy either: the
 * snapshot is taken with SQLite's own backup API, so it already contains whatever the
 * WAL held.
 */
export async function copyDataRootConsistently(sourceRoot, { stubUrl, spaceId, apiKeyEnv = 'PKW_TEST_RETRIEVAL_KEY' } = {}) {
  const target = await mkdtemp(join(tmpdir(), 'pkw-synth-copy-'))
  // mkdtemp already created the root; the identity snapshot writes into it directly.
  await mkdir(join(target, 'spaces'), { recursive: true, mode: 0o700 })
  const rewrittenPaths = []

  const snapshot = async (from, to) => {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(from, { readOnly: true })
    try { await db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`) } finally { db.close() }
  }

  await snapshot(join(sourceRoot, 'identity.sqlite'), join(target, 'identity.sqlite'))
  const spaces = await readdir(join(sourceRoot, 'spaces'), { withFileTypes: true }).catch(() => [])
  for (const space of spaces) {
    if (!space.isDirectory()) continue
    const from = join(sourceRoot, 'spaces', space.name)
    const to = join(target, 'spaces', space.name)
    await mkdir(to, { recursive: true, mode: 0o700 })
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name === 'state.sqlite' || entry.name.endsWith('-wal') || entry.name.endsWith('-shm')) continue
      await cp(join(from, entry.name), join(to, entry.name), { recursive: true, preserveTimestamps: true })
    }
    await snapshot(join(from, 'state.sqlite'), join(to, 'state.sqlite'))
    // Rewrite every absolute path that pointed at the source; refuse to leave one.
    const statePath = join(to, 'state.sqlite')
    const db = new DatabaseSync(statePath)
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name)
        for (const column of columns) {
          for (const row of db.prepare(`SELECT rowid AS rid, "${column}" AS value FROM "${table}" WHERE typeof("${column}")='text'`).all()) {
            if (typeof row.value !== 'string' || !row.value.includes(sourceRoot)) continue
            const next = row.value.split(sourceRoot).join(target)
            db.prepare(`UPDATE "${table}" SET "${column}"=? WHERE rowid=?`).run(next, row.rid)
            rewrittenPaths.push({ table, column, from: row.value, to: next })
          }
        }
      }
    } finally { db.close() }
  }

  const configPath = join(target, 'collaboration.json')
  await writeFile(configPath, JSON.stringify({
    dataPath: target,
    publicOrigin: 'http://127.0.0.1:0',
    bootstrapUsername: 'owner',
    bootstrapPasswordEnv: 'PKW_TEST_BOOTSTRAP',
    ...(stubUrl ? { retrieval: { [spaceId]: { baseUrl: stubUrl, kbId: 'kb-synthetic', apiKeyEnv } } } : {}),
  }, null, 2) + '\n', { mode: 0o600 })
  return { root: target, configPath, rewrittenPaths }
}

/** Point out every absolute path inside the copy that still names the source root. */
export async function findPathsLeakingTo(sourceRoot, copyRoot) {
  const leaks = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises')
        const link = await readlink(full).catch(() => '')
        if (link.includes(sourceRoot)) leaks.push({ path: full, target: link })
        continue
      }
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.isFile()) continue
      const bytes = await readFile(full).catch(() => null)
      if (bytes && bytes.includes(Buffer.from(sourceRoot))) leaks.push({ path: full })
    }
  }
  await walk(copyRoot)
  return leaks
}

/** A minimal synthetic release profile: the shape a candidate directory has. */
export async function makeSyntheticProfile({ version, root, pkwVersioned = true } = {}) {
  const dir = root ?? await mkdtemp(join(tmpdir(), 'pkw-synth-profile-'))
  const scope = join(dir, 'node_modules/@deepseek-ai')
  await mkdir(scope, { recursive: true, mode: 0o700 })
  const packages = ['attachments', 'base', 'domain', 'events', 'notes', 'tasks', 'web', 'weknora', 'weknora-sync', 'workspace']
  for (const name of packages) {
    const pkgDir = join(scope, `dsh-pkw-${name}`)
    await mkdir(join(pkgDir, 'lib'), { recursive: true, mode: 0o700 })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      name: `@deepseek-ai/dsh-pkw-${name}`, version: pkwVersioned ? version : '0.1.0', type: 'module', main: 'lib/index.js', files: ['lib'],
    }, null, 2) + '\n')
    await writeFile(join(pkgDir, 'lib/index.js'), `export const pkg = 'dsh-pkw-${name}'\nexport const version = '${pkwVersioned ? version : '0.1.0'}'\n`)
  }
  return dir
}

export async function removeIfPresent(path) { await rm(path, { recursive: true, force: true }) }
export { existsSync, symlink }

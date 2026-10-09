import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm, realpath, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { copyPnpmStore, inspectPnpmStore } from '../../deploy/site/rehearsal-store.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-store-copy-')))
  let db
  t.after(async () => { if (db?.isOpen) db.close(); await rm(root, { recursive: true, force: true }) })
  const source = join(root, 'source'), target = join(root, 'private')
  await mkdir(join(source, 'files/ab'), { recursive: true })
  await writeFile(join(source, 'files/ab/content'), 'original cache bytes')
  db = new DatabaseSync(join(source, 'index.db'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID')
  db.prepare('INSERT INTO package_index VALUES (?, ?)').run('committed-in-wal', Buffer.from('payload'))
  return { root, source, target, db }
}

test('store copies package bytes without opening live SQLite or external project registrations', async t => {
  const { root, source, target } = await fixture(t)
  const outside = join(root, 'original-project')
  await mkdir(outside); await writeFile(join(outside, 'precious'), 'do not touch')
  await mkdir(join(source, 'projects')); await symlink(outside, join(source, 'projects/016ce6df'))
  await symlink('/nonexistent/pkw-project', join(source, 'projects/stale'))
  await symlink('links', join(source, 'links')) // Excluded tree is never traversed.
  await mkdir(join(source, 'tmp')); await writeFile(join(source, 'tmp/lock'), 'old lock')
  const beforeNames = await readdir(source)
  const sqliteNames = ['index.db', 'index.db-wal', 'index.db-shm']
  const before = await Promise.all(sqliteNames.map(name => readFile(join(source, name))))
  assert.ok(before[1].length > 0)
  const plan = await inspectPnpmStore(source)
  assert.deepEqual(plan.selected, ['files'])
  assert.ok(plan.excluded.includes('projects'))
  const copied = await copyPnpmStore(source, target)
  assert.equal(copied.indexPolicy, 'rebuild-in-private-store'); assert.equal(copied.linksCopied, 0)
  assert.deepEqual(await readdir(target), ['files'])
  assert.deepEqual(await readdir(source), beforeNames)
  const after = await Promise.all(sqliteNames.map(name => readFile(join(source, name))))
  assert.deepEqual(after, before)
  await writeFile(join(target, 'files/ab/content'), 'private change')
  assert.equal(await readFile(join(source, 'files/ab/content'), 'utf8'), 'original cache bytes')
  assert.equal(await readFile(join(outside, 'precious'), 'utf8'), 'do not touch')
})

test('store still rejects relative and external payload links before copying', async t => {
  const { root, source, target } = await fixture(t)
  for (const value of ['content', join(root, 'missing-external')]) {
    const link = join(source, 'files/ab/alias')
    await symlink(value, link)
    await assert.rejects(copyPnpmStore(source, target), { code: 'PKW_MATRIX_STORE_LINK' })
    await assert.rejects(lstat(target), { code: 'ENOENT' })
    await rm(link)
  }
})

test('store never follows excluded database or SQLite sidecar links', async t => {
  const { root, source, target, db } = await fixture(t)
  db.close(); // Avoid replacing an open SQLite database in this counterexample.
  const realIndex = join(root, 'saved-index.db')
  await writeFile(realIndex, await readFile(join(source, 'index.db')))
  await rm(join(source, 'index.db'))
  await symlink(realIndex, join(source, 'index.db'))
  await symlink('/nonexistent/wal', join(source, 'index.db-wal'))
  const before = await readFile(realIndex)
  await copyPnpmStore(source, target)
  assert.deepEqual(await readdir(target), ['files'])
  assert.deepEqual(await readFile(realIndex), before)
  assert.ok((await lstat(join(source, 'index.db-wal'))).isSymbolicLink())
})

test('store never clears an existing destination', async t => {
  const { source, target } = await fixture(t)
  await mkdir(target); await writeFile(join(target, 'precious'), 'keep')
  await assert.rejects(copyPnpmStore(source, target), { code: 'EEXIST' })
  assert.equal(await readFile(join(target, 'precious'), 'utf8'), 'keep')
})

test('store rejects overlapping roots and leaves source intact', async t => {
  const { root, source } = await fixture(t)
  for (const target of [source, join(source, 'child'), root]) {
    await assert.rejects(copyPnpmStore(source, target), { code: 'PKW_MATRIX_STORE_PATH' })
  }
  assert.equal(await readFile(join(source, 'files/ab/content'), 'utf8'), 'original cache bytes')
})

test('closed WAL databases gain no new sidecars during a content-only copy', async t => {
  const { source, target, db } = await fixture(t)
  db.close()
  const beforeNames = await readdir(source), beforeIndex = await readFile(join(source, 'index.db'))
  assert.ok(!beforeNames.includes('index.db-wal') && !beforeNames.includes('index.db-shm'))
  await copyPnpmStore(source, target)
  assert.deepEqual(await readdir(source), beforeNames)
  assert.deepEqual(await readFile(join(source, 'index.db')), beforeIndex)
  assert.deepEqual(await readdir(target), ['files'])
})

import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AccessError, IdentityStore, type Role } from '../src/collaboration/identity.ts'

// These tests intentionally use the exported store with real SQLite and the
// production scrypt parameters. No password/hash/db methods are mocked.
const PASSWORD = 'Synthetic owner passphrase 2026!'
const NEW_PASSWORD = 'Synthetic changed passphrase 2026!'
const stores = new Set<IdentityStore>()
const dirs: string[] = []
afterEach(async () => {
  for (const store of stores) store.close()
  stores.clear()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-identity-security-'))
  dirs.push(dir)
  return dir
}
async function open(path: string, now?: () => number) {
  const store = await IdentityStore.open(path, now)
  stores.add(store)
  return store
}
async function fixture() {
  const path = join(await directory(), 'identity.sqlite')
  const clock = { now: Date.UTC(2026, 9, 2) }
  const store = await open(path, () => clock.now)
  await store.bootstrap('Owner', PASSWORD)
  const owner = await store.login('OWNER', PASSWORD)
  const team = store.createTeam(owner.session.id, 'Synthetic team')
  async function member(username: string, role: Exclude<Role, 'owner'> = 'editor') {
    const invitation = store.invite(owner.session.id, team.id, role)
    await store.register(invitation.token, username, PASSWORD)
    return store.login(username, PASSWORD)
  }
  return { path, clock, store, owner, team, member }
}
function status(operation: () => unknown, code: number) {
  try { operation(); throw new Error('Expected denial') }
  catch (error) { expect(error).toBeInstanceOf(AccessError); expect((error as AccessError).status).toBe(code) }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('collaboration identity — real SQLite and scrypt security', () => {
  it('keeps a reading-pause session valid and does not purge it when another device logs in', async () => {
    const { store, owner, clock } = await fixture()
    clock.now += 31 * 60_000
    expect(store.session(owner.token)?.id).toBe(owner.session.id)
    clock.now += 60 * 60_000
    const second = await store.login('owner', PASSWORD)
    expect(store.session(owner.token)?.id).toBe(owner.session.id)
    expect(store.session(second.token)?.id).toBe(owner.session.id)
  }, 40_000)

  it('retains an explicitly remembered session through inactivity and restart, but never past 30 days', async () => {
    const { store, owner, clock, path } = await fixture()
    const started = clock.now
    const remembered = await store.login('owner', PASSWORD, true)
    clock.now += 24 * 60 * 60_000
    expect(store.session(remembered.token)?.id).toBe(owner.session.id)
    stores.delete(store); store.close()
    const reopened = await open(path, () => clock.now)
    const spaces = reopened.spaces(owner.session.id)
    expect(reopened.session(remembered.token)?.id).toBe(owner.session.id)
    clock.now = started + 30 * 24 * 60 * 60_000 - 1
    expect(reopened.session(remembered.token)?.id).toBe(owner.session.id)
    clock.now++
    expect(reopened.session(remembered.token)).toBeUndefined()
    expect(reopened.spaces(owner.session.id)).toEqual(spaces)
    const db = new DatabaseSync(path, { readOnly: true })
    try { expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(1) } finally { db.close() }
  }, 40_000)

  it('isolates personal spaces even from team owners/admins and enforces viewer reads', async () => {
    const { store, owner, team, member } = await fixture()
    const viewer = await member('reader', 'viewer'), admin = await member('manager', 'admin')
    const privateOwner = store.spaces(owner.session.id).find(s => s.kind === 'private')!
    const privateViewer = store.spaces(viewer.session.id).find(s => s.kind === 'private')!
    expect(privateOwner.id).not.toBe(privateViewer.id)
    expect(store.spaces(viewer.session.id).map(s => s.id).sort()).toEqual([privateViewer.id, team.id].sort())
    for (const foreign of [owner.session.id, admin.session.id]) status(() => store.authorize(foreign, privateViewer.id), 404)
    status(() => store.authorize(viewer.session.id, privateOwner.id), 404)
    expect(store.authorize(viewer.session.id, team.id).role).toBe('viewer')
    status(() => store.authorize(viewer.session.id, team.id, ['owner', 'admin', 'editor']), 403)
    status(() => store.members(viewer.session.id, team.id), 403)
    status(() => store.invite(viewer.session.id, team.id, 'viewer'), 403)
    status(() => store.invite(owner.session.id, privateOwner.id, 'viewer'), 403)
    status(() => store.authorize(owner.session.id, 'unknown-space'), 404)
  }, 40_000)

  it('prevents admin promotion/owner management and preserves exactly one owner on transfer', async () => {
    const { store, owner, team, member } = await fixture()
    const admin = await member('manager', 'admin'), editor = await member('writer', 'editor')
    status(() => store.setRole(admin.session.id, team.id, editor.session.id, 'admin'), 403)
    status(() => store.setRole(admin.session.id, team.id, admin.session.id, 'editor'), 403)
    status(() => store.setRole(admin.session.id, team.id, owner.session.id, 'viewer'), 400)
    status(() => store.invite(admin.session.id, team.id, 'admin'), 403)
    status(() => store.setRole(owner.session.id, team.id, owner.session.id, null), 400)
    status(() => store.setRole(owner.session.id, team.id, editor.session.id, 'owner'), 400)
    status(() => store.transfer(admin.session.id, team.id, editor.session.id), 403)
    const priorInvite = store.invite(owner.session.id, team.id, 'viewer')
    store.transfer(owner.session.id, team.id, editor.session.id)
    expect(store.members(editor.session.id, team.id).filter(m => m.role === 'owner').map(m => m.id)).toEqual([editor.session.id])
    expect(store.authorize(editor.session.id, team.id).ownerId).toBe(editor.session.id)
    expect(store.authorize(owner.session.id, team.id).role).toBe('admin')
    status(() => store.transfer(owner.session.id, team.id, admin.session.id), 403)
    await expect(store.register(priorInvite.token, 'latejoin', PASSWORD)).rejects.toMatchObject({ status: 400 })
  }, 40_000)

  it('rechecks membership on the next authorization while preserving the removed user private space', async () => {
    const { store, owner, team, member } = await fixture()
    const editor = await member('writer', 'editor')
    const originalSession = store.session(editor.token)!
    const privateId = store.spaces(editor.session.id).find(s => s.kind === 'private')!.id
    expect(store.authorize(originalSession.id, team.id, ['editor']).role).toBe('editor')
    store.setRole(owner.session.id, team.id, editor.session.id, 'viewer')
    status(() => store.authorize(originalSession.id, team.id, ['editor']), 403)
    store.setRole(owner.session.id, team.id, editor.session.id, null)
    status(() => store.authorize(originalSession.id, team.id), 404)
    expect(store.session(editor.token)?.id).toBe(editor.session.id)
    expect(store.authorize(originalSession.id, privateId).role).toBe('owner')
    expect(store.spaces(originalSession.id).map(s => s.id)).toEqual([privateId])
  }, 40_000)

  it('makes invitations one-use and expiring; failed acceptance does not consume a valid invitation', async () => {
    const { store, owner, team, member, clock } = await fixture()
    const existing = await member('existing', 'viewer')
    const duplicate = store.invite(owner.session.id, team.id, 'editor')
    status(() => store.accept(existing.session.id, duplicate.token), 409)
    // A conflict cannot consume the invitation; an entirely new account can accept it.
    await store.register(duplicate.token, 'newperson', PASSWORD)
    await expect(store.register(duplicate.token, 'replay', PASSWORD)).rejects.toMatchObject({ status: 400 })
    const otherTeam = store.createTeam(owner.session.id, 'Other team')
    const token = store.invite(owner.session.id, otherTeam.id, 'viewer')
    store.accept(existing.session.id, token.token)
    expect(store.authorize(existing.session.id, otherTeam.id).role).toBe('viewer')
    status(() => store.accept(existing.session.id, token.token), 400)
    const expired = store.invite(owner.session.id, team.id, 'viewer')
    clock.now = expired.expires
    await expect(store.register(expired.token, 'expired', PASSWORD)).rejects.toMatchObject({ status: 400 })
    await expect(store.register('not-a-token', 'invalid', PASSWORD)).rejects.toMatchObject({ status: 400 })
  }, 40_000)

  it('revalidates invitation revocation and expiry after real scrypt, without leaving partial accounts', async () => {
    const { store, owner, team, clock } = await fixture()
    for (const operation of ['revoke', 'expire'] as const) {
      const invitation = store.invite(owner.session.id, team.id, 'viewer')
      const pending = store.register(invitation.token, 'racing_' + operation, PASSWORD)
      // register has validated the token and is now awaiting real scrypt.
      if (operation === 'revoke') store.revokeInvites(owner.session.id, team.id)
      else clock.now = invitation.expires
      await expect(pending).rejects.toMatchObject({ status: 400 })
      const replacement = store.invite(owner.session.id, team.id, 'viewer')
      await store.register(replacement.token, 'racing_' + operation, PASSWORD)
      // Successful reuse of the username proves failed registration did not persist an account.
      expect(store.members(owner.session.id, team.id).filter(m => m.username === 'racing_' + operation)).toHaveLength(1)
    }
  }, 40_000)

  it('invalidates administrator invitations when the inviter is demoted during registration', async () => {
    const { store, owner, team, member } = await fixture()
    const admin = await member('manager', 'admin')
    const invitation = store.invite(admin.session.id, team.id, 'editor')
    const pending = store.register(invitation.token, 'racing_demotion', PASSWORD)
    store.setRole(owner.session.id, team.id, admin.session.id, 'viewer')
    await expect(pending).rejects.toMatchObject({ status: 400 })
    expect(store.members(owner.session.id, team.id).some(m => m.username === 'racing_demotion')).toBe(false)
    const replacement = store.invite(owner.session.id, team.id, 'viewer')
    await store.register(replacement.token, 'racing_demotion', PASSWORD)
  }, 40_000)

  it('enforces the normal absolute deadline despite activity, rotates login tokens, and supports explicit logout', async () => {
    const { store, owner, clock } = await fixture()
    expect(store.session(undefined)).toBeUndefined()
    expect(store.session('not-a-session')).toBeUndefined()
    expect(store.session('a'.repeat(43))).toBeUndefined()
    clock.now += 30 * 60_000
    expect(store.session(owner.token)?.id).toBe(owner.session.id)
    const current = await store.login('owner', PASSWORD), started = clock.now
    expect(current.token).not.toBe(owner.token)
    expect(current.session.csrf).not.toBe(owner.session.csrf)
    for (let i = 1; i <= 24; i++) {
      clock.now = started + i * (30 * 60_000 - 1)
      expect(store.session(current.token)?.id).toBe(owner.session.id)
    }
    clock.now = started + 12 * 60 * 60_000
    expect(store.session(current.token)).toBeUndefined()
    const fresh = await store.login('owner', PASSWORD)
    store.logout(fresh.session)
    expect(store.session(fresh.token)).toBeUndefined()
  }, 40_000)

  it('requires the old password and invalidates all sessions when changing it, including after reopen', async () => {
    const { store, owner, path, clock } = await fixture()
    const second = await store.login('owner', PASSWORD, true)
    await expect(store.changePassword(owner.session, 'wrong previous passphrase', NEW_PASSWORD)).rejects.toMatchObject({ status: 401 })
    expect(store.session(owner.token)?.id).toBe(owner.session.id)
    expect(store.session(second.token)?.id).toBe(owner.session.id)
    clock.now += 31 * 60_000
    await store.changePassword(owner.session, PASSWORD, NEW_PASSWORD)
    expect(store.session(owner.token)).toBeUndefined(); expect(store.session(second.token)).toBeUndefined()
    await expect(store.login('owner', PASSWORD)).rejects.toMatchObject({ status: 401 })
    const replaced = await store.login('owner', NEW_PASSWORD)
    expect(replaced.session.id).toBe(owner.session.id)
    const spaces = store.spaces(owner.session.id)
    stores.delete(store); store.close()
    const reopened = await open(path, () => clock.now)
    expect(reopened.session(replaced.token)?.id).toBe(owner.session.id)
    expect(reopened.spaces(owner.session.id)).toEqual(spaces)
    expect(reopened.session(owner.token)).toBeUndefined()
  }, 40_000)

  it('rejects ambiguous remember choices and does not renew expiration during reads', async () => {
    const { store, owner, clock } = await fixture()
    for (const value of ['true', 'false', 1, null, {}]) {
      await expect(store.login('owner', PASSWORD, value)).rejects.toMatchObject({ status: 400 })
    }
    const expires = owner.session.expiresAt
    clock.now += 6 * 60 * 60_000
    expect(store.session(owner.token)?.expiresAt).toBe(expires)
    clock.now = expires
    expect(store.session(owner.token)).toBeUndefined()
  }, 40_000)

  it('bounds password attempts and concurrent expensive operations without replacing valid credentials', async () => {
    const { store, owner, clock } = await fixture()
    for (let i = 0; i < 5; i++) await expect(store.login('absent_account', PASSWORD)).rejects.toMatchObject({ status: 401 })
    await expect(store.login('absent_account', PASSWORD)).rejects.toMatchObject({ status: 429 })
    clock.now += 15 * 60_000
    await expect(store.login('absent_account', PASSWORD)).rejects.toMatchObject({ status: 401 })
    const pending = store.login('owner', PASSWORD)
    await expect(store.login('owner', PASSWORD)).rejects.toMatchObject({ status: 429 })
    expect((await pending).session.id).toBe(owner.session.id)
    await store.bootstrap('replacement_owner', NEW_PASSWORD)
    await expect(store.login('replacement_owner', NEW_PASSWORD)).rejects.toMatchObject({ status: 401 })
    expect((await store.login('owner', PASSWORD)).session.id).toBe(owner.session.id)
  }, 40_000)

  it('stores only password hashes and token digests, keeps identity files private, and scopes audit access', async () => {
    const { store, owner, team, path, member } = await fixture()
    const viewer = await member('reader', 'viewer')
    const invitation = store.invite(owner.session.id, team.id, 'editor')
    const audit = JSON.stringify(store.auditLog(owner.session.id, team.id))
    expect(audit).not.toContain(invitation.token); expect(audit).not.toContain(owner.token); expect(audit).not.toContain(PASSWORD)
    status(() => store.auditLog(viewer.session.id, team.id), 403)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    stores.delete(store); store.close()
    const bytes = await readFile(path)
    expect(bytes.includes(Buffer.from(PASSWORD))).toBe(false)
    expect(bytes.includes(Buffer.from(owner.token))).toBe(false)
    expect(bytes.includes(Buffer.from(invitation.token))).toBe(false)
    expect(bytes.includes(Buffer.from('scrypt-v1:'))).toBe(true)
  }, 40_000)

  it('recovers an existing account offline, revokes all its sessions and preserves identities/roles/data', async () => {
    const { store, owner, team, path, member } = await fixture()
    const viewer = await member('reader', 'viewer'), second = await store.login('reader', PASSWORD)
    const beforeSpaces = store.spaces(viewer.session.id), beforeMembers = store.members(owner.session.id, team.id)
    const canonical = join(dirname(path), 'existing-private-canonical.md'), contents = Buffer.from('---\nid: note_original\n---\n原来的资料不能因找回密码而改变\n')
    await writeFile(canonical, contents)
    await expect(store.resetPassword('reader', 'short')).rejects.toMatchObject({ status: 400 })
    expect(store.session(viewer.token)?.id).toBe(viewer.session.id)
    await expect(store.resetPassword('unknown_account', NEW_PASSWORD)).rejects.toMatchObject({ status: 404 })
    await store.resetPassword('READER', NEW_PASSWORD)
    expect(store.session(viewer.token)).toBeUndefined(); expect(store.session(second.token)).toBeUndefined()
    expect(store.session(owner.token)?.id).toBe(owner.session.id)
    await expect(store.login('reader', PASSWORD)).rejects.toMatchObject({ status: 401 })
    const recovered = await store.login('reader', NEW_PASSWORD)
    expect(recovered.session.id).toBe(viewer.session.id)
    expect(store.spaces(recovered.session.id)).toEqual(beforeSpaces)
    expect(store.members(owner.session.id, team.id)).toEqual(beforeMembers)
    expect(store.authorize(recovered.session.id, team.id).role).toBe('viewer')
    status(() => store.authorize(recovered.session.id, team.id, ['owner', 'admin', 'editor']), 403)
    expect(await readFile(canonical)).toEqual(contents)
    stores.delete(store); store.close()
    const reopened = await open(path)
    expect((await reopened.login('reader', NEW_PASSWORD)).session.id).toBe(viewer.session.id)
    expect(reopened.session(viewer.token)).toBeUndefined()
    expect(reopened.spaces(viewer.session.id)).toEqual(beforeSpaces)
  }, 40_000)

  it.each(['unknown-version', 'unknown-v0', 'malformed-v1', 'malformed-columns-v1'] as const)('rejects %s before changing the existing SQLite file', async scenario => {
    const path = join(await directory(), 'existing.sqlite')
    // Construct a separate incompatible input fixture. Never modify a live
    // IdentityStore database or bypass its API to manufacture member state.
    const db = new DatabaseSync(path)
    if (scenario === 'malformed-columns-v1') {
      for (const table of ['accounts', 'audit', 'invitations', 'members', 'sessions', 'spaces']) db.exec(`CREATE TABLE ${table}(unrelated TEXT)`)
      db.exec('PRAGMA user_version=1')
    } else db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'keep historical bytes\')')
    if (scenario === 'unknown-version') db.exec('PRAGMA user_version=99')
    if (scenario === 'malformed-v1') db.exec('PRAGMA user_version=1')
    db.close()
    const before = sha(await readFile(path))
    await expect(open(path)).rejects.toThrow(/schema|unknown|unsupported/i)
    expect(sha(await readFile(path))).toBe(before)
  }, 40_000)
})

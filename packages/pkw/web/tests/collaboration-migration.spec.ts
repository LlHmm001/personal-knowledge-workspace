import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createSpaceRuntime, type SpaceRuntime } from '../src/collaboration/runtime.ts'
import { CollaborationGateway } from '../src/collaboration/index.ts'
import { IdentityStore, type Space } from '../src/collaboration/identity.ts'
import type { Task, TaskMatrix } from '@deepseek-ai/dsh-pkw-domain'

// Exercise the same dependency-free ESM programs operators run, not test copies.
const preservation = await import(new URL('../../../../scripts/data-preservation.mjs', import.meta.url).href)
const collaborationBackup = await import(new URL('../../../../scripts/collaboration-backup.mjs', import.meta.url).href)
const adoption = await import(new URL('../../../../scripts/adopt-private-space.mjs', import.meta.url).href)
const dirs: string[] = [], runtimes = new Set<SpaceRuntime>()
afterEach(async () => {
  for (const runtime of runtimes) await runtime.close()
  runtimes.clear()
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function boot(root: string, space: Space) { const runtime = await createSpaceRuntime(root, space); runtimes.add(runtime); return runtime }
async function close(runtime: SpaceRuntime) { await runtime.close(); runtimes.delete(runtime) }
async function call<T>(runtime: SpaceRuntime, method: string, args: Record<string, unknown> = {}): Promise<T> { return await runtime.web.call(method, args) as T }
interface NoteView { note: { noteId: string; observedRevision: number; contentHash: string }; markdown: string; body: string; attachments: Array<{ attachmentId: string; relativePath: string }> }
function storedRows(database: string, table: string): Array<{ key: string; value: string }> {
  const db = new DatabaseSync(database, { readOnly: true })
  try { return db.prepare(`SELECT key,value FROM "${table}" ORDER BY key`).all().map(row => ({ key: String(row.key), value: String(row.value) })) } finally { db.close() }
}

describe('offline private-space adoption with real Harness storage and services', () => {
  it('preserves content, stable IDs, tasks, history and trash across import and two target runtime opens', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-real-migration-'))); dirs.push(root)
    const legacyRoot = join(root, 'old-runtime'), targetRoot = join(root, 'collaboration')
    const legacySpace: Space = { id: 'sp_' + 'a'.repeat(32), kind: 'private', ownerId: 'legacy-owner', name: '原始私人资料' }
    const legacyDirectory = join(legacyRoot, 'spaces', legacySpace.id), sourceWorkspace = join(legacyDirectory, 'workspace'), sourceDatabase = join(legacyDirectory, 'state.sqlite')
    const source = await boot(legacyRoot, legacySpace)
    const originalSummary = await call<{ workspaceId: string }>(source, 'summary')
    const note = await call<{ noteId: string }>(source, 'createNote', { relativePath: '个人/中文笔记.md', markdown: '# 原始中文标题\n\n必须保留的私人正文。\n' })
    const bytes = Buffer.from([0, 255, 128, 1, 13, 10, 42])
    const attachment = await call<{ attachmentId: string; filename: string }>(source, 'uploadAttachment', { filename: '二进制资料.bin', mimeType: 'application/octet-stream', contentBase64: bytes.toString('base64') })
    await call(source, 'saveNoteBody', { noteId: note.noteId, body: `# 原始中文标题\n\n必须保留的私人正文。\n[二进制资料](attachments/${attachment.attachmentId}/${attachment.filename})\n` })
    const noteBefore = await call<NoteView>(source, 'getNote', { noteId: note.noteId })
    expect(noteBefore.attachments.map(item => item.attachmentId)).toContain(attachment.attachmentId)
    const matrix = await call<TaskMatrix>(source, 'createMatrix', { name: '私人工作计划', description: '迁移保留矩阵' })
    const parent = await call<Task>(source, 'createTask', { title: '中文父任务', matrixId: matrix.matrixId, dueAt: '2026-11-02', important: true, sourceRefs: [{ kind: 'note', noteId: note.noteId }] })
    await call(source, 'updateTask', { taskId: parent.taskId, patch: { scheduledAt: '2026-10-10' } })
    const child = await call<Task>(source, 'createTask', { title: '中文子任务', parentTaskId: parent.taskId, matrixId: matrix.matrixId, dueAt: '2026-10-11' })
    const deletedTask = await call<Task>(source, 'createTask', { title: '回收任务', matrixId: matrix.matrixId })
    await call(source, 'deleteTask', { taskId: deletedTask.taskId })
    const archivedMatrix = await call<TaskMatrix>(source, 'createMatrix', { name: '归档矩阵' })
    await call(source, 'archiveMatrix', { matrixId: archivedMatrix.matrixId })
    const deletedNote = await call<{ noteId: string }>(source, 'createNote', { relativePath: '回收笔记.md', markdown: '# 回收笔记\n旧正文也必须保留\n' })
    const deletedNoteBefore = await call<NoteView>(source, 'getNote', { noteId: deletedNote.noteId })
    await call(source, 'deleteNote', { noteId: deletedNote.noteId })
    const deletedAttachment = await call<{ attachmentId: string }>(source, 'uploadAttachment', { filename: '回收资料.bin', mimeType: 'application/octet-stream', contentBase64: bytes.toString('base64') })
    await call(source, 'deleteAttachment', { attachmentId: deletedAttachment.attachmentId })
    await call(source, 'createFolder', { path: '旧项目/空子目录' })
    const folderNote = await call<{ noteId: string }>(source, 'createNote', { relativePath: '旧项目/项目记录.md', markdown: '# 项目回收资料\n保留目录内正文\n' })
    const folderNoteBefore = await call<NoteView>(source, 'getNote', { noteId: folderNote.noteId })
    const trashFolder = await call<{ trashEntryId: string }>(source, 'trashFolder', { path: '旧项目' })
    const tasksBefore = await call<Task[]>(source, 'listTasks', { includeDeleted: true })
    await close(source)
    const commitsBefore = storedRows(sourceDatabase, 'u_pkw_commits')
    expect(commitsBefore.length).toBeGreaterThan(10)
    const sourceStateBefore = await preservation.inventory(sourceDatabase)
    const sourceWorkspaceBefore = await preservation.inventory(sourceWorkspace)
    const backup = join(root, 'backup')
    const backupResult = await preservation.backupData({ workspace: sourceWorkspace, state: sourceDatabase, output: backup, offlineConfirmed: true })
    expect(backupResult.reconciliation.issues).toEqual([])
    expect(backupResult.reconciliation.identities.taskIds).toEqual(tasksBefore.map(task => task.taskId).sort())

    await mkdir(targetRoot)
    const identity = await IdentityStore.open(join(targetRoot, 'identity.sqlite'))
    let privateSpace: Space
    try {
      await identity.bootstrap('owner', 'temporary-owner-migration-passphrase')
      const login = await identity.login('owner', 'temporary-owner-migration-passphrase')
      privateSpace = identity.spaces(login.session.id).find(space => space.kind === 'private')!
      expect(privateSpace).toBeTruthy()
    } finally { identity.close() }
    const receipt = await adoption.adoptPrivateSpace({ backup, manifestSha256: backupResult.manifestSha256, dataRoot: targetRoot, spaceId: privateSpace!.id, ownerUsername: 'OWNER', offlineConfirmed: true })
    expect(receipt.workspaceId).toBe(originalSummary.workspaceId)
    expect(receipt.runtimeAcceptance).toBe('not_run')
    const targetDirectory = join(targetRoot, 'spaces', privateSpace!.id), targetDatabase = join(targetDirectory, 'state.sqlite')
    expect(storedRows(targetDatabase, 'u_pkw_commits')).toEqual(commitsBefore)
    expect(storedRows(targetDatabase, 'u_workspace_workspaces')).toHaveLength(1)
    expect(JSON.parse(storedRows(targetDatabase, 'u_workspace_workspaces')[0]!.value).path).toBe(join(targetDirectory, 'workspace'))

    const first = await boot(targetRoot, privateSpace!)
    expect((await call<{ workspaceId: string }>(first, 'summary')).workspaceId).toBe(originalSummary.workspaceId)
    const noteAfter = await call<NoteView>(first, 'getNote', { noteId: note.noteId })
    expect(noteAfter.markdown).toBe(noteBefore.markdown)
    expect(noteAfter.note.contentHash).toBe(noteBefore.note.contentHash)
    expect(noteAfter.note.observedRevision).toBe(noteBefore.note.observedRevision)
    expect(noteAfter.attachments).toEqual(noteBefore.attachments)
    expect(Buffer.from((await call<{ contentBase64: string }>(first, 'downloadAttachment', { attachmentId: attachment.attachmentId })).contentBase64, 'base64')).toEqual(bytes)
    expect(await call<Task[]>(first, 'listTasks', { includeDeleted: true })).toEqual(tasksBefore)
    expect((await call<Task[]>(first, 'listSubtasks', { parentTaskId: parent.taskId })).map(task => task.taskId)).toEqual([child.taskId])
    expect((await call<TaskMatrix[]>(first, 'listMatrices', { includeArchived: true })).map(value => value.matrixId).sort()).toEqual([matrix.matrixId, archivedMatrix.matrixId].sort())
    expect((await call<Array<{ noteId: string }>>(first, 'listTrash')).map(row => row.noteId)).toContain(deletedNote.noteId)
    expect((await call<Array<{ attachmentId: string }>>(first, 'listTrashAttachments')).map(row => row.attachmentId)).toContain(deletedAttachment.attachmentId)
    expect((await call<Array<{ trashEntryId: string }>>(first, 'listTrashFolders')).map(row => row.trashEntryId)).toContain(trashFolder.trashEntryId)
    await call(first, 'restoreNote', { noteId: deletedNote.noteId })
    await call(first, 'restoreAttachment', { attachmentId: deletedAttachment.attachmentId })
    await call(first, 'restoreFolder', { trashEntryId: trashFolder.trashEntryId })
    await call(first, 'restoreTask', { taskId: deletedTask.taskId })
    expect((await call<NoteView>(first, 'getNote', { noteId: deletedNote.noteId })).markdown).toBe(deletedNoteBefore.markdown)
    expect((await call<NoteView>(first, 'getNote', { noteId: folderNote.noteId })).markdown).toBe(folderNoteBefore.markdown)
    expect(Buffer.from((await call<{ contentBase64: string }>(first, 'downloadAttachment', { attachmentId: deletedAttachment.attachmentId })).contentBase64, 'base64')).toEqual(bytes)
    await call(first, 'saveNoteBody', { noteId: note.noteId, expectedRevision: noteAfter.note.observedRevision, expectedContentHash: noteAfter.note.contentHash, body: '# 迁入后的新编辑\n旧资料已保留，新增写入可持久化。\n' })
    const saved = await call<NoteView>(first, 'getNote', { noteId: note.noteId })
    await call(first, 'updateTask', { taskId: parent.taskId, patch: { dueAt: '', description: '迁入后更新' } })
    await close(first)

    const second = await boot(targetRoot, privateSpace!)
    expect((await call<{ workspaceId: string }>(second, 'summary')).workspaceId).toBe(originalSummary.workspaceId)
    expect((await call<NoteView>(second, 'getNote', { noteId: note.noteId })).markdown).toBe(saved.markdown)
    const currentTasks = await call<Task[]>(second, 'listTasks', { includeDeleted: true })
    const currentParent = currentTasks.find(task => task.taskId === parent.taskId)!
    expect(currentParent.dueAt).toBeUndefined(); expect(currentParent.scheduledAt).toBe('2026-10-10'); expect(currentParent.description).toBe('迁入后更新')
    expect(currentTasks.find(task => task.taskId === child.taskId)?.parentTaskId).toBe(parent.taskId)
    expect(currentTasks.find(task => task.taskId === deletedTask.taskId)?.deletedAt).toBeUndefined()
    expect((await call<NoteView>(second, 'getNote', { noteId: folderNote.noteId })).markdown).toBe(folderNoteBefore.markdown)
    expect(await call(second, 'listTrashFolders')).toEqual([])
    await close(second)
    const commitsAfter = new Map(storedRows(targetDatabase, 'u_pkw_commits').map(row => [row.key, row.value]))
    for (const row of commitsBefore) expect(commitsAfter.get(row.key)).toBe(row.value)
    expect(commitsAfter.size).toBeGreaterThan(commitsBefore.length)
    expect(storedRows(targetDatabase, 'u_workspace_workspaces').map(row => row.key)).toEqual([originalSummary.workspaceId])
    expect(await preservation.inventory(sourceDatabase)).toEqual(sourceStateBefore)
    expect(await preservation.inventory(sourceWorkspace)).toEqual(sourceWorkspaceBefore)
    expect(await readFile(join(targetDirectory, 'workspace/notes/个人/中文笔记.md'), 'utf8')).toBe(saved.markdown)
    expect((await preservation.verifySource({ backup, manifestSha256: backupResult.manifestSha256 })).sourceUnchanged).toBe(true)
  }, 60_000)
})

describe('whole collaboration cold recovery with real identity and Harness runtimes', () => {
  it('keeps two spaces and an unopened private space, blocks startup pending review, revokes old credentials and reopens mapped registries', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-real-root-recovery-'))); dirs.push(root)
    const sourceRoot = join(root, 'source'), targetRoot = join(root, 'recovered'), password = 'temporary-cold-recovery-owner-passphrase'
    const identity = await IdentityStore.open(join(sourceRoot, 'identity.sqlite'))
    let privateSpace: Space, team: Space, unopened: Space
    try {
      await identity.bootstrap('owner', password)
      const login = await identity.login('owner', password)
      privateSpace = identity.spaces(login.session.id).find(space => space.kind === 'private')!
      team = identity.createTeam(login.session.id, '原团队空间')
      const invite = identity.invite(login.session.id, team.id, 'editor')
      await identity.register(invite.token, 'member', 'temporary-member-cold-recovery-passphrase')
      const member = await identity.login('member', 'temporary-member-cold-recovery-passphrase', true)
      unopened = identity.spaces(member.session.id).find(space => space.kind === 'private')!
      identity.invite(login.session.id, team.id, 'viewer') // Must not become a live invitation after recovery.
    } finally { identity.close() }
    const originals: Array<{ space: Space; workspaceId: string; noteId: string; taskId: string; doc: NoteView }> = []
    for (const space of [privateSpace!, team!]) {
      const runtime = await boot(sourceRoot, space)
      const summary = await call<{ workspaceId: string }>(runtime, 'summary')
      const note = await call<{ noteId: string }>(runtime, 'createNote', { relativePath: '相同文件名.md', markdown: `# ${space.kind} 原内容\n保留各自隔离的数据。\n` })
      const task = await call<Task>(runtime, 'createTask', { title: `${space.kind} 原任务`, sourceRefs: [{ kind: 'note', noteId: note.noteId }], dueAt: '2026-12-01' })
      originals.push({ space, workspaceId: summary.workspaceId, noteId: note.noteId, taskId: task.taskId, doc: await call<NoteView>(runtime, 'getNote', { noteId: note.noteId }) })
      await close(runtime)
    }
    // Reading a WAL-mode SQLite file can create SHM even with readOnly=true.
    // Record comparison baselines before taking the offline fingerprint.
    const originalIdentityRows = new Map<string, unknown[]>()
    const originalIdentityDb = new DatabaseSync(join(sourceRoot, 'identity.sqlite'), { readOnly: true })
    try { for (const table of ['accounts', 'spaces', 'members', 'audit']) originalIdentityRows.set(table, originalIdentityDb.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()) } finally { originalIdentityDb.close() }
    const backup = join(root, 'backup')
    const result = await collaborationBackup.backupCollaboration({ dataRoot: sourceRoot, output: backup, offlineConfirmed: true })
    expect(result.analysis.issues).toEqual([])
    expect(result.analysis.spaces.find((space: { spaceId: string }) => space.spaceId === unopened!.id).state).toBe('uninitialized')
    const restored = await collaborationBackup.restoreCollaboration({ backup, manifestSha256: result.manifestSha256, target: targetRoot, offlineConfirmed: true })
    expect(restored.credentials.sessionsRevoked).toBe(2)
    expect(restored.credentials.invitationsRevoked).toBe(1)
    expect(restored.activationBlocked).toBe(true)
    await expect(CollaborationGateway.open({ dataPath: targetRoot, publicOrigin: 'http://127.0.0.1:41999' })).rejects.toThrow(/recovery|恢复/i)
    await collaborationBackup.approveRecovery({ dataRoot: targetRoot, offlineConfirmed: true, reviewedMemberships: true })
    const gateway = await CollaborationGateway.open({ dataPath: targetRoot, publicOrigin: 'http://127.0.0.1:41999' })
    await gateway.close()
    for (const original of originals) {
      const runtime = await boot(targetRoot, original.space)
      expect((await call<{ workspaceId: string }>(runtime, 'summary')).workspaceId).toBe(original.workspaceId)
      const doc = await call<NoteView>(runtime, 'getNote', { noteId: original.noteId })
      expect(doc.markdown).toBe(original.doc.markdown)
      expect(doc.note.contentHash).toBe(original.doc.note.contentHash)
      expect((await call<Task[]>(runtime, 'listTasks'))[0]?.taskId).toBe(original.taskId)
      const other = originals.find(item => item.space.id !== original.space.id)!
      await expect(call(runtime, 'getNote', { noteId: other.noteId })).rejects.toThrow()
      await close(runtime)
      expect(storedRows(join(targetRoot, 'spaces', original.space.id, 'state.sqlite'), 'u_workspace_workspaces').map(row => row.key)).toEqual([original.workspaceId])
    }
    const recoveredDb = new DatabaseSync(join(targetRoot, 'identity.sqlite'), { readOnly: true })
    try {
      for (const table of ['accounts', 'spaces', 'members', 'audit']) expect(recoveredDb.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).toEqual(originalIdentityRows.get(table))
      expect(recoveredDb.prepare('SELECT count(*) AS n FROM sessions').get()!.n).toBe(0)
      expect(recoveredDb.prepare('SELECT count(*) AS n FROM invitations').get()!.n).toBe(0)
    } finally { recoveredDb.close() }
    const verification = await collaborationBackup.verifyCollaborationSource({ backup, manifestSha256: result.manifestSha256, offlineConfirmed: true })
    expect(verification.sourceUnchanged).toBe(true)
  }, 60_000)
})

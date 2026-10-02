import type { Role } from './identity.ts'
import { AccessError } from './identity.ts'

// Every RPC is named explicitly. New backend methods default to denied until reviewed.
const read = new Set([
  'summary', 'listNotes', 'getNote', 'renderMarkdown', 'nextFootnoteKey',
  'listTrash', 'listTrashAttachments', 'listTrashFolders', 'listAttachments',
  'attachmentRelatedNotes', 'getAttachmentKnowledge', 'noteAttachmentSummaries',
  'getAttachment', 'downloadAttachment', 'getCompanionNote', 'search', 'listKnowledge',
  'relatedKnowledge', 'noteSyncInfo', 'getTree', 'listFolders', 'listMatrices', 'listTasks', 'listSubtasks', 'listTrashTasks',
])
const write = new Set([
  'tableMutation', 'footnoteEdit', 'footnoteDelete', 'batchRestoreTrash', 'createNote',
  'saveNote', 'saveNoteBody', 'moveNote', 'renameNoteTitle', 'deleteNote', 'restoreNote',
  'uploadAttachment', 'setCompanionNote', 'createCompanionNote', 'upgradeCompanionNote',
  'deleteAttachment', 'restoreAttachment', 'reparseAttachmentKnowledge', 'syncEntity',
  'createFolder', 'renameFolder', 'deleteFolder', 'trashFolder', 'restoreFolder', 'setOrder',
  'createMatrix', 'renameMatrix', 'archiveMatrix', 'reassignMatrixTasks', 'removeMatrix',
  'createTask', 'updateTask', 'completeTask', 'reopenTask', 'moveTaskToMatrix', 'reorderTasks', 'deleteTask', 'restoreTask',
])
const manage = new Set(['batchPurgeTrash','purgeNote','purgeAttachment','purgeFolder','syncNow','reconcileProcessing','reconcile'])
export function authorizeRpc(role: Role, method: string): 'read' | 'write' | 'manage' {
  if (read.has(method)) return 'read'
  if (write.has(method) && role !== 'viewer') return 'write'
  if (manage.has(method) && (role === 'owner' || role === 'admin')) return 'manage'
  throw new AccessError(403, '你的角色不能执行此操作，或此接口尚未开放')
}

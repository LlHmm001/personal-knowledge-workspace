# Trash Management

Status: capability/lifecycle record (this round). Trash is a content manager (single / batch / empty), not a list of per-item buttons. Canonical store stays Host/Core; the browser holds only UI projection + selection.

## Entity kinds

| kind | stable identity | restore | permanent delete |
|---|---|---|---|
| Note | `noteId` | `notes.restore(noteId)` | `notes.purge(noteId)` |
| Folder | `trashEntryId` (`FolderTrashEntryId`, decoupled from `originalPath`) | `notes.restoreFolder(trashEntryId)` | `notes.purgeFolder(trashEntryId)` |
| Attachment | `attachmentId` | `attachments.restore(id)` | `attachments.purge(id)` |

No Task/Matrix trash exists — the Trash view renders only these three kinds. Selection identity is the composite `kind:id` key (`note:…`, `folder:…`, `attachment:…`); it never reverts to `path`/`filename`/array index.

## Capabilities

- **Single restore / single permanent delete** — existing canonical operations, unchanged.
- **Batch restore** — Host `batchRestoreTrash(items)` loops per item with per-item try/catch (allSettled semantics), returns `{ ok: string[], failed: [{key,error}] }`. A failure never masks the items that succeeded.
- **Batch permanent delete** — Host `batchPurgeTrash(items)` same shape. Destructive; UI shows a custom confirm dialog (not `window.confirm`).
- **Empty Trash** — purges the **whole Trash** (all kinds), not the current filter. Confirm dialog states the total count + note/folder/attachment breakdown.
- **Select All** — selects the **currently visible** items (respects the type filter). State is derived from the selected set vs visible keys (`none/partial/all`), never a sticky flag.

## Lifecycle invariants (unchanged)

- Restore/purge go through the existing canonical service methods, preserving: stable trash identity, restore path-conflict strategy, `durable delete intent`, and WeKnora projection cleanup.
- WeKnora offline does not block local canonical deletion (existing recovery semantics); Empty Trash does not hang on an unreachable WeKnora.
- Partial failure is honest: succeeded items are removed from the trash projection; failed items stay visible and selectable; toast reports `N succeeded, M failed`.
- `restoreFolder`/`purgeFolder` take `trashEntryId` (never `originalPath`), so same-path historical trash entries do not collide.

## Selection lifecycle

- Checkbox toggle and select-all are **pure local state** — no Host call, no re-render of the item list (selection toolbar + select-all checkbox update in place).
- On background revalidate, selection is reconciled to the fresh projection (`selected ∩ freshIds`); items that disappeared (e.g. restored elsewhere) are auto-dropped.
- Successful batch operations remove their keys from selection before revalidating; `selectedCount` never goes stale.

## UI layers (one / many / all)

1. Single: per-item `恢复` / `永久删除` buttons + right-click menu.
2. Many: selection toolbar (`已选择 N 项 · 恢复 · 永久删除 · 取消选择`).
3. All: `清空回收站` in the header (danger, disabled when empty).

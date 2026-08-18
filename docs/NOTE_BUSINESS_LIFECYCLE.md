# Note + Attachment Business Orchestration (Lifecycle & Mutation Matrix)

Status: **audit record** — verified from PKW source (`packages/pkw/{notes,attachments,weknora,weknora-sync,web}`) and runtime storage, not assumptions. Governs the Note/Attachment business orchestration closure (Create/Save/Move/Delete/Restore/Purge + Companion Note).

## Canonical identity invariants (locked — do not regress)

| Identity | Stability rule |
|---|---|
| `NoteId` (`note_<12hex>`) | **Identity.** Never changes on Save/Rename/Move/Restore. Minted once at Create (or adopted from frontmatter `id`); never delete+recreate. |
| `AttachmentId` (`att_<12hex>`) | **Identity.** Stable for the binary's lifetime; external replacement is the SAME attachment at a new observed revision. |
| `path` (note `relativePath`) | **Mutable location**, not identity. Rename/Move only updates `relativePath` + `note_paths` rekey. |
| `KnowledgeId` (WeKnora) | **Remote projection identity.** Derived 1:1 from `NoteId`/`AttachmentId` via the durable `mappings` table. Move/Rename MUST NOT change it (update in place, never delete+recreate). |
| Note↔Attachment | Derived from Markdown (`collectManagedLinks` scans `attachments/<id>/...`). No structural table. |
| Companion relation | `AttachmentRecord.companionNoteId → NoteId` (stable one-to-zero-or-one). NEVER keyed by title/filename/path. |

## WeKnora note payload metadata — audit result

`createManualKnowledge` / `updateManualKnowledge` send **only**:

```js
{ title, content, channel: 'pkw', status: 'publish' }
```

**No** `path`, `folder`, `workspaceId`, or `noteId` is sent. WeKnora therefore has **no notion of the note's local path** — a Move/Rename only changes the Markdown **content fingerprint** (when managed `../attachments/...` links are depth-rewritten) and re-syncs via `updateManualKnowledge` on the SAME `knowledgeId`. Nothing in WeKnora needs a "move" operation.

## Local-first orchestration rule

- Local phase (save binary → `AttachmentRecord` → create Companion Note → persist `companionNoteId` → update UI/cache) succeeds **regardless** of WeKnora online/parse/summary state.
- Remote phase (sync → parse → summary → materialize → Note sync → Wiki/Graph) is **async** and owned by the Host/sync worker, never by ad-hoc UI calls.
- Companion Note summary arrives later via `materializeCompanionSummary` (upserts a managed `<!-- pkw:attachment-summary -->` block into the SAME NoteId Markdown, reusing the SAME Note KnowledgeId).

## Mutation matrix

Legend: `—` = not applicable / unchanged; `w` = write/update; `→` = derived action.

| Mutation | Local File | note_index / paths | NoteId | Path | KnowledgeId | Remote (WeKnora) action | Tree | Attachment refs | SourceRefs | Trash |
|---|---|---|---|---|---|---|---|---|---|---|
| **Create** | write `.md` | put record + path mapping | mint (or adopt frontmatter `id`) | set | — (created on first sync) | `createManualKnowledge` (async) | appears | embedded in Markdown | derived on search | — |
| **Save (update)** | rewrite `.md` | put record (hash/rev) | stable | stable | stable | `updateManualKnowledge` (PUT, same id) | unchanged | unchanged (Markdown) | derived | — |
| **Rename (note)** | `fs.rename` | rekey `note_paths` | stable | new | stable | `updateManualKnowledge` (same id) | relabel | rewritten if `../attachments/` depth changes | derived (same NoteId) | — |
| **Move (note)** | `fs.rename` | rekey `note_paths` | stable | new | stable | `updateManualKnowledge` (same id) | relabel | rewritten if depth changes | derived (same NoteId) | — |
| **Move (folder)** | `fs.rename` dir | rekey all child paths | stable (per note) | new (per note) | stable (per note) | `updateManualKnowledge` (same ids) | relabel subtree | rewritten if depth changes | derived | — |
| **Delete (soft)** | `fs.rename` → `archive/` | put record (`deletedAt`, `canonicalMissing?`) | stable | kept | stable (sync marks `deleted`) | mark remote deleted / hide from search | hidden | refs still in archived Markdown (other notes keep their refs) | hidden | entry |
| **Restore** | `fs.rename` back | put record (clear `deletedAt`) | stable | kept | stable (sync reactivates) | re-mark present | reappears | unchanged | visible | cleared |
| **Purge** | remove file | delete record + path mapping | gone | gone | sync clears mapping / remote delete (best-effort) | n/a | gone | removed | gone | cleared |
| **External Move** | file moved on disk | `getDocument`/`reconcile` rekeys by frontmatter `id` | stable (from `id`) | new (observed) | stable | `updateManualKnowledge` (same id) | relabel | rewritten if depth changes | derived | — |
| **External Delete** | file removed | `reconcile` soft-deletes; `listMissingNotes` flags | stable (record kept, `canonicalMissing`) | kept (file missing) | sync marks deleted | mark deleted / hide | hidden | refs point to missing file (flagged) | hidden | entry |
| **Companion Summary Update** | upsert `.md` block | put record (hash/rev) | stable | stable | stable (reuses Note KnowledgeId) | `updateManualKnowledge` (same id) | unchanged | unchanged | derived | — |

## Companion Note lifecycle (Direct Upload)

1. `importFile` → binary under `attachments/<AttachmentId>/<storedFilename>` + `AttachmentRecord`.
2. Host `createCompanionNote` (idempotent, local-first):
   - if `companionNoteId` already set → return existing note (`created:false`).
   - else derive collision-free path (`sanitizeNoteBase`/`uniqueNotePath`, CJK-safe), build `# <base>` + `attachments/<id>/<storedFilename>` reference, `notes.create`, then `setCompanionNote(AttachmentId → NoteId)`.
3. Remote: attachment sync → parser → summary; `drainCompanionSummaries` materializes summary into the companion note Markdown.
4. Retry `[创建伴随笔记]` = the same idempotent Host call (open if exists, create if missing — never a `海报(2).md`).

## Invariants this closure enforces

- Move/Rename NEVER changes `NoteId` or `KnowledgeId` — it is an in-place path/`updateManualKnowledge` mutation, never a delete+recreate.
- Direct Upload never waits on WeKnora; the Companion Note exists immediately, its summary may arrive later.
- The Attachment Library is a **Manager** (list/grid, search, type filter, sort, multi-select batch, single actions), not an Inspector entry.

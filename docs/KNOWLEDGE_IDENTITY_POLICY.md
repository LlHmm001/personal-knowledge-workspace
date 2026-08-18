# Knowledge Identity Policy (Remote Uniqueness)

Status: **decision record** — derived from real WeKnora source (`/LlHmm9527/WeKnora`) and live API probes, not assumptions. Governs how many remote WeKnora Knowledge objects one local upload/business object may produce.

## The problem

A Direct Upload of `华聚海报1.jpg` produced TWO flat WeKnora cards:

1. `JPG / File Knowledge` — the binary parsed by WeKnora's file parser (Attachment Knowledge).
2. `Companion Note / Manual Knowledge` — the auto-created Wrapper Note synced as Markdown (Note Knowledge).

A user sees one uploaded file as two equal, duplicate-looking knowledge objects.

## Decision Gate — verified WeKnora facts

| Question | Answer (from source) |
|---|---|
| Can one Knowledge hold a binary parse result AND manual companion text? | **No.** `internal/types/knowledge.go` `Type` is `manual` \| `file` \| `url` — mutually exclusive ingestion paths. Manual = raw Markdown chunks; file = binary + parser chunks. |
| Does WeKnora support parent/child/group/source identity? | **No.** The `Knowledge` struct has no `parent_id`/`child_id`/`group_id`. `CompositeRetrieveEngine` (retriever) is about combining vector stores, NOT grouping knowledge identity. |
| Is there a `metadata` JSON field? | Yes (`Knowledge.Metadata`), but it is a passive tag — WeKnora does NOT use it to merge/group cards. |
| How does Companion user text get indexed? | Only by syncing the Companion Note as a separate `manual` Knowledge. There is no "append manual text to a file knowledge" API. |

## Options evaluated

- **OPTION A — Companion Note never syncs (Attachment-only).** Remote is unique, but user-authored Companion text is never searchable. ❌ violates "user text must stay retrievable".
- **OPTION B — Attachment-backed Companion Note + explicit upgrade.** Default: no independent Note Knowledge (only Attachment Knowledge). When the user writes real original text outside the managed region, they can explicitly promote the note to independent sync. ✅ unique by default, user text retrievable on demand.
- **OPTION C — WeKnora group/composite identity.** ❌ Not supported (verified above).
- **OPTION D — Keep two remote knowledge, group only in PKW UI.** ❌ WeKnora still shows two flat cards; only hides the duplication locally.

## Recommended MVP (implemented): OPTION B — attachment-backed

Final identity model:

```
Normal Note
  NoteId
    ↕  (1:1, durable mapping)
  Note KnowledgeId            ← independent remote Knowledge (unchanged)

Attachment (Direct Upload binary)
  AttachmentId
    ↕  (1:1, durable mapping)
  Attachment KnowledgeId      ← THE single remote Knowledge for one uploaded file
    ↕  companionNoteId
Companion Note (local wrapper)
  NoteId                      ← local-only context object (image/file preview,
                                 managed summary block, user annotations)
  attachmentBacked = true     ← does NOT create a Note Knowledge by default
```

- A Direct Upload produces **one** remote Knowledge: the Attachment Knowledge (binary parser).
- The Companion Note exists locally for: file/image display, the managed parse summary, user补充正文, task SourceRefs, folder organization.
- Managed content (frontmatter + `# title` + attachment reference + `<!-- pkw:attachment-summary -->` block) is distinguished from user-authored text by `companionUserContent()` — never `body.length > 0`.
- When the user adds real original text and chooses **「将伴随笔记作为独立知识同步」**, the note is promoted (`attachmentBacked → false`) and synced as an independent Note Knowledge. This is a deliberate, durable, user-triggered decision — **not** auto-upgrade.

## Managed vs user content

`companionUserContent(markdown)` strips the deterministic managed region (frontmatter, title heading, managed `attachments/<id>/…` references, managed summary block) and returns the remainder. `hasCompanionUserContent(markdown)` is true only when real original text remains. This is the single source of truth for "does this Companion Note carry user-authored content".

## Migration of existing duplicates (safe, auditable, offline non-blocking)

Existing Companion Notes already have a Note Knowledge. The sync `reconcile` migrates them:

1. For each attachment with a `companionNoteId`, if the note has **no** user content, mark it `attachmentBacked = true`.
2. `runNoteSync` then skips it; if a legacy Note Knowledge mapping exists, it is converged through the existing durable remote-delete intent path (auditable, retryable, offline-safe).
3. The **Attachment Knowledge is kept**; the local Companion Note is kept. Only the duplicate Note Knowledge is removed.
4. Identity is matched by `companionNoteId` / `AttachmentId` / `Note KnowledgeId` (durable relations) — **never** by title/filename.

## Search routing

When Hybrid Search hits an Attachment Knowledge, the result prefers the `companionNoteId` (open the Companion Note) so the user still perceives one knowledge object. With no companion relation, it opens the Attachment detail.

## Normal Notes are unaffected

A normal hand-written note keeps its `NoteId ↔ Note KnowledgeId` 1:1 mapping unchanged.

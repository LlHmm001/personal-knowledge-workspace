# Knowledge Ingestion Policy (Ownership Matrix)

Status: **decision record** — verified from WeKnora source (`/LlHmm9527/WeKnora`) + live API probes, not assumptions. Governs "how many Persistent WeKnora Knowledge objects one local business unit produces".

## Core invariant

> Local Entity Identity ≠ Remote Knowledge Ownership.

Note and Attachment are both PKW canonical entities. Whether either becomes an independent **Persistent** WeKnora Knowledge is decided by **business source + user intent**, not by "the code happened to call `uploadFile`".

> Default: **one business knowledge unit → one Persistent Knowledge.**

## Three Attachment Knowledge Modes

| Mode | Meaning | Remote result |
|---|---|---|
| `standalone` | The attachment is itself the knowledge subject. | Persistent Attachment Knowledge. |
| `note-scoped` | The attachment is supporting material of an owner Note. | No independent Attachment Knowledge; derived content serves the owner Note Knowledge. |
| `local-only` | Save the file only. | No WeKnora projection. |

Field: `AttachmentRecord.knowledgeMode` (`'standalone' | 'note-scoped' | 'local-only'`) + `ownerNoteId` when note-scoped. `indexable:false` is treated as `local-only`.

## Ingestion scenario matrix

| # | Scenario | Local Owner | Remote Owner | Persistent Knowledge Count | Parser | Search opens | Wiki/Graph |
|---|---|---|---|---|---|---|---|
| 1 | New normal Note | Note | Note | 1 | manual Markdown | Note | eligible |
| 2 | Normal Note + uploaded image | Note | Note | 1 (Note) | image is note-scoped | Note | Note only |
| 3 | Normal Note + uploaded PDF | Note | Note | 1 (Note) | PDF is note-scoped | Note | Note only |
| 4 | Normal Note + multiple attachments | Note | Note | 1 (Note) | each note-scoped | Note | Note only |
| 5 | Note references existing standalone attachment | Note (+ Attachment) | both | 2 (real, intentional) | Attachment already standalone | Note (for note) / Companion or Attachment (for attachment) | both |
| 6 | Attachment Library direct upload | Attachment | Attachment | 1 (Attachment) | standalone | Companion (if exists) else Attachment | Attachment |
| 7 | Attachment Library + Companion Note | Attachment | Attachment | 1 (Attachment) | standalone; Companion is attachment-backed | Companion Note | Attachment |
| 8 | Attachment Library, indexing OFF | (local) | — | 0 | none | — | — |
| 9 | Companion Note later gets user text | Attachment (+ local note) | Attachment | 1 | standalone | Companion | Attachment |
| 10 | Companion ownership upgrade | Note | Note (transfer) | 1 (after transfer) | attachment content merged | Note | Note |
| 11 | Attachment removed from Note | Note | Note | 1 | n/a | Note | Note |
| 12 | Note deleted | — | — | soft-delete remote | n/a | hidden | — |
| 13 | Note restored | Note | Note | 1 (reactivate) | n/a | Note | eligible |
| 14 | Attachment deleted | — | — | remote delete | n/a | hidden | — |
| 15 | Attachment reparse | Attachment | Attachment | 1 | re-parse same Knowledge | — | — |
| 16 | Attachment binary replaced | Attachment | Attachment | 1 (replacement, same identity) | re-parse | — | — |
| 17 | Same attachment referenced by multiple Notes | first note-scoped owner (or standalone) | owner | 1 | once (cached) | owner | owner |
| 18 | Note moved/renamed | Note | Note | 1 | n/a | Note | Note |

## Decision Gate — verified WeKnora facts (6 questions)

1. **Parse-only API?** No. `Knowledge.Type` is `manual|file|url`; a file knowledge is always a full ingest (parse → chunks → searchable). No "parse-only" endpoint.
2. **Hidden / non-retrievable Knowledge?** Partial. `Knowledge.EnableStatus` (`enabled`/`disabled`) exists — newly created knowledge starts `disabled` and is enabled after parsing. Whether `disabled` fully excludes search/Wiki/Graph needs confirmation; no explicit per-knowledge "hidden/non-retrievable" flag was found.
3. **Temporary artifact vs Wiki/Graph?** No per-knowledge "exclude from wiki/graph" flag found. A temporary file Knowledge would participate in Wiki/Graph derivation while it exists. → Report as a real limitation.
4. **Parsed content for Note projection?** Only `Knowledge.description` (summary) and search chunks are exposed; the full extracted text is not a single field. → Note projection should use the bounded summary/description, not full text.
5. **Long PDF → manual Markdown?** Do NOT inject full text. Use bounded summary/description (see #4).
6. **Companion upgrade ADD vs TRANSFER?** User wants "唯一" → **TRANSFER ownership** (Note becomes primary; delete Attachment Knowledge after enriching the Note). This needs the parse-content capture mechanism from #4, so it is NOT implemented this round; the current "upgrade" is kept as an explicit action but the recommended future semantic is TRANSFER.

## Implemented this round (default rules)

- `AttachmentRecord.knowledgeMode` + `ownerNoteId` fields; `importFile` stores them.
- **Note-editor upload** (`uploadVditorFiles`, Source-mode paste) → `note-scoped` + `ownerNoteId = 当前笔记`.
- **Attachment Library direct upload** → `standalone` (unchanged).
- **Sync worker**: `note-scoped`/`local-only` attachments are skipped (no independent Attachment Knowledge); a legacy mapping is converged to deleted (durable, auditable).
- The owner Note's remote projection already carries `图片附件：<file>` (via `normalizeForRemote`), so the file is still visible in the single Note Knowledge.

## Deferred (documented, not hidden)

- **Derived-content enrichment** of the owner Note (inject OCR/PDF summary into the Note Knowledge) — requires the temporary-artifact lifecycle (parse → capture summary → enrich → cleanup) and is blocked on WeKnora's lack of parse-only/hidden knowledge (Decision Gate #1–#3).
- **Historical reconcile** of already-created note-scoped duplicates: the sync skip now applies to newly-uploaded note-scoped attachments; legacy attachments without `knowledgeMode` are not auto-reclassified (no title-based deletion).

## Normal Notes unaffected

A hand-written Note keeps its `NoteId ↔ Note KnowledgeId` 1:1 mapping unchanged.

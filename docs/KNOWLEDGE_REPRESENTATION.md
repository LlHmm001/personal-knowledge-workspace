# Knowledge Representation (Business Knowledge / Source Asset / Processing Artifact)

Status: **decision record** — verified from WeKnora source (`/LlHmm9527/WeKnora`), not assumptions. Answers "how does one Note with embedded attachments map to WeKnora's data model".

## Decision Gate — WeKnora facts (PART B)

| # | Question | Answer (source) |
|---|---|---|
| 1 | Can a manual Knowledge link multiple binary assets? | **No.** `Knowledge` has no `assets`/`files` field and no relation table. |
| 2 | Does Knowledge have a metadata/extension field for attachment refs? | **No usable field.** `Knowledge.Metadata` (JSON) is internal: `ManualKnowledgeMetadata{content,format,status,version}` for manual; file metadata for file type. `ManualKnowledgePayload` accepts only `{title,content,status,tag_ids,channel,process_config}` — no arbitrary metadata. |
| 3 | Is the Document UI inherently manual→text, file→binary/parser? | **Yes.** `Knowledge.Type` (`manual\|file\|url`) drives the renderer; no composite type. |
| 4 | Internal Knowledge + Sources/Files/Documents relation? | **None.** Chunks carry `knowledge_id` (one parent), but there is no "one Knowledge owns many files" relation. |
| 5 | Attach image/PDF to a manual Knowledge without a 2nd Knowledge? | **No.** |

## OPTION comparison (PART B2)

| | A — PKW Aggregation Only | B — WeKnora asset-relation extension | C — Composite Knowledge |
|---|---|---|---|
| WeKnora change | none | DB migration + API + UI | deep model rework |
| Main KB count | 1 (Note) | 1 | 1 |
| WeKnora Document detail shows image | ❌ (text only) | ✅ | ✅ |
| Parser | Processing KB (unchanged) | Processing KB | unified |
| Upstream merge risk | none | high | very high |
| Maintainability | high | low (fork) | low |

## Recommendation (PART B3)

**OPTION A — PKW Aggregation Only.** WeKnora is the **knowledge computation backend** (parser / search / wiki / graph); PKW is the **complete Knowledge Object UI**. WeKnora's own Document detail is a backend-inspection surface, not the user's knowledge browser.

Rationale: PKW will keep upgrading WeKnora; building a DB/API/UI fork (B) or a composite model (C) purely to show a thumbnail in the backend UI is a poor maintainability tradeoff when PKW already renders the full object (Note + image preview + PDF + derived summary).

## Three formal identities (PART C3)

```
Note A                                    ← 1 Business Knowledge Unit
├── image1.png                            ← Source Asset (canonical PKW binary)
├── image2.png                            ← Source Asset
└── report.pdf                            ← Source Asset
    (each → 1 Processing Projection in the internal Processing KB)
```

- **Business Knowledge** — the single Persistent Knowledge in the main KB (a Normal Note, or a standalone attachment the user explicitly made a knowledge object).
- **Source Asset** — a canonical PKW binary (`AttachmentId`) that supports a Business Knowledge. Never a Persistent Knowledge by itself (unless standalone).
- **Processing Artifact** — a temporary/`is_temporary` file Knowledge in the Processing KB, whose only job is to run the parser and emit derived content.

Invariant: **1 Business Knowledge = 1 Persistent main-KB Knowledge**, regardless of how many Source Assets / Processing Artifacts it owns.

## 25-scenario ingestion matrix (PART C2)

Legend: count = Persistent main-KB Knowledge count. Preview = where the binary is viewed.

| # | Scenario | Local owner | Business owner | Main KB count | Processing | Preview | Search opens | Wiki/Graph |
|---|---|---|---|---|---|---|---|---|
| 1 | Note, text only | Note | Note | 1 | — | — | Note | Note |
| 2 | Note + upload image | Note | Note | 1 | Processing KB | PKW | Note | Note |
| 3 | Note + upload PDF | Note | Note | 1 | Processing KB | PKW | Note | Note |
| 4 | Note + upload DOCX | Note | Note | 1 | Processing KB | PKW | Note | Note |
| 5 | Note + upload Excel | Note | Note | 1 | Processing KB | PKW | Note | Note |
| 6 | Note + multiple attachments | Note | Note | 1 | each in Processing KB | PKW | Note | Note |
| 7 | Note + paste image | Note | Note | 1 | Processing KB | PKW | Note | Note |
| 8 | Note + drag/drop file | Note | Note | 1 | Processing KB | PKW | Note | Note |
| 9 | Note + toolbar upload | Note | Note | 1 | Processing KB | PKW | Note | Note |
| 10 | Note references existing standalone | Note + Attachment | both | 2 (real) | — | PKW | Note or Attachment | both |
| 11 | Library direct upload image | Attachment | Attachment | 1 (standalone) | — | PKW | Companion/Attachment | Attachment |
| 12 | Library direct upload PDF | Attachment | Attachment | 1 (standalone) | — | PKW | Companion/Attachment | Attachment |
| 13 | Library multiple files | each | each | N (standalone) | — | PKW | each | each |
| 14 | Library + Companion Note | Attachment | Attachment | 1 (attachment-backed note) | — | PKW | Companion | Attachment |
| 15 | Companion note gets user text | Attachment | Attachment | 1 (attachment-backed) | — | PKW | Companion | Attachment |
| 16 | Same attachment in multiple notes | first note | first note | 1 | parse once, reuse | PKW | owner Note | owner Note |
| 17 | Note removes attachment ref | Note | Note | 1 | delayed cleanup | PKW | Note | Note |
| 18 | Attachment rename | Note | Note | 1 | n/a (same AttachmentId) | PKW | Note | Note |
| 19 | Attachment replace | Note | Note | 1 | re-process (new hash) | PKW | Note | Note |
| 20 | Attachment reparse | Note | Note | 1 | re-process | PKW | Note | Note |
| 21 | Note move/rename | Note | Note | 1 (same KnowledgeId) | — | PKW | Note | Note |
| 22 | Note delete/restore | — | — | soft-delete/reactivate | — | PKW | hidden | — |
| 23 | Attachment delete/restore | — | — | remote delete/reactivate | cleanup | PKW | hidden | — |
| 24 | Search hits attachment derived text | Note | Note | 1 | — | PKW | **owner Note** | Note |
| 25 | Wiki/Graph derivation | Note | Note | 1 | excluded | — | — | Note (main KB only) |

## PART J acceptance (Note A: "会议记录" + image1.png + report.pdf)

1. PKW Local Entities: **3** (1 Note + 2 Attachments).
2. User-visible Business Knowledge: **1** (Note A).
3. Main WeKnora KB Persistent Knowledge: **1** (Note A manual Knowledge).
4. Processing KB Artifacts: **2** (image1.png + report.pdf, `is_temporary`).
5. PKW Knowledge detail: Note body + image preview + PDF + OCR/PDF derived summary + sources + relations.
6. WeKnora native detail: text projection only (no binary) — by design under OPTION A.
7. Search on image OCR → opens **Note A**.
8. Wiki/Graph: **1** knowledge (Note A); Processing Artifacts isolated.

## Full-text retrieval (verified, not summary-only)

Real experiment against WeKnora (`GET /chunks/:knowledge_id` on a file knowledge): the chunk list returns the **full extracted text** (a 419-char TXT returned 1 chunk = full body, containing a marker sentence absent from the 143-char `description` summary). Therefore:

- The Business Knowledge remote projection injects **summary + full extracted text (chunks)**, bounded by `maxTotalChars` (default 12000, configurable) — NOT summary-only.
- The canonical Note Markdown NEVER contains the full text (only the managed Companion-Note summary block); full text lives only in the remote projection + the Processing Artifact.
- `captureDerived` captures the full chunk text (soft 30k storage cap); `enrichNoteForKnowledge` applies the remote budget.

## Regression guard (PART K)

`note-scoped` / `standalone` / `local-only` modes, Processing KB, derived enrichment, and "same Note KnowledgeId" are unchanged. WeKnora is NOT forked to show images (D1/D2: no re-creation of a second Attachment Knowledge).

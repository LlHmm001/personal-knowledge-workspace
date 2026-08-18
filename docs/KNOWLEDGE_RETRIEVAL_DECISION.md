# Knowledge Retrieval Architecture Decision (A1 vs A2)

Status: **decision record** — backed by a real WeKnora experiment, not assumptions.

## The question

A Business Knowledge (a Note + note-scoped attachments) must be **full-text searchable** (PDF internal sentences, image OCR) while keeping **one Persistent Knowledge in the main KB** and keeping the main KB Wiki/Graph clean.

Two architectures:
- **A1** — materialize the attachment extracted text into the Main KB Note Knowledge.
- **A2** — keep full text in the Processing KB; federate search (Main + Processing) and remap Processing hits → Business Knowledge.

## Experiment (real WeKnora, `GET /chunks/:knowledge_id`)

Fixture: 59,652-char document (TXT → `simple` parser) with three markers:

| Marker | char position | within 12k? | within 30k? |
|---|---|---|---|
| PKW-EARLY-4811 | 3,801 | ✅ | ✅ |
| PKW-MIDDLE-7291 | 23,620 | ❌ | ✅ |
| PKW-LATE-9637 | 53,641 | ❌ | ❌ |

Result: **9 chunks, 59,656 chars total — full text preserved in the Processing Artifact, all three markers present.**

## A1 fails for large attachments (measured)

A1's `enrichNoteForKnowledge` budget (`maxTotalChars` default 12,000) and `captureDerived` soft cap (30,000) truncate:

| Architecture | EARLY | MIDDLE | LATE |
|---|---|---|---|
| A1 (12k Main projection) | ✅ | ❌ | ❌ |
| A1 (30k capture, 12k inject) | ✅ | ✅ | ❌ |
| A2 (full text stays in Processing) | ✅ | ✅ | ✅ |

The LATE marker — a sentence any user expects to be searchable — is **lost under A1** unless the budget is raised to near-unbounded, which then bloats the Main manual Knowledge (payload growth + re-embedding cost + update amplification when one PDF is referenced by multiple Notes).

## A2 decision (recommended)

- **Main KB** = Business Knowledge projection: Note body + attachment semantics (`图片附件：<file>`) + bounded summary. Wiki/Graph use Main KB only.
- **Processing KB** = full extracted text (chunks), parser/OCR/summary. Not in user search/Wiki/Graph.
- **Search** = federate Main + Processing; Processing hit → `ProcessingKnowledgeId` → `AttachmentId` → referencing `NoteId[]` → Business Knowledge result (`matchReason: 'attachment'`, `matchedAttachmentId`). Dedupe by NoteId (a Note hit by both body and attachment merges to one result with both reasons).
- **Full text is never copied into the Note canonical Markdown** (only summary for Companion Notes); it stays in the Processing Artifact and is surfaced via federation.

## Comparison (decision criteria)

| Criterion | A1 | A2 |
|---|---|---|
| Full-text searchable (long PDF) | ❌ (truncates) | ✅ |
| Main KB stays one Knowledge | ✅ | ✅ |
| Wiki/Graph not polluted | ✅ | ✅ |
| One attachment parsed once | ✅ | ✅ |
| Multi-note shared attachment (no text duplication) | ❌ (copies text per note) | ✅ (shared) |
| Reparse refresh | re-inject per note | re-index Processing, remap unchanged |
| Main projection size | grows with attachment text | bounded |
| Offline | same | same |

## Search result model

`BusinessSearchResult` carries `source` (`note` | `attachment`), `businessNoteId`, optional `matchedAttachmentId` + `matchedChunk`, `score`. Users see one Business Knowledge per Note; the reason ("正文" vs "附件 report.pdf") is shown.

## Ranking limitation

Main-KB and Processing-KB hybrid-search scores are not directly comparable. First version: independent top-K per KB → business-level merge → no precise unified sort; documented as a known limitation.

## Isolated attachment

An attachment with no referencing Note is **not** a Business Knowledge; Processing hits for it are not surfaced as Note results (no fabricated NoteId). (Attachment detail remains available in the Attachment Manager.)

## Regression guard

`note-scoped`/`standalone`/`local-only`, Processing KB, derived capture, and "same Note KnowledgeId" are unchanged. This is PKW orchestration only — no WeKnora fork.

## Browser Evidence follow-up (HEAD 49e6eb2 +)

1. **Search provenance** — `RetrievalResult.local` now carries `matchedAttachmentId` + `matchReason`; the Search UI shows "正文命中" vs "附件命中 · <filename>" (federated remap to the owner Note). Processing KnowledgeId is never shown.
2. **Projection hygiene** — `stripInternalFrontmatter()` removes the PKW `id:` (and `pkw:*`) frontmatter from the remote projection before it enters WeKnora embedding/summary/Wiki/Graph; user `title`/`tags`/custom YAML are kept. Canonical Markdown unchanged.
3. **Image rendering in WeKnora** — WeKnora's main-KB payload now carries only `图片附件：<file>` (no renderable URL). The PKW attachment byte route is **localhost-only and unauthenticated-by-path** (serves any `att_<12hex>` to the loopback). Exposing private attachments publicly just to render them in WeKnora's backend UI is rejected (security-first). Decision: **WeKnora backend shows `图片附件：<file>`; PKW's Business Knowledge Viewer is the place images are rendered.** No WeKnora fork (F8 deferred).
4. **Summary refresh** — WeKnora `updateManualKnowledge` updates content/chunks but does NOT reliably regenerate the stale `description` ("No textual content..."). The reparse seam (`POST /knowledge/:id/reparse`) exists; wiring an explicit summary-refresh on content change is a follow-up, not done here.

## Parser lifecycle

`processing` records now store `configFingerprint`; `listNeedsReparse()` returns derived-ready attachments whose captured fingerprint differs from the current Processing KB fingerprint. No automatic bulk reparse (K).

# Note-scoped Attachment Processing Pipeline

Status: **architecture record + partial implementation**. Governs how a note-scoped attachment (uploaded inside a Normal Note) is **parsed** without becoming a second Persistent Knowledge in the main KB.

## Three identities (must stay separate)

| Identity | Kind | Lifetime |
|---|---|---|
| `AttachmentId` (`att_<12hex>`) | canonical asset | stable (PKW source of truth) |
| `ProcessingKnowledgeId` | derived processing projection | durable mapping, but NOT a Persistent Business Knowledge |
| `Persistent Note KnowledgeId` | the owner Note's remote Knowledge | the single business knowledge |

## Chosen architecture (Decision Gate)

| Option | Verdict |
|---|---|
| A. Temporary Knowledge in main KB | ❌ pollutes main KB + Wiki/Graph during its lifetime; no per-knowledge exclude flag. |
| B. **Dedicated Processing KB** | ✅ chosen — main KB stays clean; parser runs in an isolated workspace. |
| C. Direct parser seam (no Knowledge) | ❌ no stable public/service API seam found. |
| D. PKW's own parser | ❌ diverges from user WeKnora parser config semantics. |

## Why Processing KB

- Main KB (`PKW Personal Knowledge`) → only Persistent Business Knowledge (Note A), Wiki/Graph clean.
- Processing KB (`PKW Processing`) → note-scoped file uploads execute the SAME parser, then derived summary/chunks are extracted and injected into the owner Note Knowledge; the processing Knowledge is then deleted (or retained as an internal projection, never surfaced in the main KB).

## Parser config consistency (A4)

`ensureProcessingKbConfig()` must copy from the main KB (`GET /knowledge-bases/:id`):
- `chunking_config.parser_engine_rules` (per-file-type engine)
- `chunking_config` parse-relevant fields
- `vlm_config` (OCR/VLM)
- DocReader config references

Implementation uses the added WeKnora client methods: `getKnowledgeBase`, `createKnowledgeBase`, `updateKnowledgeBase`. No hardcoded parser.

## ProcessingKnowledgeId persistence (A5)

A new durable table `processing` in the sync domain (separate from `mappings`), keyed by `AttachmentId`:

```
AttachmentId → { processingKnowledgeId, processingKbId, state, summary, chunks, updatedAt }
```

This is NOT the Persistent `mappings` table (which only holds standalone attachment / note / companion KnowledgeIds).

## Derived data (A6)

- `getKnowledge(id).description` → bounded summary.
- `listKnowledgeChunks(id)` → top text segments.
- Only these two are exposed; WeKnora does NOT provide a single full-extracted-text field.

## Owner Note enrichment (A7) — implemented helper

`enrichNoteForKnowledge(normalizedMarkdown, derived[])` (domain `note-projection.ts`) appends, under a budget, `## 附件解析摘要（<filename>）` blocks to the remote note payload. Canonical local Markdown is NEVER written back.

Budget (A8): `maxSummaryChars` (2000), `maxChunkChars` (4000), `maxTotalChars` (12000) per note projection — so a 100MB PDF never becomes a 100MB manual Note.

## Search semantics (A9)

The enriched Note Knowledge contains the derived text, so Hybrid Search for an in-image/PDF keyword hits the **Owner Note** (its `normalizeForRemote` already carries `图片附件：<file>` references). Navigation is to `NoteId`, never to the ProcessingKnowledgeId.

## Wiki/Graph (A10)

Main KB Wiki/Graph sees only the Persistent Note Knowledge. Processing KB artifacts never enter the main KB's Wiki/Graph — this is the primary value of the Processing KB.

## Remaining implementation (not yet wired into the sync worker)

The sync worker still **skips** note-scoped attachments (`runAttachmentSync` returns early). The remaining work is:
1. `ensureProcessingKb()` + config sync on init.
2. Route note-scoped attachments to the Processing KB (`uploadFile` to processingKbId).
3. Write the `processing` table (version bump + migration).
4. `drainNoteScopedProcessing()` sweep: poll parse/summary → capture `description` + top chunks → mark derived-ready.
5. `runNoteSync` for the owner note: read derived data, build the remote payload via `enrichNoteForKnowledge`, and re-sync when a note-scoped attachment's derived data changes.
6. Cleanup/retry: on owner note removal (no referencing notes), delete the ProcessingKnowledge; durable delete intent for offline.

## Standalone / multiple-owner / remove (A11–A14)

- Standalone attachment (Attachment Library) → unchanged, stays in main KB as its own Knowledge.
- Existing standalone attachment referenced by a Note → keep both (two real objects), no auto-transfer.
- Multiple notes referencing the same attachment → parse once, reuse the derived result for each owner note.
- Removing a managed reference from one note does not affect another owner.

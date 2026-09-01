# DOCX Transport Live Acceptance (Decision Gate)

Status: **live experiment** (real WeKnora, `mineru_cloud` docx parser). Not a production change.

## Fixture (self-generated)

- Pixel PNG `PKW-DOCX-IMAGE-a7c21` (marker ONLY in pixels; filename `pixel-image.png`, no marker in alt/caption/markdown).
- `compileProcessingDocx` → `transport_fixture.docx` (body BEFORE/AFTER markers + embedded image + 400 filler segments).

## PART B — self-contained DOCX (verified via JSZip)

- `word/media/<hash>.png` = 941 bytes (matches pixel PNG), internal relationship (no `TargetMode="External"`).
- `document.xml` contains BEFORE/AFTER, does NOT contain the image marker (marker only in pixels). ✅

## PART C/D — upload + body text parse

- `POST /knowledge/file` → `type=file`, `file_type=docx`, `parse_status=finalizing` (never reached `completed`), `summary_status=completed`, `description="No textual content was extractable from this document."`.
- Chunks: 10 chunks, 5066 chars.
- **BEFORE marker: ❌ NOT in chunks** (title + first body paragraphs dropped by the docx parser).
- **AFTER marker: ✅ in chunks** (chunk 0).

## PART E/F/G — embedded image

- **IMAGE marker: ❌ NOT in chunks** — the embedded image was converted to `![](resource://mdHzBeg…)` (a resource link), NOT OCR'd.
- Chunk 0 = `![](resource://…) PKW-DOCX-AFTER-a7c21 …` — image link + after-text; before-text dropped.
- This is **情况 A**: the DOCX parser extracted the image as a resource link but did NOT run image OCR on it (not an OCR-credential failure — the pixels never produced text).

## PART H — search

- `PKW-DOCX-AFTER-a7c21` → real hit (`transport_fixture.docx`).
- `PKW-DOCX-BEFORE-a7c21` / `PKW-DOCX-IMAGE-a7c21` → only fuzzy hits (markers not actually in chunks).

## PART I — summary

`description = "No textual content was extractable…"` — summary stage is stale/empty despite chunks carrying text (same `updateManualKnowledge`-style staleness; `reparse` is the refresh seam).

## PART J/K/L — Knowledge type / identity

WeKnora facts (source `routes_knowledge.go` / `knowledge.go`):
- `Knowledge.Type` is fixed (`manual`/`file`/`url`); no type-change API.
- `POST /knowledge-bases/:id/knowledge/file` → `CreateKnowledgeFromFile` **always creates a new Knowledge** (no existing-id param).
- No "replace file binary" / "revision re-upload same id" endpoint; `reparseKnowledge` re-parses the SAME stored binary.

⇒ **file Knowledge每次更新都会产生新 KnowledgeId**. Identity model: `NoteId` stable; `activeKnowledgeId` changes per revision (atomic switch after parse success + durable delete of the old id). Local save never blocked by WeKnora failure.

## Decision

**OPTION B — DOCX TEXT-ONLY VALUE.**

- 正文: partial (AFTER ✅, BEFORE ❌) — the mineru_cloud docx parser drops leading text and does not preserve full body.
- embedded image: ❌ NOT OCR'd (resource link only).
- Therefore DOCX transport does **not** solve the core "inline image content becomes searchable" problem.

Do NOT wire `runNoteSync` to compiled-DOCX transport. Non-image attachments (PDF/XLSX) still need independent binary processing. The compiled `.processing.docx` remains a candidate only for text-only transport / specific multimodal scenarios (OPTION C), not a replacement for the current note-manual + attachment-processing model.

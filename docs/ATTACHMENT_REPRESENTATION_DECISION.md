# Attachment Representation Decision (FINAL)

Status: **frozen** — after three real experiments. Do not re-open a rejected route unless external conditions actually change.

## Final decisions

| Topic | Decision |
|---|---|
| Markdown canonical | **ACCEPTED** |
| Attachment binary canonical | **ACCEPTED** |
| DOCX canonical | **REJECTED** |
| DOCX primary transport | **REJECTED** |
| DOCX utility/export | **RETAINED** (`docx-note.ts`, `compileProcessingDocx`, `createDocxNote`) |
| WeKnora `resource://` architecture | **VALID INTERNAL DESIGN** |
| PKW → `resource://` integration | **REJECTED FOR CURRENT API SURFACE** |

## Three real experiments (recorded so no future re-open)

1. **Managed local path → WeKnora** — FAIL: `attachments/<id>/<file>` surfaces as an invalid image link in WeKnora (relative, non-resolvable).
2. **DOCX transport** (`DOCX_TRANSPORT_ACCEPTANCE.md`) — FAIL: BEFORE body dropped, embedded image became `resource://…` link, pixel marker absent from chunks, no OCR → OPTION B (text-only).
3. **resource:// Mapping** (`WEKNORA_RESOURCE_MAPPING_POC.md`) — FAIL FOR EXTERNAL INTEGRATION: the resource system is real (`StoredResource`/`ResourceBinding`/`ResourceAccessGrant`/`/r/:token`), but `Register`/`CreateAccessGrant` have no external HTTP API; PKW is HTTP-only.

## Locked architecture (A2)

```
Canonical:  Note.md + Attachment binary

Main WeKnora KB   (PKW Personal Knowledge)
  Note → Manual Knowledge
    body text, Markdown semantics, user context, attachment name/reference,
    Companion summary

Processing WeKnora KB (PKW Processing, is_temporary)
  Attachment binary → File Knowledge
    image OCR/VLM, PDF, Office, TXT, chunks, summary
```

- `AttachmentId` = stable identity; binary = independent asset; path/URL = projection; permission = container/resource policy.
- Local managed ref `![](attachments/<AttachmentId>/<filename>)` means "Note references Attachment" — NOT a URL, NOT a filesystem transport path, NOT a WeKnora binary-delivery mechanism.

## Surface projections (one resolver, no per-surface regex)

| Surface | Projection |
|---|---|
| PKW Source | `attachments/<id>/<filename>` |
| PKW Live / Reading | `AttachmentId` → PKW binary resolver (`/pkw/attachment/<id>`) |
| Attachment Library | `AttachmentId` → preview/download |
| Business Knowledge Viewer | `AttachmentId` → inline image/file viewer |
| WeKnora Main | `图片附件：<filename>` (no private binary) |
| Processing | `AttachmentId` → binary uploadFile |
| Search | Processing hit → `AttachmentId` → `NoteId` |
| Future Mobile | `AttachmentId` resolver |

## What closes A2 Runtime

Processing KB provision (durable `processing_kb` mapping) + Attachment → Processing KnowledgeId + TXT EARLY/MIDDLE/LATE federation (LATE beyond 12k/30k) + Main-only LATE negative + dedupe + multi-owner + isolated-attachment (no fabricated Note) + search provenance (`matchReason`/`matchedAttachmentId`) + Processing hidden + Companion summary materialize + same Main KnowledgeId.

## Deferred (explicitly out of scope now)

- OCR credential = separate **Parser Capability** issue (does not change representation architecture).
- WeKnora raw Detail = backend inspection, NOT the product viewer; **PKW Business Knowledge Viewer** is the user's Knowledge Detail (next phase).
- Wiki/Graph: WeKnora-generated, PKW ports results → Business Knowledge Viewer, never WeKnora raw Detail.
- Migration, Sidebar, Mobile, PLL, ONLYOFFICE, resource:// re-open (until WeKnora exposes Register/Grant HTTP API).

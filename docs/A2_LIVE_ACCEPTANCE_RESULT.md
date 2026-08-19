# A2 Live Acceptance Result (TXT path)

Status: **A2 RUNTIME CLOSED for the TXT path** (image OCR remains a separate Parser Capability debt).

## Deployment

- HEAD: `9a2cc1c` (deployed, `MainPID=1132438`, start `00:44:41 UTC`).
- `/opt/deepseek-harness/packages/pkw` → `/LlHmm9527/Personal Knowledge Workspace/packages/pkw` (symlink confirmed).

## Controlled Processing KB rebuild (9a2cc1c)

- Detected CREATE-ONLY config drift on the old broken KB `3005d497-…` (empty embedding/summary).
- Created new KB `549edd3e-33d1-480a-a310-b6c6bfed49e8` with `embedding_model_id=fbdf91f1-…`, `summary_model_id=69028c7d-…` (both non-empty).
- Atomically switched `workspaceId → 549edd3e`; old `3005d497` recorded in `retiredKbIds` (not deleted first).
- New config fingerprint `8597c0e7…` now covers embedding/summary model.

## Results

| Gate | Result |
|---|---|
| small TXT smoke (`PKW-PROCESSING-SMOKE-smk01`) | PASS — parse completed, marker in chunks (2 chunks / 7521 chars) |
| large TXT (>50k) completed | PASS — 9 chunks / 59659 chars |
| EARLY / MIDDLE / LATE in Processing chunks | PASS / PASS / PASS |
| Main-only LATE negative (main KB search) | PASS — 0 exact-marker hits |
| Federated EARLY / MIDDLE / LATE → Note A | PASS — all `matchReason=attachment`, `matchedAttachmentId=att_332047ab95f9` |

## A2 proof

`Processing KB hit → ProcessingKnowledgeId → AttachmentId → referencing NoteId → Note A`, with `matchReason=attachment` + `matchedAttachmentId` provenance; Processing KnowledgeId not exposed to the user result.

## Not yet re-verified live (secondary)

Dedupe (body+attachment same note), multi-owner, isolated attachment (no fabricated Note), Companion summary materialization (BLOCKED BY SUMMARY GENERATION for TXT), failure/stuck visibility.

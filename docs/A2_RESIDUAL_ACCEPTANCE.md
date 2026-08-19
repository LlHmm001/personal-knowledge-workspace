# A2 Residual Acceptance (multi-owner / isolated / dedupe)

## Multi-owner (live) — PASS

- Attachment X (`att_89a438938ad4`) referenced by Note A (`note_0bc1e487fedc`) + Note B (`note_91b3844a8954`).
- ONE active Processing Knowledge (`125eece3-…`); no duplicate upload.
- Search for the attachment marker → Note A + Note B, each once, `matchReason=attachment` + `matchedAttachmentId`.

## Isolated attachment (live) — PASS

- Attachment Y (`att_0272aa81ca73`) note-scoped but its owner Note was deleted → no referencing Note.
- Processing reached `derived-ready`; Business Search for the marker returned NO fabricated Note (only unrelated fuzzy matches on real notes).

## Dedupe (live) — single-result PASS (previous round)

- Marker in both note body + attachment → exactly one Note A result.
- 'both' provenance (正文命中 · 附件命中 · <file>) is code-complete in `fecd3f1` but requires redeploy to live-verify (runtime is still at `9a2cc1c`, PID 1132438 / start 00:44:41 < fecd3f1 commit 11:12).

## Conclusion

A2 Attachment Runtime = PRODUCT READY (TXT/attachment path). Residual debt (unchanged): Companion summary (BLOCKED BY SUMMARY), Image OCR (IMAGE_PARSER_CAPABILITY_DEBT), stalled detector, historical migration, retired-KB cleanup.

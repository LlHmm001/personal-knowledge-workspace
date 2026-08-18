# Knowledge OPTION A Migration Plan

Status: **plan** — not yet executed against production. OPTION A (PKW Aggregation Only) is the accepted direction; this documents the migration from the current dual-projection state (Note Knowledge + standalone Attachment file Knowledge in the main KB) to a single Business Knowledge per object.

## Current state

- Normal Note → Persistent Note Knowledge (main KB) ✅ (unchanged).
- Note-scoped attachment → **skipped** from main KB; parsed in Processing KB (implemented `8dc55ee`).
- Historical **standalone** attachments (Attachment Library direct upload, pre-OPTION-A) still have a Persistent Attachment Knowledge in the main KB.
- Existing Companion Notes are attachment-backed (no independent Note Knowledge), but their Attachment Knowledge may still be in the main KB.

## Target state

- Main KB (`PKW Personal Knowledge`) = **Persistent Business Knowledge only** (Notes + explicitly-standalone attachments the user made knowledge objects).
- Processing KB (`PKW Processing`) = parser execution only (`is_temporary: true`).
- A Direct Upload with a Companion Note = **1** Attachment Knowledge (main KB) + Companion Note (attachment-backed, no Note Knowledge) — this is the "standalone" case, unchanged.
- A Normal Note with embedded attachments = **1** Note Knowledge (main KB), attachments parsed in Processing KB only.

## Full-text retrieval finding (verified)

Experiment (real WeKnora, `GET /chunks/:knowledge_id` on a file knowledge): the chunk list returns the **full extracted text** (a 419-char TXT returned 1 chunk = full body, containing a marker sentence absent from the 143-char `description` summary). Therefore OPTION A preserves full-text search by injecting the captured chunks into the Business Knowledge remote projection — **not summary-only**.

## Migration steps (non-destructive, gated)

1. **Audit** — enumerate main-KB knowledge; classify by durable relation (`NoteId ↔ KnowledgeId`, `AttachmentId ↔ KnowledgeId`, `companionNoteId`), never by title.
2. **Identify note-scoped duplicates** — attachments referenced from a Normal Note's Markdown (`collectManagedLinks`) that also have a standalone Attachment Knowledge.
3. **Process-first** — for each, ensure the derived content has been captured (Processing KB) and the owner Note Knowledge has been enriched with it.
4. **Then** enqueue a durable remote-delete intent for the old standalone Attachment Knowledge (existing `runRemoteDelete` path).
5. **Verify** — main KB knowledge count, search for a marker sentence, Wiki/Graph sources — before deleting the next batch.

## Rollback

Each step is durable + idempotent; a failed Processing keeps the old Attachment Knowledge (never delete first). The Processing Artifact is a projection and can be re-created from the canonical `AttachmentId` at any time.

## Verification gate

Run the vertical slice in a dedicated test KB before any production migration. Do NOT destructively migrate the live main KB until Browser/User confirms.

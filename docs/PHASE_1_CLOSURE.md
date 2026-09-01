# PKW Phase 1 — Knowledge Workspace Foundation

**Status: CLOSED / ACCEPTED**

This document freezes the architecture, product boundaries, rejected directions,
and deferred debt for Phase 1. It is the authoritative closure record; future work
starts from here (bugfix / Product Sprint / Foundation only under the reopen rules
below).

---

## 1. Frozen Architecture Decisions

| Decision | Status |
| --- | --- |
| Markdown Note canonical | **ACCEPTED** |
| Attachment binary canonical | **ACCEPTED** |
| Folder = real directory / `relativePath` derived | **ACCEPTED** |
| `NoteId` = stable identity | **ACCEPTED** |
| `AttachmentId` = stable identity | **ACCEPTED** |
| Task Store = canonical Task source | **ACCEPTED** |
| A2 Retrieval | **ACCEPTED** |

### Knowledge model
- **Main Knowledge** = Note text / context projection.
- **Processing Knowledge** = Attachment binary parsing projection (OCR/parser/chunks/summary).
- **Business Knowledge** = PKW-aggregated user object (Note + its Sources).
- **WeKnora** = retrieval / parsing / indexing / summary / derived-knowledge engine.
- **WeKnora remote identity** = implementation detail (never user identity).
- **Local save/read** must not depend on WeKnora availability.

### Identity invariants (never regress)
- `NoteId` stable; `relativePath` mutable, never identity.
- `AttachmentId` (`att_<12hex>`) stable; filename is display metadata, never identity.
- `path` is a location, not an identity.

---

## 2. Rejected Directions (do NOT auto-reopen)

| Direction | Decision |
| --- | --- |
| DOCX canonical | **REJECTED** |
| DOCX primary transport | **REJECTED** |
| DOCX utility/export | **RETAINED** |
| filesystem absolute path as canonical asset identity | **REJECTED** |
| PKW → WeKnora `resource://` integration | **REJECTED FOR CURRENT API SURFACE** |
| A1 full attachment materialization into Main Knowledge | **REJECTED** |

> ⚠️ Post-closure amendment: the "DOCX utility/export RETAINED" decision above was later superseded — all DOCX code (`docx-note.ts` + `docx`/`jszip` deps) was removed in post-closure cleanup. See `CODEBASE_CLEANUP_REPORT.md`.

Reopen any of these only if the underlying external capability actually changes.

---

## 3. Delivered Capabilities (Phase 1)

- Workspace / Sidebar
- Notes / Folder system (path-derived)
- Desktop Note Editor (Live / Source / Reading)
- Business Knowledge Viewer
- Knowledge Discovery
- Unified RAG Retrieval
- Knowledge Sources / Attachments
- A2 Attachment Retrieval
- PDF Processing Reconciliation
- Tasks existing workflow
- Trash
- Desktop interaction runtime stabilization
- Responsive / Mobile Presentation
- Mobile Notes folder system
- Mobile Task Board → Q1–Q4
- Mobile Read-first Note strategy

---

## 4. Mobile Final Strategy

- **Desktop** = full authoring / editing experience.
- **Mobile** = read-first / navigation / search / sources / tasks / management.

### Mobile body editing: **DEFERRED**

Reason: Vditor (GopherJS IR) + iOS Safari IME / selection / keyboard has no
sufficient real-device evidence that it can be delivered safely. Data safety is
prioritized over feature completeness.

Re-evaluate only if the underlying editor condition changes.

---

## 5. Retrieval Final State

- **A2 Retrieval Core = CLOSED** (real live proof established).
- Live proof: >59k TXT → EARLY / MIDDLE / LATE all retrievable from Processing
  chunks; Main-only LATE negative (0 exact); federated LATE positive.
- Processing hit → AttachmentId → NoteId → Business Knowledge.
- Multi-owner / isolated / dedupe semantics verified.
- Human Search and future Agent Retrieval share the same Retrieval Core direction.
- **RAG relevance tuning = DEFERRED UNTIL REAL CORPUS.**

---

## 6. Sources Final State

- Attachment = independent stable resource.
- Note only references Attachment identity.
- Different surfaces self-project: Source Markdown / PKW Reading / PKW Live /
  Business Knowledge / Sources / Mobile / WeKnora Processing.
- Processing pipeline: `upload → waiting → processing → optimizing → ready/failed`.
- PDF reconciliation is closed.

---

## 7. Phase 1 Debt (NON-BLOCKING — do not implement now)

> 收敛于 docs/DEBT.md

### PRODUCT DEBT
- Mobile real-device polish
- Mobile body editing (deferred — see §4)
- Notes Explorer multi-select
- Source renderer polish
- large-list virtualization

### PARSER / AI DEBT
- Image OCR / VLM credential
- Companion summary materialization
- Wiki / Graph stability
- RAG relevance evaluation

### OPERATIONS DEBT
- failed automatic retry
- stalled detector
- retired Processing KB cleanup
- stale remote Knowledge cleanup

### MIGRATION DEBT
- historical migration

---

## 8. Post-Closure Rules

Phase 1 CLOSED. After this:

- Ordinary bug → **bugfix**.
- Experience issue → **Product Sprint**.
- Debt existence does **not** reopen Phase 1 as OPEN.

Only these reopen **Foundation**:

- canonical corruption
- identity corruption
- data loss
- permission/security break
- A2 core invariant broken
- Task Store invariant broken

---

## 9. Do NOT start Phase 2

Not in scope now: Task ↔ Knowledge, PLL, Memory, Agent workflow, Migration, new
AI capabilities. Wait for an explicit new-phase instruction.

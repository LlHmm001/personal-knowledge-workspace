# Word Note Migration (DOCX canonical)

> ⚠️ Superseded by: `docs/PHASE_1_CLOSURE.md` §2 — DOCX canonical **REJECTED**, DOCX primary transport **REJECTED**（Markdown Note + Attachment binary 胜出）。DOCX 全链代码已随 `docs/CODEBASE_CLEANUP_REPORT.md` 删除。本文件保留仅作历史证据。

Status: **direction accepted** (user decision). This doc records the agreed model + phased plan; only the P0 foundation (DOCX read/write mechanics) is implemented this round.

## Data model

```
Note
├── NoteId                   PKW stable identity (DB authoritative)
├── title / folder / tags    DB metadata
├── path                     current file location (mutable)
├── document.docx            canonical body + embedded images (binary)
├── currentHash              SHA-256 of current DOCX bytes
├── revision                 local revision number (bumped on hash change)
├── processingKnowledgeId    WeKnora parse object (Processing KB)
├── mainKnowledgeId          Business Knowledge projection (Main KB)
└── syncState
```

- `.docx` is canonical for body + embedded images (no `attachments/att_xxx/...` refs).
- DB keeps NoteId/tags/folder/sync/delete/mapping. `PKW.NoteId` is also written into the DOCX custom property as a recoverability hint on external move/rename (DB remains authoritative).
- PDF/XLSX/archive stay independent Source Assets (not OLE-embedded). `.doc` is export-only.

## Three-layer change detection

1. **Save callback (ONLYOFFICE)** — primary channel when embedded editor saves.
2. **Chokidar watcher** (`atomic` + `awaitWriteFinish`) — external desktop Word / file ops. Ignore `~$*.docx`, `*.tmp`, `*.lock`, `.~lock.*#`.
3. **Startup + periodic reconcile** — hash re-scan fallback.

All three converge to: wait-stable → read `PKW.NoteId` + SHA-256 → hash changed? → save revision → enqueue sync. Duplicate events collapse on equal hash.

## Event handling

- **add** → mint NoteId if none → register → sync.
- **change** → debounce → SHA-256 vs currentHash → new revision → re-parse.
- **rename/move** → `PKW.NoteId` resolves identity → update path only, never delete/recreate remote Knowledge.
- **unlink** → brief wait (atomic replace) → soft-delete → durable remote delete intent (no immediate permanent delete).

## WeKnora sync (Main / Processing unchanged)

WeKnora has no in-place file-binary replace. So a new DOCX revision:
1. upload new Processing Knowledge (DOCX body + embedded images parsed together),
2. wait parse success,
3. update Main Business Knowledge / search mapping,
4. atomically switch `processingKnowledgeId`,
5. delete old Processing Knowledge.

Parse failure → old version stays active, new marks `sync_failed`, background retry. Main KB stays one Business Knowledge; Wiki/Graph stays Business-Knowledge-only.

## Migration phases (do NOT bulk-migrate yet)

| Phase | Work | Done when |
|---|---|---|
| P0 | DOCX note vertical slice | create/edit/save/reopen + embedded image + desktop-Word change detection + re-search + no ghost/duplicate |
| P1 | save callback + Chokidar + reconcile | external add/change/rename/delete + restart recovery |
| P2 | WeKnora sync | unique marker re-searchable, no permanent duplicate Knowledge |
| P3 | Markdown bulk migration | body/title/image/link count parity, then switch default format |

Markdown migration: body + managed images → DOCX (embedded), PDF/XLSX links → independent Source Assets, `NoteId` → DOCX custom property. Old `.md` → read-only archive (never auto-delete).

## Implemented this round (P0 foundation)

- `domain/docx-note.ts`: `createDocxNote` (body paragraphs + `PKW.NoteId` custom property), `extractDocxText` (text for hash/WeKnora), `readDocxNoteId` / `writeDocxNoteId`. Tests round-trip text + identity + XML-escaping.
- New deps: `chokidar@5`, `docx@9`, `jszip`, `fast-xml-parser` (installed into `@deepseek-ai/dsh-pkw-domain`).

## Not yet implemented (next rounds)

- ONLYOFFICE Document Server integration (needs the Document Server provisioned).
- Notes service DOCX-canonical refactor (notes still `.md` canonical today).
- Chokidar watcher wiring + version snapshot store.
- WeKnora DOCX revision sync + atomic switch + cleanup.
- Markdown→DOCX migration.

## Knowledge ingestion: compile → single `.processing.docx` (refinement)

The canonical stays **Markdown Note + separate attachment binaries**. For WeKnora ingestion, PKW compiles the note + its managed images into **one `.processing.docx`** (a processing artifact, never canonical):

```
PKW源数据 (canonical)
  客户项目资料.md  +  海报2.png
        ↓ 编译 (处理产物)
  客户项目资料.processing.docx
  ├─ 正文 (note text)
  └─ embedded 海报2.png  (ImageRun + [图片附件：海报2.png] caption)
        ↓
WeKnora (ONE file Knowledge → body + image OCR parsed together → ONE Business Knowledge)
```

This replaces the earlier "federate Main KB + Processing KB" A2 complexity with a single-document projection: one Note = one compiled DOCX = one WeKnora Knowledge. Image OCR text and body text live in the same document, so search hits one object and no federation remap is needed.

`domain/docx-note.ts: compileProcessingDocx({noteId, title, markdown, images})` implements the compile step (text paragraphs + embedded `ImageRun` + searchable `[图片附件：<file>]` caption + `PKW.NoteId` custom property). The compiled DOCX is what the sync uploads (as a revisioned Processing Artifact); the canonical `.md` + attachment binaries are untouched.

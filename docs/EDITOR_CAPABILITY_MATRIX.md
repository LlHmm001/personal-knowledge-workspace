# Editor Capability Matrix

Status: decision/status record (this round). Canonical Markdown stays the single source of truth; CORE = pure, tested domain logic; WIRED = browser UI path present (browser-verified by the user's real-browser acceptance, not in the dev session).

## Table

| Dimension | Status | Notes |
|---|---|---|
| CORE | ✅ | `table.ts`: parse/serialize GFM, `findTableBlock`/`findTableBlockByIndex`/`resolveTableCell`, row/column transforms. Row ops are row-aware via `cursorLine` (offset-correct); column ops are column-aware via `columnIndex`. GFM guards: cannot delete header row / last column. |
| LIVE WIRED | ✅ | Live (IR) cell → structural identity (`resolveCellInEditor`: DOM table index + row/col, no cell-text dependence) → Host `tableMutation` RPC applies the pure transform → `setValue(body)` + best-effort caret/scroll restore. |
| CONTEXT WIRED | ✅ | Cell right-click menu: insert row above/below, insert column left/right, align L/C/R, delete row/column, delete table. |
| TOOLBAR WIRED | ✅ | Toolbar table button: outside a table → N×N (2–6) grid picker; inside a table → the same context actions. |
| READING | ✅ | Lute `Md2HTML` renders GFM tables (with column alignment `align=`). |
| ROUNDTRIP | ✅ | Every mutation re-serializes canonical GFM (`\| a \| b \|`, separator `:---`/`:---:`/`---:`). Source stays valid GFM; Reading parses it. |

## Footnote

Canonical syntax: `[^key]` reference inline + `[^key]: definition` (numeric keys by default). No hidden JSON. Keys are reference identities — never re-numbered on delete.

| Dimension | Status | Notes |
|---|---|---|
| CORE | ✅ | `footnote.ts`: `nextFootnoteKey` (free numeric key), `appendFootnoteDefinition`, `listFootnoteDefinitions`, `editFootnoteDefinition`, `removeFootnoteDefinition`, `countFootnoteReferences`, `deleteFootnote`. MVP limit: one reference per key; delete removes all refs + definition. |
| LIVE | ✅ | Reference renders as `sup[data-type="footnotes-ref"]`; definition block `[data-type="footnotes-block"]`. Toolbar opens a dialog (selection → reference after it; empty → reference at caret) and appends `[^key]: def` at the end. Reference/definition right-click menus for edit / jump / delete. |
| READING | ✅ | Lute `Md2HTML` already emits superscript `footnotes-ref` anchor + `↩` back-reference (native anchor jump), plus minimal CSS. |
| TOOLBAR | ✅ | Footnote button opens a content dialog (not a raw `[^1]` insertion). |
| CONTEXT | ✅ | `sup[data-type="footnotes-ref"]` → edit/jump/delete; `[data-type="footnotes-def"]` → back-to-reference/edit/delete. |
| ROUNDTRIP | ✅ | Live insert → Source shows `[^key]` + `[^key]: def`; Source-handwritten footnote → Reading correct; mode switch = 0 mutation. |

## Notes / Reading / Callout / Wiki / Attachment (regression anchors)

Already verified in prior rounds; unchanged this round (no regressions):

- Reading = Lute (callout/table/code/footnote native), wiki links protect/restore, attachment URL rewrite → `/pkw/attachment/<id>`.
- Live = Vditor IR, callout native (`SetCallout(true)`) + PKW 9-type palette.
- Wiki-link click → `openWikiTarget`; frontmatter ownership stays Host/Core; no-op mode switch.

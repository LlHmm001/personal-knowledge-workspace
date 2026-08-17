# Markdown Renderer Decision

**Status:** Decision record + runtime evidence (2026-08-17). HEAD-era: `b1cfaf5`.

## Current (problem)

- **Live** renders through Vditor IR → Lute engine.
- **Reading** renders through a homemade `renderMarkdown` in `packages/pkw/web/src/ui.ts`.
- Two parsers ⇒ semantic drift (the parity bugs the user reported).

## Runtime experiment (Lute-only feasibility)

Ran `lute.min.js` (Vditor 3.11.3, self-hosted) inside a Node vm sandbox with a browser-like global:

```js
const lute = Lute.New({ callout: true, gfmAutoLink: true, footnotes: true, sanitize: true })
lute.Md2HTML(md)
```

Observed output:

| feature | Lute-only `Md2HTML` | notes |
|---|---|---|
| GFM table | ✅ `<table><thead>…` | correct |
| fenced code | ✅ `<pre><code class="language-js">` | correct, language preserved |
| heading / list / blockquote | ✅ | correct |
| callout `> [!NOTE]` | ✅ `<div class="callout" data-subtype="NOTE">…` | **requires `lute.SetCallout(true)`, NOT `Lute.New({callout:true})`** (see Update below) |
| wiki link `[[…]]` | ❌ (not a Lute core syntax) | PKW/Obsidian extension |

## Conclusion

1. **Lute-only is feasible for standard Markdown** (table/code/heading/…), and `lute.min.js` loads standalone (`global.Lute` with `New()` → `Md2HTML()`).
2. **Lute's core DOES natively render Obsidian callouts** via `lute.SetCallout(true)` (the earlier `Lute.New({callout:true})` probe used the wrong API and produced a false negative). Wiki links `[[…]]` are NOT Lute syntax and still need a PKW extension.
3. Therefore a **PKW Markdown Extension Layer is still required, but it is now minimal**:
   - callout recognition — NOT needed (Lute `SetCallout(true)` renders it; only CSS is needed)
   - wiki-link recognition + protect/restore (the only pre/post-processor step)

## Decision

- **Do NOT keep growing the homemade `renderMarkdown` with more regex branches.**
- **Target architecture (next iteration):**
  ```
  Canonical Markdown
    → PKW extension preprocessor (callout/wiki/attachment normalization)
    → Lute.Md2HTML  (standard syntax)
    → PKW postprocessor (callout box classes, wiki link resolution, attachment cards)
  ```
- The extension layer must be **pure and testable** (no DOM), so Live and Reading share the same recognition rules.

## Deferred (not done this round, honest)

- Live-side callout visual box (Vditor IR) still shows blockquote — needs Vditor `afterRender`/render-hook wiring.
- Reading-side Lute.Md2HTML integration is verified feasible but not yet wired (fallback homemade renderer still primary).
- `fixtures/editor-compatibility.md` + automated parity tests pending.

## Update (Reading→Lute adapter wired)

- **Correction:** `lute.SetCallout(true)` renders Obsidian callouts natively (the earlier `New({callout:true})` probe was a false negative). Vditor's own `MARKDOWN_OPTIONS` uses `callout: true` via `setLute` → `lute.SetCallout(options.callout)`.
- **Wired:** Host-side `renderMarkdown` RPC (`packages/pkw/web/src/lute.ts`) loads the pinned `lute.min.js` into an isolated `node:vm` sandbox once (lazy singleton), runs `protectWikiLinks → Md2HTML → restoreWikiLinks`, and returns HTML. `renderPreview()` now paints the homemade renderer synchronously as a first-paint fallback, then replaces it with the canonical Lute HTML; on Lute failure the fallback stays.
- **Extension layer is now minimal:** `packages/pkw/domain/src/lute-pipeline.ts` (pure) only protects/restores wiki links (`[[X]]`, `[[X|Alias]]`, `![[X]]`), skipping fenced + inline code, with HTML-escaped output. Callouts/tables/code/footnotes/inline are Lute-native.

## Update (parity closure: wiki click, attachment bytes, Live callout)

- **Live callout was ALREADY native, not a blockquote gap:** Vditor 3.11.3 IR mode renders `> [!TYPE]` via Lute `SpinVditorIRDOM` → `<blockquote class="callout" data-type="callout" data-subtype="TYPE">`, and `index.css` styles it (`.vditor-ir blockquote.callout` + per-subtype `--callout-color`). The earlier "shows blockquote, needs afterRender hook" note was wrong. Vditor's CSS only colors TIP/IMPORTANT/WARNING/CAUTION, so PKW added `.vditor-ir blockquote.callout[data-subtype=…]` overrides for its full 9-type palette to match Reading.
- **Wiki-link CLICK wired:** Reading `.wikilink[data-wiki]` now routes to `openWikiTarget` (title/path → open note).
- **Attachment bytes served:** `renderMarkdownToHtml` rewrites `attachments/<id>/<file>` src/href → `/pkw/attachment/<id>` (via pure `rewriteAttachmentUrls`); the new `/pkw/attachment/<id>` route streams stored mime with inline (image) / attachment (file) disposition.
- **Still needs real browser acceptance:** the `fixtures/editor-compatibility.md` visual pass (no Chromium in the dev session).

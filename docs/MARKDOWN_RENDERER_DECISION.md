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
| callout `> [!NOTE]` | ❌ renders as plain `<blockquote><p>[!NOTE]…` | **`callout:true` does not trigger callout rendering in raw Lute** |
| wiki link `[[…]]` | ❌ (not a Lute core syntax) | PKW/Obsidian extension |

## Conclusion

1. **Lute-only is feasible for standard Markdown** (table/code/heading/…), and `lute.min.js` loads standalone (`global.Lute` with `New()` → `Md2HTML()`).
2. **Lute's core does NOT natively render Obsidian callouts or PKW wiki links** — these are PKW extensions. Vditor's *IR mode* shows callouts visually through Vditor's own preview/CSS layer, not through raw `Lute.Md2HTML`.
3. Therefore a **PKW Markdown Extension Layer is genuinely required**, not optional:
   - `parseCallout()` / callout recognition (shared by Live + Reading)
   - wiki-link recognition
   - managed-attachment recognition

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

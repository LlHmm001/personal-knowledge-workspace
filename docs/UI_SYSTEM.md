# PKW UI System v1

Status: design-system record (this round). Vanilla architecture (no React/Vue/Svelte, no CSS framework) — a single self-contained served page whose `<style>` defines semantic tokens and whose inline JS applies theme mode.

## Theme

- Three modes: **system** (default) / **light** / **dark**.
- Toggled from the Topbar `◐` Appearance menu (Follow system / Light / Dark); no main-nav space used.
- Preference persisted in **`localStorage` key `pkw-theme`** (pure client preference — no Harness settings seam, no new DB). This is documented here per the requirement to state where the preference lives.
- `system` reads `prefers-color-scheme` and listens to its `change` event, so the theme follows the OS **without a page refresh**.
- Applied via `document.documentElement[data-theme]` = `light` | `dark`.

## Semantic tokens

Defined once in `:root` (light) and overridden once in `[data-theme="dark"]`. Component rules reference tokens only — there is no `.dark .component` hardcoding (except one consolidated Vditor-editor surface block).

| group | tokens |
|---|---|
| background | `--bg-app` `--bg-sidebar` `--bg-surface` `--bg-elevated` `--bg-hover` `--bg-selected` `--bg-input` |
| text | `--text-primary` `--text-secondary` `--text-muted` |
| border | `--border` `--border-strong` |
| accent | `--accent` `--accent-hover` `--accent-soft` |
| status | `--success` `--warning` `--danger` |
| shadow | `--shadow-sm` `--shadow-md` |
| radius | `--radius-sm` `--radius-md` `--radius-lg` |
| space | `--space-1` … `--space-5` |
| code/mark | `--code-bg` `--code-fg` `--mark-bg` `--mark-fg` |
| callout | `--co-note(-bg)` `--co-tip(-bg)` `--co-info(-bg)` `--co-important(-bg)` `--co-warning(-bg)` `--co-question(-bg)` `--co-example(-bg)` `--co-success(-bg)` `--co-danger(-bg)` |

Legacy aliases (`--bg` `--panel` `--ink` `--muted` `--ok` `--warn` `--err`) map to the new tokens so existing rules keep working.

## Layout

- Topbar / Left Navigation / Main / Context Inspector, unchanged information architecture.
- **Inspector is contextual**: `#detail` is hidden (`#app.no-inspector`, grid collapses to `280px 1fr`) whenever it has no content, so Main expands. Driven by a `MutationObserver` on `#detail`, so any view that renders empty detail content automatically collapses it.

## Components

- Buttons: `button.btn` (secondary) / `.primary` / `.danger` / `.small` / `.mode` / `.icon` — one definition, reused everywhere.
- Forms: `input` / `select` / `textarea` / `checkbox` share height/radius/border/focus-ring via the modal + form rules.
- Modal: `.modal-overlay` + `.modal` (overlay/surface/header/body/footer) — Task Detail is the large-modal reference; progress dialog reuses `.spinner`.
- Context menu: `.ctx-menu` / `.ctx-item` (+ `.danger`), token-backed, light/dark parity.
- Callout: 9 types theme-safe via `--co-*` tokens (Light/Dark differ); Reading (`#preview .callout[data-subtype]`) and Live (`.vditor-ir blockquote.callout`) both consume them.
- Table / Footnote / Code: token-backed (`--border` `--bg-hover` `--code-bg/fg`); dark parity.
- Empty states: `.empty` (title/description/optional CTA) reused across views.

## Editor dark parity

- Source `textarea#editor` and Reading `#preview` use `--bg-surface`/`--text-primary`.
- Vditor Live (IR) surface adapted via a consolidated `[data-theme="dark"]` block (`.vditor`/`.vditor-ir`/`.vditor-reset`/toolbar/callout/code).

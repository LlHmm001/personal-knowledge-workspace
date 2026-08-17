# View Performance Report

Status: instrumentation + optimization record (this round). Real browser numbers must be read from the devtools console (`[pkw.view] …`) during user acceptance — the dev session has no Chromium.

## Instrumentation

`setView` records `viewStart = performance.now()` and bumps a monotonic `viewSeq` navigation guard. Each major view logs to `console.debug`:

```
[pkw.view] view=<view> phase=<phase> ms=<elapsed> [cache=hit|miss]
```

Phases: `shell` (cold — loading placeholder shown), `warm-paint` (cached projection painted), `data-ready` (authoritative data applied). Logs only view name + duration + cache/dedupe hit-miss — never user content.

## Cache-first (warm switch ≈ immediate)

Each major view keeps a UI projection cache in `state` (canonical remains Host/Core; these are UI-only):

| view | cache | loader |
|---|---|---|
| Overview | `summaryCache` | `loadOnce('summary')` |
| Notes | `treeRoot` (existing) | `loadOnce('getTree')` |
| Tasks | `tasksCache` + `matricesCache` | `loadOnce('listTasks')` + `loadOnce('listMatrices')` |
| Attachments | `attachmentsCache` | `loadOnce('listAttachments')` |
| Trash | `trashCache` | `loadOnce('listTrash'|'listTrashAttachments'|'listTrashFolders')` |
| Search | — (empty query does not search) | on user input only |

Warm switch: `renderXFrom(cache)` paints the cached projection synchronously (no loading flash), then revalidates in the background. If the revalidated data is identical the DOM is simply re-rendered from the same projection (no spinner → blank → fresh "fake loading").

## Single-flight / dedupe

`loadOnce(method, args)` reuses an in-flight promise for the same `method:args`, so `Tasks → Notes → Tasks` while `listTasks` is still pending does not fire a second `listTasks` request.

## Stale navigation guard

Each render function captures `const seq = viewSeq` and, after every `await`, aborts if `seq !== viewSeq`. A late `listTasks` response can no longer overwrite the Notes/other view the user has already navigated to.

## Mutation invalidation

`refreshTasks` / `refreshAttachments` / `refreshTrash` invalidate the relevant in-flight loader(s) before re-rendering, so a local mutation (create/delete/toggle/upload/restore/purge) always re-fetches authoritative data rather than reusing a possibly-stale in-flight response. Local mutation remains an event, not polling.

## Remaining bottleneck (honest)

1. **Cold switch** — first visit still awaits the Host round-trip; the shell (`loading`) appears immediately, data later. No preloading of Vditor/Lute/attachment bytes on startup (kept lazy by design).
2. **Editor entry** — opening a Live note still lazy-loads Vditor assets on first use; Reading lazy-loads Lute. This is a deliberate cold cost, not a per-switch cost.
3. **Host API latency** — the `listTasks`/`summary`/… round-trips are the floor for `data-ready`; there is no local store (canonical stays Host/Core).

## Expected experience targets

- Warm switch: cached projection paints synchronously → typically <100–150 ms to visible.
- Cold switch: shell immediate, authoritative data on the Host round-trip.
- Same-data revalidate: DOM no-op (no flash).
- Editor assets: first Live/Reading entry only; never re-initialized per view switch.

# Delivery status — P0 build and reliability work

Base: GitHub `main@62f57a2`. This records the developer-machine evidence; it does
not supersede the frozen model in HANDOVER §4 or claim a production deployment.

| Task | Status | Next step | Completion standard | Verification evidence | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| P0-1 build | Locally verified | Verify against the production Harness | Ten packages emit repeatable lib entries | 10 packages / 56 emitted files repeat identically; packed install passed | Medium | Base remains a metadata bundle |
| P0-2 deployment | Implemented; target acceptance blocked | Obtain target execution entry and run dry-run | Publish/install/restart and actual `/pkw` acceptance | Tooling recovery tests and isolated packed installation | High | No target profile or registry changed |
| P0-3 manual UI backflow | Blocked on production snapshots | Fetch sanitized ui.js and backups through GitHub | Itemized diffs and source backports | No production artifact available | High | ui.ts is unchanged; deploy gate prevents unaudited overwrite |
| P0-4 sync/tests | Locally verified | Verify against the production Harness | Stable suite with supported storage contract tests enabled | Five final full runs: 256 Vitest + 6 tooling passed per run; 5 external tests skipped | High | Historical data conversion is still unavailable |
| P1-5 portability | Harness seam completed; bundle injection pending | Verify actual extension loader/config contract | External config injection on target | Custom DSH_HARNESS_ROOT works locally | Medium | Read-only deployment snapshots are unchanged |
| P1-6 worker operations | Not started | Complete P0 prerequisites | Retry/stalled/retired-KB/stale-Knowledge acceptance | Not run | High | No remote cleanup introduced |
| P1-7 relevance gate | Not started | Select and verify the target reranker/LLM provider | Real relevance judgments and retrieval regression coverage | Not run | Medium | No threshold tuning substituted for reranking |

## Baseline and environment

- Original checkout: `pnpm install --frozen-lockfile` passed. Without Harness,
  typecheck failed on unresolved host declarations and 17 test files could not
  load; 50 pure-function tests passed. This was an environment failure.
- A pre-existing local Harness `0.1.5-rc.2` build was found and selected with
  `DSH_HARNESS_ROOT`. Its exact equivalence to production is **not verified**.
- Before worker/test changes, typecheck passed and five consecutive complete
  suite runs passed **250 tests, 8 skipped** each. The historical random failure
  was not reproduced in those runs; this is not proof that it never occurs.
- A new direct regression reliably reproduced overlapping summary calls:
  12 simultaneous calls all reported a canonical write instead of one. After
  serializing read/compare/write by destination Note, exactly one writes, the
  revision increases once and the body/one managed summary remain intact.
- Tests that assert a manual recovery/reconcile/materialization result now own
  their scheduling. They call the worker drain explicitly instead of allowing a
  timer to consume their fixture first. Real timer-driven convergence tests
  remain active; timeouts and result assertions were not loosened.

## Storage availability boundary

The old disabled suite assumed a `defineDomain({ migrations })` API that the
current Harness does not implement. The enabled suite now checks:

- JSON v1/v2 rejection without changing any bytes, including repeat attempts;
- v3 notes, stable identities, paths, deleted records and empty added tables
  remain readable on reopening;
- invalid v3 records reject without overwriting the medium;
- SQLite rejects v1 under a v3 descriptor and the original v1 records can still
  be reopened intact using the old descriptor.

These checks **do not implement v1/v2 → v3 conversion**. No version header is
silently bumped, no rows are discarded and no production schema is opened or
modified. Before a historical migration can be accepted, identify the actual
storage backend/location/version, obtain sanitized fixtures, and implement an
explicit backup/rollback/idempotence workflow. A green suite is not evidence
that old production media are now upgradeable.

## Target information still required

1. Production Harness repository + commit/release, and the deployment execution
   entry (service manager/start/stop commands and actual `/pkw` origin).
2. GitHub handoff snapshots of installed ui.js and both available backup dates.
3. Actual structured-state backend/location and version, for migration planning.

Keep both machines exchanging code/evidence through GitHub. Do not copy this
developer workspace directly over the production installation.

## Final developer-machine verification

| Layer | Command / evidence | Result |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | Passed |
| Typecheck | `pnpm typecheck` with explicit local Harness root | Passed |
| Tooling | Registry/version guard, snapshot/restore, interrupted installation recovery, HTTP/RPC/version probe, config mapping | 6 passed |
| Full suite | `pnpm test`, five consecutive final runs | Each run: 256 Vitest + 6 tooling passed; 5 real WeKnora tests skipped without credentials |
| Build | `pnpm verify:build` | 10 packages, 56 emitted files identical across builds; stale output removed |
| Packaging | `pnpm verify:packed` | All 10 tarballs installed through a temporary registry; JS imports, hashes, declarations and Vditor passed |
| Installed HTTP/RPC | Emitted packages with real Cordis/SQLite/fs and a test route host | PKW page/version + summary + canonical note create/read passed with WeKnora unavailable |
| Production registry publication | Not executed | Target missing |
| Production restart and `/pkw` | Not executed | Target missing |
| Browser UI / real WeKnora | Not executed | Not claimed |

The isolated registry serves already packed artifacts; it does not prove the
production registry's authentication/publish policy. Rollback tests inject an
installation failure and verify actual file/link restoration plus an HTTP/RPC
probe; they do not restart the production service. GitHub CI results must be read
separately from these local results.

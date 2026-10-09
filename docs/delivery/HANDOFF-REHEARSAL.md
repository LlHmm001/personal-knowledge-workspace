# Serial handoff rehearsal

This entry handles the three remaining rehearsal cases. It does not deploy to
the live installation, clean historical test directories, or replace the
uncommitted patch retained on the server.

## Evidence before this change

The user returned the real server race result for source commit
`f2f4c7df7bf986d21afbc7411d32c4fdb4165e4c`: all 30 requested rounds completed,
each reported confirmed cleanup, and the summary exited zero. Its evidence is
`/LlHmm9527/pkw-codex-race-EW64fh/race.log`. The two production units retained
their PIDs and zero restarts in that returned output. This is a race result,
not production acceptance. The support profile reports `0.1.8-pkw.1` and must
not be relabelled as predecessor `0.1.7-pkw.1`.

## New entry

`deploy/rehearse-matrix.mjs` exclusively creates a new data-disk directory and:

1. Validates both release receipts, exact package names/versions and tar hashes.
2. Checks support-profile isolation, capacity, and fixed pnpm 11.7.0. Copies only
   the store's `files/` package bytes, refusing links within that payload. Project
   registrations, linked installation trees, temporary files and source SQLite
   indexes are excluded. Private pnpm rebuilds its index through normal package
   fetching; this is not an offline cache clone.
3. Assembles the predecessor from its actual old tarballs with the support peer
   closure, checks installed payload bytes, imports, and resolution isolation.
4. Creates a disposable copy of the tool checkout. Its `lib` comparison baseline
   comes from verified new release tarballs, explicitly recorded as
   `basis: verified-release-artifacts, compiled: false`. This checks installation
   against released bytes; it is not a new source compilation.
5. Runs positive fault/verified rollback, real write-failure refusal, and an
   intentionally mismatched permission expectation sequentially. Each has its
   own profile/data copy and port. The strict report predicate checks outcomes,
   not just expected exit codes (respectively 0, 1, 1).
6. Requires real graceful stop outcomes and independent absence evidence. An
   interrupted command, unexplained failure, or remaining owned process-group
   member blocks the overall result. Failed scenes and private logs are kept.

Read-back proves a note marker through the API and attachment disk bytes/hash/
permissions against the write baseline. It does not assert an HTTP attachment
download or a full-body note hash.

The server bootstrap is `docs/delivery/repro-inflight/rehearse-handoff.sh`; give
it the complete reviewed source commit. It creates a fresh checkout and never
updates the original server repository. Missing receipt/materials or a different
package-manager version cause a refusal. Public npm access may be needed for
the pinned package manager or uncached public dependencies; all caches are
private to this run. No private registry credentials are read into child tools.

The intended final status is `three-rehearsals-verified`. Its primary evidence is
`run/matrix-report.json` and per-case `report.json` files. No Linux three-case
result has been obtained for this new entry yet.

## Local checks

- Ten focused test files: 123 total, 121 pass, zero failures, two pre-existing
  tests skipped because this Mac has no real Harness/profile.
- Existing deployment suite: 15/15 pass, using a temporary resolution hook for
  TypeScript already installed in the original local checkout. No dependency
  installation or changes to that checkout.
- Real pnpm 11.7.0 primitive: three synthetic tarballs, two loopback registries,
  private store, old install and copied-candidate upgrade passed; the old tree
  stayed unchanged and the peer resolved inside the candidate. No external
  registry was used in this primitive. This is not the real-product rehearsal.
- Shell syntax and diff whitespace checks passed. Full Harness CI, complete
  server rehearsal, production cutover, and historical cleanup remain separate.

## Correction after the server cache preflight

The first matrix run at commit `b70bf67` stopped with `cases: []` on
`store/v11/projects/016ce6df01435b9854f60ecc5486c926`. This is a normal pnpm
project-registration link, not evidence of a defective package or live service.
The original whole-store selection was incorrect. The stopped scene at
`/LlHmm9527/pkw-codex-rehearsal-WcOjUr` remains evidence; it is not reused.

The new selection is `files/` only. pnpm 11.7.0 source identifies `projects/` as
project links and `index.db` as a WAL-mode SQLite index. Even opening that index
read-only can create or update source WAL/SHM, so the copier never opens it.
The receipt explicitly says `indexPolicy: rebuild-in-private-store`; it does
not claim the index has been rebuilt before installation succeeds.

Verification for this correction:

- Store, matrix, artifact, artifact-reference and verdict suites: 42/42 pass,
  zero skips. New cases cover active/closed WAL source preservation, excluded
  project and database links, refused payload links, overlapping roots, and
  existing-target preservation.
- Real pnpm 11.7.0 with two synthetic packages: private install succeeded and
  created its own two-entry index; runtime returned `leaf:root`. Complete source
  store/profile inventories stayed identical and copied content had independent
  inodes. Two tarballs were fetched from the local fixture registry, with no
  third-party network. This proves the copy/install mechanism, not the server's
  three business rehearsals, which still await execution.

## Installation-exit timeout observed on the server

The `5477b3ca9d283a968f22697d807b79c8c5ab635d` run at
`/LlHmm9527/pkw-codex-rehearsal-YNdx2n` passed predecessor assembly and runtime
checks. Its first positive case printed pnpm 11.7.0's `Done in 3.9s`, then did
not produce a normal child exit before the matrix deadline. The recorded
interruption was SIGTERM and the installation error was `pnpm exited null`.
No candidate runtime check, candidate activation, injected fault or read-back
was recorded. The test listener's graceful exit and independent absence were
confirmed; both live units remained active with their original PIDs and zero
restarts in the user's returned output.

The previous matrix gate conflated interrupted execution and failed cleanup.
It now saves the per-case execution outcome before reading the case report,
retains timeout/signal/escalation and process-group evidence, and distinguishes
`PKW_MATRIX_TIMEOUT`, `PKW_MATRIX_EXECUTION`, `PKW_MATRIX_REPORT`, and actual
`PKW_MATRIX_CLEANUP`. After a deadline, progress explicitly says `stopping`.
Timeout remains failure even if every owned process subsequently stops. The
installation runner also retains the real exit signal instead of saying
`exited null`.

The cause of the server's post-completion hang is **not established**. Cached
pnpm 11.7.0 source emits the Done message after awaiting its command and first
worker shutdown. Two isolated local ten-package hoisted upgrades (direct pnpm
and Corepack, Node 24.15.0) both exited normally, 17 ms and 12 ms after Done.
A separate probe of pnpm's HTTP client also exited normally with a server that
advertised a 600-second keep-alive. These are counterexamples to proposed
causes, not a server fix. Server runtime/entry metadata and live resource
evidence are still needed. Do not increase the deadline or treat Done as an
exit-zero substitute; preserve the failed scene.

## Bounded installation-only exit probe

The server reports Node `v22.23.1` at `/root/.hermes/node/bin/node`, with global
pnpm at `/usr/local/lib/node_modules/pnpm/bin/pnpm.mjs` using `env node`.
Repeating the ten-package primitive with checksum-verified official Node
22.23.1 on this Mac still exited normally (8 ms direct, 7 ms through the
shebang). This does not reproduce Linux x64 behavior or establish the cause.

`docs/delivery/repro-inflight/diagnose-pnpm-handoff.sh` runs
`deploy/diagnose-pnpm-exit.mjs` in a fresh data-disk directory. It reads the
preserved failed scene's assembled manifest, cached package bytes, and support
tarballs, plus the original old/new release receipts and archives. It never
reads application databases, creates an application listener, or touches live
services. It installs a new old profile into a new private store, copies that
profile to a candidate, closes the old registry, then runs the original add
parameters against a new registry. The peer targets come from the failed
rehearsal's actual repacked support set. A copied existing node_modules tree
cannot be used with a different store: pnpm would reject its store binding.

Budgets are 30 seconds for pnpm version, 120 seconds for old installation,
and 60 seconds for add, followed by bounded owned-process termination if needed.
The opt-in preload records process/resource metadata at startup, Done, 2/10
seconds after Done if still alive, and normal exit. Timers are unreferenced;
no termination decision depends on Done. Each trace is at most 3500 UTF-8
bytes, with bounded resource creation locations and explicit omission counts.
The parser reads the full private log rather than a tail, keeping malformed
diagnostics separate from the command's actual exit and cleanup outcome.

Local validation includes normal/held child processes, trace byte limits,
source and existing-output protection, and a real Node 22 installation probe
using ten synthetic PKW tarballs plus a support peer. The original scene and
artifacts stayed byte/metadata identical, child groups disappeared, and the
candidate contained the new payload. This is an installation diagnostic,
not completion of any business rehearsal or production acceptance.

Final local checks: Node 22 focused suites 77/77, zero skips; real synthetic
entry kept all 11 trace records in logs, forwarding, and report (largest 1736
bytes). All three owned command groups were absent afterward. This does not
claim that the server hang has been reproduced or repaired.

## Upstream worker-pool fix: isolated version comparison

The returned `c303f62` server probe at `/LlHmm9527/pkw-pnpm-exit-Jp5xhc`
reproduced the hang without an application listener. Old install exited zero;
new add printed Done at 4047 ms and required SIGTERM at the 60-second deadline.
Owned-child cleanup was confirmed. Live unit PIDs and restart counts were
unchanged in the returned output. At Done +10s the main-thread resource list
contained only stdout/stderr pipes, while allocation samples included the
pnpm worker constructor. Those samples have omissions and no creation timestamp:
they do **not** establish when that worker was created. A Node 22 worker can
keep a process alive while those main-thread resource lists show only pipes.

Upstream [pnpm PR 13226](https://github.com/pnpm/pnpm/pull/13226) fixes a
matching mechanism: late worker work recreates a pool after shutdown, leaving
an idle worker alive. [Official 11.23.0 release notes](https://github.com/pnpm/pnpm/releases/tag/v11.23.0)
include that fix. Local deterministic checks execute the actual bundled
worker APIs as work -> finishWorkers -> late work in private copies:
11.7.0 completes the work but needs termination after 3 seconds; retaining the
pool as upstream does exits zero in 360 ms; official 11.23.0 exits zero in
419 ms. This establishes the upstream defect and fix, not yet the causal
diagnosis or repair of the server's full artifact installation.

`docs/delivery/repro-inflight/verify-pnpm-fix-handoff.sh` downloads official
pnpm 11.23.0 into a new private tool directory, checks the pinned registry
SHA512 before extraction, rejects links/special files/path escapes, and uses
that launcher for the same installation-only probe. It does not install a
global package manager. Only newly generated probe manifests use the 11.23.0
pin; the original scene retains 11.7.0. The version check runs in the new work
directory so the checkout's old pin cannot silently select the old tool.
The old/new PKW receipts, source scene, support set, byte verification and
deadlines stay the same. Normal exit zero remains mandatory; Done is not a
success gate, and timeout remains failure. No application service is started.

Local evidence for this handoff: 79 focused Node 22 tests passed, zero skips;
the real entry with official 11.23.0 and ten synthetic PKW packages plus a peer
completed version/install/add with exit zero. All owned child groups vanished,
all 11 traces were retained, payloads and peer imports passed, and complete
source byte/metadata inventories stayed unchanged. The archive's embedded
verification/extraction was exercised with all 891 files; reuse was rejected.
Server same-artifact verification and the three business rehearsals remain
outstanding. Do not change system pnpm or claim production deployment from
these local results.

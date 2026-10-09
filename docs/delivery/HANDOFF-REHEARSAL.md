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
2. Checks support-profile isolation, capacity, and fixed pnpm 11.7.0. Copies the
   existing CAS store into a private store, refusing symbolic links in either.
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

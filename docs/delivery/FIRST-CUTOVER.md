# First production move to an independent PKW runtime

Status: preparation only. No maintenance window, production stop, unit edit,
package installation into a live profile, data migration or cleanup is executed
by this document or the inventory command.

## Scope and completed evidence

The source `5084f5cee7465edbcd0a7cc73697ddab47521e12` completed the three serial
server rehearsals with overall exit zero at
`/LlHmm9527/pkw-codex-rehearsal-SC6951`. Those gates stay closed. The earlier
30-round startup race also passed. Neither result identifies the current
production package version or converts a legacy installation into a release
layout. The read-only inventory was returned with INVENTORY_COLLECTED and exit zero on 2026-10-09; its concrete baseline is recorded below.

`switchRelease()` expects an existing `current -> releases/<version>` and
`profile` tree. Its input/current rollback does not restore a replaced systemd
unit, drop-in, environment reference or runner path. The first-cutover wrapper
must explicitly preserve and restore those legacy references. Do not seed a
fictional predecessor or relabel the installed packages to match the rehearsed
0.1.7-pkw.1 artifacts.

## Returned live baseline (2026-10-09)

- Inventory status `INVENTORY_COLLECTED`, issues `[]`, exit 0; observed unit and
  process identities stayed stable. This identifies disk files, not loaded-byte
  provenance or authenticated production acceptance.
- Nine PKW packages are `0.1.2-pkw.4`; `dsh-pkw-weknora` is `0.1.0`. Preserve this
  actual mixed version vector. Do not replace it with rehearsal predecessor
  `0.1.7-pkw.1` or stamp every old package with one version.
- Current profile `/root/.dsh/profiles/web`; `session` and `storage` resolve into
  `/opt/dsh-releases/v-cd5ef81481`. Current runner is
  `/LlHmm9527/pkw-delivery-v3/repo/scripts/serve-collaboration.mjs`; actual Node is
  `/root/.hermes/node/bin/node`, port 3081.
- Configuration `/root/pkw-upgrade-2026-10-02/config/collaboration.production.json`;
  environment file `/root/pkw-upgrade-2026-10-02/secrets/pkw-gateway.env` (0600).
  Preserve both paths; no credential contents were requested or received.
- Canonical data root `/root/.dsh/pkw-collab` (0700), 94,531,584 allocated bytes
  (about 90 MiB). Lock belongs to observed PKW PID 1608174; no recovery-pending
  marker. Do not create another writer on that data root during preparation.
- PKW unit `/etc/systemd/system/pkw-collaboration.service` has no drop-ins,
  runs as root with control-group kill mode and a 30-second stop timeout; no
  PartOf/BindsTo/PropagatesStopTo link to DSH was observed. Unit SHA256
  `4fdf72f6c4e12e27d736d0331fcdd9dcecbc86e58f158e74f9ab7b6bb270f6a1`.
- DSH PID 1585972 and PKW PID 1608174 are active/running, both NRestarts 0.
  System disk available 5,297,090,560 bytes (4.93 GiB); data disk available
  21,676,056,576 bytes (20.19 GiB). Recheck space when actually making a backup.

## Next server step: candidate preparation only

`docs/delivery/repro-inflight/prepare-first-cutover.sh` checks the returned unit,
runner/config/profile-input hashes and both live process identities before and
again after the operation. It creates a new `/LlHmm9527/pkw-first-stage-*`
directory with a pinned source checkout and a separate `runtime` root.

`deploy/prepare-first-cutover.mjs` reuses the already assembled successful new
profile from the retained SC6951 positive rehearsal. It does not run pnpm or
repeat the closed three-case matrix. It requires the matrix's three recorded
verdicts and artifact hashes, verifies the current release receipt/tar payloads,
copies bytes rather than hardlinking, rebases only internal links, and compares
complete source and destination fingerprints. Runtime imports and trace checks
run in a private environment without opening any application data root.

Output is `PREPARED_NOT_ACTIVATED`, a profile/runner tree digest, artifact record,
and `drafts/50-pkw-independent.conf`. No `current` link is created and the draft
is not installed. The original service, configuration, credentials, profile,
database and rehearsal evidence remain in place. The copied profile may retain
old installer metadata; do not run package-manager commands in it. Future
updates must install into a new candidate with their own package-manager setup.

This result does **not** authorize a stop. The actual legacy mixed-version
runtime still needs a separate compatibility probe on fresh synthetic data:
old writes → candidate reads/writes → stop candidate → original old runtime
reads both. Use the exact old runner/package/dependency versions read-only,
without changing production credentials or opening production databases. That
addresses a predecessor never covered by the 0.1.7 rehearsal; it does not reopen
those completed gates or claim all historical data has been checked.

The concrete first-cutover adapter is still to be implemented and tested. It
will add one owned drop-in (WorkingDirectory and reset/set ExecStart), retaining
original unit/config/environment references. Runtime environment values have
not been disclosed; the adapter must account for module injection/test flags
without printing secrets before claiming production independence. A final
maintenance decision follows the compatibility result and reviewable stop,
cold-backup, cutover, acceptance and original-service restoration commands.

## Work to finish before a maintenance decision

| Task | Status | Next step | Completion standard | Verification evidence | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Actual live topology | collected; no issues or process changes | retain the returned baseline; recheck it at each preparation boundary | current PID, runner, config, profile, disk package versions, data root and unit references identified; changes during inspection reported | returned inventory JSON | paths or versions may differ from historical reports | no raw environment, credentials or database reads |
| First-cutover adapter and recovery | design fixed; execution pending | implement owned drop-in transaction for the actual legacy service | restore original unit/drop-ins/runner references after confirmed candidate stop; no DSH stop hooks | reviewed implementation plus relevant failure checks | generic release rollback cannot cover first unit replacement | preserve the old installation |
| Candidate and artifact provenance | server preparation passed; not activated | retain O43TIw candidate and check its digests before compatibility/cutover | archive receipts, peer closure and runner source fixed; runtime resolves inside its own profile | package/import checks and existing rehearsal evidence | don't install into the DSH profile | use private verified pnpm; don't change the global tool |
| Data and cold backup | planned, not executed | retain the canonical production dataPath; size backup | stop confirmed before the backup tool claims its lock; archive verified and SHA recorded | backup manifest and verification | copying a live SQLite file is not a consistent backup | no fresh bootstrap/adopt or snapshot overwrite |
| Production acceptance | pending cutover | configure loopback health and public-origin authenticated reads separately | intended version, original note, HTTP attachment download and save/refresh; DSH PID/restarts unchanged | enforcing verifier plus user business confirmation | a health response alone is insufficient | existing-account credentials stay on the server |
| Historical cleanup | deferred | inspect references and prepare a named candidate list | only reviewed unreferenced test outputs removed after retention conditions | sizes and reference evidence | pattern deletion can remove recovery material | this inventory never deletes |

## Required sequence for the concrete cutover command

1. While the legacy service keeps running, construct and verify the independent
   candidate, record its exact runner/package hashes, and prepare the reversible
   unit change. Confirm actual old-version compatibility instead of assuming
   the rehearsal predecessor equals production.
2. Present the exact paths, capacity budget, expected PKW interruption, backup
   command, unit delta, acceptance command and rollback actions. A human chooses
   the maintenance window after those materials are reviewable.
3. In that window, capture the current references; stop only PKW and prove the
   owned writer and children are gone. Run the existing cold-backup tool with
   its real lock protocol and verify the backup. Never remove a live lock to
   make this succeed. If backup fails, preserve evidence and safely resume the
   unchanged original service when stop evidence permits.
4. Activate the independently prepared code with the same canonical data root,
   identity store, spaces, credential references, public origin and proxy route.
   Changing where code lives does not authorize relocating or reinitializing
   the data. Retain original service files and installed profile untouched.
5. On acceptance failure, stop and confirm the candidate, then restore original
   service references and start/verify the actual old runtime. Do not restore an
   older database automatically: that could discard writes accepted by the new
   runtime. Data rollback requires its own reviewed recovery decision if an
   incompatible migration has occurred.
6. After production acceptance and observation, prepare a separate retention and
   cleanup action. Keep recovery materials and the successful rehearsal evidence.

## Inventory boundaries

`scripts/inspect-pkw-live.py` reads only the two named unit states, the current
PKW process metadata, explicitly selected configuration fields, filesystem
metadata and bounded file digests. It does not execute the installed JS, make
HTTP requests, open SQLite databases, read environment-file contents, start or
stop units, claim a data lock or write a report file. Its JSON is inventory,
not deployment approval or authenticated production acceptance. The shell
handoff downloads the script into a new data-disk file and verifies its digest;
that download is the only intended server write in this inspection step.

Disk package versions and current file hashes describe files on disk. They do
not prove which bytes a long-running process originally loaded. Partial or
changing metadata remains explicitly incomplete, not a reason to guess paths.
The real Harness CI job previously lacked repository inputs; a local/server
pass must not be represented as an independent CI run.

## Preparation-tool verification

Local Node 22 checks: `first-cutover-preparation`, `rehearsal-artifacts` and
`rehearsal-reference` together passed 28/28 with zero skips. Cases cover receipt
and completed-evidence binding, exclusive creation, internal/external links,
no hardlinks or source/data/credential mutation, runtime failure and drift,
startup provenance, and a late interrupt refusing success. Shell syntax and
whitespace checks passed. These verify the preparation tool; server preparation passed as recorded below; actual legacy compatibility/cutover remain separate evidence.


## Returned candidate preparation (not activation)

The server returned exit 0 / `PREPARED_NOT_ACTIVATED` for tool source
`9c2369363c9879e0530fcee0c28d9c2ca4a7fc82`:

- Runtime: `/LlHmm9527/pkw-first-stage-O43TIw/runtime`.
- Profile: `releases/0.1.9-pkw.1/profile`, tree SHA-256
  `06f957837b4d4dca1c366f18217cfe72aa0840156cb46c0c0301896dd9431e2b`.
- Runner: `releases/0.1.9-pkw.1/runner`, tree SHA-256
  `8c3fabd29aa8d21a97749f12b32e8f782b566b766ecb639b34c09d68c48a075f`.
- Runtime imports/trace and cleanup passed. No current link, service start,
  data access or installed unit draft. Live PKW PID 1608174 and DSH PID 1585972
  remained active with zero restarts across the operation.

## Exact installed legacy synthetic compatibility

`docs/delivery/repro-inflight/check-legacy-compatibility.sh <fixed-source-SHA>`
creates one exclusive `/LlHmm9527/pkw-legacy-compat-*` scene. It runs
`deploy/check-legacy-compatibility.mjs` with a six-minute cooperative deadline.
Each listener has its own bounded startup/shutdown, continuously drained pipes,
private HOME/TMP/cache, and a cleared/allowlisted environment. A loader observes
only that child binding its loopback port; nonce/PID/port, its own data lock and
health response must agree before any login or write. Health alone cannot
identify the child. The preload does not change application/API behavior.

The command reads installed **code** at the exact old runner and mixed profile:
9 PKW packages `0.1.2-pkw.4`, WeKnora `0.1.0`. It verifies the recorded runner
and profile manifest plus all 10 PKW package manifests/lib trees, and the full
prepared profile/runner hashes. It does not install packages or read production
configuration, environment files, locks, SQLite, content or credentials.
It does not prove which code bytes the long-running live process loaded, nor
fingerprint the entire external legacy peer closure.

The three sequential lifetimes use the same exclusively new synthetic data and
new random credentials:

1. Installed legacy: bootstrap via product, authenticate, create a note and
   attachment via real RPC, link them, verify full body and HTTP download.
2. Prepared candidate: authenticate the same account/space, read the old fixture,
   create and verify another note/attachment.
3. Installed legacy again: authenticate the same account/space and read both
   fixtures, comparing complete body, attachment HTTP bytes, disk bytes and
   their original modes. No invented SQLite records or expected mode shortcuts.

Between phases, success requires native exit 0, stream closure, PID and owned
process group gone, port free, and synthetic lock absent. Failure/force/unknown
never starts the next writer. No lock is deleted to make this pass. All scenes
and private logs survive errors. SIGINT/SIGTERM are handled cooperatively;
SIGKILL of the driver cannot run cleanup and must not be used as a timeout.

Before and after, only named unit/process/code metadata is compared against the
returned live baseline. `LEGACY_SYNTHETIC_COMPATIBILITY_PASSED` can be emitted
only after all three lifetimes and the final unchanged-code/live checks pass.
This server check is **pending** until the user returns its report. Its eventual
pass does not replace production cold backup, authenticated business acceptance,
or the separate maintenance decision. The first-cutover adapter remains pending.

Compatibility-tool local checks: Node 22.23.1 ran the client, owned-process and
scenario suites together: 24 passed, zero failures/skips. Real child-process
cases cover occupied ports, early exit, abort, forced shutdown, bounded pipe
logging, three-instance reuse and a second-SIGTERM regression. Scenario cases
cover exact sequencing, failure cleanup, last-phase interruption, existing
scenes and before/after drift. These are tool checks, not server compatibility
results. Shell syntax, bounded archive-path validation and diff whitespace also
passed. No product package or prepared artifact changed for this command.

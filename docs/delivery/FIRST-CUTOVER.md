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
layout. A fresh inventory is needed for the first production move.

`switchRelease()` expects an existing `current -> releases/<version>` and
`profile` tree. Its input/current rollback does not restore a replaced systemd
unit, drop-in, environment reference or runner path. The first-cutover wrapper
must explicitly preserve and restore those legacy references. Do not seed a
fictional predecessor or relabel the installed packages to match the rehearsed
0.1.7-pkw.1 artifacts.

## Work to finish before a maintenance decision

| Task | Status | Next step | Completion standard | Verification evidence | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Actual live topology | waiting for server inventory | run the fixed read-only script | current PID, runner, config, profile, disk package versions, data root and unit references identified; changes during inspection reported | returned inventory JSON | paths or versions may differ from historical reports | no raw environment, credentials or database reads |
| First-cutover adapter and recovery | pending topology | specify exact old/new paths and unit delta | restore original unit/drop-ins/runner references after confirmed candidate stop; no DSH stop hooks | reviewed implementation plus relevant failure checks | generic release rollback cannot cover first unit replacement | preserve the old installation |
| Candidate and artifact provenance | pending topology | stage in a new data-disk directory | archive receipts, peer closure and runner source fixed; runtime resolves inside its own profile | package/import checks and existing rehearsal evidence | don't install into the DSH profile | use private verified pnpm; don't change the global tool |
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

# First production move to an independent PKW runtime

Status: the candidate and actual installed legacy synthetic compatibility checks
passed on the server. The first-cutover tools are implemented and tested locally.
The next server operation is **prepare a plan only**. Production cutover,
production acceptance, maintenance approval and historical cleanup remain pending.

## Completed evidence and the actual predecessor

The three serial rehearsals passed with tool source
`5084f5cee7465edbcd0a7cc73697ddab47521e12` in
`/LlHmm9527/pkw-codex-rehearsal-SC6951`; the earlier startup race also passed.
Those completed gates are not rerun by first-cutover preparation. Their
`0.1.7-pkw.1` predecessor is not the version currently serving production.

The returned inventory on 2026-10-09 identified nine installed PKW packages at
`0.1.2-pkw.4` and `dsh-pkw-weknora` at `0.1.0`. This mixed version vector is
preserved. Installed files and process metadata do not prove the exact bytes a
long-running process originally loaded.

The candidate preparation returned `PREPARED_NOT_ACTIVATED`, exit 0, using source
`9c2369363c9879e0530fcee0c28d9c2ca4a7fc82`:

| Prepared object | Location or SHA-256 |
| --- | --- |
| Runtime root | `/LlHmm9527/pkw-first-stage-O43TIw/runtime` |
| Candidate profile | `releases/0.1.9-pkw.1/profile` |
| Profile tree | `06f957837b4d4dca1c366f18217cfe72aa0840156cb46c0c0301896dd9431e2b` |
| Candidate runner | `releases/0.1.9-pkw.1/runner` |
| Runner tree | `8c3fabd29aa8d21a97749f12b32e8f782b566b766ecb639b34c09d68c48a075f` |

Imports and trace checks passed. No `current` link was created, the prepared
unit draft was not installed, and no production data root was opened. Preparation
copied and checked the already assembled candidate; it did not install packages
into the DSH profile. Do not run pnpm in this retained profile. Future package
installation belongs in a new candidate with its own package-manager setup.

The user then returned `LEGACY_SYNTHETIC_COMPATIBILITY_PASSED`, exit 0, from
source **`b634a58a7953b039dc4ca662eb19eca3363c1ebd`**. Its retained report is:

`/LlHmm9527/pkw-legacy-compat-Z73xiQ/run/compatibility-report.json`

All three authenticated phases passed: installed legacy `0.1.2-pkw.4` wrote
synthetic content; candidate `0.1.9-pkw.1` read it and wrote more; the installed
legacy runtime read both back. The checks compared complete note content,
attachment HTTP/disk bytes and recorded modes. Every listener exited and its
owned resources were confirmed released before the next phase. The report
records `cleanupConfirmed`, `liveBaselineUnchanged` and `inputsUnchanged` as true,
`syntheticOnly:true`, and `productionAcceptance:"not_run"`.

This is evidence for the actual predecessor, using new synthetic data and new
credentials. It does not inspect every historical production record or replace
cold backup and authenticated production acceptance. The compatibility tool
fingerprinted the legacy PKW code and the prepared candidate; it did not claim
a fingerprint of the entire external legacy dependency closure.

## Retained production boundary

The following are the returned baseline, not a claim that later state can be
assumed unchanged. Preparation and activation check them again and refuse drift.

| Item | Recorded value |
| --- | --- |
| Legacy profile | `/root/.dsh/profiles/web` |
| Legacy runner | `/LlHmm9527/pkw-delivery-v3/repo/scripts/serve-collaboration.mjs` |
| Actual Node | `/root/.hermes/node/bin/node`, version `22.23.1` |
| PKW listener | `127.0.0.1:3081` |
| Public origin | `https://ddmind.duckdns.org` |
| Configuration | `/root/pkw-upgrade-2026-10-02/config/collaboration.production.json` |
| Environment file | `/root/pkw-upgrade-2026-10-02/secrets/pkw-gateway.env`, mode `0600` |
| Canonical data root | `/root/.dsh/pkw-collab`, mode `0700` |
| Original unit | `/etc/systemd/system/pkw-collaboration.service`, no drop-ins |
| PKW process | PID `1608174`, active/running, `NRestarts=0` |
| DSH process | PID `1585972`, active/running, `NRestarts=0` |

The data root used about 90 MiB at inventory time. Space is measured again; the
plan requires at least the greater of 512 MiB or four times allocated data plus
64 MiB on the data disk, and 256 MiB available on the system disk. The original
unit uses control-group kill mode and a 30-second stop timeout. No unit stop
propagation relationship to DSH was observed.

No first-cutover operation stops or restarts DSH. The original unit file, legacy
profile, production configuration and environment-file contents stay in place.
The canonical data root, identity database, spaces, public origin and proxy route
are retained. Changing code location does not authorize moving or initializing
production data, resetting an account, or deleting recovery material.

## Next server step: prepare a reviewable plan

`docs/delivery/repro-inflight/prepare-first-cutover-plan.sh <fixed-source-SHA>`
creates a new private `/LlHmm9527/pkw-first-cutover-*` directory, downloads that
exact source archive, validates archive paths and types, and invokes
`deploy/first-cutover.mjs prepare`. The operator uses the reviewed bootstrap
SHA-256 and full source SHA supplied with the handoff. No mutable branch URL is
used as the deployment instruction.

The script prompts on the server's controlling terminal for the **existing PKW
web account** and password. Password input is hidden and is saved only to an
exclusively created `credentials.json`, mode `0600`, inside the private directory.
It is not placed in command arguments, terminal output or the report. It must
not be pasted into chat. This is neither the bootstrap secret nor a password
reset. Without a real terminal, the prompt fails rather than echoing a password.

Preparation rechecks the compatibility report, code and unit/configuration
hashes, data-root identity, free space, DSH identity and the actual PKW process.
The loopback listener must belong to that process, which must also own the data
lock. It then logs in, chooses an existing private-space note and attachment,
and records full content/markdown/attachment digests without returning their
contents. If the account cannot provide that baseline, preparation fails before
any service action.

The HTTP client connects to loopback with the configured public Host and Origin.
Login can create ordinary session/audit metadata in the existing service. The
preparation step performs **no business-content writes**, package installation,
stop/start, backup, `current` creation or unit edit. This authenticated read is
more than the earlier metadata-only inventory and remains distinct from
post-cutover acceptance.

A successful result is `FIRST_CUTOVER_PLAN_READY`, with the private `plan.json`
path, its exact SHA-256, capacity budget and command previews. `unit-change.json`
contains the proposed drop-in. The plan binds the tools, compatibility evidence,
old/new code, original references and acceptance credential file. **Printing an
activation command does not execute it or approve a maintenance window.** Return
the summary output for review; retain the private directory without publishing
its contents.

## The reviewed service change and maintenance transaction

The adapter creates only these owned service references:

- `/LlHmm9527/pkw-first-stage-O43TIw/runtime/current` points to
  `releases/0.1.9-pkw.1`.
- `/etc/systemd/system/pkw-collaboration.service.d/50-pkw-independent.conf`
  changes WorkingDirectory and resets/sets ExecStart to the new runner and
  profile, using the original configuration path and port 3081.

The drop-in preserves the existing EnvironmentFile and business settings. It
clears module-injection and test-only environment flags and disables runtime
compile caches. The existing `NODE_EXTRA_CA_CERTS` service setting, if any, is
preserved; the separate preparation bootstrap clears inherited tooling loaders
before executing its own checks. Unknown drop-ins or changed owned files cause
refusal rather than replacement.

After a human chooses the maintenance window, activation requires both the
exact plan digest and explicit `--maintenance-approved`. It captures a **fresh**
existing-content baseline before stopping PKW; an old plan's content hashes are
not substituted for current content. A single service adapter retains observed
process identities through the transaction:

1. Stop PKW and confirm the unit, observed processes, cgroup, listener and data
   lock are stopped/released. Unknown observations never count as stopped.
2. Create the cold backup in the plan's `cold-backup` **directory**. It contains
   raw data, SQLite snapshots and `manifest.json`, not a tar archive. The backup
   tool uses its own lock protocol only after PKW is confirmed stopped, verifies
   readiness and backup contents against the stopped source, and records the
   manifest SHA-256. A surviving backup worker or lock blocks continuation.
3. Reconfirm stopped state, install the owned references and reload systemd.
   Start the candidate, confirm process/listener/lock ownership, then compare the
   same original note and attachment through an authenticated session.
4. Recheck DSH identity/restarts. Only these completed checks produce
   `ACTIVATED_VERIFIED`. Browser login, original-note/attachment access and a new
   save/refresh check by the user remain separately pending business confirmation.

There is no package install or database conversion step during this first
maintenance transaction. The cooperative command deadline is bounded, but it
is not a promised interruption duration; backup and recovery depend on observed
state. Do not impose an outer SIGKILL timeout that prevents cleanup/recovery.

## Failure recovery and operator limits

The journal records action intent before effects and the observed result after
each action. If the candidate may have started, recovery requests its stop and
obtains fresh stopping evidence before removing either owned reference or
starting the original service. A complete backup never substitutes for current
stop evidence. After restoring the original references, recovery starts the
actual old runtime and verifies the pre-stop note and attachment baseline.

An unrelated DSH identity change is recorded and prevents a verified success
claim, but is not a prerequisite for safely restoring PKW's own original
references and restarting the confirmed-stopped PKW service.

A failed activation with verified original-service recovery is still a failed
deployment (`FAILED_ORIGINAL_RESTORED_VERIFIED`). Unconfirmed stopping, changed
references or unverified recovery produce `RECOVERY_BLOCKED_OR_UNVERIFIED`;
these do not authorize a second writer or a blind retry. A pre-stop failure is
`STOPPED_BEFORE_SERVICE_ACTION`.

Rollback changes **code references only**. It never restores an earlier database
automatically, because that could discard writes the candidate accepted. A
separate manual rollback command is supported only after the same plan recorded
`ACTIVATED_VERIFIED` and the candidate is still identifiable. It captures a fresh
candidate-content baseline, stops the candidate, restores original references
and checks that the old runtime reads that baseline. Data recovery, if ever
needed, requires a separate reviewed decision.

An activation journal prevents rerunning the same activation. Interrupted scenes,
ambiguous locks, failed journal writes and disk I/O errors require inspection of
the retained evidence. Journal failure after stopping can also prevent automatic
recovery from proceeding; the script does not claim guaranteed recovery when its
own evidence cannot be persisted. Never delete the production data lock, rerun
bootstrap, or overwrite the journal to bypass a refusal. SIGKILL cannot run the
cooperative recovery path.

Keep the plan directory, credentials file, cold backup, original installation and
both successful rehearsal/compatibility evidence directories private and intact.
Credential disposal and historical cleanup are later, named actions after
acceptance and retention review; this handoff deletes none of them.

## Verification boundaries

Local Node 22.23.1 verification: `node --test scripts/tests/first-cutover-*.test.mjs`
completed with 95 passed, 0 failed and 0 skipped; `bash -n` on the preparation
bootstrap and `git diff --check` passed. These include the retained candidate
preparation tests and the new plan/transaction tests.

Local suites exercise the first-cutover transaction's stop/recovery ordering,
partial-start and interruption paths; exact owned-reference changes; systemd,
PID/cgroup/listener/lock evidence; authenticated full-content checks; cold-backup
worker outcomes; and the terminal/bootstrap guards. They are tool tests, not a
record of operating this production unit. Candidate preparation and actual-legacy
synthetic compatibility are the returned server results recorded above.

The next expected server evidence is `FIRST_CUTOVER_PLAN_READY`. Production
activation, post-cutover authenticated acceptance and user business confirmation
are not run. Real Harness CI still requires its repository inputs; local and
server checks must not be reported as an independent Harness CI pass.

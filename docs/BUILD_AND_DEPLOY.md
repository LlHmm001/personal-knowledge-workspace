# PKW build, package and deployment

This pipeline upgrades an **existing** PKW profile. It does not provision a new
Harness, change the extension bundle, migrate data, or infer service commands.
Production patch backflow (P0-3) is a prerequisite to activating a different UI.

For the new private/team-space gateway, use the separate
[collaboration deployment and operations guide](upgrade/COLLABORATION_DEPLOYMENT.md)
and [data preservation/import procedure](upgrade/DATA_MIGRATION.md). The existing
deployment command does not enable authentication, migrate data or change routes.

## Local prerequisites and build

Use the repository's `pnpm@11.7.0` and Node 22.19+ or Node 24. The Harness checkout
must already have its dependencies and host declarations/runtime built. Choose
the checkout explicitly; omitting the variable preserves the deployment seam:

```sh
export DSH_HARNESS_ROOT=/opt/deepseek-harness
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm verify:build
pnpm verify:packed
```

`DSH_HARNESS_ROOT` must be absolute. No sibling-directory layout or system symlink
is created. `tsconfig.json` and `tsconfig.base.json` retain the default mapping;
the tooling substitutes the configured root. Vitest writes an ignored generated
config alongside them. Harness peers are supplied by the host, so automatic peer
installation is disabled in this development workspace.

All ten packages have a `build` command. The root compiler checks all source
roots together (including Cordis service augmentations), emits only PKW, and
writes `lib/*.js` plus declarations. Relative `.ts` imports in JavaScript **and
declarations** become `.js`. Package entry points target `lib`; source/tests are
excluded from published files. `base` exports the location of its existing YAML
patch; importing it does not register services or apply that patch.

`pnpm --filter @deepseek-ai/dsh-pkw-web build` checks the full source graph and
emits the selected package. Use root `pnpm build` before packaging a release.
Compiler failures leave previous outputs intact. Successful builds remove stale
output modules. `verify:build` checks two complete builds by SHA-256 and injects a
stale output to prove removal.

`verify:packed` packs every package, serves the tarballs through a temporary
loopback registry, installs an isolated profile, and verifies:

- package contents exclude sources, tests, node_modules and npmrc;
- all internal dependency versions resolve through the registry;
- the installed PKW base YAML composes with the actual Harness base/Web bundle
  YAML through Harness's own parser and include algorithm, without warnings or
  duplicate IDs; shared host services remain unique, DSH/workspace keep JSON,
  and exactly five PKW domains route to the unchanged SQLite path;
- installed artifacts match the built files; plain Node imports all ten entries;
- installed type declarations work for a TypeScript consumer;
- Vditor/Lute loads its installed asset and renders Markdown;
- installed PKW handlers serve `/pkw` and summary RPC, and create/read canonical
  notes with WeKnora unavailable, using real Cordis, SQLite and filesystem seams.

The bundle check reads the installed artifact, rejects a PKW source symlink,
and does not activate plugins, evaluate `!!js`, or read user profile/home
overlays. It therefore does not certify a target server's custom composition.

This is a local installation/integration check. Its HTTP route host is a test
adapter, not the production DSH process or browser acceptance.

## Isolated browser preview

With the same `DSH_HARNESS_ROOT`, run `pnpm preview`. It builds and verifies the
tarballs, then prints a `PREVIEW_URL` bound to `127.0.0.1`. Open that address to
try the actual installed UI with disposable sample notes, SQLite and files.
WeKnora is intentionally unavailable; no production configuration or user data
is loaded. Stop with Ctrl+C to dispose the test host and remove the temporary
installation and workspace. This is a development preview, not a production
server or a deployment command.

## Read-only target inventory

The deployment side can collect the following evidence after fetching this
repository through GitHub. Only Node is required; no package installation or
service restart is performed by this command:

```sh
node scripts/inspect-profile.mjs \
  --profile /root/.dsh/profiles/web \
  --harness /opt/deepseek-harness
```

Use the real target paths. The JSON reports installed PKW/host versions and entry
hashes, available UI artifact/backup hashes, and the Harness commit when the
supplied directory is its Git root. Unresolved packages and a missing source
commit are reported explicitly. Entry hashes are an inventory aid, not proof
of every host dependency or service behavior. The command does not read notes,
databases, environment variables, registry credentials or service configuration;
it does not copy UI source. Actual UI snapshots, storage location/schema and
service commands still need a separate deployment-side handoff.

## Review manual UI patches before activation

Have the deployment side commit sanitized, read-only snapshots of current
`dsh-pkw-web/lib/ui.js` and available `ui.js.bak-*` files to a GitHub handoff
branch. Record the profile location, capture time, file hashes and Harness
release/commit. The brief and handover name different backups
(`20260825-004526` and `20260831-072433`); inspect both when available.

Compare the backups, current artifact and newly compiled source. Record each
behavioral change and its source backport or reason it is already present.
Do not copy generated JavaScript wholesale into TypeScript.

If the production UI differs from the build, deployment requires a review JSON:

```json
{
  "productionSha256": "SHA256 of the reviewed installed lib/ui.js",
  "sourceSha256": "SHA256 of the resulting repository web/src/ui.ts",
  "changes": ["Each reviewed manual change and its source location/disposition"]
}
```

The gate binds the review to current bytes. It cannot replace the human/code
review itself. A missing/stale review stops before publishing or stopping DSH.

## One-command deployment

### Registry availability is a deployment prerequisite

The configured loopback registry must be running, retain its configuration and
storage, and authorize the deployment account to **publish and install** all
`@deepseek-ai/dsh-pkw-*` packages. A successful ping, anonymous read, or `npm whoami`
alone does not prove publishing permission. `--dry-run` does not publish and is
not evidence that this prerequisite passed. The real command publishes every
artifact before stopping the installed service; a 401/403 or partial publication
must stop the attempt with the old installation intact.

Keep registry configuration, user database and credentials in controlled backups.
If authentication cannot be restored, do not enable anonymous publishing or
disable authentication to pass the gate. A site-specific temporary loopback
registry must be reviewed and kept alive through publication **and installation**;
`PKW_LOCAL_REGISTRY=1` is not a supported switch of this repository's deployment
CLI. Preserve and compare any such server-side script changes before updating.

### Failed deployment versus failed recovery

The default `verifyHttp` contract requires actual PKW HTML and business RPC; it
does not count a login page, HTTP 401 or a generic 200 as acceptance. The private
receipt now retains `errorDetails`: both deployment and recovery cause chains,
plus recovery `phase`, `profileRestored`, `serviceRestarted` and `verified`.
`PKW_ROLLBACK_FAILED` means recovery was not verified; it cannot be changed into
success by matching a different error string. Inspect the nested causes first.

`activate(options, execute, verify)` also supports a reviewed environment-specific
verifier. Existing adapters may instead pass `options.verify`; conflicting or
non-function verifiers are rejected before service changes. It is used for both
activation and rollback and must validate actual
business behavior (and the requested version on activation); never pass a no-op.
The CLI continues to use the strict default probe. An authenticated collaboration
gateway needs its own authenticated, space-scoped acceptance; do not remove its
access protection just to satisfy the legacy single-profile probe.

Run on the deployment machine **after fetching the reviewed commit from GitHub**.
Use a fresh immutable version; neither source manifests nor old registry versions
are overwritten. Supply absolute executable stop/start hooks for the actual DSH
service. Each hook must wait until its operation finishes and return a nonzero
status on failure. Hooks run with the profile as their working directory.

```sh
DSH_HARNESS_ROOT=/opt/deepseek-harness \
PKW_STOP_HOOK=/absolute/path/stop-dsh-web \
PKW_START_HOOK=/absolute/path/start-dsh-web \
pnpm run deploy \
  --profile /root/.dsh/profiles/web \
  --version 0.1.1-pkw.1 \
  --registry http://localhost:4873 \
  --url http://127.0.0.1:3080 \
  --ui-review /absolute/path/ui-review.json \
  --dry-run
```

The paths/port/version above are examples; use the verified target configuration.
`--dry-run` runs typecheck/tests/build, UI review, installed host resolution and
HTTP/RPC preflight. It does not publish, change the installed packages or call
service hooks. Remove `--dry-run` to run the complete pipeline. The shell entry
`scripts/deploy-pkw.sh` accepts the same arguments.

The executing form performs these steps:

1. Acquire a per-profile deployment lock and perform the checks above.
2. Stage and pack all packages with exact internal versions. Publish all artifacts
   to the loopback registry under the `pkw-candidate` tag before touching the
   running installation. Existing versions are immutable; partial publication
   does not cause an install and is never automatically unpublished.
3. Stop DSH and snapshot package manifests, lockfiles, npmrc and the complete
   node_modules tree (including symlinks) into a private backup directory.
4. Install the exact package versions with lifecycle scripts and automatic host
   peer installation disabled. Verify installed host entry hashes did not change,
   then run the plain-Node artifact/import/Vditor check in that profile.
5. Start DSH and verify the PKW HTML, its `X-PKW-Version` header, and a successful
   `POST /pkw/api` summary contract. The version is captured when the web module
   loads, so an old process cannot claim a newly written package.json version.
6. If installation or acceptance fails, stop the service, restore the previous
   installation, restart it and verify its page/RPC. Recovery failure is reported
   separately, with the backup retained.

Receipts, tarballs and backups remain in
`<profiles-directory>/.pkw-deployments/<version>/`. The receipt records artifact
hashes, UI review, host entry hashes and acceptance status. These local backups
can contain registry credentials; do not commit them. Canonical notes,
attachments and storage media are outside this installation rollback. This
pipeline does not roll back user edits or perform schema migrations.

`/pkw` probes cover a running route and read-only business RPC. Target browser
interaction, production dataset acceptance and external WeKnora integration
remain separate evidence. Never infer them from this command's local tests.

## CI

Public repository checks and tooling tests run without private Harness access.
The full job requires `HARNESS_REPO_URL`, `HARNESS_REPO_TOKEN`, and preferably an
exact `HARNESS_REF` matching deployment. It installs/builds that checkout, then
runs typecheck, tests, repeat-build and installed-package verification. A failed
test is no longer tolerated. If the Harness repository is unconfigured, that
job is visibly **skipped**, not a compilation/runtime pass.

## Independent PKW runtime (recommended target)

A PKW installation must not depend on a DSH installation to start, and a PKW release
must not be able to change DSH. Both properties come from one decision: PKW owns its
package tree.

### Why the shared-profile install is not used

Inside a DSH profile the PKW packages' Harness peers (`"*"` ranges) are resolved
through ancestor directories. On a real host those ancestors are symlink farms
pointing into the installed DSH release, so:

- a PKW install writes `package.json`, `pnpm-lock.yaml`, `.npmrc` and
  `node_modules` of a profile that DSH also loads;
- the peers PKW actually loads change whenever DSH is upgraded or restored;
- a failed install can leave DSH unable to load its own plugins.

Installing into a shared profile — including with `--frozen-lockfile` or with
optional dependencies disabled — keeps every one of those properties. It is
therefore not an accepted fallback.

### Building the independent profile

```
node scripts/pkw-independent-profile.mjs   --profile /srv/pkw/releases/<version>/profile   --version <version>   --store /srv/pkw/store --cache /srv/pkw/npm-cache --tmp /srv/pkw/tmp
```

The script resolves every reachable `@deepseek-ai/*` peer from the **pinned Harness
source tree** (`--harness`, default `$DSH_HARNESS_ROOT`), packs it with `workspace:`
ranges rewritten, publishes the tarballs to a one-off loopback registry, and installs
them next to the ten PKW packages. Afterwards it proves with Node's own resolver
that every package resolves inside the profile and that none resolves under the DSH
release root or a DSH profile farm; a violation exits 5.

`hoisted` layout is not a requirement in itself — what matters is that the closure is
pinned, the resolution never borrows the live DSH tree, and the real install plus the
business tests pass. The script uses `nodeLinker: hoisted` because that is what the
plugin runtime expects, not as a gate.

### Registry notes

Optional cross-platform binaries in a DSH profile's lockfile (for example
`@openai/codex-*`, >100 MB each) are pulled in whenever pnpm re-resolves the whole
graph. A loopback registry with a short uplink timeout turns those into retry loops
that can stall an installation, so `deploy/site/loopback-registry.mjs` defaults to
20 s for the primary uplink and 60 s for the fallback, both configurable
(`PKW_REGISTRY_TIMEOUT_MS`, `PKW_REGISTRY_FALLBACK_TIMEOUT_MS`). Pre-warming the
store is a last resort, not a prerequisite. An independent profile does not contain
those packages at all, which removes the problem at the source.

### Install first, switch second

`prepareInstall()` performs the exact-version install **while the previous release is
still serving**, then runs the strict import check. `activate({ prepared })` snapshots
the restored profile, verifies that the profile inputs are unchanged since
preparation, stops the service, switches, restarts and verifies. A preparation
failure therefore never leaves a stopped service, which is what happened when install
and stop were one step.

### Shutdown contract

`scripts/serve-collaboration.mjs` reports exactly one of two outcomes:

- `graceful-shutdown` + exit 0: in-flight responses finished, space runtimes closed
  (committed writes complete, databases closed), identity store closed, data-root lock
  released by `gateway.close()`;
- `forced-exit` + exit 1: the drain budget expired, closing failed, or a second signal
  arrived. The lock is deliberately **not** removed on this path, because something may
  still hold the root.

`PKW_DRAIN_TIMEOUT_MS` (default 25 s) must stay below the unit's `TimeoutStopSec`
(30 s) so a non-graceful stop is reported before systemd escalates to `SIGKILL`.

### Verifying a deployment

`deploy/site/verify-collaboration.mjs` is designed to be passed as the third argument
of `activate()`, so the same contract applies to activation and rollback. It refuses a
login page, a bare HTTP 200, a gateway that is not started from the profile being
deployed, and a version mismatch. When no owner credential file is supplied it says
`not_verified_no_credentials` instead of implying that business behaviour was checked.

### Classifying an installed profile

`scripts/check-declared-vs-installed.mjs` answers whether an installed tree is
`CURRENT`, `BEHIND_REPO`, `AHEAD_OF_REPO`, `CORRUPT` or `UNVERIFIED`. It reports
`CORRUPT` only when a trusted release manifest with per-file hashes is supplied;
a version string alone is never evidence, and the tool never fails a gate. The strict
`check-runtime-imports.mjs` stays exactly as it is: an installed older release is
expected to fail it, and that failure is a classification problem, not something to
relax.

### Service unit

`deploy/pkw.service` is a template (fill `@PKW_ROOT@` and `@PKW_VERSION@`). It
contains no DSH path and no hook that stops or starts another service. Prefer keeping
the existing unit name and changing only `ExecStart`; if a rename is genuinely needed,
stop and disable the old unit and confirm the port is free and `gateway.lock` is
released **before** enabling the new one, so two auto-restarting services never race
for the same data root.

### Data roots

The production data root stays where it is. Any migration out of `DSH_HOME` is a
separate change with its own consistency snapshot, checksum list, absolute-path
rewrite verification and rollback plan. A rehearsal copy must also drop the retrieval
configuration (or point it at a loopback stub) and rewrite absolute workspace paths
found in the copied databases before the copy is started.

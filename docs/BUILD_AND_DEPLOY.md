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
- installed artifacts match the built files; plain Node imports all ten entries;
- installed type declarations work for a TypeScript consumer;
- Vditor/Lute loads its installed asset and renders Markdown;
- installed PKW handlers serve `/pkw` and summary RPC, and create/read canonical
  notes with WeKnora unavailable, using real Cordis, SQLite and filesystem seams.

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

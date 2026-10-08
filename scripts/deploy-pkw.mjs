#!/usr/bin/env node
/**
 * DISABLED. This entry point installed a release into the profile a service was using.
 *
 * That is the failure mode the independent runtime exists to remove: a release install
 * must never write the profile in service, and a failed install must never be able to
 * leave a stopped service behind. The supported path is `deploy/switch-release.mjs`,
 * which installs into a fresh candidate directory, promotes it inside one recoverable
 * transaction, and preserves the previous release for the rollback.
 *
 * The file is kept so an existing invocation fails loudly with instructions instead of
 * silently doing the old thing.
 */
process.stderr.write(`scripts/deploy-pkw.mjs is disabled.

It installed a release into the profile in service, which can leave a stopped service
with no rollback. Use the supported entry point instead:

  node deploy/switch-release.mjs \\
    --root <release-root> --version <new-version> --artifact-dir <staged-artifacts> \\
    --stop-hook <stop.sh> --start-hook <start.sh> --verify-hook <verify.mjs> \\
    [--reachable-url http://127.0.0.1:<port>]

See docs/BUILD_AND_DEPLOY.md ("Independent PKW runtime").
`)
process.exit(3)

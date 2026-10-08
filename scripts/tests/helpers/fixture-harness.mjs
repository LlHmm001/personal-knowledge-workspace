#!/usr/bin/env node
/** Write a synthetic Harness tree so the profile builder can run without a private checkout. */
import { makeSyntheticHarness } from './synthetic-harness.mjs'

const target = process.argv[2]
if (!target) { process.stderr.write('Usage: node scripts/tests/helpers/fixture-harness.mjs TARGET_DIR\n'); process.exit(2) }
const root = await makeSyntheticHarness(target)
console.log(root)

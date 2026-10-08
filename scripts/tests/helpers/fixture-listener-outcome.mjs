#!/usr/bin/env node
/**
 * Test-only probe: end the fixture listener after it has generated its data.
 *
 * Some failure modes of the generator can only be produced against the real entry point, and this
 * is the one that needs a helper: the listener must finish the API work and *then* end in a way
 * nobody asked for — exiting non-zero, or dying from a signal — so the generator's outcome gate
 * can be observed refusing to report a fixture.
 *
 * The child is asked to end through the listener's own test-only escape hatch
 * (`PKW_TEST_LISTENER_EXIT`), and this watches the data root so the ending lands *after* the API
 * work: the moment both a note and an attachment exist, it writes `PKW_FIXTURE_PROBE_ARMED` into
 * the data root, which the listener is polling for. Without that order the listener would die
 * before generating anything, and the case under test would never be reached.
 *
 * Never referenced outside `scripts/tests/generator-trace-gates.test.mjs`, and only on a data root
 * and a port the test created itself.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.env.PKW_FIXTURE_PROBE
const target = process.argv[2]
if (!mode || !target) {
  process.stderr.write('Usage: PKW_FIXTURE_PROBE=exit1|signal node fixture-listener-outcome.mjs TARGET\n')
  process.exit(2)
}

/** True once the listener has written both a note and an attachment. */
async function generationFinished() {
  const spacesDir = join(target, 'spaces')
  for (const space of await readdir(spacesDir).catch(() => [])) {
    const notes = await readdir(join(spacesDir, space, 'workspace', 'notes')).catch(() => [])
    const attachments = await readdir(join(spacesDir, space, 'workspace', 'attachments')).catch(() => [])
    if (notes.length > 0 && attachments.length > 0) return true
  }
  return false
}

const { writeFile } = await import('node:fs/promises')
const deadline = Date.now() + 20000
for (;;) {
  if (await generationFinished()) break
  if (Date.now() > deadline) {
    process.stderr.write('the listener never finished generating, so it was not ended\n')
    process.exit(3)
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
}

// Arm the listener's escape hatch, which it polls for. The listener ends itself a moment later so
// the caller has finished the last call of its generation (the logout) and moved on to its stop:
// that is when the ending under test is the shutdown, rather than a request dying mid-flight.
await writeFile(join(target, 'PKW_FIXTURE_PROBE_ARMED'), `${mode}\n`, { mode: 0o600 })
await new Promise(resolvePromise => setTimeout(resolvePromise, Number(process.env.PKW_FIXTURE_PROBE_DELAY_MS ?? 200)))
process.exit(0)

/**
 * Reveal the error a gateway page route hides behind its generic 400.
 *
 * The collaboration gateway answers most failures with `400 PKW_REQUEST_FAILED` and a fixed
 * message: correct for a user, useless for a diagnosis. This loader hook rewrites that one catch
 * block — in memory only, for one process — so the same run also writes the error it is hiding to
 * `/tmp/pkw-gateway-error.json`. Nothing on disk is modified.
 *
 * Usage:
 *   node --import ./docs/delivery/probe-gateway-error.mjs <listener or probe script>
 *
 * The patch is deliberately narrow: it matches the exact `catch (error) {` that follows the header
 * write, so an unrelated catch cannot be rewritten by accident, and a file whose text does not
 * match is left exactly as it is.
 */
import { register } from 'node:module'

const OUT = '/tmp/pkw-gateway-error.json'
const MARKER = 'if (res.headersSent) {\n                res.destroy();\n                return;\n            }\n            const code = error?.code;'
const REPORT = 'try { writeFileSync(' + JSON.stringify(OUT) + ', JSON.stringify({ at: new Date().toISOString(), name: error?.constructor?.name ?? null, code: error?.code ?? null, message: error?.message ?? String(error), stack: (error?.stack ?? "").split("\\n").slice(0, 12) }, null, 2)) } catch { /* best effort */ }'
const PATCHED = 'if (res.headersSent) {\n                res.destroy();\n                return;\n            }\n            ' + REPORT + '\n            const code = error?.code;'

const loaderSource = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  'export async function load(url, context, nextLoad) {',
  '  const result = await nextLoad(url, context)',
  "  // Any copy of the gateway counts: a profile carries its own node_modules, so the file the listener actually loads is the one under the release being served.",
  "  if (!url.endsWith('dsh-pkw-web/lib/collaboration/index.js')) return result",
  "  const source = result.source ?? readFileSync(new URL(url), 'utf8')",
  "  const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8')",
  '  const marker = ' + JSON.stringify(MARKER),

  "  writeFileSync('/tmp/pkw-gateway-hook.json', JSON.stringify({ url, matched: text.includes(marker) }))",
  "  if (!text.includes(marker)) return { ...result, source: text, format: 'module' }",
  "  return { ...result, source: text.replace(marker, " + JSON.stringify(PATCHED) + "), format: 'module' }",
  '}',
].join('\n')

register(new URL(`data:text/javascript,${encodeURIComponent(loaderSource)}`), import.meta.url)

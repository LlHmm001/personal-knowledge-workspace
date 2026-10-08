/**
 * Reveal what the collaboration gateway hides behind `400 PKW_REQUEST_FAILED`.
 *
 * The gateway maps every unclassified failure to one generic 400 — right for a user, useless for a
 * diagnosis. This loader hook rewrites three narrow sites of that one module, in memory and for one
 * process only, so a run also reports on stderr:
 *
 *   PKW-LOAD <url>               the hook rewrote this module
 *   PKW-ENTERED <method> <url>   the gateway's own `handle()` ran for this request
 *   PKW-FINISH <status> <url>    that response finished
 *   PKW-JSON <status> <body>     the gateway's JSON helper answered (with the calling frame)
 *   PKW-CATCH <json>             the gateway's catch block ran, with the error it caught
 *
 * Every marker is an exact multi-line match, so an unrelated site cannot be rewritten, and a file
 * whose text does not match is returned unchanged. Nothing on disk is modified.
 *
 * Usage:
 *   node --import ./docs/delivery/probe-gateway-error.mjs <listener>
 */
import { register } from 'node:module'

const PATCH_REPORT = '/tmp/pkw-gateway-patch.json'

const ENTER = "async handle(req, res) {\n        res.setHeader('Cache-Control', 'private, no-store');"
const ENTERED = [
  'async handle(req, res) {',
  "        process.stderr.write('PKW-ENTERED ' + req.method + ' ' + req.url + '\\n');",
  "        res.on('finish', () => process.stderr.write('PKW-FINISH ' + res.statusCode + ' ' + req.url + '\\n'));",
  "        res.setHeader('Cache-Control', 'private, no-store');",
].join('\n')

const JSONFN = "const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };"
const JSONFN_PATCHED = [
  'const json = (res, status, body) => {',
  "    try { process.stderr.write('PKW-JSON ' + status + ' ' + JSON.stringify(body).slice(0, 80) + '\\n' + String(new Error('who').stack).split('\\n').slice(2, 4).join('\\n') + '\\n') } catch { /* best effort */ }",
  "    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };",
].join('\n')

const MARKER = 'if (res.headersSent) {\n                res.destroy();\n                return;\n            }\n            const code = error?.code;'
const REPORT = "process.stderr.write('PKW-CATCH ' + JSON.stringify({ name: error?.constructor?.name ?? null, status: error?.status ?? null, message: error?.message ?? String(error), stack: String(error?.stack ?? '').split('\\n').slice(0, 8) }) + '\\n')"
const PATCHED = 'if (res.headersSent) {\n                res.destroy();\n                return;\n            }\n            ' + REPORT + '\n            const code = error?.code;'

const WEBSERVER_CATCH = "const next = () => {\n\t\t\thandle(req, res).catch((err) => {"
const WEBSERVER_PATCHED = "const next = () => {\n\t\t\thandle(req, res).catch((err) => { process.stderr.write('PKW-WS-CATCH ' + req.method + ' ' + req.url + ' ' + String(err && err.stack || err) + '\\n')"

const loaderSource = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  'export async function load(url, context, nextLoad) {',
  '  const result = await nextLoad(url, context)',
  "  if (url.includes('dsh-host-webserver')) {",
  "    const ws = result.source ?? readFileSync(new URL(url), 'utf8')",
  "    const wst = typeof ws === 'string' ? ws : Buffer.from(ws).toString('utf8')",
  '    const wsMarker = ' + JSON.stringify(WEBSERVER_CATCH),
  "    const wsp = wst.includes(wsMarker) ? wst.replace(wsMarker, " + JSON.stringify(WEBSERVER_PATCHED) + ') : wst',
  "    process.stderr.write('PKW-LOAD-WEBSERVER ' + url + ' patched=' + String(wst.includes(wsMarker)) + '\\n')",
  "    return { ...result, source: wsp, format: 'module' }",
  "  }",
  "  if (!(url.includes('dsh-pkw-web') && url.endsWith('collaboration/index.js'))) return result",
  "  const source = result.source ?? readFileSync(new URL(url), 'utf8')",
  "  const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8')",
  '  const enter = ' + JSON.stringify(ENTER),
  '  const jsonfn = ' + JSON.stringify(JSONFN),
  '  const marker = ' + JSON.stringify(MARKER),
  "  const entered = text.includes(enter) ? text.replace(enter, " + JSON.stringify(ENTERED) + ') : text',
  "  const withJson = entered.includes(jsonfn) ? entered.replace(jsonfn, " + JSON.stringify(JSONFN_PATCHED) + ') : entered',
  "  const patched = withJson.includes(marker) ? withJson.replace(marker, " + JSON.stringify(PATCHED) + ') : withJson',
  "  writeFileSync(" + JSON.stringify(PATCH_REPORT) + ", JSON.stringify({ url, bytes: text.length, enterFound: text.includes(enter), jsonFound: entered.includes(jsonfn), catchFound: withJson.includes(marker) }, null, 2))",
  "  process.stderr.write('PKW-LOAD ' + url + '\\n')",
  "  return { ...result, source: patched, format: 'module' }",
  '}',
].join('\n')

register(new URL(`data:text/javascript,${encodeURIComponent(loaderSource)}`), import.meta.url)

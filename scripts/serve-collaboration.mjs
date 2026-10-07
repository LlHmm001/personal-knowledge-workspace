#!/usr/bin/env node
/** Dedicated loopback-only collaboration listener; does not expose the Harness app/RPC surface. */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { profile: { type: 'string' }, config: { type: 'string' }, port: { type: 'string', default: '3081' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('node scripts/serve-collaboration.mjs --profile /absolute/installed-profile --config /absolute/collaboration.json [--port 3081]')
  process.exit(0)
}
if (!values.profile || !values.config) throw new Error('--profile and --config are required; credentials are read only from the configured environment variable names')
const port = Number(values.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1–65535')
const require = createRequire(join(resolve(values.profile), 'package.json'))
const { CollaborationGateway } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-pkw-web/lib/collaboration/index.js')).href)
const config = JSON.parse(await readFile(resolve(values.config), 'utf8'))
const gateway = await CollaborationGateway.open(config)
let closing = false
const server = createServer((req, res) => {
  if (closing) { res.writeHead(503); res.end('shutting down'); return }
  let path
  try {
    const target = req.url ?? '/'
    if (!target.startsWith('/') || target.startsWith('//')) throw new Error('Invalid request target')
    path = new URL(target, 'http://localhost').pathname
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('invalid request target'); return
  }
  if (req.method === 'GET' && path === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ready":true}'); return }
  if (path !== '/pkw' && !path.startsWith('/pkw/')) { res.writeHead(404); res.end('not found'); return }
  void gateway.handle(req, res)
})
server.requestTimeout = 30_000
server.headersTimeout = 15_000
server.maxConnections = 100
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
} catch (error) { await gateway.close(); throw error }
console.log(JSON.stringify({ status: 'listening', bind: `127.0.0.1:${port}`, publicOrigin: config.publicOrigin, mode: 'collaboration', productionAcceptance: 'not_run' }))
async function stop() {
  if (closing) return
  closing = true
  try {
    // Node waits for in-flight responses before closing the data runtimes.
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await gateway.close()
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })

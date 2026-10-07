/**
 * One-off loopback registry used while installing a PKW release.
 *
 * It serves this release's staged tarballs and proxies everything else, so the
 * profile's existing dependency graph (including any Harness peers a site's
 * profile already declares) stays resolvable during the exact-version install.
 * It runs on an ephemeral 127.0.0.1 port, requires no credentials, and is closed
 * once the install finishes.
 *
 * This is a reviewed, generic version of a site-local script. Site-specific
 * endpoints and credentials are not baked in: pass them through the environment.
 *
 *   PKW_REGISTRY_UPLINK          upstream registry URL (default https://registry.npmjs.org)
 *   PKW_REGISTRY_SCOPED_UPLINK   preferred uplink for @deepseek-ai/* (optional; a
 *                                local Verdaccio-style mirror when a site has one)
 *   PKW_REGISTRY_TIMEOUT_MS      per-attempt timeout, first uplink (default 20000)
 *   PKW_REGISTRY_FALLBACK_TIMEOUT_MS  per-attempt timeout, remaining uplinks (default 60000)
 *   PKW_REGISTRY_TRACE           when set, record a bounded request trace
 *
 * Large optional binaries are common in DSH profiles (for example the
 * cross-platform `@openai/codex-*` builds are >100 MB each). A short timeout turns
 * those into retry loops that can stall an installation, so the default timeouts
 * here are deliberately longer than a fast metadata fetch needs.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

/**
 * Read package/package.json from a gzipped tarball without shelling out.
 * `execFileSync` would block the event loop and make concurrent metadata requests
 * from a running install time out, so the header is parsed directly.
 */
async function readManifestFromTarball(tarball) {
  const { gunzipSync } = await import('node:zlib')
  const raw = gunzipSync(await readFile(tarball))
  let offset = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0
    if (name === 'package/package.json') return JSON.parse(raw.subarray(offset + 512, offset + 512 + size).toString('utf8'))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error(`no package/package.json inside ${tarball}`)
}

export async function startLoopbackRegistry(options = {}) {
  const upstream = (options.upstream ?? process.env.PKW_REGISTRY_UPLINK ?? 'https://registry.npmjs.org').replace(/\/$/, '')
  const scopedUpstream = (options.scopedUpstream ?? process.env.PKW_REGISTRY_SCOPED_UPLINK ?? '').replace(/\/$/, '')
  const firstTimeout = Number(options.timeoutMs ?? process.env.PKW_REGISTRY_TIMEOUT_MS ?? 20_000)
  const laterTimeout = Number(options.fallbackTimeoutMs ?? process.env.PKW_REGISTRY_FALLBACK_TIMEOUT_MS ?? 60_000)
  const tarballs = new Map()
  const documents = new Map()
  const trace = []

  const server = createServer(async (request, response) => {
    const started = Date.now()
    const path = decodeURIComponent(new URL(request.url, 'http://local').pathname)
    if (process.env.PKW_REGISTRY_TRACE) trace.push(`${started % 1_000_000} ${request.method} ${path}`)
    if (tarballs.has(path)) {
      const bytes = tarballs.get(path)
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) })
      response.end(bytes)
      return
    }
    const document = documents.get(path.slice(1))
    if (document) {
      const body = Buffer.from(JSON.stringify(document))
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) })
      response.end(body)
      return
    }
    const scoped = path.startsWith('/@deepseek-ai%2f') || path.startsWith('/@deepseek-ai/')
    const uplinks = (scoped && scopedUpstream ? [scopedUpstream, upstream] : [upstream, scopedUpstream]).filter(Boolean)
    let lastError = 'no uplink configured'
    for (const [index, uplink] of uplinks.entries()) {
      try {
        const upstreamResponse = await fetch(uplink + request.url, {
          headers: { accept: request.headers.accept ?? 'application/json' },
          signal: AbortSignal.timeout(index === 0 ? firstTimeout : laterTimeout),
        })
        if (!upstreamResponse.ok && index + 1 < uplinks.length) { lastError = `${uplink} -> ${upstreamResponse.status}`; continue }
        const body = Buffer.from(await upstreamResponse.arrayBuffer())
        response.writeHead(upstreamResponse.status, { 'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json' })
        response.end(body)
        return
      } catch (error) { lastError = `${uplink} -> ${error.message}` }
    }
    response.writeHead(502, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: `uplink failed: ${lastError}` }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    dumpTrace: () => trace.slice(-40),
    /** Publish one staged tarball so pnpm can resolve this exact version. */
    async add(tarball) {
      const bytes = await readFile(tarball)
      const manifest = await readManifestFromTarball(tarball)
      const basename = manifest.name.split('/').pop()
      const path = `/${manifest.name}/-/${basename}-${manifest.version}.tgz`
      manifest.dist = {
        tarball: url + path,
        shasum: createHash('sha1').update(bytes).digest('hex'),
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
      }
      tarballs.set(path, bytes)
      documents.set(manifest.name, {
        name: manifest.name,
        'dist-tags': { latest: manifest.version },
        versions: { [manifest.version]: manifest },
        time: { [manifest.version]: new Date().toISOString() },
      })
    },
    close: () => new Promise(done => server.close(done)),
  }
}

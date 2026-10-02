import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('independent collaboration launcher review', () => {
  it('rejects malformed HTTP request targets without crashing or stranding the writer lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pkw-launcher-review-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const moduleRoot = join(root, 'node_modules/@deepseek-ai/dsh-pkw-web')
    await mkdir(join(moduleRoot, 'lib/collaboration'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(moduleRoot, 'package.json'), '{"type":"module"}')
    // Exercise the shipped CLI in a separate process. Its imported content
    // gateway is a small fixture: this regression concerns HTTP parsing before
    // gateway dispatch, not identity/password behavior covered by other tests.
    await writeFile(join(moduleRoot, 'lib/collaboration/index.js'), `
      import { open, unlink } from 'node:fs/promises';
      import { join } from 'node:path';
      export class CollaborationGateway {
        static async open(config) {
          const gateway = new this();
          gateway.path = join(config.dataPath, 'gateway.lock');
          gateway.lock = await open(gateway.path, 'wx');
          await gateway.lock.writeFile('synthetic writer lock');
          return gateway;
        }
        async handle(req, res) { res.writeHead(404); res.end('fixture'); }
        async close() { await this.lock.close(); await unlink(this.path); }
      }
    `)
    await writeFile(join(root, 'config.json'), JSON.stringify({ dataPath: root, publicOrigin: 'http://localhost' }))
    const reservation = createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../../scripts/serve-collaboration.mjs', import.meta.url)), '--profile', root, '--config', join(root, 'config.json'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = '', exited = false
    const exit = new Promise<void>(resolve => child.once('exit', () => { exited = true; resolve() }))
    cleanups.push(async () => { if (!exited) child.kill('SIGTERM'); await exit })
    child.stderr!.on('data', chunk => { errors += String(chunk) })
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('"status":"listening"')) resolve() })
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Launcher exited before listening: ' + errors)))
    })
    expect(await readFile(join(root, 'gateway.lock'), 'utf8')).toBe('synthetic writer lock')

    for (const target of ['//%', 'http://[']) {
      const response = await new Promise<{ status: number; error?: string }>(resolve => {
        const req = request({ hostname: '127.0.0.1', port, path: target, headers: { Connection: 'close' } }, res => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode! }))
        })
        req.on('error', error => resolve({ status: 0, error: error.message }))
        req.end()
      })
      expect(response, errors).toEqual({ status: 400 })
      expect(child.exitCode).toBeNull()
      const health = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ready: true })
    }
    child.kill('SIGTERM')
    await exit
    expect(child.exitCode, errors).toBe(0)
    await expect(readFile(join(root, 'gateway.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20_000)
})

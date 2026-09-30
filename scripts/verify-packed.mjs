import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { repoRoot } from './harness-config.mjs'
import { packageList, run, stagePackages } from './deployment.mjs'

const harness = resolve(process.env.DSH_HARNESS_ROOT || '/opt/deepseek-harness')
const directory = await mkdtemp(join(tmpdir(), 'pkw-packed-'))
let registry
try {
  const profile = join(directory, 'profile')
  await mkdir(profile)
  const artifacts = await stagePackages(join(directory, 'packages'), '0.1.1-pack-check', 'http://localhost:4873')
  for (const artifact of artifacts) {
    const listing = execFileSync('tar', ['-tzf', artifact.tarball], { encoding: 'utf8' })
    assert.match(listing, /package\/lib\/index.js/)
    assert.match(listing, /package\/lib\/index.d.ts/)
    assert.doesNotMatch(listing, /package\/(?:src|tests|node_modules)\/|package\/\.npmrc/)
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact.tarball, 'package/package.json'], { encoding: 'utf8' }))
    assert.ok(!JSON.stringify(manifest).includes('workspace:'))
  }
  // Exercise real registry dependency resolution, including transitive PKW
  // versions. Root-level file dependencies would not cover that boundary.
  const documents = new Map()
  const tarballs = new Map()
  registry = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://local').pathname)
    if (tarballs.has(path)) { res.end(tarballs.get(path)); return }
    const doc = documents.get(path.slice(1))
    if (!doc) { res.writeHead(404); res.end('{}'); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(doc))
  })
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve))
  const registryUrl = `http://127.0.0.1:${registry.address().port}`
  for (const artifact of artifacts) {
    const bytes = await readFile(artifact.tarball)
    const path = `/${artifact.name}/-/package.tgz`
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact.tarball, 'package/package.json'], { encoding: 'utf8' }))
    manifest.dist = { tarball: registryUrl + path, shasum: createHash('sha1').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
    documents.set(artifact.name, { name: artifact.name, 'dist-tags': { latest: artifact.version }, versions: { [artifact.version]: manifest } })
    tarballs.set(path, bytes)
  }
  await writeFile(join(profile, '.npmrc'), `@deepseek-ai:registry=${registryUrl}\n`)
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    private: true, type: 'module', packageManager: 'pnpm@11.7.0',
    dependencies: Object.fromEntries(artifacts.map(p => [p.name, p.version])),
  }, null, 2))
  await run('pnpm', ['install', '--ignore-scripts', '--config.auto-install-peers=false'], profile)
  // Model the host's existing installation, without modifying that checkout.
  // PKW itself MUST come from the tarballs above, never a source symlink.
  const peers = new Set((await packageList()).flatMap(p => Object.keys(p.manifest.peerDependencies ?? {})))
  for (const name of ['@deepseek-ai/dsh-storage', '@deepseek-ai/dsh-storage-sqlite', '@deepseek-ai/dsh-fs-local']) peers.add(name)
  const roots = [join(harness, 'vendor')]
  for (const entry of await readdir(join(harness, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(join(harness, 'packages', entry.name))
  }
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      let manifest
      try { manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) } catch { continue }
      if (!peers.has(manifest.name)) continue
      const target = join(profile, 'node_modules', manifest.name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(path, target)
      peers.delete(manifest.name)
    }
  }
  assert.deepEqual([...peers], [], 'Harness checkout is missing declared peers')
  await run(process.execPath, [join(repoRoot, 'scripts/check-runtime-imports.mjs'), '--profile', profile, '--version', '0.1.1-pack-check'], profile)
  await run(process.execPath, [join(repoRoot, 'scripts/packed-web-smoke.mjs'), '--profile', profile, '--version', '0.1.1-pack-check'], profile)
  await writeFile(join(profile, 'consumer.ts'), `import { NoteId, quadrantOf } from '@deepseek-ai/dsh-pkw-domain'\nconst id: string = NoteId('note_example')\nconst q: number = quadrantOf({ important: true, urgent: false })\n// @ts-expect-error branded id is not a number\nconst invalid: number = NoteId('note_example')\nvoid [id, q, invalid]\n`)
  await run(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'es2024', 'consumer.ts'], profile)
  console.log('PASS: all 10 tarballs installed without PKW sources; plain Node imports, Vditor renderer, artifact hashes, and consumer types verified')
} finally {
  if (registry) await new Promise(resolve => registry.close(resolve))
  await rm(directory, { recursive: true, force: true })
}

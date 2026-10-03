/** Verify installed JavaScript with plain Node, without TS/source aliases. */
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'

const { values } = parseArgs({ options: { profile: { type: 'string' }, version: { type: 'string' } } })
if (!values.profile) throw new Error('--profile is required; source imports are not a deployment check')
const require = createRequire(join(resolve(values.profile), 'package.json'))
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages/pkw')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function verifyTree(expected, installed) {
  const entries = await readdir(expected, { withFileTypes: true })
  for (const entry of entries) {
    const source = join(expected, entry.name)
    const target = join(installed, entry.name)
    if (entry.isDirectory()) await verifyTree(source, target)
    else if (hash(await readFile(source)) !== hash(await readFile(target))) throw new Error(`Installed artifact differs: ${target}`)
  }
}
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const pkg = JSON.parse(await readFile(join(root, entry.name, 'package.json'), 'utf8'))
  const modulePath = require.resolve(pkg.name)
  const packageRoot = dirname(dirname(modulePath))
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (installed.main !== 'lib/index.js' || (values.version && installed.version !== values.version)) throw new Error(`Wrong package entry/version: ${pkg.name}`)
  await verifyTree(join(root, entry.name, 'lib'), join(packageRoot, 'lib'))
  await import(pathToFileURL(modulePath).href)
  if (entry.name === 'web') {
    const { CollaborationGateway } = await import(pathToFileURL(join(packageRoot, 'lib/collaboration/index.js')).href)
    if (typeof CollaborationGateway.open !== 'function') throw new Error('Collaboration runtime entry missing')
    const { renderMarkdownToHtml } = await import(pathToFileURL(join(packageRoot, 'lib/lute.js')).href)
    if (!(await renderMarkdownToHtml('# PKW smoke')).includes('PKW smoke')) throw new Error('Vditor/Lute render failed')
  }
  console.log(`OK ${pkg.name}@${installed.version}: artifact match + Node import`)
}

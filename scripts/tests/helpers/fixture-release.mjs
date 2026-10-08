#!/usr/bin/env node
/**
 * Write a synthetic PKW release so the release mechanics can be exercised without
 * compiling the real sources.
 *
 * Compiling needs the Harness type declarations, which only exist in a private
 * checkout. Release mechanics — staging, profile assembly, resolution isolation,
 * promotion, rollback — do not: they only care about the package shape. So this fixture
 * produces that shape, and the jobs that own real declaration files run the real build.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const PACKAGES = ['attachments', 'base', 'domain', 'events', 'notes', 'tasks', 'web', 'weknora', 'weknora-sync', 'workspace']
const target = resolve(process.argv[2] ?? '.ci/packages')
const version = process.argv[3] ?? '0.0.0-fixture'

for (const name of PACKAGES) {
  const dir = join(target, name)
  await mkdir(join(dir, 'lib'), { recursive: true })
  const packageName = `@deepseek-ai/dsh-pkw-${name}`
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: packageName, version, type: 'module', main: 'lib/index.js', types: 'lib/index.d.ts', files: ['lib'],
    // The PKW packages hard-depend on their siblings and declare Harness peers, which is
    // the shape the profile builder has to resolve.
    ...(name === 'workspace' ? { dependencies: { '@deepseek-ai/dsh-pkw-domain': version } } : {}),
    peerDependencies: { '@deepseek-ai/cordis': '*', '@deepseek-ai/dsh-fs': '*', '@deepseek-ai/dsh-workspace': '*' },
  }, null, 2) + '\n')
  await writeFile(join(dir, 'lib/index.js'), `export const name = ${JSON.stringify(packageName)}\nexport const version = ${JSON.stringify(version)}\n`)
  await writeFile(join(dir, 'lib/index.d.ts'), 'export declare const name: string\nexport declare const version: string\n')
  if (name === 'web') {
    await mkdir(join(dir, 'lib/collaboration'), { recursive: true })
    await writeFile(join(dir, 'lib/collaboration/index.js'), 'export const CollaborationGateway = { open: async () => ({ close: async () => {} }) }\n')
    await writeFile(join(dir, 'lib/lute.js'), 'export const renderMarkdownToHtml = async source => String(source)\n')
  }
}
console.log(target)

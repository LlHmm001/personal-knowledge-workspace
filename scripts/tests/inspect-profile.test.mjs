import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectProfile } from '../inspect-profile.mjs'

test('target inventory exposes only versions and hashes; user files and configuration remain untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-inventory-'))
  try {
    const web = join(dir, 'node_modules/@deepseek-ai/dsh-pkw-web')
    await mkdir(join(web, 'lib'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh-pkw-web': '0.1.0' }, privateSetting: 'do-not-report-profile-config' }))
    await writeFile(join(dir, '.npmrc'), 'do-not-report-registry-credentials')
    await writeFile(join(dir, 'canonical.md'), 'do-not-report-personal-note')
    await writeFile(join(web, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '0.1.0', main: 'lib/index.js' }))
    await writeFile(join(web, 'lib/index.js'), 'export default 1')
    await writeFile(join(web, 'lib/ui.js'), 'do-not-report-ui-source')
    await writeFile(join(web, 'lib/ui.js.bak-20260825-004526'), 'old-ui')
    await writeFile(join(web, 'lib/unrelated-secret.json'), 'do-not-report-unrelated-file')
    const report = await inspectProfile(dir)
    assert.equal(report.pkw.find(p => p.name === '@deepseek-ai/dsh-pkw-web').version, '0.1.0')
    assert.equal(report.uiArtifacts.length, 2)
    assert.equal(report.uiArtifacts[0].sha256.length, 64)
    assert.ok(report.pkw.some(p => p.status === 'unresolved from profile'))
    assert.doesNotMatch(JSON.stringify(report), /do-not-report/)
    assert.equal(await readFile(join(dir, 'canonical.md'), 'utf8'), 'do-not-report-personal-note')
    assert.equal(await readFile(join(web, 'lib/ui.js'), 'utf8'), 'do-not-report-ui-source')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

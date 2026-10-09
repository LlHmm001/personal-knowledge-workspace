import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { diagnosePnpmExit, readExitTraces } from '../../deploy/diagnose-pnpm-exit.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pkw-exit-guard-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inputs = join(root, 'inputs')
  await mkdir(inputs)
  const values = { 'work-dir': join(root, 'probe'), 'scene-dir': inputs, 'old-artifact-dir': inputs, 'artifact-dir': inputs, 'pnpm-bin': process.execPath, 'old-version': '1.0.0', version: '2.0.0' }
  return { root, inputs, values }
}

test('pnpm exit diagnostic never adopts an existing scene', async t => {
  const { values } = await fixture(t)
  await mkdir(values['work-dir'])
  const precious = join(values['work-dir'], 'precious')
  await writeFile(precious, 'keep')
  await assert.rejects(diagnosePnpmExit(values), { code: 'EEXIST' })
  assert.equal(await readFile(precious, 'utf8'), 'keep')
})

test('pnpm exit diagnostic refuses aliased and overlapping inputs before creating output', async t => {
  const { root, inputs, values } = await fixture(t)
  values['work-dir'] = join(inputs, 'nested')
  await assert.rejects(diagnosePnpmExit(values), { code: 'PKW_PROBE_PATH' })
  values['work-dir'] = join(root, 'probe')
  const alias = join(root, 'alias')
  await symlink(inputs, alias)
  values['scene-dir'] = alias
  await assert.rejects(diagnosePnpmExit(values), { code: 'PKW_PROBE_PATH' })
  await assert.rejects(readFile(join(values['work-dir'], 'report.json')), { code: 'ENOENT' })
})

test('missing release receipt preserves diagnostic failure and starts no command', async t => {
  const { values } = await fixture(t)
  const report = await diagnosePnpmExit(values, { onProgress: () => {} })
  assert.equal(report.status, 'pnpm-exit-probe-stopped')
  assert.equal(report.error.phase, 'preflight')
  assert.equal(report.error.code, 'ENOENT')
  assert.deepEqual(report.commands, [])
  assert.equal(report.servicesStarted, false)
  assert.equal(report.installationSwitched, false)
  assert.equal(JSON.parse(await readFile(join(values['work-dir'], 'report.json'), 'utf8')).status, report.status)
})

test('private trace parser keeps early records beyond a log tail and rejects malformed lines separately', async t => {
  const { root } = await fixture(t), log = join(root, 'large.log')
  const record = { schema: 1, phase: 'done', pid: 42, resources: [{ type: 'Timeout', count: 1 }], unexpected: 'do not forward' }
  await writeFile(log, '[PKW_PNPM_EXIT_TRACE] ' + JSON.stringify(record) + '\n' + 'x'.repeat(80_000) + '\n[PKW_PNPM_EXIT_TRACE] {invalid\n[PKW_PNPM_EXIT_TRACE] null\n')
  const result = await readExitTraces(log)
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].phase, 'done')
  assert.equal(result.records[0].unexpected, undefined)
  assert.equal(result.malformed, 2)
})

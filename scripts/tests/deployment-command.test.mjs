import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../deployment.mjs'

test('deployment command requires normal zero exit', async () => {
  await run(process.execPath, ['-e', 'process.exit(0)'])
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)']), error => {
    assert.equal(error.code, 'PKW_COMMAND_FAILED')
    assert.equal(error.exitCode, 7)
    assert.equal(error.signal, null)
    assert.match(error.message, /exited 7/)
    return true
  })
})

test('deployment command keeps the terminating signal instead of saying exited null', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']), error => {
    assert.equal(error.code, 'PKW_COMMAND_INTERRUPTED')
    assert.equal(error.exitCode, null)
    assert.equal(error.signal, 'SIGTERM')
    assert.match(error.message, /terminated by SIGTERM/)
    assert.doesNotMatch(error.message, /exited null/)
    return true
  })
})

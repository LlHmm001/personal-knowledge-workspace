'use strict'

// Opt-in diagnostic preload for an isolated pnpm probe. Never loaded by deployment.
// Do not print arguments, environment, socket addresses, payloads, or whole handles.
const { isMainThread } = require('node:worker_threads')

if (isMainThread) {
  const { writeSync } = require('node:fs')
  const { createHook } = require('node:async_hooks')
  const { basename, isAbsolute } = require('node:path')
  const prefix = '[PKW_PNPM_EXIT_TRACE] '
  const recordByteLimit = 3500
  const started = Date.now()
  const limit = 32
  let doneSeen = false
  let stdoutTail = ''
  let diagnosticDepth = 0
  const allocationLimit = 256
  const allocationOutputLimit = 4
  const allocationTypes = new Set(['Timeout', 'TCPWRAP', 'TCPCONNECTWRAP', 'TCPSERVERWRAP', 'TLSWRAP', 'MESSAGEPORT', 'PROCESSWRAP'])
  const allocations = new Map()
  let allocationDropped = 0
  let allocationErrors = 0

  // Metadata only: retaining the resource object itself could change its lifetime.
  function onInit(id, type) {
    if (diagnosticDepth || !allocationTypes.has(type)) return
    if (allocations.size >= allocationLimit) { allocationDropped++; return }
    diagnosticDepth++
    try {
      const error = new Error()
      Error.captureStackTrace(error, onInit)
      const frames = []
      for (const line of String(error.stack).split('\n').slice(1)) {
        // Keep locations, never function names, source text, or an error message.
        const match = line.match(/(?:\(|^\s*at )((?:file:\/\/\/|\/|node:|\[eval\])[^()\r\n]*?):(\d+):(\d+)\)?$/)
        if (!match) continue
        const file = match[1].split(/[?#]/, 1)[0]
        if (file === __filename || file === 'file://' + __filename) continue
        frames.push({ file: file.slice(0, 512), line: Number(match[2]), column: Number(match[3]) })
      }
      const external = frames.filter(frame => !frame.file.startsWith('node:'))
      const useful = external.length ? external : frames
      const stack = useful.slice(0, 2)
      allocations.set(id, { id, type, stack, stackOmitted: useful.length - stack.length })
    } catch { allocationErrors++ }
    finally { diagnosticDepth-- }
  }
  const hook = createHook({ init: onInit, destroy: id => allocations.delete(id) })
  const selectedAllocations = () => {
    const rank = item => item.stack.some(frame => /pnpm|corepack/.test(frame.file)) ? 0 : item.stack.some(frame => !frame.file.startsWith('node:')) ? 1 : 2
    const seen = new Set(), selected = []
    for (const allocation of [...allocations.values()].sort((a, b) => rank(a) - rank(b))) {
      const key = JSON.stringify([allocation.type, allocation.stack])
      if (seen.has(key)) continue
      seen.add(key)
      selected.push({ ...allocation, stack: allocation.stack.slice() })
      if (selected.length === allocationOutputLimit) break
    }
    return selected
  }
  const boundedLine = record => {
    const serialize = () => {
      record.allocationOmitted = record.allocationTracked - record.allocations.length
      record.handleOmitted = (record.handleTotal ?? 0) - (record.handles?.length ?? 0)
      record.requestOmitted = (record.requestTotal ?? 0) - (record.requests?.length ?? 0)
      return '\n' + prefix + JSON.stringify(record) + '\n'
    }
    let line = serialize()
    while (Buffer.byteLength(line, 'utf8') > recordByteLimit) {
      const allocation = record.allocations.findLast(item => item.stack.length > 1)
      if (allocation) { allocation.stack.pop(); allocation.stackOmitted++ }
      else if (record.allocations.length > 2) record.allocations.pop()
      else if (record.handles?.length) record.handles.pop()
      else if (record.requests?.length) record.requests.pop()
      else if (record.allocations.length) record.allocations.pop()
      else if (record.executable.length > 128 || (record.pnpmModule?.length ?? 0) > 128) {
        record.executable = record.executable.slice(0, 128)
        if (record.pnpmModule) record.pnpmModule = record.pnpmModule.slice(0, 128)
        record.metadataTruncated = true
      } else if (record.resources?.length) {
        record.resources.pop()
        record.resourceTypesOmitted = (record.resourceTypesOmitted ?? 0) + 1
      } else break
      line = serialize()
    }
    return line
  }

  const typeName = value => {
    const name = typeof value === 'string' ? value : value?.constructor?.name
    return typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name) ? name : 'Unknown'
  }
  const pnpmModule = () => {
    const filename = process.argv[1]
    return typeof filename === 'string' && isAbsolute(filename) && /^pnpm\.(?:cjs|mjs|js)$/.test(basename(filename)) ? filename : null
  }
  const handleInfo = handle => {
    const result = { type: typeName(handle) }
    const refOwner = typeof handle?.hasRef === 'function' ? handle : handle?._handle
    if (typeof refOwner?.hasRef === 'function') result.ref = Boolean(refOwner.hasRef())
    if (Number.isInteger(handle?.fd) && handle.fd >= 0) result.fd = handle.fd
    return result
  }
  const emit = (phase, exitCode) => {
    // Diagnostics must not change the program's outcome if stderr or an inspection fails.
    diagnosticDepth++
    try {
      const record = { schema: 1, phase, elapsedMs: Date.now() - started, pid: process.pid, ppid: process.ppid, node: process.version, executable: process.execPath, pnpmModule: pnpmModule() }
      const unavailable = []
      try {
        const resources = process.getActiveResourcesInfo()
        const counts = new Map()
        for (const resource of resources) {
          const type = typeName(resource)
          if (counts.has(type) || counts.size < limit) counts.set(type, (counts.get(type) ?? 0) + 1)
        }
        record.resources = [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => a.type.localeCompare(b.type))
        record.resourceTotal = resources.length
        record.resourceTypesOmitted = new Set(resources).size - counts.size
      } catch { unavailable.push('resources') }
      try {
        const handles = process._getActiveHandles()
        record.handles = handles.slice(0, limit).map(handleInfo)
        record.handleTotal = handles.length
      } catch { unavailable.push('handles') }
      try {
        const requests = process._getActiveRequests()
        record.requests = requests.slice(0, limit).map(request => ({ type: typeName(request) }))
        record.requestTotal = requests.length
      } catch { unavailable.push('requests') }
      if (unavailable.length) record.unavailable = unavailable
      record.allocations = selectedAllocations()
      record.allocationTracked = allocations.size
      record.allocationOmitted = Math.max(0, allocations.size - allocationOutputLimit)
      record.allocationLimit = allocationLimit
      record.allocationDropped = allocationDropped
      record.allocationOverflow = allocationDropped > 0
      if (allocationErrors) record.allocationErrors = allocationErrors
      if (Number.isInteger(exitCode)) record.exitCode = exitCode
      writeSync(2, boundedLine(record))
    } catch { /* No diagnostic failure may interrupt pnpm. */ }
    finally { diagnosticDepth-- }
  }
  const observe = chunk => {
    if (doneSeen) return
    // Keep only enough previous text to recognize a Done line split across writes.
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8') : ''
    const combined = stdoutTail + text
    stdoutTail = combined.slice(-32)
    if (!/\bDone in\s+\d/.test(combined)) return
    doneSeen = true
    stdoutTail = ''
    emit('done')
    // These timers observe a process that remains alive; they never keep it alive.
    diagnosticDepth++
    try {
      setTimeout(() => emit('after-done-2s'), 2000).unref()
      setTimeout(() => emit('after-done-10s'), 10000).unref()
    } finally { diagnosticDepth-- }
  }
  const stdout = process.stdout
  const originalWrite = stdout.write
  stdout.write = function () {
    const result = Reflect.apply(originalWrite, this, arguments)
    try { observe(arguments[0]) } catch { /* Preserve write's result and callbacks. */ }
    return result
  }
  // once keeps the output bounded even if application beforeExit work repeats.
  process.once('beforeExit', code => emit('beforeExit', code))
  process.once('exit', code => {
    try { emit('exit', code) } finally { hook.disable() }
  })
  hook.enable()
  emit('startup')
}

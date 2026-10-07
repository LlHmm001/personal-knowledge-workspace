import ts from 'typescript'
import { parsedConfig, reportDiagnostics } from './harness-config.mjs'

const config = parsedConfig('tsconfig.json')
const program = ts.createProgram(config.fileNames, config.options)
if (reportDiagnostics([...config.errors, ...ts.getPreEmitDiagnostics(program)])) process.exitCode = 1

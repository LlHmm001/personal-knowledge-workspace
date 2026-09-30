import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Keep the deployment seam's default; allow an explicit checkout elsewhere. */
export function harnessConfig(filename, env = process.env) {
  const root = env.DSH_HARNESS_ROOT || '/opt/deepseek-harness'
  if (!isAbsolute(root)) throw new Error('DSH_HARNESS_ROOT must be an absolute path')
  const result = ts.readConfigFile(join(repoRoot, filename), ts.sys.readFile)
  if (result.error) throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, '\n'))
  const config = result.config
  config.compilerOptions.paths = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([name, paths]) => [name,
      paths.map(path => path.replace(/^\/opt\/deepseek-harness(?=\/)/, root)),
    ]),
  )
  return config
}

export function parsedConfig(filename) {
  return ts.parseJsonConfigFileContent(harnessConfig(filename), ts.sys, repoRoot)
}

/** vite-tsconfig-paths needs a file alongside the original (same include base). */
export function testConfigPath() {
  const path = join(repoRoot, '.pkw-tsconfig.test.json')
  const content = JSON.stringify(harnessConfig('tsconfig.base.json'), null, 2) + '\n'
  let previous
  try { previous = readFileSync(path, 'utf8') } catch { /* first run */ }
  if (content !== previous) writeFileSync(path, content)
  return path
}

export function reportDiagnostics(diagnostics) {
  if (!diagnostics.length) return false
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => repoRoot,
    getCanonicalFileName: name => name,
    getNewLine: () => '\n',
  }))
  return true
}

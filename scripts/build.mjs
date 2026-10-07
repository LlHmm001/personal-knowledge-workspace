import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { parsedConfig, repoRoot, reportDiagnostics } from './harness-config.mjs'

const packageRoot = join(repoRoot, 'packages/pkw')
const packages = (await readdir(packageRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
const requested = process.argv.slice(2)
if (requested.some(name => !packages.includes(name))) throw new Error('Unknown PKW package')
const selected = requested.length ? requested : packages
const config = parsedConfig('tsconfig.json')
// Compile all source roots together, as in typecheck, including service type
// augmentations. Harness remains external declarations; never emit its source.
const roots = config.fileNames.filter(path => path.includes(`${sep}src${sep}`))
const virtualOutput = join(repoRoot, '.pkw-build')
const program = ts.createProgram(roots, {
  ...config.options,
  noEmit: false,
  noEmitOnError: true,
  declaration: true,
  sourceMap: false,
  rewriteRelativeImportExtensions: true,
  rootDir: packageRoot,
  outDir: virtualOutput,
})
if (reportDiagnostics([...config.errors, ...ts.getPreEmitDiagnostics(program)])) process.exit(1)
const outputs = new Map()
const emitted = program.emit(undefined, (filename, content) => {
  const parts = relative(virtualOutput, filename).split(sep)
  const [name, source, ...rest] = parts
  if (!packages.includes(name) || source !== 'src' || rest.includes('..')) {
    throw new Error(`Unexpected emitted file: ${filename}`)
  }
  if (selected.includes(name)) outputs.set(join(name, ...rest), content)
}, undefined, false, {
  // TS rewrites runtime .ts specifiers, but leaves them in declarations.
  // Published packages contain only lib, so declarations must refer to .js
  // too (TypeScript resolves those specifiers to the adjacent .d.ts files).
  afterDeclarations: [context => {
    const rewrite = value => ts.isStringLiteral(value) && /^\.\.?\//.test(value.text) && value.text.endsWith('.ts')
      ? context.factory.createStringLiteral(value.text.slice(0, -3) + '.js') : value
    const visit = node => {
      if (ts.isImportDeclaration(node)) return context.factory.updateImportDeclaration(node, node.modifiers, node.importClause, rewrite(node.moduleSpecifier), node.attributes)
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) return context.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, rewrite(node.moduleSpecifier), node.attributes)
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return context.factory.updateImportTypeNode(node, context.factory.updateLiteralTypeNode(node.argument, rewrite(node.argument.literal)), node.attributes, node.qualifier, node.typeArguments, node.isTypeOf)
      return ts.visitEachChild(node, visit, context)
    }
    return node => ts.visitNode(node, visit)
  }],
})
if (emitted.emitSkipped || reportDiagnostics(emitted.diagnostics)) process.exit(1)
for (const name of selected) {
  const manifest = JSON.parse(await readFile(join(packageRoot, name, 'package.json'), 'utf8'))
  for (const entry of [manifest.main, manifest.types]) {
    if (!entry?.startsWith('lib/') || !outputs.has(join(name, entry.slice(4)))) {
      throw new Error(`${manifest.name}: missing emitted entry ${entry}`)
    }
  }
}
// Do not destroy the previous build on a compiler failure. A fresh directory
// also removes stale outputs left by renamed/deleted source modules.
for (const name of selected) {
  const target = join(packageRoot, name, 'lib')
  const staging = join(packageRoot, name, `.pkw-lib-${process.pid}`)
  try {
    await mkdir(staging)
    for (const [filename, content] of outputs) {
      if (!filename.startsWith(name + sep)) continue
      const out = resolve(staging, filename.slice(name.length + 1))
      await mkdir(join(out, '..'), { recursive: true })
      await writeFile(out, content)
    }
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    console.log(`Built ${name}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

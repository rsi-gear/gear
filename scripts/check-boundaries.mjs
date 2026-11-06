import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const failures = []
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [])
const graph = new Map()
for (const layer of ['domain', 'ports', 'runtime', 'application', 'adapters', 'cli']) {
  for (const path of files(join(root, 'src', layer))) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const imports = source.statements.filter(ts.isImportDeclaration)
    graph.set(path, [])
    for (const declaration of imports) {
      const name = declaration.moduleSpecifier.text
      if (!name.startsWith('.')) continue
      const target = resolve(dirname(path), name.replace(/\.js$/u, '.ts'))
      const destination = relative(join(root, 'src'), target).split('/')[0]
      if (['domain', 'ports'].includes(layer) && !['domain', 'ports'].includes(destination)) failures.push(`${relative(root, path)} depends on ${name}`)
      if (layer === 'runtime' && !['domain', 'ports', 'runtime'].includes(destination)) failures.push(`${relative(root, path)} imports a concrete implementation: ${name}`)
      const typeOnly = declaration.importClause?.isTypeOnly || declaration.importClause?.namedBindings && ts.isNamedImports(declaration.importClause.namedBindings) && declaration.importClause.namedBindings.elements.every(element => element.isTypeOnly)
      if (!typeOnly) graph.get(path).push(target)
    }
  }
}
const visited = new Set(), pending = new Set()
function visit(path, trail) {
  if (pending.has(path)) { failures.push('Runtime import cycle: ' + [...trail, path].map(value => relative(root, value)).join(' -> ')); return }
  if (visited.has(path) || !graph.has(path)) return
  pending.add(path)
  for (const target of graph.get(path)) visit(target, [...trail, path])
  pending.delete(path); visited.add(path)
}
for (const path of graph.keys()) visit(path, [])

// Public entrypoints must not load the retired search/service assembly, including
// through CLI dynamic imports such as resource maintenance or training.
const runtimeGraph = new Map()
for (const path of files(join(root, 'src'))) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = []
  const record = name => {
    if (!name.startsWith('.')) return
    const target = resolve(dirname(path), name.replace(/\.js$/u, '.ts'))
    if (existsSync(target)) imports.push(target)
  }
  const scan = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')) {
        const target = resolve(dirname(path), node.moduleSpecifier.text)
        if (target.startsWith(join(root, 'tests') + '/')) failures.push('Production module imports a test fixture: ' + relative(root, path))
      }
      const clause = node.importClause
      const bindings = clause?.namedBindings ?? node.exportClause
      const typeOnly = node.isTypeOnly || clause?.isTypeOnly ||
        !clause?.name && bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
        bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
      if (!typeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) record(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0])) record(node.arguments[0].text)
    ts.forEachChild(node, scan)
  }
  scan(source); runtimeGraph.set(path, imports)
}
const reachable = new Set()
const retired = /^(?:(?:search|refine|evaluator|meta|notebook|worker)\/|skill\/control-plane\.ts$|state\/store\.ts$)/u
const follow = (path, trail = []) => {
  if (reachable.has(path) || !runtimeGraph.has(path)) return
  reachable.add(path)
  if (retired.test(relative(join(root, 'src'), path))) failures.push('Public entrypoint loads retired assembly: ' + [...trail, path].map(value => relative(root, value)).join(' -> '))
  for (const next of runtimeGraph.get(path)) follow(next, [...trail, path])
}
for (const entry of ['index.ts', 'cli.ts', 'skill/index.ts', 'training/index.ts', 'adapters/codex/runner.ts']) follow(join(root, 'src', entry))
if (failures.length) throw new Error(failures.join('\n'))
console.log(`Dependency boundaries passed for ${graph.size} TypeScript modules`)
console.log(`Public entrypoints reach ${reachable.size} runtime modules without retired execution assemblies`)

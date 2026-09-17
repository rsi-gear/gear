import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { ComponentKind, ComponentRef } from '../types.js'

type ComponentImplementation = ComponentRef<unknown>['implementation']
type Artifact = {
  logicalName: string
  path: string
  format: 'module' | 'hitch-rollout-module' | 'declarations' | 'bytes'
  declarations?: readonly string[]
  omitDeclarations?: readonly string[]
  omitModuleSpecifiers?: readonly string[]
}

const COMPONENT_PACKAGE = 'dsh-plugin-refine/components'
const COMPONENT_VERSION = '2.0.0'
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
const SHA256 = /^sha256:[0-9a-f]{64}$/u

const BUILTIN_DECLARATIONS: Record<string, readonly string[]> = {
  'candidate-generator:dsh-meta-forked-proposals': ['ForkedProposalCandidateGenerator'],
  'candidate-generator:meta-forked-proposals': ['ForkedProposalCandidateGenerator'],
  'task-sampler:dataset': ['condition', 'DatasetTaskSampler'],
  'candidate-assessor:evaluation-metrics': ['EvaluationMetricsCandidateAssessor'],
  'candidate-selector:highest-quality': ['HighestQualityCandidateSelector'],
  'judge:task-reward': ['TaskRewardJudge'],
  'promotion-policy:paired-gate': ['pairedRewards', 'PairedGatePromotionPolicy'],
}

const ALL_BUILTIN_DECLARATIONS = new Set(Object.values(BUILTIN_DECLARATIONS).flat())
const LEGACY_COMPONENT_DECLARATIONS = new Set([
  'builtinImplementation', 'componentRef', 'builtinComponentRef', 'rolloutProviderSemanticDigest',
  'assertComponentRef', ...ALL_BUILTIN_DECLARATIONS, 'ComponentRegistry',
])

function readArtifact(path: string): Buffer {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`component artifact must be a regular file: ${path}`)
  if (info.size > MAX_ARTIFACT_BYTES) throw new Error(`component artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${path}`)
  return readFileSync(path)
}

function sha256(parts: Array<string | Uint8Array>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part
    hash.update(String(bytes.byteLength)).update('\0').update(bytes).update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function currentFile(relativeJsPath: string): string {
  const source = fileURLToPath(import.meta.url).endsWith('.ts')
  return fileURLToPath(new URL(source ? relativeJsPath.replace(/\.js$/u, '.ts') : relativeJsPath, import.meta.url))
}

function javascript(bytes: Uint8Array, label: string): string {
  return ts.transpileModule(Buffer.from(bytes).toString('utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2024,
      verbatimModuleSyntax: true,
    },
    fileName: label,
  }).outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '')
}

function sourceFile(bytes: Uint8Array, label: string): ts.SourceFile {
  return ts.createSourceFile(label, javascript(bytes, label), ts.ScriptTarget.ES2024, true, ts.ScriptKind.JS)
}

function declarationMap(source: ts.SourceFile): Map<string, ts.Node> {
  const declarations = new Map<string, ts.Node>()
  for (const statement of source.statements) {
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name !== undefined) {
      declarations.set(statement.name.text, statement)
    }
  }
  return declarations
}

function canonicalDeclarations(bytes: Uint8Array, names: readonly string[], label: string): string {
  const source = sourceFile(bytes, label)
  const declarations = declarationMap(source)
  return names.map(name => {
    const declaration = declarations.get(name)
    if (declaration === undefined) throw new Error(`${label} has unsupported component layout: missing ${name}`)
    return declaration.getText(source)
  }).join('\n')
}

function importShape(statement: ts.ImportDeclaration, source: ts.SourceFile): string {
  const moduleName = statement.moduleSpecifier.getText(source)
  const clause = statement.importClause
  const names = clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
    ? clause.namedBindings.elements.map(element => element.getText(source)).sort().join(',')
    : clause?.name?.getText(source) ?? ''
  return `${moduleName}:${names}`
}

function assertModuleLayout(
  bytes: Uint8Array,
  label: string,
  expectedImports: readonly string[],
  expectedDeclarations: ReadonlySet<string>,
  expectedVariables: ReadonlySet<string> = new Set(),
): void {
  const source = sourceFile(bytes, label)
  const imports: string[] = []
  const declarations = new Set<string>()
  const variables = new Set<string>()
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) { imports.push(importShape(statement, source)); continue }
    if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) && statement.name !== undefined) {
      declarations.add(statement.name.text); continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) variables.add(declaration.name.getText(source))
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) continue
    throw new Error(`${label} has unsupported executable top-level statement: ${ts.SyntaxKind[statement.kind]}`)
  }
  const same = (left: readonly string[], right: readonly string[]): boolean => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  if (!same(imports, expectedImports)
    || !same([...declarations], [...expectedDeclarations])
    || !same([...variables], [...expectedVariables])) {
    throw new Error(`${label} has unsupported component module layout`)
  }
}

function importsOf(bytes: Uint8Array, label: string): string[] {
  const source = sourceFile(bytes, label)
  return source.statements.filter(ts.isImportDeclaration).map(statement => importShape(statement, source)).sort()
}

function nodeEngine(root: string): string {
  const manifestPath = join(root, 'package.json')
  const value = JSON.parse(readArtifact(manifestPath).toString('utf8')) as { engines?: { node?: unknown } }
  if (typeof value.engines?.node !== 'string' || value.engines.node.length === 0) {
    throw new Error(`component package has no Node runtime contract: ${manifestPath}`)
  }
  return value.engines.node
}

function currentRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url))
}

function builtinAlgorithmArtifact(kind: ComponentKind, id: string): string {
  const names = BUILTIN_DECLARATIONS[`${kind}:${id}`]
  if (names === undefined) throw new Error(`unknown built-in ${kind} component: ${id}`)
  const algorithmPath = currentFile('./builtin-algorithms.js')
  const algorithmBytes = readArtifact(algorithmPath)
  assertModuleLayout(
    algorithmBytes,
    algorithmPath,
    ["'../state/digest.js':digestJson", "'./component-ref.js':assertComponentRef"],
    ALL_BUILTIN_DECLARATIONS,
  )
  const refPath = currentFile('./component-ref.js')
  const digestPath = currentFile('../state/digest.js')
  const refBytes = readArtifact(refPath)
  const digestBytes = readArtifact(digestPath)
  assertModuleLayout(refBytes, refPath, ["'../state/digest.js':digestJson"], new Set(['componentRef', 'assertComponentRef']))
  assertModuleLayout(digestBytes, digestPath, ["'node:crypto':createHash"], new Set(['stableJson', 'digestJson']))
  return sha256([
    canonicalDeclarations(algorithmBytes, names, algorithmPath),
    canonicalDeclarations(refBytes, ['assertComponentRef'], refPath),
    canonicalDeclarations(digestBytes, ['stableJson', 'digestJson'], digestPath),
  ])
}

function implementation(kind: ComponentKind, id: string, revision: string, artifactsDigest: string): ComponentImplementation {
  return {
    package: COMPONENT_PACKAGE,
    version: COMPONENT_VERSION,
    integrity: sha256([JSON.stringify({ identitySchema: 2, kind, id, apiVersion: 1, revision, node: nodeEngine(currentRoot()) }), artifactsDigest]),
  }
}

export function builtinImplementation(kind: ComponentKind, id: string): ComponentImplementation {
  if (kind === 'rollout-provider' && id === 'hitch-cli') return hitchCliImplementation()
  return implementation(kind, id, '1', builtinAlgorithmArtifact(kind, id))
}

function canonicalModule(
  bytes: Uint8Array,
  label: string,
  omitDeclarations: readonly string[] = [],
  omitModuleSpecifiers: readonly string[] = [],
): string {
  const source = sourceFile(bytes, label)
  const omitted = new Set(omitDeclarations)
  const omittedModules = new Set(omitModuleSpecifiers)
  return source.statements
    .filter(statement => !((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement))
      && statement.name !== undefined && omitted.has(statement.name.text)))
    .filter(statement => !((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
      && omittedModules.has(statement.moduleSpecifier.text)))
    .map(statement => statement.getText(source))
    .join('\n')
}

function canonicalHitchRolloutModule(bytes: Uint8Array, label: string): string {
  const source = sourceFile(bytes, label)
  const evaluator = source.statements.filter((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === 'HitchCliEvaluator')
  if (evaluator.length !== 1) throw new Error(`${label} has unsupported Hitch evaluator layout`)
  // Bounded verifier reads cannot affect rollout submission or execution. Omit
  // exactly this ordinary instance method while keeping every other member in
  // the rollout implementation identity.
  const diagnostic = evaluator[0]!.members.filter(member => ts.isMethodDeclaration(member)
    && ts.isIdentifier(member.name) && member.name.text === 'inspectVerifierDiagnosticPage'
    && !member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
    && !(ts.canHaveDecorators(member) && (ts.getDecorators(member)?.length ?? 0) > 0))
  if (diagnostic.length > 1) throw new Error(`${label} has duplicate verifier diagnostic page methods`)
  return source.statements.map(statement => {
    if (statement !== evaluator[0] || diagnostic.length === 0) return statement.getText(source)
    const text = statement.getText(source)
    const start = diagnostic[0]!.getFullStart() - statement.getStart(source)
    const end = diagnostic[0]!.end - statement.getStart(source)
    return `${text.slice(0, start)}${text.slice(end)}`
  }).join('\n')
}

function artifactClosureDigest(artifacts: readonly Artifact[]): string {
  return sha256(artifacts.flatMap(artifact => {
    const bytes = readArtifact(artifact.path)
    const content = artifact.format === 'module'
      ? canonicalModule(bytes, artifact.path, artifact.omitDeclarations, artifact.omitModuleSpecifiers)
      : artifact.format === 'hitch-rollout-module'
        ? canonicalHitchRolloutModule(bytes, artifact.path)
        : artifact.format === 'declarations'
          ? canonicalDeclarations(bytes, artifact.declarations ?? [], artifact.path)
          : bytes
    return [artifact.logicalName, content]
  }))
}

function currentArtifacts(kind: 'hitch-cli' | 'llm-verifier'): Artifact[] {
  if (kind === 'hitch-cli') return [
    { logicalName: 'evaluator/hitch-cli', path: currentFile('../evaluator/hitch-cli.js'), format: 'hitch-rollout-module' },
    { logicalName: 'evaluator/cleanup', path: currentFile('../evaluator/cleanup.js'), format: 'module' },
    { logicalName: 'state/digest', path: currentFile('../state/digest.js'), format: 'module' },
    { logicalName: 'state/dataset', path: currentFile('../state/dataset.js'), format: 'module' },
    { logicalName: 'types-runtime', path: currentFile('../types.js'), format: 'module' },
    { logicalName: 'hitch-codex-wrapper', path: currentFile('../../assets/hitch-codex-wrapper.mjs'), format: 'bytes' },
    { logicalName: 'hitch-codex-credential-helper', path: currentFile('../../assets/hitch-codex-credential-helper.mjs'), format: 'bytes' },
  ]
  return [
    {
      logicalName: 'selection/llm-verifier',
      path: currentFile('../selection/llm-verifier.js'),
      format: 'module',
      omitDeclarations: ['llmVerifierImplementation'],
      omitModuleSpecifiers: ['../evolution/component-identity.js'],
    },
    { logicalName: 'state/digest', path: currentFile('../state/digest.js'), format: 'module' },
    {
      logicalName: 'evolution/component-ref', path: currentFile('./component-ref.js'),
      format: 'declarations', declarations: ['assertComponentRef'],
    },
    { logicalName: 'llm-verifier-bridge', path: currentFile('../../assets/llm-verifier-bridge.py'), format: 'bytes' },
  ]
}

export function hitchCliImplementation(): ComponentImplementation {
  return implementation('rollout-provider', 'hitch-cli', '1', artifactClosureDigest(currentArtifacts('hitch-cli')))
}

export function stableLlmVerifierImplementation(): ComponentImplementation {
  return implementation('candidate-assessor', 'llm-verifier', '1', artifactClosureDigest(currentArtifacts('llm-verifier')))
}

function legacyBuiltinIdentity(root: string, kind: ComponentKind, id: string): ComponentImplementation {
  const modulePath = join(root, 'lib/evolution/components.js')
  const moduleBytes = readArtifact(modulePath)
  assertModuleLayout(
    moduleBytes,
    modulePath,
    ["'../state/digest.js':digestJson", "'node:crypto':createHash", "'node:fs':readFileSync", "'node:url':fileURLToPath"],
    LEGACY_COMPONENT_DECLARATIONS,
    new Set(['PACKAGE_NAME', 'PACKAGE_MANIFEST_BYTES', 'PACKAGE_VERSION']),
  )
  assertLegacyPackageInitializers(moduleBytes, modulePath)
  assertLegacyClassSafety(moduleBytes, modulePath)
  const manifestBytes = readArtifact(join(root, 'package.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { name?: unknown; version?: unknown }
  if (manifest.name !== 'dsh-plugin-refine' || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`legacy component root has unsupported package identity: ${root}`)
  }
  return {
    package: manifest.name,
    version: manifest.version,
    integrity: `sha256:${createHash('sha256')
      .update(moduleBytes).update('\0').update(manifestBytes).update('\0')
      .update(JSON.stringify({ package: manifest.name, version: manifest.version, kind, id, apiVersion: 1 }))
      .digest('hex')}`,
  }
}

function legacyLlmVerifierIdentity(root: string): ComponentImplementation {
  const moduleBytes = readArtifact(join(root, 'lib/selection/llm-verifier.js'))
  const bridgeBytes = readArtifact(join(root, 'assets/llm-verifier-bridge.py'))
  const manifestBytes = readArtifact(join(root, 'package.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { name?: unknown; version?: unknown }
  if (manifest.name !== 'dsh-plugin-refine' || typeof manifest.version !== 'string') throw new Error('unsupported legacy verifier package')
  return {
    package: manifest.name,
    version: manifest.version,
    integrity: `sha256:${createHash('sha256').update(moduleBytes).update('\0').update(bridgeBytes).update('\0').update(manifestBytes).digest('hex')}`,
  }
}

function exactImplementation(left: ComponentImplementation, right: ComponentImplementation): boolean {
  const expectedKeys = JSON.stringify(['integrity', 'package', 'version'])
  return JSON.stringify(Object.keys(left).sort()) === expectedKeys
    && JSON.stringify(Object.keys(right).sort()) === expectedKeys
    && left.package === right.package && left.version === right.version && left.integrity === right.integrity
}

function moduleBody(bytes: Uint8Array, label: string, omitDeclarations: readonly string[] = []): string {
  const source = sourceFile(bytes, label)
  const omitted = new Set(omitDeclarations)
  return source.statements
    .filter(statement => !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
    .filter(statement => !((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement))
      && statement.name !== undefined && omitted.has(statement.name.text)))
    .map(statement => statement.getText(source))
    .join('\n')
}

function assertLegacyClassSafety(bytes: Uint8Array, label: string): void {
  const source = sourceFile(bytes, label)
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue
    for (const member of statement.members) {
      if (ts.isClassStaticBlockDeclaration(member)
        || (ts.canHaveModifiers(member)
          && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword))
        || (member.name !== undefined && ts.isComputedPropertyName(member.name))) {
        throw new Error(`${label} has unsupported legacy class initialization`)
      }
    }
  }
}

function assertLegacyPackageInitializers(bytes: Uint8Array, label: string): void {
  const source = sourceFile(bytes, label)
  const expected: Record<string, string> = {
    PACKAGE_NAME: "'dsh-plugin-refine'",
    PACKAGE_MANIFEST_BYTES: "readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)))",
    PACKAGE_VERSION: "JSON.parse(PACKAGE_MANIFEST_BYTES.toString('utf8')).version",
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(source)
      if (name in expected && declaration.initializer?.getText(source) !== expected[name]) {
        throw new Error(`${label} has unsupported legacy ${name} initializer`)
      }
    }
  }
}

function llmVerifierClosureMatches(root: string): boolean {
  // The legacy verifier imports assertComponentRef from the monolithic
  // components module, so that module must satisfy the complete supported V1
  // layout even though its raw bytes were not part of the verifier digest.
  legacyBuiltinIdentity(root, 'candidate-assessor', 'evaluation-metrics')
  const legacyModule = join(root, 'lib/selection/llm-verifier.js')
  const currentModule = currentFile('../selection/llm-verifier.js')
  const legacyBytes = readArtifact(legacyModule)
  const currentBytes = readArtifact(currentModule)
  const expectedLegacyImports = [
    "'../evolution/components.js':assertComponentRef", "'../state/digest.js':digestJson",
    "'node:child_process':spawn", "'node:crypto':createHash", "'node:fs':readFileSync",
    "'node:path':dirname,isAbsolute", "'node:url':fileURLToPath",
  ].sort()
  const expectedCurrentImports = [
    "'../evolution/component-ref.js':assertComponentRef", "'../state/digest.js':digestJson",
    "'node:child_process':spawn", "'node:path':dirname,isAbsolute", "'node:url':fileURLToPath",
  ].sort()
  if (JSON.stringify(importsOf(legacyBytes, legacyModule)) !== JSON.stringify(expectedLegacyImports)
    || JSON.stringify(importsOf(currentBytes, currentModule)) !== JSON.stringify(expectedCurrentImports)) return false
  if (moduleBody(legacyBytes, legacyModule, ['llmVerifierImplementation'])
    !== moduleBody(currentBytes, currentModule)) return false
  const legacyDigest = join(root, 'lib/state/digest.js')
  const currentDigest = currentFile('../state/digest.js')
  const legacyComponents = join(root, 'lib/evolution/components.js')
  const currentRef = currentFile('./component-ref.js')
  const legacyDigestBytes = readArtifact(legacyDigest)
  const currentDigestBytes = readArtifact(currentDigest)
  assertModuleLayout(legacyDigestBytes, legacyDigest, ["'node:crypto':createHash"], new Set(['stableJson', 'digestJson']))
  assertModuleLayout(currentDigestBytes, currentDigest, ["'node:crypto':createHash"], new Set(['stableJson', 'digestJson']))
  if (canonicalDeclarations(legacyDigestBytes, ['stableJson', 'digestJson'], legacyDigest)
      !== canonicalDeclarations(currentDigestBytes, ['stableJson', 'digestJson'], currentDigest)
    || canonicalDeclarations(readArtifact(legacyComponents), ['assertComponentRef'], legacyComponents)
      !== canonicalDeclarations(readArtifact(currentRef), ['assertComponentRef'], currentRef)) return false
  return readArtifact(join(root, 'assets/llm-verifier-bridge.py')).equals(
    readArtifact(currentFile('../../assets/llm-verifier-bridge.py')),
  )
}

function legacyArtifacts(root: string, kind: 'hitch-cli' | 'llm-verifier'): Artifact[] {
  return currentArtifacts(kind).map(artifact => ({
    ...artifact,
    path: join(root, artifact.logicalName === 'types-runtime' ? 'lib/types.js'
      : artifact.logicalName === 'hitch-codex-wrapper' ? 'assets/hitch-codex-wrapper.mjs'
      : artifact.logicalName === 'hitch-codex-credential-helper' ? 'assets/hitch-codex-credential-helper.mjs'
      : artifact.logicalName === 'llm-verifier-bridge' ? 'assets/llm-verifier-bridge.py'
      : `lib/${artifact.logicalName}.js`),
  }))
}

export class LegacyComponentVerifier {
  readonly roots: string[]

  constructor(roots: readonly string[] = []) {
    if (roots.some(root => !isAbsolute(root))) throw new TypeError('legacy component roots must be absolute paths')
    this.roots = [...new Set(roots)]
  }

  accepts(ref: ComponentRef<unknown>, expected: ComponentImplementation, kind: ComponentKind, id: string): boolean {
    if (!SHA256.test(ref.implementation.integrity)) return false
    const names = BUILTIN_DECLARATIONS[`${kind}:${id}`]
    const current = names === undefined
      ? kind === 'rollout-provider' && id === 'hitch-cli' ? hitchCliImplementation()
        : kind === 'candidate-assessor' && id === 'llm-verifier' ? stableLlmVerifierImplementation()
          : undefined
      : builtinImplementation(kind, id)
    if (current === undefined || !exactImplementation(current, expected)) return false
    for (const root of this.roots) {
      try {
        const legacy = id === 'llm-verifier' ? legacyLlmVerifierIdentity(root) : legacyBuiltinIdentity(root, kind, id)
        if (!exactImplementation(legacy, ref.implementation) || nodeEngine(root) !== nodeEngine(currentRoot())) continue
        if (names !== undefined) {
          const legacyPath = join(root, 'lib/evolution/components.js')
          const currentPath = currentFile('./builtin-algorithms.js')
          if (canonicalDeclarations(readArtifact(legacyPath), names, legacyPath)
            !== canonicalDeclarations(readArtifact(currentPath), names, currentPath)) continue
          const legacyDigest = join(root, 'lib/state/digest.js')
          const currentDigest = currentFile('../state/digest.js')
          const legacyDigestBytes = readArtifact(legacyDigest)
          const currentDigestBytes = readArtifact(currentDigest)
          assertModuleLayout(legacyDigestBytes, legacyDigest, ["'node:crypto':createHash"], new Set(['stableJson', 'digestJson']))
          assertModuleLayout(currentDigestBytes, currentDigest, ["'node:crypto':createHash"], new Set(['stableJson', 'digestJson']))
          if (canonicalDeclarations(readArtifact(legacyDigest), ['stableJson', 'digestJson'], legacyDigest)
            !== canonicalDeclarations(readArtifact(currentDigest), ['stableJson', 'digestJson'], currentDigest)) continue
          const currentRef = currentFile('./component-ref.js')
          if (canonicalDeclarations(readArtifact(legacyPath), ['assertComponentRef'], legacyPath)
            !== canonicalDeclarations(readArtifact(currentRef), ['assertComponentRef'], currentRef)) continue
        } else if (id === 'llm-verifier') {
          if (!llmVerifierClosureMatches(root)) continue
        } else {
          const artifactKind = id === 'hitch-cli' || id === 'llm-verifier' ? id : undefined
          if (artifactKind === undefined
            || artifactClosureDigest(legacyArtifacts(root, artifactKind))
              !== artifactClosureDigest(currentArtifacts(artifactKind))) continue
        }
        return true
      } catch { continue }
    }
    return false
  }
}

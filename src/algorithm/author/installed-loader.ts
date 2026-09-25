import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { jsonDigest } from '../schema.js';
import { authorSourceCheckerDigest, authorSourceClosureDigest, readBoundedFile, sealedTreeDigest } from './identity.js';
import { checkAuthorModuleSource } from './source-check.js';
import { AUTHOR_WIRE_VERSION_V2 } from './index.js';

const SDK_BARE = 'rsi-gear/algorithm/author';
const require = createRequire(import.meta.url);
function compilerIdentity(): string {
  const packageRoot = dirname(require.resolve('typescript/package.json'));
  return jsonDigest({ entry: authorSourceCheckerDigest(), package: sealedTreeDigest(packageRoot) });
}
const SHA512 = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function within(root: string, candidate: string): boolean {
  const tail = relative(root, candidate);
  return tail !== '..' && !tail.startsWith('../') && !isAbsolute(tail);
}
function readJson(path: string): Record<string, unknown> {
  const bytes = readBoundedFile(path, 4 * 1024 * 1024);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid JSON object: ${path}`);
  return parsed as Record<string, unknown>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid installed package metadata');
  return value as Record<string, unknown>;
}
function exactFileDependency(root: string, dependency: string): string {
  if (!dependency.startsWith('file:')) throw new Error('Author SDK dependency is not a local tarball');
  const value = dependency.slice(5);
  const path = dependency.startsWith('file://') ? fileURLToPath(dependency)
    : resolve(root, value);
  if (!path.endsWith('.tgz')) throw new Error('Author SDK file dependency must be a tarball');
  return realpathSync(path);
}
function verifySdkRuntimeGraph(packageRoot: string, entry: string): void {
  const seen = new Set<string>();
  const scan = (filePath: string): void => {
    const actual = realpathSync(filePath);
    if (!within(packageRoot, actual)) throw new Error('Installed SDK runtime import escapes package closure');
    if (seen.has(actual)) return;
    seen.add(actual);
    if (seen.size > 4096) throw new Error('Installed SDK runtime graph exceeds file limit');
    const extension = extname(actual);
    if (extension === '.json') return;
    if (!['.js', '.mjs', '.cjs'].includes(extension)) throw new Error('Unsupported installed SDK runtime import');
    const source = readBoundedFile(actual, 4 * 1024 * 1024).toString('utf8');
    const file = ts.createSourceFile(actual, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    const follow = (specifier: string): void => {
      if (specifier.startsWith('node:')) return;
      if (!specifier.startsWith('.')) throw new Error(`Installed author SDK runtime dependency is not closed: ${specifier}`);
      scan(resolve(dirname(actual), specifier));
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) follow(node.moduleSpecifier.text);
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        follow(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        throw new Error('Installed author SDK runtime dynamic import is unsupported');
      ts.forEachChild(node, visit);
    };
    visit(file);
  };
  scan(entry);
}
function installedPackage(root: string): { sdkEntry: string; sdkPackageRoot: string; packageDigest: string; tarballDigest: string; lockDigest: string } {
  const projectPackage = readJson(join(root, 'package.json'));
  const projectLock = readJson(join(root, 'package-lock.json'));
  if (projectPackage.type !== 'module') throw new Error('Installed author project must declare type:module');
  const dependency = record(projectPackage.dependencies)['rsi-gear'];
  const lockPackages = record(projectLock.packages);
  const lockRoot = record(lockPackages['']);
  const lockEntry = record(lockPackages['node_modules/rsi-gear']);
  if (record(lockRoot.dependencies)['rsi-gear'] !== dependency || typeof lockEntry.resolved !== 'string')
    throw new Error('Author SDK dependency and lockfile drift');
  const integrity = lockEntry.integrity;
  if (typeof integrity !== 'string' || !SHA512.test(integrity))
    throw new Error('Author SDK lockfile requires sha512 integrity');
  let tarballDigest: string;
  if (typeof dependency === 'string' && dependency.startsWith('file:')) {
    const tarball = exactFileDependency(root, dependency);
    if (exactFileDependency(root, lockEntry.resolved) !== tarball)
      throw new Error('Author SDK lockfile resolves a different tarball');
    const tarballBytes = readBoundedFile(tarball, 128 * 1024 * 1024);
    if (`sha512-${createHash('sha512').update(tarballBytes).digest('base64')}` !== integrity)
      throw new Error('Author SDK tarball integrity drift');
    tarballDigest = jsonDigest({ path: tarball, bytes: createHash('sha256').update(tarballBytes).digest('hex') });
  } else {
    if (typeof dependency !== 'string' || !EXACT_VERSION.test(dependency)
      || lockEntry.version !== dependency || !lockEntry.resolved.startsWith('https://'))
      throw new Error('Author SDK registry dependency requires exact version and integrity lock');
    tarballDigest = jsonDigest({ registryVersion: dependency, resolved: lockEntry.resolved, integrity });
  }
  const installPath = join(root, 'node_modules', 'rsi-gear');
  if (lstatSync(installPath).isSymbolicLink()) throw new Error('Symlinked author SDK installation is unsupported');
  const installedRoot = realpathSync(installPath);
  if (!within(root, installedRoot)) throw new Error('Installed SDK escapes trusted project root');
  const installed = readJson(join(installedRoot, 'package.json'));
  if (installed.name !== 'rsi-gear' || installed.version !== lockEntry.version)
    throw new Error('Installed author SDK package metadata drift');
  const exportRecord = record(record(installed.exports)['./algorithm/author']);
  const exportPath = exportRecord.default;
  if (typeof exportPath !== 'string' || !exportPath.startsWith('./') || !exportPath.endsWith('.js'))
    throw new Error('Installed author SDK export is unsupported');
  const sdkEntry = realpathSync(resolve(installedRoot, exportPath));
  if (!within(installedRoot, sdkEntry)) throw new Error('Installed author SDK export escapes package');
  verifySdkRuntimeGraph(installedRoot, sdkEntry);
  return { sdkEntry, sdkPackageRoot: installedRoot, packageDigest: sealedTreeDigest(installedRoot),
    tarballDigest, lockDigest: createHash('sha256').update(readBoundedFile(join(root, 'package-lock.json'), 4 * 1024 * 1024)).digest('hex') };
}
function emitPath(source: string, root: string): string {
  const tail = relative(root, source);
  const extension = extname(tail);
  if (extension === '.ts') return tail.slice(0, -3) + '.js';
  if (extension === '.mts') return tail.slice(0, -4) + '.mjs';
  if (extension === '.js' || extension === '.mjs') return tail;
  throw new Error(`Unsupported author entry extension ${source}`);
}
function pinSdkImports(path: string, sdkUrl: string): void {
  const source = readBoundedFile(path, 4 * 1024 * 1024).toString('utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const patches: Array<{ start: number; end: number }> = [];
  for (const statement of parsed.statements) {
    const spec = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined;
    if (spec && ts.isStringLiteral(spec) && spec.text === SDK_BARE)
      patches.push({ start: spec.getStart(parsed), end: spec.getEnd() });
  }
  let pinned = source;
  for (const patch of patches.reverse()) pinned = pinned.slice(0, patch.start) + JSON.stringify(sdkUrl) + pinned.slice(patch.end);
  if (pinned.includes(`from '${SDK_BARE}'`) || pinned.includes(`from "${SDK_BARE}"`))
    throw new Error('Unpinned SDK import in emitted author module');
  writeFileSync(path, pinned);
}
function compileAuthor(root: string, modulePath: string, sources: string[], sdkEntry: string,
  emitRoot: string): string {
  const outputParent = dirname(emitRoot);
  const inspectDirectory = (directory: string): void => {
    try {
      const info = lstatSync(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || !within(root, realpathSync(directory)))
        throw new Error('Author emit directory escapes trusted project root');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  // No mkdir is allowed until every existing parent and target has passed the path check.
  inspectDirectory(join(root, '.gear'));
  inspectDirectory(outputParent);
  inspectDirectory(emitRoot);
  mkdirSync(outputParent, { recursive: true });
  inspectDirectory(join(root, '.gear'));
  inspectDirectory(outputParent);
  const stage = join(outputParent, `.staging-${randomUUID()}`);
  mkdirSync(stage);
  try {
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, rootDir: root, outDir: stage,
      rewriteRelativeImportExtensions: true, allowJs: true, checkJs: false, noEmitOnError: true,
      skipLibCheck: true, strict: true, declaration: false, sourceMap: false, types: [] };
    const program = ts.createProgram([modulePath], options);
    const result = program.emit();
    const errors = ts.getPreEmitDiagnostics(program).concat(result.diagnostics).filter(item => item.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(`Author TypeScript compile failed:\n${ts.formatDiagnosticsWithColorAndContext(errors,
      { getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => '\n' })}`);
    for (const source of sources) {
      const output = join(stage, emitPath(source, root));
      if (!existsSync(output)) throw new Error(`Author compiler did not emit ${source}`);
      pinSdkImports(output, pathToFileURL(sdkEntry).href);
    }
    const digest = sealedTreeDigest(stage);
    if (existsSync(emitRoot)) {
      if (sealedTreeDigest(emitRoot) !== digest) throw new Error('Existing author emit identity drift');
      return digest;
    }
    renameSync(stage, emitRoot);
    return digest;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
export type InstalledAuthorAdmission = {
  readonly projectRoot: string; readonly sourceModule: string; readonly emittedModule: string;
  readonly emitRoot: string; readonly sdkEntry: string; readonly sdkEntryUrl: string;
  readonly sdkPackageRoot: string; readonly sdkPackageDigest: string;
  readonly sdkEntryDigest: string; readonly emitDigest: string; readonly sourceDigest: string;
};
function identity(root: string, modulePath: string): { sourceClosure: string; packageDigest: string; tarballDigest: string;
  lockDigest: string; sdkEntry: string; sdkPackageRoot: string; sdkEntryDigest: string; sources: string[]; graphDigest: string } {
  const sources = checkAuthorModuleSource(modulePath, root, undefined, true);
  const installed = installedPackage(root);
  const graphDigest = jsonDigest(sources.map(path => ({ path: relative(root, path),
    digest: createHash('sha256').update(readBoundedFile(path, 4 * 1024 * 1024)).digest('hex') })));
  return { sourceClosure: authorSourceClosureDigest(root), graphDigest, ...installed,
    sdkEntryDigest: createHash('sha256').update(readBoundedFile(installed.sdkEntry, 64 * 1024 * 1024)).digest('hex'), sources };
}
/** Admission only writes a disposable .gear/author-emit cache; no Campaign state/CAS/lock is created.
 * Replay later only verifies sealed source, package and emitted bytes. */
export function admitInstalledAuthorProject(projectRoot: string, module: string): InstalledAuthorAdmission {
  const root = realpathSync(projectRoot);
  if (isAbsolute(module) || module.split(/[\\/]/).includes('..')) throw new Error('Author module must be project-relative');
  const modulePath = realpathSync(resolve(root, module));
  if (!within(root, modulePath)) throw new Error('Author module escapes trusted project root');
  const first = identity(root, modulePath);
  const compilerDigest = compilerIdentity();
  const emitKey = jsonDigest({ source: first.sourceClosure, graph: first.graphDigest, package: first.packageDigest,
    tarball: first.tarballDigest, compiler: compilerDigest, sdkEntry: first.sdkEntry });
  const emitRoot = join(root, '.gear', 'author-emit', emitKey);
  const emitDigest = compileAuthor(root, modulePath, first.sources, first.sdkEntry, emitRoot);
  const second = identity(root, modulePath);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Author source changed during admission');
  const emittedModule = join(emitRoot, emitPath(modulePath, root));
  if (!existsSync(emittedModule)) throw new Error('Author entry was not emitted');
  return { projectRoot: root, sourceModule: modulePath, emittedModule, emitRoot,
    sdkEntry: first.sdkEntry, sdkEntryUrl: pathToFileURL(first.sdkEntry).href,
    sdkPackageRoot: first.sdkPackageRoot, sdkPackageDigest: first.packageDigest,
    sdkEntryDigest: first.sdkEntryDigest, emitDigest,
    sourceDigest: jsonDigest({ wireVersion: AUTHOR_WIRE_VERSION_V2, source: first.sourceClosure, graph: first.graphDigest,
      installedPackage: first.packageDigest, tarball: first.tarballDigest, lock: first.lockDigest,
      sdkEntry: first.sdkEntryDigest, emitted: emitDigest, compiler: compilerDigest }) };
}
export function verifyInstalledAuthorAdmission(admission: InstalledAuthorAdmission): void {
  const gearPath = join(admission.projectRoot, '.gear');
  if (lstatSync(gearPath).isSymbolicLink() || lstatSync(admission.emitRoot).isSymbolicLink()
    || !within(admission.projectRoot, realpathSync(admission.emitRoot)))
    throw new Error('Installed author emit path drift');
  const current = identity(admission.projectRoot, admission.sourceModule);
  const sourceDigest = jsonDigest({ wireVersion: AUTHOR_WIRE_VERSION_V2, source: current.sourceClosure, graph: current.graphDigest,
    installedPackage: current.packageDigest, tarball: current.tarballDigest, lock: current.lockDigest,
    sdkEntry: current.sdkEntryDigest, emitted: admission.emitDigest, compiler: compilerIdentity() });
  if (sourceDigest !== admission.sourceDigest || current.sdkEntry !== admission.sdkEntry
    || current.sdkPackageRoot !== admission.sdkPackageRoot
    || sealedTreeDigest(admission.emitRoot) !== admission.emitDigest)
    throw new Error('Installed author source/package/emit identity drift');
}

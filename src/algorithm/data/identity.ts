import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../schema.js';

const s3Entrypoints = ['providers/evidence', 'providers/tasks', 'providers/measurement', 'providers/execution', 'data/legacy'];
const closureScope = new AsyncLocalStorage<ImplementationClosureSnapshot>();

function normalizedEntrypoints(entrypoints: readonly string[]): string[] {
  if (entrypoints.length === 0 || entrypoints.some(entry => !/^(?:\.\.\/)?[A-Za-z0-9_./-]+$/u.test(entry)))
    throw new Error('Invalid implementation entrypoints');
  return [...new Set(entrypoints)].sort();
}

/** One invocation's actual source/package byte identity; never shared across runs or resumes. */
export class ImplementationClosureSnapshot {
  private readonly closures = new Map<string, string>();
  private active = true;

  capture(entrypoints: readonly string[]): void {
    if (!this.active) throw new Error('Implementation closure snapshot has expired');
    const normalized = normalizedEntrypoints(entrypoints), key = JSON.stringify(normalized);
    if (!this.closures.has(key)) this.closures.set(key, scanImplementationClosure(normalized));
  }

  digest(entrypoints: readonly string[], configuration: unknown): string {
    if (!this.active) throw new Error('Implementation closure snapshot has expired');
    const normalized = normalizedEntrypoints(entrypoints), key = JSON.stringify(normalized);
    this.capture(normalized);
    return configuredDigest(this.closures.get(key)!, configuration);
  }

  invalidate(): void { this.active = false; this.closures.clear(); }
}

/** Async-local isolation prevents concurrent admissions from sharing a source snapshot. */
export async function withImplementationClosureSnapshot<T>(work: (snapshot: ImplementationClosureSnapshot) => Promise<T>): Promise<T> {
  const snapshot = new ImplementationClosureSnapshot();
  try { return await closureScope.run(snapshot, () => work(snapshot)); }
  finally { snapshot.invalidate(); }
}

function configuredDigest(closure: string, configuration: unknown): string {
  return createHash('sha256').update(canonicalJson({ configuration, closure, node: process.versions.node })).digest('hex');
}

const builtins = new Set(builtinModules);
function externalName(path: string, repositoryRoot: string): { name: string; packagePath?: string; packageId?: string } {
  if (path.startsWith(`${repositoryRoot}/`) && !path.includes('/node_modules/')) return { name: relative(repositoryRoot, path) };
  let directory = dirname(path);
  while (directory !== dirname(directory)) {
    if (basename(directory) === 'node_modules') throw new Error(`External implementation package identity missing: ${path}`);
    const packagePath = join(directory, 'package.json');
    if (existsSync(packagePath)) {
      const packageInfo = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string; version?: string };
      // Subpath package.json files commonly declare only module type; keep walking to the installed package root.
      if (packageInfo.name && packageInfo.version) {
        const packageId = `external/${packageInfo.name}@${packageInfo.version}`;
        return { name: `${packageId}/${relative(directory, path)}`, packagePath, packageId };
      }
    }
    directory = dirname(directory);
  }
  throw new Error(`S3 implementation dependency has no package identity: ${path}`);
}

/** Hashes the transitive local import/export closure of the built or source implementation. */
export function implementationClosureDigest(entrypoints: readonly string[], configuration: unknown): string {
  const scoped = closureScope.getStore();
  if (scoped) return scoped.digest(entrypoints, configuration);
  return configuredDigest(scanImplementationClosure(normalizedEntrypoints(entrypoints)), configuration);
}

function scanImplementationClosure(normalized: readonly string[]): string {
  const current = fileURLToPath(import.meta.url);
  const algorithmRoot = dirname(dirname(current));
  const repositoryRoot = resolve(algorithmRoot, '../..');
  const extension = extname(current);
  const pending = normalized.map(entry => resolve(algorithmRoot, `${entry}${extension}`));
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  const packages = new Set<string>();
  const capturePackage = (entry: string): void => {
    const identity = externalName(entry, repositoryRoot);
    if (!identity.packagePath || !identity.packageId) throw new Error(`External package identity missing: ${entry}`);
    const packageRoot = dirname(identity.packagePath);
    if (packages.has(packageRoot)) return;
    packages.add(packageRoot);
    const manifest = JSON.parse(readFileSync(identity.packagePath, 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    const visit = (directory: string): void => {
      for (const entryName of readdirSync(directory).sort()) {
        if (entryName === 'node_modules') continue;
        const child = join(directory, entryName);
        const stat = lstatSync(child);
        if (stat.isSymbolicLink()) throw new Error(`External package contains a symlink: ${child}`);
        if (stat.isDirectory()) visit(child);
        else if (stat.isFile()) {
          const name = `${identity.packageId}/${relative(packageRoot, child)}`;
          const bytes = readFileSync(child);
          const previous = files.get(name);
          if (previous && !previous.equals(bytes)) throw new Error(`External package collision: ${name}`);
          files.set(name, bytes);
          if (files.size > 10_000) throw new Error('S3 external dependency closure too large');
        }
      }
    };
    visit(packageRoot);
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      let resolved: string;
      try { resolved = createRequire(identity.packagePath).resolve(dependency); }
      catch (error) { throw new Error(`Installed dependency ${dependency} missing from ${identity.packageId}`, { cause: error }); }
      capturePackage(resolved);
    }
    for (const dependency of [...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})].sort()) {
      let resolved: string;
      try { resolved = createRequire(identity.packagePath).resolve(dependency); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
      capturePackage(resolved);
    }
  };
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (!existsSync(path) || seen.size > 2_000) throw new Error(`S3 implementation dependency missing or too large: ${path}`);
    const bytes = readFileSync(path);
    const identity = externalName(path, repositoryRoot);
    if (identity.packagePath) { capturePackage(path); continue; }
    files.set(identity.name, bytes);
    const source = bytes.toString('utf8');
    const specs: string[] = [];
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!/^\s*(?:import\s+(?!\()|export\s+(?:\*|\{))/u.test(line)) continue;
      const sideEffect = line.match(/^\s*import\s*['"]([^'"\s;]+)['"]/u);
      if (sideEffect) { specs.push(sideEffect[1]!); continue; }
      let declaration = '';
      for (let next = index; next < Math.min(lines.length, index + 32); next++) {
        declaration += `${lines[next]!}\n`;
        const imported = declaration.match(/\bfrom\s*['"]([^'"\s;]+)['"]/u);
        if (imported) { specs.push(imported[1]!); break; }
        if (declaration.includes(';')) break;
      }
    }
    for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"\s;]+)['"]\s*\)/gu)) specs.push(match[1]!);
    for (const spec of specs) {
      if (spec.startsWith('node:') || builtins.has(spec)) continue;
      let dependency: string;
      if (spec.startsWith('.')) dependency = resolve(dirname(path), spec);
      else {
        try { dependency = createRequire(path).resolve(spec); }
        catch {
          let resolved: string;
          try { resolved = import.meta.resolve(spec); }
          catch (error) { throw new Error(`Unresolvable S3 dependency ${spec} from ${path}`, { cause: error }); }
          if (resolved.startsWith('node:')) continue;
          if (!resolved.startsWith('file:')) throw new Error(`Unresolvable external dependency ${spec}`);
          dependency = fileURLToPath(resolved);
        }
      }
      if (spec.startsWith('.') && extname(path) === '.ts' && extname(dependency) === '.js') dependency = `${dependency.slice(0, -3)}.ts`;
      if (!extname(dependency)) dependency += extension;
      if (spec.startsWith('.')) pending.push(dependency);
      else capturePackage(dependency);
    }
  }
  const hash = createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    hash.update(name); hash.update('\0'); hash.update(String(bytes.length)); hash.update('\0'); hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}

export function s3ImplementationDigest(kind: string, configuration: unknown): string {
  return implementationClosureDigest(s3Entrypoints, { kind, configuration });
}

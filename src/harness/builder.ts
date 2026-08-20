import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { applyPatch } from 'diff'
import { load as loadYaml } from 'js-yaml'
import type { ArtifactOp, HarnessManifest, HarnessMutation, PreparedHarness } from '../types.js'

const ALLOWED_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])
const FORBIDDEN_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
])

export interface HarnessCompiler {
  compile(worktree: string, signal: AbortSignal): Promise<void>
}

export interface HarnessBuilderOptions {
  harnessRoot: string
  artifactRoot: string
  dshRevision: string
  toolchainRef: string
  sandboxProfileRef: string
  maxOperations?: number
  maxMutationBytes?: number
  allowedImports?: string[]
  compiler: HarnessCompiler
}

export class MutationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MutationValidationError'
  }
}

function sha256(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function safeRelativePath(path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\')) {
    throw new MutationValidationError(`artifact path must be a non-empty POSIX relative path: ${path}`)
  }
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new MutationValidationError(`artifact path escapes or is not normalized: ${path}`)
  }
  if (!ALLOWED_ROOTS.has(segments[0]!)) throw new MutationValidationError(`artifact root is not mutable: ${path}`)
  if (segments.some(segment => FORBIDDEN_NAMES.has(segment))) {
    throw new MutationValidationError(`dependency and lock files are fixed substrate: ${path}`)
  }
  return segments.join('/')
}

async function files(root: string): Promise<string[]> {
  const found: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new MutationValidationError(`symlink is forbidden in harness artifacts: ${relative(root, absolute)}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) found.push(relative(root, absolute).split(sep).join('/'))
      else throw new MutationValidationError(`unsupported artifact type: ${relative(root, absolute)}`)
    }
  }
  await visit(root)
  return found.sort()
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const path of await files(source)) {
    if (path === 'manifest.json') continue
    const target = join(destination, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(source, ...path.split('/')), target)
  }
}

export class HarnessBuilder {
  private readonly maxOperations: number
  private readonly maxMutationBytes: number

  constructor(readonly options: HarnessBuilderOptions) {
    this.maxOperations = options.maxOperations ?? 32
    this.maxMutationBytes = options.maxMutationBytes ?? 512 * 1024
  }

  async build(mutation: HarnessMutation, signal: AbortSignal): Promise<PreparedHarness> {
    this.validateEnvelope(mutation)
    const parentPath = this.refPath(mutation.parentRef)
    const parentManifest = JSON.parse(await readFile(join(parentPath, 'manifest.json'), 'utf8')) as HarnessManifest
    if (parentManifest.digest !== mutation.parentDigest) {
      throw new MutationValidationError(`parent digest CAS failed: expected ${mutation.parentDigest}, found ${parentManifest.digest}`)
    }

    const worktree = await mkdtemp(join(tmpdir(), 'dsh-refine-build-'))
    try {
      await copyTree(parentPath, worktree)
      for (const op of mutation.ops) await this.applyOperation(worktree, op)
      await this.validateComposition(worktree)
      await this.validateImports(worktree)
      await this.options.compiler.compile(worktree, signal)
      const manifest = await this.createManifest(worktree, mutation.parentRef)
      await writeFile(join(worktree, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      const artifactPath = join(this.options.artifactRoot, manifest.digest.slice('sha256:'.length))
      await mkdir(dirname(artifactPath), { recursive: true })
      try {
        await rename(worktree, artifactPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          await copyTree(worktree, artifactPath)
          await copyFile(join(worktree, 'manifest.json'), join(artifactPath, 'manifest.json'))
          await rm(worktree, { recursive: true, force: true })
          return { ref: manifest.digest, digest: manifest.digest, artifactPath, manifest }
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
        const existing = JSON.parse(await readFile(join(artifactPath, 'manifest.json'), 'utf8')) as HarnessManifest
        if (existing.digest !== manifest.digest) throw new Error(`content-addressed artifact collision at ${artifactPath}`)
        await rm(worktree, { recursive: true, force: true })
      }
      return { ref: manifest.digest, digest: manifest.digest, artifactPath, manifest }
    } catch (error) {
      await rm(worktree, { recursive: true, force: true })
      throw error
    }
  }

  private validateEnvelope(mutation: HarnessMutation): void {
    if (mutation.ops.length === 0 || mutation.ops.length > this.maxOperations) {
      throw new MutationValidationError(`mutation must contain 1..${this.maxOperations} operations`)
    }
    let bytes = 0
    const paths = new Set<string>()
    for (const op of mutation.ops) {
      const path = safeRelativePath(op.path)
      if (paths.has(path)) throw new MutationValidationError(`artifact path appears more than once: ${path}`)
      paths.add(path)
      const source = op.type === 'patch' ? op.patch : op.type === 'create' ? op.content : ''
      if (source.includes('\0')) throw new MutationValidationError(`binary mutation content is forbidden: ${path}`)
      bytes += Buffer.byteLength(source)
    }
    if (bytes > this.maxMutationBytes) throw new MutationValidationError(`mutation exceeds ${this.maxMutationBytes} bytes`)
    if (mutation.evidenceRefs.some(ref => /held[-_]?out/iu.test(ref))) {
      throw new MutationValidationError('held-out evidence cannot be referenced by a mutation')
    }
  }

  private async applyOperation(root: string, op: ArtifactOp): Promise<void> {
    const path = safeRelativePath(op.path)
    const absolute = resolve(root, ...path.split('/'))
    if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new MutationValidationError(`artifact path escaped worktree: ${path}`)
    await this.assertNoSymlinkAncestor(root, path)
    if (op.type === 'create') {
      try {
        await lstat(absolute)
        throw new MutationValidationError(`create expected absent path: ${path}`)
      } catch (error) {
        if (error instanceof MutationValidationError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, op.content, { encoding: 'utf8', flag: 'wx' })
      return
    }
    const current = await readFile(absolute)
    if (sha256(current) !== op.expectedDigest) throw new MutationValidationError(`digest CAS failed for ${path}`)
    if (op.type === 'delete') {
      await rm(absolute)
      return
    }
    const patched = applyPatch(current.toString('utf8'), op.patch)
    if (patched === false) throw new MutationValidationError(`patch did not apply cleanly: ${path}`)
    await writeFile(absolute, patched, 'utf8')
  }

  private async assertNoSymlinkAncestor(root: string, path: string): Promise<void> {
    const segments = path.split('/').slice(0, -1)
    let current = root
    for (const segment of segments) {
      current = join(current, segment)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new MutationValidationError(`symlink ancestor is forbidden: ${path}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return
      }
    }
  }

  private async validateComposition(root: string): Promise<void> {
    const compositionPath = join(root, 'preset', 'agent.cordis.yml')
    const parsed = loadYaml(await readFile(compositionPath, 'utf8'))
    if (!Array.isArray(parsed)) throw new MutationValidationError('preset/agent.cordis.yml must contain a Cordis row list')
    for (const [index, row] of parsed.entries()) {
      if (typeof row !== 'object' || row === null || typeof (row as { name?: unknown }).name !== 'string') {
        throw new MutationValidationError(`preset row ${index + 1} must name a plugin`)
      }
    }
  }

  private async validateImports(root: string): Promise<void> {
    const allowed = this.options.allowedImports ?? ['@deepseek-ai/', 'node:']
    const importPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu
    for (const path of await files(root)) {
      if (!/\.[cm]?[jt]sx?$/u.test(path)) continue
      const source = await readFile(join(root, ...path.split('/')), 'utf8')
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1]
        if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('/')) continue
        if (!allowed.some(entry => specifier === entry || (entry.endsWith('/') && specifier.startsWith(entry)))) {
          throw new MutationValidationError(`import is outside the fixed dependency allowlist in ${path}: ${specifier}`)
        }
      }
    }
  }

  private async createManifest(root: string, parentRef: string): Promise<HarnessManifest> {
    const artifacts = []
    for (const path of await files(root)) {
      if (path === 'manifest.json') continue
      const content = await readFile(join(root, ...path.split('/')))
      artifacts.push({ path, digest: sha256(content), bytes: content.byteLength })
    }
    const identity = {
      schemaVersion: 1 as const,
      parentRef,
      dshRevision: this.options.dshRevision,
      toolchainRef: this.options.toolchainRef,
      sandboxProfileRef: this.options.sandboxProfileRef,
      artifacts,
    }
    return { ...identity, digest: sha256(JSON.stringify(identity)) }
  }

  private refPath(ref: string): string {
    if (!/^[a-zA-Z0-9:._-]+$/u.test(ref)) throw new MutationValidationError(`invalid harness ref: ${ref}`)
    if (ref.startsWith('sha256:')) return join(this.options.artifactRoot, ref.slice('sha256:'.length))
    return join(this.options.harnessRoot, ref.replace(':', '-'))
  }
}

export class NoopHarnessCompiler implements HarnessCompiler {
  async compile(_worktree: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
  }
}

export { sha256 as digestContent, safeRelativePath }
export function presetIdForHarnessRef(ref: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref)) throw new MutationValidationError(`target harness ref is not a sha256 identity: ${ref}`)
  return `target-${ref.slice('sha256:'.length)}`
}

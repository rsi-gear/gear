import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { applyPatch } from 'diff'
import { load as loadYaml } from 'js-yaml'
import type { ArtifactOp, HarnessManifest, HarnessMutation, PreparedHarness, SemanticTarget } from '../types.js'
import { isExactGitCommit } from '../types.js'

const ALLOWED_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])
const SEMANTIC_TARGETS = new Set<SemanticTarget>([
  'context', 'pre_action', 'routing', 'post_action', 'action_verifier',
  'skill', 'tool', 'workflow', 'compaction',
])
const FORBIDDEN_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
])

export interface HarnessCompiler {
  compile(worktree: string, signal: AbortSignal): Promise<void>
}

export interface HarnessBuilderOptions {
  repositoryPath: string
  targetRoot: string
  dshBaseRef: string
  toolchainRef: string
  sandboxProfileRef: string
  gitExecutable?: string
  commitAuthorName?: string
  commitAuthorEmail?: string
  maxOperations?: number
  maxMutationBytes?: number
  maxGitOutputBytes?: number
  allowedImports?: string[]
  compiler: HarnessCompiler
}

interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

interface GitTreeEntry {
  mode: string
  type: string
  path: string
}

export class MutationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MutationValidationError'
  }
}

export class SubstrateExpansionError extends MutationValidationError {
  constructor(message: string) {
    super(message)
    this.name = 'SubstrateExpansionError'
  }
}

function sha256(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function normalizedTargetRoot(path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\')) {
    throw new TypeError('targetRoot must be a non-empty POSIX relative path')
  }
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError('targetRoot must be normalized and contained in the DSH repository')
  }
  return segments.join('/')
}

function safeRelativePath(path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\')) {
    throw new MutationValidationError(`artifact path must be a non-empty POSIX relative path: ${path}`)
  }
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new MutationValidationError(`artifact path escapes or is not normalized: ${path}`)
  }
  if (!ALLOWED_ROOTS.has(segments[0]!)) throw new SubstrateExpansionError(`artifact root is fixed substrate: ${path}`)
  if (segments.some(segment => FORBIDDEN_NAMES.has(segment))) {
    throw new SubstrateExpansionError(`dependency and lock files are fixed substrate: ${path}`)
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

export class HarnessBuilder {
  private readonly maxOperations: number
  private readonly maxMutationBytes: number
  private readonly maxGitOutputBytes: number
  readonly repositoryPath: string
  readonly targetRoot: string

  constructor(readonly options: HarnessBuilderOptions) {
    this.repositoryPath = resolve(options.repositoryPath)
    this.targetRoot = normalizedTargetRoot(options.targetRoot)
    this.maxOperations = options.maxOperations ?? 32
    this.maxMutationBytes = options.maxMutationBytes ?? 512 * 1024
    this.maxGitOutputBytes = options.maxGitOutputBytes ?? 8 * 1024 * 1024
  }

  async initialize(): Promise<void> {
    const inside = (await this.git(['rev-parse', '--is-inside-work-tree'])).stdout.trim()
    if (inside !== 'true') throw new Error(`target DSH repository is not a Git worktree: ${this.repositoryPath}`)
    await this.assertRepositoryClean()
    await this.resolveExactCommit(this.options.dshBaseRef, true)
  }

  async build(mutation: HarnessMutation, signal: AbortSignal): Promise<PreparedHarness> {
    this.validateEnvelope(mutation)
    await this.assertRepositoryClean()
    const parentRef = await this.resolveExactCommit(mutation.parentRef, true)
    const parentManifest = await this.readManifest(parentRef)
    if (parentManifest.digest !== mutation.parentDigest) {
      throw new MutationValidationError(`parent digest CAS failed: expected ${mutation.parentDigest}, found ${parentManifest.digest}`)
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-refine-build-'))
    const worktree = join(temporaryRoot, 'worktree')
    let worktreeAdded = false
    try {
      await this.git(['worktree', 'add', '--detach', worktree, parentRef], signal)
      worktreeAdded = true
      const harnessRoot = join(worktree, ...this.targetRoot.split('/'))
      for (const op of mutation.ops) await this.applyOperation(harnessRoot, op)
      await this.validateComposition(harnessRoot)
      await this.validateImports(harnessRoot)
      await this.options.compiler.compile(worktree, signal)
      await this.assertCompilerStayedInTarget(worktree)
      const manifest = await this.createManifest(harnessRoot, parentRef)
      await writeFile(join(harnessRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await this.git(['-C', worktree, 'add', '--', this.targetRoot], signal)
      await this.git([
        '-C', worktree,
        '-c', `user.name=${this.options.commitAuthorName ?? 'DSH Refine Meta Agent'}`,
        '-c', `user.email=${this.options.commitAuthorEmail ?? 'dsh-refine@localhost'}`,
        'commit', '--no-gpg-sign', '--no-verify', '-m', `refine: evolve target harness from ${parentRef}`,
      ], signal)
      const ref = await this.resolveExactCommitAt(worktree, 'HEAD')
      const status = (await this.git(['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all'], signal)).stdout
      if (status.trim().length > 0) throw new Error(`candidate worktree is not clean after commit:\n${status.slice(0, 4000)}`)
      await this.git(['update-ref', `refs/dsh-refine/candidates/${ref}`, ref], signal)
      return { ref, digest: manifest.digest, repositoryPath: this.repositoryPath, manifest }
    } finally {
      if (worktreeAdded) await this.git(['worktree', 'remove', '--force', worktree]).catch(() => {})
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  validateMutation(value: unknown): HarnessMutation {
    try {
      this.validateEnvelope(value as HarnessMutation)
    } catch (error) {
      // A structurally submitted proposal that asks for fixed substrate is
      // admitted so RefineService can durably classify it as such.
      if (!(error instanceof SubstrateExpansionError)) throw error
    }
    return value as HarnessMutation
  }

  async readManifest(ref: string): Promise<HarnessManifest> {
    const commit = await this.resolveExactCommit(ref, true)
    await this.assertBaseAncestor(commit)
    const text = await this.show(commit, 'manifest.json')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new MutationValidationError(`target manifest is invalid JSON at ${commit}: ${String(error)}`)
    }
    const manifest = this.validateManifest(value, commit)
    await this.verifyManifestArtifacts(commit, manifest)
    return manifest
  }

  async readHarnessFile(ref: string, path: string): Promise<{ content: string; digest: string; bytes: number }> {
    const normalized = safeRelativePath(path)
    const manifest = await this.readManifest(ref)
    const artifact = manifest.artifacts.find(item => item.path === normalized)
    if (artifact === undefined) throw new MutationValidationError(`path is not in the target manifest: ${normalized}`)
    const raw = await this.showBuffer(ref, normalized)
    const content = raw.toString('utf8')
    if (!Buffer.from(content, 'utf8').equals(raw)) {
      throw new MutationValidationError(`target harness file is not UTF-8 text: ${normalized}`)
    }
    const bytes = raw.byteLength
    const digest = sha256(raw)
    if (artifact.bytes !== bytes || artifact.digest !== digest) {
      throw new MutationValidationError(`manifest integrity mismatch for ${normalized} at ${ref}`)
    }
    return { content, digest, bytes }
  }

  private validateEnvelope(value: HarnessMutation): void {
    if (typeof value !== 'object' || value === null) throw new MutationValidationError('mutation must be an object')
    if (!isExactGitCommit(value.parentRef)) throw new MutationValidationError('mutation parentRef must be a full Git commit OID')
    if (typeof value.parentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.parentDigest)) {
      throw new MutationValidationError('mutation parentDigest must be a sha256 digest')
    }
    if (!SEMANTIC_TARGETS.has(value.target)) throw new MutationValidationError(`unknown semantic target: ${String(value.target)}`)
    if (!Array.isArray(value.ops) || value.ops.length === 0 || value.ops.length > this.maxOperations) {
      throw new MutationValidationError(`mutation must contain 1..${this.maxOperations} operations`)
    }
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some(ref => typeof ref !== 'string')) {
      throw new MutationValidationError('mutation evidenceRefs must be strings')
    }
    if (typeof value.rationale !== 'string' || typeof value.expectedOutcome !== 'string') {
      throw new MutationValidationError('mutation rationale and expectedOutcome must be strings')
    }
    let bytes = 0
    const paths = new Set<string>()
    for (const op of value.ops) {
      if (typeof op !== 'object' || op === null || !new Set(['create', 'patch', 'delete']).has(op.type)) {
        throw new MutationValidationError('mutation operation has an invalid type')
      }
      if (typeof op.path !== 'string') throw new MutationValidationError('mutation operation path must be a string')
      const path = safeRelativePath(op.path)
      if (paths.has(path)) throw new MutationValidationError(`artifact path appears more than once: ${path}`)
      paths.add(path)
      if (op.type === 'create' && (op.expect !== 'absent' || typeof op.content !== 'string')) {
        throw new MutationValidationError(`create operation is malformed: ${path}`)
      }
      if (op.type === 'patch' && (typeof op.patch !== 'string' || typeof op.expectedDigest !== 'string')) {
        throw new MutationValidationError(`patch operation is malformed: ${path}`)
      }
      if (op.type === 'delete' && typeof op.expectedDigest !== 'string') {
        throw new MutationValidationError(`delete operation is malformed: ${path}`)
      }
      const source = op.type === 'patch' ? op.patch : op.type === 'create' ? op.content : ''
      if (source.includes('\0')) throw new MutationValidationError(`binary mutation content is forbidden: ${path}`)
      bytes += Buffer.byteLength(source)
    }
    if (bytes > this.maxMutationBytes) throw new MutationValidationError(`mutation exceeds ${this.maxMutationBytes} bytes`)
    if (value.evidenceRefs.some(ref => /held[-_]?out/iu.test(ref))) {
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
          throw new SubstrateExpansionError(`import is outside the fixed dependency allowlist in ${path}: ${specifier}`)
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
      dshBaseRef: this.options.dshBaseRef,
      toolchainRef: this.options.toolchainRef,
      sandboxProfileRef: this.options.sandboxProfileRef,
      artifacts,
    }
    return { ...identity, digest: sha256(JSON.stringify(identity)) }
  }

  private validateManifest(value: unknown, commit: string): HarnessManifest {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new MutationValidationError(`target manifest must be an object at ${commit}`)
    }
    const manifest = value as Partial<HarnessManifest>
    if (manifest.schemaVersion !== 1 || manifest.dshBaseRef !== this.options.dshBaseRef
      || manifest.toolchainRef !== this.options.toolchainRef
      || manifest.sandboxProfileRef !== this.options.sandboxProfileRef
      || !Array.isArray(manifest.artifacts)
      || typeof manifest.digest !== 'string') {
      throw new MutationValidationError(`target manifest substrate does not match fixed configuration at ${commit}`)
    }
    if (manifest.parentRef !== undefined && !isExactGitCommit(manifest.parentRef)) {
      throw new MutationValidationError(`target manifest parentRef is not an exact commit at ${commit}`)
    }
    for (const artifact of manifest.artifacts) {
      if (typeof artifact !== 'object' || artifact === null
        || typeof artifact.path !== 'string' || typeof artifact.digest !== 'string'
        || typeof artifact.bytes !== 'number' || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
        throw new MutationValidationError(`target manifest has an invalid artifact entry at ${commit}`)
      }
      safeRelativePath(artifact.path)
      if (!/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)) {
        throw new MutationValidationError(`target manifest has an invalid artifact digest at ${commit}`)
      }
    }
    const identity = {
      schemaVersion: 1 as const,
      ...(manifest.parentRef === undefined ? {} : { parentRef: manifest.parentRef }),
      dshBaseRef: manifest.dshBaseRef,
      toolchainRef: manifest.toolchainRef,
      sandboxProfileRef: manifest.sandboxProfileRef,
      artifacts: manifest.artifacts,
    }
    if (sha256(JSON.stringify(identity)) !== manifest.digest) {
      throw new MutationValidationError(`target manifest digest is invalid at ${commit}`)
    }
    return { ...identity, digest: manifest.digest }
  }

  private async verifyManifestArtifacts(commit: string, manifest: HarnessManifest): Promise<void> {
    const raw = await this.gitBuffer([
      'ls-tree', '-rz', '--full-tree', commit, '--', this.targetRoot,
    ])
    const entries: GitTreeEntry[] = raw.toString('utf8').split('\0').filter(Boolean).map((line) => {
      const match = line.match(/^(\d+)\s+(\S+)\s+[0-9a-f]+\t(.+)$/u)
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw new MutationValidationError(`Git returned an invalid target tree entry at ${commit}`)
      }
      return { mode: match[1], type: match[2], path: match[3] }
    })
    const prefix = `${this.targetRoot}/`
    const artifacts = new Map(manifest.artifacts.map(artifact => [artifact.path, artifact]))
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) throw new MutationValidationError(`target tree escaped ${this.targetRoot} at ${commit}`)
      const path = entry.path.slice(prefix.length)
      if (path === 'manifest.json') {
        if (entry.mode !== '100644' || entry.type !== 'blob') {
          throw new MutationValidationError(`target manifest must be a regular file at ${commit}`)
        }
        continue
      }
      safeRelativePath(path)
      if ((entry.mode !== '100644' && entry.mode !== '100755') || entry.type !== 'blob') {
        throw new MutationValidationError(`target artifact must be a regular file: ${path}`)
      }
      const declared = artifacts.get(path)
      if (declared === undefined) throw new MutationValidationError(`target artifact is missing from manifest: ${path}`)
      if (seen.has(path)) throw new MutationValidationError(`target manifest contains a duplicate artifact: ${path}`)
      seen.add(path)
      const content = await this.gitBuffer(['show', `${commit}:${entry.path}`])
      if (content.byteLength !== declared.bytes || sha256(content) !== declared.digest) {
        throw new MutationValidationError(`target manifest integrity mismatch for ${path} at ${commit}`)
      }
    }
    for (const path of artifacts.keys()) {
      if (!seen.has(path)) throw new MutationValidationError(`manifest artifact is missing from target tree: ${path}`)
    }
    if (!entries.some(entry => entry.path === `${this.targetRoot}/manifest.json`)) {
      throw new MutationValidationError(`target manifest is missing at ${commit}`)
    }
  }

  private async assertRepositoryClean(): Promise<void> {
    const status = (await this.git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout
    if (status.trim().length > 0) throw new Error(`target DSH repository must be clean before refinement:\n${status.slice(0, 4000)}`)
  }

  private async assertBaseAncestor(commit: string): Promise<void> {
    const result = await this.git(['merge-base', '--is-ancestor', this.options.dshBaseRef, commit], undefined, [0, 1])
    if (result.code !== 0) throw new MutationValidationError(`candidate parent ${commit} is not based on fixed DSH base ${this.options.dshBaseRef}`)
  }

  private async assertCompilerStayedInTarget(worktree: string): Promise<void> {
    const output = (await this.git(['-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all'])).stdout
    for (const line of output.split('\n').filter(Boolean)) {
      const rawPath = line.slice(3).split(' -> ').at(-1) ?? ''
      const normalized = rawPath.replace(/^"|"$/gu, '')
      if (normalized !== this.targetRoot && !normalized.startsWith(`${this.targetRoot}/`)) {
        throw new SubstrateExpansionError(`compiler or mutation changed fixed substrate outside ${this.targetRoot}: ${normalized}`)
      }
    }
  }

  private async resolveExactCommit(ref: string, requireExact: boolean): Promise<string> {
    const commit = await this.resolveExactCommitAt(this.repositoryPath, ref)
    if (requireExact && (!isExactGitCommit(ref) || ref !== commit)) {
      throw new MutationValidationError(`harness ref must be the exact full Git commit OID: ${ref}`)
    }
    return commit
  }

  private async resolveExactCommitAt(repository: string, ref: string): Promise<string> {
    const output = (await this.git(['-C', repository, 'rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim()
    if (!isExactGitCommit(output)) throw new Error(`Git returned a non-canonical commit OID for ${ref}: ${output}`)
    return output
  }

  private async show(ref: string, path: string): Promise<string> {
    const commit = await this.resolveExactCommit(ref, true)
    const gitPath = `${this.targetRoot}/${path}`
    return (await this.git(['show', `${commit}:${gitPath}`])).stdout
  }

  private async showBuffer(ref: string, path: string): Promise<Buffer> {
    const commit = await this.resolveExactCommit(ref, true)
    return this.gitBuffer(['show', `${commit}:${this.targetRoot}/${path}`])
  }

  private gitBuffer(args: string[], signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    return new Promise<Buffer>((resolvePromise, reject) => {
      const command = this.options.gitExecutable ?? 'git'
      const fullArgs = ['-C', this.repositoryPath, ...args]
      const child = spawn(command, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let overflow = false
      const append = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength
        if (outputBytes > this.maxGitOutputBytes) {
          overflow = true
          child.kill('SIGTERM')
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
      const abort = (): void => { child.kill('SIGTERM') }
      signal?.addEventListener('abort', abort, { once: true })
      child.once('error', reject)
      child.once('exit', (code, childSignal) => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted === true) return reject(signal.reason)
        if (overflow) return reject(new Error(`${command} output exceeded ${this.maxGitOutputBytes} bytes`))
        if (code !== 0) {
          return reject(new Error(`${command} ${fullArgs.join(' ')} failed (${childSignal ?? code ?? 'unknown'}): ${Buffer.concat(stderr).toString('utf8').slice(-4000)}`))
        }
        resolvePromise(Buffer.concat(stdout))
      })
    })
  }

  private git(args: string[], signal?: AbortSignal, allowedExitCodes: number[] = [0]): Promise<CommandResult> {
    return this.command(this.options.gitExecutable ?? 'git', ['-C', this.repositoryPath, ...args], signal, allowedExitCodes)
  }

  private command(command: string, args: string[], signal?: AbortSignal, allowedExitCodes: number[] = [0]): Promise<CommandResult> {
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    return new Promise<CommandResult>((resolvePromise, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let overflow = false
      const append = (current: string, chunk: string): string => {
        const next = current + chunk
        if (Buffer.byteLength(next) > this.maxGitOutputBytes) {
          overflow = true
          child.kill('SIGTERM')
          return next.slice(0, this.maxGitOutputBytes)
        }
        return next
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout = append(stdout, chunk) })
      child.stderr.on('data', (chunk: string) => { stderr = append(stderr, chunk) })
      const abort = (): void => { child.kill('SIGTERM') }
      signal?.addEventListener('abort', abort, { once: true })
      child.once('error', reject)
      child.once('exit', (code, childSignal) => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted === true) return reject(signal.reason)
        if (overflow) return reject(new Error(`${command} output exceeded ${this.maxGitOutputBytes} bytes`))
        const exitCode = code ?? -1
        if (!allowedExitCodes.includes(exitCode)) {
          return reject(new Error(`${command} ${args.join(' ')} failed (${childSignal ?? exitCode}): ${stderr.slice(-4000)}`))
        }
        resolvePromise({ stdout, stderr, code: exitCode })
      })
    })
  }
}

export class NoopHarnessCompiler implements HarnessCompiler {
  async compile(_worktree: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason
  }
}

export { sha256 as digestContent, safeRelativePath }

export function presetIdForManifestDigest(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new MutationValidationError(`manifest digest is invalid: ${digest}`)
  return `target-${digest.slice('sha256:'.length)}`
}

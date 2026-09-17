import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import ts from 'typescript'
import type { CandidateDiffSummary, HarnessManifest, PreparedHarness, SealedCandidateVersion } from '../types.js'
import { isExactGitCommit } from '../types.js'
import type { CandidateWorkspaceHandle } from '../candidate/workspace.js'
import { candidateCheckReport, CompilerCheckError, type CandidateCheckReport, type CompilerCheckReport } from './check-report.js'

const ALLOWED_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])
const FORBIDDEN_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
])

export interface HarnessCompiler {
  readonly runtimeValidation?: boolean
  compile(worktree: string, signal: AbortSignal, manifest?: HarnessManifest): Promise<void | CompilerCheckReport>
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

function porcelainPaths(output: string): string[] {
  const fields = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined || field.length === 0) continue
    if (field.length < 4 || field[2] !== ' ') throw new Error('Git returned malformed porcelain status')
    const code = field.slice(0, 2)
    paths.push(field.slice(3))
    if (/[RC]/u.test(code)) {
      const source = fields[++index]
      if (source === undefined || source.length === 0) throw new Error('Git returned malformed rename/copy status')
      paths.push(source)
    }
  }
  return paths
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
  private readonly maxGitOutputBytes: number
  readonly repositoryPath: string
  readonly targetRoot: string

  constructor(readonly options: HarnessBuilderOptions) {
    this.repositoryPath = resolve(options.repositoryPath)
    this.targetRoot = normalizedTargetRoot(options.targetRoot)
    this.maxGitOutputBytes = options.maxGitOutputBytes ?? 8 * 1024 * 1024
  }

  async initialize(): Promise<void> {
    const inside = (await this.git(['rev-parse', '--is-inside-work-tree'])).stdout.trim()
    if (inside !== 'true') throw new Error(`target DSH repository is not a Git worktree: ${this.repositoryPath}`)
    await this.resolveExactCommit(this.options.dshBaseRef, true)
  }

  validationCapabilities() {
    return { pipeline: 'compiler', runtime: this.options.compiler.runtimeValidation === true ? 'configured' : 'unavailable' }
  }

  async finalizeWorkspace(
    handle: CandidateWorkspaceHandle,
    sealed: CandidateDiffSummary,
    signal: AbortSignal,
  ): Promise<PreparedHarness> {
    if (handle.state !== 'finalizing') throw new MutationValidationError(`candidate workspace must be finalizing, found ${handle.state}`)
    if (sealed.parentRef !== handle.parentRef || sealed.files.length === 0) {
      throw new MutationValidationError('candidate workspace has no sealed change or the parent identity mismatches')
    }
    const parentRef = await this.resolveExactCommit(handle.parentRef, true)
    const parentManifest = await this.readManifest(parentRef)
    if (parentManifest.digest !== handle.parentDigest) {
      throw new MutationValidationError(`parent digest CAS failed: expected ${handle.parentDigest}, found ${parentManifest.digest}`)
    }
    const head = await this.resolveExactCommitAt(handle.worktreePath, 'HEAD')
    if (head !== parentRef) throw new MutationValidationError('candidate workspace HEAD changed after sealing')
    const cached = await this.git(['-C', handle.worktreePath, 'diff', '--cached', '--quiet', '--exit-code'], signal, [0, 1])
    if (cached.code !== 0) throw new MutationValidationError('candidate workspace index changed before finalization')

    const harnessRoot = join(handle.worktreePath, ...this.targetRoot.split('/'))
    await this.validateComposition(harnessRoot)
    await this.validateImports(harnessRoot)
    const validation = await this.compileWorkspace(handle, signal)
    await this.assertCompilerStayedInTarget(handle.worktreePath)
    if (await this.resolveExactCommitAt(handle.worktreePath, 'HEAD') !== parentRef) {
      throw new SubstrateExpansionError('compiler changed candidate Git HEAD')
    }
    const manifest = await this.createManifest(harnessRoot, parentRef)
    if (!await this.hasArtifactChanges(handle.worktreePath)) {
      throw new MutationValidationError('candidate has no artifact changes after the fixed compiler pipeline')
    }
    await writeFile(join(harnessRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await this.git(['-C', handle.worktreePath, 'add', '--', this.targetRoot], signal)
    await this.assertCompilerStayedInTarget(handle.worktreePath)
    await this.git([
      '-C', handle.worktreePath,
      '-c', `user.name=${this.options.commitAuthorName ?? 'DSH Refine Meta Agent'}`,
      '-c', `user.email=${this.options.commitAuthorEmail ?? 'dsh-refine@localhost'}`,
      'commit', '--no-gpg-sign', '--no-verify', '-m', 'refine: evolve target harness', '-m',
      `Evolution: ${handle.evolutionId}\nRound: ${handle.roundId}\nParent: ${parentRef}`,
    ], signal)
    const ref = await this.resolveExactCommitAt(handle.worktreePath, 'HEAD')
    const status = (await this.git(['-C', handle.worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)).stdout
    if (status.length > 0) throw new Error(`candidate worktree is not clean after commit (${porcelainPaths(status).slice(0, 20).join(', ')})`)
    const immutableRef = `refs/dsh-refine/evolutions/${handle.evolutionId}/candidates/${ref}`
    await this.git(['update-ref', immutableRef, ref], signal)
    const treeOid = (await this.git(['rev-parse', `${ref}^{tree}`], signal)).stdout.trim()
    if (!isExactGitCommit(treeOid)) throw new MutationValidationError('candidate root tree object id is invalid')
    const verified = await this.readManifest(ref)
    if (verified.digest !== manifest.digest) throw new MutationValidationError('candidate manifest changed while committing')
    return { ref, digest: manifest.digest, treeOid, immutableRef, repositoryPath: this.repositoryPath, manifest, validation }
  }

  async checkWorkspace(handle: CandidateWorkspaceHandle, signal: AbortSignal): Promise<CandidateCheckReport> {
    if (handle.state !== 'open') throw new MutationValidationError(`candidate workspace must be open for checks, found ${handle.state}`)
    const parentRef = await this.resolveExactCommit(handle.parentRef, true)
    if (await this.resolveExactCommitAt(handle.worktreePath, 'HEAD') !== parentRef) {
      throw new MutationValidationError('candidate workspace HEAD changed before check')
    }
    const harnessRoot = join(handle.worktreePath, ...this.targetRoot.split('/'))
    await this.validateComposition(harnessRoot)
    await this.validateImports(harnessRoot)
    const report = await this.compileWorkspace(handle, signal)
    await this.assertCompilerStayedInTarget(handle.worktreePath)
    return report
  }

  private async compileWorkspace(handle: CandidateWorkspaceHandle, signal: AbortSignal): Promise<CandidateCheckReport> {
    const root = join(handle.worktreePath, this.targetRoot)
    const before = await this.createManifest(root, handle.parentRef)
    const compiler = await this.options.compiler.compile(handle.worktreePath, signal, before)
    if (compiler?.ok === false) throw new CompilerCheckError(compiler)
    if (compiler?.runtime.load.status !== undefined && compiler.runtime.load.status !== 'not_checked') {
      const after = await this.createManifest(root, handle.parentRef)
      if (after.digest !== before.digest) throw new MutationValidationError('CANDIDATE_CHANGED_DURING_CHECK: candidate no longer matches runtime evidence')
    }
    return candidateCheckReport(compiler ?? undefined, before.digest)
  }

  async verifySealedCandidate(version: Readonly<SealedCandidateVersion>): Promise<void> {
    const commit = await this.resolveExactCommit(version.commitOid, true)
    const pinned = await this.resolveExactCommit(version.immutableRef, false)
    if (pinned !== commit) throw new MutationValidationError('candidate immutable ref no longer points to its sealed commit')
    const treeOid = (await this.git(['rev-parse', `${commit}^{tree}`])).stdout.trim()
    if (treeOid !== version.treeOid) throw new MutationValidationError('candidate tree OID does not match its sealed commit')
    const manifest = await this.readManifest(commit)
    if (manifest.digest !== version.manifestDigest) {
      throw new MutationValidationError('candidate manifest digest does not match its sealed commit')
    }
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

  async searchSnapshot(candidateId: string, ref: string, parentIds: string[] = []): Promise<import('../search/types.js').Snapshot> {
    const manifest = await this.readManifest(ref)
    const tree = (await this.git(['rev-parse', `${ref}^{tree}`])).stdout.trim()
    const { seal } = await import('../search/contracts.js')
    return seal({ candidateId, commit: ref, tree, manifestDigest: manifest.digest, parentIds, findingRefs: [] })
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

  async readHarnessDiff(
    parentRef: string,
    candidateRef: string,
    paths: readonly string[],
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{
    parentRef: string
    candidateRef: string
    paths: string[]
    patch: string
    patchBytes: number
    contentDigest: string
    truncated: boolean
  }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('historical diff maxBytes must be positive')
    const parent = await this.resolveExactCommit(parentRef, true)
    const candidate = await this.resolveExactCommit(candidateRef, true)
    const manifest = await this.readManifest(candidate)
    if (manifest.parentRef !== parent) throw new MutationValidationError('historical candidate does not name the recorded parent')
    await this.readManifest(parent)
    const selected = [...new Set(paths.map(safeRelativePath))].sort()
    if (selected.length === 0) throw new MutationValidationError('historical candidate has no recorded changed paths')
    const patch = (await this.git([
      'diff', '--no-ext-diff', '--no-color', '--unified=3', parent, candidate, '--',
      ...selected.map(path => `${this.targetRoot}/${path}`),
    ], signal)).stdout
    const raw = Buffer.from(patch)
    if (raw.byteLength <= maxBytes) {
      return {
        parentRef: parent,
        candidateRef: candidate,
        paths: selected,
        patch,
        patchBytes: raw.byteLength,
        contentDigest: sha256(raw),
        truncated: false,
      }
    }
    let end = maxBytes
    let visible = raw.subarray(0, end).toString('utf8')
    while (visible.endsWith('\uFFFD') && end > 0) visible = raw.subarray(0, --end).toString('utf8')
    return {
      parentRef: parent,
      candidateRef: candidate,
      paths: selected,
      patch: visible,
      patchBytes: raw.byteLength,
      contentDigest: sha256(raw),
      truncated: true,
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
    for (const path of await files(root)) {
      if (!/\.[cm]?[jt]sx?$/u.test(path)) continue
      const source = await readFile(join(root, ...path.split('/')), 'utf8')
      // Parse JS/TS/JSX instead of treating examples in prompts, comments, or
      // regular expressions as imports. The fixed compiler still owns builds.
      const visit = (node: ts.Node): void => {
        let module: ts.Node | undefined
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          module = node.moduleSpecifier
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
          module = node.moduleReference.expression
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
          module = node.argument.literal
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === 'require'
          || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require'
            && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'module')) {
          module = node.arguments[0]
        }
        if (module !== undefined && ts.isStringLiteralLike(module)) {
          const specifier = module.text
          if (!specifier.startsWith('.') && !specifier.startsWith('/')
            && !allowed.some(entry => entry === 'node:'
              ? specifier.startsWith('node:') && isBuiltin(specifier)
              : specifier === entry || (entry.endsWith('/') && specifier.startsWith(entry)))) {
            throw new SubstrateExpansionError(`import is outside the fixed dependency allowlist in ${path}: ${specifier}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest))
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

  private async assertBaseAncestor(commit: string): Promise<void> {
    const result = await this.git(['merge-base', '--is-ancestor', this.options.dshBaseRef, commit], undefined, [0, 1])
    if (result.code !== 0) throw new MutationValidationError(`candidate parent ${commit} is not based on fixed DSH base ${this.options.dshBaseRef}`)
  }

  private async assertCompilerStayedInTarget(worktree: string): Promise<void> {
    const output = (await this.git(['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout
    for (const path of porcelainPaths(output)) {
      if (path !== this.targetRoot && !path.startsWith(`${this.targetRoot}/`)) {
        throw new SubstrateExpansionError(`compiler or mutation changed fixed substrate outside ${this.targetRoot}: ${path}`)
      }
    }
  }

  private async hasArtifactChanges(worktree: string): Promise<boolean> {
    const output = (await this.git([
      '-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', this.targetRoot,
    ])).stdout
    return porcelainPaths(output).some(path => path !== `${this.targetRoot}/manifest.json`)
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
      child.once('close', (code, childSignal) => {
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
      child.once('close', (code, childSignal) => {
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

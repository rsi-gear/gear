import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CandidateDiffFile, CandidateDiffSummary, RefinementRound } from '../types.js'
import { isExactGitCommit } from '../types.js'
import { createTwoFilesPatch, diffLines } from 'diff'

const ALLOWED_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])
const FORBIDDEN_NAMES = new Set(['manifest.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'])

export type CandidateWorkspaceState = 'open' | 'sealing' | 'sealed' | 'finalizing' | 'committed' | 'disposed'

export interface CandidateWorkspaceHandle {
  workspaceId: string
  evolutionId: string
  roundId: string
  parentRef: string
  parentDigest: string
  worktreePath: string
  targetPath: string
  generation: number
  ownershipToken: string
  state: CandidateWorkspaceState
}

export interface CandidateWorkspaceBinding {
  metaSessionId: string
  evolutionId: string
  workspaceId: string
  roundId: string
  generation: number
}

export interface CandidateWorkspaceRequest {
  evolutionId: string
  roundId: string
  parentHarnessRef: string
  parentHarnessDigest: string
}

export interface CandidateWorkspaceOptions {
  repositoryPath: string
  targetRoot: string
  rootForEvolution(evolutionId: string): string
  maxFiles: number
  maxBytes: number
  maxDiffBytes: number
  gitExecutable?: string
}

interface CommandResult { stdout: Buffer; stderr: Buffer; code: number }

function sha256(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function isContained(path: string, root: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

function safeId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new TypeError(`${label} is invalid`)
  return value
}

function posix(path: string): string { return path.split(sep).join('/') }

function validateArtifactPath(path: string): string {
  if (path.length === 0 || path.includes('\\') || path.startsWith('/') || path.includes('\0')) {
    throw new Error(`candidate path is invalid: ${path}`)
  }
  const parts = path.split('/')
  if (parts.some(part => part.length === 0 || part === '.' || part === '..')) throw new Error(`candidate path is not normalized: ${path}`)
  if (!ALLOWED_ROOTS.has(parts[0]!)) throw new Error(`candidate path is fixed substrate: ${path}`)
  if (parts.some(part => FORBIDDEN_NAMES.has(part))) throw new Error(`candidate path is protected: ${path}`)
  return parts.join('/')
}

export class CandidateWorkspaceManager {
  private readonly repositoryPath: string
  private readonly targetRoot: string
  private readonly gitExecutable: string
  private readonly handles = new Map<string, CandidateWorkspaceHandle>()
  private readonly bindings = new Map<string, CandidateWorkspaceBinding>()
  private readonly activeOperations = new Map<string, number>()
  private generation = 0

  constructor(readonly options: CandidateWorkspaceOptions) {
    this.repositoryPath = resolve(options.repositoryPath)
    this.targetRoot = options.targetRoot
    this.gitExecutable = options.gitExecutable ?? 'git'
  }

  async initialize(): Promise<void> {
    const inside = (await this.git(['-C', this.repositoryPath, 'rev-parse', '--is-inside-work-tree'])).stdout.toString('utf8').trim()
    if (inside !== 'true') throw new Error(`candidate repository is not a Git worktree: ${this.repositoryPath}`)
  }

  async create(input: Readonly<CandidateWorkspaceRequest> | Readonly<RefinementRound>, signal: AbortSignal): Promise<CandidateWorkspaceHandle> {
    const request: CandidateWorkspaceRequest = 'parentHarnessRef' in input ? input : {
      evolutionId: input.evolutionId,
      roundId: input.roundId,
      parentHarnessRef: input.targetHarnessRef,
      parentHarnessDigest: input.targetHarnessDigest,
    }
    safeId(request.evolutionId, 'evolutionId')
    safeId(request.roundId, 'roundId')
    if (!isExactGitCommit(request.parentHarnessRef)) throw new TypeError('candidate parent must be an exact Git commit')
    const resolvedParent = (await this.git(['-C', this.repositoryPath, 'rev-parse', '--verify', `${request.parentHarnessRef}^{commit}`], signal)).stdout.toString('utf8').trim()
    if (resolvedParent !== request.parentHarnessRef) throw new Error('candidate parent ref did not resolve to its pinned exact commit')

    const evolutionRoot = resolve(this.options.rootForEvolution(request.evolutionId))
    await mkdir(evolutionRoot, { recursive: true, mode: 0o700 })
    const ownedRoot = await mkdtemp(join(evolutionRoot, 'workspace-'))
    const workspaceId = crypto.randomUUID()
    const worktreePath = join(ownedRoot, 'worktree')
    let added = false
    try {
      await this.git(['-C', this.repositoryPath, 'worktree', 'add', '--detach', worktreePath, resolvedParent], signal)
      added = true
      const targetPath = await realpath(join(worktreePath, ...this.targetRoot.split('/')))
      const handle: CandidateWorkspaceHandle = {
        workspaceId,
        evolutionId: request.evolutionId,
        roundId: request.roundId,
        parentRef: request.parentHarnessRef,
        parentDigest: request.parentHarnessDigest,
        worktreePath,
        targetPath,
        generation: ++this.generation,
        ownershipToken: crypto.randomUUID(),
        state: 'open',
      }
      await this.writeSidecar(handle)
      this.handles.set(workspaceId, handle)
      return handle
    } catch (error) {
      if (added) await this.git(['-C', this.repositoryPath, 'worktree', 'remove', '--force', worktreePath]).catch(() => {})
      await rm(ownedRoot, { recursive: true, force: true })
      throw error
    }
  }

  bind(workspaceId: string, metaSessionId: string): CandidateWorkspaceBinding {
    const handle = this.requireHandle(workspaceId)
    if (handle.state !== 'open') throw new Error(`candidate workspace is not open: ${workspaceId}`)
    const existing = this.bindings.get(metaSessionId)
    if (existing !== undefined) throw new Error(`Meta session already owns candidate workspace ${existing.workspaceId}`)
    const binding: CandidateWorkspaceBinding = {
      metaSessionId,
      evolutionId: handle.evolutionId,
      workspaceId,
      roundId: handle.roundId,
      generation: handle.generation,
    }
    this.bindings.set(metaSessionId, binding)
    return binding
  }

  resolve(metaSessionId: string): CandidateWorkspaceHandle {
    const binding = this.bindings.get(metaSessionId)
    if (binding === undefined) throw new Error('Meta session has no active candidate workspace')
    const handle = this.requireHandle(binding.workspaceId)
    if (handle.evolutionId !== binding.evolutionId || handle.roundId !== binding.roundId || handle.generation !== binding.generation) {
      throw new Error('candidate workspace binding identity mismatch')
    }
    if (handle.state === 'disposed') throw new Error('candidate workspace is disposed')
    return handle
  }

  unbind(metaSessionId: string, workspaceId: string): void {
    const binding = this.bindings.get(metaSessionId)
    if (binding === undefined) return
    if (binding.workspaceId !== workspaceId) throw new Error('refusing to unbind a different candidate workspace')
    this.bindings.delete(metaSessionId)
  }

  rotateBinding(workspaceId: string, sourceSessionId: string, successorSessionId: string): void {
    const handle = this.resolve(sourceSessionId)
    if (handle.workspaceId !== workspaceId || handle.state !== 'open'
      || (this.activeOperations.get(workspaceId) ?? 0) !== 0 || this.bindings.has(successorSessionId)) {
      throw new Error('candidate workspace is not quiescent for session rotation')
    }
    this.bindings.delete(sourceSessionId)
    handle.generation += 1
    this.bind(workspaceId, successorSessionId)
  }

  async withOpenWorkspace<T>(metaSessionId: string, mutation: boolean, callback: (handle: CandidateWorkspaceHandle) => Promise<T>): Promise<T> {
    const handle = this.resolve(metaSessionId)
    if (handle.state !== 'open') throw new Error(`candidate workspace does not accept operations in state ${handle.state}`)
    this.activeOperations.set(handle.workspaceId, (this.activeOperations.get(handle.workspaceId) ?? 0) + 1)
    try {
      if (mutation && handle.state !== 'open') throw new Error('candidate workspace is sealed')
      return await callback(handle)
    } finally {
      const remaining = (this.activeOperations.get(handle.workspaceId) ?? 1) - 1
      if (remaining === 0) this.activeOperations.delete(handle.workspaceId)
      else this.activeOperations.set(handle.workspaceId, remaining)
    }
  }

  async preflight(workspaceId: string, signal?: AbortSignal): Promise<CandidateDiffSummary> {
    const handle = this.requireHandle(workspaceId)
    if (handle.state !== 'open' && handle.state !== 'sealing' && handle.state !== 'sealed' && handle.state !== 'finalizing') {
      throw new Error(`candidate workspace cannot be inspected in state ${handle.state}`)
    }
    const head = (await this.git(['-C', handle.worktreePath, 'rev-parse', 'HEAD'], signal)).stdout.toString('utf8').trim()
    if (head !== handle.parentRef) throw new Error('candidate workspace HEAD no longer matches its exact parent')
    const staged = await this.git(['-C', handle.worktreePath, 'diff', '--cached', '--quiet', '--exit-code'], signal, new Set([0, 1]))
    if (staged.code !== 0) throw new Error('candidate workspace index must remain empty before finalization')
    const raw = (await this.git([
      '-C', handle.worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ], signal)).stdout
    const statusEntries = raw.toString('utf8').split('\0').filter(Boolean)
    const paths = new Set<string>()
    for (const entry of statusEntries) {
      const code = entry.slice(0, 2)
      if (code[0] !== ' ' && code[0] !== '?') throw new Error(`candidate workspace index was modified: ${entry.slice(0, 100)}`)
      const repositoryPath = entry.slice(3)
      const prefix = `${this.targetRoot}/`
      if (!repositoryPath.startsWith(prefix)) throw new Error(`candidate change escapes target root: ${repositoryPath}`)
      paths.add(validateArtifactPath(repositoryPath.slice(prefix.length)))
    }
    if (paths.size === 0) return { parentRef: handle.parentRef, files: [], totalBytes: 0, patchDigest: sha256('') }
    if (paths.size > this.options.maxFiles) throw new Error(`candidate changes ${paths.size} files, over limit ${this.options.maxFiles}`)

    const files: CandidateDiffFile[] = []
    const identity: string[] = []
    let totalBytes = 0
    let visibleDiffBytes = 0
    for (const path of [...paths].sort()) {
      const absolute = join(handle.targetPath, ...path.split('/'))
      if (!isContained(resolve(absolute), resolve(handle.targetPath))) throw new Error(`candidate path escapes target root: ${path}`)
      let after: Buffer | undefined
      try {
        const info = await lstat(absolute)
        if (info.isSymbolicLink()) throw new Error(`candidate path is a symlink: ${path}`)
        if (!info.isFile()) throw new Error(`candidate path is not a regular file: ${path}`)
        if (info.nlink > 1) throw new Error(`candidate path is a hardlink: ${path}`)
        const canonical = await realpath(absolute)
        const canonicalRoot = await realpath(handle.targetPath)
        if (!isContained(canonical, canonicalRoot)) throw new Error(`candidate path escapes target root: ${path}`)
        after = await readFile(absolute)
        if (after.includes(0)) throw new Error(`candidate file is binary: ${path}`)
        new TextDecoder('utf-8', { fatal: true }).decode(after)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const beforeResult = await this.git(['-C', handle.worktreePath, 'show', `${handle.parentRef}:${this.targetRoot}/${path}`], signal, new Set([0, 128]))
      const before = beforeResult.code === 0 ? beforeResult.stdout : undefined
      if (before === undefined && after === undefined) continue
      if (before?.includes(0)) throw new Error(`parent candidate file is binary: ${path}`)
      totalBytes += after?.byteLength ?? 0
      visibleDiffBytes += (before?.byteLength ?? 0) + (after?.byteLength ?? 0)
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const beforeText = before === undefined ? '' : decoder.decode(before)
      const afterText = after === undefined ? '' : decoder.decode(after)
      let additions = 0
      let deletions = 0
      for (const part of diffLines(beforeText, afterText)) {
        const lines = part.value.length === 0 ? 0 : part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0)
        if (part.added === true) additions += lines
        if (part.removed === true) deletions += lines
      }
      const change = before === undefined ? 'created' : after === undefined ? 'deleted' : 'modified'
      files.push({
        path, change, additions, deletions,
        ...(before === undefined ? {} : { bytesBefore: before.byteLength }),
        ...(after === undefined ? {} : { bytesAfter: after.byteLength }),
      })
      identity.push(`${change}\0${path}\0${before === undefined ? '-' : sha256(before)}\0${after === undefined ? '-' : sha256(after)}`)
    }
    if (totalBytes > this.options.maxBytes) throw new Error(`candidate content is ${totalBytes} bytes, over limit ${this.options.maxBytes}`)
    if (visibleDiffBytes > this.options.maxDiffBytes) throw new Error(`candidate diff basis is ${visibleDiffBytes} bytes, over limit ${this.options.maxDiffBytes}`)
    return { parentRef: handle.parentRef, files, totalBytes, patchDigest: sha256(identity.join('\n')) }
  }

  async seal(workspaceId: string, signal?: AbortSignal): Promise<CandidateDiffSummary> {
    const handle = this.requireHandle(workspaceId)
    if (handle.state !== 'open') throw new Error(`candidate workspace cannot seal from ${handle.state}`)
    handle.state = 'sealing'
    try {
      while ((this.activeOperations.get(workspaceId) ?? 0) > 0) {
        if (signal?.aborted === true) throw signal.reason
        await new Promise(resolveWait => setTimeout(resolveWait, 10))
      }
      const summary = await this.preflight(workspaceId, signal)
      handle.state = 'sealed'
      await this.writeSidecar(handle)
      return summary
    } catch (error) {
      handle.state = 'open'
      await this.writeSidecar(handle).catch(() => {})
      throw error
    }
  }

  async diff(workspaceId: string, maxBytes?: number, signal?: AbortSignal): Promise<{
    summary: CandidateDiffSummary
    patch: string
    truncated: boolean
  }> {
    const handle = this.requireHandle(workspaceId)
    const summary = await this.preflight(workspaceId, signal)
    const cap = Math.min(maxBytes ?? this.options.maxDiffBytes, this.options.maxDiffBytes)
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new TypeError('candidate diff maxBytes must be a positive integer')
    let patch = ''
    for (const file of summary.files) {
      const absolute = join(handle.targetPath, ...file.path.split('/'))
      let after = ''
      try { after = await readFile(absolute, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const beforeResult = await this.git(['-C', handle.worktreePath, 'show', `${handle.parentRef}:${this.targetRoot}/${file.path}`], signal, new Set([0, 128]))
      const before = beforeResult.code === 0 ? beforeResult.stdout.toString('utf8') : ''
      patch += createTwoFilesPatch(`a/harness/${file.path}`, `b/harness/${file.path}`, before, after, '', '', { context: 3 })
    }
    const raw = Buffer.from(patch)
    if (raw.byteLength <= cap) return { summary, patch, truncated: false }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let end = cap
    while (end > 0) {
      try { return { summary, patch: decoder.decode(raw.subarray(0, end)), truncated: true } } catch { end -= 1 }
    }
    return { summary, patch: '', truncated: true }
  }

  markFinalizing(workspaceId: string): void {
    const handle = this.requireHandle(workspaceId)
    if (handle.state !== 'sealed') throw new Error(`candidate workspace cannot finalize from ${handle.state}`)
    handle.state = 'finalizing'
  }

  async verifySealed(workspaceId: string, expected: CandidateDiffSummary, signal?: AbortSignal): Promise<CandidateDiffSummary> {
    const handle = this.requireHandle(workspaceId)
    if (handle.state !== 'finalizing') throw new Error(`candidate workspace is not finalizing: ${workspaceId}`)
    const actual = await this.preflight(workspaceId, signal)
    if (actual.parentRef !== expected.parentRef || actual.patchDigest !== expected.patchDigest) {
      throw new Error('candidate workspace changed after it was sealed')
    }
    return actual
  }

  async markCommitted(workspaceId: string): Promise<void> {
    const handle = this.requireHandle(workspaceId)
    if (handle.state !== 'finalizing') throw new Error(`candidate workspace cannot commit from ${handle.state}`)
    handle.state = 'committed'
    await this.writeSidecar(handle)
  }

  async dispose(workspaceId: string): Promise<void> {
    const handle = this.requireHandle(workspaceId)
    if (handle.state === 'disposed') return
    await this.drain(workspaceId)
    for (const [sessionId, binding] of this.bindings) {
      if (binding.workspaceId === workspaceId) this.bindings.delete(sessionId)
    }
    const ownedRoot = dirname(handle.worktreePath)
    const configuredRoot = resolve(this.options.rootForEvolution(handle.evolutionId))
    if (!isContained(resolve(ownedRoot), configuredRoot) || resolve(ownedRoot) === configuredRoot) {
      throw new Error('refusing to dispose candidate workspace outside its configured evolution root')
    }
    const sidecarPath = join(ownedRoot, 'workspace.json')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Record<string, unknown>
    if (sidecar.workspaceId !== handle.workspaceId || sidecar.evolutionId !== handle.evolutionId
      || sidecar.worktreePath !== handle.worktreePath || sidecar.ownershipToken !== handle.ownershipToken) {
      throw new Error('refusing to dispose candidate workspace with mismatched ownership sidecar')
    }
    await this.git(['-C', this.repositoryPath, 'worktree', 'remove', '--force', handle.worktreePath]).catch(() => {})
    await this.git(['-C', this.repositoryPath, 'worktree', 'prune']).catch(() => {})
    handle.state = 'disposed'
    this.handles.delete(workspaceId)
    await rm(ownedRoot, { recursive: true, force: true })
  }

  async drain(workspaceId: string): Promise<void> {
    this.requireHandle(workspaceId)
    while ((this.activeOperations.get(workspaceId) ?? 0) > 0) {
      await new Promise(resolveWait => setTimeout(resolveWait, 10))
    }
  }

  async restore(workspaceId: string, input: CandidateWorkspaceRequest): Promise<CandidateWorkspaceHandle> {
    safeId(workspaceId, 'workspaceId')
    safeId(input.evolutionId, 'evolutionId')
    const root = resolve(this.options.rootForEvolution(input.evolutionId))
    const matches: Array<{ ownedRoot: string; sidecar: CandidateWorkspaceHandle }> = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('workspace-')) continue
      const ownedRoot = join(root, entry.name)
      let sidecar: CandidateWorkspaceHandle
      try { sidecar = JSON.parse(await readFile(join(ownedRoot, 'workspace.json'), 'utf8')) as CandidateWorkspaceHandle }
      catch { continue }
      if (sidecar.workspaceId === workspaceId) matches.push({ ownedRoot, sidecar })
    }
    if (matches.length !== 1) throw new Error('candidate workspace recovery identity is missing or ambiguous')
    const { ownedRoot, sidecar } = matches[0]!
    if (sidecar.workspaceId !== workspaceId || sidecar.evolutionId !== input.evolutionId
      || sidecar.roundId !== input.roundId || sidecar.parentRef !== input.parentHarnessRef
      || sidecar.parentDigest !== input.parentHarnessDigest || sidecar.worktreePath !== join(ownedRoot, 'worktree')
      || sidecar.state !== 'open' || typeof sidecar.ownershipToken !== 'string') {
      throw new Error('candidate workspace recovery identity mismatch')
    }
    if ((await lstat(ownedRoot)).isSymbolicLink()
      || (await realpath(sidecar.worktreePath)) !== join(await realpath(ownedRoot), 'worktree')) {
      throw new Error('candidate recovery workspace is redirected')
    }
    const handle = { ...sidecar, targetPath: await realpath(join(sidecar.worktreePath, this.targetRoot)), generation: ++this.generation }
    this.handles.set(workspaceId, handle)
    try { await this.preflight(workspaceId) } catch (error) { this.handles.delete(workspaceId); throw error }
    return handle
  }

  async recoverOrphans(evolutionId: string, preservedWorkspaceIds: ReadonlySet<string> = new Set()): Promise<string[]> {
    safeId(evolutionId, 'evolutionId')
    const root = resolve(this.options.rootForEvolution(evolutionId))
    await mkdir(root, { recursive: true, mode: 0o700 })
    const recovered: string[] = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('workspace-')) continue
      const ownedRoot = join(root, entry.name)
      let sidecar: Record<string, unknown>
      try {
        sidecar = JSON.parse(await readFile(join(ownedRoot, 'workspace.json'), 'utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof sidecar.workspaceId !== 'string' || typeof sidecar.ownershipToken !== 'string'
        || sidecar.evolutionId !== evolutionId || sidecar.worktreePath !== join(ownedRoot, 'worktree')
        || !isContained(resolve(String(sidecar.worktreePath)), root)) {
        continue
      }
      if (this.handles.has(sidecar.workspaceId)) continue
      if (preservedWorkspaceIds.has(sidecar.workspaceId)) continue
      await this.git(['-C', this.repositoryPath, 'worktree', 'remove', '--force', String(sidecar.worktreePath)]).catch(() => {})
      await rm(ownedRoot, { recursive: true, force: true })
      recovered.push(sidecar.workspaceId)
    }
    await this.git(['-C', this.repositoryPath, 'worktree', 'prune']).catch(() => {})
    return recovered.sort()
  }

  private requireHandle(workspaceId: string): CandidateWorkspaceHandle {
    const handle = this.handles.get(workspaceId)
    if (handle === undefined) throw new Error(`unknown candidate workspace: ${workspaceId}`)
    return handle
  }

  private async writeSidecar(handle: CandidateWorkspaceHandle): Promise<void> {
    const path = join(dirname(handle.worktreePath), 'workspace.json')
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    const value = {
      schemaVersion: 1,
      workspaceId: handle.workspaceId,
      evolutionId: handle.evolutionId,
      roundId: handle.roundId,
      parentRef: handle.parentRef,
      parentDigest: handle.parentDigest,
      worktreePath: handle.worktreePath,
      generation: handle.generation,
      state: handle.state,
      ownershipToken: handle.ownershipToken,
    }
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  }

  private async git(
    args: string[],
    signal?: AbortSignal,
    allowedCodes = new Set([0]),
  ): Promise<CommandResult> {
    const child = spawn(this.gitExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const cap = Math.max(this.options.maxBytes * 2, this.options.maxDiffBytes * 2, 1024 * 1024)
    let outputBytes = 0
    let outputError: Error | undefined
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > cap) {
        outputError ??= new Error(`git output exceeded the ${cap} byte safety limit`)
        child.kill('SIGKILL')
      } else target.push(chunk)
    }
    child.stdout.on('data', chunk => collect(stdout, Buffer.from(chunk)))
    child.stderr.on('data', chunk => collect(stderr, Buffer.from(chunk)))
    const code = await new Promise<number>((resolveCode, reject) => {
      child.once('error', reject)
      child.once('close', value => resolveCode(value ?? -1))
    })
    if (outputError !== undefined) throw outputError
    const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code }
    if (!allowedCodes.has(code)) {
      throw new Error(`git ${args[0] ?? ''} failed (${code}): ${result.stderr.toString('utf8').slice(0, 4000)}`)
    }
    return result
  }
}

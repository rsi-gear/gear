import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FsDirEntry, type FsEditOutcome, type FsEditRequest, type FsInfo, type FsPathInfo, type FsTarget, type FsWriteIntent, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { lstat as hostLstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CandidateWorkspaceManager } from './workspace.js'

const VIRTUAL_ROOT = '/candidate/harness'
const ALLOWED_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])
const PROTECTED_NAMES = new Set(['manifest.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.git'])

function contained(path: string, root: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function virtualPath(relativePath: string): string {
  return relativePath.length === 0 ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${relativePath.split(sep).join('/')}`
}

/**
 * A session-bound adapter around DSH's public local filesystem provider. DSH
 * retains its native read/write/edit schemas and atomic observation protocol;
 * this layer supplies the candidate identity and containment boundary.
 */
export class CandidateFileSystem extends LocalFileSystem {
  constructor(
    ctx: Context,
    private readonly manager: CandidateWorkspaceManager,
    private readonly metaSessionId: string,
    private readonly maxReadBytes: number,
  ) {
    super(ctx, { cwd: VIRTUAL_ROOT, diffBasisMaxBytes: maxReadBytes })
  }

  override get sandboxMode(): 'workspace-write' { return 'workspace-write' }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const { root, physical, relativePath } = this.map(path)
    await this.assertNoLinks(root, physical)
    const target = await super.resolve(physical, opts?.signal === undefined ? undefined : { signal: opts.signal })
    const canonical = super.processPath(target)
    if (!contained(canonical, root)) throw new FsError('candidate path escapes the active workspace', 'FS_PERMISSION_DENIED')
    return { targetKey: target.targetKey, displayPath: virtualPath(relativePath) }
  }

  override async lstat(path: string, _opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const { root, physical } = this.map(path)
    await this.assertNoLinks(root, physical)
    return super.lstat(physical, undefined, signal)
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(virtualPath(this.assertTarget(target))).href
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.assertTarget(target)
    return super.stat(target, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.assertReadable(target, signal)
    return super.readText(target, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.assertReadable(target, signal)
    return super.streamText(target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    await this.assertReadable(target, signal)
    return super.readBytes(target, signal, Math.min(maxBytes, this.maxReadBytes))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const relativeParent = this.assertTarget(target)
    const entries = await super.listDir(target, signal)
    return entries.filter(entry => {
      if (PROTECTED_NAMES.has(entry.name)) return false
      return relativeParent.length !== 0 || ALLOWED_ROOTS.has(entry.name)
    }).map(entry => {
      const relativePath = relativeParent.length === 0 ? entry.name : join(relativeParent, entry.name)
      return { ...entry, target: { targetKey: entry.target.targetKey, displayPath: virtualPath(relativePath) } }
    })
  }

  override writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    this.assertTarget(target)
    this.assertTextBound(content)
    void sandboxPolicy
    return this.manager.withOpenWorkspace(this.metaSessionId, true, () => super.writeText(target, content, expected, signal))
  }

  override editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: import('@deepseek-ai/dsh-fs').FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    this.assertTarget(target)
    this.assertTextBound(edit.oldString)
    this.assertTextBound(edit.newString)
    void sandboxPolicy
    return this.manager.withOpenWorkspace(this.metaSessionId, true, async () => {
      const current = await super.readText(target, signal)
      const occurrences = edit.replaceAll ? current.split(edit.oldString).length - 1 : 1
      const projectedBytes = Buffer.byteLength(current, 'utf8')
        + occurrences * (Buffer.byteLength(edit.newString, 'utf8') - Buffer.byteLength(edit.oldString, 'utf8'))
      if (projectedBytes > this.manager.options.maxBytes) {
        throw new FsError(`candidate edit exceeds ${this.manager.options.maxBytes} bytes`, 'FS_TOO_LARGE')
      }
      return super.editText(target, edit, expected, signal)
    })
  }

  private map(input: string): { root: string; physical: string; relativePath: string } {
    const handle = this.manager.resolve(this.metaSessionId)
    let path = input.trim()
    if (path.length === 0) throw new FsError('file_path must be non-empty', 'FS_NOT_FOUND')
    if (path === '/candidate' || path === VIRTUAL_ROOT) path = '.'
    else if (path.startsWith(`${VIRTUAL_ROOT}/`)) path = path.slice(VIRTUAL_ROOT.length + 1)
    else if (isAbsolute(path)) throw new FsError('absolute host paths are unavailable in the candidate workspace', 'FS_PERMISSION_DENIED')
    // Native grep/glob can return ./-prefixed paths when searching ".".
    path = path.replace(/^(?:\.\/)+/u, '') || '.'
    const segments = path === '.' ? [] : path.split(/[\\/]/u)
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new FsError('candidate path must be normalized and cannot traverse parents', 'FS_PERMISSION_DENIED')
    }
    if (segments.length > 0 && !ALLOWED_ROOTS.has(segments[0]!)) {
      throw new FsError(`candidate path is fixed substrate: ${path}`, 'FS_PERMISSION_DENIED')
    }
    if (segments.some(segment => PROTECTED_NAMES.has(segment))) {
      throw new FsError(`candidate path is protected: ${path}`, 'FS_PERMISSION_DENIED')
    }
    const root = resolve(handle.targetPath)
    const physical = resolve(root, ...segments)
    if (!contained(physical, root)) throw new FsError('candidate path escapes the active workspace', 'FS_PERMISSION_DENIED')
    return { root, physical, relativePath: segments.join(sep) }
  }

  private assertTarget(target: FsTarget): string {
    const handle = this.manager.resolve(this.metaSessionId)
    const root = resolve(handle.targetPath)
    const physical = super.processPath(target)
    if (!contained(physical, root)) throw new FsError('stale or foreign candidate target', 'FS_PERMISSION_DENIED')
    const offset = relative(root, physical)
    const segments = offset === '' ? [] : offset.split(sep)
    if (segments.length > 0 && (!ALLOWED_ROOTS.has(segments[0]!) || segments.some(part => PROTECTED_NAMES.has(part)))) {
      throw new FsError('candidate target is protected', 'FS_PERMISSION_DENIED')
    }
    return offset
  }

  private async assertReadable(target: FsTarget, signal?: AbortSignal): Promise<void> {
    this.assertTarget(target)
    const info = await super.stat(target, signal)
    if (info?.type === 'file' && info.size !== undefined && info.size > this.maxReadBytes) {
      throw new FsError(`candidate file exceeds ${this.maxReadBytes} bytes`, 'FS_TOO_LARGE')
    }
  }

  private async assertNoLinks(root: string, target: string): Promise<void> {
    if (target === root) return
    const parts = relative(root, target).split(sep)
    let current = root
    for (const part of parts) {
      current = join(current, part)
      try {
        const info = await hostLstat(current)
        if (info.isSymbolicLink()) throw new FsError('symlinks are forbidden in candidate paths', 'FS_PERMISSION_DENIED')
        if (info.isFile() && info.nlink > 1) throw new FsError('hardlinks are forbidden in candidate paths', 'FS_PERMISSION_DENIED')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (dirname(current) === current) break
    }
  }

  private assertTextBound(content: string): void {
    if (content.includes('\0')) throw new FsError('NUL bytes are forbidden in candidate text', 'FS_NOT_TEXT')
    if (Buffer.byteLength(content, 'utf8') > this.manager.options.maxBytes) {
      throw new FsError(`candidate file exceeds ${this.manager.options.maxBytes} bytes`, 'FS_TOO_LARGE')
    }
  }
}

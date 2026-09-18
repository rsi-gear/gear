import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CandidateWorkspaceManager } from '../candidate/workspace.js'

const VIRTUAL_ROOT = '/candidate/harness'
const ALLOWED_ROOTS = new Set(['preset', 'plugins', 'prompts', 'skills', 'workflows'])
const PROTECTED_NAMES = new Set(['manifest.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.git'])

function digest(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function contained(path: string, root: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

function virtualPath(path: string): string {
  return path.length === 0 ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${path.split(sep).join('/')}`
}

interface ResolvedCandidatePath {
  root: string
  physical: string
  relativePath: string
}

export interface SkillFileOptions {
  maxReadBytes: number
  maxTreeEntries?: number
}

/** Safe filesystem surface used by non-DSH Meta harnesses. */
export class SkillCandidateFiles {
  private readonly maxTreeEntries: number

  constructor(
    private readonly manager: CandidateWorkspaceManager,
    private readonly options: SkillFileOptions,
  ) {
    this.maxTreeEntries = options.maxTreeEntries ?? 2_000
  }

  async read(sessionId: string, path: string): Promise<{ path: string; text: string; bytes: number; digest: string }> {
    return this.manager.withOpenWorkspace(sessionId, false, async handle => {
      const target = await this.resolve(handle.targetPath, path)
      const info = await lstat(target.physical)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('candidate path is not a regular owned file')
      if (info.size > this.options.maxReadBytes) throw new Error(`candidate file exceeds ${this.options.maxReadBytes} bytes`)
      const content = await readFile(target.physical)
      if (content.includes(0)) throw new Error('candidate file is not text')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
      return { path: virtualPath(target.relativePath), text, bytes: content.byteLength, digest: digest(content) }
    })
  }

  async tree(sessionId: string, path = '.'): Promise<{ root: string; entries: Array<{ path: string; type: 'file' | 'directory'; bytes?: number; digest?: string }> }> {
    return this.manager.withOpenWorkspace(sessionId, false, async handle => {
      const target = await this.resolve(handle.targetPath, path)
      const entries: Array<{ path: string; type: 'file' | 'directory'; bytes?: number; digest?: string }> = []
      const visit = async (physical: string, relativePath: string): Promise<void> => {
        const children = await readdir(physical, { withFileTypes: true })
        for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
          if (PROTECTED_NAMES.has(child.name)) continue
          if (relativePath.length === 0 && !ALLOWED_ROOTS.has(child.name)) continue
          const childRelative = relativePath.length === 0 ? child.name : join(relativePath, child.name)
          if (childRelative.split(sep).some(segment => PROTECTED_NAMES.has(segment))) continue
          if (entries.length >= this.maxTreeEntries) throw new Error(`candidate tree exceeds ${this.maxTreeEntries} entries`)
          const childPhysical = join(physical, child.name)
          const info = await lstat(childPhysical)
          if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error(`links are forbidden in candidate paths: ${childRelative}`)
          if (info.isDirectory()) {
            entries.push({ path: virtualPath(childRelative), type: 'directory' })
            await visit(childPhysical, childRelative)
          } else if (info.isFile()) {
            const content = info.size <= this.options.maxReadBytes ? await readFile(childPhysical) : undefined
            entries.push({
              path: virtualPath(childRelative),
              type: 'file',
              bytes: info.size,
              ...(content === undefined ? {} : { digest: digest(content) }),
            })
          }
        }
      }
      const info = await lstat(target.physical)
      if (info.isFile()) {
        const content = await readFile(target.physical)
        entries.push({ path: virtualPath(target.relativePath), type: 'file', bytes: info.size, digest: digest(content) })
      } else if (info.isDirectory()) await visit(target.physical, target.relativePath)
      else throw new Error('candidate path is not a regular file or directory')
      return { root: virtualPath(target.relativePath), entries }
    })
  }

  write(
    sessionId: string,
    path: string,
    text: string,
    expectedDigest: string | null,
  ): Promise<{ path: string; bytes: number; digest: string }> {
    return this.manager.withOpenWorkspace(sessionId, true, async handle => {
      this.assertText(text)
      const target = await this.resolve(handle.targetPath, path, true)
      const existing = await this.existingDigest(target.physical)
      if (expectedDigest === null ? existing !== undefined : existing !== expectedDigest) {
        throw new Error('candidate file changed since it was observed')
      }
      const mode = existing === undefined ? undefined : (await lstat(target.physical)).mode & 0o777
      await mkdir(dirname(target.physical), { recursive: true, mode: 0o700 })
      await this.assertNoLinks(target.root, dirname(target.physical))
      const canonicalParent = await realpath(dirname(target.physical))
      if (!contained(canonicalParent, target.root)) throw new Error('candidate path escapes the active workspace')
      const temporary = `${target.physical}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(text, 'utf8')
          if (mode !== undefined) await file.chmod(mode)
          await file.sync()
        } finally { await file.close() }
        const current = await this.existingDigest(target.physical)
        if (expectedDigest === null ? current !== undefined : current !== expectedDigest) {
          throw new Error('candidate file changed while it was being written')
        }
        await rename(temporary, target.physical)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      const bytes = Buffer.byteLength(text)
      return { path: virtualPath(target.relativePath), bytes, digest: digest(text) }
    })
  }

  async edit(
    sessionId: string,
    path: string,
    oldString: string,
    newString: string,
    expectedDigest: string,
    replaceAll = false,
  ): Promise<{ path: string; bytes: number; digest: string; replacements: number }> {
    if (oldString.length === 0) throw new TypeError('oldString must be non-empty')
    const observed = await this.read(sessionId, path)
    if (observed.digest !== expectedDigest) throw new Error('candidate file changed since it was observed')
    const occurrences = observed.text.split(oldString).length - 1
    if (occurrences === 0) throw new Error('oldString was not found in the candidate file')
    if (!replaceAll && occurrences !== 1) throw new Error('oldString is not unique; set replaceAll or provide more context')
    const text = replaceAll ? observed.text.split(oldString).join(newString) : observed.text.replace(oldString, () => newString)
    const written = await this.write(sessionId, path, text, expectedDigest)
    return { ...written, replacements: replaceAll ? occurrences : 1 }
  }

  remove(sessionId: string, path: string, expectedDigest: string): Promise<{ path: string; removed: true }> {
    return this.manager.withOpenWorkspace(sessionId, true, async handle => {
      const target = await this.resolve(handle.targetPath, path)
      const existing = await this.existingDigest(target.physical)
      if (existing !== expectedDigest) throw new Error('candidate file changed since it was observed')
      const info = await lstat(target.physical)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('candidate path is not a regular owned file')
      await rm(target.physical)
      return { path: virtualPath(target.relativePath), removed: true }
    })
  }

  private async resolve(rootInput: string, input: string, allowMissing = false): Promise<ResolvedCandidatePath> {
    const root = await realpath(rootInput)
    let path = input.trim()
    if (path === '' || path === '.' || path === '/candidate' || path === VIRTUAL_ROOT) path = '.'
    else if (path.startsWith(`${VIRTUAL_ROOT}/`)) path = path.slice(VIRTUAL_ROOT.length + 1)
    else if (isAbsolute(path)) throw new Error('absolute host paths are unavailable in the candidate workspace')
    path = path.replace(/^(?:\.\/)+/u, '') || '.'
    const segments = path === '.' ? [] : path.split(/[\\/]/u)
    if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) throw new Error('candidate path must be normalized')
    if (segments.length > 0 && !ALLOWED_ROOTS.has(segments[0]!)) throw new Error(`candidate path is fixed substrate: ${path}`)
    if (segments.some(segment => PROTECTED_NAMES.has(segment))) throw new Error(`candidate path is protected: ${path}`)
    const physical = resolve(root, ...segments)
    if (!contained(physical, root)) throw new Error('candidate path escapes the active workspace')
    await this.assertNoLinks(root, allowMissing ? dirname(physical) : physical)
    return { root, physical, relativePath: segments.join(sep) }
  }

  private async assertNoLinks(root: string, target: string): Promise<void> {
    if (target === root) return
    const offset = relative(root, target)
    if (!contained(target, root)) throw new Error('candidate path escapes the active workspace')
    let current = root
    for (const part of offset.split(sep)) {
      current = join(current, part)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error('links are forbidden in candidate paths')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
    }
  }

  private async existingDigest(path: string): Promise<string | undefined> {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('candidate path is not a regular owned file')
      return digest(await readFile(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private assertText(text: string): void {
    if (text.includes('\0')) throw new Error('NUL bytes are forbidden in candidate text')
    if (Buffer.byteLength(text) > this.manager.options.maxBytes) throw new Error(`candidate file exceeds ${this.manager.options.maxBytes} bytes`)
  }
}

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { HarnessManifest } from '../types.js'

const execute = promisify(execFile)
const digest = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

export async function createCheckSnapshot(worktree: string, targetRoot: string, manifest: HarnessManifest, signal: AbortSignal, runtimeRoot: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gear-runtime-check-')))
  const repository = join(root, 'repository')
  const writable = join(root, 'writable')
  const home = join(writable, 'home')
  const copied = new Map<string, string>()
  try {
    // Git supplies the fixed carrier tree; manifest supplies all current artifact
    // bytes, including untracked additions and deletions. No Git metadata, host
    // dotfiles, or ignored dependency trees enter the disposable repository.
    const { stdout } = await execute('git', ['-C', worktree, 'ls-files', '-z'], { signal, maxBuffer: 8 * 1024 * 1024 })
    const paths = new Set(stdout.split('\0').filter(path => path && !path.startsWith(`${targetRoot}/`)))
    for (const artifact of manifest.artifacts) paths.add(`${targetRoot}/${artifact.path}`)
    for (const path of paths) {
      signal.throwIfAborted()
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => ['', '.', '..', '.git', 'node_modules'].includes(part))) {
        throw new Error(`unsupported snapshot path: ${path}`)
      }
      const source = join(worktree, path)
      if (!(await lstat(source)).isFile()) throw new Error(`snapshot requires a regular file: ${path}`)
      const content = await readFile(source)
      const artifact = manifest.artifacts.find(item => `${targetRoot}/${item.path}` === path)
      if (artifact && (artifact.bytes !== content.byteLength || artifact.digest !== digest(content))) {
        throw new Error(`candidate changed while copying: ${path}`)
      }
      await mkdir(dirname(join(repository, path)), { recursive: true })
      await writeFile(join(repository, path), content)
      copied.set(path, digest(content))
    }
    await mkdir(join(repository, targetRoot), { recursive: true })
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    await writeFile(join(repository, targetRoot, 'manifest.json'), manifestBytes)
    copied.set(`${targetRoot}/manifest.json`, digest(manifestBytes))
    await mkdir(join(home, 'profiles', 'node_modules'), { recursive: true })
    await mkdir(join(writable, 'workspace'), { recursive: true })
    await mkdir(join(writable, 'tmp'), { recursive: true })
    // Candidate imports resolve against the Target installation, including its
    // pnpm visibility boundaries. The recursive DSH profile fallback belongs to
    // the profile only: exposing it here makes transitive imports falsely pass.
    const modules = await realpath(join(runtimeRoot, 'node_modules'))
    await symlink(modules, join(repository, 'node_modules'), 'dir')
    const verify = async (): Promise<void> => {
      if (!(await lstat(join(repository, 'node_modules'))).isSymbolicLink()
        || await realpath(join(repository, 'node_modules')) !== modules) {
        throw new Error('SNAPSHOT_CHANGED_DURING_CHECK: node_modules')
      }
      const seen = new Set<string>()
      const visit = async (directory: string, prefix = ''): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = prefix + entry.name
          if (path === 'node_modules') continue
          if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`)
          else {
            if (!entry.isFile() || !copied.has(path) || digest(await readFile(join(directory, entry.name))) !== copied.get(path)) {
              throw new Error(`SNAPSHOT_CHANGED_DURING_CHECK: ${path}`)
            }
            seen.add(path)
          }
        }
      }
      await visit(repository)
      if (seen.size !== copied.size) throw new Error('SNAPSHOT_CHANGED_DURING_CHECK: files were removed')
    }
    return { root, repository, writable, home, verify }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

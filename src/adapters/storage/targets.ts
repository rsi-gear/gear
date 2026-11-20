import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
  mkdtemp,
  rename,
  rm,
  open,
} from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { materialPath } from '../../domain/material-path.js'
import { assertMutationPath, mutationPolicyDigest } from '../../domain/mutation-policy.js'
import type { TargetManifest, TargetResource } from '../../domain/target.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import { publishFile, syncDirectory } from './atomic.js'

export function targetManifest(
  adapter: HarnessAdapter,
  runtimeIdentity: string,
  baseRef: string,
  resources: TargetResource[],
): TargetManifest {
  const body = {
    version: 2 as const,
    adapterRef: adapter.describe().adapterRef,
    runtimeIdentity,
    baseRef,
    mutationPolicyDigest: mutationPolicyDigest(adapter.mutationPolicy),
    resources,
  }
  return { ...body, digest: canonicalDigest(body) }
}

/** Walk the exact runnable resource tree; links and unbounded trees are never sealed. */
export async function targetResources(root: string): Promise<TargetResource[]> {
  const result: TargetResource[] = []
  let bytes = 0
  const walk = async (path: string): Promise<void> => {
    const info = await lstat(join(root, path))
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1))
      throw new GearError('target-link-forbidden', 'Target resources cannot contain links')
    if (info.isDirectory()) {
      for (const entry of await readdir(join(root, path))) {
        if (entry === '.git') continue
        if (entry === 'node_modules')
          throw new GearError(
            'target-dependency-forbidden',
            'Target dependencies belong to its fixed runtime',
          )
        await walk(path ? `${path}/${entry}` : entry)
      }
    } else if (info.isFile()) {
      bytes += info.size
      if (bytes > 64 * 1024 * 1024 || result.length >= 4096)
        throw new GearError('target-too-large', 'Target exceeds 4096 files or 64 MiB')
      const content = await readFile(join(root, path))
      result.push({
        path,
        digest: canonicalDigest(content.toString('base64')),
        executable: Boolean(info.mode & 0o111),
      })
    } else throw new GearError('target-special-file', 'Only regular files and directories are allowed')
  }
  await walk('')
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export async function snapshotTarget(source: string, destination: string): Promise<TargetResource[]> {
  const resources = await targetResources(source)
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const resource of resources) {
    const path = join(destination, resource.path)
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
    await writeFile(path, await readFile(join(source, resource.path)), {
      flag: 'wx',
      mode: resource.executable ? 0o500 : 0o400,
    })
  }
  if (canonicalDigest(await targetResources(destination)) !== canonicalDigest(resources))
    throw new GearError(
      'target-changed-during-snapshot',
      'Target changed while its snapshot was being frozen',
    )
  return resources
}

export class TargetStore {
  constructor(
    readonly runRoot: string,
    readonly adapter: HarnessAdapter,
    readonly runtimeIdentity: string,
  ) {}
  path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new GearError('invalid-candidate-id', 'Invalid candidate ID')
    return join(this.runRoot, 'targets', id)
  }
  private manifestPath(id: string): string {
    this.path(id)
    return join(this.runRoot, 'target-manifests', `${id}.json`)
  }
  /** Deterministic exact construction; a crash after rename resumes by verifying the same bytes. */
  async materialize(
    id: string,
    parentId: string,
    files: Record<string, { content: string; encoding: 'base64'; executable: boolean }>,
  ): Promise<TargetManifest> {
    const destination = this.path(id),
      parent = await this.verify(parentId)
    const resources: TargetResource[] = []
    let total = 0
    for (const [path, file] of Object.entries(files)) {
      materialPath(path)
      if (path.split('/').some((part) => ['.git', 'node_modules'].includes(part)))
        throw new GearError('invalid-material-path', 'Invalid candidate file path')
      const bytes = Buffer.from(file.content, 'base64')
      if (
        file.encoding !== 'base64' ||
        bytes.toString('base64') !== file.content ||
        typeof file.executable !== 'boolean'
      )
        throw new GearError('invalid-material-file', 'Expected canonical regular file content')
      total += bytes.length
      if (bytes.length > 1024 * 1024 || total > 16 * 1024 * 1024 || resources.length >= 4096)
        throw new GearError('material-too-large', 'Candidate exceeds its file resource budget')
      resources.push({ path, digest: canonicalDigest(file.content), executable: file.executable })
    }
    resources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const before = new Map(parent.resources.map((file) => [file.path, file])),
      after = new Map(resources.map((file) => [file.path, file]))
    for (const path of new Set([...before.keys(), ...after.keys()]))
      if (canonicalDigest(before.get(path) ?? null) !== canonicalDigest(after.get(path) ?? null)) {
        try {
          assertMutationPath(path, this.adapter.mutationPolicy)
        } catch {
          throw new GearError(
            'candidate-mutation-rejected',
            'The edit changes a protected or fixed target resource',
          )
        }
      }
    const manifest = targetManifest(this.adapter, this.runtimeIdentity, parent.baseRef, resources)
    try {
      const existing = await this.verify(id)
      if (existing.digest !== manifest.digest)
        throw new GearError('candidate-construction-conflict', 'Candidate ID already has different material')
      return existing
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const targetRoot = join(this.runRoot, 'targets')
    await mkdir(targetRoot, { recursive: true, mode: 0o700 })
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    const check = async (path: string) => {
      try {
        await this.adapter.check(path)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code && code !== 'ENOENT') throw error
        throw new GearError(
          'candidate-harness-rejected',
          'The edited candidate failed the harness resource checks',
        )
      }
    }
    if (existing) {
      if (
        existing.isSymbolicLink() ||
        canonicalDigest(await targetResources(destination)) !== canonicalDigest(resources)
      )
        throw new GearError('candidate-construction-conflict', 'Interrupted candidate has different material')
      await check(destination)
    } else {
      const stage = await mkdtemp(join(targetRoot, '.edits-'))
      try {
        const directories = new Set([stage])
        for (const [path, file] of Object.entries(files)) {
          await mkdir(join(stage, path, '..'), { recursive: true, mode: 0o700 })
          for (let parent = dirname(join(stage, path)); parent !== stage; parent = dirname(parent))
            directories.add(parent)
          const handle = await open(join(stage, path), 'wx', file.executable ? 0o500 : 0o400)
          try {
            await handle.writeFile(Buffer.from(file.content, 'base64'))
            await handle.sync()
          } finally {
            await handle.close()
          }
        }
        await check(stage)
        if (canonicalDigest(await targetResources(stage)) !== canonicalDigest(resources))
          throw new GearError('candidate-construction-conflict', 'Candidate changed during validation')
        for (const directory of [...directories].sort((a, b) => b.length - a.length))
          await syncDirectory(directory)
        await rename(stage, destination)
        await syncDirectory(targetRoot)
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
    }
    await publishFile(this.manifestPath(id), JSON.stringify(manifest), { immutable: true })
    return manifest
  }
  async seal(id: string, baseRef: string, parentId?: string): Promise<TargetManifest> {
    const resources = await targetResources(this.path(id))
    if (parentId) {
      const parent = await this.verify(parentId)
      const before = new Map(parent.resources.map((resource) => [resource.path, resource]))
      const after = new Map(resources.map((resource) => [resource.path, resource]))
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        if (canonicalDigest(before.get(path) ?? null) !== canonicalDigest(after.get(path) ?? null))
          assertMutationPath(path, this.adapter.mutationPolicy)
      }
      baseRef = parent.baseRef
    }
    await this.adapter.check(this.path(id))
    const manifest = targetManifest(this.adapter, this.runtimeIdentity, baseRef, resources)
    for (const resource of resources)
      await chmod(join(this.path(id), resource.path), resource.executable ? 0o500 : 0o400)
    await publishFile(this.manifestPath(id), JSON.stringify(manifest), { immutable: true })
    return manifest
  }
  async verify(id: string): Promise<TargetManifest> {
    const manifest = JSON.parse(await readFile(this.manifestPath(id), 'utf8')) as TargetManifest
    const { digest, ...body } = manifest
    if (
      manifest.version !== 2 ||
      canonicalDigest(body) !== digest ||
      canonicalDigest(manifest.resources) !== canonicalDigest(await targetResources(this.path(id))) ||
      canonicalDigest(manifest.adapterRef) !== canonicalDigest(this.adapter.describe().adapterRef) ||
      manifest.runtimeIdentity !== this.runtimeIdentity ||
      manifest.mutationPolicyDigest !== mutationPolicyDigest(this.adapter.mutationPolicy)
    )
      throw new GearError(
        'target-identity-mismatch',
        `Frozen target ${id} or its execution conditions changed`,
      )
    return manifest
  }
}

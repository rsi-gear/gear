import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import { assertMutationPath, mutationPolicyDigest } from '../../domain/mutation-policy.js'
import type { TargetManifest, TargetResource } from '../../domain/target.js'
import type { HarnessAdapter } from '../../ports/harness.js'
import { publishFile } from './atomic.js'

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

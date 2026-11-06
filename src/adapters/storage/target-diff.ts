import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { formatPatch, structuredPatch } from 'diff'
import type { Candidate } from '../../domain/algorithm-wire.js'
import type { TargetResource } from '../../domain/target.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { TargetStore } from './targets.js'

export interface TargetFileChange {
  path: string
  change: 'added' | 'removed' | 'modified'
  before: Omit<TargetResource, 'path'> | null
  after: Omit<TargetResource, 'path'> | null
  patch: string | null
  patch_status: 'included' | 'unchanged' | 'binary' | 'too-large' | 'budget-exhausted' | 'too-complex'
}

/** Bounded display projection; it never alters or substitutes the complete sealed resources. */
export async function targetDiff(store: TargetStore, from: Candidate, to: Candidate) {
  const verify = async (candidate: Candidate) => {
    const manifest = await store.verify(candidate.id)
    if (manifest.digest !== candidate.digest)
      throw new GearError('target-identity-mismatch', 'Report target differs from its saved candidate')
    return manifest
  }
  const before = await verify(from)
  const after = from.id === to.id && from.digest === to.digest ? before : await verify(to)
  const oldFiles = new Map(before.resources.map((resource) => [resource.path, resource]))
  const newFiles = new Map(after.resources.map((resource) => [resource.path, resource]))
  const files: TargetFileChange[] = []
  let remainingBytes = 128 * 1024
  const read = async (id: string, resource?: TargetResource): Promise<Buffer> => {
    if (!resource) return Buffer.alloc(0)
    const file = await open(join(store.path(id), resource.path), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1)
        throw new GearError('target-link-forbidden', 'Report target resources must be regular files')
      const bytes = await file.readFile()
      if (
        canonicalDigest(bytes.toString('base64')) !== resource.digest ||
        Boolean(info.mode & 0o111) !== resource.executable
      )
        throw new GearError('target-identity-mismatch', 'Target changed while preparing its report')
      return bytes
    } finally {
      await file.close()
    }
  }
  const metadata = (resource?: TargetResource) =>
    resource ? { digest: resource.digest, executable: resource.executable } : null
  const text = (bytes: Buffer): string | null => {
    if (bytes.includes(0)) return null
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return null
    }
  }
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const oldFile = oldFiles.get(path),
      newFile = newFiles.get(path)
    if (canonicalDigest(oldFile ?? null) === canonicalDigest(newFile ?? null)) continue
    const change: TargetFileChange = {
      path,
      change: !oldFile ? 'added' : !newFile ? 'removed' : 'modified',
      before: metadata(oldFile),
      after: metadata(newFile),
      patch: null,
      patch_status: 'unchanged',
    }
    files.push(change)
    if (oldFile?.digest === newFile?.digest) continue
    const oldBytes = await read(from.id, oldFile),
      newBytes = await read(to.id, newFile)
    if (oldBytes.length > 64 * 1024 || newBytes.length > 64 * 1024) {
      change.patch_status = 'too-large'
      continue
    }
    const oldText = text(oldBytes),
      newText = text(newBytes)
    if (oldText === null || newText === null) {
      change.patch_status = 'binary'
      continue
    }
    if (!remainingBytes) {
      change.patch_status = 'budget-exhausted'
      continue
    }
    const patch = structuredPatch(
      oldFile ? JSON.stringify(`a/${path}`) : '/dev/null',
      newFile ? JSON.stringify(`b/${path}`) : '/dev/null',
      oldText,
      newText,
      undefined,
      undefined,
      { context: 3, maxEditLength: 2000 },
    )
    if (!patch) {
      change.patch_status = 'too-complex'
      continue
    }
    const formatted = formatPatch(patch),
      size = Buffer.byteLength(formatted)
    if (size > remainingBytes) {
      change.patch_status = 'budget-exhausted'
      continue
    }
    change.patch = formatted
    change.patch_status = 'included'
    remainingBytes -= size
  }
  return {
    from: { id: from.id, digest: from.digest },
    to: { id: to.id, digest: to.digest },
    files,
    omitted_patches: files.filter((file) => !['included', 'unchanged'].includes(file.patch_status)).length,
  }
}

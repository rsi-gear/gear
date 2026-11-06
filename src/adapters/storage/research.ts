import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import {
  researchArchive,
  type ResearchArchive,
  type ResearchObject,
  type ResearchPack,
} from '../../domain/research.js'
import type { RunJournal } from '../../domain/run.js'
import { publishFile, syncDirectory } from './atomic.js'

const encoded = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  )

async function bounded<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = []
  for (let index = 0; index < items.length; index += 16) {
    const results = await Promise.allSettled(items.slice(index, index + 16).map(action))
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      output.push(result.value)
    }
  }
  return output
}

/** Immutable, content-addressed seed archive. Uncommitted objects have no journal reference. */
export class ResearchStore {
  constructor(readonly root: string) {}
  private path(kind: 'packs' | 'snapshots', digest: string) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new GearError('invalid-research-digest', 'Invalid research archive digest')
    return join(this.root, kind, digest.slice(7) + '.json')
  }
  private async read<T extends { digest: string }>(kind: 'packs' | 'snapshots', digest: string): Promise<T> {
    const path = this.path(kind, digest),
      info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink())
      throw new GearError('research-identity-mismatch', 'Research records must be regular files')
    const value = JSON.parse(await readFile(path, 'utf8')) as T
    const { digest: actual, ...body } = value
    if (actual !== digest || canonicalDigest(body) !== digest)
      throw new GearError('research-identity-mismatch', 'Frozen research record changed')
    return value
  }
  private async save(kind: 'packs' | 'snapshots', value: ResearchPack | ResearchArchive) {
    try {
      await this.read(kind, value.digest)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await publishFile(this.path(kind, value.digest), encoded(value), { immutable: true })
  }
  async capture(journal: RunJournal): Promise<ResearchArchive> {
    const { archive, packs } = researchArchive(journal)
    await bounded(packs, (pack) => this.save('packs', pack))
    await this.save('snapshots', archive)
    // Persist creation of both child directories before RunStore commits its journal.
    await syncDirectory(this.root)
    return archive
  }
  async load(journal: RunJournal): Promise<{ archive: ResearchArchive; objects: ResearchObject[] }> {
    const expected = researchArchive(journal)
    const archive = await this.read<ResearchArchive>('snapshots', expected.archive.digest)
    const packs = await bounded(archive.packs, (digest) => this.read<ResearchPack>('packs', digest))
    const byDigest = new Map(packs.flatMap((pack) => pack.objects).map((object) => [object.digest, object]))
    const objects = archive.objects.map((reference) => {
      const object = byDigest.get(reference.digest)
      if (!object || object.kind !== reference.kind)
        throw new GearError('research-identity-mismatch', 'Research record kind changed')
      const { digest, ...body } = object
      if (canonicalDigest(body) !== digest)
        throw new GearError('research-identity-mismatch', 'Research record digest changed')
      return object
    })
    return { archive, objects }
  }
}

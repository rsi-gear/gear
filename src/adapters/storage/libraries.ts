import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { ArtifactRef } from '../../domain/algorithm-wire-v2.js'
import type { OperatorArtifact } from '../../domain/operator-run.js'
import { publishFile } from './atomic.js'
import { withFileLock } from './file-lock.js'

interface PublicationRequest {
  commit_id: string
  name: string
  snapshot: ArtifactRef
  expected_revision: string | null
}
export interface LibraryPublication {
  status: 'published' | 'conflict'
  commit_id: string
  revision: string | null
  snapshot: ArtifactRef
}
interface Publication {
  request: PublicationRequest
  result: LibraryPublication
}
interface LibraryLog {
  version: 1
  name: string
  head: { revision: string; snapshot: ArtifactRef } | null
  commits: Publication[]
  digest: string
}

/** One atomic head+commit log makes a lost receipt recoverable even after later publications. */
export class LibraryStore {
  constructor(readonly root: string) {}
  private file(kind: string, digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new GearError('invalid-library-digest', 'Invalid library object identity')
    return join(this.root, kind, digest.slice(7) + '.json')
  }
  private async read(path: string): Promise<unknown> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32 * 1024 * 1024)
      throw new GearError('library-object-invalid', 'Library objects must be bounded regular files')
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  }
  async save(snapshot: OperatorArtifact): Promise<void> {
    if (
      snapshot.ref.kind !== 'library' ||
      snapshot.ref.visibility !== 'optimization' ||
      canonicalDigest({ kind: 'library', value: snapshot.value, sources: snapshot.sources }) !==
        snapshot.ref.digest
    )
      throw new GearError(
        'library-snapshot-identity',
        'Library snapshot content does not match its reference',
      )
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024)
      throw new GearError('library-snapshot-too-large', 'Library snapshot exceeds its byte budget')
    await publishFile(this.file('snapshots', canonicalDigest(snapshot.ref)), JSON.stringify(snapshot), {
      immutable: true,
    })
  }
  async snapshot(ref: ArtifactRef): Promise<OperatorArtifact> {
    const snapshot = (await this.read(this.file('snapshots', canonicalDigest(ref)))) as OperatorArtifact
    if (
      canonicalDigest(snapshot.ref) !== canonicalDigest(ref) ||
      snapshot.ref.kind !== 'library' ||
      canonicalDigest({ kind: 'library', value: snapshot.value, sources: snapshot.sources }) !== ref.digest
    )
      throw new GearError('library-snapshot-identity', 'Library snapshot changed')
    return snapshot
  }
  private async log(name: string): Promise<LibraryLog> {
    const path = this.file('heads', canonicalDigest(name))
    let log: LibraryLog
    try {
      log = (await this.read(path)) as LibraryLog
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const body = { version: 1 as const, name, head: null, commits: [] }
      return { ...body, digest: canonicalDigest(body) }
    }
    const { digest, ...body } = log
    if (
      log.version !== 1 ||
      log.name !== name ||
      !Array.isArray(log.commits) ||
      log.commits.length > 10000 ||
      canonicalDigest(body) !== digest
    )
      throw new GearError('library-log-identity', 'Library publication log failed verification')
    let revision: string | null = null
    const seen = new Set<string>()
    for (const commit of log.commits) {
      if (
        commit.request.name !== name ||
        seen.has(commit.request.commit_id) ||
        commit.result.commit_id !== commit.request.commit_id ||
        canonicalDigest(commit.result.snapshot) !== canonicalDigest(commit.request.snapshot)
      )
        throw new GearError('library-log-identity', 'Library commit identity changed')
      seen.add(commit.request.commit_id)
      const published: boolean = commit.request.expected_revision === revision
      if (
        commit.result.status !== (published ? 'published' : 'conflict') ||
        commit.result.revision !== (published ? canonicalDigest(commit.request) : revision)
      )
        throw new GearError('library-log-identity', 'Library commit chain changed')
      if (published) revision = commit.result.revision
    }
    const latest = log.commits.filter((commit) => commit.result.status === 'published').at(-1)
    if (
      canonicalDigest(log.head) !==
      canonicalDigest(latest ? { revision: latest.result.revision, snapshot: latest.result.snapshot } : null)
    )
      throw new GearError(
        'library-log-identity',
        'Library head differs from the committed publication history',
      )
    return log
  }
  async publish(request: PublicationRequest): Promise<LibraryPublication> {
    this.file('commits', request.commit_id)
    if (!request.name || request.name.length > 512)
      throw new GearError('invalid-library-name', 'Library name is invalid')
    await this.snapshot(request.snapshot)
    const path = this.file('heads', canonicalDigest(request.name))
    return withFileLock(path + '.lock', async () => {
      const log = await this.log(request.name)
      const previous = log.commits.find((item) => item.request.commit_id === request.commit_id)
      if (previous) {
        if (canonicalDigest(previous.request) !== canonicalDigest(request))
          throw new GearError('library-commit-conflict', 'Library commit ID was reused with different inputs')
        await publishFile(this.file('commits', request.commit_id), JSON.stringify(previous), {
          immutable: true,
        })
        return previous.result
      }
      if (log.commits.length >= 10000)
        throw new GearError('library-log-full', 'Library publication log reached its bounded capacity')
      const published = request.expected_revision === (log.head?.revision ?? null)
      const result: LibraryPublication = {
        status: published ? 'published' : 'conflict',
        commit_id: request.commit_id,
        revision: published ? canonicalDigest(request) : (log.head?.revision ?? null),
        snapshot: request.snapshot,
      }
      const record = { request: structuredClone(request), result }
      const body = {
        version: 1 as const,
        name: log.name,
        head: published ? { revision: result.revision!, snapshot: request.snapshot } : log.head,
        commits: [...log.commits, record],
      }
      const encoded = JSON.stringify({ ...body, digest: canonicalDigest(body) })
      if (Buffer.byteLength(encoded) > 32 * 1024 * 1024)
        throw new GearError('library-log-full', 'Library publication log reached its byte capacity')
      await publishFile(path, encoded)
      // This immutable receipt is a cache of the atomic commit log, recoverable
      // from that log if publication succeeds but receipt creation is interrupted.
      await publishFile(this.file('commits', request.commit_id), JSON.stringify(record), { immutable: true })
      return result
    })
  }
  async head(name: string): Promise<LibraryLog['head']> {
    return (await this.log(name)).head
  }
}

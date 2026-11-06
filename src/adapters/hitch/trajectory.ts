import { readFileSync } from 'node:fs'
import type { Json, TrialArtifact } from '../../domain/algorithm-wire.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'
import type { ArtifactReaderDescriptor, TrajectoryQuery } from '../../domain/trajectory.js'
import type { ArtifactReader } from '../../ports/trajectory.js'
import { hitchJson } from './transport.js'
import { nativeManifestDigest } from './native-source.js'

export const HITCH_TRAJECTORY = 'hitch-canonical-events-v1'
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
export const trajectoryReaderIdentity = canonicalDigest(
  ['./trajectory', './transport', './native-source'].map((name) =>
    readFileSync(new URL(name + extension, import.meta.url), 'utf8'),
  ),
)
const invalid = () =>
  new GearError(
    'trajectory-response-invalid',
    'Trajectory page does not match its frozen source or bounded query',
  )
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export function validateHitchPage(
  value: Record<string, unknown>,
  runId: string,
  digest: string | null,
  query: TrajectoryQuery,
): Json {
  const filter = {
    ...(query.types ? { types: query.types } : {}),
    ...(query.seq_start === undefined ? {} : { seq_start: query.seq_start }),
    ...(query.seq_end === undefined ? {} : { seq_end: query.seq_end }),
    ...(query.field === undefined ? {} : { field: query.field }),
  }
  if (
    value.schema_version !== '1' ||
    value.kind !== 'trajectory-events-page' ||
    value.run_id !== runId ||
    typeof value.canonical_sha256 !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.canonical_sha256) ||
    (digest !== null && value.canonical_sha256 !== digest) ||
    canonicalDigest(value.filter) !== canonicalDigest(filter) ||
    !Array.isArray(value.events) ||
    value.events.length > (query.limit ?? 20) ||
    !integer(value.total_matches) ||
    value.total_matches < value.events.length ||
    typeof value.eof !== 'boolean' ||
    (value.eof
      ? value.next_cursor !== undefined
      : typeof value.next_cursor !== 'string' || !value.next_cursor || value.next_cursor.length > 8192)
  )
    throw invalid()
  let previous = -1
  for (const event of value.events as Array<Record<string, unknown>>) {
    if (
      !event ||
      !integer(event.seq) ||
      event.seq <= previous ||
      typeof event.type !== 'string' ||
      event.seq < (query.seq_start ?? 0) ||
      event.seq > (query.seq_end ?? Number.MAX_SAFE_INTEGER) ||
      (query.types && !query.types.includes(event.type))
    )
      throw invalid()
    previous = event.seq
  }
  if (
    value.redactions !== undefined &&
    (!Array.isArray(value.redactions) ||
      value.redactions.some((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
        const record = entry as Record<string, unknown>
        return (
          Object.keys(record).some((key) => !['rule_id', 'count'].includes(key)) ||
          typeof record.rule_id !== 'string' ||
          !/^[a-z][a-z0-9._-]{0,127}$/u.test(record.rule_id) ||
          !integer(record.count)
        )
      }))
  )
    throw invalid()
  // Return only the public event-page contract; private provider fields cannot be smuggled alongside it.
  return {
    events: value.events.map((event: Record<string, Json>) =>
      Object.fromEntries(
        Object.entries(event).filter(([key]) =>
          [
            'type',
            'seq',
            'time',
            'data',
            'ignorable',
            'sourceEventSeqs',
            'surfaceOp',
            'field',
            'value',
            'event_excerpt',
          ].includes(key),
        ),
      ),
    ),
    total_matches: value.total_matches,
    eof: value.eof,
    ...(value.next_cursor === undefined ? {} : { next_cursor: value.next_cursor as string }),
    ...(value.redactions === undefined ? {} : { redactions: value.redactions as Json }),
  }
}

export class HitchArtifactReader implements ArtifactReader {
  readonly descriptor: ArtifactReaderDescriptor
  constructor(
    readonly executable: string,
    readonly root: string,
  ) {
    this.descriptor = {
      format: HITCH_TRAJECTORY,
      implementation_identity: trajectoryReaderIdentity,
      configuration: { executable, root },
    }
  }
  private async page(runId: string, digest: string | null, query: TrajectoryQuery, signal: AbortSignal) {
    if (!/^run_[a-f0-9]{32}$/u.test(runId))
      throw new GearError('invalid-trajectory-source', 'Invalid provider trajectory identity')
    const args = [
      'trajectory',
      'events',
      runId,
      '--limit',
      String(query.limit ?? 20),
      '--max-bytes',
      '36864',
      '--json',
      ...(digest ? ['--canonical-sha256', digest] : []),
      ...(query.types ? ['--types', query.types.join(',')] : []),
      ...(query.seq_start === undefined ? [] : ['--seq-start', String(query.seq_start)]),
      ...(query.seq_end === undefined ? [] : ['--seq-end', String(query.seq_end)]),
      ...(query.field === undefined ? [] : ['--field', query.field]),
      ...(query.cursor === undefined ? [] : ['--cursor', query.cursor]),
    ]
    const page = await hitchJson(this.executable, this.root, args, signal, 30_000, 36 * 1024)
    const publicPage = validateHitchPage(page, runId, digest, query)
    return { digest: page.canonical_sha256 as string, page: publicPage }
  }
  async capture(
    runId: string,
    taskId: string,
    repetition: number,
    signal: AbortSignal,
  ): Promise<TrialArtifact> {
    const base = {
      kind: 'trajectory' as const,
      format: HITCH_TRAJECTORY,
      task_id: taskId,
      repetition,
      locator: { run_id: runId, native_manifest_digest: await nativeManifestDigest(this.root, runId) },
    }
    try {
      const value = await this.page(runId, null, { limit: 1 }, signal)
      return { ...base, status: 'available', content_digest: value.digest, reason: null }
    } catch {
      signal.throwIfAborted()
      return { ...base, status: 'unavailable', content_digest: null, reason: 'trajectory-source-unavailable' }
    }
  }
  async read(artifact: TrialArtifact, query: TrajectoryQuery, signal: AbortSignal): Promise<Json> {
    const locator = artifact.locator as { run_id?: unknown; native_manifest_digest?: unknown } | null
    if (
      artifact.format !== HITCH_TRAJECTORY ||
      artifact.status !== 'available' ||
      !artifact.content_digest ||
      !locator ||
      typeof locator.run_id !== 'string' ||
      Object.keys(locator).some((key) => !['run_id', 'native_manifest_digest'].includes(key)) ||
      (locator.native_manifest_digest !== undefined &&
        locator.native_manifest_digest !== null &&
        (typeof locator.native_manifest_digest !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/u.test(locator.native_manifest_digest)))
    )
      throw new GearError('trajectory-unavailable', 'No verified canonical trajectory is available')
    return (await this.page(locator.run_id, artifact.content_digest, query, signal)).page
  }
}

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Json } from '../../domain/algorithm-wire.js'
import type { OperatorArtifact, TargetExecution } from '../../domain/operator-run.js'
import type { OperationReceipt, OperationRequest } from '../../ports/operations.js'
import { GearError } from '../../domain/errors.js'
import { canonicalDigest } from '../../domain/canonical.js'
import { materialPath } from '../../domain/material-path.js'
import { parseRunOutputExport, parseRunOutputManifest, type RunOutputManifest } from './run-artifacts.js'
import { validateHitchPage } from './trajectory.js'
import type { TrajectoryQuery } from '../../domain/trajectory.js'

type HitchCall = (args: string[], signal: AbortSignal) => Promise<Record<string, unknown>>
const messageTypes = [
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
  'tool/call',
  'tool/result',
]
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const invalid = () =>
  new GearError('target-artifact-invalid', 'Target artifact does not match its sealed execution')
const digest = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

/** Read target-only Hitch namespaces. Never derive status, output or error text from observation/verifier. */
export class HitchOperatorArtifacts {
  constructor(
    readonly call: HitchCall,
    readonly cache: string,
    readonly revisionIdentity: string,
  ) {}

  async capture(
    request: OperationRequest,
    receipt: OperationReceipt,
    signal: AbortSignal,
  ): Promise<TargetExecution[]> {
    const provenance = object(receipt.provenance)
    const evaluations = provenance.evaluations as Array<{
      eval_id: string
      trials: Array<{ run_id: string; task_id: string; attempt: number }>
    }>
    const groups = provenance.execution_artifacts as Array<{ eval_id: string; repetition: number }>
    if (!Array.isArray(evaluations) || !Array.isArray(groups)) throw invalid()
    const executions: TargetExecution[] = []
    for (const slot of request.slots) {
      const matches = groups
        .filter((group) => group.repetition === slot.repetition)
        .flatMap((group) =>
          evaluations
            .filter((evaluation) => evaluation.eval_id === group.eval_id)
            .flatMap((evaluation) =>
              evaluation.trials
                .filter((trial) => trial.task_id === slot.taskId)
                .map((trial) => ({ ...trial, eval_id: evaluation.eval_id })),
            ),
        )
      if (matches.length > 1) throw invalid()
      const trial = matches[0]
      if (!trial) {
        executions.push({
          taskId: slot.taskId,
          repetition: slot.repetition,
          status: 'unavailable',
          output: { value: { available: false } },
          trajectory: null,
        })
        continue
      }
      if (!/^run_[a-f0-9]{32}$/u.test(trial.run_id) || trial.attempt !== 1) throw invalid()
      const inspected = await this.call(['runs', 'inspect', trial.run_id, '--json'], signal)
      const record = object(inspected.record),
        context = object(record.context),
        parent = object(record.parent)
      if (
        inspected.schema_version !== '1' ||
        inspected.record_status !== 'valid' ||
        record.run_id !== trial.run_id ||
        context.kind !== 'benchmark_task' ||
        context.task_id !== slot.taskId ||
        parent.eval_id !== trial.eval_id ||
        parent.attempt !== trial.attempt ||
        object(record.harness).revision_identity !== this.revisionIdentity ||
        !['succeeded', 'failed', 'timed_out', 'cancelled'].includes(String(record.status))
      )
        throw invalid()
      const target: TargetExecution = {
        taskId: slot.taskId,
        repetition: slot.repetition,
        status: record.status as TargetExecution['status'],
        output: { value: { available: false } },
        trajectory: null,
      }
      if (inspected.trajectory_status === 'valid') {
        const first = await this.page(trial.run_id, null, undefined, signal)
        const value = { available: true, source_digest: first.digest, projection: 'target-messages-v1' }
        const external = {
          format: 'hitch-target-messages-v1',
          locator: { run_id: trial.run_id, digest: first.digest },
        }
        target.trajectory = { value, external }
        // A task without declared files can select its sealed target conversation as output.
        target.output = { value: { ...value, kind: 'target-transcript' }, external }
      }
      try {
        const manifest = parseRunOutputManifest(
          await this.call(['runs', 'artifacts', 'list', trial.run_id, '--json'], signal),
          { runId: trial.run_id, evalId: trial.eval_id, taskId: slot.taskId, attempt: trial.attempt },
        )
        target.output = {
          value: {
            available: true,
            kind: 'declared-files',
            source_digest: manifest.digest,
            entries: manifest.entries,
          },
          external: { format: 'hitch-declared-output-v1', locator: manifest as unknown as Json },
        }
      } catch (error) {
        signal.throwIfAborted()
        // An unsupported output namespace has no effect on independently observed target status.
        // Identity errors are never downgraded to unavailable content.
        if (error instanceof TypeError) throw invalid()
        if (!(error instanceof GearError) || error.code !== 'hitch-output-unavailable') throw error
      }
      executions.push(target)
    }
    return executions
  }

  private async page(
    runId: string,
    expected: string | null,
    cursor: string | undefined,
    signal: AbortSignal,
  ) {
    const query: TrajectoryQuery = { types: messageTypes, limit: 20, ...(cursor ? { cursor } : {}) }
    const raw = await this.call(
      [
        'trajectory',
        'events',
        runId,
        '--types',
        messageTypes.join(','),
        '--limit',
        '20',
        '--max-bytes',
        '36864',
        '--json',
        ...(expected ? ['--canonical-sha256', expected] : []),
        ...(cursor ? ['--cursor', cursor] : []),
      ],
      signal,
    )
    const page = validateHitchPage(raw, runId, expected, query) as {
      events: Json[]
      eof: boolean
      next_cursor?: string
      total_matches: number
    }
    return { ...page, digest: String(raw.canonical_sha256) }
  }

  async read(artifact: OperatorArtifact, path: string | null, signal: AbortSignal): Promise<Buffer> {
    const source = artifact.external
    if (!source) throw invalid()
    if (source.format === 'hitch-target-messages-v1') {
      if (path !== null)
        throw new GearError(
          'material-path-invalid',
          'Target conversation reads do not accept arbitrary field paths',
        )
      const locator = object(source.locator),
        runId = String(locator.run_id),
        expected = String(locator.digest)
      if (!/^run_[a-f0-9]{32}$/u.test(runId) || !/^sha256:[a-f0-9]{64}$/u.test(expected)) throw invalid()
      let cursor: string | undefined,
        total = 0,
        complete = true,
        previous = -1
      const events: Json[] = [],
        seen = new Set<string>()
      do {
        const page = await this.page(runId, expected, cursor, signal)
        for (const item of page.events) {
          const event = object(item)
          if (Number(event.seq) <= previous) throw invalid()
          previous = Number(event.seq)
          const projected = targetMessage(event)
          if (!projected.complete) complete = false
          total += Buffer.byteLength(JSON.stringify(projected.event))
          if (total > 64 * 1024 * 1024 || events.length >= 100000)
            throw new GearError(
              'target-trajectory-too-large',
              'Target conversation exceeds the bounded read capacity',
            )
          events.push(projected.event)
        }
        cursor = page.eof ? undefined : page.next_cursor
        if (cursor && (seen.has(cursor) || !page.events.length)) throw invalid()
        if (cursor) seen.add(cursor)
      } while (cursor)
      return Buffer.from(
        JSON.stringify({
          projection: 'target-messages-v1',
          source_digest: expected,
          content_complete: complete,
          events,
        }),
      )
    }
    if (source.format !== 'hitch-declared-output-v1') throw invalid()
    const saved = source.locator as unknown as RunOutputManifest
    const manifest = parseRunOutputManifest(saved, { runId: saved.run_id })
    if (path === null)
      return Buffer.from(JSON.stringify({ entries: manifest.entries, source_digest: manifest.digest }))
    materialPath(path)
    const entry = manifest.entries.find((entry) => entry.path === path)
    if (!entry) throw new GearError('material-path-missing', 'File is not in the sealed output manifest')
    await mkdir(this.cache, { recursive: true, mode: 0o700 })
    const destination = join(this.cache, canonicalDigest([manifest.run_id, manifest.digest]).slice(7))
    const exported = await this.call(
      [
        'runs',
        'artifacts',
        'export',
        manifest.run_id,
        '--manifest-digest',
        manifest.digest,
        '--out',
        destination,
        '--json',
      ],
      signal,
    )
    parseRunOutputExport(exported, manifest, destination)
    const directory = await lstat(destination),
      manifestInfo = await lstat(join(destination, 'hitch-output-manifest.json'))
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      manifestInfo.nlink !== 1 ||
      manifestInfo.size > 4 * 1024 * 1024
    )
      throw invalid()
    const diskManifest = parseRunOutputManifest(
      JSON.parse(await readFile(join(destination, 'hitch-output-manifest.json'), 'utf8')),
      { runId: manifest.run_id },
    )
    if (diskManifest.digest !== manifest.digest) throw invalid()
    let current = destination
    for (const segment of path.split('/')) {
      current = join(current, segment)
      const info = await lstat(current)
      if (
        info.isSymbolicLink() ||
        (current !== join(destination, path) && !info.isDirectory()) ||
        (current === join(destination, path) &&
          (!info.isFile() || info.nlink !== 1 || info.size !== entry.bytes))
      )
        throw invalid()
    }
    const bytes = await readFile(current)
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw invalid()
    return bytes
  }
}

/** Strip provider diagnostics, usage, source metadata and unknown event extensions. */
function targetMessage(event: Record<string, unknown>): { event: Json; complete: boolean } {
  if (!messageTypes.includes(String(event.type))) throw invalid()
  const data = object(event.data),
    message = object(data.message ?? data)
  if (event.event_excerpt)
    return {
      event: { seq: Number(event.seq), type: String(event.type), content: null, omitted: true },
      complete: false,
    }
  if (event.type === 'tool/call')
    return {
      event: {
        seq: Number(event.seq),
        type: 'tool/call',
        call_id: String(data.callId ?? ''),
        name: String(data.name ?? ''),
        arguments: typeof data.arguments === 'string' ? data.arguments : null,
      },
      complete: true,
    }
  let complete = true
  const content = (value: unknown, depth = 0): Json => {
    if (depth > 32 || !Array.isArray(value)) {
      complete = false
      return null
    }
    return value.map((part) => {
      const block = object(part)
      if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
      if (block.type === 'tool-result')
        return {
          type: 'tool-result',
          toolCallId: String(block.toolCallId ?? ''),
          isError: block.isError === true,
          content: content(block.content, depth + 1),
        }
      complete = false
      return { type: typeof block.type === 'string' ? block.type : 'omitted', omitted: true }
    })
  }
  const projected = content(message.content)
  return { event: { seq: Number(event.seq), type: String(event.type), content: projected }, complete }
}

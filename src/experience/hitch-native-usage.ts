import { constants, createReadStream } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  EXPERIENCE_USE_EXTRACTOR_VERSION,
  type ExperienceUsageReadResult,
  type ExperienceUsageReader,
  type ExperienceUsageTrace,
  type ExperienceUsageTraceFile,
  type ExperienceUsageUnavailableReason,
} from './usage.js'

const RUN_ID = /^run_[0-9a-f]{32}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const MAIN_SOURCE_PATH = 'trajectory/provider/deepseek-session.jsonl'
const CHILD_SOURCE_PATH = /^trajectory\/provider\/deepseek-child-session-[1-9][0-9]*\.jsonl$/u
const RETAINED_EVENT_TYPES = new Set(['user/message', 'request/header'])
const RETAINED_TOOL_NAMES = new Set(['skill', 'read', 'read_file', 'fs.read'])

type JsonRecord = Record<string, unknown>

interface NativeFilePlan {
  path: string
  digest: string
  bytes: number
  child: boolean
}

interface NativeRunPlan {
  runId: string
  runDirectory: string
  trajectoryManifestDigest: string
  providerSessionId?: string
  files: NativeFilePlan[]
  cached?: ExperienceUsageTrace
}

export interface HitchNativeExperienceUsageReaderOptions {
  root: string
  maxRuns?: number
  maxFilesPerRun?: number
  maxManifestBytes?: number
  maxNativeFileBytes?: number
  maxRunBytes?: number
  maxSnapshotBytes?: number
  maxRetainedBytesPerRun?: number
  concurrency?: number
  maxCachedRuns?: number
  maxCachedBytes?: number
}

class NativeUsageError extends Error {
  constructor(readonly reason: ExperienceUsageUnavailableReason, message: string) {
    super(message)
  }
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep)
}

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  signal: AbortSignal,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      signal.throwIfAborted()
      const index = next++
      if (index >= values.length) return
      output[index] = await task(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return output
}

function eventRecord(value: unknown): JsonRecord {
  const item = record(value)
  if (item === undefined || typeof item.type !== 'string') {
    throw new NativeUsageError('native-source-parse-failed', 'native event is not an object with a type')
  }
  return item
}

function toolResultCallId(event: JsonRecord): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const message = record(record(event.data)?.message)
  const source = record(message?.source)
  if (source?.kind !== 'tool' || typeof source.callId !== 'string' || !Array.isArray(message?.content)) return undefined
  const matched = message.content.map(record).some(item => item?.type === 'tool-result'
    && item.toolCallId === source.callId)
  return matched ? source.callId : undefined
}

function retainedEvent(event: JsonRecord, trackedCalls: Set<string>): JsonValue | undefined {
  if (event.type !== 'session' && (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0)) {
    throw new NativeUsageError('native-source-parse-failed', 'native event has an invalid sequence')
  }
  if (event.type === 'tool/call') {
    const data = record(event.data)
    if (typeof data?.name !== 'string' || !RETAINED_TOOL_NAMES.has(data.name)) return undefined
    if (typeof data.callId === 'string') trackedCalls.add(data.callId)
    return event as JsonValue
  }
  if (event.type === 'tool/result') {
    const callId = toolResultCallId(event)
    return callId !== undefined && trackedCalls.has(callId) ? event as JsonValue : undefined
  }
  if (!RETAINED_EVENT_TYPES.has(event.type as string)) return undefined
  const data = record(event.data)
  if (event.type === 'user/message') {
    const source = record(data?.source)
    if (source?.kind !== 'skill-invocation' || typeof source.name !== 'string') return undefined
    return event as JsonValue
  }
  const system = record(data?.header)?.system
  if (system === undefined) return undefined
  return {
    type: 'request/header',
    seq: event.seq as number,
    data: { header: { system: system as JsonValue } },
  }
}

function sourceFailure(reason: ExperienceUsageUnavailableReason): { ok: false; reason: ExperienceUsageUnavailableReason } {
  return { ok: false, reason }
}

type SourceScan =
  | { ok: true; file: ExperienceUsageTraceFile; retainedBytes: number; retainedComplete: boolean }
  | { ok: false; reason: ExperienceUsageUnavailableReason }

export class HitchNativeExperienceUsageReader implements ExperienceUsageReader {
  private readonly root: string
  private readonly maxRuns: number
  private readonly maxFilesPerRun: number
  private readonly maxManifestBytes: number
  private readonly maxNativeFileBytes: number
  private readonly maxRunBytes: number
  private readonly maxSnapshotBytes: number
  private readonly maxRetainedBytesPerRun: number
  private readonly concurrency: number
  private readonly maxCachedRuns: number
  private readonly maxCachedBytes: number
  private readonly verified = new Map<string, { trace: ExperienceUsageTrace; bytes: number }>()
  private verifiedBytes = 0

  constructor(options: HitchNativeExperienceUsageReaderOptions) {
    if (options.root.length === 0) throw new TypeError('Hitch usage root is required')
    this.root = resolve(options.root)
    this.maxRuns = options.maxRuns ?? 1_024
    this.maxFilesPerRun = options.maxFilesPerRun ?? 16
    this.maxManifestBytes = options.maxManifestBytes ?? 1024 * 1024
    this.maxNativeFileBytes = options.maxNativeFileBytes ?? 32 * 1024 * 1024
    this.maxRunBytes = options.maxRunBytes ?? 64 * 1024 * 1024
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 1024 * 1024 * 1024
    this.maxRetainedBytesPerRun = options.maxRetainedBytesPerRun ?? 8 * 1024 * 1024
    this.concurrency = options.concurrency ?? 4
    this.maxCachedRuns = options.maxCachedRuns ?? 1_024
    this.maxCachedBytes = options.maxCachedBytes ?? 128 * 1024 * 1024
    for (const [name, value] of Object.entries({
      maxRuns: this.maxRuns,
      maxFilesPerRun: this.maxFilesPerRun,
      maxManifestBytes: this.maxManifestBytes,
      maxNativeFileBytes: this.maxNativeFileBytes,
      maxRunBytes: this.maxRunBytes,
      maxSnapshotBytes: this.maxSnapshotBytes,
      maxRetainedBytesPerRun: this.maxRetainedBytesPerRun,
      concurrency: this.concurrency,
      maxCachedRuns: this.maxCachedRuns,
      maxCachedBytes: this.maxCachedBytes,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
    }
  }

  async readRuns(runIds: readonly string[], signal: AbortSignal): Promise<Map<string, ExperienceUsageReadResult>> {
    signal.throwIfAborted()
    const ids = [...new Set(runIds)].sort((left, right) => left.localeCompare(right))
    const output = new Map<string, ExperienceUsageReadResult>()
    const accepted: string[] = []
    for (const runId of ids) {
      if (!RUN_ID.test(runId)) output.set(runId, { available: false, runId, reason: 'run-id-missing' })
      else if (accepted.length >= this.maxRuns) {
        output.set(runId, { available: false, runId, reason: 'snapshot-run-limit' })
      } else accepted.push(runId)
    }

    let rootReal: string
    try { rootReal = await realpath(this.root) }
    catch {
      for (const runId of accepted) output.set(runId, {
        available: false, runId, reason: 'trajectory-manifest-unavailable',
      })
      return output
    }
    const planned = await mapLimit(accepted, this.concurrency, signal, async runId => {
      try { return await this.planRun(rootReal, runId, signal) }
      catch (error) {
        if (signal.aborted) throw error
        const reason = error instanceof NativeUsageError ? error.reason : 'trajectory-manifest-unavailable'
        return { available: false, runId, reason } satisfies ExperienceUsageReadResult
      }
    })

    const scans: NativeRunPlan[] = []
    let reserved = 0
    for (const plan of planned) {
      if ('available' in plan) { output.set(plan.runId, plan); continue }
      if (plan.cached !== undefined) { output.set(plan.runId, { available: true, trace: plan.cached }); continue }
      const bytes = plan.files.reduce((sum, file) => sum + file.bytes, 0)
      if (reserved + bytes > this.maxSnapshotBytes) {
        output.set(plan.runId, {
          available: false,
          runId: plan.runId,
          reason: 'snapshot-byte-limit',
          trajectoryManifestDigest: plan.trajectoryManifestDigest,
          mainSessionFiles: 1,
          childSessionFiles: plan.files.length - 1,
          listedFiles: plan.files.length,
          verifiedFiles: 0,
          verifiedBytes: 0,
        })
      } else {
        reserved += bytes
        scans.push(plan)
      }
    }

    const scanned = await mapLimit(scans, this.concurrency, signal, plan => this.scanRun(rootReal, plan, signal))
    for (const result of scanned) {
      output.set(result.available ? result.trace.runId : result.runId, result)
      if (result.available && result.trace.coverage === 'listed-files-complete') this.cache(result.trace)
    }
    return output
  }

  private async planRun(rootReal: string, runId: string, signal: AbortSignal): Promise<NativeRunPlan> {
    const runDirectory = resolve(rootReal, 'runs', runId)
    if (!inside(rootReal, runDirectory)) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'run path escaped Hitch root')
    }
    const runInfo = await lstat(runDirectory).catch(() => undefined)
    if (runInfo === undefined || !runInfo.isDirectory() || runInfo.isSymbolicLink()) {
      throw new NativeUsageError('trajectory-manifest-unavailable', 'run directory is unavailable')
    }
    const runReal = await realpath(runDirectory)
    if (!inside(rootReal, runReal)) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'run directory escaped Hitch root')
    }
    const manifestPath = resolve(runReal, 'trajectory.ref.json')
    const info = await lstat(manifestPath).catch(() => undefined)
    if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
      throw new NativeUsageError('trajectory-manifest-unavailable', 'trajectory manifest is unavailable')
    }
    if (info.size > this.maxManifestBytes) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory manifest exceeds the byte limit')
    }
    const raw = await readFile(manifestPath, { signal })
    if (raw.byteLength !== info.size) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory manifest changed while reading')
    }
    const trajectoryManifestDigest = sha256(raw)
    let parsed: unknown
    try { parsed = JSON.parse(raw.toString('utf8')) }
    catch { throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory manifest is invalid JSON') }
    const manifest = record(parsed)
    if (manifest?.schema_version !== '2' || manifest.run_id !== runId
      || manifest.provider !== 'deepseek' || manifest.fidelity !== 'provider_native'
      || !Array.isArray(manifest.files)) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory manifest identity is invalid')
    }
    const providerFiles = manifest.files.map(record).filter(file => file?.role === 'provider_events')
    const providerSessionId = manifest.provider_session_id
    if (providerSessionId !== undefined && (typeof providerSessionId !== 'string' || providerSessionId.length === 0)) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory provider session identity is invalid')
    }
    if (providerFiles.length === 0 || providerFiles.length > this.maxFilesPerRun) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory provider event file count is invalid')
    }
    const files: NativeFilePlan[] = []
    const seen = new Set<string>()
    for (const file of providerFiles) {
      const path = file?.path
      const digest = file?.sha256
      const bytes = file?.bytes
      const child = typeof path === 'string' && CHILD_SOURCE_PATH.test(path)
      if (typeof path !== 'string' || path !== MAIN_SOURCE_PATH && !child
        || file?.media_type !== 'application/x-ndjson'
        || typeof digest !== 'string' || !SHA256.test(digest)
        || !Number.isSafeInteger(bytes) || (bytes as number) <= 0
        || (bytes as number) > this.maxNativeFileBytes || seen.has(path)) {
        throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory provider event entry is invalid')
      }
      seen.add(path)
      files.push({ path, digest, bytes: bytes as number, child })
    }
    files.sort((left, right) => left.path.localeCompare(right.path))
    if (files.filter(file => !file.child).length !== 1
      || files.reduce((sum, file) => sum + file.bytes, 0) > this.maxRunBytes) {
      throw new NativeUsageError('trajectory-manifest-invalid', 'trajectory provider event set is invalid')
    }
    const cached = this.verified.get(`${runId}:${trajectoryManifestDigest}:${EXPERIENCE_USE_EXTRACTOR_VERSION}`)?.trace
    return {
      runId,
      runDirectory: runReal,
      trajectoryManifestDigest,
      ...(typeof providerSessionId === 'string' ? { providerSessionId } : {}),
      files,
      ...(cached === undefined ? {} : { cached }),
    }
  }

  private async scanRun(
    rootReal: string,
    plan: NativeRunPlan,
    signal: AbortSignal,
  ): Promise<ExperienceUsageReadResult> {
    let retainedBudget = this.maxRetainedBytesPerRun
    const scans: SourceScan[] = []
    for (const file of plan.files) {
      signal.throwIfAborted()
      const result = await this.scanFile(rootReal, plan.runDirectory, file, retainedBudget, signal)
      if (result.ok) retainedBudget = Math.max(0, retainedBudget - result.retainedBytes)
      scans.push(result)
    }
    let verified = scans.filter((scan): scan is Extract<SourceScan, { ok: true }> => scan.ok)
    const failed = scans.find((scan): scan is Extract<SourceScan, { ok: false }> => !scan.ok)
    let identityIncomplete = false
    const main = verified.find(scan => scan.file.sourcePath === MAIN_SOURCE_PATH)
    if (main === undefined && verified.length > 0) {
      return {
        available: false,
        runId: plan.runId,
        reason: failed?.reason ?? 'native-source-invalid',
        trajectoryManifestDigest: plan.trajectoryManifestDigest,
        mainSessionFiles: 1,
        childSessionFiles: plan.files.length - 1,
        listedFiles: plan.files.length,
        verifiedFiles: verified.length,
        verifiedBytes: verified.reduce((sum, scan) => sum + scan.file.bytes, 0),
      }
    }
    if (main !== undefined && plan.providerSessionId !== undefined
      && main.file.sessionId !== plan.providerSessionId) {
      return {
        available: false,
        runId: plan.runId,
        reason: 'native-source-invalid',
        trajectoryManifestDigest: plan.trajectoryManifestDigest,
        mainSessionFiles: 1,
        childSessionFiles: plan.files.length - 1,
        listedFiles: plan.files.length,
        verifiedFiles: verified.length,
        verifiedBytes: verified.reduce((sum, scan) => sum + scan.file.bytes, 0),
      }
    }
    if (main !== undefined) {
      const byId = new Map<string, Extract<SourceScan, { ok: true }>>()
      const duplicates = new Set<string>()
      for (const scan of verified) {
        if (byId.has(scan.file.sessionId)) duplicates.add(scan.file.sessionId)
        else byId.set(scan.file.sessionId, scan)
      }
      const trusted = new Set([main.file.sessionId])
      let changed = true
      while (changed) {
        changed = false
        for (const scan of verified) {
          const parent = scan.file.parentSessionId === undefined ? undefined : byId.get(scan.file.parentSessionId)
          if (trusted.has(scan.file.sessionId) || duplicates.has(scan.file.sessionId)
            || parent === undefined || !trusted.has(parent.file.sessionId)
            || scan.file.delegationDepth !== parent.file.delegationDepth + 1) continue
          trusted.add(scan.file.sessionId)
          changed = true
        }
      }
      const next = verified.filter(scan => scan.file.sourcePath === MAIN_SOURCE_PATH
        || !duplicates.has(scan.file.sessionId) && trusted.has(scan.file.sessionId))
      identityIncomplete = next.length !== verified.length
      verified = next
    }
    const retainedIncomplete = verified.some(scan => !scan.retainedComplete)
    if (verified.length === 0) {
      return {
        available: false,
        runId: plan.runId,
        reason: failed?.reason ?? 'native-source-unavailable',
        trajectoryManifestDigest: plan.trajectoryManifestDigest,
        mainSessionFiles: 1,
        childSessionFiles: plan.files.length - 1,
        listedFiles: plan.files.length,
        verifiedFiles: 0,
        verifiedBytes: 0,
      }
    }
    const coverage = failed === undefined && !retainedIncomplete && !identityIncomplete
      ? 'listed-files-complete'
      : 'partial'
    const reason = identityIncomplete
      ? 'native-source-invalid'
      : failed?.reason ?? (retainedIncomplete ? 'native-source-byte-limit' : undefined)
    const trace: ExperienceUsageTrace = {
      schemaVersion: 1,
      kind: 'dsh-native-events',
      runId: plan.runId,
      trajectoryManifestDigest: plan.trajectoryManifestDigest,
      listedFiles: plan.files.length,
      mainSessionFiles: 1,
      childSessionFiles: plan.files.length - 1,
      coverage,
      ...(reason === undefined ? {} : { reason }),
      files: verified.map(scan => scan.file).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    }
    return { available: true, trace }
  }

  private async scanFile(
    rootReal: string,
    runDirectory: string,
    plan: NativeFilePlan,
    maxRetainedBytes: number,
    signal: AbortSignal,
  ): Promise<SourceScan> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const path = resolve(runDirectory, plan.path)
      if (!inside(runDirectory, path) || !inside(rootReal, path)) {
        throw new NativeUsageError('native-source-invalid', 'native source path escaped its run directory')
      }
      const pathInfo = await lstat(path)
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size !== plan.bytes) {
        throw new NativeUsageError('native-source-invalid', 'native source identity is invalid')
      }
      const pathReal = await realpath(path)
      if (!inside(runDirectory, pathReal) || dirname(pathReal) !== dirname(path)) {
        throw new NativeUsageError('native-source-invalid', 'native source resolved outside its allowed directory')
      }
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const openInfo = await handle.stat()
      if (!openInfo.isFile() || openInfo.size !== plan.bytes) {
        throw new NativeUsageError('native-source-invalid', 'native source changed before reading')
      }
      const hash = createHash('sha256')
      const decoder = new StringDecoder('utf8')
      const trackedCalls = new Set<string>()
      const events: JsonValue[] = []
      let line = ''
      let bytes = 0
      let retainedBytes = 0
      let retainedComplete = true
      let session: JsonRecord | undefined
      const consume = (rawLine: string): void => {
        if (rawLine.endsWith('\r')) rawLine = rawLine.slice(0, -1)
        if (rawLine.length === 0) return
        let parsed: unknown
        try { parsed = JSON.parse(rawLine) }
        catch { throw new NativeUsageError('native-source-parse-failed', 'native source contains invalid JSON') }
        const event = eventRecord(parsed)
        if (event.type === 'session') {
          if (session !== undefined) throw new NativeUsageError('native-source-parse-failed', 'native source has multiple session headers')
          session = event
          return
        }
        const retained = retainedEvent(event, trackedCalls)
        if (retained === undefined) return
        const retainedSize = Buffer.byteLength(JSON.stringify(retained), 'utf8')
        if (retainedBytes + retainedSize > maxRetainedBytes) { retainedComplete = false; return }
        retainedBytes += retainedSize
        events.push(retained)
      }
      const stream = createReadStream(path, { fd: handle.fd, autoClose: false, signal })
      for await (const rawChunk of stream) {
        const chunk = rawChunk as Buffer
        bytes += chunk.byteLength
        if (bytes > plan.bytes || bytes > this.maxNativeFileBytes) {
          throw new NativeUsageError('native-source-byte-limit', 'native source exceeds its declared bytes')
        }
        hash.update(chunk)
        line += decoder.write(chunk)
        let newline = line.indexOf('\n')
        while (newline >= 0) {
          consume(line.slice(0, newline))
          line = line.slice(newline + 1)
          newline = line.indexOf('\n')
        }
        if (Buffer.byteLength(line, 'utf8') > this.maxNativeFileBytes) {
          throw new NativeUsageError('native-source-byte-limit', 'native source line exceeds the byte limit')
        }
      }
      line += decoder.end()
      consume(line)
      if (bytes !== plan.bytes) throw new NativeUsageError('native-source-invalid', 'native source byte count changed')
      if (`sha256:${hash.digest('hex')}` !== plan.digest) {
        throw new NativeUsageError('native-source-digest-mismatch', 'native source digest does not match its manifest')
      }
      const sessionId = session?.id
      const depth = session?.delegationDepth ?? 0
      const parentSessionId = session?.parentSession
      if (typeof sessionId !== 'string' || sessionId.length === 0
        || !Number.isSafeInteger(depth) || (depth as number) < 0
        || plan.child !== ((depth as number) > 0)
        || plan.child && (typeof parentSessionId !== 'string' || parentSessionId.length === 0)) {
        throw new NativeUsageError('native-source-parse-failed', 'native source session identity is invalid')
      }
      return {
        ok: true,
        retainedBytes,
        retainedComplete,
        file: {
          sourcePath: plan.path,
          sourceDigest: plan.digest,
          bytes,
          sessionId,
          ...(typeof parentSessionId === 'string' ? { parentSessionId } : {}),
          delegationDepth: depth as number,
          events,
        },
      }
    } catch (error) {
      if (signal.aborted) throw error
      return sourceFailure(error instanceof NativeUsageError ? error.reason : 'native-source-unavailable')
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private cache(trace: ExperienceUsageTrace): void {
    const key = `${trace.runId}:${trace.trajectoryManifestDigest}:${EXPERIENCE_USE_EXTRACTOR_VERSION}`
    const previous = this.verified.get(key)
    if (previous !== undefined) this.verifiedBytes -= previous.bytes
    this.verified.delete(key)
    const bytes = Buffer.byteLength(JSON.stringify(trace), 'utf8')
    if (bytes > this.maxCachedBytes) return
    this.verified.set(key, { trace, bytes })
    this.verifiedBytes += bytes
    while (this.verified.size > this.maxCachedRuns || this.verifiedBytes > this.maxCachedBytes) {
      const oldest = this.verified.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.verifiedBytes -= this.verified.get(oldest)?.bytes ?? 0
      this.verified.delete(oldest)
    }
  }
}

import { createHash } from 'node:crypto'

/** Public Hitch wire contract. Keep this independent of Hitch's private storage layout. */
export interface RunOutputManifest {
  schema_version: '1'
  kind: 'run-output-artifacts'
  run_id: string
  eval_id: string
  task_id: string
  attempt: number
  harness_commit: string
  task_digest: string
  entries: Array<{ name: string; path: string; media_type: string; bytes: number; sha256: string }>
  digest: string
}

export interface RunOutputIdentity {
  runId: string
  harnessCommit?: string
  taskId?: string
  taskDigest?: string
  evalId?: string
  attempt?: number
}

// Hitch canonical JSON sorts keys by code units, not localeCompare.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('invalid run output object')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    throw new TypeError('invalid run output fields')
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value)
}

export function parseRunOutputManifest(input: unknown, expected: RunOutputIdentity): RunOutputManifest {
  const value = object(input)
  keys(value, [
    'schema_version',
    'kind',
    'run_id',
    'eval_id',
    'task_id',
    'attempt',
    'harness_commit',
    'task_digest',
    'entries',
    'digest',
  ])
  if (
    value.schema_version !== '1' ||
    value.kind !== 'run-output-artifacts' ||
    !/^run_[a-f0-9]{32}$/u.test(String(value.run_id)) ||
    value.run_id !== expected.runId ||
    !/^eval_[a-f0-9]{32}$/u.test(String(value.eval_id)) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u.test(String(value.task_id)) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(String(value.harness_commit)) ||
    !sha(value.task_digest) ||
    !sha(value.digest) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 10_000
  )
    throw new TypeError('invalid run output manifest')
  if (
    (expected.harnessCommit !== undefined && expected.harnessCommit !== value.harness_commit) ||
    (expected.taskId !== undefined && expected.taskId !== value.task_id) ||
    (expected.taskDigest !== undefined && expected.taskDigest !== value.task_digest) ||
    (expected.evalId !== undefined && expected.evalId !== value.eval_id) ||
    (expected.attempt !== undefined && expected.attempt !== value.attempt)
  )
    throw new TypeError('run output provenance mismatch')
  const paths = new Set<string>(),
    names = new Set<string>()
  let total = 0
  for (const item of value.entries) {
    const entry = object(item)
    keys(entry, ['name', 'path', 'media_type', 'bytes', 'sha256'])
    if (
      !nonempty(entry.name) ||
      !nonempty(entry.path) ||
      !nonempty(entry.media_type) ||
      !sha(entry.sha256) ||
      entry.path.length > 4096 ||
      entry.path !== entry.path.normalize('NFC') ||
      [...entry.path].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === ':',
      ) ||
      entry.path.includes('\\') ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      entry.path === 'hitch-output-manifest.json' ||
      entry.path.startsWith('hitch-output-manifest.json/') ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0 ||
      (entry.bytes as number) > 16 * 1024 * 1024 ||
      paths.has(entry.path) ||
      names.has(entry.name)
    )
      throw new TypeError('invalid run output entry')
    total += entry.bytes as number
    const segments = entry.path.split('/')
    for (let i = 1; i < segments.length; i++)
      if (paths.has(segments.slice(0, i).join('/'))) throw new TypeError('overlapping run output paths')
    paths.add(entry.path)
    names.add(entry.name)
  }
  if (total > 64 * 1024 * 1024 || JSON.stringify([...paths]) !== JSON.stringify([...paths].sort()))
    throw new TypeError('invalid run output budget or ordering')
  const { digest, ...body } = value
  if (`sha256:${createHash('sha256').update(canonical(body)).digest('hex')}` !== digest)
    throw new TypeError('run output manifest digest mismatch')
  return structuredClone(value) as unknown as RunOutputManifest
}

export interface RunOutputExport {
  schema_version: '1'
  kind: 'run-output-artifacts-export'
  run_id: string
  manifest_digest: string
  destination: string
}

export function parseRunOutputExport(
  input: unknown,
  manifest: RunOutputManifest,
  destination: string,
): RunOutputExport {
  const value = object(input)
  keys(value, ['schema_version', 'kind', 'run_id', 'manifest_digest', 'destination'])
  if (
    value.schema_version !== '1' ||
    value.kind !== 'run-output-artifacts-export' ||
    value.run_id !== manifest.run_id ||
    value.manifest_digest !== manifest.digest ||
    value.destination !== destination
  )
    throw new TypeError('run output export receipt mismatch')
  return value as unknown as RunOutputExport
}

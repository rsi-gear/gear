import { canonicalDigest } from '../../domain/canonical.js'
import { GearError } from '../../domain/errors.js'

interface Artifact {
  artifact_id: string
  artifact_integrity: string
  entrypoint_integrity: string
  harness_id: string
  revision_identity: string
  platform: string
  node_version: string
  source_type: string
  storage: string
}
interface RuntimeContract {
  docker_platform: string
  artifact_platform: string
  node_version: string
}
export interface TaskArtifact {
  task_id: string
  artifact: Artifact
  runtime_contract: RuntimeContract
}
export interface HitchArtifactPin {
  platform: string
  artifact_id: string
  artifact_integrity: string
  entrypoint_integrity: string
}

/** Only the platforms used by this submission belong in its immutable request. */
export function artifactPins(bindings: TaskArtifact[], taskIds: string[]): HitchArtifactPin[] {
  const selected = bindings.filter((binding) => taskIds.includes(binding.task_id))
  check(taskIds.length && taskIds.every((id) => selected.some((binding) => binding.task_id === id)))
  const pins = new Map<string, HitchArtifactPin>()
  for (const { artifact } of selected) {
    const pin = {
      platform: artifact.platform,
      artifact_id: artifact.artifact_id,
      artifact_integrity: artifact.artifact_integrity,
      entrypoint_integrity: artifact.entrypoint_integrity,
    }
    const prior = pins.get(pin.platform)
    check(
      !prior ||
        Object.keys(pin).every(
          (key) => prior[key as keyof HitchArtifactPin] === pin[key as keyof HitchArtifactPin],
        ),
    )
    pins.set(pin.platform, pin)
  }
  return [...pins.values()].sort((a, b) => (a.platform < b.platform ? -1 : 1))
}
export interface ArtifactSelection {
  harnessRef: string
  revisionIdentity: string
  taskIds: string[]
}
interface Expected extends ArtifactSelection {
  evalId: string
  provider: string
}
function check(valid: unknown): asserts valid {
  if (!valid)
    throw new GearError(
      'hitch-artifact-identity',
      'Hitch prepared Target artifacts, task assignments and execution plan do not agree',
    )
}
function object(value: unknown): Record<string, unknown> {
  check(!!value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
function artifact(value: unknown, expected: ArtifactSelection): Artifact {
  const r = object(value),
    selector = expected.harnessRef.slice(expected.harnessRef.indexOf('@') + 1)
  check(
    digest(r.artifact_id) &&
      digest(r.artifact_integrity) &&
      digest(r.entrypoint_integrity) &&
      r.revision_identity === expected.revisionIdentity &&
      r.harness_id === expected.harnessRef.split('@')[0] &&
      ['linux-x64', 'linux-arm64'].includes(String(r.platform)) &&
      typeof r.node_version === 'string' &&
      /^v\d+\.\d+\.\d+$/u.test(r.node_version) &&
      r.source_type === (selector.startsWith('version:') ? 'npm' : 'git') &&
      r.storage === 'harbor-artifact-cache-v2',
  )
  return Object.fromEntries(
    [
      'artifact_id',
      'artifact_integrity',
      'entrypoint_integrity',
      'harness_id',
      'revision_identity',
      'platform',
      'node_version',
      'source_type',
      'storage',
    ].map((key) => [key, r[key]]),
  ) as unknown as Artifact
}
function runtime(value: unknown, prepared: Artifact): RuntimeContract {
  const r = object(value)
  check(
    r.artifact_platform === prepared.platform &&
      r.node_version === prepared.node_version &&
      r.docker_platform === (prepared.platform === 'linux-x64' ? 'linux/amd64' : 'linux/arm64'),
  )
  return {
    docker_platform: r.docker_platform as string,
    artifact_platform: prepared.platform,
    node_version: prepared.node_version,
  }
}
function tasks(value: unknown, allowed: string[], seen: Set<string>): string[] {
  check(Array.isArray(value) && value.length > 0)
  for (const task of value) {
    check(typeof task === 'string' && allowed.includes(task) && !seen.has(task))
    seen.add(task)
  }
  return value as string[]
}
export function parsePreparedArtifacts(value: unknown, expected: ArtifactSelection): TaskArtifact[] {
  const r = object(value)
  check(Array.isArray(r.prepared_artifacts) && r.prepared_artifacts.length > 0)
  const seen = new Set<string>()
  const result = r.prepared_artifacts.flatMap((value) => {
    const row = object(value),
      prepared = artifact(row, expected),
      contract = runtime(row.runtime_contract, prepared)
    return tasks(row.task_ids, expected.taskIds, seen).map((task_id) => ({
      task_id,
      artifact: prepared,
      runtime_contract: contract,
    }))
  })
  check(seen.size === expected.taskIds.length)
  if (r.prepared_artifacts.length === 1)
    check(canonicalDigest(artifact(r.prepared_artifact, expected)) === canonicalDigest(result[0]!.artifact))
  else check(r.prepared_artifact === undefined)
  assertStablePreparedArtifacts(result)
  return result.sort((a, b) => Buffer.compare(Buffer.from(a.task_id), Buffer.from(b.task_id)))
}

/** This verifies reported artifact pins, not artifact bytes or pre-execution availability. */
export function hitchPreparedArtifacts(
  inspection: Record<string, unknown>,
  expected: Expected,
): TaskArtifact[] {
  const planned = parsePreparedArtifacts(inspection.plan, expected),
    reported = parsePreparedArtifacts(inspection.result, expected)
  check(canonicalDigest(planned) === canonicalDigest(reported))
  const execution = object(inspection.execution_plan),
    seen = new Set<string>()
  check(
    execution.membership === 'known' &&
      Array.isArray(execution.work_items) &&
      execution.work_items.length > 0,
  )
  for (const value of execution.work_items) {
    const work = object(value)
    check(
      work.schema_version === '1' &&
        work.eval_id === expected.evalId &&
        work.backend === 'harbor' &&
        work.provider === expected.provider &&
        work.logical_attempt === 1 &&
        work.opaque_membership === false,
    )
    for (const task of tasks(work.task_ids, expected.taskIds, seen)) {
      const pin = planned.find((item) => item.task_id === task)!
      check(
        work.artifact_id === pin.artifact.artifact_id &&
          canonicalDigest(runtime(work.runtime_contract, pin.artifact)) ===
            canonicalDigest(pin.runtime_contract),
      )
    }
  }
  check(seen.size === expected.taskIds.length)
  return planned
}

/** Repetitions at the same runtime platform cannot silently use different installed dependencies. */
export function assertStablePreparedArtifacts(bindings: TaskArtifact[]): void {
  const platforms = new Map<string, string>()
  for (const binding of bindings) {
    const key = binding.runtime_contract.docker_platform,
      identity = canonicalDigest(binding.artifact)
    check(!platforms.has(key) || platforms.get(key) === identity)
    platforms.set(key, identity)
  }
}

/** Every accepted task must use the artifact frozen before admission. */
export function assertPreparedArtifactsMatch(observed: TaskArtifact[], frozen: TaskArtifact[]): void {
  for (const binding of observed) {
    const expected = frozen.find((value) => value.task_id === binding.task_id)
    check(expected && canonicalDigest(binding) === canonicalDigest(expected))
  }
}

import { normalize } from 'node:path'
import type {
  ChampionState,
  ComponentRef,
  EvaluationCondition,
  EvaluationEvidence,
  EvaluationRequest,
  EvolutionRegistryEntry,
  EvolutionSpec,
  HitchTrajectoryReader,
  RefineEvaluator,
  RefinementRound,
  RoundEvaluationAttempt,
} from '../types.js'
import { digestJson } from '../state/digest.js'

const SHA256 = /^sha256:[0-9a-f]{64}$/u
const SAFE_ID = /^[a-zA-Z0-9_-]+$/u
const TERMINAL_ROUNDS = new Set<RefinementRound['status']>([
  'accepted', 'rejected', 'rejected-for-substrate', 'failed',
])
const HITCH_CONFIG_FIELDS = new Set([
  'executable',
  'harnessId',
  'root',
  'model',
  'attempts',
  'maxConcurrent',
  'setupTimeoutMs',
  'terminationGraceMs',
  'maxOutputBytes',
  'maxTrajectoryOutputBytes',
  'maxTrajectoryAnalysisBytes',
  'maxTrajectoryEventsBytes',
  'trajectoryCacheEntries',
  'trajectoryCacheBytes',
  'allowUnavailableVerifierDiagnosis',
  'seeds',
  'sampling',
  'agentArgs',
  'passEnv',
  'controlPlane',
])
const HITCH_CONTROL_FIELDS = new Set([
  'mode', 'provider', 'cpuPerTrial', 'memoryPerTrial', 'buildMode', 'modelCapture', 'requireModelCapture',
])
const SUPPORTED_HITCH_PACKAGES = new Set([
  'dsh-plugin-refine',
  'dsh-plugin-refine/components',
])

export type BaselineSourcePartition = 'seed' | 'held-out'

export interface BaselineSourceRequest {
  evolutionId: string
  roundId: string
  /** Seed is always imported; held-out is opt-in. */
  partitions?: readonly BaselineSourcePartition[]
}

export interface BaselineComponentIdentity {
  kind: ComponentRef<unknown>['kind']
  id: string
  apiVersion: number
  implementation: ComponentRef<unknown>['implementation']
}

export interface BaselineTargetProjection {
  provider: {
    kind: 'rollout-provider'
    id: 'hitch-cli'
    apiVersion: 1
  }
  harnessId: string
  repetitions: number
  seeds?: number[]
  model: string
  sampling: EvolutionSpec['rollout']['sampling']
  agentConfig: EvolutionSpec['rollout']['agentConfig']
  agentArgs: string[]
  controlPlane: Record<string, unknown>
  sandboxProfileRef: string
}

export interface BaselineSourcePartitionSnapshot {
  condition: EvaluationCondition
  evidence: EvaluationEvidence
  evidenceDigest: string
  sourceAttempt: RoundEvaluationAttempt
  sourceAttemptDigest: string
  currentInvocationFingerprint?: string
}

/**
 * Spec-scoped proof that a current provider may keep using a condition digest
 * established by a validated earlier provider. It intentionally contains no
 * evaluation evidence or target commit, so later rounds and promoted targets
 * in the same immutable evolution can use the same condition namespace.
 */
export interface BaselineConditionSource {
  schemaVersion: 1
  rule: 'hitch-condition-reuse-v1'
  partitions: readonly ['seed'] | readonly ['seed', 'held-out']
  source: {
    evolutionId: string
    roundId: string
    specDigest: string
    conditionFormula: 'component-ref-v1' | 'provider-semantic-v1' | 'validated-inheritance-v1'
  }
  inheritedRolloutProviderDigest: string
  sourceProvider: BaselineComponentIdentity
  destinationProvider: BaselineComponentIdentity
  targetProjection: BaselineTargetProjection
  targetProjectionDigest: string
  parentConditionSourceDigest?: string
  digest: string
}

export interface BaselineSourceSnapshot {
  schemaVersion: 1
  source: {
    evolutionId: string
    roundId: string
    specDigest: string
    roundDigest: string
  }
  target: {
    harnessRef: string
    manifestDigest: string
  }
  conditionSource: BaselineConditionSource
  partitions: {
    seed: BaselineSourcePartitionSnapshot
    heldOut?: BaselineSourcePartitionSnapshot
  }
  artifactAccess: {
    normalizedHitchRoot: string
    probedSeedRunIds: string[]
    verifierEvidence: 'verified' | 'trajectory-only-explicit'
  }
  digest: string
}

export interface PreparedBaselineSource {
  inheritedRolloutProviderDigest: string
  conditionSource: BaselineConditionSource
  snapshot: BaselineSourceSnapshot
}

export interface BaselineSourceRegistry {
  readEntry(evolutionId: string): Promise<EvolutionRegistryEntry | undefined>
  requireSpec(evolutionId: string): Promise<EvolutionSpec>
  stateStore(evolutionId: string): {
    readRound(roundId: string): Promise<RefinementRound | undefined>
  }
}

interface CommonPreparationInput {
  newSpec: EvolutionSpec
  initialChampion: ChampionState
  evaluator: RefineEvaluator
  trajectoryReader: HitchTrajectoryReader
  /**
   * Required only when the reader does not expose HitchCliEvaluator.options.root.
   * The value identifies the root actually used by the supplied reader.
   */
  trajectoryReaderRoot?: string
  workspaceRoot: string
  allowUnavailableVerifierDiagnosis?: boolean
  signal?: AbortSignal
}

export interface PrepareBaselineSourceInput extends CommonPreparationInput {
  registry: BaselineSourceRegistry
  source: BaselineSourceRequest
}

export interface PrepareBaselineSourceFromStateInput extends CommonPreparationInput {
  source: BaselineSourceRequest
  sourceSpecDigest: string
  sourceSpec: EvolutionSpec
  sourceRound: RefinementRound
}

function fail(message: string): never {
  throw new Error(`baseline source is incompatible: ${message}`)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function assertOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length > 0) fail(`${label} has unknown semantics: ${unknown.join(', ')}`)
}

function same(left: unknown, right: unknown): boolean {
  return digestJson(left) === digestJson(right)
}

function normalizedSeeds(value: unknown): unknown {
  return Array.isArray(value) && value.length === 0 ? undefined : value
}

function componentIdentity(ref: ComponentRef<unknown>): BaselineComponentIdentity {
  return {
    kind: ref.kind,
    id: ref.id,
    apiVersion: ref.apiVersion,
    implementation: structuredClone(ref.implementation),
  }
}

function normalizeRoot(root: unknown, label: string): string {
  if (typeof root !== 'string') fail(`${label} Hitch root is missing`)
  return root.length === 0 ? '' : normalize(root)
}

function readerRoot(reader: HitchTrajectoryReader, explicit: string | undefined): string {
  if (explicit !== undefined) return normalizeRoot(explicit, 'trajectory reader')
  const options = (reader as HitchTrajectoryReader & { options?: unknown }).options
  const root = typeof options === 'object' && options !== null
    ? (options as { root?: unknown }).root
    : undefined
  return normalizeRoot(root, 'trajectory reader')
}

export function parseBaselineSourceRequest(value: unknown): BaselineSourceRequest {
  const request = value as BaselineSourceRequest
  if (typeof request !== 'object' || request === null || Array.isArray(request)) fail('selection must be an object')
  const keys = Object.keys(request)
  if (keys.some(key => key !== 'evolutionId' && key !== 'roundId' && key !== 'partitions')) {
    fail('selection has unknown fields')
  }
  if (typeof request.evolutionId !== 'string' || !SAFE_ID.test(request.evolutionId)
    || typeof request.roundId !== 'string' || !SAFE_ID.test(request.roundId)) {
    fail('selection evolutionId and roundId must be safe non-empty IDs')
  }
  const selected = request.partitions === undefined ? ['seed'] as BaselineSourcePartition[] : [...request.partitions]
  if (selected.length === 0 || selected.some(value => value !== 'seed' && value !== 'held-out')
    || new Set(selected).size !== selected.length || !selected.includes('seed')) {
    fail('partitions must be either ["seed"] or ["seed", "held-out"]')
  }
  return {
    evolutionId: request.evolutionId,
    roundId: request.roundId,
    partitions: selected.includes('held-out') ? ['seed', 'held-out'] : ['seed'],
  }
}

function partitions(request: BaselineSourceRequest): Array<BaselineSourcePartition> {
  return [...parseBaselineSourceRequest(request).partitions!]
}

function conditionFromSpec(
  spec: EvolutionSpec,
  partition: BaselineSourcePartition,
  inheritedProviderDigest?: string,
): EvaluationCondition {
  const dataset = partition === 'seed' ? spec.datasets.seed : spec.datasets.heldOut
  const identity = {
    partition,
    dataset,
    repetitions: spec.rollout.repetitions,
    ...(spec.rollout.seeds === undefined ? {} : { seeds: spec.rollout.seeds }),
    model: spec.rollout.model,
    sampling: spec.rollout.sampling,
    timeoutMs: spec.taskBudgetMs,
    rolloutProviderDigest: inheritedProviderDigest
      ?? spec.rollout.providerSemanticDigest
      ?? digestJson(spec.rollout.provider),
  }
  return { conditionId: digestJson(identity), ...identity }
}

function knownProviderSemanticDigest(spec: EvolutionSpec): string {
  const provider = spec.rollout.provider
  const config = hitchConfig(spec, 'source')
  return digestJson({
    provider: {
      kind: provider.kind,
      id: provider.id,
      apiVersion: provider.apiVersion,
      implementation: provider.implementation,
    },
    semanticConfig: { harnessId: config.harnessId },
    agentConfig: spec.rollout.agentConfig,
  })
}

function hitchConfig(spec: EvolutionSpec, label: 'source' | 'destination'): Record<string, unknown> {
  const provider = spec.rollout.provider
  if (provider.kind !== 'rollout-provider' || provider.id !== 'hitch-cli' || provider.apiVersion !== 1
    || !SUPPORTED_HITCH_PACKAGES.has(provider.implementation.package)
    || typeof provider.implementation.version !== 'string' || provider.implementation.version.length === 0
    || !SHA256.test(provider.implementation.integrity)
    || provider.configDigest !== digestJson(provider.config)) {
    fail(`${label} rollout provider is not a recognized Hitch V1 component`)
  }
  const sampler = spec.rollout.taskSampler
  if (sampler.kind !== 'task-sampler' || sampler.id !== 'dataset' || sampler.apiVersion !== 1
    || !SUPPORTED_HITCH_PACKAGES.has(sampler.implementation.package)
    || typeof sampler.implementation.version !== 'string' || sampler.implementation.version.length === 0
    || !SHA256.test(sampler.implementation.integrity)
    || sampler.configDigest !== digestJson(sampler.config)
    || !same(sampler.config, {})) {
    fail(`${label} task sampler has unknown condition semantics`)
  }
  const config = object(provider.config, `${label} Hitch config`)
  assertOnlyFields(config, HITCH_CONFIG_FIELDS, `${label} Hitch config`)
  const harnessId = config.harnessId
  const root = config.root
  const model = config.model
  const attempts = config.attempts
  const agentArgs = config.agentArgs
  const sampling = config.sampling
  if (typeof harnessId !== 'string' || harnessId.length === 0 || typeof root !== 'string'
    || model !== spec.rollout.model || attempts !== spec.rollout.repetitions
    || !Array.isArray(agentArgs) || agentArgs.some(value => typeof value !== 'string')
    || !same(sampling, spec.rollout.sampling)
    || !same(normalizedSeeds(config.seeds), normalizedSeeds(spec.rollout.seeds))
    || !same(spec.rollout.agentConfig, { agentArgs })) {
    fail(`${label} Hitch config is not bound to its frozen rollout fields`)
  }
  const control = config.controlPlane === undefined
    ? { mode: 'direct', requireModelCapture: false }
    : object(config.controlPlane, `${label} Hitch control plane`)
  assertOnlyFields(control, HITCH_CONTROL_FIELDS, `${label} Hitch control plane`)
  if ((control.mode ?? 'direct') !== 'direct') {
    fail(`${label} baseline source requires the Hitch direct control plane`)
  }
  if (control.requireModelCapture !== undefined && typeof control.requireModelCapture !== 'boolean') {
    fail(`${label} Hitch model capture requirement is invalid`)
  }
  return config
}

function targetProjection(spec: EvolutionSpec, label: 'source' | 'destination'): BaselineTargetProjection {
  const config = hitchConfig(spec, label)
  const agentArgs = [...config.agentArgs as string[]]
  const rawControl = config.controlPlane === undefined
    ? {}
    : object(config.controlPlane, 'Hitch control plane')
  const controlPlane = {
    mode: rawControl.mode ?? 'direct',
    requireModelCapture: rawControl.requireModelCapture ?? false,
    ...structuredClone(rawControl),
  }
  return {
    provider: { kind: 'rollout-provider', id: 'hitch-cli', apiVersion: 1 },
    harnessId: config.harnessId as string,
    repetitions: spec.rollout.repetitions,
    ...(spec.rollout.seeds === undefined ? {} : { seeds: [...spec.rollout.seeds] }),
    model: spec.rollout.model,
    sampling: structuredClone(spec.rollout.sampling),
    agentConfig: structuredClone(spec.rollout.agentConfig),
    agentArgs,
    controlPlane,
    sandboxProfileRef: spec.sandboxProfileRef,
  }
}

function sourceEvidence(
  round: RefinementRound,
  partition: BaselineSourcePartition,
): EvaluationEvidence | undefined {
  return partition === 'seed' ? round.baseline : round.evaluation?.heldOutBaseline
}

function sourceAttempt(
  round: RefinementRound,
  evidence: EvaluationEvidence,
): RoundEvaluationAttempt | undefined {
  return round.evaluationAttempts?.find(attempt =>
    attempt.provider === evidence.provider && attempt.evalId === evidence.evalId)
}

function validateEvidence(
  round: RefinementRound,
  partition: BaselineSourcePartition,
  condition: EvaluationCondition,
): { evidence: EvaluationEvidence; attempt: RoundEvaluationAttempt } {
  const evidence = sourceEvidence(round, partition)
  if (evidence === undefined) fail(`source round has no ${partition} baseline evidence`)
  const attempt = sourceAttempt(round, evidence)
  const phase = partition === 'seed' ? 'seed-baseline' : 'held-out-baseline'
  if (evidence.completeness !== 'complete' || evidence.invalidTrials.length !== 0
    || evidence.plannedTrialCount !== evidence.trials.length
    || attempt?.status !== 'settled'
    || attempt.phase !== phase
    || attempt.owner.role !== 'baseline'
    || attempt.owner.harnessRef !== round.targetHarnessRef
    || attempt.conditionId !== condition.conditionId
    || attempt.dataset !== condition.dataset.ref
    || attempt.requestedModelId !== condition.model
    || attempt.requestedCommit !== round.targetHarnessRef
    || evidence.conditionId !== condition.conditionId
    || evidence.dataset !== condition.dataset.ref
    || evidence.requestedCommit !== round.targetHarnessRef
    || evidence.actualCommit !== round.targetHarnessRef
    || evidence.provider !== attempt.provider) {
    fail(`source ${partition} baseline is not complete settled evidence owned by the frozen target`)
  }
  return { evidence, attempt }
}

function sourceFormula(
  spec: EvolutionSpec,
  providerDigest: string,
  projection: BaselineTargetProjection,
): {
  formula: BaselineConditionSource['source']['conditionFormula']
  parent?: BaselineConditionSource
} {
  if (spec.rollout.providerSemanticDigest === undefined) {
    if (providerDigest !== digestJson(spec.rollout.provider)) fail('legacy component-ref provider digest is forged')
    return { formula: 'component-ref-v1' }
  }
  if (spec.rollout.providerSemanticDigest !== providerDigest) {
    fail('source spec provider digest does not match its round')
  }
  if (providerDigest === knownProviderSemanticDigest(spec)) {
    return { formula: 'provider-semantic-v1' }
  }
  const value = (spec as EvolutionSpec & { baselineConditionSource?: unknown }).baselineConditionSource
  if (value !== undefined) {
    const parent = validateBaselineConditionSource(value)
    if (parent.inheritedRolloutProviderDigest === providerDigest
      && same(parent.destinationProvider, componentIdentity(spec.rollout.provider))
      && same(parent.targetProjection, projection)) {
      return { formula: 'validated-inheritance-v1', parent }
    }
  }
  fail('source provider semantic digest uses an unknown formula')
}

function validateComponentIdentity(value: unknown, label: string): BaselineComponentIdentity {
  const identity = object(value, label) as unknown as BaselineComponentIdentity
  const implementation = object(identity.implementation, `${label} implementation`)
  if (identity.kind !== 'rollout-provider' || identity.id !== 'hitch-cli' || identity.apiVersion !== 1
    || !SUPPORTED_HITCH_PACKAGES.has(implementation.package as string)
    || typeof implementation.version !== 'string' || implementation.version.length === 0
    || typeof implementation.integrity !== 'string' || !SHA256.test(implementation.integrity)) {
    fail(`${label} is not a recognized Hitch V1 identity`)
  }
  return structuredClone(identity)
}

export function validateBaselineConditionSource(value: unknown): BaselineConditionSource {
  const proof = object(value, 'baseline condition source') as unknown as BaselineConditionSource
  const source = object(proof.source, 'baseline condition source identity')
  const formula = source.conditionFormula
  const canonicalPartitions = Array.isArray(proof.partitions)
    && (same(proof.partitions, ['seed']) || same(proof.partitions, ['seed', 'held-out']))
  if (proof.schemaVersion !== 1 || proof.rule !== 'hitch-condition-reuse-v1'
    || !canonicalPartitions
    || typeof source.evolutionId !== 'string' || !SAFE_ID.test(source.evolutionId)
    || typeof source.roundId !== 'string' || !SAFE_ID.test(source.roundId)
    || typeof source.specDigest !== 'string' || !SHA256.test(source.specDigest)
    || !['component-ref-v1', 'provider-semantic-v1', 'validated-inheritance-v1'].includes(formula as string)
    || typeof proof.inheritedRolloutProviderDigest !== 'string'
    || !SHA256.test(proof.inheritedRolloutProviderDigest)
    || typeof proof.targetProjectionDigest !== 'string' || !SHA256.test(proof.targetProjectionDigest)
    || proof.targetProjectionDigest !== digestJson(proof.targetProjection)
    || (proof.parentConditionSourceDigest !== undefined
      && (typeof proof.parentConditionSourceDigest !== 'string'
        || !SHA256.test(proof.parentConditionSourceDigest)))
    || (formula === 'validated-inheritance-v1') !== (proof.parentConditionSourceDigest !== undefined)
    || typeof proof.digest !== 'string' || !SHA256.test(proof.digest)) {
    fail('condition source identity is invalid')
  }
  validateComponentIdentity(proof.sourceProvider, 'condition source provider')
  validateComponentIdentity(proof.destinationProvider, 'condition destination provider')
  const { digest, ...identity } = proof
  if (digestJson(identity) !== digest) fail('condition source digest does not match its contents')
  return structuredClone(proof)
}

function validateSnapshotPartition(value: unknown, name: BaselineSourcePartition): BaselineSourcePartitionSnapshot {
  const partition = object(value, `snapshot ${name} partition`) as unknown as BaselineSourcePartitionSnapshot
  if (!SHA256.test(partition.evidenceDigest) || partition.evidenceDigest !== digestJson(partition.evidence)
    || !SHA256.test(partition.sourceAttemptDigest)
    || partition.sourceAttemptDigest !== digestJson(partition.sourceAttempt)
    || partition.condition.partition !== name
    || partition.condition.conditionId !== partition.evidence.conditionId
    || partition.condition.dataset.ref !== partition.evidence.dataset
    || partition.sourceAttempt.phase !== (name === 'seed' ? 'seed-baseline' : 'held-out-baseline')
    || partition.sourceAttempt.status !== 'settled'
    || partition.sourceAttempt.owner.role !== 'baseline'
    || partition.sourceAttempt.provider !== partition.evidence.provider
    || partition.sourceAttempt.evalId !== partition.evidence.evalId
    || partition.sourceAttempt.conditionId !== partition.condition.conditionId
    || partition.sourceAttempt.dataset !== partition.condition.dataset.ref
    || partition.sourceAttempt.requestedModelId !== partition.condition.model
    || partition.evidence.completeness !== 'complete'
    || partition.evidence.invalidTrials.length !== 0
    || partition.evidence.plannedTrialCount !== partition.evidence.trials.length
    || (partition.currentInvocationFingerprint !== undefined
      && (typeof partition.currentInvocationFingerprint !== 'string'
        || partition.currentInvocationFingerprint.length === 0))) {
    fail(`snapshot ${name} partition is invalid`)
  }
  return structuredClone(partition)
}

export function validateBaselineSourceSnapshot(value: unknown): BaselineSourceSnapshot {
  const snapshot = object(value, 'baseline source snapshot') as unknown as BaselineSourceSnapshot
  if (snapshot.schemaVersion !== 1
    || typeof snapshot.source !== 'object' || snapshot.source === null
    || !SAFE_ID.test(snapshot.source.evolutionId) || !SAFE_ID.test(snapshot.source.roundId)
    || !SHA256.test(snapshot.source.specDigest) || !SHA256.test(snapshot.source.roundDigest)
    || typeof snapshot.target !== 'object' || snapshot.target === null
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(snapshot.target.harnessRef)
    || !SHA256.test(snapshot.target.manifestDigest)
    || typeof snapshot.artifactAccess !== 'object' || snapshot.artifactAccess === null
    || typeof snapshot.artifactAccess.normalizedHitchRoot !== 'string'
    || !Array.isArray(snapshot.artifactAccess.probedSeedRunIds)
    || snapshot.artifactAccess.probedSeedRunIds.length === 0
    || new Set(snapshot.artifactAccess.probedSeedRunIds).size !== snapshot.artifactAccess.probedSeedRunIds.length
    || !['verified', 'trajectory-only-explicit'].includes(snapshot.artifactAccess.verifierEvidence)
    || !SHA256.test(snapshot.digest)) {
    fail('snapshot identity is invalid')
  }
  const conditionSource = validateBaselineConditionSource(snapshot.conditionSource)
  if (conditionSource.source.evolutionId !== snapshot.source.evolutionId
    || conditionSource.source.roundId !== snapshot.source.roundId
    || conditionSource.source.specDigest !== snapshot.source.specDigest) {
    fail('snapshot condition proof is not bound to its source round')
  }
  const seed = validateSnapshotPartition(snapshot.partitions?.seed, 'seed')
  const heldOut = snapshot.partitions?.heldOut === undefined
    ? undefined
    : validateSnapshotPartition(snapshot.partitions.heldOut, 'held-out')
  if ((conditionSource.partitions.length === 2) !== (heldOut !== undefined)) {
    fail('snapshot partitions do not match the sealed source selection')
  }
  const seedRunIds = new Set(seed.evidence.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId]))
  if (snapshot.artifactAccess.probedSeedRunIds.some(runId => !seedRunIds.has(runId))) {
    fail('snapshot artifact probe is not bound to seed evidence')
  }
  for (const partition of [seed, heldOut].filter(value => value !== undefined)) {
    if (partition.condition.rolloutProviderDigest !== conditionSource.inheritedRolloutProviderDigest
      || partition.sourceAttempt.owner.harnessRef !== snapshot.target.harnessRef
      || partition.sourceAttempt.requestedCommit !== snapshot.target.harnessRef
      || partition.evidence.requestedCommit !== snapshot.target.harnessRef
      || partition.evidence.actualCommit !== snapshot.target.harnessRef) {
      fail('snapshot evidence is not bound to its condition proof and target')
    }
  }
  const { digest, ...identity } = snapshot
  if (digestJson(identity) !== digest) fail('snapshot digest does not match its contents')
  return structuredClone({
    ...snapshot,
    conditionSource,
    partitions: { seed, ...(heldOut === undefined ? {} : { heldOut }) },
  })
}

async function verifyIdentity(
  evaluator: RefineEvaluator,
  round: RefinementRound,
  condition: EvaluationCondition,
  evidence: EvaluationEvidence,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (evaluator.evaluationIdentity === undefined) fail('current evaluator cannot resolve evidence identity')
  const request: EvaluationRequest = {
    phase: condition.partition === 'seed' ? 'seed-baseline' : 'held-out-baseline',
    dataset: condition.dataset.ref,
    harnessRef: round.targetHarnessRef,
    condition,
  }
  const identityRound = {
    ...round,
    workspaceRoot,
    sandboxProfileRef: round.sandboxProfileRef,
  }
  const identity = await evaluator.evaluationIdentity(identityRound, request, signal)
  signal.throwIfAborted()
  if (identity === undefined
    || identity.provider !== evidence.provider
    || identity.effectiveConfigDigest !== evidence.effectiveConfigDigest) {
    fail(`current evaluator does not recognize source ${condition.partition} evidence`)
  }
  return identity.invocationFingerprint
}

function trialReward(evidence: EvaluationEvidence, runId: string): number | undefined {
  const trial = evidence.trials.find(value => value.runId === runId)
  return trial === undefined ? undefined : trial.rewards.reward ?? Object.values(trial.rewards)[0]
}

async function probeSeedArtifacts(
  evidence: EvaluationEvidence,
  reader: HitchTrajectoryReader,
  configuredRoot: string,
  expectedRoot: string,
  allowUnavailableVerifierDiagnosis: boolean,
  signal: AbortSignal,
): Promise<BaselineSourceSnapshot['artifactAccess']> {
  if (configuredRoot !== expectedRoot) fail('trajectory reader is bound to a different Hitch root')
  const allRunIds = evidence.trials.flatMap(trial => trial.runId === undefined ? [] : [trial.runId])
  const failedTrials = evidence.trials.filter(trial =>
    (trial.rewards.reward ?? Object.values(trial.rewards)[0] ?? 0) <= 0)
  if (failedTrials.some(trial => trial.runId === undefined)) {
    fail('failed seed evidence has no trajectory run ID')
  }
  const required = failedTrials.map(trial => trial.runId!)
  const selected = required.length > 0 ? [...new Set(required)] : allRunIds.slice(0, 1)
  if (selected.length === 0) fail('seed evidence has no run ID for artifact availability verification')

  const capabilities = await reader.inspectCapabilities(signal)
  signal.throwIfAborted()
  if (capabilities.schemaVersion !== 1 || capabilities.trajectoryAnalysis !== 1
    || capabilities.trajectoryEventsPage !== 1) {
    fail('current Hitch reader does not expose known bounded trajectory capabilities')
  }
  const verifierAvailable = capabilities.verifierEvidence === 1
    && typeof reader.inspectVerifierEvidence === 'function'
  if (!verifierAvailable && !allowUnavailableVerifierDiagnosis) {
    fail('current Hitch reader cannot verify source run ownership')
  }

  let verifierEvidence: BaselineSourceSnapshot['artifactAccess']['verifierEvidence'] = verifierAvailable
    ? 'verified'
    : 'trajectory-only-explicit'
  for (const runId of selected) {
    const analysis = await reader.inspectTrajectoryAnalysis(runId, signal)
    signal.throwIfAborted()
    if (analysis.schemaVersion !== 1 || analysis.kind !== 'trajectory-analysis'
      || analysis.runId !== runId || analysis.coverage.surface !== 'complete') {
      fail(`source trajectory is unavailable or incomplete: ${runId}`)
    }
    if (!verifierAvailable) continue
    const verifier = await reader.inspectVerifierEvidence!(runId, signal)
    signal.throwIfAborted()
    const trial = evidence.trials.find(value => value.runId === runId)!
    if (verifier.runId !== runId || verifier.parent === undefined
      || verifier.parent.evalId !== evidence.evalId
      || (trial.trialName !== undefined && verifier.parent.trialId !== trial.trialName)
      || (trial.attempt !== undefined && verifier.parent.attempt !== trial.attempt)
      || verifier.verifier.status === 'corrupt'
      || ((verifier.verifier.status === 'missing' || verifier.verifier.status === 'unavailable')
        && !allowUnavailableVerifierDiagnosis)) {
      fail(`source trajectory ownership or verifier evidence is invalid: ${runId}`)
    }
    if (verifier.verifier.status === 'missing' || verifier.verifier.status === 'unavailable') {
      verifierEvidence = 'trajectory-only-explicit'
    }
    // Reading a successful trial is only an availability probe. Failed trials
    // remain mandatory diagnostic inputs and must retain their recorded reward.
    if (required.includes(runId) && trialReward(evidence, runId) === undefined) {
      fail(`failed seed evidence has no recorded reward: ${runId}`)
    }
  }
  return {
    normalizedHitchRoot: expectedRoot,
    probedSeedRunIds: selected,
    verifierEvidence,
  }
}

export async function prepareBaselineSource(
  input: PrepareBaselineSourceInput,
): Promise<PreparedBaselineSource> {
  const selected = partitions(input.source)
  if (input.source.evolutionId === input.newSpec.evolutionId) fail('source and destination evolution must differ')
  const entry = await input.registry.readEntry(input.source.evolutionId)
  if (entry === undefined) fail(`unknown source evolution: ${input.source.evolutionId}`)
  const [sourceSpec, sourceRound] = await Promise.all([
    input.registry.requireSpec(input.source.evolutionId),
    input.registry.stateStore(input.source.evolutionId).readRound(input.source.roundId),
  ])
  if (sourceRound === undefined) fail(`unknown source round: ${input.source.roundId}`)
  return prepareBaselineSourceFromState({
    ...input,
    source: { ...input.source, partitions: selected },
    sourceSpecDigest: entry.specDigest,
    sourceSpec,
    sourceRound,
  })
}

export async function prepareBaselineSourceFromState(
  input: PrepareBaselineSourceFromStateInput,
): Promise<PreparedBaselineSource> {
  const selected = partitions(input.source)
  const signal = input.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const sourceSpec = structuredClone(input.sourceSpec)
  const sourceRound = structuredClone(input.sourceRound)
  const newSpec = structuredClone(input.newSpec)

  if (input.source.evolutionId === newSpec.evolutionId) fail('source and destination evolution must differ')
  if (sourceSpec.evolutionId !== input.source.evolutionId
    || sourceRound.evolutionId !== input.source.evolutionId
    || sourceRound.roundId !== input.source.roundId
    || !SHA256.test(input.sourceSpecDigest)
    || digestJson(sourceSpec) !== input.sourceSpecDigest) {
    fail('source registry, spec, and round identity do not agree')
  }
  if (!TERMINAL_ROUNDS.has(sourceRound.status)
    || sourceRound.pendingEvaluationRerun !== undefined
    || (sourceRound.pendingEvaluationSubmissions?.length ?? 0) > 0
    || sourceRound.evaluationRepairResume !== undefined) {
    fail('source round is not durably terminal')
  }
  if (newSpec.initialHarness.ref !== input.initialChampion.ref
    || newSpec.initialHarness.digest !== input.initialChampion.manifestDigest
    || sourceRound.targetHarnessRef !== input.initialChampion.ref
    || sourceRound.targetHarnessDigest !== input.initialChampion.manifestDigest) {
    fail('source target commit and manifest must equal the new initial champion')
  }
  if (sourceRound.seedTaskRef !== sourceSpec.datasets.seed.ref
    || sourceRound.heldOutRef !== sourceSpec.datasets.heldOut.ref
    || sourceRound.taskBudgetMs !== sourceSpec.taskBudgetMs
    || sourceRound.sandboxProfileRef !== sourceSpec.sandboxProfileRef
    || !same(sourceRound.plan.taskSampler, sourceSpec.rollout.taskSampler)) {
    fail('source round is not bound to its frozen Target spec')
  }
  const expectedPlanIdentity = {
    roundId: sourceRound.roundId,
    taskSampler: sourceRound.plan.taskSampler,
    seed: sourceRound.plan.seed,
    heldOut: sourceRound.plan.heldOut,
  }
  if (sourceRound.plan.planId !== `${sourceRound.roundId}-plan`
    || sourceRound.plan.digest !== digestJson(expectedPlanIdentity)) {
    fail('source round plan digest is invalid')
  }

  const sourceConfig = hitchConfig(sourceSpec, 'source')
  const destinationConfig = hitchConfig(newSpec, 'destination')
  const normalizedSourceRoot = normalizeRoot(sourceConfig.root, 'source')
  const normalizedDestinationRoot = normalizeRoot(destinationConfig.root, 'destination')
  if (normalizedSourceRoot !== normalizedDestinationRoot) {
    fail('source and destination Hitch roots differ')
  }
  const normalizedReaderRoot = readerRoot(input.trajectoryReader, input.trajectoryReaderRoot)
  const sourceProjection = targetProjection(sourceSpec, 'source')
  const destinationProjection = targetProjection(newSpec, 'destination')
  if (!same(sourceProjection, destinationProjection)) {
    fail('source and destination Target parameters differ')
  }

  const preparedPartitions: Partial<Record<BaselineSourcePartition, BaselineSourcePartitionSnapshot>> = {}
  let formula: BaselineConditionSource['source']['conditionFormula'] | undefined
  let parentConditionSource: BaselineConditionSource | undefined
  let inheritedRolloutProviderDigest: string | undefined

  for (const partition of selected) {
    const sourceCondition = conditionFromSpec(sourceSpec, partition)
    const recordedCondition = partition === 'seed' ? sourceRound.plan.seed : sourceRound.plan.heldOut
    if (!same(sourceCondition, recordedCondition)) fail(`source ${partition} condition is forged or uses unknown semantics`)
    inheritedRolloutProviderDigest ??= recordedCondition.rolloutProviderDigest
    if (recordedCondition.rolloutProviderDigest !== inheritedRolloutProviderDigest) {
      fail('selected source partitions disagree on rollout provider identity')
    }
    const { evidence, attempt } = validateEvidence(sourceRound, partition, recordedCondition)
    const recognized = sourceFormula(sourceSpec, recordedCondition.rolloutProviderDigest, sourceProjection)
    if (formula !== undefined && formula !== recognized.formula) {
      fail('selected source partitions use different condition formulas')
    }
    formula = recognized.formula
    if (recognized.parent !== undefined) {
      parentConditionSource ??= recognized.parent
      if (parentConditionSource.digest !== recognized.parent.digest) {
        fail('selected source partitions have different inherited provenance')
      }
    }

    const destinationCondition = conditionFromSpec(newSpec, partition, inheritedRolloutProviderDigest)
    if (!same(destinationCondition, recordedCondition)) {
      fail(`destination ${partition} condition cannot inherit the verified source identity`)
    }
    const currentInvocationFingerprint = await verifyIdentity(
      input.evaluator,
      { ...sourceRound, sandboxProfileRef: newSpec.sandboxProfileRef },
      destinationCondition,
      evidence,
      input.workspaceRoot,
      signal,
    )
    preparedPartitions[partition] = {
      condition: structuredClone(recordedCondition),
      evidence: structuredClone(evidence),
      evidenceDigest: digestJson(evidence),
      sourceAttempt: structuredClone(attempt),
      sourceAttemptDigest: digestJson(attempt),
      ...(currentInvocationFingerprint === undefined ? {} : { currentInvocationFingerprint }),
    }
  }

  const seed = preparedPartitions.seed
  if (seed === undefined || formula === undefined || inheritedRolloutProviderDigest === undefined) {
    fail('seed baseline preparation is incomplete')
  }
  const artifactAccess = await probeSeedArtifacts(
    seed.evidence,
    input.trajectoryReader,
    normalizedReaderRoot,
    normalizedSourceRoot,
    input.allowUnavailableVerifierDiagnosis === true,
    signal,
  )
  const conditionSourceIdentity = {
    schemaVersion: 1 as const,
    rule: 'hitch-condition-reuse-v1' as const,
    partitions: (selected.includes('held-out') ? ['seed', 'held-out'] : ['seed']) as
      ['seed', 'held-out'] | ['seed'],
    source: {
      evolutionId: input.source.evolutionId,
      roundId: input.source.roundId,
      specDigest: input.sourceSpecDigest,
      conditionFormula: formula,
    },
    inheritedRolloutProviderDigest,
    sourceProvider: componentIdentity(sourceSpec.rollout.provider),
    destinationProvider: componentIdentity(newSpec.rollout.provider),
    targetProjection: sourceProjection,
    targetProjectionDigest: digestJson(sourceProjection),
    ...(parentConditionSource === undefined ? {} : { parentConditionSourceDigest: parentConditionSource.digest }),
  }
  const conditionSource = validateBaselineConditionSource({
    ...conditionSourceIdentity,
    digest: digestJson(conditionSourceIdentity),
  })
  const existingConditionSource = (newSpec as EvolutionSpec & { baselineConditionSource?: unknown })
    .baselineConditionSource
  if (existingConditionSource !== undefined
    && validateBaselineConditionSource(existingConditionSource).digest !== conditionSource.digest) {
    fail('destination spec carries a different baseline condition source')
  }

  const identity = {
    schemaVersion: 1 as const,
    source: {
      evolutionId: input.source.evolutionId,
      roundId: input.source.roundId,
      specDigest: input.sourceSpecDigest,
      roundDigest: digestJson(sourceRound),
    },
    target: {
      harnessRef: sourceRound.targetHarnessRef,
      manifestDigest: sourceRound.targetHarnessDigest,
    },
    conditionSource,
    partitions: {
      seed,
      ...(preparedPartitions['held-out'] === undefined
        ? {}
        : { heldOut: preparedPartitions['held-out'] }),
    },
    artifactAccess,
  }
  const snapshot: BaselineSourceSnapshot = {
    ...identity,
    digest: digestJson(identity),
  }
  return {
    inheritedRolloutProviderDigest,
    conditionSource,
    snapshot: validateBaselineSourceSnapshot(snapshot),
  }
}

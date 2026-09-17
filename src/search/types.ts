/** Versioned contracts for explicitly opted-in evolutions. Legacy records are unchanged. */
export type Partition = 'seed' | 'held-out'
export type ProcessMode = 'off' | 'auto' | 'required'
export type Bucket = 'local' | 'shared' | 'cross'
export type Stage = 'baseline-probe' | 'local' | 'bridge' | 'global-seed' | 'held-out'
export interface MetricContract {
  id: string
  revision: string
  digest: string
  channel: 'outcome' | 'process'
  evidenceKind: 'final-outcome' | 'final-state-partial-credit' | 'trajectory'
  granularity: 'dataset-aggregate' | 'trial' | 'component'
  direction: 'maximize' | 'minimize'
  range?: { min: number; max: number }
  normalization?: { kind: 'fixed-linear'; min: number; max: number }
  comparisonQuantum: number
  repetitionReducer: 'mean'
  applicableTaskSetDigest: string
  /** Equal group IDs assert equal utility units, including after normalization. */
  group: string
}
export type MetricObservation =
  | { status: 'available'; rawValue: number; contractDigest: string; evidenceRef: string }
  | { status: 'unsupported' | 'not-applicable'; declarationDigest: string }
  | { status: 'missing' | 'invalid'; contractDigest: string; reason: string }
export interface SearchTask {
  id: string
  contentDigest: string
  outcome: MetricContract
  process?: MetricContract
  successUtility: number
  weight: number
  stratum: string
  estimatedCost: number
  /** Optional per-task subset of the frozen logical repetition manifest. */
  repetitionIndices?: number[]
  regressionTemplate?: Omit<import('./regression.js').RegressionInput, 'source' | 'outcome'>
}
export interface TaskUniverse {
  partition: Partition
  tasks: SearchTask[]
  /** Covers execution environment, model, sampling, scorer and per-task budgets. */
  conditionDigest: string
  repetitions: Array<{ index: number; seed: number | null }>
  digest: string
  regressionSuiteDigest?: string
  /** Immutable suite included only when admitting a new seed universe. */
  regressionSuite?: import('./regression.js').RegressionSuite
}
export interface TaskSetLimit { ratio: number; minTasks?: number | null; maxTasks?: number | null }
export interface TaskSetSizing {
  basis: 'seed-universe'
  rounding: 'ceil'
  local: TaskSetLimit
  shared: TaskSetLimit
  cross: TaskSetLimit
  bridge: TaskSetLimit
}
export interface TaskSetResolution {
  universeDigest: string
  universeSize: number
  config: TaskSetSizing
  quantities: Record<Bucket | 'bridge', { requested: number; resolved: number; reasons: string[] }>
  digest: string
}
export interface TaskGuard {
  taskId: string
  partition: Partition
  rule: 'no-regression' | 'minimum-score' | 'must-pass'
  minimumUtility?: number
}
export interface AssertionGuard {
  taskId: string
  partition: Partition
  assertionId: string
  schemaDigest: string
  rule: 'must-pass' | 'no-new-violation'
}
export interface MetricThresholds { minimumGain: number; maxSeedRegression: number; maxHeldOutRegression: number }
export interface MultisignalPromotionConfig {
  policy: 'paired-multisignal-v1'
  validationMode: 'independent-held-out' | 'shared-set-research'
  /** Explicit authorization to update the research champion on a shared task set. */
  allowSharedSetPromotion?: boolean
  outcome: MetricThresholds
  process: MetricThresholds & { mode: ProcessMode; groups?: Record<string, MetricThresholds> }
  allowNeutral: boolean
  protectedTasks: TaskGuard[]
  protectedAssertions: AssertionGuard[]
}
export interface SearchConfig {
  mode: 'failure-cluster-gepa-v1'
  seed: number
  parentBatchCount: number
  parentSampling: 'scoped-frontier-membership-v1' | 'epsilon-greedy-gepa-v1'
  /** A registered strategy overrides the legacy parentSampling preset. */
  parentPolicy?: import('../types.js').ComponentRef<unknown>
  /** Direct champion branch probability; GEPA exploration may also select it. Defaults to 0.5. */
  championProbability?: number
  scopeWeights: 'uniform-by-family'
  archiveCoverage: 'complete-scope'
  diagnosis: { sharing: 'parent-evidence-dossier'; planner: 'evidence-failure-clusters-v1'; candidatesPerFamily: number }
  taskSetSizing: TaskSetSizing
  scopeSampling: { bucketWeights: Record<Bucket, number>; epochPolicy: 'stable' | 'periodic'; updateEveryRounds?: number; maxHistoricalSpecialists?: number; sharedCoreTaskIds?: string[] }
  evaluationStages: {
    bridge: { maxCandidates: number; groupAllocation: 'weighted-round-robin'; taskSelection: 'nominated-scopes-union-then-stratified' }
    globalSeed: { maxCandidates: 1 }
    reuseValidCells: true
  }
  process: { mode: ProcessMode; parentBudgetFraction: number }
  globalTaskWeights: 'uniform'
  explorationGuards: TaskGuard[]
}
export interface BudgetLimits {
  maxNewRolloutCells: number
  maxDiagnosisInputTokens: number
  maxDiagnosisOutputTokens: number
  /** Omit when the external Meta runtime cannot enforce this resource. Explicit numbers are hard limits. */
  maxGenerationTokens?: number
  maxGenerationRequests?: number
  maxRepairCells: number
  timeoutMs: number
}
export interface SearchSettings {
  search: SearchConfig
  promotion: MultisignalPromotionConfig
  budgets: { round: BudgetLimits; evolution: BudgetLimits }
  regression: { collectFailures: boolean; maxProposals: number; suiteRef?: string | null }
}
export interface Snapshot {
  candidateId: string
  commit: string
  tree: string
  manifestDigest: string
  parentIds: string[]
  /** Seed-only, readable handoff. Never a held-out result or an empty checkpoint. */
  findingRefs: string[]
  digest: string
}
export interface EvaluationScope {
  familyId: string
  epoch: number
  universeDigest: string
  taskSetSizeResolutionDigest: string
  buckets: Record<Bucket, string[]>
  taskIds: string[]
  weights: Record<string, number>
  guards: TaskGuard[]
  sampling: Record<Bucket, { requested: number; selected: number; reasons: string[] }>
  samplingEvidenceDigest?: string
  /** Excludes family label, preventing renamed duplicate scopes from increasing probability. */
  equivalenceDigest: string
  digest: string
}
export interface CellIdentity {
  taskId: string
  taskContentDigest: string
  repetition: number
  seed: number | null
  conditionDigest: string
  outcomeContractDigest: string
  processContractDigest?: string
  harnessCommit: string
  harnessManifestDigest: string
  /** Originating record, retained for provenance; role/lineage labels do not create a new execution slot. */
  snapshotDigest: string
}
export interface EvidenceCell {
  identity: CellIdentity
  status: 'available' | 'missing' | 'invalid'
  outcome: MetricObservation
  process?: MetricObservation
  assertions?: Array<{ id: string; schemaDigest: string; status: 'passed' | 'failed' | 'excluded' }>
  /** Legacy invalid observations cannot be rescued using embedded numeric values. */
  envelope: 'legacy-v1' | 'score-envelope-v2'
  outcomeCertified: boolean
  evidenceRef: string
  completedAt: string
  digest: string
}
export interface StageEvaluationPlan {
  stage: Stage
  partition: Partition
  universeDigest: string
  taskSetSizeResolutionDigest: string
  scopeDigest: string
  taskIds: string[]
  participantIds: string[]
  prerequisiteDecisionDigests: string[]
  selectionRuleDigest: string
  digest: string
}
export interface StageResult {
  stagePlanDigest: string
  snapshotDigest: string
  cells: EvidenceCell[]
  settled: boolean
  supersedesEvidenceDigest?: string
  failure?: SearchStageFailure
  digest: string
}
export interface EvaluationStageDecision {
  stagePlanDigest: string
  candidateId: string
  outcome: 'advance' | 'retained-local' | 'ineligible' | 'insufficient-evidence'
  reasonCodes: string[]
  supportDigest: string
  nextStagePlanDigest?: string
  digest: string
}
/** Seed-only, rebuildable status projection; held-out evidence is never included. */
export interface SearchProgress {
  phase: 'bootstrap' | 'scope-preparation' | 'diagnosis-planning' | 'generation' | 'local' | 'bridge' | 'global-seed' | 'seed-research-complete'
  evaluations: Array<{
    stage: Exclude<Stage, 'held-out'>
    stagePlanDigest: string
    scopeDigest: string
    candidateId: string
    state: 'running' | 'settled'
    plannedCells: number
    profile?: Pick<EvidenceProfile, 'coverage' | 'processCoverage' | 'outcomeComplete' | 'processComplete' | 'processTaskIds' | 'tasks' | 'supportDigest'>
    failure?: SearchStageFailure
  }>
  decisions: EvaluationStageDecision[]
}
export interface SearchStageFailure {
  kind: 'execution-failure' | 'budget-exhausted'
  code: string
  message: string
  evidenceRef?: string
}
export interface PendingSearchOperation {
  operationKey: string
  kind: 'evaluation' | 'diagnosis' | 'generation'
  partition: Partition
  stagePlanDigest: string
  candidateId: string
  state: 'running' | 'unknown' | 'not-started' | 'partially-complete'
  handle?: string
  reason: string
}
export interface EvaluationExecutionResult {
  cells: EvidenceCell[]
  failure?: SearchStageFailure
}
export type ExternalRecovery<T> =
  | { status: 'complete'; result: T }
  | { status: 'not-started' }
  /** Evaluation cells are durable; every remaining batch is verified not started, with no unresolved submission. */
  | { status: 'partially-complete'; cells: EvidenceCell[] }
  | { status: 'running'; handle: string }
  | { status: 'unknown'; reason?: string }
export interface BridgeSelectionDecision {
  plan?: StageEvaluationPlan
  skipped: string[]
  exclusions: Array<{ candidateId: string; scopeDigest: string; reason: 'group-quota' | 'bridge-disabled' | 'bridge-capacity' | 'bridge-budget' }>
}
export interface EvidenceConsumption {
  stagePlanDigest: string
  snapshotDigest: string
  resultDigest: string
  consumerDigest: string
  consumer: 'bootstrap-archive' | 'diagnosis' | 'workplans' | 'local-decision' | 'nomination' | 'research-archive' | 'scope-preparation'
  digest: string
}
export interface Coverage {
  planned: number; available: number; paired: number; pending: number; missing: number; invalid: number
  notEvaluated: number
}
export interface TaskProfile {
  taskId: string
  outcome?: number
  process?: number
  outcomeKey?: string
  processKey?: string
}
export interface EvidenceProfile {
  universeDigest: string
  stagePlanDigest: string
  scopeDigest: string
  snapshotDigest: string
  coverage: Coverage
  processCoverage: Coverage
  outcomeComplete: boolean
  processComplete: boolean
  processTaskIds: string[]
  tasks: TaskProfile[]
  outcome?: number
  outcomeKey?: string
  processGroups: Record<string, number>
  processGroupKeys: Record<string, string>
  supportDigest: string
}
export interface DiagnosisFact {
  taskId: string
  evidenceRefs: string[]
  status: 'supported-hypothesis' | 'unresolved' | 'infrastructure-invalid' | 'successful-control'
  familyId?: string
  hypothesis?: string
  modificationPaths?: string[]
  mechanism?: string
  submode?: string
}
export interface DiagnosisDossier {
  failure?: SearchStageFailure
  parentSnapshotDigest: string
  universeDigest: string
  taskIds: string[]
  baselineEvidenceDigests: string[]
  facts: DiagnosisFact[]
  classifierIntegrity: string
  sanitizationPolicyDigest: string
  digest: string
}
export interface DossierExcerpt {
  sourceDossierDigest: string
  parentSnapshotDigest: string
  baselineEvidenceDigests: string[]
  facts: DiagnosisFact[]
  classifierIntegrity: string
  sanitizationPolicyDigest: string
  digest: string
}
export interface FailureCluster {
  familyId: string
  parentSnapshotDigest: string
  dossierDigest: string
  taskIds: string[]
  evidenceRefs: string[]
  hypotheses: string[]
  modificationPaths: string[]
  taskFeatures?: Array<{ taskId: string; submodes: string[]; modificationPaths: string[] }>
  successfulControlTaskIds?: string[]
  protectedFailure: boolean
  estimatedCost: number
  digest: string
}
export interface ScopeSamplingEvidence {
  universeDigest: string
  cutoffDigest: string
  clusterDigests: string[]
  tasks: Record<string, { familyIds: string[]; submodes: string[]; modificationPaths: string[]; historicalDifficulty?: number }>
  digest: string
}
export interface StageParticipantBinding {
  stagePlanDigest: string
  participantId: string
  sealedSnapshotDigest: string
  digest: string
}
export interface CandidateWorkPlan {
  candidateId: string
  batchId: string
  parentSnapshotDigest: string
  dossierDigest: string
  clusterDigest: string
  familyId: string
  hypothesis: string
  targetTaskIds: string[]
  requiredDiagnosisRefs: string[]
  modificationPaths: string[]
  scopeDigest: string
  localStagePlanDigest: string
  modificationBoundaryRule: { requiredSeedTaskIds: string[]; onInsufficientScope: 'retain-research-only' }
  generationBudget: { maxTokens?: number; maxModelRequests?: number; deadlineAt: number }
  digest: string
}
export interface WorkplanReceipt {
  kind: 'workplan-dossier-consumed'
  candidateId: string
  sessionId: string
  workplanDigest: string
  dossierDigest: string
  deliveredDigest: string
  accessedRefs: string[]
  digest: string
}
export interface ResearchFinding {
  candidateId: string
  parentSnapshotDigest: string
  hypothesis: string
  scopeDigest: string
  changedPaths: string[]
  improvements: string[]
  regressions: string[]
  unverifiedTaskIds: string[]
  workflowAdoption: 'unknown'
  supportDigest: string
  nextSteps: string[]
  digest: string
}
export interface ScopeView {
  scopeDigest: string
  outcomeEligibleIds: string[]
  processEligibleIds: string[]
  fronts: Array<{ taskId: string; channel: 'outcome' | 'process'; candidateIds: string[]; informative: boolean }>
  representatives: Record<string, string>
  prunedIds: string[]
  conditionalParentProbabilities: Record<string, number>
  pendingEvidenceIds: string[]
  ineligibleIds: string[]
  digest: string
}
export interface ResearchArchive {
  schemaVersion: 1
  evolutionId: string
  revision: number
  universeDigest: string
  snapshots: Snapshot[]
  scopes: EvaluationScope[]
  /** Only seed evidence is accepted by the archive builder. */
  results: StageResult[]
  plans: StageEvaluationPlan[]
  scopeViews: ScopeView[]
  scopeProbabilities: Record<string, number>
  parentProbabilities: Record<string, number>
  /** Present only for the opt-in champion/GEPA mixture. Scope views retain their GEPA weights. */
  parentMixture?: {
    strategy: 'epsilon-greedy-gepa-v1'
    championId: string
    championProbability: number
    championScopeDigest: string
    explorationParentProbabilities: Record<string, number>
  }
  activeParentIds: string[]
  digest: string
  /** Only committed parent seed diagnoses can influence later scope sampling. */
  clusters: FailureCluster[]
}
export interface ParentBatch {
  batchId: string
  sourceScopeDigest: string
  parentSnapshotDigest: string
  maxCandidateSlots: number
  drawIndex: number
  selectionBranch?: 'champion' | 'gepa'
}
export interface ParentPolicyAudit {
  ref: import('../types.js').ComponentRef<unknown>
  inputDigest: string
  parentProbabilities: Record<string, number>
  reasonCodes: string[]
}
export interface ParentSelectionDecision {
  archiveDigest: string
  algorithmRef: 'sha256-counter-v1'
  policy?: ParentPolicyAudit
  randomSeed: string
  batches: ParentBatch[]
  digest: string
}
export interface GateDecision {
  outcome: 'eligible' | 'accepted' | 'rejected' | 'insufficient-evidence'
  reasonCodes: string[]
  supportDigest: string
  metricContractDigests: string[]
  comparison: { outcomeGain?: number; processGains: Record<string, number>; constraintCoverage: 'available' | 'unavailable' }
  digest: string
}
export interface SearchProvider {
  integrity: string
  capabilities: { taskSubsetPlans: boolean; batchIndependentCells: boolean; idempotentExecution: boolean }
  describe(partition: Partition): Promise<TaskUniverse>
  /** Idempotent key identifies one invocation, including across controller crashes. */
  evaluate(input: { plan: StageEvaluationPlan; snapshot: Snapshot; cells: CellIdentity[]; idempotencyKey: string; signal: AbortSignal }): Promise<EvidenceCell[]>
  /** Read-only recovery: must never create or restart a Target run, including after its deadline. */
  inspectEvaluation?(input: { plan: StageEvaluationPlan; snapshot: Snapshot; cells: CellIdentity[]; idempotencyKey: string; signal: AbortSignal }): Promise<ExternalRecovery<EvaluationExecutionResult>>
  /** Verifies provider provenance as well as identity, before any reuse or scoring. */
  verifyCell(cell: EvidenceCell, identity: CellIdentity): boolean | Promise<boolean>
  /** Recover process only from the original run artifacts; must never execute another Target run. */
  completeProcess?(cell: EvidenceCell, idempotencyKey: string, signal: AbortSignal): Promise<EvidenceCell>
  /** Read-only lookup of the original process projection operation. */
  inspectProcess?(cell: EvidenceCell, idempotencyKey: string, signal: AbortSignal): Promise<ExternalRecovery<EvaluationExecutionResult>>
  verifyRegressionSuite?(suiteDigest: string, universe: TaskUniverse): boolean | Promise<boolean>
}
export interface DiagnosisProvider {
  integrity: string
  sanitizationPolicyDigest: string
  diagnose(input: { snapshot: Snapshot; universe: TaskUniverse; taskIds: string[]; cells: EvidenceCell[]; idempotencyKey: string; maxInputTokens: number; maxOutputTokens: number; signal: AbortSignal }): Promise<{ facts: DiagnosisFact[]; inputTokens: number; outputTokens: number }>
  /** Reads an existing classifier operation without initiating another model request. */
  inspectDiagnosis?(idempotencyKey: string, signal: AbortSignal): Promise<ExternalRecovery<{ facts: DiagnosisFact[]; inputTokens: number; outputTokens: number; failure?: SearchStageFailure }>>
}

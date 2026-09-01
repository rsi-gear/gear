import Schema from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ChampionState, MetaSamplingConfig, PromotionPolicy, RolloutSamplingConfig } from './types.js'

export interface HitchConfig {
  executable: string
  harnessId: string
  root: string
  model: string
  attempts: number
  maxConcurrent: number
  setupTimeoutMs: number
  terminationGraceMs: number
  maxOutputBytes: number
  maxTrajectoryOutputBytes: number
  seeds?: number[]
  sampling: RolloutSamplingConfig
  agentArgs: string[]
  passEnv: string[]
}

export interface Config {
  workspaceRoot: string
  dshRepository: string
  targetRoot: string
  stateRoot?: string
  metaPreset: string
  metaModel: AgentOptions
  metaSampling: MetaSamplingConfig
  metaAdapter: {
    kind: 'dsh' | 'skill'
    runtimeType?: string
    runtimeVersion?: string
    runtimeIntegrity?: string
    harnessId?: string
    harnessDigest?: string
    socketPath?: string
    maxRequestBytes: number
  }
  dshBaseRef: string
  toolchainRef: string
  sandboxProfileRef: string
  seedTaskRef: string
  heldOutRef: string
  taskBudgetMs: number
  pythonExecutable?: string
  metaSandbox: {
    mode: 'required' | 'disabled'
  }
  seedTasksPath?: string
  allowedImports: string[]
  initialChampion?: ChampionState
  evolutionState: {
    publishedPointer: boolean
    maxLiveMetaSessions: number
  }
  candidateWorkspace: {
    rootName: string
    maxFiles: number
    maxBytes: number
    maxDiffBytes: number
    maxReadBytes: number
    shellEnabled: boolean
    shellTimeoutMs: number
    shellOutputBytes: number
  }
  candidateGeneration: {
    maxCandidates: number
    maxModelRequests?: number
    maxTokens?: number
    /** Deprecated compatibility alias for the former single round-wide budget. */
    timeoutMs?: number
    attemptTimeoutMs?: number
    maxAttemptsPerCandidate?: number
    roundTimeoutMs?: number
  }
  selection: {
    survivors: number
    timeoutMs: number
    llmVerifier?: {
      pythonExecutable: string
      model: string
      criteria: Record<string, string>
      groundTruthNote?: string
      nEvaluations: number
      pivots: number
      seed: number
      maxWorkers: number
      maxOutputBytes: number
      maxTrajectoryEvents: number
      maxTrajectoryChars: number
      passEnv: string[]
    }
  }
  compiler: {
    command: string
    args: string[]
    timeoutMs: number
    env: Record<string, string>
  }
  hitch: HitchConfig
  promotion: PromotionPolicy
}

export const ConfigSchema: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().required(),
  dshRepository: Schema.string().required(),
  targetRoot: Schema.string().default('harness'),
  stateRoot: Schema.string(),
  metaPreset: Schema.string().required(),
  metaModel: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    maxTokens: Schema.number(),
  }).required(),
  metaSampling: Schema.object({
    temperature: Schema.number(),
  }).default({} as never),
  metaAdapter: Schema.object({
    kind: Schema.union(['dsh', 'skill'] as const).default('dsh'),
    runtimeType: Schema.string(),
    runtimeVersion: Schema.string(),
    runtimeIntegrity: Schema.string(),
    harnessId: Schema.string(),
    harnessDigest: Schema.string(),
    socketPath: Schema.string(),
    maxRequestBytes: Schema.number().default(1024 * 1024),
  }).default({ kind: 'dsh', maxRequestBytes: 1024 * 1024 } as never),
  dshBaseRef: Schema.string().required(),
  toolchainRef: Schema.string().required(),
  sandboxProfileRef: Schema.string().required(),
  seedTaskRef: Schema.string().required(),
  heldOutRef: Schema.string().required(),
  taskBudgetMs: Schema.number().default(3_600_000),
  pythonExecutable: Schema.string().default('python3'),
  metaSandbox: Schema.object({
    mode: Schema.union(['required', 'disabled'] as const).default('required'),
  }).default({ mode: 'required' }),
  seedTasksPath: Schema.string(),
  allowedImports: Schema.array(Schema.string()).default(['@deepseek-ai/', 'node:']),
  initialChampion: Schema.object({
    schemaVersion: Schema.const(2).required(),
    ref: Schema.string().required(),
    manifestDigest: Schema.string().required(),
    updatedAt: Schema.string().required(),
    roundId: Schema.string(),
  }),
  evolutionState: Schema.object({
    publishedPointer: Schema.boolean().default(true),
    maxLiveMetaSessions: Schema.number().default(8),
  }).default({ publishedPointer: true, maxLiveMetaSessions: 8 }),
  candidateWorkspace: Schema.object({
    rootName: Schema.string().default('candidate-worktrees'),
    maxFiles: Schema.number().default(64),
    maxBytes: Schema.number().default(2 * 1024 * 1024),
    maxDiffBytes: Schema.number().default(1024 * 1024),
    maxReadBytes: Schema.number().default(128 * 1024),
    shellEnabled: Schema.boolean().default(true),
    shellTimeoutMs: Schema.number().default(120_000),
    shellOutputBytes: Schema.number().default(1024 * 1024),
  }).default({
    rootName: 'candidate-worktrees',
    maxFiles: 64,
    maxBytes: 2 * 1024 * 1024,
    maxDiffBytes: 1024 * 1024,
    maxReadBytes: 128 * 1024,
    shellEnabled: true,
    shellTimeoutMs: 120_000,
    shellOutputBytes: 1024 * 1024,
  }),
  candidateGeneration: Schema.object({
    maxCandidates: Schema.number().default(1),
    maxModelRequests: Schema.number(),
    maxTokens: Schema.number(),
    timeoutMs: Schema.number(),
    attemptTimeoutMs: Schema.number(),
    maxAttemptsPerCandidate: Schema.number(),
    roundTimeoutMs: Schema.number(),
  }).default({
    maxCandidates: 1,
    attemptTimeoutMs: 900_000,
    maxAttemptsPerCandidate: 2,
    roundTimeoutMs: 1_800_000,
  } as never),
  selection: Schema.object({
    survivors: Schema.number().default(1),
    timeoutMs: Schema.number().default(300_000),
    llmVerifier: Schema.object({
      pythonExecutable: Schema.string().required(),
      model: Schema.string().required(),
      criteria: Schema.dict(Schema.string()).required(),
      groundTruthNote: Schema.string(),
      nEvaluations: Schema.number().default(4),
      pivots: Schema.number().default(2),
      seed: Schema.number().default(0),
      maxWorkers: Schema.number().default(8),
      maxOutputBytes: Schema.number().default(1024 * 1024),
      maxTrajectoryEvents: Schema.number().default(100_000),
      maxTrajectoryChars: Schema.number().default(512 * 1024),
      passEnv: Schema.array(Schema.string()).default([]),
    }).default(undefined as never),
  }).default({ survivors: 1, timeoutMs: 300_000, llmVerifier: undefined as never }),
  compiler: Schema.object({
    command: Schema.string().required(),
    args: Schema.array(Schema.string()).default([]),
    timeoutMs: Schema.number().default(120_000),
    env: Schema.dict(Schema.string()).default({}),
  }).required(),
  hitch: Schema.object({
    executable: Schema.string().default('hitch'),
    harnessId: Schema.string().default('deepseek'),
    root: Schema.string().default(''),
    model: Schema.string().default(''),
    attempts: Schema.number().default(1),
    maxConcurrent: Schema.number().default(4),
    setupTimeoutMs: Schema.number().default(1_800_000),
    terminationGraceMs: Schema.number().default(5_000),
    maxOutputBytes: Schema.number().default(8 * 1024 * 1024),
    maxTrajectoryOutputBytes: Schema.number().default(64 * 1024 * 1024),
    seeds: Schema.array(Schema.number()),
    sampling: Schema.object({ temperature: Schema.number() }).default({} as never),
    agentArgs: Schema.array(Schema.string()).default([]),
    passEnv: Schema.array(Schema.string()).default([]),
  }).default({
    executable: 'hitch',
    harnessId: 'deepseek',
    root: '',
    model: '',
    attempts: 1,
    maxConcurrent: 4,
    setupTimeoutMs: 1_800_000,
    terminationGraceMs: 5_000,
    maxOutputBytes: 8 * 1024 * 1024,
    maxTrajectoryOutputBytes: 64 * 1024 * 1024,
    sampling: {} as never,
    agentArgs: [],
    passEnv: [],
  } as never),
  promotion: Schema.object({
    minimumCandidateScore: Schema.number().default(0),
    minimumAbsoluteGain: Schema.number().default(0),
    requireNoRegression: Schema.boolean().default(true),
    maxHeldOutRegression: Schema.number().default(0),
    maxRequiredRegressions: Schema.number().default(0),
    requiredTaskIds: Schema.array(Schema.string()),
  }).default({
    minimumCandidateScore: 0,
    minimumAbsoluteGain: 0,
    requireNoRegression: true,
    maxHeldOutRegression: 0,
    maxRequiredRegressions: 0,
    requiredTaskIds: [],
  }),
}) as Schema<Config>

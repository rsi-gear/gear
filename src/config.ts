import Schema from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ChampionState, PromotionPolicy } from './types.js'

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
  agentArgs: string[]
  passEnv: string[]
}

export interface Config {
  workspaceRoot: string
  dshRepository: string
  targetRoot: string
  stateRoot?: string
  metaPreset: string
  metaHarnessRef: string
  metaModel: AgentOptions
  metaSampling?: Record<string, string | number | boolean>
  dshBaseRef: string
  toolchainRef: string
  sandboxProfileRef: string
  seedTaskRef: string
  heldOutRef: string
  taskBudgetMs: number
  pythonExecutable?: string
  seedTasksPath?: string
  allowedImports: string[]
  initialChampion?: ChampionState
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
  metaHarnessRef: Schema.string().required(),
  metaModel: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    maxTokens: Schema.number(),
  }).required(),
  metaSampling: Schema.dict(Schema.union([Schema.string(), Schema.number(), Schema.boolean()])),
  dshBaseRef: Schema.string().required(),
  toolchainRef: Schema.string().required(),
  sandboxProfileRef: Schema.string().required(),
  seedTaskRef: Schema.string().required(),
  heldOutRef: Schema.string().required(),
  taskBudgetMs: Schema.number().default(300_000),
  pythonExecutable: Schema.string().default('python3'),
  seedTasksPath: Schema.string(),
  allowedImports: Schema.array(Schema.string()).default(['@deepseek-ai/', 'node:']),
  initialChampion: Schema.object({
    schemaVersion: Schema.const(2).required(),
    ref: Schema.string().required(),
    manifestDigest: Schema.string().required(),
    updatedAt: Schema.string().required(),
    roundId: Schema.string(),
  }),
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
    agentArgs: [],
    passEnv: [],
  }),
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

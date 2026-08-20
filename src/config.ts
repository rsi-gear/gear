import Schema from '@deepseek-ai/schemastery'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ChampionState, PromotionPolicy } from './types.js'

export interface Config {
  workspaceRoot: string
  harnessRoot: string
  artifactRoot?: string
  stateRoot?: string
  metaPreset: string
  metaHarnessRef: string
  metaModel: AgentOptions
  metaSampling?: Record<string, string | number | boolean>
  dshRevision: string
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
  promotion: PromotionPolicy
}

export const ConfigSchema: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().required(),
  harnessRoot: Schema.string().required(),
  artifactRoot: Schema.string(),
  stateRoot: Schema.string(),
  metaPreset: Schema.string().required(),
  metaHarnessRef: Schema.string().required(),
  metaModel: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
    maxTokens: Schema.number(),
  }).required(),
  metaSampling: Schema.dict(Schema.union([Schema.string(), Schema.number(), Schema.boolean()])),
  dshRevision: Schema.string().required(),
  toolchainRef: Schema.string().required(),
  sandboxProfileRef: Schema.string().required(),
  seedTaskRef: Schema.string().required(),
  heldOutRef: Schema.string().required(),
  taskBudgetMs: Schema.number().default(300_000),
  pythonExecutable: Schema.string().default('python3'),
  seedTasksPath: Schema.string(),
  allowedImports: Schema.array(Schema.string()).default(['@deepseek-ai/', 'node:']),
  initialChampion: Schema.object({
    ref: Schema.string().required(),
    digest: Schema.string().required(),
    artifactPath: Schema.string().required(),
    updatedAt: Schema.string().required(),
    roundId: Schema.string(),
  }),
  compiler: Schema.object({
    command: Schema.string().required(),
    args: Schema.array(Schema.string()).default([]),
    timeoutMs: Schema.number().default(120_000),
    env: Schema.dict(Schema.string()).default({}),
  }).required(),
  promotion: Schema.object({
    minimumCandidateScore: Schema.number().default(0),
    minimumAbsoluteGain: Schema.number().default(0),
    requireNoRegression: Schema.boolean().default(true),
    maxHeldOutRegression: Schema.number().default(0),
    maxRequiredRegressions: Schema.number().default(0),
  }).default({
    minimumCandidateScore: 0,
    minimumAbsoluteGain: 0,
    requireNoRegression: true,
    maxHeldOutRegression: 0,
    maxRequiredRegressions: 0,
  }),
}) as Schema<Config>

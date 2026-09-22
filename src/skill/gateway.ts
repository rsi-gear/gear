import type { RefineCapabilities } from '../capabilities.js'
import type { RefineService } from '../refine/service.js'
import { skillHarnessIdentity } from '../meta/identity.js'
import type { SkillMetaCoordinator } from '../meta/skill.js'
import type { EvaluationRerunSelector, SemanticTarget } from '../types.js'
import type { SkillCandidateFiles } from './files.js'
import { parseBaselineSourceRequest } from '../refine/baseline-source.js'
import { parseObjective } from '../objective/contracts.js'

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('params must be an object')
  return value as Record<string, unknown>
}

function string(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || value[key].length === 0) throw new TypeError(`${key} is required`)
  return value[key]
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined) return undefined
  return string(value, key)
}

function optionalInteger(value: Record<string, unknown>, key: string): number | undefined {
  if (value[key] === undefined) return undefined
  if (!Number.isSafeInteger(value[key])) throw new TypeError(`${key} must be an integer`)
  return value[key] as number
}

function strings(value: Record<string, unknown>, key: string): string[] | undefined {
  const selected = value[key]
  if (selected === undefined) return undefined
  if (!Array.isArray(selected) || selected.some(item => typeof item !== 'string')) throw new TypeError(`${key} must be an array of strings`)
  return [...selected]
}

const SEMANTIC_TARGETS = new Set<SemanticTarget>([
  'context', 'pre_action', 'routing', 'post_action', 'action_verifier',
  'skill', 'tool', 'workflow', 'compaction',
])

function focus(value: Record<string, unknown>): SemanticTarget[] | undefined {
  const selected = strings(value, 'focus')
  if (selected?.some(item => !SEMANTIC_TARGETS.has(item as SemanticTarget))) throw new TypeError('focus contains an unknown semantic target')
  return selected as SemanticTarget[] | undefined
}

export interface SkillGatewayOptions {
  maxRequestBytes?: number
}

/** Structured, harness-neutral API consumed by the packaged refine skill. */
export class RefineSkillGateway {
  readonly maxRequestBytes: number

  constructor(
    private readonly service: RefineService,
    private readonly coordinator: SkillMetaCoordinator,
    private readonly capabilities: RefineCapabilities,
    private readonly files: SkillCandidateFiles,
    options: SkillGatewayOptions = {},
  ) {
    this.maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024
  }

  async call(method: string, paramsInput: unknown): Promise<unknown> {
    const params = record(paramsInput)
    if (method === 'control.start') {
      const from = optionalString(params, 'from')
      const seedTaskRef = optionalString(params, 'seedTaskRef')
      const rounds = optionalInteger(params, 'rounds')
      const taskBudgetMs = optionalInteger(params, 'taskBudgetMs')
      const selectedFocus = focus(params)
      const name = optionalString(params, 'name')
      const objective = parseObjective(params.objective)
      const baselineSource = params.baselineSource === undefined
        ? undefined
        : parseBaselineSourceRequest(params.baselineSource)
      if (from !== undefined && from !== 'initial' && from !== 'published' && !/^[0-9a-f]{40}$/u.test(from)) {
        throw new TypeError('from must be initial, published, or an exact Git commit')
      }
      return this.service.admit('skill', {
        objective,
        ...(seedTaskRef === undefined ? {} : { seedTaskRef }),
        ...(rounds === undefined ? {} : { rounds }),
        ...(taskBudgetMs === undefined ? {} : { taskBudgetMs }),
        ...(selectedFocus === undefined ? {} : { focus: selectedFocus }),
        ...(from === undefined ? {} : { from }),
        ...(name === undefined ? {} : { name }),
        ...(baselineSource === undefined ? {} : { baselineSource }),
      })
    }
    if (method === 'control.continue') {
      if (params.objective !== undefined) throw new TypeError('continue cannot change the frozen objective; create a new evolution')
      const roundId = optionalString(params, 'roundId')
      const rounds = optionalInteger(params, 'rounds')
      const selectedFocus = focus(params)
      if (roundId !== undefined && (rounds !== undefined || selectedFocus !== undefined)) {
        throw new TypeError('roundId cannot be combined with rounds or focus')
      }
      return this.service.continueEvolution('skill', string(params, 'evolutionId'), {
        ...(roundId === undefined ? {} : { roundId }),
        ...(rounds === undefined ? {} : { rounds }),
        ...(selectedFocus === undefined ? {} : { focus: selectedFocus }),
      })
    }
    if (method === 'control.identity') {
      const evolutionId = optionalString(params, 'evolutionId')
      return skillHarnessIdentity(evolutionId === undefined
        ? this.service.options.metaAgent
        : (await this.service.registry.requireSpec(evolutionId)).metaAgent)
    }
    if (method === 'control.status') {
      const evolutionId = optionalString(params, 'evolutionId')
      return evolutionId === undefined
        ? this.service.listEvolutions()
        : this.service.status(evolutionId, optionalString(params, 'roundId'))
    }
    if (method === 'control.rerun') {
      const selector = record(params.selector)
      let parsed: EvaluationRerunSelector
      if (selector.mode === 'invalid') parsed = { mode: 'invalid' }
      else if (selector.mode === 'tasks') {
        const taskNames = strings(selector, 'taskNames') ?? []
        if (taskNames.length === 0) throw new TypeError('taskNames must not be empty')
        parsed = { mode: 'tasks', taskNames: [...new Set(taskNames)] }
      } else throw new TypeError('selector mode must be invalid or tasks')
      return this.service.rerunEvaluation(
        string(params, 'evolutionId'), string(params, 'roundId'), string(params, 'evalId'), parsed,
      )
    }
    if (method === 'control.search-resume') {
      return this.service.resumeSearchRound(string(params, 'evolutionId'), string(params, 'roundId'))
    }
    if (method === 'control.search-repair') {
      return this.service.repairSearchStage(string(params, 'evolutionId'), string(params, 'roundId'), string(params, 'repairId'), string(params, 'evidenceDigest'))
    }
    if (method === 'control.publish') {
      await this.service.publish(string(params, 'evolutionId'), optionalString(params, 'ref'))
      return { published: true }
    }
    if (method === 'control.rollback') return this.service.rollback(string(params, 'evolutionId'), string(params, 'ref'))
    if (method === 'meta.claim') {
      return this.coordinator.claim(
        string(params, 'clientId'), params.identity,
        optionalString(params, 'evolutionId'),
        optionalString(params, 'roundId'),
      ) ?? { pending: false }
    }

    const assignment = this.coordinator.authorize(
      string(params, 'leaseId'), string(params, 'leaseToken'), string(params, 'clientId'),
    )
    if (method === 'meta.fail') {
      return this.service.failMetaExecution(
        assignment.evolutionId,
        assignment.roundId,
        assignment.candidateId,
        assignment.sessionId,
        string(params, 'reason'),
      )
    }
    if (method === 'candidate.read') return this.files.read(assignment.sessionId, string(params, 'path'))
    if (method === 'candidate.tree') return this.files.tree(assignment.sessionId, optionalString(params, 'path'))
    if (method === 'candidate.write') {
      const expectedDigest = params.expectedDigest
      if (expectedDigest !== null && typeof expectedDigest !== 'string') throw new TypeError('expectedDigest must be a digest or null')
      if (typeof params.text !== 'string') throw new TypeError('text must be a string')
      return this.files.write(assignment.sessionId, string(params, 'path'), params.text, expectedDigest)
    }
    if (method === 'candidate.edit') {
      return this.files.edit(
        assignment.sessionId,
        string(params, 'path'),
        string(params, 'oldString'),
        typeof params.newString === 'string' ? params.newString : (() => { throw new TypeError('newString must be a string') })(),
        string(params, 'expectedDigest'),
        params.replaceAll === true,
      )
    }
    if (method === 'candidate.remove') return this.files.remove(assignment.sessionId, string(params, 'path'), string(params, 'expectedDigest'))
    if (method === 'meta.call') {
      return this.capabilities.call('refine-meta', assignment.sessionId, string(params, 'capability'), params.arguments ?? {})
    }
    throw new Error(`unknown refine skill method: ${method}`)
  }
}

import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { MetaSessionManager } from './meta/session.js'
import type { RefineService } from './refine/service.js'
import type { RefineStateStore } from './state/store.js'
import type { HarnessMutation, RefineBridgeRequestMap, SessionRole } from './types.js'

export interface CapabilityOptions {
  seedTasksPath?: string
  maxReadBytes?: number
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('capability params must be an object')
  return value as Record<string, unknown>
}

function publicJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value, (key, item) => /heldOut|held_out|partitionRef/iu.test(key) ? undefined : item)) as JsonValue
}

export class RefineCapabilities {
  private readonly maxReadBytes: number

  constructor(
    private readonly service: RefineService,
    private readonly store: RefineStateStore,
    private readonly meta: MetaSessionManager,
    private readonly resolveAgent: (sessionId: string) => Agent | undefined,
    private readonly options: CapabilityOptions = {},
  ) {
    this.maxReadBytes = options.maxReadBytes ?? 128 * 1024
  }

  async call(role: SessionRole, sessionId: string, method: string, params: unknown): Promise<unknown> {
    const args = record(params)
    if (role === 'refine-meta') return this.callMeta(sessionId, method, args)
    if (role === 'target') {
      if (method === 'refine.run') return this.service.admit('target')
      if (method === 'refine.status') return this.service.status(this.string(args, 'roundId'))
    }
    throw new Error(`capability is unavailable for ${role}: ${method}`)
  }

  private async callMeta(sessionId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === 'harness.current') {
      const champion = await this.store.readChampion()
      if (champion === undefined) throw new Error('no champion is initialized')
      const manifest = JSON.parse(await readFile(resolve(champion.artifactPath, 'manifest.json'), 'utf8')) as unknown
      return publicJson({ ref: champion.ref, digest: champion.digest, manifest })
    }
    if (method === 'harness.read') {
      const champion = await this.store.readChampion()
      if (champion === undefined || args.ref !== champion.ref) throw new Error('harness ref is not the current champion')
      const path = this.string(args, 'path')
      if (isAbsolute(path) || path.split('/').some(segment => segment === '..' || segment === '')) throw new Error('invalid harness path')
      const absolute = resolve(champion.artifactPath, ...path.split('/'))
      if (!absolute.startsWith(`${resolve(champion.artifactPath)}${sep}`)) throw new Error('harness path escaped artifact')
      const [realRoot, realFile] = await Promise.all([realpath(champion.artifactPath), realpath(absolute)])
      if (!realFile.startsWith(`${realRoot}${sep}`)) throw new Error('harness path followed a symlink outside the artifact')
      const content = await readFile(realFile, 'utf8')
      const offset = this.optionalInteger(args, 'offset') ?? 0
      const limit = Math.min(this.optionalInteger(args, 'limit') ?? this.maxReadBytes, this.maxReadBytes)
      return { ref: champion.ref, path, offset, text: content.slice(offset, offset + limit), eof: offset + limit >= content.length }
    }
    if (method === 'seed_tasks.load') {
      if (this.options.seedTasksPath === undefined) return { tasks: [] }
      return publicJson(JSON.parse(await readFile(this.options.seedTasksPath, 'utf8')))
    }
    if (method === 'trajectory.query') {
      const offset = this.optionalInteger(args, 'offset') ?? 0
      const limit = Math.min(this.optionalInteger(args, 'limit') ?? 20, 100)
      const rounds = (await this.store.listRounds()).slice(offset, offset + limit).map(round => ({
        roundId: round.roundId,
        status: round.status,
        targetHarnessRef: round.targetHarnessRef,
        baseline: round.baseline,
        evaluation: round.evaluation === undefined ? undefined : {
          baseline: round.evaluation.baseline,
          candidate: round.evaluation.candidate,
          evidenceRefs: round.evaluation.evidenceRefs.filter(ref => !/held[-_]?out/iu.test(ref)),
        },
        decision: round.decision,
        failure: round.failure === undefined ? undefined : { phase: round.failure.phase },
      }))
      return publicJson({ rounds, offset, limit })
    }
    if (method === 'hitch.status') return this.service.status(this.string(args, 'roundId'))
    if (method === 'submit_refinement_proposal') {
      const roundId = this.string(args, 'roundId')
      const agent = this.resolveAgent(sessionId)
      if (agent === undefined) throw new Error('meta session is not live')
      const mutation = (args.mutation ?? null) as HarnessMutation | null
      const attribution = this.meta.proposalAttribution(roundId, agent, mutation)
      await this.service.submitProposal(roundId, mutation, attribution)
      return { accepted: true, roundId }
    }
    throw new Error(`unknown refine-meta capability: ${method}`)
  }

  private string(args: Record<string, unknown>, key: string): string {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${key} must be a non-empty string`)
    return value
  }

  private optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key]
    if (value === undefined) return undefined
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${key} must be a non-negative integer`)
    return value as number
  }
}

export type CapabilityMethod = keyof RefineBridgeRequestMap

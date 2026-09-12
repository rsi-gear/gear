import { digestJson } from '../state/digest.js'
import { invariant, seal, sorted, verifyDigest } from './contracts.js'
import type { TaskGuard } from './types.js'

export interface RegressionProposal {
  id: string
  source: { kind: 'seed-evaluation' | 'online-feedback'; evidenceRef: string }
  prompt: string
  fixtureRefs: string[]
  environmentRef?: string
  graderRef?: string
  expectedBehavior: string
  failureCategory: string
  deduplicationKey: string
  status: 'proposed' | 'needs-fixture' | 'validated' | 'rejected'
  reasonCodes: string[]
  digest: string
}
export interface RegressionInput {
  source: { kind: 'seed-evaluation' | 'online-feedback' | 'held-out'; evidenceRef: string }
  outcome: 'business-failure' | 'infrastructure-invalid'
  prompt: string
  fixtureRefs: string[]
  environmentRef?: string
  graderRef?: string
  expectedBehavior: string
  failureCategory: string
}
export function collectFailure(input: RegressionInput, existing: RegressionProposal[], config: { collectFailures: boolean; maxProposals: number }): { proposal?: RegressionProposal; reason?: string } {
  if (!config.collectFailures) return { reason: 'collection-disabled' }
  if (input.source.kind === 'held-out') return { reason: 'held-out-isolation' }
  if (input.outcome !== 'business-failure') return { reason: 'execution-repair-required' }
  if (existing.length >= config.maxProposals) return { reason: 'proposal-capacity' }
  invariant(input.source.evidenceRef.length > 0, 'failure provenance required')
  // Reject rather than retaining a possibly incomplete redaction of credentials or personal data.
  const text = [input.prompt, input.expectedBehavior, input.failureCategory, ...input.fixtureRefs, input.environmentRef ?? '', input.graderRef ?? ''].join('\n')
  if (/(?:-----BEGIN .*PRIVATE KEY|\b(?:Bearer|password|api[_-]?key|access[_-]?token|secret)\s*[:= ]\s*\S+|\bsk-[A-Za-z0-9_-]{12,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]?){13,19}\b)/iu.test(text)) return { reason: 'sensitive-content' }
  const prompt = input.prompt.trim()
  invariant(prompt.length > 0 && input.expectedBehavior.length > 0, 'regression prompt and expected behavior required')
  const deduplicationKey = digestJson({ prompt, fixtures: sorted(input.fixtureRefs), environment: input.environmentRef ?? null, grader: input.graderRef ?? null, expected: input.expectedBehavior })
  if (existing.some(p => p.deduplicationKey === deduplicationKey)) return { reason: 'duplicate' }
  const status = input.fixtureRefs.length && input.environmentRef && input.graderRef ? 'proposed' as const : 'needs-fixture' as const
  return { proposal: seal({ id: `regression-${deduplicationKey.slice(7, 23)}`, source: input.source as RegressionProposal['source'], prompt, fixtureRefs: sorted(input.fixtureRefs),
    ...(input.environmentRef ? { environmentRef: input.environmentRef } : {}), ...(input.graderRef ? { graderRef: input.graderRef } : {}), expectedBehavior: input.expectedBehavior,
    failureCategory: input.failureCategory, deduplicationKey, status, reasonCodes: status === 'needs-fixture' ? ['reproducible-fixture-required'] : [] }) }
}
export interface RegressionSuite {
  schemaVersion: 1
  parentSuiteDigest?: string
  builderIntegrity: string
  tasks: Array<{ taskId: string; contentDigest: string; fixtureRefs: string[]; environmentRef: string; graderRef: string; isolationRef: string; validationEvidenceRef: string; proposalDigest: string; role: 'development' | 'protected-regression'; guard?: TaskGuard }>
  digest: string
}
export async function materializeSuite(input: Omit<RegressionSuite, 'schemaVersion' | 'digest'>, proposals: RegressionProposal[], verify: (task: RegressionSuite['tasks'][number], proposal: RegressionProposal) => Promise<boolean>): Promise<RegressionSuite> {
  invariant(input.tasks.length > 0 && sorted(input.tasks.map(t => t.taskId)).length === input.tasks.length, 'invalid regression task manifest')
  for (const task of input.tasks) {
    const proposal = proposals.find(p => p.digest === task.proposalDigest)
    invariant(proposal, 'unknown source proposal'); verifyDigest(proposal)
    invariant(proposal.status === 'proposed' || proposal.status === 'validated', 'unmaterializable proposal')
    invariant(task.fixtureRefs.length && task.environmentRef && task.graderRef && task.isolationRef && task.validationEvidenceRef, 'reproducible inputs, grader, isolation and validation are required')
    invariant(task.role !== 'protected-regression' || task.guard?.partition === 'seed' && task.guard.taskId === task.taskId, 'protected regression requires an explicit seed guard')
    invariant(await verify(task, proposal), 'regression fixture validation failed')
  }
  return seal({ schemaVersion: 1 as const, ...input })
}

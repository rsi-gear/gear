import { digestJson } from '../state/digest.js'
import { digest, finite, invariant, seal, sorted, verifyDigest } from './contracts.js'
import { validateSearchSchema } from './schema.js'
import type { SearchSettings, TaskGuard, TaskUniverse } from './types.js'

export interface RegressionProposal {
  id: string
  source: { kind: 'seed-evaluation' | 'online-feedback'; evidenceRef: string }
  prompt: string
  promptDigest: string
  sanitizedPromptRef: string
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
/** Persist this content-addressed object alongside proposals when using an external journal. */
export function sanitizedRegressionPrompt(prompt: string) { return seal({ kind: 'sanitized-regression-prompt' as const, prompt }) }
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
  return { proposal: seal({ id: `regression-${deduplicationKey.slice(7, 23)}`, source: input.source as RegressionProposal['source'], prompt,
    promptDigest: digestJson(prompt), sanitizedPromptRef: sanitizedRegressionPrompt(prompt).digest, fixtureRefs: sorted(input.fixtureRefs),
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
export function validateRegressionSuite(suite: RegressionSuite): void {
  validateSearchSchema('RegressionSuite', suite); verifyDigest(suite)
  digest(suite.builderIntegrity)
  if (suite.parentSuiteDigest) digest(suite.parentSuiteDigest)
  invariant(suite.tasks.length > 0 && sorted(suite.tasks.map(t => t.taskId)).length === suite.tasks.length
    && sorted(suite.tasks.map(t => t.contentDigest)).length === suite.tasks.length, 'invalid regression task manifest')
  for (const task of suite.tasks) {
    digest(task.contentDigest); digest(task.proposalDigest)
    invariant(task.taskId.length && task.fixtureRefs.length && task.fixtureRefs.every(r => r.length)
      && task.environmentRef && task.graderRef && task.isolationRef && task.validationEvidenceRef, 'reproducible inputs, grader, isolation and validation are required')
    if (task.role === 'protected-regression') {
      invariant(task.guard?.partition === 'seed' && task.guard.taskId === task.taskId, 'protected regression requires an explicit seed guard')
      invariant(['no-regression', 'minimum-score', 'must-pass'].includes(task.guard.rule), 'invalid regression guard')
      if (task.guard.rule === 'minimum-score') finite(task.guard.minimumUtility!, 'regression guard minimum')
    } else invariant(task.role === 'development' && task.guard === undefined, 'development regression cannot declare a hidden guard')
  }
}

/** Bind the immutable suite's hard rules at admission, preserving every explicit operator rule. */
export function resolveRegressionSettings(settings: SearchSettings, seed: TaskUniverse, heldOut: TaskUniverse): SearchSettings {
  invariant(!heldOut.regressionSuite && !heldOut.regressionSuiteDigest, 'known regression suite cannot serve as held-out')
  const ref = settings.regression.suiteRef
  if (!ref) {
    invariant(!seed.regressionSuite && !seed.regressionSuiteDigest, 'regression suite must be explicitly selected at admission')
    return structuredClone(settings)
  }
  digest(ref)
  const suite = seed.regressionSuite
  invariant(suite && suite.digest === ref && seed.regressionSuiteDigest === ref, 'selected regression suite requires its frozen manifest')
  validateRegressionSuite(suite)
  for (const task of suite.tasks) invariant(seed.tasks.some(t => t.id === task.taskId && t.contentDigest === task.contentDigest), 'regression suite member missing or changed in seed universe')
  const resolved = structuredClone(settings)
  for (const task of suite.tasks) if (task.role === 'protected-regression') {
    if (!resolved.promotion.protectedTasks.some(g => digestJson(g) === digestJson(task.guard))) resolved.promotion.protectedTasks.push(structuredClone(task.guard!))
  }
  return resolved
}

export async function materializeSuite(input: Omit<RegressionSuite, 'schemaVersion' | 'digest'>, proposals: RegressionProposal[], verify: (task: RegressionSuite['tasks'][number], proposal: RegressionProposal) => Promise<boolean>): Promise<RegressionSuite> {
  const suite = seal({ schemaVersion: 1 as const, ...structuredClone(input) })
  const sources = structuredClone(proposals)
  validateRegressionSuite(suite)
  for (const task of suite.tasks) {
    const proposal = sources.find(p => p.digest === task.proposalDigest)
    invariant(proposal, 'unknown source proposal'); verifyDigest(proposal)
    validateSearchSchema('RegressionProposal', proposal)
    invariant(proposal.promptDigest === digestJson(proposal.prompt) && proposal.sanitizedPromptRef === sanitizedRegressionPrompt(proposal.prompt).digest, 'regression prompt identity mismatch')
    invariant(proposal.status === 'proposed' || proposal.status === 'validated', 'unmaterializable proposal')
    invariant(await verify(structuredClone(task), structuredClone(proposal)), 'regression fixture validation failed')
  }
  return suite
}

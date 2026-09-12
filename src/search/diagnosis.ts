import { digestJson } from '../state/digest.js'
import { validateSearchSchema } from './schema.js'
import { invariant, seal, sorted, verifyDigest } from './contracts.js'
import type { CandidateWorkPlan, DiagnosisDossier, DossierExcerpt, EvaluationScope, FailureCluster, TaskUniverse, WorkplanReceipt } from './types.js'

export function clusters(dossier: DiagnosisDossier, universe: TaskUniverse, protectedIds: string[]): FailureCluster[] {
  validateSearchSchema('DiagnosisDossier', dossier)
  verifyDigest(dossier)
  invariant(dossier.universeDigest === universe.digest && universe.partition === 'seed', 'diagnosis must use the actual parent seed evidence')
  const families = new Map<string, typeof dossier.facts>()
  for (const fact of dossier.facts) {
    invariant(dossier.taskIds.includes(fact.taskId), 'diagnosis references task outside its frozen range')
    if (fact.status !== 'supported-hypothesis') continue
    invariant(fact.familyId && fact.hypothesis && fact.mechanism && fact.modificationPaths?.length && fact.evidenceRefs.length, 'actionable diagnosis requires supported mechanism, hypothesis and module boundary')
    invariant(fact.modificationPaths.every(p => p && !p.startsWith('/') && !p.split('/').includes('..')), 'unsafe modification boundary')
    const values = families.get(fact.familyId) ?? []; values.push(fact); families.set(fact.familyId, values)
  }
  return [...families.entries()].map(([familyId, facts]) => {
    const controls = dossier.facts.filter(f => f.status === 'successful-control'
      && (f.familyId === familyId || facts.some(failure => universe.tasks.find(t => t.id === failure.taskId)!.stratum === universe.tasks.find(t => t.id === f.taskId)!.stratum)
        || f.modificationPaths?.some(path => facts.some(failure => failure.modificationPaths!.includes(path)))))
    const features = [...facts, ...controls]
    return seal({
    familyId, parentSnapshotDigest: dossier.parentSnapshotDigest, dossierDigest: dossier.digest,
    taskIds: sorted(facts.map(f => f.taskId)), evidenceRefs: sorted(facts.flatMap(f => f.evidenceRefs)),
    hypotheses: sorted(facts.map(f => f.hypothesis!)), modificationPaths: sorted(facts.flatMap(f => f.modificationPaths!)),
    taskFeatures: sorted(features.map(f => f.taskId)).map(taskId => ({ taskId,
      submodes: sorted(features.filter(f => f.taskId === taskId).flatMap(f => f.submode ? [f.submode] : [])),
      modificationPaths: sorted(features.filter(f => f.taskId === taskId).flatMap(f => f.modificationPaths ?? [])) })),
    successfulControlTaskIds: sorted(controls.map(f => f.taskId)),
    protectedFailure: facts.some(f => protectedIds.includes(f.taskId)),
    estimatedCost: sorted(facts.map(f => f.taskId)).reduce((sum, id) => sum + universe.tasks.find(t => t.id === id)!.estimatedCost, 0),
    })
  }).sort((a, b) => Number(b.protectedFailure) - Number(a.protectedFailure) || b.taskIds.length - a.taskIds.length || a.familyId.localeCompare(b.familyId))
}
export function deliveredWorkplan(workplan: CandidateWorkPlan, dossier: DiagnosisDossier, findings: unknown[], scope?: EvaluationScope): { workplan: CandidateWorkPlan; dossier: DossierExcerpt; findings: unknown[]; scope?: EvaluationScope; digest: string } {
  validateSearchSchema('CandidateWorkPlan', workplan); validateSearchSchema('DiagnosisDossier', dossier)
  verifyDigest(workplan); verifyDigest(dossier)
  invariant(workplan.dossierDigest === dossier.digest && workplan.parentSnapshotDigest === dossier.parentSnapshotDigest, 'workplan dossier parent mismatch')
  if (scope) invariant(scope.digest === workplan.scopeDigest, 'delivered scope does not match assigned workplan')
  const excerpt = seal({ sourceDossierDigest: dossier.digest, parentSnapshotDigest: dossier.parentSnapshotDigest,
    baselineEvidenceDigests: dossier.baselineEvidenceDigests,
    facts: dossier.facts.filter(f => workplan.targetTaskIds.includes(f.taskId) || scope?.taskIds.includes(f.taskId)),
    classifierIntegrity: dossier.classifierIntegrity, sanitizationPolicyDigest: dossier.sanitizationPolicyDigest })
  return seal({ workplan, dossier: excerpt, findings, ...(scope ? { scope } : {}) })
}
export function consumptionReceipt(delivery: ReturnType<typeof deliveredWorkplan>, sessionId: string, accessedRefs: string[]): WorkplanReceipt {
  invariant(sessionId.length > 0, 'candidate session required for workplan consumption')
  invariant(delivery.workplan.requiredDiagnosisRefs.every(ref => accessedRefs.includes(ref)), 'assigned diagnostic evidence has not been consumed')
  return seal({ kind: 'workplan-dossier-consumed' as const, candidateId: delivery.workplan.candidateId, sessionId,
    workplanDigest: delivery.workplan.digest, dossierDigest: delivery.dossier.sourceDossierDigest, deliveredDigest: delivery.digest, accessedRefs: sorted(accessedRefs) })
}
export function validateReceipt(receipt: WorkplanReceipt, delivery: ReturnType<typeof deliveredWorkplan>, sessionId: string): void {
  validateSearchSchema('WorkplanReceipt', receipt)
  verifyDigest(receipt)
  invariant(receipt.kind === 'workplan-dossier-consumed' && receipt.sessionId === sessionId && receipt.candidateId === delivery.workplan.candidateId
    && receipt.workplanDigest === delivery.workplan.digest && receipt.dossierDigest === delivery.dossier.sourceDossierDigest && receipt.deliveredDigest === delivery.digest
    && delivery.workplan.requiredDiagnosisRefs.every(ref => receipt.accessedRefs.includes(ref)), 'invalid workplan consumption receipt')
}

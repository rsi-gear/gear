import { digest, seal, initialCheckpoint, zeroCost } from '../lib/contracts.mjs'
const runtimeDigest = digest('runtime')
export const task = seal({ protocol: 'analysis-task@2', taskId: 'synthetic', taskFamilyId: 'synthetic', description: 'fixture',
  inputs: { trainDigest: digest('train'), predictDigest: digest('predict') }, predictIds: ['query'], validationPlanDigest: digest('five-folds'), runtimeDigest,
  prediction: { kind: 'tabular', idColumn: 'row', targetColumns: ['label'], metric: 'accuracy', labels: ['0', '1'] },
  publicFiles: [], benchmark: { format: 'mle-bench', competitionId: 'titanic', definitionDigest: digest('definition'),
    publicTreeDigest: digest('public-files'), sourceRevision: 'fixture', verification: 'fixture' } })
export const checkpoint = () => initialCheckpoint({ researchProjectId: 'test', taskFamilyId: task.taskFamilyId, baseTaskDigest: task.digest,
  dataScopeDigest: digest('visible-rows'), runtimeDigest, scorerDigest: digest('accuracy') })

export class Backend {
  constructor(store, { failAt = 0, stopAt = 0, outageAt = 0 } = {}) { Object.assign(this, { store, failAt, stopAt, outageAt }); this.calls = []; this.saved = new Map(); this.deliveries = 0 }
  async admit() {}
  async verifyReceipt(receipt) { await this.store.verifySources(await this.store.get(receipt.checkpointRef)); return true }
  async cancel() {}
  async rollout(request, history) {
    if (this.saved.has(request.digest)) return this.saved.get(request.digest)
    const k = request.slotIndex
    this.calls.push({ request, history })
    if (this.outageAt === k) throw new Error('infra unavailable')
    const runId = `run_${request.harness.commit.slice(0, 16)}${String(k).padStart(16, '0')}`
    const bytes = Buffer.from(`print(${k})`), source = await this.store.putBytes(bytes)
    const failed = this.failAt === k
    const oofDigest = failed ? null : await this.store.putBytes(Buffer.from(JSON.stringify({ [runId]: ['1'] })))
    const solution = failed ? null : seal({ protocol: 'analysis-solution@1', entrypoint: 'solution.py', files: [{ path: 'solution.py', digest: source, bytes: bytes.length }],
      parameters: {}, trainingSeed: 42, runtimeDigest, authoredByRunId: runId })
    const used = { cpuSeconds: 1, requests: 1, tokens: 100, tools: 2 }
    const experiment = seal({ protocol: 'analysis-experiment@2', experimentId: `${runId}/experiment`, sequenceId: request.sequenceId,
      rolloutRunId: runId, slotIndex: k, parentExperimentId: history.history.at(-1)?.experimentId ?? null, operator: k === 1 ? 'draft' : 'improve',
      sourceDigest: solution?.digest ?? null, validationPlanDigest: digest('five-folds'), trainingSeed: 42,
      claim: { hypothesis: `test ${k}`, intendedChange: 'fixture' }, execution: { status: failed ? 'generation_failed' : 'completed',
        receiptDigest: digest(runId), physicalAttemptRefs: [runId], reusedEvidenceRefs: [], cost: used,
        metric: 'accuracy', foldMetrics: failed ? [] : Array.from({ length: 5 }, (_, fold) => ({ fold, rows: 10, score: (5 + k) / 10, utility: (5 + k) / 10 })),
        pooledScore: failed ? null : (5 + k) / 10, pooledUtility: failed ? null : (5 + k) / 10, oofDigest },
      interpretation: { conclusion: 'fixture', limitations: [] } })
    const result = seal({ protocol: 'analysis-rollout-receipt@1', requestDigest: request.digest, runId, outputManifestDigest: digest([runId, 'outputs']),
      experiment, solutions: solution ? [solution] : [], selectedSolutionDigest: solution?.digest ?? history.currentSolutionDigest,
      availableEvidenceRefs: [experiment.digest], selectionPolicyDigest: digest('policy'), cost: used, stop: this.stopAt === k, sealedAt: `2026-11-06T00:00:0${k}Z` })
    this.saved.set(request.digest, result); return result
  }
  async deliver(request) {
    this.deliveries++
    return seal({ protocol: 'analysis-delivery@1', requestDigest: request.digest, status: 'completed', solutionDigest: request.solution.digest,
      quality: this.quality ?? .8, accuracy: this.quality ?? .8, metric: 'accuracy', score: this.quality ?? .8,
      runId: 'delivery', outputManifestDigest: digest('delivery'), modelRequests: 0, cost: { ...zeroCost(), cpuSeconds: 2 } })
  }
}

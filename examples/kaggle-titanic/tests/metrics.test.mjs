import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolveMetric, resolveObjective } from '../../../lib/objective/contracts.js'
import { aggregateRawMetrics, extractRawMetrics, scoreObjective } from '../../../lib/objective/scoring.js'
import { objective } from '../common.mjs'

// Identical bytes are consumed by Hitch's actual CSV scorer and standard-score converter tests.
const fixture = JSON.parse(await readFile(new URL('../../../test-contracts/kaggle-rewards-v1.json', import.meta.url), 'utf8'))
const standard = resolveMetric({ id: 'total_score', revision: 'fixture', unit: 'score', direction: 'maximize',
  source: { path: 'scores.totalScore', extractor: 'number-v1' }, range: { min: 0, max: 1 },
  granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 })
const contracts = [standard, ...fixture.raw_metrics.metrics.map(resolveMetric)]
const goal = resolveObjective(objective, contracts)
const slots = Array.from({ length: 5 }, (_, i) => ({ id: `titanic-dev-fold-${i}`, repetitions: [0], weight: .2 }))
function extract(item, taskId, certified = true, registry = contracts) {
  return extractRawMetrics({ contracts: registry, certified,
    trial: { scores: { totalScore: item.rewards.total_score }, verifier: { result: { rewards: item.rewards } } },
    identity: { taskId, repetition: 0, runId: `fixture-${item.id}-${taskId}`, attempt: 1,
      harnessCommit: 'a'.repeat(40), conditionDigest: `sha256:${'b'.repeat(64)}`, originalArtifactRefs: [`fixture:${item.id}`] } })
}

for (const item of fixture.cases.filter(item => item.mode !== 'finalization')) {
  test(`shared scorer contract projects ${item.id} into the existing Gear objective`, () => {
    const records = slots.map(slot => extract(item, slot.id))
    const aggregates = aggregateRawMetrics(contracts, slots, records)
    const scored = scoreObjective(goal, aggregates, 'five-fixed-folds')
    assert.equal(scored.status, 'available')
    assert.equal(scored.score, item.rewards.total_score)
    assert.equal(aggregates.pass_rate.value, item.rewards.completed)
    assert.equal(scored.constraintResults[0].status, item.rewards.valid_output === 1 ? 'passed' : 'failed')
    if (item.rewards.accuracy === undefined) {
      assert.equal(aggregates.accuracy.status, 'missing')
      assert.equal(aggregates.accuracy.value, undefined)
    } else {
      assert.equal(aggregates.accuracy.status, 'available')
      assert.equal(aggregates.accuracy.value, item.rewards.accuracy)
    }
  })
}

test('missing a fold or uncertified infrastructure evidence cannot yield a complete objective', () => {
  const item = fixture.cases.find(item => item.id === 'half_correct')
  const missing = slots.slice(0, 4).map(slot => extract(item, slot.id))
  const partial = scoreObjective(goal, aggregateRawMetrics(contracts, slots, missing), 'five-fixed-folds')
  assert.equal(partial.status, 'missing')
  assert.equal(partial.score, undefined)
  assert.equal(partial.constraintResults[0].status, 'unavailable')
  const invalid = slots.map((slot, i) => extract(item, slot.id, i !== 4))
  assert.equal(scoreObjective(goal, aggregateRawMetrics(contracts, slots, invalid), 'five-fixed-folds').status, 'invalid')
})

test('finalization contract certifies output without inventing test accuracy', () => {
  const item = fixture.cases.find(item => item.mode === 'finalization')
  const registry = [standard, ...fixture.finalization_raw_metrics.metrics.map(resolveMetric)]
  const record = extract(item, 'titanic-finalize', true, registry)
  assert.equal(record.metrics.accuracy, undefined)
  assert.equal(record.metrics.total_score.value, 1)
  assert.equal(record.metrics.valid_output.value, 1)
})

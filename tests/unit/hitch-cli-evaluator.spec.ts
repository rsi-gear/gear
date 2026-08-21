import { chmod, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js'
import type { RefinementRound } from '../../src/types.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function round(root: string, commit: string, digest: string): RefinementRound {
  return {
    schemaVersion: 2,
    roundId: 'round-1',
    workspaceRoot: root,
    status: 'baseline-running',
    source: 'api',
    createdAt: 'now',
    updatedAt: 'now',
    metaHarnessRef: 'meta-v1',
    targetHarnessRef: commit,
    targetHarnessDigest: digest,
    sandboxProfileRef: 'sandbox-v1',
    seedTaskRef: 'seed',
    heldOutRef: 'held-out',
    taskBudgetMs: 60_000,
    promotionPolicy: {
      minimumCandidateScore: 0,
      minimumAbsoluteGain: 0,
      requireNoRegression: true,
      maxHeldOutRegression: 0,
      maxRequiredRegressions: 0,
    },
    batchId: 'batch-1',
    roundIndex: 1,
    roundCount: 1,
  }
}

async function setup() {
  const fixture = await createGitHarnessFixture()
  roots.push(fixture.root)
  const executable = join(fixture.root, 'fake-hitch.mjs')
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const dataset = value('--dataset')
const harness = value('--harness')
const commit = harness.match(/#([0-9a-f]{40,64})$/)?.[1]
if (dataset === 'slow') setTimeout(() => {}, 30000)
else if (dataset === 'invalid-json') process.stdout.write('not-json\\n')
else {
  const actual = dataset === 'mismatch' ? 'f'.repeat(40) : commit
  process.stdout.write(JSON.stringify({
    schema_version: '1', eval_id: 'eval_' + '1'.repeat(32), status: 'succeeded', exit_code: 0,
    candidate: { harness_ref: 'deepseek@commit:' + actual, revision_identity: 'sha256:' + '2'.repeat(64) },
    dataset,
    summary: { n_trials: 1, n_completed: 1, n_errored: 0, n_cancelled: 0, primary_reward: 1,
      trials: [{ task_name: 'task-1', trial_name: 'trial-1', status: 'completed', rewards: { reward: 1 } }] },
    local_source_transport: { kind: 'local-git-commit', resolution_identity: 'sha256:' + '2'.repeat(64),
      commit: actual, tree: '3'.repeat(40), payload_sha256: 'sha256:' + '4'.repeat(64), payload_bytes: 100 },
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  }) + '\\n')
}
`)
  await chmod(executable, 0o755)
  const evaluator = new HitchCliEvaluator({
    executable,
    harnessId: 'deepseek',
    root: '',
    model: 'deepseek-chat',
    attempts: 1,
    maxConcurrent: 2,
    setupTimeoutMs: 10_000,
    terminationGraceMs: 100,
    maxOutputBytes: 1024 * 1024,
    agentArgs: [],
    passEnv: [],
    repositoryPath: fixture.repository,
  })
  return { fixture, evaluator }
}

describe('HitchCliEvaluator', () => {
  it('invokes Hitch CLI and validates exact local commit transport evidence', async () => {
    const { fixture, evaluator } = await setup()
    const evidence = await evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      { phase: 'seed-baseline', dataset: 'seed', harnessRef: fixture.championRef },
      new AbortController().signal,
    )
    expect(evidence).toMatchObject({
      dataset: 'seed', requestedCommit: fixture.championRef, actualCommit: fixture.championRef,
      primaryReward: 1, summary: { total: 1, passed: 1, failed: 0 },
      localSourceTransport: { commit: fixture.championRef },
    })
  })

  it('fails closed on invalid JSON and actual commit mismatch', async () => {
    const { fixture, evaluator } = await setup()
    const state = round(fixture.root, fixture.championRef, fixture.manifest.digest)
    await expect(evaluator.evaluate(state, {
      phase: 'seed-baseline', dataset: 'invalid-json', harnessRef: fixture.championRef,
    }, new AbortController().signal)).rejects.toThrow(/invalid JSON/)
    await expect(evaluator.evaluate(state, {
      phase: 'seed-baseline', dataset: 'mismatch', harnessRef: fixture.championRef,
    }, new AbortController().signal)).rejects.toThrow(/resolved .* expected/)
  })

  it('terminates Hitch when the round is aborted', async () => {
    const { fixture, evaluator } = await setup()
    const controller = new AbortController()
    const evaluation = evaluator.evaluate(
      round(fixture.root, fixture.championRef, fixture.manifest.digest),
      { phase: 'seed-baseline', dataset: 'slow', harnessRef: fixture.championRef },
      controller.signal,
    )
    setTimeout(() => controller.abort(new Error('test abort')), 50)
    await expect(evaluation).rejects.toThrow(/test abort/)
  })
})

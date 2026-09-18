import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { componentRef } from '../../src/evolution/components.js'
import { contentExcerpt } from '../../src/evaluator/trajectory-projection.js'
import { LlmVerifierCandidateAssessor, type LlmVerifierAssessorConfig } from '../../src/selection/llm-verifier.js'
import type { CandidateSelectionInput, HitchTrajectoryAnalysis, HitchTrajectoryReader } from '../../src/types.js'
import { evidence, evaluationCondition, SHA } from '../helpers/research-fixture.js'
import { trajectoryAnalysis, trajectoryReader } from '../helpers/trajectory-fixture.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fakePython(): Promise<string> {
  const root = join(process.env.TMPDIR ?? '/tmp', `llm-verifier-assessor-${crypto.randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  const path = join(root, 'fake-python')
  await writeFile(path, `#!${process.execPath}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  const emit = () => {
    const cells = request.cells.map(cell => {
      const ids = cell.candidates.map(candidate => candidate.candidate_id)
      const scores = Object.fromEntries(cell.candidates.map(candidate => [candidate.candidate_id, candidate.trace.includes('preferred') ? 0.9 : 0.1]))
      const ranking = [...ids].sort((left, right) => scores[right] - scores[left] || left.localeCompare(right))
      return { task_name: cell.task_name, attempt: cell.attempt, candidate_ids: ids, scores,
        ranking_candidate_ids: ranking, winner_candidate_id: ranking[0], n_comparisons: 2, criteria: ['success'] }
    })
    process.stdout.write(JSON.stringify({ schema_version: 1, cells,
      usage: { model_requests: 2, input_tokens: 10, cached_input_tokens: 2, output_tokens: 4, reasoning_tokens: 1 } }))
  }
  if (request.config.model === 'delay') setTimeout(emit, 10000)
  else if (request.config.model === 'leak') {
    process.stderr.write('provider rejected key: ' + process.env.TEST_VERIFIER_SECRET)
    process.exitCode = 1
  }
  else emit()
})
`)
  await chmod(path, 0o755)
  return path
}

function config(pythonExecutable: string, model = 'test-model'): LlmVerifierAssessorConfig {
  return {
    pythonExecutable,
    runtime: { pythonVersion: 'test', packageVersion: '0.2.0', packageIntegrity: SHA('a') },
    model,
    criteria: { success: 'Which trajectory most completely solves the task?' },
    nEvaluations: 1,
    pivots: 1,
    seed: 0,
    maxWorkers: 2,
    maxOutputBytes: 64 * 1024,
    maxTrajectoryEvents: 100,
    maxTrajectoryChars: 10_000,
    passEnv: [],
  }
}

function candidate(candidateId: string, runId: string): CandidateSelectionInput {
  const condition = evaluationCondition('seed', 'seed')
  const seedEvaluation = evidence(condition, candidateId === 'left' ? '1'.repeat(40) : '2'.repeat(40), 1, candidateId === 'left' ? '1' : '2')
  seedEvaluation.trials = [{ taskName: 'task-1', attempt: 1, runId, status: 'completed', rewards: { reward: 1 } }]
  return {
    candidateId,
    parentHarnessRef: 'a'.repeat(40),
    parentCandidateIds: ['parent'],
    sealedVersion: {
      commitOid: candidateId === 'left' ? '1'.repeat(40) : '2'.repeat(40),
      treeOid: candidateId === 'left' ? '3'.repeat(40) : '4'.repeat(40),
      manifestDigest: SHA(candidateId === 'left' ? '5' : '6'),
      patchDigest: SHA(candidateId === 'left' ? '7' : '8'),
      immutableRef: `refs/test/${candidateId}`,
    },
    seedEvaluation,
    seedComparison: {
      parentBaselineEvalId: 'baseline', pairedTrials: [],
      pairing: { planned: 1, paired: 0, excluded: 1, baselineInvalid: 0, candidateInvalid: 0 },
      scoreDelta: 0, requiredRegressions: 0,
    },
    metrics: { quality: 1, taskSuccessRate: 1 },
  }
}

function analysis(runId: string, answer: string, problem = 'Solve the same task.'): HitchTrajectoryAnalysis {
  return trajectoryAnalysis(runId, [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: problem }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } },
    ])
}

function readerFor(runIds: readonly string[], answer: (runId: string) => string, problem?: (runId: string) => string): HitchTrajectoryReader {
  return trajectoryReader(new Map(runIds.map(runId => [
    runId,
    analysis(runId, answer(runId), problem?.(runId)),
  ])))
}

describe('LlmVerifierCandidateAssessor', () => {
  it('reads paired seed trajectories asynchronously and returns auditable cross-candidate metrics', async () => {
    const executable = await fakePython()
    const ref = componentRef('candidate-assessor', 'llm-verifier', {
      package: 'test-assessor', version: '1.0.0', integrity: SHA('9'),
    }, config(executable))
    const runIds = [`run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`]
    const reader = readerFor(runIds, runId => runId.endsWith('2') ? 'preferred solution' : 'weak solution')
    const result = await new LlmVerifierCandidateAssessor(ref).assess({
      evolutionId: 'evo-1', roundId: 'round-1',
      candidates: [candidate('left', runIds[0]!), candidate('right', runIds[1]!)],
    }, { trajectoryReader: reader }, new AbortController().signal)
    expect(result.rankingCandidateIds).toEqual(['right', 'left'])
    expect(result.candidateMetrics.right).toMatchObject({ quality: 0.9, descriptors: { llmVerifierScore: 0.9 } })
    expect(result.candidateMetrics.left?.quality).toBe(0.1)
    expect(result.usage).toEqual({ modelRequests: 2, inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: 1 })
    expect(result.evidence).toMatchObject({
      kind: 'llm-verifier',
      cells: [{
        problemDigest: expect.stringMatching(/^sha256:/),
        candidates: [
          { candidateId: 'left', trajectoryDigest: expect.stringMatching(/^sha256:/) },
          { candidateId: 'right', trajectoryDigest: expect.stringMatching(/^sha256:/) },
        ],
        winnerCandidateId: 'right',
      }],
    })
    expect(JSON.stringify(result.evidence)).not.toContain('preferred solution')
  })

  it('assesses trajectories whose long task and assistant messages are top-level excerpts', async () => {
    const executable = await fakePython()
    const ref = componentRef('candidate-assessor', 'llm-verifier', {
      package: 'test-assessor', version: '1.0.0', integrity: SHA('9'),
    }, config(executable))
    const runIds = [`run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`]
    const analyses = new Map(runIds.map(runId => {
      const value = analysis(runId, runId.endsWith('2') ? 'preferred solution' : 'weak solution')
      value.surface.nodes[0]!.message = contentExcerpt(runId, 'Solve the same task.', 'message', 0, 8) as never
      value.surface.nodes[1]!.message = contentExcerpt(
        runId,
        runId.endsWith('2') ? 'preferred solution' : 'weak solution',
        'message',
        1,
        15,
      ) as never
      return [runId, value] as const
    }))
    const result = await new LlmVerifierCandidateAssessor(ref).assess({
      evolutionId: 'evo-1', roundId: 'round-1',
      candidates: [candidate('left', runIds[0]!), candidate('right', runIds[1]!)],
    }, { trajectoryReader: trajectoryReader(analyses) }, new AbortController().signal)
    expect(result.rankingCandidateIds).toEqual(['right', 'left'])
  })

  it('compares partial candidates on their common valid paired support', async () => {
    const executable = await fakePython()
    const ref = componentRef('candidate-assessor', 'llm-verifier', {
      package: 'test-assessor', version: '1.0.0', integrity: SHA('9'),
    }, config(executable))
    const left = candidate('left', `run_${'1'.repeat(32)}`)
    const right = candidate('right', `run_${'2'.repeat(32)}`)
    left.seedEvaluation.trials.push({
      taskName: 'left-only', attempt: 1, runId: `run_${'3'.repeat(32)}`,
      status: 'completed', rewards: { reward: 1 },
    })
    right.seedEvaluation.trials.push({
      taskName: 'right-only', attempt: 1, runId: `run_${'4'.repeat(32)}`,
      status: 'completed', rewards: { reward: 1 },
    })
    const inspected: string[] = []
    const baseReader = readerFor([`run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`], runId => runId.endsWith('2') ? 'preferred solution' : 'weak solution')
    const reader: HitchTrajectoryReader = {
      ...baseReader,
      async inspectTrajectoryAnalysis(runId, signal) {
        inspected.push(runId)
        return baseReader.inspectTrajectoryAnalysis(runId, signal)
      },
    }
    const result = await new LlmVerifierCandidateAssessor(ref).assess({
      evolutionId: 'evo-1', roundId: 'round-1', candidates: [left, right],
    }, { trajectoryReader: reader }, new AbortController().signal)
    expect(result.rankingCandidateIds).toEqual(['right', 'left'])
    expect(inspected.sort()).toEqual([`run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`].sort())
    expect(result.evidence).toMatchObject({ cells: [{ taskName: 'task-1' }] })
  })

  it('fails closed when candidate task prompts do not match', async () => {
    const executable = await fakePython()
    const ref = componentRef('candidate-assessor', 'llm-verifier', {
      package: 'test-assessor', version: '1.0.0', integrity: SHA('9'),
    }, config(executable))
    const runIds = [`run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`]
    const reader = readerFor(runIds, () => 'answer', runId => runId.endsWith('2') ? 'Different task.' : 'Original task.')
    await expect(new LlmVerifierCandidateAssessor(ref).assess({
      evolutionId: 'evo-1', roundId: 'round-1',
      candidates: [candidate('left', runIds[0]!), candidate('right', runIds[1]!)],
    }, { trajectoryReader: reader }, new AbortController().signal)).rejects.toThrow(/prompt mismatch/)
  })

  it('honors selection cancellation while the verifier process is running', async () => {
    const executable = await fakePython()
    const ref = componentRef('candidate-assessor', 'llm-verifier', {
      package: 'test-assessor', version: '1.0.0', integrity: SHA('9'),
    }, config(executable, 'delay'))
    const runIds = [`run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`]
    const reader = readerFor(runIds, () => 'answer')
    const controller = new AbortController()
    const pending = new LlmVerifierCandidateAssessor(ref).assess({
      evolutionId: 'evo-1', roundId: 'round-1',
      candidates: [candidate('left', runIds[0]!), candidate('right', runIds[1]!)],
    }, { trajectoryReader: reader }, controller.signal)
    setTimeout(() => controller.abort(new Error('selection cancelled')), 25)
    await expect(pending).rejects.toThrow(/selection cancelled/)
  })

  it('redacts allowlisted credential values from verifier failures', async () => {
    const executable = await fakePython()
    const secret = `verifier-secret-${crypto.randomUUID()}`
    process.env.TEST_VERIFIER_SECRET = secret
    try {
      const assessorConfig = { ...config(executable, 'leak'), passEnv: ['TEST_VERIFIER_SECRET'] }
      const ref = componentRef('candidate-assessor', 'llm-verifier', {
        package: 'test-assessor', version: '1.0.0', integrity: SHA('9'),
      }, assessorConfig)
      const runIds = [`run_${'1'.repeat(32)}`, `run_${'2'.repeat(32)}`]
      const reader = readerFor(runIds, () => 'answer')
      const pending = new LlmVerifierCandidateAssessor(ref).assess({
        evolutionId: 'evo-1', roundId: 'round-1',
        candidates: [candidate('left', runIds[0]!), candidate('right', runIds[1]!)],
      }, { trajectoryReader: reader }, new AbortController().signal)
      await expect(pending).rejects.toThrow(/\[REDACTED\]/)
      await expect(pending).rejects.not.toThrow(secret)
    } finally {
      delete process.env.TEST_VERIFIER_SECRET
    }
  })
})

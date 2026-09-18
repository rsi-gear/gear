import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HitchCliEvaluator } from '../../src/evaluator/hitch-cli.js'
import type { EvaluationRequest, EvaluationRerunReservation, RoundEvaluationAttempt } from '../../src/types.js'
import { roundFixture } from '../helpers/research-fixture.js'

// CI pins and builds the matching Hitch control-plane contract. Only the costly
// Harbor executor is replaced; CLI, HTTP routing, scheduling, persistence,
// cancellation and resource release are all the real Hitch implementation.
const hitchRoot = process.env.HITCH_CONTRACT_ROOT

describe.skipIf(hitchRoot === undefined)('real Hitch daemon rerun contract', () => {
  it.each(['abort', 'lost-observer', 'late-submit'] as const)('stops the owned rerun after %s', async scenario => {
    const source = resolve(hitchRoot!)
    const { DaemonServer, daemonClient } = await import(/* @vite-ignore */ pathToFileURL(join(source, 'dist/src/daemon/index.js')).href)
    const { validateEvalRequest } = await import(/* @vite-ignore */ pathToFileURL(join(source, 'dist/src/evals/index.js')).href)
    const { sha256JSON } = await import(/* @vite-ignore */ pathToFileURL(join(source, 'dist/src/foundation/index.js')).href)
    const root = await mkdtemp(join(tmpdir(), 'gear-hitch-rerun-contract-'))
    const daemonRoot = join(root, 'daemon')
    let started = 0
    let stopped = 0
    const server = new DaemonServer({ root: daemonRoot, port: 0, maxConcurrent: 1, logger: () => {},
      evalRerunExecutor: async ({ signal }: { signal: AbortSignal }) => {
        started++
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        stopped++
        throw new Error('Harbor executor stopped')
      },
    })
    await server.start()
    const executable = join(root, 'hitch.mjs')
    await writeFile(executable, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(join(source, 'dist/bin/hitch.js')).href)})\n`)
    await chmod(executable, 0o755)
    const evaluator = new HitchCliEvaluator({
      executable, root: daemonRoot, repositoryPath: root, harnessId: 'deepseek', model: 'deepseek-chat',
      attempts: 1, maxConcurrent: 1, setupTimeoutMs: 10_000, terminationGraceMs: 100,
      maxOutputBytes: 1024 * 1024, maxTrajectoryOutputBytes: 1024 * 1024,
      sampling: {}, agentArgs: [], passEnv: [], controlPlane: { mode: 'daemon', requireModelCapture: false },
    })
    const round = roundFixture({ workspaceRoot: root })
    const request: EvaluationRequest = { phase: 'seed-baseline', dataset: round.seedTaskRef, harnessRef: round.targetHarnessRef, condition: round.plan.seed }
    const evalId = `eval_${'a'.repeat(32)}`
    const attempt: RoundEvaluationAttempt = {
      provider: 'hitch-cli', evalId, phase: request.phase, conditionId: request.condition.conditionId,
      dataset: request.dataset, requestedCommit: request.harnessRef, requestedModelId: request.condition.model,
      owner: { candidateId: `champion-${request.harnessRef}`, role: 'baseline', harnessRef: request.harnessRef },
      status: 'failed', startedAt: 'before', completedAt: 'after',
    }
    const reservation = evaluator.prepareRerun(round, request, attempt, { mode: 'invalid' })!
    await writeFile(join(root, 'gear-rerun-reservation.json'), JSON.stringify(reservation))
    const evalDirectory = join(daemonRoot, 'evals', evalId)
    await mkdir(evalDirectory, { recursive: true })
    const evalRequest = await validateEvalRequest({ dataset: 'demo@1.0', harness_ref: 'pi@version:1.2.3', max_concurrent: 1 })
    const now = new Date().toISOString()
    await writeFile(join(evalDirectory, 'submission.json'), JSON.stringify({ schema_version: '1', eval_id: evalId, request: evalRequest, submission_digest: sha256JSON(evalRequest), submitted_at: now }))
    await writeFile(join(evalDirectory, 'control.json'), JSON.stringify({ schema_version: '1', eval_id: evalId, generation: 1, state: 'failed', requested_parallelism: 1, admitted_parallelism: 0, active_leases: [], queued_work_items: [], terminal_work_items: [], created_at: now, updated_at: now }))
    await writeFile(join(evalDirectory, 'result.json'), JSON.stringify({ schema_version: '1', eval_id: evalId, status: 'failed', exit_code: 1, started_at: now, completed_at: now }))
    const controller = new AbortController()
    try {
      if (scenario === 'late-submit') {
        await evaluator.cancelRerun(reservation)
        await expect(evaluator.rerun(round, request, attempt, { mode: 'invalid' }, controller.signal, reservation)).rejects.toMatchObject({ code: 'hitch_eval_rerun_failed' })
        expect(started).toBe(0)
      } else if (scenario === 'abort') {
        const pending = evaluator.rerun(round, request, attempt, { mode: 'invalid' }, controller.signal, reservation)
        const rejected = expect(pending).rejects.toThrow('Gear stopped')
        await expect.poll(() => started).toBe(1)
        controller.abort(new Error('Gear stopped'))
        await rejected
        expect(stopped).toBe(1)
      } else {
        const child = spawn(executable, ['--root', daemonRoot, 'eval', 'rerun', evalId, '--invalid', '--daemon', '--rerun-id', reservation.rerunId], { stdio: 'ignore' })
        const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()) })
        try {
          await expect.poll(() => started).toBe(1)
        } finally { child.kill('SIGTERM'); await exited }
        expect(stopped).toBe(0)
        const recovered = JSON.parse(await readFile(join(root, 'gear-rerun-reservation.json'), 'utf8')) as EvaluationRerunReservation
        // A new Gear instance/config still cancels using the saved daemon root.
        const restarted = new HitchCliEvaluator({ ...evaluator.options, root: join(root, 'other'), controlPlane: { mode: 'direct', requireModelCapture: false } })
        await restarted.cancelRerun(recovered)
        expect(stopped).toBe(1)
      }
      const client = await daemonClient(daemonRoot)
      expect((await client.request('/health')).eval_rerun_scheduler).toMatchObject({ queued: 0, running: 0 })
      if (scenario !== 'late-submit') {
        expect((await client.request(`/v1/evals/${evalId}/reruns/${reservation.rerunId}`)).state.status).toBe('cancelled')
      }
      expect(JSON.parse(await readFile(join(evalDirectory, 'control.json'), 'utf8')).state).toBe('failed')
    } finally {
      controller.abort()
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

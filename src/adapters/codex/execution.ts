import { lstat, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDigest } from '../../domain/canonical.js'
import { assertMutationPath } from '../../domain/mutation-policy.js'
import type { Json } from '../../domain/algorithm-wire.js'
import type { OperationReceipt } from '../../ports/operations.js'
import { snapshotTarget, targetResources } from '../storage/targets.js'
import { publishFile, syncDirectory } from '../storage/atomic.js'
import { prepareSandbox, codexAdapter } from './sandbox.js'
import { describeCodex, fileDigest } from './identity.js'
import type { CodexJob } from './contracts.js'
import { builtinPolicy } from '../python/builtin-policy.js'
import { executeHitchMeta } from './hitch-execution.js'
import { cleanupCodex, type CodexResources, type CodexWorkerLifecycle } from './cleanup.js'

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
export async function executeJob(
  job: CodexJob,
  directory: string,
  worker?: CodexWorkerLifecycle,
): Promise<OperationReceipt> {
  const { request, configuration: config, context } = job.input
  const operation = request.operation
  let sandbox: Awaited<ReturnType<typeof prepareSandbox>> | undefined
  let candidate: OperationReceipt['candidate'] = null,
    status: 'complete' | 'failed' = 'failed'
  let data: Json = { error: 'codex-execution-failed' },
    outcome = 'failed'
  let hitchResult: Awaited<ReturnType<typeof executeHitchMeta>> | undefined
  let modelStopped = true
  const resources: CodexResources = {}
  try {
    try {
      if (await exists(join(directory, 'cancel.json'))) throw new Error('codex-cancelled')
      const runtime = await describeCodex(config)
      if (runtime.identity !== job.identity) throw new Error('codex-identity-changed')
      sandbox = await prepareSandbox(job, runtime, resources)
      hitchResult = await executeHitchMeta(sandbox, directory, config.timeoutMs, () => {
        modelStopped = false
        worker?.modelStarted()
      })
      modelStopped = true
      worker?.modelStopped()
      if (!hitchResult.complete) throw new Error(hitchResult.outcome)
      if (await exists(join(directory, 'cancel.json'))) throw new Error('codex-cancelled')
      const resultPath = join(sandbox.output, 'result.json'),
        info = await lstat(resultPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
        throw new Error('codex-output-invalid')
      let result: Record<string, Json>
      try {
        result = builtinPolicy<Record<string, Json>>(
          request.operatorCall ? 'operator_meta_result' : 'meta_result',
          {
            operation,
            result: JSON.parse(await readFile(resultPath, 'utf8')),
            ...(request.operatorCall ? { operator_call: request.operatorCall } : {}),
          },
          context.experiencePython,
        )
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError)
          throw new Error('codex-output-invalid')
        throw error
      }
      data = result
      if (operation.kind === 'generate_candidate' && !result.declined) {
        const parent = await targetResources(join(context.targets, operation.parent_id!))
        const resources = await targetResources(sandbox.candidate)
        const before = new Map(parent.map((resource) => [resource.path, resource]))
        const after = new Map(resources.map((resource) => [resource.path, resource]))
        const adapter = codexAdapter(context.targetAdapter)
        for (const path of new Set([...before.keys(), ...after.keys()])) {
          if (canonicalDigest(before.get(path) ?? null) !== canonicalDigest(after.get(path) ?? null))
            assertMutationPath(path, adapter.mutationPolicy)
        }
        await adapter.check(sandbox.candidate)
        const destination = join(context.targets, operation.candidate_id!)
        const staged = join(context.targets, `.codex-${request.operationId.slice(7)}`)
        if (await exists(destination)) throw new Error('codex-candidate-conflict')
        await snapshotTarget(sandbox.candidate, staged)
        await rename(staged, destination)
        await syncDirectory(context.targets)
        candidate = {
          id: operation.candidate_id!,
          parent_id: operation.parent_id,
          digest: canonicalDigest(resources),
        }
      }
      status = result.declined ? 'failed' : 'complete'
      outcome = result.declined ? 'declined' : 'complete'
    } catch (error) {
      // Model output and native errors can contain credentials/paths; never forward them to algorithms.
      const known = [
        'codex-cancelled',
        'codex-timeout',
        'codex-controller-stopped',
        'codex-identity-changed',
        'codex-output-invalid',
        'codex-candidate-conflict',
        'codex-output-too-large',
        'generation-budget-exhausted',
        'hitch-meta-failed',
      ]
      outcome =
        error instanceof Error && known.includes(error.message) ? error.message : 'codex-execution-failed'
      data = { error: outcome }
    }
    // An exit event alone cannot prove that a signal-killed guard stopped its model.
    if (!modelStopped) throw new Error('codex-model-state-unknown')
    const events = join(directory, 'events.jsonl')
    const receipt: OperationReceipt = {
      result: {
        operation_id: request.operationId,
        kind: operation.kind,
        status,
        candidate_id: operation.candidate_id,
        data,
      },
      evidence: [],
      candidate,
      physicalAttempts: 0,
      usage: hitchResult?.usage ?? { tokens: null, model_requests: null, dollars: null },
      provenance: {
        provider: 'hitch',
        harness: 'codex',
        hitch_run_id: hitchResult?.runId ?? null,
        implementation: job.identity,
        model: config.model,
        input_digest: job.digest,
        outcome,
        events_digest: (await exists(events)) ? await fileDigest(events) : null,
      },
    }
    await publishFile(join(directory, 'receipt.json'), JSON.stringify(receipt), { immutable: true })
    return receipt
  } finally {
    // Includes preparation, validation, receipt construction and failed publication.
    worker?.beginCleanup()
    await cleanupCodex(directory, job.digest, resources, modelStopped)
  }
}

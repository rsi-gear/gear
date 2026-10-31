import { spawn } from 'node:child_process'
import { lstat, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalDigest } from '../../domain/canonical.js'
import { assertMutationPath } from '../../domain/mutation-policy.js'
import type { Json } from '../../domain/algorithm-wire.js'
import type { OperationReceipt } from '../../ports/operations.js'
import { snapshotTarget, targetResources } from '../storage/targets.js'
import { publishFile, syncDirectory } from '../storage/atomic.js'
import { prepareSandbox, codexAdapter } from './sandbox.js'
import { describeCodex, fileDigest } from './identity.js'
import type { CodexJob } from './contracts.js'
import { CodexUsage } from './usage.js'
import { cleanupCodex, type CodexResources, type CodexWorkerLifecycle } from './cleanup.js'

const MAX_CANDIDATE_DIFF_BYTES = 256 * 1024

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function candidateDiff(
  parentRoot: string,
  candidateRoot: string,
  parent: Awaited<ReturnType<typeof targetResources>>,
  candidate: Awaited<ReturnType<typeof targetResources>>,
): Promise<string> {
  const parentByPath = new Map(parent.map((resource) => [resource.path, resource]))
  const changed = candidate.filter(
    (resource) => canonicalDigest(parentByPath.get(resource.path) ?? null) !== canonicalDigest(resource),
  )
  let diff = ''
  for (const resource of changed) {
    const content = await readFile(join(candidateRoot, resource.path), 'utf8')
    diff += `--- ${resource.path}\n+++ ${resource.path}\n${content}\n`
    if (Buffer.byteLength(diff, 'utf8') >= MAX_CANDIDATE_DIFF_BYTES)
      return diff.slice(0, MAX_CANDIDATE_DIFF_BYTES)
  }
  const candidatePaths = new Set(candidate.map((resource) => resource.path))
  for (const resource of parent) {
    if (candidatePaths.has(resource.path)) continue
    diff += `--- ${resource.path}\n+++ /dev/null\n`
    if (Buffer.byteLength(diff, 'utf8') >= MAX_CANDIDATE_DIFF_BYTES)
      return diff.slice(0, MAX_CANDIDATE_DIFF_BYTES)
  }
  return diff
}

function parseResult(value: unknown, taskIds: string[]): Record<string, Json> {
  const data = value as Record<string, Json>
  const strings = (input: unknown): input is string[] =>
    Array.isArray(input) &&
    input.length <= 256 &&
    input.every((item) => typeof item === 'string' && item.length <= 16_384)
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).some((key) => !['summary', 'declined', 'hypotheses', 'clusters'].includes(key)) ||
    typeof data.summary !== 'string' ||
    data.summary.length > 16_384 ||
    typeof data.declined !== 'boolean' ||
    !strings(data.hypotheses) ||
    !Array.isArray(data.clusters) ||
    data.clusters.length > 256 ||
    data.clusters.some(
      (cluster) =>
        !cluster ||
        typeof cluster !== 'object' ||
        Array.isArray(cluster) ||
        Object.keys(cluster).some((key) => !['task_ids', 'hypotheses'].includes(key)) ||
        !strings(cluster.task_ids) ||
        cluster.task_ids.some((id) => !taskIds.includes(id)) ||
        !strings(cluster.hypotheses),
    )
  )
    throw new Error('codex-output-invalid')
  return data
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
  const usage = new CodexUsage()
  let processCompleted = false,
    modelStopped = true
  const resources: CodexResources = {}
  try {
    try {
      if (await exists(join(directory, 'cancel.json'))) throw new Error('codex-cancelled')
      const runtime = await describeCodex(config)
      if (runtime.identity !== job.identity) throw new Error('codex-identity-changed')
      sandbox = await prepareSandbox(job, runtime, resources)
      const log = await open(join(directory, 'events.jsonl'), 'wx', 0o600)
      const diagnostics = await open(join(directory, 'stderr.log'), 'wx', 0o600)
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.env.GEAR_LOCK_PYTHON || 'python3',
            ['-I', '-B', fileURLToPath(new URL('../../../assets/codex-process-guard.py', import.meta.url))],
            { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
          )
          if (child.pid !== undefined) {
            modelStopped = false
            worker?.modelStarted()
          }
          let confirmation = ''
          child.stdio[3]!.on('data', (chunk: Buffer) => {
            if (Buffer.byteLength(confirmation) <= 1024) confirmation += chunk.toString('utf8')
          })
          let pending = '',
            bytes = 0,
            reason: string | undefined
          const kill = (message: string): void => {
            reason ??= message
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          }
          const timer = setTimeout(() => kill('codex-timeout'), config.timeoutMs)
          let checking = false
          const polling = setInterval(() => {
            if (checking) return
            checking = true
            void exists(join(directory, 'cancel.json'))
              .then((cancel) => {
                if (cancel) kill('codex-cancelled')
              })
              .catch(() => kill('codex-cancel-check-failed'))
              .finally(() => {
                checking = false
              })
          }, 100)
          // A killed controller cannot leave a model process running indefinitely.
          const terminate = (): void => kill('codex-controller-stopped')
          process.once('SIGTERM', terminate)
          process.once('SIGINT', terminate)
          child.stdin.on('error', () => {})
          let writes = Promise.resolve()
          let errorBytes = 0
          child.stderr.on('data', (chunk: Buffer) => {
            if (errorBytes >= 64 * 1024) return
            const bounded = chunk.subarray(0, 64 * 1024 - errorBytes)
            errorBytes += bounded.length
            writes = writes
              .then(async () => {
                await diagnostics.write(bounded)
              })
              .catch(() => kill('codex-log-failed'))
          })
          child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > 32 * 1024 * 1024) {
              kill('codex-output-too-large')
              return
            }
            writes = writes
              .then(async () => {
                await log.write(chunk)
              })
              .catch(() => kill('codex-log-failed'))
            pending += chunk.toString('utf8')
            while (pending.includes('\n')) {
              const index = pending.indexOf('\n'),
                line = pending.slice(0, index)
              pending = pending.slice(index + 1)
              usage.record(line)
            }
          })
          let spawnError: Error | undefined
          child.once('error', (error) => {
            spawnError = error
          })
          child.once('close', (code, signal) => {
            try {
              const ack = JSON.parse(confirmation) as {
                version?: number
                model_stopped?: boolean
                returncode?: number
              }
              if (!signal && ack.version === 1 && ack.model_stopped === true && ack.returncode === code) {
                modelStopped = true
                worker?.modelStopped()
              }
            } catch {
              /* Missing or damaged guard confirmation keeps the operation unknown. */
            }
            if (spawnError && child.pid === undefined) {
              modelStopped = true
              worker?.modelStopped()
            }
            clearTimeout(timer)
            clearInterval(polling)
            process.removeListener('SIGTERM', terminate)
            process.removeListener('SIGINT', terminate)
            if (pending.trim()) usage.record(pending)
            void writes.then(() => {
              if (!modelStopped || reason || spawnError || code !== 0)
                reject(new Error(reason ?? 'codex-process-failed'))
              else resolve()
            }, reject)
          })
          child.stdin.write(
            `${JSON.stringify({
              argv: sandbox!.argv,
              env: sandbox!.env,
              cwd: sandbox!.candidate,
              prompt: sandbox!.prompt,
              cleanupRoot: sandbox!.root,
              timeoutMs: config.timeoutMs,
              ...(worker ? { controllerGroup: worker.group } : {}),
            })}\n`,
          )
          // Keep the pipe open: EOF also kills the sandbox if this worker is SIGKILLed.
        })
        processCompleted = true
        await log.sync()
      } finally {
        await log.close()
        await diagnostics.close()
      }
      if (await exists(join(directory, 'cancel.json'))) throw new Error('codex-cancelled')
      const resultPath = join(sandbox.output, 'result.json'),
        info = await lstat(resultPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
        throw new Error('codex-output-invalid')
      const result = parseResult(JSON.parse(await readFile(resultPath, 'utf8')), operation.task_ids)
      data = result
      if (operation.kind === 'generate_candidate' && !result.declined) {
        const parentRoot = join(context.targets, operation.parent_id!)
        const parent = await targetResources(parentRoot)
        const candidateRoot = sandbox.candidate
        const resources = await targetResources(candidateRoot)
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
        data = {
          ...result,
          candidate_diff: await candidateDiff(parentRoot, candidateRoot, parent, resources),
        }
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
      usage: usage.result(processCompleted),
      provenance: {
        provider: 'codex',
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

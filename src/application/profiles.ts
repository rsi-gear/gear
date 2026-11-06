import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GearError } from '../domain/errors.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { OperationProvider, OperationRequest } from '../ports/operations.js'
import { ProcessOperationProvider } from '../adapters/process/operation-provider.js'
import type { ProjectBindings, ProjectRuntimeContext } from './project-service.js'
import type { Json } from '../domain/algorithm-wire.js'
import { HitchOperationProvider } from '../adapters/hitch/provider.js'
import { harnessAdapter } from './harness-adapters.js'
import { pythonExecutable, pythonJson, pythonSourceRoot } from './python.js'
import { configuredCancellation } from './cancellation.js'

import { profile, assertProfileRole, processProfile } from './profile-store.js'
export { profile, profileRoot } from './profile-store.js'

export async function configuredProvider(
  context: ProjectRuntimeContext,
  signal: AbortSignal = new AbortController().signal,
): Promise<OperationProvider> {
  signal.throwIfAborted()
  const targets = join(context.stateRoot, 'runs', context.runId, 'targets')
  const shared = { runId: context.runId, targetAdapter: context.config.target.adapter, targets }
  const targetProfile = await profile(context.config.target.profile)
  assertProfileRole(targetProfile, 'target', context.config.target.adapter)
  const evaluation: OperationProvider =
    'kind' in targetProfile && targetProfile.kind === 'hitch'
      ? await HitchOperationProvider.connect(
          targetProfile,
          {
            directory: join(context.stateRoot, 'runs', context.runId, 'providers/hitch'),
            targets,
            taskIds: context.benchmark.tasks.map((task) => task.id),
            adapter: harnessAdapter(context.config.target.adapter),
            implementationIdentity: canonicalDigest(
              await Promise.all([
                ...[
                  'hitch/provider',
                  'hitch/connection',
                  'hitch/binding',
                  'hitch/preparation',
                  'hitch/sdk',
                  'process/executable',
                  'hitch/dataset',
                  'python/benchmark-limits',
                  'hitch/control',
                  'hitch/conditions',
                  'hitch/artifacts',
                  'hitch/environment',
                  'hitch/json',
                  'hitch/failure',
                  'hitch/observation',
                  'hitch/evidence',
                  'hitch/verifier',
                  'hitch/transport',
                  'hitch/settings',
                  'hitch/trajectory',
                  'hitch/native-source',
                  `${context.config.target.adapter}/harness`,
                ].map((name) =>
                  readFile(
                    new URL(
                      `../adapters/${name}${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`,
                      import.meta.url,
                    ),
                    'utf8',
                  ),
                ),
                ...[
                  'benchmark/harbor.py',
                  'benchmark/native.py',
                  'benchmark/payload.py',
                  'benchmark/limits.py',
                  'benchmark/limits.json',
                  'benchmark/environment.py',
                  'benchmark/manifest.py',
                  'benchmark/manifest_codec.cjs',
                  'benchmark/scorers.py',
                  'benchmark/source.py',
                  'benchmark/python_scorer.py',
                  'benchmark/llm_scorer.py',
                  'benchmark/runtime_limits.py',
                  'algorithms/verifier.py',
                  'canonical.py',
                ].map((name) => readFile(join(pythonSourceRoot, 'gear', name), 'utf8')),
              ]),
            ),
            seal: (destination, taskIds) =>
              pythonJson(['benchmark', 'seal-harbor'], {
                benchmark: context.benchmark,
                destination,
                task_ids: taskIds,
              }),
            compile: (destination, taskIds, baseImage, compileSignal) =>
              pythonJson(
                ['benchmark', 'harbor', '--output', destination],
                {
                  benchmark: context.benchmark,
                  task_ids: taskIds,
                  base_image: baseImage,
                },
                compileSignal,
              ),
            compilePlanning: (destination, taskIds, baseImage, compileSignal) =>
              pythonJson(
                ['benchmark', 'harbor', '--output', destination],
                {
                  benchmark: context.benchmark,
                  task_ids: taskIds,
                  base_image: baseImage,
                  planning_only: true,
                },
                compileSignal,
              ),
          },
          signal,
        )
      : await ProcessOperationProvider.connect(
          processProfile(targetProfile as Parameters<typeof processProfile>[0]),
          {
            ...shared,
            benchmark: context.benchmark,
          } as unknown as Json,
          signal,
        )
  if (context.kind === 'evaluate') return evaluation
  const metaProfile = await profile(context.config.meta.profile)
  assertProfileRole(metaProfile, 'meta')
  if ('kind' in metaProfile && metaProfile.kind === 'hitch')
    throw new GearError('invalid-meta-profile', 'Select an external Meta process profile')
  const meta = await ProcessOperationProvider.connect(
    processProfile(
      'kind' in metaProfile && metaProfile.kind === 'codex' && context.config.sandbox
        ? {
            ...metaProfile,
            configuration: {
              ...metaProfile.configuration,
              linuxIsolation: context.config.sandbox.linux_isolation,
            },
          }
        : metaProfile,
    ),
    {
      ...shared,
      directory: join(context.stateRoot, 'runs', context.runId, 'providers/codex'),
      experiencePython: await pythonExecutable(),
      ...(evaluation.artifactReader ? { artifactReader: evaluation.artifactReader } : {}),
      protectedPaths: [context.root, context.stateRoot],
      tasks: context.benchmark.tasks
        .filter((task) => context.benchmark.splits.seed.includes(task.id))
        .map(({ id, family, instruction }) => ({ id, family, instruction })),
    } as unknown as Json,
    signal,
  )
  const choose = (request: OperationRequest) =>
    request.operation.kind === 'evaluate_seed' ? evaluation : meta
  return {
    identity: canonicalDigest({ evaluation: evaluation.identity, meta: meta.identity }),
    async prepareAdmission() {
      await evaluation.prepareAdmission?.()
      await meta.prepareAdmission()
    },
    cancellation: {
      version: 1,
      kind: 'composite',
      evaluation: evaluation.cancellation ?? null,
      meta: meta.cancellation ?? null,
    },
    ...(evaluation.artifactReader ? { artifactReader: evaluation.artifactReader } : {}),
    evaluationIdentity: evaluation.identity,
    timeouts: {
      ...(evaluation.timeouts?.taskRuntime ? { taskRuntime: evaluation.timeouts.taskRuntime } : {}),
      target: evaluation.timeouts?.target ?? null,
      meta:
        'kind' in metaProfile && metaProfile.kind === 'codex'
          ? [
              ...(meta.timeouts?.meta ?? []),
              {
                name: 'codex-generation',
                scope: 'meta-operation',
                milliseconds: metaProfile.configuration.timeoutMs,
              },
            ]
          : (meta.timeouts?.meta ?? null),
    },
    capabilities: {
      ...evaluation.capabilities,
      idempotentSubmission:
        evaluation.capabilities.idempotentSubmission && meta.capabilities.idempotentSubmission,
      inspect: evaluation.capabilities.inspect && meta.capabilities.inspect,
      cancel: evaluation.capabilities.cancel && meta.capabilities.cancel,
      hardDollarBudget: evaluation.capabilities.hardDollarBudget && meta.capabilities.hardDollarBudget,
      generationBudget: meta.capabilities.generationBudget,
    },
    completeEvidence: (request, signal) => {
      if (!evaluation.completeEvidence)
        throw new GearError(
          'evidence-projection-unsupported',
          'Evaluation provider cannot project original artifacts',
        )
      return evaluation.completeEvidence(request, signal)
    },
    submit: (request, signal) => choose(request).submit(request, signal),
    inspect: (request, signal) => choose(request).inspect(request, signal),
    cancel: (request) => choose(request).cancel(request),
  }
}
export const configuredBindings: ProjectBindings = {
  provider: configuredProvider,
  cancellation: configuredCancellation,
}

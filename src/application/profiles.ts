import { ModelOperationProvider } from '../adapters/model/provider.js'
import { materialReferences } from '../domain/materials.js'
import { isArtifactOperation } from '../domain/artifacts.js'
import { candidateReferences } from '../domain/candidate-references.js'
import { isLocalWorkspace } from '../domain/workspaces.js'
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
                  'hitch/trial-details',
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
                  'refine/verifier.py',
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
  const roleProfiles = context.config.meta.roles ?? {}
  const metaTimeouts: NonNullable<OperationProvider['timeouts']>['meta'] = []
  const connectMeta = async (name: string, directory: string): Promise<OperationProvider> => {
    const selected = await profile(name)
    assertProfileRole(selected, 'meta')
    const tasks = context.benchmark.tasks
      .filter((task) => context.benchmark.splits.seed.includes(task.id))
      .map(({ id, family, instruction }) => ({ id, family, instruction }))
    if ('kind' in selected && selected.kind === 'model') {
      const provider = await ModelOperationProvider.connect(selected, { directory, tasks })
      metaTimeouts.push(...provider.timeouts.meta)
      return provider
    }
    if ('kind' in selected && selected.kind === 'hitch')
      throw new GearError('invalid-meta-profile', 'Select a Meta execution profile')
    const provider = await ProcessOperationProvider.connect(
      processProfile(
        'kind' in selected && selected.kind === 'codex' && context.config.sandbox
          ? {
              ...selected,
              configuration: {
                ...selected.configuration,
                linuxIsolation: context.config.sandbox.linux_isolation,
              },
            }
          : selected,
      ),
      {
        ...shared,
        directory,
        experiencePython: await pythonExecutable(),
        ...(evaluation.artifactReader ? { artifactReader: evaluation.artifactReader } : {}),
        protectedPaths: [context.root, context.stateRoot],
        tasks,
      } as unknown as Json,
      signal,
    )
    metaTimeouts.push(...(provider.timeouts.meta ?? []))
    if ('kind' in selected && selected.kind === 'codex')
      metaTimeouts.push({
        name: 'codex-generation',
        scope: 'meta-operation',
        milliseconds: selected.configuration.timeoutMs,
      })
    return provider
  }
  const meta = await connectMeta(
    context.config.meta.profile,
    join(context.stateRoot, 'runs', context.runId, 'providers/codex'),
  )
  const roles = Object.create(null) as Record<string, OperationProvider>
  for (const [role, name] of Object.entries(roleProfiles))
    roles[role] = await connectMeta(
      name,
      join(context.stateRoot, 'runs', context.runId, 'providers/roles', role),
    )
  const roleProviders = [meta, ...Object.values(roles)]
  const chooseOperation = (operation: OperationRequest['operation']) => {
    if (operation.kind === 'evaluate_seed') return evaluation
    const role =
      operation.payload && typeof operation.payload === 'object' && !Array.isArray(operation.payload)
        ? operation.payload.gear_role_v1
        : undefined
    return typeof role === 'string' && Object.hasOwn(roles, role) ? roles[role]! : meta
  }
  const choose = (request: OperationRequest) => chooseOperation(request.operation)
  const roleCancellation = Object.fromEntries(
    Object.entries(roles).map(([role, provider]) => [role, provider.cancellation ?? null]),
  )
  return {
    identity: canonicalDigest({
      evaluation: evaluation.identity,
      meta: meta.identity,
      ...(Object.keys(roles).length
        ? {
            roles: Object.fromEntries(
              Object.entries(roles).map(([role, provider]) => [role, provider.identity]),
            ),
          }
        : {}),
    }),
    async prepareAdmission() {
      await evaluation.prepareAdmission?.()
      for (const provider of roleProviders) await provider.prepareAdmission?.()
    },
    cancellation: {
      version: 1,
      kind: 'composite',
      evaluation: evaluation.cancellation ?? null,
      meta: meta.cancellation ?? null,
      ...(Object.keys(roles).length ? { roles: roleCancellation } : {}),
    },
    ...(evaluation.artifactReader ? { artifactReader: evaluation.artifactReader } : {}),
    evaluationIdentity: evaluation.identity,
    timeouts: {
      ...(evaluation.timeouts?.taskRuntime ? { taskRuntime: evaluation.timeouts.taskRuntime } : {}),
      target: evaluation.timeouts?.target ?? null,
      meta: metaTimeouts,
    },
    capabilities: {
      ...evaluation.capabilities,
      idempotentSubmission:
        evaluation.capabilities.idempotentSubmission &&
        roleProviders.every((provider) => provider.capabilities.idempotentSubmission),
      inspect:
        evaluation.capabilities.inspect && roleProviders.every((provider) => provider.capabilities.inspect),
      cancel:
        evaluation.capabilities.cancel && roleProviders.every((provider) => provider.capabilities.cancel),
      hardDollarBudget:
        evaluation.capabilities.hardDollarBudget &&
        roleProviders.every((provider) => provider.capabilities.hardDollarBudget),
      generationBudget: roleProviders.every((provider) => provider.capabilities.generationBudget),
      candidateReferences: roleProviders.some((provider) => provider.capabilities.candidateReferences),
      workspaces: roleProviders.some((provider) => provider.capabilities.workspaces),
      readOnlyMaterials: roleProviders.some((provider) => provider.capabilities.readOnlyMaterials),
    },
    capabilitiesFor: (operation) => chooseOperation(operation).capabilities,
    validateOperation(operation) {
      if (
        isArtifactOperation(operation.kind) ||
        isLocalWorkspace(operation.kind) ||
        operation.kind === 'nominate' ||
        operation.kind === 'stop'
      )
        return
      const provider = chooseOperation(operation)
      provider.validateOperation?.(operation)
      if (Object.keys(candidateReferences(operation)).length && !provider.capabilities.candidateReferences)
        throw new GearError(
          'candidate-references-unsupported',
          'Selected role executor cannot materialize references',
        )
      if (Object.keys(materialReferences(operation)).length && !provider.capabilities.readOnlyMaterials)
        throw new GearError(
          'materials-unsupported',
          'Selected role executor cannot materialize read-only inputs',
        )
      if (operation.kind === 'workspace_edit' && !provider.capabilities.workspaces)
        throw new GearError(
          'workspaces-unsupported',
          'Selected role executor cannot edit workspace revisions',
        )
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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GearError } from '../../domain/errors.js'
import type { HitchProfile, HitchProviderContext } from './provider.js'
import type { inspectHitchConnection } from './connection.js'
import { openHitchSdk, sdkObject, type HitchEnvironment } from './sdk.js'
import { parsePreparedArtifacts, type TaskArtifact } from './artifacts.js'
import { hitchSettings } from './settings.js'

// Bound simultaneous host Python inspectors independently of task execution.
const taskInspectionBatchSize = 8

type Connection = Awaited<ReturnType<typeof inspectHitchConnection>>
export interface HitchRuntimeAccess {
  prepare(
    profile: HitchProfile,
    context: HitchProviderContext,
    connection: Connection,
    signal: AbortSignal,
  ): Promise<TaskArtifact[]>
  verify(
    profile: HitchProfile,
    bindings: TaskArtifact[],
    environment: HitchEnvironment,
    signal: AbortSignal,
  ): Promise<void>
}
async function bounded<T>(
  signal: AbortSignal,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController(),
    timer = setTimeout(() => deadline.abort(), timeoutMs)
  const combined = AbortSignal.any([signal, deadline.signal])
  try {
    return await work(combined)
  } catch (error) {
    if (error instanceof GearError) throw error
    throw new GearError(
      'hitch-preparation-failed',
      'Hitch could not prepare or verify the frozen Target artifacts',
      { retryable: true },
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Uses Hitch's public preparation APIs and cache; it owns no evaluation jobs. */
export class HitchPreparedRuntime implements HitchRuntimeAccess {
  async prepare(
    profile: HitchProfile,
    context: HitchProviderContext,
    connection: Connection,
    signal: AbortSignal,
  ): Promise<TaskArtifact[]> {
    return bounded(signal, hitchSettings(profile).preparationTimeoutMs, async (signal) => {
      if (!context.taskIds.length || new Set(context.taskIds).size !== context.taskIds.length)
        throw new GearError(
          'hitch-preparation-tasks',
          'Artifact preparation requires the frozen benchmark task set',
        )
      const sdk = await openHitchSdk(profile, connection.executionEnvironment)
      await sdk.check(signal)
      const controller = sdkObject(
        await sdk.call('controller', 'ensureControllerRuntime', {
          root: profile.root,
          payloadRoot: sdk.root,
        }),
      )
      if (
        controller.runtime_id !== connection.executionEnvironment.controller.runtime_id ||
        typeof controller.directory !== 'string'
      )
        throw new GearError(
          'hitch-sdk-runtime-mismatch',
          'Prepared controller payload differs from the observed daemon',
        )
      const resolution = sdkObject(
        await sdk.call('revisions', 'resolveHarness', profile.harnessRef, {
          root: profile.root,
          env: process.env,
        }),
      )
      if (resolution.identity !== connection.revisionIdentity)
        throw new GearError('hitch-revision-drift', 'Target source changed during artifact preparation')
      const temporary = await mkdtemp(join(tmpdir(), 'gear-hitch-preparation-')),
        dataset = join(temporary, 'dataset')
      try {
        let localTransport: unknown
        if (profile.harnessRef.includes('@git+')) {
          const reference = sdkObject(
              await sdk.call('revisions', 'parseHarnessReference', profile.harnessRef),
            ),
            selector = sdkObject(reference.selector),
            source = sdkObject(selector.source)
          if (
            selector.type !== 'commit' ||
            source.explicit !== true ||
            typeof source.local_path !== 'string' ||
            sdkObject(resolution.revision).commit !== selector.value
          )
            throw new GearError('hitch-revision-drift', 'Local Git source must resolve to its exact commit')
          // The Docker builder cannot access the host repository path. Export
          // the exact commit through Hitch's verified transport before building.
          localTransport = await sdk.call('backends', 'buildLocalGitTransport', {
            evalDirectory: temporary,
            resolvedRevision: resolution,
            sourceDirectory: source.local_path,
            env: process.env,
            signal,
          })
        }
        if (context.compilePlanning)
          await context.compilePlanning(dataset, context.taskIds, profile.baseImage, signal)
        else await context.compile(dataset, context.taskIds, profile.baseImage, signal)
        signal.throwIfAborted()
        const groups = new Map<string, string[]>()
        for (let offset = 0; offset < context.taskIds.length; offset += taskInspectionBatchSize) {
          const tasks = await sdk.call('evals', 'resolveLocalTaskPlanningInputs', {
            root: profile.root,
            dataset,
            taskIds: context.taskIds.slice(offset, offset + taskInspectionBatchSize),
            defaultResources: sdk.value('evals', 'DEFAULT_EVAL_TRIAL_RESOURCES'),
            defaultSource: 'submission-default',
            inspectorPath: join(
              controller.directory,
              'payload/integrations/harbor/hitch_harbor_task_resources.py',
            ),
            env: process.env,
            signal,
          })
          if (!Array.isArray(tasks))
            throw new GearError('hitch-sdk-contract', 'Hitch did not report task runtime platforms')
          for (const raw of tasks) {
            const task = sdkObject(raw)
            const platform =
              task.runtime_platform ?? sdk.value('backends', 'DEFAULT_HARBOR_TRIAL_DOCKER_PLATFORM')
            if (typeof platform !== 'string' || typeof task.task_id !== 'string')
              throw new GearError('hitch-sdk-contract', 'Hitch did not report task runtime platforms')
            groups.set(platform, [...(groups.get(platform) ?? []), task.task_id])
          }
        }
        const assignments = []
        for (const [platform, taskIds] of groups) {
          signal.throwIfAborted()
          const runtime = sdkObject(await sdk.call('backends', 'harborTrialRuntimeContract', platform))
          const prepared = sdkObject(
            await sdk.call('evals', 'prepareHarborArtifact', {
              root: profile.root,
              resolvedRevision: resolution,
              runtimeDirectory: controller.directory,
              runtimeId: controller.runtime_id,
              runtimeContract: runtime,
              ...(localTransport === undefined ? {} : { localTransport }),
              env: process.env,
              signal,
            }),
          )
          const artifact = sdkObject(prepared.artifact)
          assignments.push({
            ...artifact,
            task_ids: taskIds,
            runtime_contract: {
              docker_platform: runtime.dockerPlatform,
              artifact_platform: runtime.artifactPlatform,
              node_version: runtime.nodeVersion,
            },
          })
        }
        const bindings = parsePreparedArtifacts(
          {
            prepared_artifacts: assignments,
            ...(assignments.length === 1 ? { prepared_artifact: assignments[0] } : {}),
          },
          {
            harnessRef: profile.harnessRef,
            revisionIdentity: connection.revisionIdentity,
            taskIds: context.taskIds,
          },
        )
        await sdk.check(signal)
        return bindings
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    })
  }
  async verify(
    profile: HitchProfile,
    bindings: TaskArtifact[],
    environment: HitchEnvironment,
    signal: AbortSignal,
  ): Promise<void> {
    return bounded(signal, hitchSettings(profile).preparationTimeoutMs, async (signal) => {
      const sdk = await openHitchSdk(profile, environment)
      await sdk.check(signal)
      const seen = new Set<string>()
      for (const { artifact } of bindings) {
        signal.throwIfAborted()
        if (seen.has(artifact.artifact_id)) continue
        await sdk.call('evals', 'loadHarborArtifact', profile.root, artifact)
        seen.add(artifact.artifact_id)
      }
      await sdk.check(signal)
    })
  }
}

import { access, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, it, vi, beforeEach } from 'vitest'
import { HitchPreparedRuntime } from '../../src/adapters/hitch/preparation.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { digestJson } from '../../src/adapters/hitch/json.js'
import { GearError } from '../../src/domain/errors.js'
import type { HitchProfile, HitchProviderContext } from '../../src/adapters/hitch/provider.js'
import type { inspectHitchConnection } from '../../src/adapters/hitch/connection.js'

const sdk = vi.hoisted(() => ({ root: '/sdk', check: vi.fn(), call: vi.fn(), value: vi.fn() }))
vi.mock('../../src/adapters/hitch/sdk.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/adapters/hitch/sdk.js')>(), openHitchSdk: vi.fn(async () => sdk),
}))
const profile: HitchProfile = { kind: 'hitch', executable: '/sdk/hitch', root: '/cache', harnessRef: 'deepseek@version:1.0.0', model: 'unused', passEnv: [], baseImage: 'image@'+digestJson('image'), timeoutMs: 1000 }
const connection: Awaited<ReturnType<typeof inspectHitchConnection>> = {
  revisionIdentity: digestJson('revision'), capabilities: {}, executionEnvironment: {
    provider: 'local-docker', workerId: 'local', collisionDomainId: 'engine',
    controller: { schema_version: '2', package_version: '0.2.16', node_version: 'v22.23.0', runtime_id: digestJson('controller'), source: { kind: 'unavailable', commit: null, dirty: null } },
    environment: {},
  },
}
let directory: string
const context: HitchProviderContext = {
  directory: '/submissions', targets: '/targets', adapter: new DshHarnessAdapter(), taskIds: ['a', 'b', 'c'], implementationIdentity: digestJson('adapter'),
  // The production compiler owns its destination and rejects an existing tree.
  compile: vi.fn(async path => { directory = path; await mkdir(path) }),
}
const signal = new AbortController().signal
beforeEach(() => {
  vi.clearAllMocks()
  sdk.value.mockImplementation((_namespace, key) => key === 'DEFAULT_HARBOR_TRIAL_DOCKER_PLATFORM' ? 'linux/amd64' : {})
  sdk.call.mockImplementation(async (_namespace, key, input) => {
    if (key === 'ensureControllerRuntime') return { runtime_id: connection.executionEnvironment.controller.runtime_id, directory: '/controller' }
    if (key === 'resolveHarness') return { identity: connection.revisionIdentity }
    if (key === 'resolveLocalTaskPlanningInputs') return input.taskIds.map((id: string) => ({ task_id: id, ...(id !== 'b' ? { runtime_platform: 'linux/arm64' } : {}) }))
    if (key === 'harborTrialRuntimeContract') return { dockerPlatform: input, artifactPlatform: input === 'linux/amd64' ? 'linux-x64' : 'linux-arm64', nodeVersion: 'v22.23.0' }
    if (key === 'prepareHarborArtifact') return { artifact: { artifact_id: digestJson(input.runtimeContract.artifactPlatform), artifact_integrity: digestJson('tree'), entrypoint_integrity: digestJson('entry'), harness_id: 'deepseek', revision_identity: connection.revisionIdentity, platform: input.runtimeContract.artifactPlatform, node_version: 'v22.23.0', source_type: 'npm', storage: 'harbor-artifact-cache-v2' } }
    return {}
  })
})
it('prepares once per declared/default platform and freezes every task before returning', async () => {
  const runtime = new HitchPreparedRuntime(), result = await runtime.prepare(profile, context, connection, signal)
  expect(result.map(row => [row.task_id, row.runtime_contract.docker_platform])).toEqual([['a','linux/arm64'], ['b','linux/amd64'], ['c','linux/arm64']])
  expect(sdk.call.mock.calls.filter(([, key]) => key === 'prepareHarborArtifact')).toHaveLength(2)
  expect(sdk.check).toHaveBeenCalledTimes(2)
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(dirname(directory))).rejects.toMatchObject({ code: 'ENOENT' })
  await runtime.verify(profile, result, connection.executionEnvironment, signal)
  expect(sdk.call.mock.calls.filter(([, key]) => key === 'loadHarborArtifact')).toHaveLength(2)
})
it('stops before compilation when SDK environment does not match the resident daemon', async () => {
  sdk.check.mockRejectedValueOnce(new GearError('hitch-sdk-environment-mismatch', 'changed'))
  await expect(new HitchPreparedRuntime().prepare(profile, context, connection, signal)).rejects.toMatchObject({ code: 'hitch-sdk-environment-mismatch' })
  expect(context.compile).not.toHaveBeenCalled()
})
it('uses declaration-only compilation for planning when available', async () => {
  const compilePlanning = vi.fn(async (path: string) => { directory = path; await mkdir(path) })
  const bindings = await new HitchPreparedRuntime().prepare({ ...profile }, { ...context, compilePlanning }, connection, signal)
  expect(bindings).toHaveLength(3)
  expect(compilePlanning).toHaveBeenCalledOnce()
  expect(context.compile).not.toHaveBeenCalled()
  expect(compilePlanning.mock.calls[0]).toEqual([directory, context.taskIds, profile.baseImage, expect.any(AbortSignal)])
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('sanitizes preparation failures and removes temporary datasets', async () => {
  const original = sdk.call.getMockImplementation()!
  sdk.call.mockImplementation(async (...args) => {
    if (args[1] === 'prepareHarborArtifact') throw new Error('private diagnostic')
    return original(...args)
  })
  await expect(new HitchPreparedRuntime().prepare(profile, context, connection, signal)).rejects.toMatchObject({ code: 'hitch-preparation-failed', message: expect.not.stringContaining('private') })
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects missing task coverage rather than silently freezing a partial benchmark', async () => {
  const original = sdk.call.getMockImplementation()!
  sdk.call.mockImplementation(async (...args) => args[1] === 'resolveLocalTaskPlanningInputs' ? [{ task_id: 'a' }] : original(...args))
  await expect(new HitchPreparedRuntime().prepare(profile, context, connection, signal)).rejects.toMatchObject({ code: 'hitch-artifact-identity' })
})

it('exports a pinned local Git source once and mounts the verified transport in each platform builder', async () => {
  const commit = 'a'.repeat(40), original = sdk.call.getMockImplementation()!
  const selected = { ...profile, harnessRef: `deepseek@git+file:///custom/runtime#${commit}` }
  let transport: unknown, temporary = ''
  sdk.call.mockImplementation(async (...args) => {
    const [, key, input] = args
    if (key === 'parseHarnessReference') return { selector: { type: 'commit', value: commit, source: { explicit: true, local_path: '/custom/runtime' } } }
    if (key === 'resolveHarness') return { identity: connection.revisionIdentity, revision: { commit } }
    if (key === 'buildLocalGitTransport') {
      temporary = input.evalDirectory
      expect(input.sourceDirectory).toBe('/custom/runtime')
      expect(input.signal.aborted).toBe(false)
      await mkdir(temporary + '/local-source')
      transport = { directory: temporary + '/local-source', manifest: { commit } }
      return transport
    }
    const result = await original(...args)
    if (key === 'prepareHarborArtifact') {
      expect(input.localTransport).toBe(transport)
      result.artifact.source_type = 'git'
    }
    return result
  })
  const bindings = await new HitchPreparedRuntime().prepare(selected, context, connection, signal)
  expect(bindings).toHaveLength(3)
  expect(sdk.call.mock.calls.filter(([, key]) => key === 'buildLocalGitTransport')).toHaveLength(1)
  expect(sdk.call.mock.calls.filter(([, key]) => key === 'prepareHarborArtifact')).toHaveLength(2)
  await expect(access(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a local Git resolution for a different commit before exporting or compiling', async () => {
  const original = sdk.call.getMockImplementation()!, commit = 'a'.repeat(40)
  sdk.call.mockImplementation(async (...args) => {
    if (args[1] === 'parseHarnessReference') return { selector: { type: 'commit', value: commit, source: { explicit: true, local_path: '/custom/runtime' } } }
    if (args[1] === 'resolveHarness') return { identity: connection.revisionIdentity, revision: { commit: 'b'.repeat(40) } }
    return original(...args)
  })
  await expect(new HitchPreparedRuntime().prepare({ ...profile, harnessRef: `deepseek@git+file:///custom/runtime#${commit}` }, context, connection, signal))
    .rejects.toMatchObject({ code: 'hitch-revision-drift' })
  expect(context.compile).not.toHaveBeenCalled()
  expect(sdk.call.mock.calls.filter(([, key]) => key === 'buildLocalGitTransport')).toHaveLength(0)
})

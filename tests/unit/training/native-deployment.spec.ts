import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { digestJson } from '../../../src/training/digest.js'
import { ManagedNativeEndpointPreparer } from '../../../src/training/native-deployment.js'
import { parseNativeDeploymentProfile, type NativeDeploymentProfile } from '../../../src/training/native-deployment-profile.js'
import { ProcessResponseError } from '../../../src/training/process.js'
import { TrainingContractError } from '../../../src/training/schema.js'
import { ModelTrainingStore } from '../../../src/training/store.js'
import { ModelNodeTransport, nodeCommand } from '../../../src/training/transport.js'
import type * as T from '../../../src/training/types.js'
import { fixture } from './fixture.js'

function profile(model: T.ModelVersion): NativeDeploymentProfile {
  const runtimeLock = { environmentDigest: digestJson('environment'), pythonVersion: '3.12.11', sglangVersion: '0.5.0', supervisorVersion: '4.3.0',
    timeoutBinary: '/usr/bin/timeout', timeoutDigest: digestJson('timeout') }
  const engineArgs = ['--tool-call-parser', 'qwen25']
  return { schemaVersion: 1, name: 'evaluation', nodeRef: 'gpu', node: { nodeId: 'gpu', generation: 'boot-1' }, backend: 'supervisor',
    resourceGroup: 'evaluation-gpus', gpuUuids: ['GPU-evaluation'], trainingGpuUuids: ['GPU-training'], tensorParallelSize: 1,
    python: '/opt/eval/bin/python', supervisorPython: '/opt/control/bin/python', runtimeLock,
    endpoint: { nodePort: 32000, localPort: 32000, api: 'chat-completions',
      capabilities: { streaming: true, tool_calls: true, parallel_tool_calls: false, input_modalities: ['text'] }, generation: { max_output_tokens: 128 },
      serviceConfig: { engine: 'sglang', engine_version: runtimeLock.sglangVersion,
        engine_digest: digestJson({ environmentDigest: runtimeLock.environmentDigest, engineArgs }), tool_parser: 'qwen25',
        tokenizer_digest: model.tokenizerDigest, chat_template_digest: model.chatTemplateDigest } },
    engineArgs, startupTimeoutSeconds: 30, stopTimeoutSeconds: 2, maxDeploymentAttempts: 2, maxRuntimeSeconds: 300, minFreeDiskBytes: 1024 }
}

/** A protocol double, never a claim that a GPU/model was deployed. */
function nodeDouble(p: NativeDeploymentProfile) {
  const records = new Map<string, any>()
  let control = { sequence: -1, action: 'pause' }
  const call = vi.fn(async (operation: string, payload: any, _id?: string, _remaining?: number): Promise<any> => {
    const action = operation.slice('deployment.'.length)
    if (!['observe', 'releaseConsumer'].includes(action)) {
      if (payload.control.sequence < control.sequence || payload.control.sequence === control.sequence && payload.control.action !== control.action)
        throw new TrainingContractError('deployment-fenced', 'newer intent')
      control = payload.control
    }
    const target = payload.intent?.incarnation ?? payload.incarnation
    let r = records.get(target)
    if (action === 'fence') return { control }
    if (action === 'ensure') {
      if (!r) { r = { ...payload.intent, verified: true, processState: 'RUNNING', status: 'starting', consumers: {} }; records.set(target, r) }
      return structuredClone(r)
    }
    if (action === 'observe') return r ? structuredClone(r) : { status: 'absent', verified: false }
    if (action === 'ready') { r.status = 'ready'; return structuredClone(r) }
    if (action === 'acquireConsumer') {
      if (r.status !== 'ready') throw new TrainingContractError('deployment-draining', 'draining')
      r.consumers[payload.consumer.id] = payload.consumer
      return {}
    }
    if (action === 'releaseConsumer') { if (r) delete r.consumers[payload.consumer.id]; return {} }
    if (action === 'retire') {
      if (!r) return { status: 'released' }
      r.status = 'draining'
      if (Object.keys(r.consumers).length) return { status: 'draining', reason: 'active-consumers' }
      r.status = 'released'; r.verified = false; r.released = true; r.deathProven = true
      return { status: 'released' }
    }
    if (action === 'releaseOwnership') return { released: true }
    throw new Error(operation)
  })
  const transport = { identity: p.node, connection: { transport: { type: 'local' }, gateway: { localPort: 31000, nodePort: 31000 } }, call,
    endpointRoute: vi.fn(async () => 'http://127.0.0.1:32000'), closeEndpointRoute: vi.fn(async () => ({ closed: false, reason: 'local' })) } as unknown as ModelNodeTransport
  return { transport, records, call }
}

describe('managed native preparation protocol', () => {
  let root: string, model: T.ModelVersion, ref: T.ContentRef, p: NativeDeploymentProfile, context: T.EndpointPreparationContext
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-native-'))
    const store = new ModelTrainingStore(join(root, 'cas')), spec = await fixture(store)
    ref = spec.initialModel; model = await store.readJson(ref); p = profile(model)
    context = { experimentId: 'exp-native', controllerDirectory: root, runId: 'run-1', controlSequence: 1, action: 'start', deadlineAt: new Date(Date.now() + 300_000).toISOString() }
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  function setup(ssh = false) {
    const remote = nodeDouble(p), verify = vi.fn(async () => {})
    if (ssh) remote.transport.connection.transport = { type: 'ssh', host: 'reserved-gpu' }
    return { ...remote, verify, preparer: new ManagedNativeEndpointPreparer(p, { transport: remote.transport, verifyEndpoint: verify, trainingGpuUuids: ['GPU-training'] }) }
  }
  function restart(s: ReturnType<typeof setup>) {
    return new ManagedNativeEndpointPreparer(p, { transport: s.transport, verifyEndpoint: s.verify, trainingGpuUuids: ['GPU-training'] })
  }
  function stateFile(preparer: ManagedNativeEndpointPreparer) {
    return join(root, 'native-deployments', preparer.configurationDigest.slice(7), 'state.json')
  }
  async function savedState(preparer: ManagedNativeEndpointPreparer) {
    return JSON.parse(await readFile(stateFile(preparer), 'utf8')) as { intents: Record<string, any>; history?: Record<string, any> }
  }
  function proveDead(s: ReturnType<typeof setup>, incarnation?: string) {
    const record = incarnation ? s.records.get(incarnation) : [...s.records.values()].at(-1)
    record.verified = false; record.deathProven = true; record.processState = 'EXITED'
  }
  it('validates frozen devices, executable overrides and public binding fields', () => {
    expect(parseNativeDeploymentProfile(p)).toEqual(p)
    expect(() => parseNativeDeploymentProfile({ ...p, gpuUuids: ['GPU-training'] })).toThrow(expect.objectContaining({ code: 'native-gpu-overlap' }))
    expect(() => parseNativeDeploymentProfile({ ...p, engineArgs: ['--model-path', '/foreign'] })).toThrow(expect.objectContaining({ code: 'invalid-native-engine-args' }))
    expect(() => parseNativeDeploymentProfile({ ...p, endpoint: { ...p.endpoint, generation: { max_output_tokens: 1, secret: 2 } } })).toThrow()
    const remote = nodeDouble(p)
    expect(() => new ManagedNativeEndpointPreparer(p, { transport: remote.transport, verifyEndpoint: async () => {}, trainingGpuUuids: ['GPU-another'] })).toThrow(expect.objectContaining({ code: 'native-training-placement-drift' }))
  })
  it('persists the original intent before start, recovers an uncertain SSH reply and returns the same binding', async () => {
    const s = setup(), original = s.call.getMockImplementation()!
    let loseReply = true
    s.call.mockImplementation(async (...args) => {
      if (args[0] === 'deployment.ensure') {
        const file = join(root, 'native-deployments', s.preparer.configurationDigest.slice(7), 'state.json')
        expect(Object.keys(JSON.parse(await readFile(file, 'utf8')).intents)).toHaveLength(1)
        const result = await original(...args)
        if (loseReply) { loseReply = false; throw new ProcessResponseError('process-failed', 'SSH reply lost', 255) }
        return result
      }
      return original(...args)
    })
    const binding = await s.preparer.prepare(model, ref, context)
    expect(binding).toBeDefined(); expect(await s.preparer.prepare(model, ref, context)).toEqual(binding)
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.ensure')).toHaveLength(1)
    expect(s.verify).toHaveBeenCalled(); expect(binding!.connection.auth.kind).toBe('env')
    expect(JSON.stringify(binding)).not.toContain([...s.records.values()][0].authKey)
  })
  it('does not infer death from unknown ownership or a failed observation', async () => {
    const s = setup(), binding = (await s.preparer.prepare(model, ref, context))!
    const record = [...s.records.values()][0]
    record.verified = false; record.processState = 'ABSENT'
    await expect(s.preparer.observe(binding, context)).rejects.toMatchObject({ code: 'deployment-incarnation-lost' })
    record.deathProven = true
    expect(await s.preparer.observe(binding, context)).toBeUndefined()
  })
  it('drains two independent consumers and never stops on single-task cancellation', async () => {
    const s = setup(), binding = (await s.preparer.prepare(model, ref, context))!
    for (const id of ['task-a', 'task-b']) await s.preparer.acquireConsumer(binding, { id, experimentId: context.experimentId, runId: 'run-1', evaluationKey: id }, context)
    await s.preparer.releaseConsumer(binding, 'task-a', context)
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.retire')).toHaveLength(0)
    expect(await s.preparer.retire(binding, context)).toEqual({ status: 'draining', reason: 'active-consumers' })
    await expect(s.preparer.acquireConsumer(binding, { id: 'task-c', experimentId: context.experimentId, runId: 'run-1', evaluationKey: 'c' }, context)).rejects.toMatchObject({ code: 'deployment-draining' })
    await s.preparer.releaseConsumer(binding, 'task-b', context)
    expect(await s.preparer.retire(binding, context)).toEqual({ status: 'released' })
  })
  it('creates a new authenticated wire identity after confirmed retirement without refreshing the total deadline', async () => {
    const s = setup(), first = (await s.preparer.prepare(model, ref, context))!
    const firstRecord = [...s.records.values()][0]
    firstRecord.verified = false; firstRecord.deathProven = true; firstRecord.processState = 'EXITED'
    expect(await s.preparer.observe(first, context)).toBeUndefined()
    await s.preparer.retire(first, context)
    const routeCalls = vi.mocked(s.transport.endpointRoute).mock.calls.length
    expect(await s.preparer.observe(first, context)).toBeUndefined()
    expect(s.transport.endpointRoute).toHaveBeenCalledTimes(routeCalls)
    const second = (await s.preparer.prepare(model, ref, context))!
    expect(second.wire_model).not.toBe(first.wire_model); expect(second.connection.auth).not.toEqual(first.connection.auth)
    const records = [...s.records.values()]
    expect(records[1].hardDeadlineAt).toBe(records[0].hardDeadlineAt)
    expect(records[1].attempt).toBe(2)
    expect(await s.preparer.retire(first, context)).toEqual({ status: 'released' })
    await s.preparer.retire(second, context)
    await expect(s.preparer.prepare(model, ref, context)).rejects.toMatchObject({ code: 'deployment-attempts-exhausted' })
  })
  it('recovers a saved ready instance directly through prepare after proven death without an explicit caller retire', async () => {
    const s = setup(), first = (await s.preparer.prepare(model, ref, context))!
    const original = [...s.records.values()][0]
    proveDead(s)
    const second = await restart(s).prepare(model, ref, context)
    expect(second).toBeDefined()
    expect(second!.wire_model).not.toBe(first.wire_model)
    expect(second!.connection.auth).not.toEqual(first.connection.auth)
    const replacement = [...s.records.values()][1]
    expect(replacement.attempt).toBe(2)
    expect(replacement.hardDeadlineAt).toBe(original.hardDeadlineAt)
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.retire')).toHaveLength(1)
    proveDead(s)
    await expect(restart(s).prepare(model, ref, context)).rejects.toMatchObject({ code: 'deployment-attempts-exhausted' })
  })
  it('waits for recorded consumers before automatically rebuilding a dead ready instance', async () => {
    const s = setup(), binding = (await s.preparer.prepare(model, ref, context))!
    await s.preparer.acquireConsumer(binding, { id: 'in-flight', experimentId: context.experimentId, runId: 'run-1', evaluationKey: 'evaluation' }, context)
    proveDead(s)
    expect(await restart(s).prepare(model, ref, context)).toBeUndefined()
    expect(s.records.size).toBe(1)
    await s.preparer.releaseConsumer(binding, 'in-flight', context)
    expect(await restart(s).prepare(model, ref, context)).toBeDefined()
    expect(s.records.size).toBe(2)
  })
  it('continues a persisted draining recovery after the original remote retirement finishes', async () => {
    const s = setup()
    await s.preparer.prepare(model, ref, context)
    proveDead(s)
    const call = s.call.getMockImplementation()!
    let draining = true
    s.call.mockImplementation(async (...args) => {
      if (args[0] === 'deployment.retire' && draining) {
        draining = false
        return { status: 'draining', reason: 'active-consumers' }
      }
      return call(...args)
    })
    expect(await s.preparer.prepare(model, ref, context)).toBeUndefined()
    const state = await savedState(s.preparer)
    expect(Object.values(state.intents)[0].status).toBe('draining')
    expect(await restart(s).observe(Object.values(state.intents)[0].binding, context)).toBeUndefined()
    expect(await restart(s).prepare(model, ref, context)).toBeDefined()
    expect(s.records.size).toBe(2)
  })
  it('does not rebuild a ready instance with unknown death or extend an expired recovery budget', async () => {
    const s = setup()
    await s.preparer.prepare(model, ref, context)
    const original = [...s.records.values()][0]
    original.verified = false; original.processState = 'ABSENT'
    await expect(restart(s).prepare(model, ref, context)).rejects.toMatchObject({ code: 'deployment-incarnation-lost' })
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.retire')).toHaveLength(0)
    proveDead(s)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.hardDeadlineAt) - 500)
    await expect(restart(s).prepare(model, ref, context)).rejects.toMatchObject({ code: 'deployment-deadline-expired' })
    expect(s.records.size).toBe(1)
  })
  it('persists pending route cleanup before opening a managed SSH route', async () => {
    const s = setup(true)
    vi.mocked(s.transport.endpointRoute).mockImplementation(async (_directory, route) => {
      const state = await savedState(s.preparer)
      const record = Object.values(state.intents).find(r => r.intent.incarnation === route.incarnation)
      expect(record.routeCleanup).toEqual({ status: 'pending' })
      return 'http://127.0.0.1:32000'
    })
    expect(await s.preparer.prepare(model, ref, context)).toBeDefined()
  })
  it('keeps confirmed model release separate from failed SSH cleanup and resumes cleanup after restart', async () => {
    const s = setup(true), binding = (await s.preparer.prepare(model, ref, context))!
    vi.mocked(s.transport.closeEndpointRoute).mockRejectedValueOnce(new TrainingContractError('node-route-close-failed', 'reply lost'))
    expect(await s.preparer.retire(binding, context)).toEqual({ status: 'blocked', reason: 'node-route-close-failed' })
    let record = Object.values((await savedState(s.preparer)).intents)[0]
    expect(record.status).toBe('released')
    expect(record.routeCleanup).toEqual({ status: 'pending', failure: 'node-route-close-failed' })
    expect(await restart(s).retireOwned(context)).toEqual({ status: 'released' })
    record = Object.values((await savedState(s.preparer)).intents)[0]
    expect(record.routeCleanup).toEqual({ status: 'completed' })
    expect(s.transport.closeEndpointRoute).toHaveBeenCalledTimes(2)
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.retire')).toHaveLength(1)
  })
  it('idempotently acknowledges a route already closed before its cleanup reply was lost', async () => {
    const s = setup(true), binding = (await s.preparer.prepare(model, ref, context))!
    const incarnation = [...s.records.keys()][0]!, routes = new Set([incarnation])
    vi.mocked(s.transport.closeEndpointRoute).mockImplementation(async (_directory, route) => {
      if (routes.delete(route.incarnation)) throw new TrainingContractError('node-route-close-failed', 'closed before disconnect')
      return { closed: false, reason: 'missing-record' }
    })
    expect(await s.preparer.retire(binding, context)).toEqual({ status: 'blocked', reason: 'node-route-close-failed' })
    expect(routes.size).toBe(0)
    expect(await restart(s).observe(binding, context)).toBeUndefined()
    expect(await restart(s).retire(binding, context)).toEqual({ status: 'released' })
    expect(Object.values((await savedState(s.preparer)).intents)[0].routeCleanup).toEqual({ status: 'completed' })
    expect(s.transport.closeEndpointRoute).toHaveBeenCalledTimes(2)
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.retire')).toHaveLength(1)
  })
  it('serializes a delayed route reopen with retirement so a released binding leaves no connection behind', async () => {
    const s = setup(true), binding = (await s.preparer.prepare(model, ref, context))!
    let opened!: () => void, finish!: () => void, routeActive = true
    const opening = new Promise<void>(resolve => { opened = resolve }), wait = new Promise<void>(resolve => { finish = resolve })
    vi.mocked(s.transport.endpointRoute).mockImplementation(async () => {
      opened(); await wait; routeActive = true
      return 'http://127.0.0.1:32000'
    })
    vi.mocked(s.transport.closeEndpointRoute).mockImplementation(async () => { routeActive = false; return { closed: true } })
    const observing = s.preparer.observe(binding, context)
    void observing.catch(() => {})
    await opening
    const retiring = s.preparer.retire(binding, context)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (Object.values((await savedState(s.preparer)).intents)[0].status === 'released') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(Object.values((await savedState(s.preparer)).intents)[0].status).toBe('released')
    finish()
    await expect(observing).rejects.toMatchObject({ code: 'deployment-draining' })
    expect(await retiring).toEqual({ status: 'released' })
    expect(routeActive).toBe(false)
    expect(Object.values((await savedState(s.preparer)).intents)[0].routeCleanup).toEqual({ status: 'completed' })
  })
  it.each(['current', 'history'] as const)('reconciles legacy released %s records whose route cleanup was never acknowledged', async location => {
    const s = setup(true), binding = (await s.preparer.prepare(model, ref, context))!
    await s.preparer.retire(binding, context)
    const incarnation = [...s.records.keys()][0]!
    if (location === 'history') await s.preparer.prepare(model, ref, context)
    const state = await savedState(s.preparer)
    const record = location === 'history' ? state.history![incarnation] : Object.values(state.intents)[0]
    delete record.routeCleanup // Simulate old schema after release persisted, before SSH close.
    await writeFile(stateFile(s.preparer), JSON.stringify(state))
    vi.mocked(s.transport.closeEndpointRoute).mockClear()
    expect(await restart(s).retireOwned(context)).toEqual({ status: 'released' })
    expect(s.transport.closeEndpointRoute).toHaveBeenCalledWith(context.controllerDirectory,
      expect.objectContaining({ incarnation }))
    const saved = await savedState(s.preparer)
    expect((location === 'history' ? saved.history![incarnation] : Object.values(saved.intents)[0]).routeCleanup).toEqual({ status: 'completed' })
  })
  it.each(['same-model', 'other-model', 'retireOwned', 'releaseOwnership'] as const)('cannot bypass pending historical route cleanup through %s', async action => {
    const s = setup(true), first = (await s.preparer.prepare(model, ref, context))!
    await s.preparer.retire(first, context)
    const incarnation = [...s.records.keys()][0]!
    await s.preparer.prepare(model, ref, context)
    const state = await savedState(s.preparer)
    state.history![incarnation].routeCleanup = { status: 'pending' }
    await writeFile(stateFile(s.preparer), JSON.stringify(state))
    vi.mocked(s.transport.closeEndpointRoute).mockClear().mockRejectedValue(new TrainingContractError('node-route-close-failed', 'retain old route'))
    const resumed = restart(s), ensureCount = s.call.mock.calls.filter(c => c[0] === 'deployment.ensure').length
    if (action === 'same-model') expect(await resumed.prepare(model, ref, context)).toBeUndefined()
    else if (action === 'other-model') {
      const nextRef = { ...ref, digest: digestJson('other-model') }; nextRef.uri = `cas:${nextRef.digest}`
      const nextModel = { ...model, id: digestJson('another-model-version'), hfSnapshotRef: nextRef }
      expect(await resumed.prepare(nextModel, nextRef, context)).toBeUndefined()
    } else if (action === 'retireOwned') expect(await resumed.retireOwned(context)).toEqual({ status: 'blocked', reason: 'node-route-close-failed' })
    else expect(await resumed.releaseOwnership(context)).toEqual({ released: false, reason: 'node-route-close-failed' })
    expect(s.transport.closeEndpointRoute).toHaveBeenCalledWith(context.controllerDirectory, expect.objectContaining({ incarnation }))
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.ensure')).toHaveLength(ensureCount)
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.releaseOwnership')).toHaveLength(0)
  })
  it('fences a delayed readiness result after pause without publishing or starting another instance', async () => {
    const s = setup()
    let finish!: () => void, entered!: () => void
    const waiting = new Promise<void>(r => { entered = r }), probe = new Promise<void>(r => { finish = r })
    s.verify.mockImplementation(async () => { entered(); await probe })
    const preparing = s.preparer.prepare(model, ref, context)
    await waiting
    await s.preparer.fence({ ...context, controlSequence: 2, action: 'pause' })
    finish()
    await expect(preparing).rejects.toMatchObject({ code: 'deployment-fenced' })
    expect(s.call.mock.calls.filter(c => c[0] === 'deployment.ready')).toHaveLength(0)
    expect(await s.preparer.retireOwned({ ...context, controlSequence: 2, action: 'pause' })).toEqual({ status: 'released' })
  })
  it('uses normal observation budgets after startup and permits bounded cleanup after the experiment deadline', async () => {
    const s = setup(), binding = (await s.preparer.prepare(model, ref, context))!
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 45_000)
    await s.preparer.observe(binding, context)
    const observation = s.call.mock.calls.filter(c => c[0] === 'deployment.observe').at(-1)!
    expect(observation[3]).toBeGreaterThan(1000)
    const expired = { ...context, deadlineAt: new Date(Date.now() - 1000).toISOString(), controlSequence: 2, action: 'pause' as const }
    await s.preparer.fence(expired)
    expect(await s.preparer.retire(binding, expired)).toEqual({ status: 'released' })
    const stop = s.call.mock.calls.find(c => c[0] === 'deployment.retire')!
    expect(stop[3]).toBeGreaterThan(1000)
    expect(await s.preparer.releaseOwnership(expired)).toEqual({ released: true })
    await s.preparer.retireOwned(expired)
    await expect(s.preparer.prepare(model, ref, { ...context, controlSequence: 3 })).rejects.toMatchObject({ code: 'deployment-fenced' })
  })
  it('quotes the identical node helper for local and SSH transports', () => {
    const connection: T.ModelNodeConnection = { transport: { type: 'local' }, workspace: '/node', python: ['/safe path/python'], configPath: "/safe path/node's.json", gateway: { localPort: 31000, nodePort: 31000 } }
    expect(nodeCommand(connection, 'rpc')).toEqual(['/safe path/python', '-m', 'gear.training.cli.node', 'rpc', '--config', "/safe path/node's.json"])
    const remote = nodeCommand({ ...connection, transport: { type: 'ssh', host: 'reserved-gpu' } }, 'rpc')
    expect(remote.at(-1)).toContain("'/safe path/python' '-m' 'gear.training.cli.node'")
    expect(remote.at(-1)).toContain("node'\\''s.json")
  })
  it('uses the existing binary CAS transfer for another evaluation node and keeps model JSON files opaque', async () => {
    const controller = new ModelTrainingStore(join(root, 'transfer-controller')), source = new ModelTrainingStore(join(root, 'transfer-source')),
      destination = new ModelTrainingStore(join(root, 'transfer-destination'))
    const configFile = await source.putJson({ literal: { uri: `cas:sha256:${'a'.repeat(64)}`, digest: `sha256:${'a'.repeat(64)}`, mediaType: 'application/json' } })
    const weights = await source.putBytes(Buffer.from('controlled opaque weight bytes'), 'application/octet-stream')
    const manifest = { schemaVersion: 1, format: 'hf-safetensors', files: [
      { path: 'config.json', contentRef: configFile, sha256: configFile.digest, size: (await source.readBytes(configFile)).length },
      { path: 'model.safetensors', contentRef: weights, sha256: weights.digest, size: (await source.readBytes(weights)).length },
    ] }
    const snapshot = await source.putJson(manifest); await controller.putJson(manifest)
    const create = async (label: string, store: ModelTrainingStore): Promise<ModelNodeTransport> => {
      const configPath = join(root, label + '.node.json')
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, nodeId: label, nodeRoot: join(root, label + '-state'), storeRoot: store.root }))
      const connection: T.ModelNodeConnection = { transport: { type: 'local' }, workspace: root,
        python: ['env', `PYTHONPATH=${resolve('python')}`, process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3'], configPath,
        gateway: { nodePort: 31000, localPort: 31000 } }
      const node = await new ModelNodeTransport(connection, null).call('probe', {}) as T.NodeIdentity
      return new ModelNodeTransport(connection, { nodeId: node.nodeId, generation: node.generation })
    }
    const sourceTransport = await create('source-native', source), transport = await create('evaluation-native', destination)
    const actualCall = transport.call.bind(transport), remote = nodeDouble(p)
    vi.spyOn(transport, 'call').mockImplementation((operation, payload, requestId, remaining) => operation.startsWith('deployment.')
      ? remote.call(operation, payload, requestId, remaining) : actualCall(operation, payload, requestId, remaining))
    const moved = { ...model, hfSnapshotRef: snapshot }, movedProfile = { ...p, node: transport.identity!, trainingGpuUuids: [] }
    const preparer = new ManagedNativeEndpointPreparer(movedProfile, { transport, sourceTransport, store: controller,
      trainingGpuUuids: [], verifyEndpoint: async () => {} })
    const binding = await preparer.prepare(moved, ref, context)
    expect(binding!.deployment_receipt.model_digest).toBe(snapshot.digest)
    expect(await destination.readBytes(weights)).toEqual(await source.readBytes(weights))
    expect(await destination.readJson(configFile)).toEqual(await source.readJson(configFile))
    await expect(destination.readBytes({ uri: `cas:sha256:${'a'.repeat(64)}`, digest: `sha256:${'a'.repeat(64)}`, mediaType: 'application/json' })).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
})

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trainingCommand } from '../../../src/training/cli.js'
import { preflightDeployment } from '../../../src/training/preflight-deployment.js'
import { parseModelNodePreflight } from '../../../src/training/node-preflight.js'
import { ModelNodeTransport } from '../../../src/training/transport.js'
import * as processes from '../../../src/training/process.js'
import { preflightFixture } from './preflight-fixture.js'

describe('deployment checks before experiment freeze', () => {
  let root: string, fixture: ReturnType<typeof preflightFixture>
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gear-preflight-')); fixture = preflightFixture(root)
    vi.spyOn(ModelNodeTransport.prototype, 'call').mockImplementation(async function (this: ModelNodeTransport, operation, payload) {
      expect(payload).toEqual({})
      if (operation === 'probe') { expect(this.identity).toBeNull(); return fixture.probe }
      if (operation === 'preflight') {
        expect(this.identity).toEqual({ nodeId: fixture.probe.nodeId, generation: fixture.probe.generation })
        return fixture.report
      }
      throw new Error('diagnostics must not submit jobs or model services')
    })
  })
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
  const check = (report: Awaited<ReturnType<typeof preflightDeployment>>, code: string) => report.checks.find(item => item.code === code)

  it('accepts a single idle GPU with colocated scheduling but does not certify training or sandbox execution', async () => {
    const report = await preflightDeployment(fixture.config, fixture.invoke)
    expect(report.readyForRuntimeProbes).toBe(true)
    expect(report.runtimeValidation).toBe('not-certified')
    expect(check(report, 'sandbox-to-model-route')).toMatchObject({ scope: 'network', status: 'unverified' })
    expect(report.remainingValidation).toContain('colocated-memory-and-weight-cycle')
    expect(report.modelNode?.hostMemory?.availableBytes).toBe(128_000_000_000)
    expect(report.harbor?.environment).toEqual(fixture.environment)
    expect(await readdir(root)).toEqual([])
  })
  it('public CLI checks a deployment without creating an experiment or admitting work', async () => {
    vi.spyOn(processes, 'jsonProcess').mockImplementation(fixture.invoke)
    const file = join(root, 'controller.json'); await writeFile(file, JSON.stringify(fixture.config))
    const report = await trainingCommand(['preflight-deployment', '--config', file])
    expect(report).toMatchObject({ kind: 'training-deployment-preflight', readyForRuntimeProbes: true, runtimeValidation: 'not-certified' })
    expect(await readdir(root)).toEqual(['controller.json'])
    await expect(trainingCommand(['preflight-deployment', 'extra', '--config', file])).rejects.toMatchObject({ code: 'usage' })
  })
  it('reports controller/Harbor readiness even when the model node is unreachable and redacts transport diagnostics', async () => {
    vi.mocked(ModelNodeTransport.prototype.call).mockRejectedValue(new Error('private-host-credential'))
    const report = await preflightDeployment(fixture.config, fixture.invoke)
    expect(report.readyForRuntimeProbes).toBe(false)
    expect(check(report, 'model-node-unavailable')).toMatchObject({ scope: 'model-node', status: 'blocked' })
    expect(check(report, 'harbor-environment-observation')?.status).toBe('passed')
    expect(JSON.stringify(report)).not.toContain('private-host-credential')
  })
  it('continues model diagnostics when controller or Harbor dependencies fail', async () => {
    const report = await preflightDeployment(fixture.config, async (command, args) => {
      if (args.includes('runtime')) throw new Error('private-controller-path')
      return fixture.invoke(command, args)
    })
    expect(check(report, 'controller-unavailable')).toMatchObject({ scope: 'controller', status: 'blocked' })
    expect(check(report, 'controller-observation-required')?.status).toBe('unverified')
    expect(check(report, 'cuda-runtime')?.status).toBe('passed')
    fixture.environment.docker.status = 'unavailable'
    const noDocker = await preflightDeployment(fixture.config, fixture.invoke)
    expect(check(noDocker, 'provider-environment-unavailable')).toMatchObject({ scope: 'harbor-worker', status: 'blocked' })
    expect(check(noDocker, 'package-sglang')?.status).toBe('passed')
  })
  it('places missing packages, occupied GPUs and gateway mismatches on the model node', async () => {
    fixture.report.checks.find(item => item.code === 'package-ray')!.status = 'blocked'
    fixture.report.gpus[0]!.activeProcesses = 1
    fixture.report.ports.inference = 32101
    const report = await preflightDeployment(fixture.config, fixture.invoke)
    for (const code of ['package-ray', 'idle-gpu-pool', 'evaluation-gateway-port']) expect(check(report, code)).toMatchObject({ scope: 'model-node', status: 'blocked' })
    expect(check(report, 'minimum-gpu-pool')?.status).toBe('passed')
  })
  it('requires additional GPUs for disaggregated rollout and isolated evaluation', async () => {
    fixture.config.deployment.gpuScheduling.actorRollout = 'disaggregated'
    expect(check(await preflightDeployment(fixture.config, fixture.invoke), 'minimum-gpu-pool')?.status).toBe('blocked')
    fixture.report.gpus.push({ ...fixture.report.gpus[0]!, uuid: 'GPU-456' })
    expect((await preflightDeployment(fixture.config, fixture.invoke)).readyForRuntimeProbes).toBe(true)
    fixture.config.deployment.gpuScheduling.trainEvaluation = 'isolated'
    expect(check(await preflightDeployment(fixture.config, fixture.invoke), 'minimum-gpu-pool')?.status).toBe('blocked')
  })
  it('does not reuse diagnostics from another node generation or ignore unknown GPU occupancy', async () => {
    fixture.report.node = { ...fixture.report.node, generation: 'boot-2' }
    expect(check(await preflightDeployment(fixture.config, fixture.invoke), 'model-node-runtime-drift')?.status).toBe('blocked')
    fixture.report.node.generation = fixture.probe.generation
    fixture.report.checks.find(item => item.code === 'gpu-process-observation')!.status = 'blocked'
    fixture.report.gpus[0]!.activeProcesses = null
    const report = await preflightDeployment(fixture.config, fixture.invoke)
    expect(check(report, 'gpu-process-observation')?.status).toBe('blocked')
    expect(check(report, 'idle-gpu-pool')?.status).toBe('blocked')
  })
  it('rejects contradictory or arbitrary model diagnostics and filters extra provider fields', async () => {
    const identity = { nodeId: fixture.probe.nodeId, generation: fixture.probe.generation }
    const valid = structuredClone(fixture.report)
    for (const mutate of [
      () => { fixture.report.gpus[0]!.activeProcesses = null },
      () => { fixture.report.checks.find(item => item.code === 'cuda-runtime')!.status = 'blocked' },
      () => { fixture.report.checks = fixture.report.checks.filter(item => item.code !== 'slime-tracked-runtime') },
      () => { Object.assign(fixture.report, { privateField: 'private-model-path' }) },
    ]) {
      fixture.report = structuredClone(valid); mutate()
      expect(() => parseModelNodePreflight(fixture.report, identity, fixture.probe.runtimeDigest)).toThrow()
    }
    const rejected = await preflightDeployment(fixture.config, fixture.invoke)
    expect(JSON.stringify(rejected)).not.toContain('private-model-path')
    fixture.report = valid
    Object.assign(fixture.environment.harbor, { credentials: 'private-provider-credential' })
    const report = await preflightDeployment(fixture.config, fixture.invoke)
    expect(report.readyForRuntimeProbes).toBe(true)
    expect(JSON.stringify(report)).not.toContain('private-provider-credential')
  })
  it('attributes a changing controller runtime to the controller instead of the Harbor host', async () => {
    let calls = 0
    const report = await preflightDeployment(fixture.config, async (command, args) => {
      if (args.includes('runtime') && ++calls === 2) return { ...fixture.controller, source: { kind: 'unavailable' } }
      return fixture.invoke(command, args)
    })
    expect(check(report, 'controller-source-unavailable')).toMatchObject({ scope: 'controller', target: 'hitch', status: 'blocked' })
  })
  it('public CLI reads a real Python node without requiring Hitch, Docker or Slime on that node', async () => {
    vi.restoreAllMocks()
    const original = processes.jsonProcess
    vi.spyOn(processes, 'jsonProcess').mockImplementation((command, args, payload, timeout) => command[0] === 'env'
      ? original(command, args, payload, timeout) : fixture.invoke(command, args))
    const node = fixture.config.deployment.nodes.gpu!
    node.transport = { type: 'local' }; node.workspace = root; node.configPath = join(root, 'node.json')
    node.python = ['env', `PYTHONPATH=${resolve('python')}`, process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3']
    node.gateway.localPort = node.gateway.nodePort
    fixture.config.evaluationGateway.localPort = fixture.config.evaluationGateway.nodePort
    const jobConfigPath = join(root, 'job.json'), jobsRoot = join(root, 'jobs')
    await writeFile(jobConfigPath, JSON.stringify({ schemaVersion: 2, storeRoot: fixture.config.storeRoot, jobsRoot,
      slimePath: join(root, 'missing-slime'), megatronPath: join(root, 'missing-megatron'), gatewayBindHost: '127.0.0.1',
      gatewayPort: node.gateway.nodePort, controllerTimeoutSeconds: 30, episodeTimeoutSeconds: 30 }))
    await writeFile(node.configPath, JSON.stringify({ schemaVersion: 2, nodeId: 'cpu-preflight', nodeRoot: join(root, 'node'),
      storeRoot: fixture.config.storeRoot, jobConfigPath, inferencePort: fixture.config.evaluationGateway.nodePort }))
    const file = join(root, 'controller.json'); await writeFile(file, JSON.stringify(fixture.config))
    const report = await trainingCommand(['preflight-deployment', '--config', file]) as Awaited<ReturnType<typeof preflightDeployment>>
    expect(report.modelNode?.node.nodeId).toBe('cpu-preflight')
    expect(check(report, 'training-node-configuration')?.status).toBe('passed')
    expect(check(report, 'slime-checkout')).toMatchObject({ scope: 'model-node', status: 'blocked' })
    expect(check(report, 'megatron-checkout')?.status).toBe('blocked')
    expect(report.readyForRuntimeProbes).toBe(false)
    expect(report.runtimeValidation).toBe('not-certified')
    expect(await readdir(root)).not.toContain('jobs')
    expect(await readdir(join(root, 'node'))).not.toContain('rpc')
  }, 30_000)
})

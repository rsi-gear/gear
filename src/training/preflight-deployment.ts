import { digestJson } from './digest.js'
import { parseTrainingDeployment } from './deployment.js'
import { parseModelNodePreflight, type ModelNodePreflight } from './node-preflight.js'
import { observeExecutionProvider, observeHitchController, type HitchControllerObservation } from './placement-observation.js'
import { jsonProcess } from './process.js'
import { requireContract } from './schema.js'
import { ModelNodeTransport } from './transport.js'
import type { TrainingControllerConfigV2 } from './cli.js'
import type { NodeIdentity } from './types.js'

type Check = { scope: 'controller' | 'harbor-worker' | 'model-node' | 'network'; target: string; code: string; status: 'passed' | 'blocked' | 'unverified' }
type Json = Record<string, unknown>
const object = (value: unknown): Json => {
  requireContract(!!value && typeof value === 'object' && !Array.isArray(value), 'invalid-preflight-observation', 'preflight observation must be structured')
  return value as Json
}
const knownErrors = new Set(['controller-runtime-capability-missing', 'controller-runtime-unavailable', 'controller-source-unavailable',
  'missing-provider-observation', 'ambiguous-execution-provider', 'execution-provider-unavailable', 'missing-worker-generation',
  'missing-provider-identity', 'missing-harbor-provider', 'provider-observation-capability-missing', 'model-node-runtime-drift',
  'invalid-provider-environment', 'provider-observation-mismatch', 'provider-environment-drift', 'provider-environment-unavailable',
  'daemon-runtime-drift', 'worker-runtime-drift', 'node-response-drift', 'node-generation-drift', 'invalid-node-preflight', 'process-timeout'])

function publicEnvironment(environment: Json): Json {
  const pick = (raw: unknown, keys: string[]) => Object.fromEntries(keys.map(key => [key, object(raw)[key]]))
  return { schema_version: environment.schema_version, host_platform: environment.host_platform,
    harbor: pick(environment.harbor, ['status', 'version', 'executable_digest']),
    docker: pick(environment.docker, ['status', 'version', 'executable_digest', 'engine_id', 'os', 'architecture']),
    buildx: pick(environment.buildx, ['status', 'version']), sandbox: pick(environment.sandbox, ['status']) }
}

/** Configuration readiness, kept separate from numerical/sandbox probe certification. */
export async function preflightDeployment(input: TrainingControllerConfigV2, invoke = jsonProcess) {
  const config = parseTrainingDeployment(input.deployment), nodeRef = config.modelRuntime.nodeRef
  const checks: Check[] = []
  const record = (scope: Check['scope'], target: string, code: string, passed: boolean) => { checks.push({ scope, target, code, status: passed ? 'passed' : 'blocked' }) }
  const failed = (scope: Check['scope'], target: string, fallback: string, error: unknown) => {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    record(scope, target, typeof code === 'string' && knownErrors.has(code) ? code : fallback, false)
  }
  const observations: {
    controller: HitchControllerObservation | null
    python: { pythonVersion: string; bridgeDigest: string } | null
    modelNode: ModelNodePreflight | null
    harbor: Awaited<ReturnType<typeof observeExecutionProvider>> | null
  } = { controller: null, python: null, modelNode: null, harbor: null }
  const controllerWork = async () => {
    const results = await Promise.allSettled([
      observeHitchController(input.hitch, invoke),
      invoke(input.hitch.command, ['--root', input.hitch.root, 'capabilities', '--json']),
      invoke(input.hitch.python, ['-c', 'import json,platform\nfrom gear_training.preflight import bridge_digest\nprint(json.dumps({"pythonVersion":platform.python_version(),"bridgeDigest":bridge_digest()}))']),
    ])
    const [observed, capabilities, bridge] = results
    if (observed.status === 'fulfilled') { observations.controller = observed.value; record('controller', 'hitch', 'controller-runtime', true) }
    else failed('controller', 'hitch', 'controller-unavailable', observed.reason)
    if (capabilities.status === 'fulfilled') {
      try {
        const caps = object(capabilities.value)
        record('controller', 'hitch', 'training-binding', ['training_external_binding', 'exact_policy_tokens', 'training_policy_fencing'].every(key => caps[key] === '1'))
        record('controller', 'hitch', 'managed-model-node', caps.managed_model_node === '2')
        record('controller', 'hitch', 'training-harness', Array.isArray(caps.training_harnesses) && caps.training_harnesses.includes('training-tool'))
      } catch (error) { failed('controller', 'hitch', 'controller-capabilities-unavailable', error) }
    } else failed('controller', 'hitch', 'controller-capabilities-unavailable', capabilities.reason)
    if (bridge.status === 'fulfilled') {
      try {
        const value = object(bridge.value)
        requireContract(typeof value.pythonVersion === 'string' && /^3\.(\d+)\.\d+$/.test(value.pythonVersion) && Number(value.pythonVersion.split('.')[1]) >= 10
          && typeof value.bridgeDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.bridgeDigest), 'controller-python-unavailable', 'controller Python bridge is unavailable')
        observations.python = { pythonVersion: value.pythonVersion, bridgeDigest: value.bridgeDigest }; record('controller', 'python', 'controller-python-bridge', true)
      } catch (error) { failed('controller', 'python', 'controller-python-unavailable', error) }
    } else failed('controller', 'python', 'controller-python-unavailable', bridge.reason)
    if (!observations.controller) {
      checks.push({ scope: 'harbor-worker', target: config.taskExecution.provider, code: 'controller-observation-required', status: 'unverified' })
      return
    }
    try {
      const harbor = await observeExecutionProvider(config, input.hitch, invoke)
      requireContract(digestJson(harbor.controller) === digestJson(observations.controller), 'controller-runtime-unavailable', 'controller changed during preflight')
      observations.harbor = harbor
      for (const [code, passed] of Object.entries(harbor.provider.capabilities)) record('harbor-worker', config.taskExecution.provider, code, passed)
      record('harbor-worker', config.taskExecution.provider, 'harbor-environment-observation', true)
    } catch (error) {
      observations.harbor = null
      const controllerFailure = error && typeof error === 'object' && String((error as { code?: unknown }).code).startsWith('controller-')
      failed(controllerFailure ? 'controller' : 'harbor-worker', controllerFailure ? 'hitch' : config.taskExecution.provider, 'harbor-observation-unavailable', error)
    }
  }
  const modelWork = async () => {
    const connection = config.nodes[nodeRef]!
    try {
      const probe = object(await new ModelNodeTransport(connection, null).call('probe', {}))
      requireContract(typeof probe.nodeId === 'string' && probe.nodeId.length > 0 && typeof probe.generation === 'string' && probe.generation.length > 0
        && probe.runtimeDigest === digestJson(probe.runtime), 'model-node-runtime-drift', 'model node probe is incomplete')
      const node: NodeIdentity = { nodeId: probe.nodeId, generation: probe.generation }
      const report = await new ModelNodeTransport(connection, node).call('preflight', {})
      const modelNode = parseModelNodePreflight(report, node, String(probe.runtimeDigest))
      observations.modelNode = modelNode
      record('network', nodeRef, 'authenticated-model-node-rpc', true)
      for (const check of modelNode.checks) checks.push({ scope: 'model-node', target: nodeRef, ...check })
      record('model-node', nodeRef, 'process-launcher', config.modelRuntime.launcher === 'process' && Array.isArray(probe.launchers) && probe.launchers.includes('process'))
      record('model-node', nodeRef, 'rollout-gateway-port', modelNode.ports.rollout === connection.gateway.nodePort)
      record('model-node', nodeRef, 'evaluation-gateway-port', modelNode.ports.inference === input.evaluationGateway.nodePort)
      const minimum = (config.gpuScheduling.actorRollout === 'colocated' ? 1 : 2) + (config.gpuScheduling.trainEvaluation === 'isolated' ? 1 : 0)
      record('model-node', nodeRef, 'minimum-gpu-pool', modelNode.gpus.length >= minimum)
      record('model-node', nodeRef, 'idle-gpu-pool', modelNode.gpus.filter(gpu => gpu.activeProcesses === 0).length >= minimum)
    } catch (error) { failed('model-node', nodeRef, 'model-node-unavailable', error) }
  }
  await Promise.all([controllerWork(), modelWork()])
  checks.push({ scope: 'network', target: config.taskExecution.provider, code: 'sandbox-to-model-route', status: 'unverified' })
  checks.sort((a, b) => `${a.scope}:${a.target}:${a.code}`.localeCompare(`${b.scope}:${b.target}:${b.code}`))
  const { controller, python, harbor, modelNode } = observations
  return { schemaVersion: 2 as const, kind: 'training-deployment-preflight' as const, observedAt: new Date().toISOString(),
    readyForRuntimeProbes: !checks.some(check => check.status === 'blocked'), runtimeValidation: 'not-certified' as const,
    controller: { hitch: controller, python }, harbor: harbor ? { ...harbor, environment: publicEnvironment(harbor.environment) } : null, modelNode, checks,
    remainingValidation: ['selected-device-allocation', 'sandbox-to-model-route', 'native-tokens-and-logprobs', 'backward-checkpoint-export-reload',
      ...(config.gpuScheduling.actorRollout === 'colocated' ? ['colocated-memory-and-weight-cycle'] : []), 'training-evaluation-device-handoff'] }
}

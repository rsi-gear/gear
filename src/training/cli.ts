import { readFile } from 'node:fs/promises'
import { ModelTrainingCoordinator } from './coordinator.js'
import { HitchModelEvaluator, type HitchModelEvaluatorOptions } from './hitch.js'
import { HitchModelPublisher } from './publication.js'
import { jsonProcess } from './process.js'
import { parseModelTrainingSpec, requireContract } from './schema.js'
import { SlimeModelTrainer, NodeSlimeModelTrainer, type SlimeTrainerOptions } from './slime.js'
import { ModelTrainingStore } from './store.js'
import { parseTrainingDeployment, freezeExecutionPlacement } from './deployment.js'
import { ModelNodeTransport } from './transport.js'
import { TrainingEpisodeCoordinator } from './episodes.js'
import { observeExecutionPlacement } from './placement-observation.js'
import { preflightDeployment } from './preflight-deployment.js'
import { digestJson } from './digest.js'
import { retainContentGraph } from './retention.js'
import type { ModelTrainingSpec, TrainingDeploymentConfig, NodeIdentity, ContentRef } from './types.js'

export interface TrainingControllerConfigV1 {
  schemaVersion: 1
  storeRoot: string
  slime: SlimeTrainerOptions
  hitch: HitchModelEvaluatorOptions
  activationPath: string
}
export interface TrainingControllerConfigV2 {
  schemaVersion: 2
  storeRoot: string
  artifactStorage?: 'controller' | 'model-node'
  deployment: TrainingDeploymentConfig
  evaluationGateway: { localPort: number; nodePort: number }
  episodeTimeoutSeconds: number
  hitch: Omit<HitchModelEvaluatorOptions, 'modelNode' | 'deployment'>
  activationPath: string
}
export type TrainingControllerConfig = TrainingControllerConfigV1 | TrainingControllerConfigV2

export function parseTrainingControllerConfig(value: unknown): TrainingControllerConfig {
  const config = value as TrainingControllerConfig | null
  requireContract(!!config && [1, 2].includes(config.schemaVersion) && typeof config.storeRoot === 'string' && config.storeRoot.startsWith('/')
    && !!config.hitch && Array.isArray(config.hitch.python) && config.hitch.python.length > 0,
    'invalid-controller-config', 'controller requires an absolute storeRoot, versioned configuration and controller-side Hitch/Python commands')
  if (config.schemaVersion === 1) requireContract(!!config.slime && Array.isArray(config.slime.python), 'invalid-controller-config', 'v1 controller requires local Slime configuration')
  else {
    config.deployment = parseTrainingDeployment(config.deployment)
    const connection = config.deployment.nodes[config.deployment.modelRuntime.nodeRef]!, gateway = config.evaluationGateway
    requireContract(config.artifactStorage === undefined || ['controller', 'model-node'].includes(config.artifactStorage),
      'invalid-controller-config', 'artifactStorage must select controller or model-node')
    requireContract(config.deployment.modelRuntime.launcher === 'process' && !!gateway
      && [gateway.localPort, gateway.nodePort].every(port => Number.isSafeInteger(port) && port > 0 && port < 65536)
      && gateway.localPort !== connection.gateway.localPort && gateway.nodePort !== connection.gateway.nodePort
      && (connection.transport.type !== 'local' || gateway.localPort === gateway.nodePort)
      && Number.isSafeInteger(config.episodeTimeoutSeconds) && config.episodeTimeoutSeconds > 0,
      'invalid-controller-config', 'v2 requires a process model node, distinct stable evaluation/rollout routes and a positive episode timeout')
    requireContract(!('modelNode' in config.hitch) && !('deployment' in config.hitch) && !('slime' in config),
      'invalid-controller-config', 'v2 model connection comes from deployment; do not supply legacy Slime or a separate Hitch node override')
  }
  return config
}

export function trainingController(config: TrainingControllerConfig, spec: ModelTrainingSpec, store = new ModelTrainingStore(config.storeRoot)) {
  requireContract(config.schemaVersion === spec.schemaVersion, 'controller-spec-version-mismatch', 'select a matching controller version; existing experiments are not migrated implicitly')
  if (config.schemaVersion === 1) {
    const trainer = new SlimeModelTrainer(config.slime)
    const publisher = new HitchModelPublisher(store, { ...config.hitch, activationPath: config.activationPath })
    return { trainer, publisher, coordinator: new ModelTrainingCoordinator(store, trainer, new HitchModelEvaluator(store, config.hitch)) }
  }
  requireContract(spec.schemaVersion === 2, 'controller-spec-version-mismatch', 'v2 controller needs a v2 experiment')
  const placement = spec.deployment, node = placement.modelRuntime
  requireContract(digestJson(config.deployment.taskExecution) === digestJson({ placement: placement.taskExecution.placement, provider: placement.taskExecution.provider })
    && digestJson(config.deployment.modelRuntime) === digestJson({ nodeRef: node.nodeRef, launcher: node.launcher })
    && digestJson(config.deployment.gpuScheduling) === digestJson(placement.gpuScheduling),
    'deployment-drift', 'controller deployment differs from the frozen experiment; create a new experiment for placement changes')
  const connection = config.deployment.nodes[node.nodeRef]!
  const transport = new ModelNodeTransport(connection, { nodeId: node.nodeId, generation: node.generation })
  const episodes = new TrainingEpisodeCoordinator(store, transport, { ...config.hitch, deployment: config.deployment, episodeTimeoutSeconds: config.episodeTimeoutSeconds })
  const artifactStorage = config.artifactStorage ?? (connection.transport.type === 'ssh' ? 'model-node' : 'controller')
  const trainer = new NodeSlimeModelTrainer(transport, store, episodes, artifactStorage)
  const { workspace: _workspace, ...inferenceConnection } = connection
  const evaluator = new HitchModelEvaluator(store, { ...config.hitch, artifactStorage, deployment: config.deployment, modelNode: { ...inferenceConnection, gateway: config.evaluationGateway } })
  const publisher = new HitchModelPublisher(store, { ...config.hitch, activationPath: config.activationPath, artifactStorage,
    frozenNode: node, modelNode: { ...inferenceConnection, gateway: config.evaluationGateway } })
  return { trainer, publisher, coordinator: new ModelTrainingCoordinator(store, trainer, evaluator) }
}
export async function trainingCommand(argv: string[]): Promise<unknown> {
  const args = [...argv]; const action = args.shift()
  if (action === '--help' || action === 'help') return {
    usage: 'gear-refine training ACTION --config CONTROLLER.json [arguments]',
    actions: ['node-probe DEPLOYMENT.json NODE_REF', 'preflight-deployment', 'freeze-deployment', 'put-json FILE', 'seal-hf DIRECTORY', 'seal-hf-node NODE_DIRECTORY', 'seal-dataset DIRECTORY', 'validate SPEC', 'init SPEC', 'admit EXP', 'preflight EXP RUN',
      'advance EXP RUN', 'status EXP [RUN]', 'pause EXP RUN', 'resume EXP RUN', 'close EXP RUN', 'publish EXP', 'rollback EXP RELEASE'],
  }
  if (action === 'node-probe') {
    requireContract(args.length === 2, 'usage', 'training node-probe DEPLOYMENT.json NODE_REF')
    const deployment = parseTrainingDeployment(JSON.parse(await readFile(args[0]!, 'utf8')))
    const node = deployment.nodes[args[1]!]
    requireContract(node, 'unknown-model-node', 'requested model node is not configured')
    return new ModelNodeTransport(node, null).call('probe', {})
  }
  const index = args.indexOf('--config')
  requireContract(index >= 0 && !!args[index + 1], 'usage', 'gear-refine training ACTION --config CONTROLLER.json [arguments]')
  const file = args.splice(index, 2)[1]!
  const config = parseTrainingControllerConfig(JSON.parse(await readFile(file, 'utf8')))
  const store = new ModelTrainingStore(config.storeRoot)
  if (action === 'preflight-deployment') {
    requireContract(config.schemaVersion === 2 && args.length === 0, 'usage', 'preflight-deployment requires a v2 controller config and no positional arguments')
    return preflightDeployment(config)
  }
  if (action === 'freeze-deployment') {
    requireContract(config.schemaVersion === 2 && args.length === 0, 'usage', 'freeze-deployment requires a v2 controller config and no positional arguments')
    const observation = await observeExecutionPlacement(config.deployment, config.hitch)
    return { deployment: freezeExecutionPlacement(config.deployment, observation), observation }
  }
  if (action === 'put-json') {
    requireContract(args.length === 1, 'usage', 'training put-json FILE --config CONTROLLER.json')
    return store.putJson(JSON.parse(await readFile(args[0]!, 'utf8')))
  }
  if (action === 'seal-hf-node') {
    requireContract(config.schemaVersion === 2 && args.length === 1, 'usage', 'seal-hf-node requires a v2 controller and one absolute node directory')
    const connection = config.deployment.nodes[config.deployment.modelRuntime.nodeRef]!
    const observed = await new ModelNodeTransport(connection, null).call('probe', {}) as NodeIdentity
    const transport = new ModelNodeTransport(connection, { nodeId: observed.nodeId, generation: observed.generation }, 3_600_000)
    const result = await transport.call('cas.sealHf', { directory: args[0] }) as { modelRef: ContentRef }
    await retainContentGraph(transport, store, [result.modelRef])
    return { ...result, node: transport.identity, artifactStorage: 'model-node' }
  }
  if (action === 'seal-hf' || action === 'seal-dataset') {
    requireContract(args.length === 1, 'usage', `training ${action} DIRECTORY --config CONTROLLER.json`)
    return jsonProcess(config.schemaVersion === 1 ? config.slime.python : config.hitch.python, ['-m', 'gear_training.artifacts', action, '--store-root', store.root], { directory: args[0] }, 3_600_000)
  }
  if (action === 'validate' || action === 'init') {
    requireContract(args.length === 1, 'usage', `training ${action} SPEC.json --config CONTROLLER.json`)
    const spec = parseModelTrainingSpec(JSON.parse(await readFile(args[0]!, 'utf8')))
    const { coordinator } = trainingController(config, spec, store)
    return action === 'init' ? coordinator.createExperiment(spec) : { valid: true, runtimeValidation: spec.trainer.runtimeLock.validation }
  }
  const experimentId = args.shift()
  requireContract(experimentId, 'usage', 'an experiment ID is required')
  if (action === 'status' && args.length === 0) return store.load(experimentId)
  const { coordinator, trainer, publisher } = trainingController(config, (await store.load(experimentId)).spec, store)
  if (action === 'admit') { requireContract(args.length === 0, 'usage', 'admit accepts only an experiment ID'); return coordinator.admit(experimentId) }
  if (action === 'publish' || action === 'rollback') {
    requireContract(args.length === (action === 'rollback' ? 1 : 0) && !!config.activationPath, 'usage', 'publish EXP or rollback EXP RELEASE requires activationPath')
    return coordinator.publish(experimentId, publisher, args[0])
  }
  const runId = args.shift()
  requireContract(runId && args.length === 0, 'usage', 'training preflight|advance|status|pause|resume|close EXP RUN --config CONTROLLER.json')
  if (action === 'preflight') return trainer.preflight((await coordinator.inspect(experimentId, runId)).request)
  if (action === 'status') return coordinator.inspect(experimentId, runId)
  if (action === 'advance' || action === 'pause' || action === 'resume' || action === 'close') return coordinator[action](experimentId, runId)
  throw new Error('unknown training command')
}

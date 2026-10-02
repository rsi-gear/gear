import { dirname, resolve } from 'node:path'
import { parseScriptControllerConfig, scriptCommand } from './script-controller.js'
import { sealScriptSource } from './script-source.js'
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
import type { ModelTrainingSpec, TrainingDeploymentConfig, NodeIdentity, ContentRef, ModelTrainingRun } from './types.js'

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
/** Keep the existing durable coordinator moving; never silently resume a stopped job. */
export async function runTraining(
  coordinator: Pick<ModelTrainingCoordinator, 'inspect' | 'advance' | 'pause'>,
  experimentId: string, runId: string,
  options: { intervalMs?: number; signal?: AbortSignal; onProgress?: (run: ModelTrainingRun) => void } = {},
): Promise<ModelTrainingRun> {
  const interval = options.intervalMs ?? 1000
  requireContract(Number.isSafeInteger(interval) && interval > 0 && interval <= 60_000, 'invalid-poll-interval', 'poll interval must be 1–60000 ms')
  let run = await coordinator.inspect(experimentId, runId)
  while (true) {
    if (options.signal?.aborted && run.execution !== 'completed' && run.execution !== 'paused') {
      run = await coordinator.pause(experimentId, runId)
    } else if (run.execution === 'running' || run.execution === 'pausing') {
      try { run = await coordinator.advance(experimentId, runId) }
      catch (error) {
        if (!options.signal?.aborted) throw error
        run = await coordinator.pause(experimentId, runId)
      }
    } else return run
    options.onProgress?.(run)
    if (run.execution !== 'running' && run.execution !== 'pausing') return run
    await new Promise(resolve => setTimeout(resolve, interval))
  }
}

async function runFromCli(coordinator: ModelTrainingCoordinator, experimentId: string, runId: string) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  let previous = ''
  try {
    process.stderr.write(JSON.stringify({ experimentId, runId }) + '\n')
    return await runTraining(coordinator, experimentId, runId, {
      signal: controller.signal,
      onProgress: run => {
        const progress = JSON.stringify({ experimentId, runId, phase: run.phase, execution: run.execution, error: run.error })
        if (progress !== previous) { process.stderr.write(progress + '\n'); previous = progress }
      },
    })
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}

export async function trainingCommand(argv: string[]): Promise<unknown> {
  const args = [...argv]; const action = args.shift()
  if (action === '--help' || action === 'help') return {
    usage: 'gear-refine training ACTION --config CONTROLLER.json [arguments]',
    actions: ['node-probe DEPLOYMENT.json NODE_REF', 'preflight-deployment', 'freeze-deployment', 'put-json FILE', 'seal-hf DIRECTORY', 'seal-hf-node NODE_DIRECTORY', 'seal-dataset DIRECTORY', 'seal-sft INPUT.json', 'validate SPEC', 'init SPEC', 'admit EXP', 'preflight EXP RUN',
      'seal-script SOURCE_DIRECTORY MODULE:FACTORY', 'run SPEC', 'run SCRIPT_ID', 'run EXP RUN', 'advance EXP RUN', 'status EXP [RUN]', 'pause EXP RUN', 'resume EXP RUN', 'close EXP RUN', 'publish EXP', 'rollback EXP RELEASE'],
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
  const rawConfig = JSON.parse(await readFile(file, 'utf8'))
  if (rawConfig.kind === 'training-script-controller') return scriptCommand(action!, args, parseScriptControllerConfig(rawConfig))
  const config = parseTrainingControllerConfig(rawConfig)
  const scriptId = args.length === 1 && /^script_[a-f0-9]{32}$/.test(args[0]!)
  const scriptSpec = action === 'run' && args.length === 1 && !scriptId
    && JSON.parse(await readFile(args[0]!, 'utf8')).kind === 'training-script'
  if (scriptId || scriptSpec) {
    requireContract(config.schemaVersion === 2, 'script-controller-version', 'use a v2 controller or a training-script-controller config')
    return scriptCommand(action!, args, { schemaVersion: 1, kind: 'training-script-controller', storeRoot: config.storeRoot,
      node: config.deployment.nodes[config.deployment.modelRuntime.nodeRef]! })
  }
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
  if (action === 'seal-script') {
    requireContract(args.length === 2, 'usage', 'training seal-script SOURCE_DIRECTORY MODULE:FACTORY --config CONTROLLER.json')
    return sealScriptSource(store, resolve(args[0]!), args[1]!)
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
  if (action === 'seal-sft') {
    requireContract(args.length === 1, 'usage', 'training seal-sft INPUT.json --config CONTROLLER.json')
    const input = JSON.parse(await readFile(args[0]!, 'utf8'))
    if (config.schemaVersion === 2 && Array.isArray(input.records)) {
      // Authoring verifies sealed model limits; native chat masks also need
      // tokenizer bytes. Fetch missing declared files only; weights stay there.
      const model = await store.readJson<{ hfSnapshotRef: ContentRef }>(input.modelRef)
      const snapshot = await store.readJson<{ files: { path: string; contentRef: ContentRef }[] }>(model.hfSnapshotRef)
      const connection = config.deployment.nodes[config.deployment.modelRuntime.nodeRef]!
      let transport: ModelNodeTransport | undefined
      const hasMessages = input.records.some((r: { messages?: unknown }) => r.messages)
      const names = new Set(['config.json', 'tokenizer.json', 'tokenizer.model', 'tokenizer_config.json', 'special_tokens_map.json',
        'added_tokens.json', 'vocab.json', 'merges.txt', 'chat_template.jinja'])
      for (const entry of snapshot.files ?? []) if (names.has(entry.path) && (hasMessages || entry.path === 'config.json')) {
        try { await store.readBytes(entry.contentRef) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (!transport) {
            const observed = await new ModelNodeTransport(connection, null).call('probe', {}) as NodeIdentity
            transport = new ModelNodeTransport(connection, { nodeId: observed.nodeId, generation: observed.generation })
          }
          await transport.download(store, entry.contentRef)
        }
      }
    }
    return jsonProcess(config.schemaVersion === 1 ? config.slime.python : config.hitch.python,
      ['-m', 'gear_training.artifacts', 'seal-sft', '--store-root', store.root], input, 3_600_000)
  }
  if (action === 'seal-hf' || action === 'seal-dataset') {
    requireContract(args.length === 1, 'usage', `training ${action} DIRECTORY --config CONTROLLER.json`)
    return jsonProcess(config.schemaVersion === 1 ? config.slime.python : config.hitch.python, ['-m', 'gear_training.artifacts', action, '--store-root', store.root], { directory: args[0] }, 3_600_000)
  }
  if (action === 'run' && args.length === 1) {
    const input = JSON.parse(await readFile(args[0]!, 'utf8'))
    // Local source selection is resolved once; only immutable refs enter the experiment.
    if (input.scriptSource) {
      requireContract(input.trainer && typeof input.scriptSource.directory === 'string' && typeof input.scriptSource.entrypoint === 'string', 'invalid-script-source', 'scriptSource requires directory and entrypoint')
      requireContract(!input.trainer.script, 'duplicate-script-source', 'select scriptSource or a sealed trainer.script, not both')
      input.trainer.script = await sealScriptSource(store, resolve(dirname(resolve(args[0]!)), input.scriptSource.directory), input.scriptSource.entrypoint)
      delete input.scriptSource
    }
    const spec = parseModelTrainingSpec(input)
    const { coordinator } = trainingController(config, spec, store)
    const experiment = await coordinator.createExperiment(spec)
    const run = await coordinator.admit(experiment.id)
    return runFromCli(coordinator, experiment.id, run.id)
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
  requireContract(runId && args.length === 0, 'usage', 'training run|preflight|advance|status|pause|resume|close EXP RUN --config CONTROLLER.json')
  if (action === 'run') return runFromCli(coordinator, experimentId, runId)
  if (action === 'preflight') return trainer.preflight((await coordinator.inspect(experimentId, runId)).request)
  if (action === 'status') return coordinator.inspect(experimentId, runId)
  if (action === 'advance' || action === 'pause' || action === 'resume' || action === 'close') return coordinator[action](experimentId, runId)
  throw new Error('unknown training command')
}

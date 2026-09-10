import { digestJson } from '../../../src/training/digest.js'
import { freezeExecutionPlacement } from '../../../src/training/deployment.js'
import type { ModelTrainingSpecV1, ModelTrainingSpecV2, TrainingDeploymentConfig } from '../../../src/training/types.js'

const hash = digestJson('observed-runtime')
export const deployment = (task: 'local' | 'remote' = 'local', model: 'local' | 'ssh' = 'ssh'): TrainingDeploymentConfig => ({
  schemaVersion: 2, taskExecution: { placement: task, provider: task === 'local' ? 'local-docker' : 'harbor-remote' },
  modelRuntime: { nodeRef: 'gpu', launcher: 'process' }, gpuScheduling: { actorRollout: 'colocated', trainEvaluation: 'sequential' },
  nodes: { gpu: { transport: model === 'local' ? { type: 'local' } : { type: 'ssh', host: 'vast-debug' },
    workspace: '/workspace/gear', python: ['/opt/training/bin/python'], configPath: '/workspace/node.json', gateway: { localPort: 31001, nodePort: 31002 } } },
})
export const observation = (config: TrainingDeploymentConfig) => ({
  node: { nodeId: 'gpu-node', generation: 'boot-1', runtimeDigest: hash, gpuUuids: ['GPU-123'], launchers: ['process' as const] },
  provider: { name: config.taskExecution.provider, placement: config.taskExecution.placement, identityDigest: hash, capabilitiesDigest: hash,
    capabilities: { harborDocker: true, exactTrainingBinding: true, managedModelRoute: true } },
})
export function v2spec(legacy: ModelTrainingSpecV1, config = deployment()): ModelTrainingSpecV2 {
  const trainer = { ...legacy.trainer }; delete trainer.placement
  return { ...legacy, schemaVersion: 2, trainer, deployment: freezeExecutionPlacement(config, observation(config)),
    resources: { trainingDevices: [{ nodeId: 'gpu-node', gpuUuid: 'GPU-123' }], evaluationDevices: [{ nodeId: 'gpu-node', gpuUuid: 'GPU-123' }] },
    evaluation: { ...legacy.evaluation, provider: 'hitch-managed', topology: 'harbor-dataset' } }
}

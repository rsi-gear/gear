import { join } from 'node:path'
import { digestJson } from './digest.js'
import { jsonProcess } from './process.js'
import { requireContract } from './schema.js'
import { atomicWrite } from './store.js'
import type { FrozenExecutionPlacement, ModelNodeConnection } from './types.js'

export function hitchModelNodeBinding(node: FrozenExecutionPlacement['modelRuntime']) {
  requireContract(node.launcher === 'process', 'unsupported-model-launcher', 'model nodes require the process launcher')
  return { schema_version: '2', node_id: node.nodeId, generation: node.generation, runtime_digest: node.runtimeDigest, launcher: 'process' }
}

/** Register a private connection only against the already frozen node identity. */
export async function registerHitchModelNode(
  options: { command: string[]; root: string; modelNode?: Omit<ModelNodeConnection, 'workspace'> },
  binding: ReturnType<typeof hitchModelNodeBinding>,
  directory: string,
): Promise<string> {
  requireContract(options.modelNode, 'managed-node-not-configured', 'a private model-node connection is required')
  const file = join(directory, 'binding.json')
  const registration = join(directory, 'registration.json')
  await atomicWrite(file, binding)
  await atomicWrite(registration, { schema_version: '2', binding, connection: options.modelNode })
  const observed = await jsonProcess(options.command, ['--root', options.root, 'model-node', 'register', '--file', registration]) as { binding?: unknown } | null
  requireContract(observed && digestJson(observed.binding) === digestJson(binding),
    'model-node-registration-drift', 'Hitch registered another model-node identity')
  return file
}

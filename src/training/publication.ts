import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelPublisher } from './coordinator.js'
import { digestJson } from './digest.js'
import { jsonProcess } from './process.js'
import { requireContract } from './schema.js'
import { atomicWrite, TrainingContentStore, withTrainingFileLock } from './store.js'
import { hitchModelNodeBinding, registerHitchModelNode } from './hitch-model-node.js'
import type { FrozenExecutionPlacement, ModelNodeConnection, ModelVersion } from './types.js'

export interface HitchModelPublisherOptions {
  command: string[]
  root: string
  python: string[]
  activationPath: string
  artifactStorage?: 'controller' | 'model-node'
  modelNode?: Omit<ModelNodeConnection, 'workspace'>
  frozenNode?: FrozenExecutionPlacement['modelRuntime']
}

/** New episodes read this pointer once and use its immutable local/sha256 ID. */
export class HitchModelPublisher implements ModelPublisher {
  constructor(readonly store: TrainingContentStore, readonly options: HitchModelPublisherOptions) {}
  async activate(model: ModelVersion, activationId: string) {
    const directory = join(dirname(this.options.activationPath), 'published-models', model.id.slice(7))
    const call = (args: string[]) => jsonProcess(this.options.command, ['--root', this.options.root, ...args], undefined, 3_600_000)
    let imported: { model_id: string; tokenizer_digest: string; template_digest: string }
    let modelNode: ReturnType<typeof hitchModelNodeBinding> | undefined
    if (this.options.artifactStorage === 'model-node') {
      requireContract(this.options.frozenNode, 'managed-node-not-configured', 'remote publication requires the frozen experiment model node')
      modelNode = hitchModelNodeBinding(this.options.frozenNode)
      const capabilities = await call(['capabilities', '--json']) as Record<string, unknown>
      requireContract(capabilities.managed_model_node === '2' && capabilities.model_node_storage === '1',
        'remote-model-storage-unavailable', 'Hitch must support model-node artifact storage')
      const nodeFile = await registerHitchModelNode(this.options, modelNode,
        join(dirname(this.options.activationPath), 'model-nodes', digestJson(modelNode).slice(7)))
      const refFile = join(directory, 'snapshot-ref.json')
      await atomicWrite(refFile, model.hfSnapshotRef)
      imported = await call(['models', 'add-node', refFile, '--model-node-file', nodeFile, '--name', model.id.slice(7), '--json']) as typeof imported
      await call(['models', 'inspect', `local/${imported.model_id}`, '--verify', '--model-node-file', nodeFile, '--json'])
    } else {
      await jsonProcess(this.options.python, ['-m', 'gear_training.artifacts', 'materialize', '--store-root', this.store.root],
        { ref: model.hfSnapshotRef, destination: directory }, 3_600_000)
      imported = await call(['models', 'add', directory, '--name', model.id.slice(7), '--json']) as typeof imported
    }
    requireContract(/^sha256:[a-f0-9]{64}$/.test(imported.model_id) && imported.tokenizer_digest === model.tokenizerDigest
      && imported.template_digest === model.chatTemplateDigest, 'publication-import-drift', 'publication model import does not match the approved model')
    const snapshot = await this.store.readJson<{ files: { path: string; size: number; sha256: string }[] }>(model.hfSnapshotRef)
    requireContract(digestJson((imported as unknown as { files: unknown }).files) === digestJson(snapshot.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
      'publication-import-drift', 'publication weights differ from the approved HF snapshot')
    return withTrainingFileLock(`${this.options.activationPath}.lock`, async () => {
      const receiptPath = join(dirname(this.options.activationPath), 'activation-receipts', `${activationId}.json`)
      let receipt: { activationId: string; modelVersionId: string; active: true } | undefined
      try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as typeof receipt } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (receipt) {
        requireContract(receipt.modelVersionId === model.id, 'activation-id-conflict', 'activation id refers to another model')
        return receipt
      }
      let old: { activationId: string; modelVersionId: string } | undefined
      try { old = JSON.parse(await readFile(this.options.activationPath, 'utf8')) as typeof old } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      requireContract(old?.activationId !== activationId || old.modelVersionId === model.id, 'activation-id-conflict', 'activation id already refers to another model')
      await atomicWrite(this.options.activationPath, { schemaVersion: 1, activationId, modelVersionId: model.id, modelRef: await this.store.putJson(model),
        hitchModel: `local/${imported.model_id}`, ...(modelNode ? { modelNode } : {}) })
      const result = { activationId, modelVersionId: model.id, active: true as const }
      await atomicWrite(receiptPath, result)
      return result
    })
  }
}

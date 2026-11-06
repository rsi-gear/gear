import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelPublisher } from './coordinator.js'
import { digestJson } from './digest.js'
import { jsonProcess } from './process.js'
import { requireContract } from './schema.js'
import { atomicWrite, TrainingContentStore, withTrainingFileLock } from './store.js'
import { ModelNodeTransport, snapshotFileEntries } from './transport.js'
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

/** Publish the approved immutable artifact pointer; endpoint deployment remains external. */
export class HitchModelPublisher implements ModelPublisher {
  constructor(readonly store: TrainingContentStore, readonly options: HitchModelPublisherOptions) {}
  async activate(model: ModelVersion, activationId: string) {
    const directory = join(dirname(this.options.activationPath), 'published-models', model.id.slice(7))
    const call = (args: string[]) => jsonProcess(this.options.command, ['--root', this.options.root, ...args], undefined, 3_600_000)
    let imported: { model_id: string; tokenizer_digest: string; template_digest: string }
    if (this.options.artifactStorage === 'model-node') {
      requireContract(this.options.frozenNode && this.options.modelNode, 'training-node-not-configured', 'remote publication requires the frozen training node')
      const transport = new ModelNodeTransport({ ...this.options.modelNode, workspace: directory }, { nodeId: this.options.frozenNode.nodeId, generation: this.options.frozenNode.generation })
      await transport.download(this.store, model.hfSnapshotRef)
      const files = snapshotFileEntries(await this.store.readJson(model.hfSnapshotRef))
      requireContract(files, 'invalid-publication-snapshot', 'publication requires an immutable HF snapshot')
      // File contents are opaque; JSON configs must not expand the CAS traversal.
      for (const file of files) await transport.download(this.store, file.contentRef)
    }
    await jsonProcess(this.options.python, ['-m', 'gear.training.cli.artifacts', 'materialize', '--store-root', this.store.root],
      { ref: model.hfSnapshotRef, destination: directory }, 3_600_000)
    imported = await call(['models', 'add', directory, '--name', model.id.slice(7), '--json']) as typeof imported
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
        hitchModel: `local/${imported.model_id}` })
      const result = { activationId, modelVersionId: model.id, active: true as const }
      await atomicWrite(receiptPath, result)
      return result
    })
  }
}

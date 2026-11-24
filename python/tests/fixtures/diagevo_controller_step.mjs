// Test-only providers: the actual controller validates native Python artifacts
// and makes promotion decisions from explicitly synthetic evaluator scores.
import { readFile } from 'node:fs/promises'
import { ModelTrainingStore } from '../../../lib/training/store.js'
import { ModelTrainingCoordinator } from '../../../lib/training/coordinator.js'
import { digestJson } from '../../../lib/training/digest.js'
import { modelEvidenceKey } from '../../../lib/training/evaluation.js'
import { publicEndpointBinding } from '../../../lib/training/endpoint-binding.js'

const [root, experimentId, runId, artifactsFile] = process.argv.slice(2)
const store = new ModelTrainingStore(root)
const artifacts = JSON.parse(await readFile(artifactsFile, 'utf8'))
const run = (await store.load(experimentId)).runs[runId]
const request = run.request
const checkpoint = await store.readJson(artifacts.checkpointRef)
const status = {
  schemaVersion: 1, handle: artifacts.handle, phase: 'checkpointed', execution: 'completed',
  committedUpdate: checkpoint.committedUpdate, usage: artifacts.usage, resourcesReleased: true,
}
const trainer = {
  preflight: async () => ({ schemaVersion: 1, trainingExternalBinding: true, exactPolicyTokens: true,
    policyFencing: true, durableIdempotency: true, checkpointEveryUpdate: true, immutableHfExport: true,
    runtimeLockDigest: digestJson(request.trainer.runtimeLock), blockers: [] }),
  submit: async () => artifacts.handle,
  control: async () => status,
  inspect: async () => status,
  collect: async () => artifacts,
}
const generation = { max_output_tokens: 16, temperature: 0 }
const service = { engine: 'diagevo-evaluation-double' }
const prepare = async model => {
  const connection = { schema_version: '1', base_url: 'http://fixture.invalid/v1',
    wire_model: 'fixture-' + model.id.slice(-16), api: 'chat-completions', auth: { kind: 'none' },
    capabilities: { streaming: true, tool_calls: false, parallel_tool_calls: false, input_modalities: ['text'] } }
  return { schema_version: '1', kind: 'external-endpoint', endpoint_ref: 'endpoint/fixture',
    endpoint_revision: digestJson(connection), api: connection.api, wire_model: connection.wire_model,
    capabilities: connection.capabilities, generation,
    connection: { base_url: connection.base_url, auth: connection.auth },
    deployment_receipt: { schema_version: '1', model_digest: model.hfSnapshotRef.digest,
      wire_model: connection.wire_model, deployment_ref: 'fixture:' + model.id,
      source: 'diagevo-test', service_config: service } }
}
let evaluations = 0
const evaluator = {
  observeUsage: async () => ({ gpuSeconds: null, gpuSecondsSource: null }),
  evaluate: async r => {
    evaluations++
    return { schemaVersion: 2, evalId: `${runId}-eval-${evaluations}`, subject: r.subject, condition: r.condition,
      evidenceKey: modelEvidenceKey({ subject: r.subject, condition: r.condition }),
      endpointBinding: publicEndpointBinding(r.endpointBinding),
      trials: r.condition.slots.map((slot, index) => ({ taskId: slot.taskId, attempt: slot.attempt,
        runId: `${runId}-eval-${evaluations}-${index}`, valid: true, inferenceError: false,
        reward: r.model.trainingRunId === runId ? 1 : 0 })),
      complete: true, gpuSeconds: null, gpuSecondsSource: null }
  },
}
const coordinator = new ModelTrainingCoordinator(store, trainer, evaluator, {
  configurationDigest: digestJson('diagevo-test-preparer'), trustedReceiptSources: ['diagevo-test'], prepare,
})
console.log(JSON.stringify(await coordinator.advance(experimentId, runId)))

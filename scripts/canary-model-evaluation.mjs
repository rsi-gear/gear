// Independent immutable-model evaluation using the public Hitch evaluator.
// Diagnostic evidence only: this does not certify a runtime or promote a model.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { HitchModelEvaluator } from '../lib/training/hitch.js'
import { digestJson } from '../lib/training/digest.js'
import { TrainingContentStore, atomicWrite } from '../lib/training/store.js'
import { validateReadyEndpointBinding } from '../lib/training/endpoint-binding.js'
import { modelEvidenceKey, validateModelEvidence } from '../lib/training/evaluation.js'

const [inputFile, output] = process.argv.slice(2)
assert(inputFile && output, 'usage: canary-model-evaluation.mjs INPUT.json OUTPUT')
const input = JSON.parse(await readFile(inputFile, 'utf8'))
assert.equal(input.kind, 'gear-independent-model-diagnostic')
assert.equal(input.validated, false)
assert(Number.isSafeInteger(input.seconds) && input.seconds > 0 && input.seconds <= 1800)
const { request, options } = input
assert.equal(request.schemaVersion, 2)
validateReadyEndpointBinding(request.endpointBinding, request.model, request.condition, input.trustedReceiptSources)
assert.equal(request.condition.budgetsDigest, digestJson(options.budgets))
const store = new TrainingContentStore(input.storeRoot)
assert.deepEqual(await store.readJson(request.subject.modelVersionRef), request.model)
const evaluator = new HitchModelEvaluator(store, options)
const key = modelEvidenceKey(request), started = Date.now(), deadline = started + input.seconds * 1000
await mkdir(output, { recursive: true })
const summary = { kind: input.kind, validated: false, key, status: 'running', completed: false }

try {
  while (Date.now() < deadline) {
    try {
      const evidence = validateModelEvidence(await evaluator.evaluate(request, key), request)
      await atomicWrite(join(output, 'evidence.json'), evidence)
      assert(evidence.complete, 'independent evaluation did not produce a complete valid trial')
      assert(evidence.trials.every(t => !input.trainingRunIds.includes(t.runId)), 'evaluation reused a training run')
      Object.assign(summary, { status: 'passed', completed: true, evalId: evidence.evalId,
        gpuSeconds: evidence.gpuSeconds, trials: evidence.trials })
      console.log(JSON.stringify({ status: 'passed', evalId: evidence.evalId, trials: evidence.trials }))
      break
    } catch (error) {
      if (error?.code !== 'evaluation-pending') throw error
      await atomicWrite(join(output, 'progress.json'), { ...summary, elapsedSeconds: (Date.now() - started) / 1000, message: error.message })
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  assert(summary.completed, 'independent evaluation deadline expired')
} catch (error) {
  Object.assign(summary, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
  throw error
} finally {
  if (!summary.completed) {
    try { summary.cleanup = await evaluator.cancel(request, key) }
    catch (error) { summary.cleanupError = error instanceof Error ? error.message : String(error) }
  }
  summary.elapsedSeconds = (Date.now() - started) / 1000
  await atomicWrite(join(output, 'summary.json'), summary)
}

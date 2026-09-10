// Real controller/node/Hitch reconciliation. The caller owns an isolated native
// diagnostic job and its instance lifecycle; this script never certifies it.
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TrainingEpisodeCoordinator } from '../lib/training/episodes.js'
import { ModelNodeTransport, contentDependencies } from '../lib/training/transport.js'
import { retainContentGraph } from '../lib/training/retention.js'
import { jsonProcess } from '../lib/training/process.js'
import { TrainingContentStore, atomicWrite } from '../lib/training/store.js'
import { parseTrainingRequest, parseTrainingHandle, parseTrainingArtifacts } from '../lib/training/schema.js'
import { digestJson } from '../lib/training/digest.js'

const [inputFile, output] = process.argv.slice(2)
assert(inputFile && output, 'usage: node scripts/canary-training-controller.mjs INPUT.json OUTPUT')
const input = JSON.parse(await readFile(inputFile, 'utf8'))
assert.equal(input.kind, 'gear-full-driver-diagnostic')
assert.equal(input.validated, false)
const request = parseTrainingRequest(input.request), handle = parseTrainingHandle(input.handle)
assert.equal(request.schemaVersion, 2)
assert([1, 2].includes(request.trainer.updatesPerCandidate), 'diagnostic expects one or two updates')
assert.equal(request.trainer.runtimeLock.validation, 'pending-gpu')
assert.equal(handle.requestDigest, digestJson(request))
assert(Number.isSafeInteger(input.seconds) && input.seconds > 0 && input.seconds <= 1800)
await mkdir(output, { recursive: true })
const transport = new ModelNodeTransport(input.connection, input.node)
const store = new TrainingContentStore(input.storeRoot)
const lost = new Set(), lossEvents = []
const loseReply = (operation, result) => {
  if (!(input.loseReplies ?? []).includes(operation) || lost.has(operation)) return
  lost.add(operation)
  lossEvents.push({ operation, resultDigest: digestJson(result), elapsedSeconds: (Date.now() - started) / 1000 })
  throw Object.assign(new Error(`diagnostic discarded completed ${operation} reply`), { code: 'diagnostic-reply-lost' })
}
const originalCall = transport.call.bind(transport)
transport.call = async (...args) => { const result = await originalCall(...args); loseReply(args[0], result); return result }
const invoke = async (...args) => {
  const result = await jsonProcess(...args)
  if (args[1].includes('submit') && args[1].includes('eval')) loseReply('hitch.eval.submit', result)
  return result
}
const episodes = new TrainingEpisodeCoordinator(store, transport, input.hitch, invoke)
const summary = { kind: input.kind, validated: false, handle, status: 'running', artifactsCollected: false, phases: [] }
const started = Date.now(), deadline = started + input.seconds * 1000
let completed = false, last = '', lastStatus
try {
  await episodes.preflight(request)
  await episodes.remember(request, handle.jobId)
  while (Date.now() < deadline) {
    const status = await transport.call('training.inspect', { handle })
    lastStatus = status
    const terminal = !['running', 'pausing'].includes(status.execution)
    let result
    try { result = await episodes.reconcile(handle, terminal && status.execution !== 'completed') }
    catch (error) {
      if (error.code !== 'diagnostic-reply-lost') throw error
      await atomicWrite(join(output, 'lost-replies.json'), lossEvents)
      continue
    }
    const phase = JSON.stringify([status.execution, status.phase, status.committedUpdate, status.resourcesReleased])
    if (last !== phase) {
      last = phase
      const event = { elapsedSeconds: (Date.now() - started) / 1000, ...status }
      summary.phases.push(event)
      await atomicWrite(join(output, 'progress.json'), summary)
      console.log(JSON.stringify({ phase: status.phase, execution: status.execution, committedUpdate: status.committedUpdate, resourcesReleased: status.resourcesReleased }))
    }
    if (terminal && status.resourcesReleased && !result.pending) {
      if (input.expectInterruption === true) {
        assert(['failed', 'interrupted'].includes(status.execution), 'fault watch must interrupt this incarnation')
        completed = true
        Object.assign(summary, { status: 'interrupted', resourcesReleased: true })
        break
      }
      assert.equal(status.execution, 'completed', 'native diagnostic job failed')
      assert.notEqual(status.phase, 'inconclusive', 'no complete real reward batch')
      assert.equal(status.committedUpdate, request.trainer.updatesPerCandidate, 'every configured update must be committed')
      const artifacts = parseTrainingArtifacts(await transport.call('training.collect', { handle }))
      assert(artifacts.resourcesReleased)
      await atomicWrite(join(output, 'node-artifacts.json'), artifacts)
      await retainContentGraph(transport, store, contentDependencies(artifacts))
      completed = true
      Object.assign(summary, { status: 'passed', artifactsMetadataCollected: true, artifactsCollected: true, artifactStorage: 'model-node',
        checkpointRef: artifacts.checkpointRef, model: artifacts.model, gpuSeconds: artifacts.usage.gpuSeconds })
      break
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert(completed, 'controller diagnostic deadline expired')
} catch (error) {
  Object.assign(summary, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
  throw error
} finally {
  if (!completed) {
    for (const action of [() => transport.call('training.cancel', { handle }), () => episodes.reconcile(handle, true)]) {
      try { await action() } catch (error) { (summary.cleanupErrors ??= []).push(error instanceof Error ? error.message : String(error)) }
    }
  }
  summary.elapsedSeconds = (Date.now() - started) / 1000
  summary.lostReplies = lossEvents
  if (lastStatus) summary.lastStatus = lastStatus
  await atomicWrite(join(output, 'summary.json'), summary)
}

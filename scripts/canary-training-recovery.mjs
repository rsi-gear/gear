// Real crash boundaries and production replay/export/finalization on one node.
// The caller owns the instance lifecycle. Stage deadlines stop test processes;
// stopping the instance is a separate acceptance step after all model tests.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { jsonProcess } from '../lib/training/process.js'
import { atomicWrite, TrainingContentStore } from '../lib/training/store.js'
import { ModelNodeTransport } from '../lib/training/transport.js'
import { digestJson } from '../lib/training/digest.js'

const [root, mode] = process.argv.slice(2)
assert(root && (!mode || mode === '--resume'), 'usage: canary-training-recovery.mjs INPUT_ROOT [--resume]')
const read = async name => JSON.parse(await readFile(join(root, name), 'utf8'))
const payload = await read('training-payload.json'), hitch = await read('hitch-controller.json')
const updates = payload.request.trainer.updatesPerCandidate
assert([1, 2].includes(updates), 'recovery diagnostic supports one or two updates')
const deployment = await read('deployment-template.json'), facts = await read('node-facts.json')
const connection = deployment.nodes[deployment.modelRuntime.nodeRef]
assert.equal(connection.transport.type, 'ssh')
const node = { nodeId: facts.probe.nodeId, generation: facts.probe.generation }
const transport = new ModelNodeTransport(connection, node, 180_000)
const workspace = connection.workspace
const quote = s => `'${s.replaceAll("'", "'\\''")}'`
const remote = args => ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', connection.transport.host, args.map(quote).join(' ')]
const probeArgs = name => [...connection.python, join(workspace, 'python/probes', name), '--node-config', connection.configPath]
const output = join(root, 'recovery'); await mkdir(output, { recursive: true })
const children = new Set()
function run(argv, logPath) {
  const log = createWriteStream(logPath)
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => { children.delete(child); log.end(); code === 0 ? resolve() : reject(new Error(`diagnostic process exited ${code}; see ${logPath}`)) })
  })
  // A sibling may fail while the caller is awaiting launch; don't lose the
  // error or emit an unhandled rejection before Promise.all attaches.
  void done.catch(() => {})
  return { child, done }
}
const summary = { kind: 'real-single-gpu-recovery', validated: false, status: 'running', boundaries: [] }
let handle, startStage = 0, attemptStarted = false
try {
  assert.equal(digestJson((await transport.call('probe', {})).runtime), digestJson(facts.probe.runtime),
    'actual Python command differs from the frozen runtime observation')
  if (mode === '--resume') {
    const previous = await read('recovery/summary.json')
    const progress = await read('recovery/progress.json').catch(error => {
      if (error.code === 'ENOENT' && previous.boundaries.length === 0) return previous
      throw error
    })
    assert.equal(previous.status, 'failed', 'only an ended failed attempt can be resumed')
    const marker = await read('recovery/marker.json')
    handle = marker.handle; assert.equal(handle.requestDigest, digestJson(payload.request)); assert.deepEqual(marker.node, node)
    const preflight = await transport.call('training.preflight', { request: payload.request })
    assert(preflight.blockers.length > 0 && preflight.blockers.every(value => value === 'gpu-probes-pending'
      || value.startsWith('missing-runtime-probe-evidence:')), 'frozen runtime or GPU is unavailable; retain the original attempt')
    const current = await transport.call('training.inspect', { handle })
    assert(['failed', 'interrupted', 'paused'].includes(current.execution) && current.resourcesReleased,
      'old execution must be stopped and physically released before diagnostic continuation')
    startStage = progress.boundaries.length
    assert(startStage >= 0 && startStage <= 3)
    if (startStage === 0) {
      const inspect = 'from single_gpu_recovery_smoke import context; from gear_training.ledger import Ledger; import json,sys; n,s,d,r,h=context(sys.argv[1]); l=Ledger(d/"ledger.sqlite"); print(json.dumps({"batch":(d/"batch.json").exists(),"pending":(d/"pending-update.json").exists(),"commits":l.db.execute("SELECT COUNT(*) FROM commits").fetchone()[0]})); l.close()'
      const state = await jsonProcess(remote([...connection.python, '-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(workspace, 'python/probes'))}); ${inspect}`, connection.configPath]), [], undefined, 30_000)
      assert(state.batch && !state.pending && state.commits === 0, 'first-boundary retry requires the unchanged sealed batch and no saved update')
    }
    for (const [index, entry] of progress.boundaries.entries()) {
      assert.equal(entry.boundary, ['sealed-batch', 'pending-update', 'committed-update'][index])
      assert.equal(entry.report.status, 'interrupted'); assert.equal(entry.report.resourcesReleased, true)
      assert.equal(entry.fault.injected, true); assert.deepEqual(entry.fault.handle, handle); assert.deepEqual(entry.fault.node, node)
      assert(entry.fault.unresponsiveGpuSeconds >= 2.5)
      assert.deepEqual(await read(`recovery/stage-${index + 1}/fault.json`), entry.fault)
    }
    if (startStage < 3) {
      const boundary = ['sealed-batch', 'pending-update', 'committed-update'][startStage]
      const script = 'import json,sys; from pathlib import Path; p=Path(sys.argv[1]); print(p.read_text() if p.exists() else "null")'
      const fault = await jsonProcess(remote([...connection.python, '-c', script, join(workspace, `fault-${boundary}.json`)]), [], undefined, 30_000)
      assert(!fault?.injected, 'an injected fault lacks a collected receipt; reconcile it before continuing')
    }
    const archive = join(output, `failed-attempt-${Date.now()}`); await mkdir(archive)
    for (const name of ['summary.json', 'progress.json', 'failure-log-tails.json', 'failure-log-tails-reconciled.json', `stage-${startStage + 1}`]) {
      try { await rename(join(output, name), join(archive, name)) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    summary.boundaries = progress.boundaries
    await atomicWrite(join(output, 'progress.json'), summary)
    attemptStarted = true
  } else {
    try {
      await readFile(join(output, 'marker.json'))
      assert.fail('existing diagnostic must be resumed explicitly; original evidence is retained')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const prepare = [...connection.python, join(workspace, 'python/probes/controller_training_smoke.py'), 'prepare', '--node-config', connection.configPath]
    const prepareCommand = `${prepare.map(quote).join(' ')} > ${quote(join(workspace, 'prepare.log'))} 2>&1 && cat ${quote(join(workspace, 'node-state/full-driver-diagnostic.json'))}`
    const marker = await jsonProcess(['ssh', '-T', '-o', 'BatchMode=yes', connection.transport.host, prepareCommand], [], payload, 180_000)
    handle = marker.handle; assert.equal(handle.requestDigest, digestJson(payload.request)); assert.deepEqual(marker.node, node)
    await atomicWrite(join(output, 'marker.json'), marker)
    attemptStarted = true
  }
  const boundaries = ['sealed-batch', 'pending-update', 'committed-update', null]
  for (const [index, boundary] of boundaries.entries()) {
    if (index < startStage) continue
    const stage = join(output, `stage-${index + 1}`); await mkdir(stage, { recursive: true })
    let watch
    if (boundary) {
      watch = run(remote([...probeArgs('single_gpu_recovery_smoke.py'), 'watch', '--boundary', boundary,
        '--output', join(workspace, `fault-${boundary}.json`), '--seconds', '900']), join(stage, 'watch.log'))
    }
    const launch = index === 0 && mode !== '--resume' ? [...probeArgs('controller_training_smoke.py'), 'start'] : [...probeArgs('single_gpu_recovery_smoke.py'), 'resume']
    const launched = await jsonProcess(remote(launch), [], undefined, 120_000)
    await atomicWrite(join(stage, 'launch.json'), launched)
    const input = { ...payload, handle, connection, node, storeRoot: join(root, 'controller-content'), hitch,
      seconds: 900, expectInterruption: !!boundary, loseReplies: index === 0 ? ['hitch.eval.submit', 'training.episodes.ack', 'training.episodes.admit', 'training.episodes.result'] : [] }
    const inputFile = join(stage, 'controller-input.json'); await atomicWrite(inputFile, input)
    const controller = run([process.execPath, resolve('scripts/canary-training-controller.mjs'), inputFile, stage], join(stage, 'controller.log'))
    await Promise.all([controller.done, ...(watch ? [watch.done] : [])])
    const report = await read(`recovery/stage-${index + 1}/summary.json`)
    assert.equal(report.status, boundary ? 'interrupted' : 'passed')
    if (boundary) {
      const fault = await jsonProcess(remote(['cat', join(workspace, `fault-${boundary}.json`)]), [], undefined, 30_000)
      assert.equal(fault.injected, true); assert.equal(fault.boundary, boundary)
      assert(fault.unresponsiveGpuSeconds >= 2.5); assert.deepEqual(fault.handle, handle)
      await atomicWrite(join(stage, 'fault.json'), fault)
      summary.boundaries.push({ boundary, report, fault })
    }
    await atomicWrite(join(output, 'progress.json'), summary)
    console.log(JSON.stringify({ stage: index + 1, boundary, status: report.status, gpuSeconds: report.lastStatus.usage.gpuSeconds }))
  }
  const artifacts = await read('recovery/stage-4/node-artifacts.json'), store = new TrainingContentStore(join(root, 'controller-content'))
  const commit = await store.readJson(artifacts.updateCommitRefs[0])
  assert.equal(artifacts.updateCommitRefs.length, updates); assert.equal(commit.committedUpdate, 1)
  const checkpoint = await store.readJson(commit.checkpointRef), cursor = await store.readJson(checkpoint.dataCursorRef)
  const [sealed, pending, committed] = summary.boundaries.map(value => value.fault)
  assert.deepEqual(sealed.batch, pending.batch); assert.deepEqual(pending.batch, committed.batch)
  assert.equal(commit.consumedBatchDigest, pending.pending.batchRef.digest)
  assert.deepEqual(checkpoint.actorStateRef, pending.pending.trainerStateRef)
  assert.deepEqual(cursor, pending.pending.dataCursor)
  assert.equal(committed.commits.length, 1)
  const final = await read('recovery/stage-4/summary.json')
  assert(final.artifactsCollected && final.artifactStorage === 'model-node')
  const modelRef = await store.putJson(artifacts.model)
  const finalCheckpoint = await store.readJson(artifacts.checkpointRef)
  assert.equal(finalCheckpoint.committedUpdate, updates)
  const captureAudit = await jsonProcess(remote([...probeArgs('audit_training_capture.py'),
    '--capture-root', join(workspace, 'training-capture'), '--output', join(workspace, 'training-capture-audit.json')]), [], undefined, 60_000)
  assert.equal(captureAudit.passed, true)
  assert.equal(captureAudit.requestDigest, handle.requestDigest)
  assert.deepEqual(captureAudit.checkpointRef, artifacts.checkpointRef)
  assert.equal(captureAudit.updates.length, updates)
  await atomicWrite(join(output, 'training-capture-audit.json'), captureAudit)
  Object.assign(summary, { status: 'passed', handle, committedUpdates: updates, originalSealedBatch: pending.pending.batchRef,
    model: artifacts.model, modelRef, checkpointRef: artifacts.checkpointRef, gpuSeconds: artifacts.usage.gpuSeconds,
    captureAuditDigest: digestJson(captureAudit) })
} catch (error) {
  if (!attemptStarted) throw error
  Object.assign(summary, { status: 'failed', error: String(error) })
  if (handle) {
    await transport.call('training.cancel', { handle }).catch(() => {})
    try {
      const releaseDeadline = Date.now() + 30_000
      while (Date.now() < releaseDeadline) {
        const status = await transport.call('training.inspect', { handle })
        if (status.resourcesReleased) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      const failure = await jsonProcess(remote(probeArgs('collect_training_failure.py')), [], undefined, 30_000)
      assert.deepEqual(failure.handle, handle)
      assert.deepEqual(failure.node, node)
      await atomicWrite(join(output, 'failure-log-tails.json'), failure)
      summary.failureLogDigest = digestJson(failure)
    } catch (collectionError) {
      summary.failureLogCollectionError = String(collectionError)
    }
  }
  throw error
} finally {
  for (const child of children) child.kill('SIGTERM')
  if (attemptStarted) await atomicWrite(join(output, 'summary.json'), summary)
}

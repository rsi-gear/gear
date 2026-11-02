// Opt-in smoke: one synthetic seed failure, real Python-authored diagnosis and
// generation, and receipt replay. This does not benchmark a Target model.
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..')
const api = path => import(pathToFileURL(join(packageRoot, 'lib', path)).href)
const { ProcessOperationProvider } = await api('adapters/process/operation-provider.js')
const { processProfile } = await api('application/profile-store.js')
const { harnessAdapter } = await api('application/harness-adapters.js')
const { canonicalDigest } = await api('domain/canonical.js')
const { targetResources } = await api('adapters/storage/targets.js')
const { freezeAlgorithmSource } = await api('adapters/python/source.js')
const { PythonAlgorithmWorker } = await api('adapters/python/worker.js')
const { resolvePythonExecutable } = await api('adapters/python/interpreter.js')
const executable = process.env.GEAR_TEST_CODEX, model = process.env.GEAR_TEST_CODEX_MODEL
const authHome = process.env.GEAR_TEST_CODEX_AUTH_HOME, output = process.env.GEAR_TEST_LIVE_OUTPUT
assert(executable && model && authHome && output,
  'Set GEAR_TEST_CODEX, GEAR_TEST_CODEX_MODEL, GEAR_TEST_CODEX_AUTH_HOME and a new GEAR_TEST_LIVE_OUTPUT')
const python = resolvePythonExecutable()
const linuxIsolation = process.env.GEAR_TEST_LINUX_ISOLATION ?? 'seccomp'
assert(['seccomp', 'bubblewrap-only'].includes(linuxIsolation))
await mkdir(resolve(output), { mode: 0o700 })
const root = await realpath(output)
const targets = join(root, 'targets'), directory = join(root, 'operations')
const source = join(root, 'source'), scratch = join(root, 'scratch')
await mkdir(join(targets, 'anchor'), { recursive: true })
await mkdir(directory); await mkdir(scratch)
const harness = harnessAdapter('pi')
await harness.prepare(join(targets, 'anchor'))
const anchorDigest = canonicalDigest(await targetResources(join(targets, 'anchor')))
const implementationIdentity = await freezeAlgorithmSource(source, [{
  path: 'custom_meta.py', source: join(packageRoot, 'examples/algorithms/custom_meta.py'),
}])
const passEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].filter(name => process.env[name])
const profile = processProfile({ kind: 'codex', passEnv, configuration: {
  executable, model, authHome, reasoningEffort: 'low', timeoutMs: 180000,
  linuxIsolation,
  allowedDomains: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
} })
const context = { runId: 'python-meta-smoke', targetAdapter: 'pi', targets, directory,
  experiencePython: python, protectedPaths: [root], tasks: [{ id: 'seed', family: 'format',
    instruction: 'Write the integer 42 with one trailing newline to /app/answer.txt.' }] }
const provider = await ProcessOperationProvider.connect(profile, context)
await provider.prepareAdmission()
const worker = new PythonAlgorithmWorker({ python, sourceRoot: source, scratch, implementationIdentity, linuxIsolation })
const algorithm = { name: 'gepa', options: {
  meta_policy: { entrypoint: 'custom_meta:FailureAnalysis', configuration: {} },
  proposal_planner: 'custom_meta:plan_findings',
} }
const view = { run_id: context.runId, step_id: 0, seed: 'python-meta-live',
  tasks: [{ id: 'seed', family: 'format', estimated_cost: 1 }],
  candidates: [{ id: 'anchor', parent_id: null, digest: anchorDigest }],
  evidence: [{ candidate_id: 'anchor', task_id: 'seed', repetition: 0, score: 0,
    status: 'valid', scope: 'global',
    feedback: 'The answer was returned as prose but the requested output file was missing.' }],
  completed: [], budget: { evaluations_remaining: 10, candidates_remaining: 1,
    rounds: 1, repetitions: 1 }, anchor_id: 'anchor', objective: null }
let state = { version: 1, data: { phase: 'parents', round: 0 } }
const report = { model, linuxIsolation, taskCount: 1, evidence: 'synthetic-seed-feedback', evaluatedTargets: 0,
  algorithmIdentity: implementationIdentity, providerIdentity: provider.identity, operations: [] }
let active
try {
  await worker.start(AbortSignal.timeout(30000))
  for (const kind of ['diagnose_seed', 'generate_candidate']) {
    const decision = await worker.step(view, state, algorithm, AbortSignal.timeout(30000))
    assert.equal(decision.operations.length, 1)
    const operation = decision.operations[0]
    assert.equal(operation.kind, kind)
    assert(operation.payload.meta, 'Python must author both Meta tasks')
    const request = { operationId: canonicalDigest({ runId: view.run_id, operation }),
      runId: view.run_id, generation: 1, operation, partition: 'seed', repetitions: 0,
      slots: [], evidence: view.evidence }
    await writeFile(join(root, kind + '-decision.json'), JSON.stringify(decision, null, 2) + '\n')
    active = request
    console.log('Starting real ' + kind)
    let receipt
    try { receipt = await provider.submit(request, AbortSignal.timeout(profile.timeoutMs + 10000)) }
    catch (error) {
      const inspection = await provider.inspect(request, AbortSignal.timeout(10000))
      if (inspection.state !== 'complete') throw error
      receipt = inspection.receipt
    }
    await writeFile(join(root, kind + '-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    assert.equal(receipt.result.status, 'complete', 'Inspect private operation diagnostics')
    assert.equal(receipt.result.data.declined, false)
    if (kind === 'diagnose_seed') {
      assert(receipt.result.data.findings?.length, 'Custom diagnosis must return actionable findings')
      assert.equal(receipt.candidate, null)
      assert.equal(canonicalDigest(await targetResources(join(targets, 'anchor'))), anchorDigest)
    } else {
      assert(receipt.candidate)
      await harness.check(join(targets, receipt.candidate.id))
      assert.notEqual(canonicalDigest(await targetResources(join(targets, receipt.candidate.id))), anchorDigest)
      assert.equal(operation.payload.hypothesis, view.completed[0].data.findings[0])
    }
    const events = join(directory, request.operationId.slice(7), 'events.jsonl')
    const before = await readFile(events)
    const reconnected = await ProcessOperationProvider.connect(profile, context)
    assert.equal(reconnected.identity, provider.identity)
    assert.deepEqual((await reconnected.inspect(request, AbortSignal.timeout(10000))).receipt, receipt)
    assert.deepEqual(await reconnected.submit(request, AbortSignal.timeout(10000)), receipt)
    assert.deepEqual(await readFile(events), before, 'Replay must not call the model again')
    report.operations.push({ kind, status: receipt.result.status,
      usage: receipt.usage, candidate: receipt.candidate, replayReusedReceipt: true })
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    state = decision.state
    view.completed.push(receipt.result)
    view.step_id++
    active = undefined
    console.log(kind + ': passed, including receipt replay')
  }
  assert.equal(report.operations.length, 2)
  console.log('Python Meta smoke passed: ' + root)
} catch (error) {
  if (active) await provider.cancel(active)
  throw error
} finally { await worker.dispose() }

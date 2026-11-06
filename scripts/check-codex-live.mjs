// Explicitly opt-in: real Codex Meta generation using the production process provider.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const packageRoot = process.env.GEAR_TEST_PACKAGE_ROOT ?? resolve(import.meta.dirname, '..')
const api = path => import(pathToFileURL(join(packageRoot, 'lib', path)).href)
const { ProcessOperationProvider } = await api('adapters/process/operation-provider.js')
const { processProfile } = await api('application/profile-store.js')
const { harnessAdapter } = await api('application/harness-adapters.js')
const { canonicalDigest } = await api('domain/canonical.js')
const { targetResources } = await api('adapters/storage/targets.js')
const executable = process.env.GEAR_TEST_CODEX, model = process.env.GEAR_TEST_CODEX_MODEL
const authHome = process.env.GEAR_TEST_CODEX_AUTH_HOME
assert(executable && model && authHome, 'Set GEAR_TEST_CODEX, GEAR_TEST_CODEX_MODEL and GEAR_TEST_CODEX_AUTH_HOME')
const adapters = (process.env.GEAR_TEST_LIVE_ADAPTERS ?? 'dsh,pi').split(',')
assert(adapters.length && adapters.every(id => ['dsh', 'pi'].includes(id)))
const output = process.env.GEAR_TEST_LIVE_OUTPUT
  ? resolve(process.env.GEAR_TEST_LIVE_OUTPUT)
  : await mkdtemp(join(tmpdir(), 'gear-codex-live-'))
if (process.env.GEAR_TEST_LIVE_OUTPUT) await mkdir(output, { mode: 0o700 })
const root = await realpath(output)
console.log('Live Meta evidence: ' + root)
const profile = processProfile({ kind: 'codex', passEnv: [], configuration: {
  executable, model, authHome, reasoningEffort: 'low', timeoutMs: 180000,
  allowedDomains: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
} })
const report = { model, source: 'external-model', evidence: 'synthetic-seed-feedback', operations: [] }
for (const id of adapters) {
  const targets = join(root, id, 'targets'), directory = join(root, id, 'operations')
  await mkdir(join(targets, 'anchor'), { recursive: true }); await mkdir(directory)
  const harness = harnessAdapter(id)
  await harness.prepare(join(targets, 'anchor'))
  const context = { runId: 'live-' + id, targetAdapter: id, targets, directory, protectedPaths: [root],
    tasks: [{ id: 'seed', instruction: 'Write the integer 42 with one trailing newline to /app/answer.txt.', family: 'format' }] }
  const provider = await ProcessOperationProvider.connect(profile, context)
  await provider.prepareAdmission()
  const request = { operationId: canonicalDigest({ test: 'live-meta', id, model }), runId: context.runId, generation: 1,
    operation: { kind: 'generate_candidate', candidate_id: 'candidate', parent_id: 'anchor', task_ids: ['seed'], scope: 'global',
      rationale: 'Make output-file creation reliable', payload: { hypothesis: 'Before finalizing, verify the requested output file exists and has the requested format.' } },
    partition: 'seed', repetitions: 0, slots: [], evidence: [{ candidate_id: 'anchor', task_id: 'seed', repetition: 0,
      score: 0, status: 'valid', scope: 'global', feedback: 'The answer was returned as prose but the requested output file was missing.' }] }
  try {
    // An interrupted acknowledgment is reconciled; it never authorizes a second generation.
    let receipt
    try { receipt = await provider.submit(request, AbortSignal.timeout(profile.timeoutMs + 10000)) }
    catch (error) {
      const inspection = await provider.inspect(request, AbortSignal.timeout(10000))
      if (inspection.state !== 'complete') throw error
      receipt = inspection.receipt
    }
    await writeFile(join(root, id, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    assert.equal(receipt.result.status, 'complete', 'Meta generation failed; inspect private operation diagnostics')
    assert(receipt.candidate && receipt.result.data.declined === false, 'Model declined the controlled generation task')
    await harness.check(join(targets, 'candidate'))
    assert.notEqual(canonicalDigest(await targetResources(join(targets, 'candidate'))),
      canonicalDigest(await targetResources(join(targets, 'anchor'))), 'Candidate did not change')
    const events = join(directory, request.operationId.slice(7), 'events.jsonl')
    const before = await readFile(events)
    const reconnected = await ProcessOperationProvider.connect(profile, context)
    assert.equal(reconnected.identity, provider.identity)
    assert.deepEqual((await reconnected.inspect(request, AbortSignal.timeout(10000))).receipt, receipt)
    assert.deepEqual(await reconnected.submit(request, AbortSignal.timeout(10000)), receipt)
    assert.deepEqual(await readFile(events), before, 'Replay started another model operation')
    report.operations.push({ adapter: id, status: receipt.result.status, candidate: receipt.candidate.id,
      identity: provider.identity, usage: receipt.usage, replayReusedReceipt: true })
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(id + ': real generation, validated candidate and receipt replay passed')
  } catch (error) {
    await provider.cancel(request)
    throw error
  }
}

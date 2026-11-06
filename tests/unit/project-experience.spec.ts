import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { DshHarnessAdapter } from '../../src/adapters/dsh/harness.js'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { ProjectExperience } from '../../src/application/experience.js'
import { ProjectApplication } from '../../src/application/project-service.js'
import { ProjectController } from '../../src/application/project-controller.js'
import { stageExperience } from '../../src/adapters/codex/experience.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { ExperienceContext } from '../../src/domain/experience.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { Json } from '../../src/domain/algorithm-wire.js'
import type { CodexJob } from '../../src/adapters/codex/contracts.js'
import type { OperationProvider, OperationRequest } from '../../src/ports/operations.js'
import { DurableRunner } from '../../src/runtime/runner.js'
import { sealedProvider } from '../../src/application/sealed-provider.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(adapterName: 'pi' | 'dsh' = 'pi') {
  const root = await mkdtemp(join(tmpdir(), 'gear-experience-')); roots.push(root)
  const runRoot = join(root, '.gear/runs/run'), store = new RunStore(join(root, '.gear'))
  const targets = new TargetStore(runRoot, adapterName === 'pi' ? new PiHarnessAdapter() : new DshHarnessAdapter(), canonicalDigest('provider'))
  for (const id of ['anchor', 'candidate']) {
    await targets.adapter.prepare(targets.path(id))
    if (id === 'candidate') await writeFile(join(targets.path(id), adapterName === 'pi' ? 'AGENTS.md' : 'prompts/system.md'), 'Keep exact output formatting.\n')
  }
  const anchor = { id: 'anchor', digest: (await targets.seal('anchor', 'test')).digest, parent_id: null }
  const candidate = { id: 'candidate', digest: (await targets.seal('candidate', '', 'anchor')).digest, parent_id: 'anchor' }
  const config = { target: { adapter: adapterName } }
  await writeFile(join(runRoot, 'project.json'), JSON.stringify(config))
  const spec: RunSpec = {
    version: 1, kind: 'refine', benchmarkDigest: canonicalDigest('tasks'), configDigest: canonicalDigest(config),
    implementationIdentity: canonicalDigest('algorithm'), providerIdentity: targets.runtimeIdentity,
    championRevision: null, targetSourceDigest: anchor.digest, lineage: null,
    algorithm: { name: 'gepa', options: {} }, validationMode: 'holdout', seed: 'fixed',
    seedTasks: [{ id: 'seed', family: 'format', estimated_cost: 1 }], heldOutTaskIds: ['HELD_OUT_CANARY'], anchor,
    budget: { rounds: 2, maxEvaluations: 10, maxCandidates: 3, repetitions: 1 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 }, objectiveIdentity: pythonObjective.identity,
    generationBudget: { version: 1, total: {}, perOperation: {} }, evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [0] },
  }
  const journal = await store.create('run', spec)
  journal.candidates.push(candidate)
  journal.seedEvidence = [anchor, candidate].map((item, index) => ({ candidate_id: item.id, task_id: 'seed', repetition: 0, score: index, status: 'valid', scope: 'global', feedback: 'seed feedback' }))
  const request: OperationRequest = {
    runId: journal.id, operationId: canonicalDigest('generate'), generation: 0, partition: 'seed', repetitions: 1,
    slots: [], evidence: [], operation: { kind: 'generate_candidate', candidate_id: candidate.id, parent_id: anchor.id,
      task_ids: ['seed'], scope: 'global', rationale: 'format output', payload: { hypothesis: 'keep format', unrelated: 'PRIVATE_PAYLOAD' } },
  }
  const result = { operation_id: request.operationId, kind: request.operation.kind, candidate_id: candidate.id, status: 'complete' as const, data: { arbitrary: 'PRIVATE_RESULT' } }
  journal.operations.push({ request, status: 'complete', reservedAttempts: 0, receipt: { result, candidate, evidence: [], physicalAttempts: 0, usage: {}, provenance: { private: 'PRIVATE_PROVENANCE' } } })
  const evaluation = { ...request, operationId: canonicalDigest('evaluate'), slots: [{ taskId: 'seed', repetition: 0 }], operation: { ...request.operation, kind: 'evaluate_seed' as const, parent_id: null } }
  journal.operations.push({ request: evaluation, status: 'complete', reservedAttempts: 1, receipt: { result: { ...result, operation_id: evaluation.operationId, kind: 'evaluate_seed' }, evidence: journal.seedEvidence.filter(cell => cell.candidate_id === candidate.id), candidate: null, physicalAttempts: 1, usage: {}, provenance: null } })
  await store.write(journal)
  const experience = new ProjectExperience(runRoot, targets)
  const meta: OperationRequest = { ...request, operationId: canonicalDigest('diagnose'), operation: { ...request.operation, kind: 'diagnose_seed', parent_id: null }, evidence: journal.seedEvidence.filter(cell => cell.candidate_id === candidate.id) }
  return { root, runRoot, store, targets, journal, experience, meta }
}

it('captures actual-parent seed outcomes and target diffs without raw receipts or held-out data', async () => {
  const { experience, journal } = await fixture()
  const first = await experience.capture(journal)
  expect(first.records).toHaveLength(1)
  expect(first.records[0]).toMatchObject({ parent: { id: 'anchor' }, candidate: { id: 'candidate' }, classification: { effect: 'improved', complete: true }, change: { files: [{ path: 'AGENTS.md' }] } })
  expect(await experience.access(journal, { snapshot_digest: first.digest, ref: 'experience:' + first.records[0]!.digest.slice(7), view: 'diff' })).toMatchObject({ items: [{ patch: expect.stringContaining('+Keep exact') }] })
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE_|HELD_OUT/)
  journal.heldOutEvidence = [{ ...journal.seedEvidence[0]!, task_id: 'HELD_OUT_CANARY', feedback: 'PRIVATE_HELD_OUT' }]
  journal.gate = { status: 'rejected', reason: 'PRIVATE_GATE' }
  expect(await experience.capture(journal)).toEqual(first)
})

it('keeps earlier observations readable while new incomplete evidence creates another revision', async () => {
  const { experience, journal, store, meta } = await fixture()
  const before = await experience.capture(journal)
  const context = await experience.prepare(journal, meta)
  expect(context.cards).toHaveLength(1)
  expect(context.cards[0]).toMatchObject({ candidate_id: 'candidate', match_reasons: ['actual direct parent edit outcome'] })
  journal.seedEvidence[1] = { ...journal.seedEvidence[1]!, score: null, status: 'environment_failed' }
  await store.write(journal)
  const after = await experience.capture(journal)
  expect(after.digest).not.toBe(before.digest)
  expect(after.records[0]?.classification).toMatchObject({ effect: 'incomparable', unavailable_tasks: 1 })
  expect(await experience.store.read(before.digest)).toEqual(before)
  await experience.verify({ ...meta, experience: context })
  const old = await experience.access(journal, { snapshot_digest: before.digest })
  expect(old).toMatchObject({ total: 1, items: [{ card: { classification: { effect: 'improved' } } }] })
})

it('rejects damaged and symlink snapshots, changed contexts, and unbound lineage', async () => {
  const { experience, journal, meta } = await fixture()
  const context = await experience.prepare(journal, meta)
  const changed: ExperienceContext = { ...context, available_records: 100 }
  await expect(experience.verify({ ...meta, experience: changed })).rejects.toMatchObject({ code: 'experience-context-mismatch' })
  const path = join(experience.store.root, context.snapshot_digest.slice(7) + '.json'), original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('improved', 'regressed'))
  await expect(experience.verify({ ...meta, experience: context })).rejects.toMatchObject({ code: 'experience-identity-mismatch' })
  await rm(path); await writeFile(path + '.other', original); await symlink(path + '.other', path)
  await expect(experience.store.read(context.snapshot_digest)).rejects.toThrow()
  journal.candidates[1]!.parent_id = 'unknown'
  await expect(experience.capture(journal)).rejects.toThrow()
})

it('serves bounded query/read through the shared controller and explicitly reports uncaptured trajectories', async () => {
  const { root } = await fixture()
  const controller = new ProjectController(new ProjectApplication(root, { async provider() { throw new Error('read-only') } }))
  const page = await controller.invoke('experience.query', { run_id: 'run', query: { effects: ['improved'] } }) as { snapshot_digest: string; items: Array<{ card: { ref: string } }> }
  const params = { run_id: 'run', snapshot_digest: page.snapshot_digest, ref: page.items[0]!.card.ref }
  expect(await controller.invoke('experience.read', { ...params, view: 'diff' })).toMatchObject({ total: 1, items: [{ path: 'AGENTS.md' }] })
  expect(await controller.invoke('experience.read', { ...params, view: 'trajectory' })).toMatchObject({ availability: 'not_captured', items: [] })
  await expect(controller.invoke('experience.read', { ...params, ref: 'experience:outside' })).rejects.toThrow('outside the frozen snapshot')
  await expect(controller.invoke('experience.query', { run_id: 'run', path: '/private' })).rejects.toThrow()
})

it('stages a standalone Python reader for only the reserved snapshot', async () => {
  const { root, targets, experience, journal, meta } = await fixture()
  meta.experience = await experience.prepare(journal, meta)
  const sandbox = join(root, 'sandbox'); await mkdir(sandbox)
  const job = { input: { context: { targets: join(targets.runRoot, 'targets'), tasks: [{ id: 'seed' }] }, request: meta } } as CodexJob
  const staged = await stageExperience(job, sandbox)
  const input = staged.input as unknown as { reader: { argv: string[] } }
  const [executable, ...args] = input.reader.argv
  const child = execFile(executable!, args, { maxBuffer: 65536 })
  child.stdin!.end(JSON.stringify({ action: 'query', query: { paths: ['AGENTS.md'] } }))
  const stdout = await new Promise<string>((resolve, reject) => { let text = ''; child.stdout!.on('data', chunk => { text += chunk }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(text))) })
  expect(JSON.parse(stdout)).toMatchObject({ snapshot_digest: meta.experience.snapshot_digest, total: 1 })
  expect(await readFile(join(sandbox, 'experience/snapshot.json'), 'utf8')).not.toMatch(/PRIVATE_|HELD_OUT/)
  expect(staged.readPaths.length).toBeGreaterThan(0)
})

it('resumes the exact committed Meta context without regenerating its snapshot', async () => {
  const { store, experience, targets, journal } = await fixture()
  const prepare = vi.spyOn(experience, 'prepare')
  let fail = true
  const calls: OperationRequest[] = []
  const provider: OperationProvider = {
    identity: journal.spec.providerIdentity,
    capabilities: { seeds: true, temperature: true, subsets: true, idempotentSubmission: true, inspect: true, cancel: true, physicalAttemptAccounting: true, evidenceProjection: false, generationBudget: false, hardDollarBudget: false },
    async submit(request) { calls.push(request); if (fail) throw new Error('lost response'); return { result: { operation_id: request.operationId, kind: request.operation.kind, candidate_id: request.operation.candidate_id, status: 'complete', data: null }, evidence: [], candidate: null, physicalAttempts: 0, usage: {}, provenance: null } },
    async inspect() { return { state: 'not_submitted' } }, async cancel() {},
  }
  const driver = { async step(view: { step_id: number }, state: typeof journal.state) { return { state, reason: 'test', operations: [{ kind: view.step_id === 0 ? 'diagnose_seed' as const : 'stop' as const, candidate_id: view.step_id === 0 ? 'candidate' : null, parent_id: null, task_ids: view.step_id === 0 ? ['seed'] : [], scope: 'global', rationale: '', payload: null as Json }] } } }
  const run = () => new DurableRunner(store, driver, sealedProvider(provider, targets, experience), pythonObjective, experience).run('run', new AbortController().signal)
  await expect(run()).rejects.toThrow('lost response')
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(calls[0]!.experience?.cards).toHaveLength(1)
  fail = false
  expect((await run()).status).toBe('completed')
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(calls[1]).toEqual(calls[0])
})

it('binds original seed executions, ignores projections and replaces obsolete artifact sources', async () => {
  const { journal, experience, runRoot, store } = await fixture()
  journal.spec.artifactReader = { format: 'test', implementation_identity: canonicalDigest('reader'), configuration: { root: '/PRIVATE_ROOT' } }
  journal.specDigest = canonicalDigest(journal.spec)
  const evaluation = journal.operations[1]!
  const artifact = { kind: 'trajectory' as const, format: 'test', task_id: 'seed', repetition: 0, status: 'available' as const, content_digest: canonicalDigest('trace'), locator: { run_id: 'PRIVATE_RUN' }, reason: null }
  evaluation.receipt!.artifacts = [artifact]
  await store.write(journal)
  const snapshot = await experience.capture(journal)
  const references = []
  for await (const reference of experience.store.trajectoryReferences(snapshot, snapshot.records[0]!)) references.push(reference)
  expect(references).toHaveLength(1)
  expect(references[0]).toMatchObject({ candidate_id: 'candidate', content_digest: artifact.content_digest })
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_')
  const { TrajectoryStore } = await import('../../src/adapters/storage/trajectory.js')
  const binding = await new TrajectoryStore(join(runRoot, 'trajectory-sources')).read('sha256:' + references[0]!.ref.slice(11))
  expect(binding).toMatchObject({ origin_run_id: 'run', origin_candidate_id: 'candidate', operation_id: evaluation.request.operationId, receipt_digest: canonicalDigest(evaluation.receipt), artifact })
  const { SeedTrajectoryArchive } = await import('../../src/application/trajectory.js')
  const projection = structuredClone(evaluation)
  projection.request.projection = { sourceOperationId: evaluation.request.operationId, sourceReceiptDigest: canonicalDigest(evaluation.receipt), rootOperationId: evaluation.request.operationId, rootRequestDigest: canonicalDigest(evaluation.request), rootProvenanceDigest: canonicalDigest(evaluation.receipt!.provenance), attempt: 1, missing: [] }
  projection.receipt!.artifacts = []
  journal.operations.push(projection)
  expect(await new SeedTrajectoryArchive(runRoot, journal).references(['candidate'], ['seed'])).toEqual(references)
  const prior = structuredClone(evaluation)
  prior.request.runId = 'older-run'; prior.request.operation.candidate_id = 'old-candidate'
  prior.receipt!.evidence = prior.receipt!.evidence.map(cell => ({ ...cell, candidate_id: 'old-candidate' }))
  const inherited = structuredClone(journal)
  inherited.operations = []
  inherited.seedEvidence = [ { ...prior.receipt!.evidence[0]!, candidate_id: inherited.spec.anchor.id } ]
  const inheritedRefs = await new SeedTrajectoryArchive(runRoot, inherited, { operations: [prior] } as import('../../src/application/baseline.js').BaselineProof).references(['anchor'], ['seed'])
  const inheritedSource = await new TrajectoryStore(join(runRoot, 'trajectory-sources')).read('sha256:' + inheritedRefs[0]!.ref.slice(11))
  expect(inheritedSource).toMatchObject({ candidate_id: 'anchor', origin_run_id: 'older-run', origin_candidate_id: 'old-candidate', receipt_digest: canonicalDigest(prior.receipt) })
  const repair = structuredClone(evaluation); repair.request.operationId = canonicalDigest('repair'); repair.receipt!.artifacts = []
  journal.operations.push(repair)
  expect(await new SeedTrajectoryArchive(runRoot, journal).references(['candidate'], ['seed'])).toEqual([])
})

it('serves frozen trajectory pages through ProjectController and exports private source bindings', async () => {
  const { root, journal, runRoot, store, experience } = await fixture()
  const executable = join(root, 'hitch.mjs'), providerRoot = join(root, 'provider'), run = 'run_' + 'c'.repeat(32)
  await mkdir(providerRoot)
  await writeFile(executable, `#!${process.execPath}\nimport {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};await trajectoryFixture();`, { mode: 0o700 })
  await writeFile(join(providerRoot, run + '.json'), JSON.stringify([{ type: 'assistant/message', seq: 0, data: 'seed trace' }]))
  const { HitchArtifactReader } = await import('../../src/adapters/hitch/trajectory.js')
  const reader = new HitchArtifactReader(executable, providerRoot)
  journal.spec.artifactReader = reader.descriptor; journal.specDigest = canonicalDigest(journal.spec)
  journal.operations[1]!.receipt!.artifacts = [await reader.capture(run, 'seed', 0, new AbortController().signal)]
  journal.status = 'completed'
  await store.write(journal)
  const snapshot = await experience.capture(journal), record = snapshot.records[0]!
  const controller = new ProjectController(new ProjectApplication(root, { async provider() { throw new Error('read-only') } }))
  const references = []
  for await (const reference of experience.store.trajectoryReferences(snapshot, record)) references.push(reference)
  const params = { run_id: 'run', snapshot_digest: snapshot.digest, ref: 'experience:' + record.digest.slice(7), source_ref: references[0]!.ref }
  expect(await controller.invoke('experience.trajectory', params)).toMatchObject({ total: 1, scope: 'canonical-session', items: [{ data: 'seed trace' }] })
  await expect(controller.invoke('experience.trajectory', { ...params, source_ref: 'trajectory:' + 'e'.repeat(64) })).rejects.toMatchObject({ code: 'trajectory-outside-snapshot' })
  const exported = await controller.invoke('run.export', { run_id: 'run' }) as { destination: string }
  const path = join(exported.destination, 'trajectory-sources.json'), bundle = JSON.parse(await readFile(path, 'utf8'))
  expect(bundle).toMatchObject({ version: 1, reader: reader.descriptor, sources: [{ candidate_id: 'candidate', artifact: { locator: { run_id: run } } }] })
  expect(await controller.invoke('run.export', { run_id: 'run' })).toEqual(exported)
  await writeFile(path, '{}')
  await expect(controller.invoke('run.export', { run_id: 'run' })).rejects.toMatchObject({ code: 'export-identity-mismatch' })
  await writeFile(join(runRoot, 'trajectory-sources', references[0]!.ref.slice(11) + '.json'), '{}')
  await expect(controller.invoke('experience.trajectory', params)).rejects.toMatchObject({ code: 'trajectory-source-changed' })
})

it('derives native child-session resource use with frozen sources, caches complete proof and exposes bounded views', async () => {
  const { root, journal, runRoot, store, experience, targets } = await fixture('dsh')
  const { createHash } = await import('node:crypto')
  const hash = (bytes: string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
  const executable = join(root, 'hitch.mjs'), providerRoot = join(root, 'provider'), run = 'run_' + 'd'.repeat(32)
  const raw = JSON.stringify([{ type: 'assistant/message', seq: 0, data: 'canonical seed trace' }])
  await mkdir(join(providerRoot, 'runs', run, 'trajectory/provider'), { recursive: true })
  await writeFile(executable, `#!${process.execPath}\nimport {trajectoryFixture} from ${JSON.stringify(new URL('../fixtures/trajectory-hitch.mjs', import.meta.url).href)};await trajectoryFixture();`, { mode: 0o700 })
  await writeFile(join(providerRoot, run + '.json'), raw)
  const content = await readFile(join(targets.path('candidate'), 'prompts/system.md'), 'utf8')
  const headers = [{ type: 'session', version: 0, id: 'main', delegationDepth: 0 }, { type: 'session', version: 1, id: 'child', delegationDepth: 1, parentSession: 'main' }]
  const childEvents = [{ type: 'tool/call', seq: 1, data: { callId: 'read', name: 'read', arguments: { path: '/opt/gear-target/prompts/system.md' } } },
    { type: 'tool/result', seq: 2, data: { message: { role: 'tool', toolCallId: 'read', source: { kind: 'tool', callId: 'read' }, content: [{ type: 'text', text: content }], isError: false } } }]
  const files = []
  for (const [index, name] of ['deepseek-session.jsonl', 'deepseek-child-session-1.jsonl'].entries()) {
    const text = [headers[index], ...(index ? childEvents : [])].map(value => JSON.stringify(value)).join('\n') + '\n'
    const path = 'trajectory/provider/' + name
    await writeFile(join(providerRoot, 'runs', run, path), text)
    files.push({ role: 'provider_events', path, media_type: 'application/x-ndjson', sha256: hash(text), bytes: Buffer.byteLength(text) })
  }
  await writeFile(join(providerRoot, 'runs', run, 'trajectory.ref.json'), JSON.stringify({ schema_version: '2', run_id: run, provider: 'deepseek', fidelity: 'provider_native', provider_session_id: 'main', files: [...files, { role: 'canonical_session', path: 'canonical.jsonl', sha256: hash(raw) }] }))
  const { HitchArtifactReader } = await import('../../src/adapters/hitch/trajectory.js')
  const reader = new HitchArtifactReader(executable, providerRoot)
  const artifact = await reader.capture(run, 'seed', 0, new AbortController().signal)
  expect(artifact.locator).toMatchObject({ native_manifest_digest: expect.stringMatching(/^sha256:/) })
  journal.spec.artifactReader = reader.descriptor; journal.specDigest = canonicalDigest(journal.spec)
  journal.operations[1]!.receipt!.artifacts = [artifact]
  await store.write(journal)
  const childPath = join(providerRoot, 'runs', run, files[1]!.path)
  const originalChild = await readFile(childPath)
  await writeFile(childPath, originalChild.toString().replace('exact', 'wrong'))
  const partial = await experience.capture(journal)
  expect(await experience.access(journal, { snapshot_digest: partial.digest, ref: 'experience:' + partial.records[0]!.digest.slice(7), view: 'modification-use' })).toMatchObject({ items: [{ status: 'unknown', source: { coverage: 'partial' } }] })
  await writeFile(childPath, originalChild)
  const snapshot = await experience.capture(journal), record = snapshot.records[0]!
  expect(snapshot.digest).not.toBe(partial.digest)
  expect(await experience.access(journal, { snapshot_digest: snapshot.digest, ref: 'experience:' + record.digest.slice(7), view: 'modification-use' })).toMatchObject({ summary: { candidate_trials: 1, status_counts: { observed: 1 }, conditioned_results: expect.arrayContaining([expect.objectContaining({ status: 'observed', mean_reward_delta: 1 })]) },
    items: [{ status: 'observed', source: { child_session_files: 1, coverage: 'listed-files-complete' }, artifacts: [{ path: 'prompts/system.md', actions: [{ session_id: 'child', call_seq: 1, result_seq: 2 }] }] }] })
  expect(JSON.stringify(record.modification_use)).not.toContain(content)
  const view = await experience.access(journal, { ref: 'experience:' + record.digest.slice(7), view: 'modification-use', snapshot_digest: snapshot.digest })
  expect(view).toMatchObject({ summary: { status_counts: { observed: 1 }, conditioned_results: expect.arrayContaining([expect.objectContaining({ status: 'observed', mean_reward_delta: 1 })]) }, items: [{ status: 'observed' }], total: 1 })
  expect(await experience.access(journal, { ref: 'experience:' + partial.records[0]!.digest.slice(7), view: 'modification-use', snapshot_digest: partial.digest })).toMatchObject({ items: [{ status: 'unknown' }] })
  await rm(providerRoot, { recursive: true })
  expect(await experience.capture(journal)).toEqual(snapshot)
  const { readdir } = await import('node:fs/promises')
  const cached = (await readdir(join(runRoot, 'modification-use'))).find(name => name.endsWith('.json'))!
  await writeFile(join(runRoot, 'modification-use', cached), '{}')
  await expect(experience.capture(journal)).rejects.toMatchObject({ code: 'modification-observation-changed' })
})

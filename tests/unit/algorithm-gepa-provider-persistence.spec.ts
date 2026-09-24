import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BindingStore } from '../../src/algorithm/bindings.js'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaDiagnosisProvider, GepaEvaluationProvider, GepaGenerationProvider } from '../../src/algorithm/providers/gepa-operations.js'
import { ProviderReconcileError } from '../../src/algorithm/provider-errors.js'
import { JournalArtifactStore, SearchJournalProviderRecordBackend } from '../../src/algorithm/runtime/persistence.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { cellKey, plannedCells } from '../../src/search/evidence.js'
import { evaluatedFixture, fixtures, revise, scopeFixture } from '../../src/search/testing.js'
import { MemorySearchStore } from '../../src/search/testing.js'
import { SearchBudgetExceeded } from '../../src/search/store.js'
import { SearchExecutionFailure } from '../../src/search/recovery.js'
import { seal } from '../../src/search/contracts.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('restores GEPA started intent and sealed artifacts from a SearchJournal checkpoint under the original physical key', async () => {
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const roundId = 'round-a', evolutionId = 'evolution-a'
  const originalKey = digestJson([evolutionId, roundId,
    `evaluation-${digestJson([plan.digest, fixture.anchor.digest]).slice(7)}`])
  const schema = { id: 'harness', slots: { harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } } as const
  let journal = new MemorySearchStore()
  const makeHost = async () => {
    const root = mkdtempSync(join(tmpdir(), 'gepa-journal-provider-')); roots.push(root)
    const artifacts = new JournalArtifactStore(join(root, 'artifacts'), journal, roundId)
    await artifacts.hydrate()
    const bindings = new BindingStore(artifacts, schema)
    const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
      manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
    const bindingSetRef = bindings.create({ harness })
    const records = new SearchJournalProviderRecordBackend(journal, roundId)
    const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider,
      undefined, records, journal)
    return { artifacts, bindingSetRef, provider }
  }
  const first = await makeHost()
  const input = { roundIdentity: { evolutionId, roundId }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
  const operationId = digestJson(['journal-provider', roundId]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-round-a', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: first.provider.describe().implementationDigest, bindingSetRef: first.bindingSetRef,
    limits: { rolloutCells: plannedCells(fixture.seed, plan, fixture.anchor).length, repairCells: 0 } }
  const realEvaluate = fixture.provider.evaluate
  const realInspect = fixture.provider.inspectEvaluation!
  let loseResponse = true
  let inspectionReady = false
  fixture.provider.inspectEvaluation = async request => inspectionReady
    ? realInspect(request) : { status: 'running', handle: 'original-key-running' }
  fixture.provider.evaluate = async request => {
    const cells = await realEvaluate(request)
    if (loseResponse) { loseResponse = false; throw new Error('lost physical response after durable execution') }
    return cells
  }
  expect((await first.provider.submit(envelope)).status).toBe('running')
  expect(fixture.executions).toHaveLength(1)
  expect(fixture.executions[0]?.key).toBe(originalKey)
  inspectionReady = true
  journal = new MemorySearchStore(journal.checkpoint())
  const resumed = await makeHost()
  expect(resumed.bindingSetRef).toEqual(envelope.bindingSetRef)
  expect(resumed.provider.describe().implementationDigest).toBe(envelope.implementationDigest)
  expect((await resumed.provider.inspect(envelope)).status).toBe('replay-safe')
  const submitted = await resumed.provider.submit(envelope)
  expect(submitted.status).toBe('completed')
  expect(fixture.executions).toHaveLength(1)
  journal = new MemorySearchStore(journal.checkpoint())
  const finalHost = await makeHost()
  const final = await finalHost.provider.inspect(envelope)
  expect(final.status).toBe('completed')
  if (final.status !== 'completed' || final.completion.outcome.kind !== 'result') throw new Error('missing durable GEPA result')
  const resultRef = (final.completion.outcome.value as { resultRef: Parameters<JournalArtifactStore['getJson']>[0] }).resultRef
  expect((finalHost.artifacts.getJson(resultRef) as { cells: unknown[] }).cells).toHaveLength(1)
  const physicalCell = (finalHost.artifacts.getJson(resultRef) as unknown as {
    cells: Array<{ identity: Parameters<typeof cellKey>[0]; digest: string }> }).cells[0]!
  expect(await journal.read(`cells/${cellKey(physicalCell.identity).slice(7)}`)).toEqual({ ref: physicalCell.digest })
  expect(await journal.read(`rounds/${roundId}/evaluation-${digestJson([plan.digest, fixture.anchor.digest]).slice(7)}`))
    .toEqual({ ref: (finalHost.artifacts.getJson(resultRef) as { digest: string }).digest })
})

it('surfaces a journal cache write failure in the same call without repeating the physical rollout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-journal-write-failure-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const journal = new MemorySearchStore()
  const originalWrite = journal.write.bind(journal)
  let fail = true
  journal.write = async (name, value) => {
    if (name.startsWith('cells/') && fail) { fail = false; throw new Error('disk unavailable') }
    return originalWrite(name, value)
  }
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings,
    fixture.provider, undefined, undefined, journal)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
  const operationId = digestJson(['journal-write-failure', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: 1, repairCells: 0 } }
  await expect(provider.submit(envelope)).rejects.toMatchObject({ name: 'ProviderReconcileError',
    cause: { message: 'disk unavailable' } } satisfies Partial<ProviderReconcileError>)
  expect(fixture.executions).toHaveLength(1)
  expect((await provider.submit(envelope)).status).toBe('completed')
  expect(fixture.executions).toHaveLength(1)
})

it('uses the timed physical signal but the original caller signal for recovery inspection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-deadline-signal-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
  const operationId = digestJson(['timed-evaluation', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: 1, repairCells: 0 } }
  const caller = new AbortController()
  let runSignal: AbortSignal | undefined
  let inspectionSignal: AbortSignal | undefined
  let physicalCalls = 0
  fixture.provider.evaluate = async request => new Promise((_resolve, reject) => {
    physicalCalls++
    runSignal = request.signal
    const abort = () => reject(request.signal.reason)
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
  })
  fixture.provider.inspectEvaluation = async request => {
    inspectionSignal = request.signal
    return { status: 'running', handle: 'original-worker' }
  }
  const dispose = provider.beginLegacyInvocation({ callerSignal: caller.signal, deadlineAt: Date.now() + 30 })
  try {
    expect((await provider.submit(envelope)).status).toBe('running')
    expect(physicalCalls).toBe(1)
    expect(runSignal?.aborted).toBe(true)
    expect(runSignal?.reason).toBeInstanceOf(SearchBudgetExceeded)
    expect(inspectionSignal).not.toBe(caller.signal)
    expect(inspectionSignal?.aborted).toBe(false)
    expect(caller.signal.aborted).toBe(false)
    const stopped = new Error('caller stopped')
    caller.abort(stopped)
    expect(inspectionSignal?.aborted).toBe(true)
    expect(inspectionSignal?.reason).toBe(stopped)
  } finally { dispose() }
})

it('seals a zero-cost timeout without starting a fresh physical evaluation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-expired-new-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
  const operationId = digestJson(['expired-new', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: 1, repairCells: 0 } }
  fixture.provider.evaluate = async () => { throw new Error('expired evaluation must not start') }
  const dispose = provider.beginLegacyInvocation({ callerSignal: new AbortController().signal,
    deadlineAt: Date.now() - 1 })
  try {
    const submission = await provider.submit(envelope)
    expect(submission.status).toBe('completed')
    if (submission.status !== 'completed' || submission.completion.outcome.kind !== 'result')
      throw new Error('missing terminal timeout evidence')
    expect(submission.completion.receipt?.cumulative).toEqual({ rolloutCells: 0, repairCells: 0 })
    const resultRef = (submission.completion.outcome.value as { resultRef: Parameters<typeof artifacts.getJson>[0] }).resultRef
    expect(artifacts.getJson(resultRef)).toMatchObject({ failure: {
      kind: 'budget-exhausted', code: 'time', message: 'search budget exhausted: time' } })
  } finally { dispose() }
})

it('seals the original evaluation without starting process repair when projection is deferred', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-deferred-projection-')); roots.push(root)
  const fixture = fixtures(4, true)
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const physical = fixture.provider.evaluate
  fixture.provider.evaluate = async request => (await physical(request)).map(cell => revise(cell, {
    process: { status: 'missing', contractDigest: cell.identity.processContractDigest!, reason: 'original has no projection' },
  }))
  let projections = 0
  fixture.provider.completeProcess = async () => { projections++; throw new Error('repair must be an independent operation') }
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'required', projectionPolicy: 'defer' } as unknown as JsonValue
  const operationId = digestJson(['defer-process', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: 1, repairCells: 0 } }
  const submitted = await provider.submit(envelope)
  expect(submitted.status).toBe('completed')
  if (submitted.status !== 'completed' || submitted.completion.outcome.kind !== 'result') throw new Error('missing original evaluation')
  const resultRef = (submitted.completion.outcome.value as { resultRef: Parameters<FileArtifactStore['getJson']>[0] }).resultRef
  const stage = artifacts.getJson(resultRef) as { cells: Array<{ process?: { status: string } }> }
  expect(stage.cells[0]?.process?.status).toBe('missing')
  expect(projections).toBe(0)
})

it('retries a legacy running evaluation once per explicit public invocation using the original key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-legacy-running-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const input = { roundIdentity: { evolutionId: 'legacy:evolution', roundId: 'round-a' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
  const operationId = digestJson(['legacy-running', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-round-a', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: 1, repairCells: 0 } }
  const realEvaluate = fixture.provider.evaluate
  let ready = false
  const calls: string[] = []
  fixture.provider.inspectEvaluation = async () => ({ status: 'running', handle: 'physical-handle' })
  fixture.provider.evaluate = async request => {
    calls.push(request.idempotencyKey)
    if (!ready) throw new Error('physical work still running')
    return realEvaluate(request)
  }
  provider.beginLegacyInvocation()
  expect((await provider.submit(envelope)).status).toBe('running')
  expect((await provider.inspect(envelope)).status).toBe('running')
  expect(await provider.legacyPending(envelope)).toEqual({ state: 'running', handle: 'physical-handle',
    reason: 'physical work still running' })
  expect(calls).toHaveLength(1)
  provider.beginLegacyInvocation()
  expect((await provider.inspect(envelope)).status).toBe('replay-safe')
  ready = true
  expect((await provider.submit(envelope)).status).toBe('completed')
  expect(calls).toEqual([calls[0], calls[0]])
  expect(calls[0]).toBe(digestJson(['legacy:evolution', 'round-a',
    `evaluation-${digestJson([plan.digest, fixture.anchor.digest]).slice(7)}`]))
  expect((await provider.inspect(envelope)).status).toBe('completed')
})

it('uses the legacy diagnosis key and conditionally meters configured generation resources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-legacy-key-')); roots.push(root)
  const fixture = fixtures(4)
  const { result: baseline } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const physical = fixture.diagnosis.diagnose
  let key = ''
  fixture.diagnosis.diagnose = async request => { key = request.idempotencyKey; return physical(request) }
  const journal = new MemorySearchStore()
  const diagnosis = new GepaDiagnosisProvider(join(root, 'operations'), artifacts, bindings,
    fixture.diagnosis, undefined, journal)
  const taskIds = ['task-0']
  const input = { roundIdentity: { evolutionId: 'legacy:evolution', roundId: 'round-a' }, snapshot: fixture.anchor,
    universe: fixture.seed, taskIds, baseline } as unknown as JsonValue
  const operationId = digestJson(['diagnosis', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-round-a', decisionIndex: 0, localKey: 'diagnose',
    operationId, idempotencyKey: operationId, kind: 'gepa.diagnose', input, inputDigest: jsonDigest(input),
    implementationDigest: diagnosis.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { diagnosisInputTokens: 100, diagnosisOutputTokens: 100 } }
  const diagnosisSubmission = await diagnosis.submit(envelope)
  expect(diagnosisSubmission.status).toBe('completed')
  expect(key).toBe(digestJson(['round-a',
    `diagnosis-${digestJson([fixture.anchor.digest, baseline.digest, taskIds]).slice(7)}`]))
  const diagnosisName = `diagnosis-${digestJson([fixture.anchor.digest, baseline.digest, taskIds]).slice(7)}`
  const inputPointer = await journal.read<{ ref: string }>(`rounds/round-a/${diagnosisName}-input`)
  expect(await journal.object(inputPointer!.ref)).toMatchObject({ snapshot: fixture.anchor,
    universe: fixture.seed, taskIds, cells: baseline.cells, maxInputTokens: 100, maxOutputTokens: 100 })
  const diagnosisPointer = await journal.read<{ ref: string }>(
    `rounds/round-a/${diagnosisName}`)
  expect(diagnosisPointer?.ref).toMatch(/^sha256:/)
  expect((await journal.object<{ digest: string }>(diagnosisPointer!.ref)).digest).toBe(diagnosisPointer?.ref)
  const consumed = await journal.read<{ ref: string }>(
    `rounds/round-a/consumed-${digestJson([baseline.stagePlanDigest, baseline.snapshotDigest]).slice(7)}`)
  expect(await journal.object(consumed!.ref)).toMatchObject({ resultDigest: baseline.digest,
    consumer: 'diagnosis', consumerDigest: diagnosisPointer?.ref })
  const combinations = [
    { generationTokens: false, generationRequests: false },
    { generationTokens: true, generationRequests: false },
    { generationTokens: false, generationRequests: true },
    { generationTokens: true, generationRequests: true },
  ]
  for (const metering of combinations) {
    const provider = new GepaGenerationProvider(join(root, 'generation'), artifacts, bindings, fixture.hooks,
      digestJson('hooks').slice(7), undefined, metering)
    expect(provider.describe().meteredDimensions).toEqual(Object.entries(metering)
      .filter(([, enabled]) => enabled).map(([dimension]) => dimension))
  }
})

it('keeps an earlier evidence consumer when diagnosis reuses the same verified baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-diagnosis-consumer-')); roots.push(root)
  const fixture = fixtures(4)
  const { result: baseline } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const journal = new MemorySearchStore()
  const consumedName = `consumed-${digestJson([baseline.stagePlanDigest, baseline.snapshotDigest]).slice(7)}`
  const firstConsumption = seal({ stagePlanDigest: baseline.stagePlanDigest,
    snapshotDigest: baseline.snapshotDigest, resultDigest: baseline.digest,
    consumer: 'scope-preparation' as const, consumerDigest: digestJson('prepared-scope') })
  await journal.freeze('r', consumedName, () => firstConsumption)
  const provider = new GepaDiagnosisProvider(join(root, 'operations'), artifacts, bindings,
    fixture.diagnosis, undefined, journal)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, snapshot: fixture.anchor,
    universe: fixture.seed, taskIds: ['task-0'], baseline } as unknown as JsonValue
  const operationId = digestJson(['diagnosis-earlier-consumer', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'diagnose',
    operationId, idempotencyKey: operationId, kind: 'gepa.diagnose', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { diagnosisInputTokens: 100, diagnosisOutputTokens: 100 } }
  expect((await provider.submit(envelope)).status).toBe('completed')
  const pointer = await journal.read<{ ref: string }>(`rounds/r/${consumedName}`)
  expect(pointer?.ref).toBe(firstConsumption.digest)
  expect(await journal.object(pointer!.ref)).toEqual(firstConsumption)
})

it('materializes an inspected diagnosis completion in the same call after a lost response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-diagnosis-lost-response-')); roots.push(root)
  const fixture = fixtures(4)
  const { result: baseline } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const journal = new MemorySearchStore()
  const provider = new GepaDiagnosisProvider(join(root, 'operations'), artifacts, bindings,
    fixture.diagnosis, undefined, journal)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, snapshot: fixture.anchor,
    universe: fixture.seed, taskIds: ['task-0'], baseline } as unknown as JsonValue
  const operationId = digestJson(['diagnosis-lost-response', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'diagnose',
    operationId, idempotencyKey: operationId, kind: 'gepa.diagnose', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { diagnosisInputTokens: 100, diagnosisOutputTokens: 100 } }
  const realDiagnose = fixture.diagnosis.diagnose
  const realInspect = fixture.diagnosis.inspectDiagnosis!
  let physicalCalls = 0, inspectCalls = 0
  fixture.diagnosis.diagnose = async request => {
    physicalCalls++
    await realDiagnose(request)
    throw new Error('diagnosis response lost')
  }
  fixture.diagnosis.inspectDiagnosis = async (key, signal) => {
    inspectCalls++
    return realInspect(key, signal)
  }
  const dispose = provider.beginLegacyInvocation()
  try {
    const submission = await provider.submit(envelope)
    expect(submission.status).toBe('completed')
    expect(physicalCalls).toBe(1)
    expect(inspectCalls).toBe(1)
    expect((await provider.inspect(envelope)).status).toBe('completed')
    expect(inspectCalls).toBe(1)
  } finally { dispose() }
})

it.each(['consumption', 'result'] as const)(
  'replays a sealed diagnosis response after a %s pointer write fault without another physical call', async fault => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-diagnosis-pointer-fault-')); roots.push(root)
  const fixture = fixtures(4)
  const { result: baseline } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const journal = new MemorySearchStore()
  const originalWrite = journal.write.bind(journal)
  let failPointer = true
  journal.write = async (name, value) => {
    const target = fault === 'consumption' ? name.startsWith('rounds/r/consumed-')
      : name.startsWith('rounds/r/diagnosis-') && !name.endsWith('-input')
    if (target && failPointer) {
      failPointer = false
      throw new Error('diagnosis pointer disk unavailable')
    }
    return originalWrite(name, value)
  }
  const provider = new GepaDiagnosisProvider(join(root, 'operations'), artifacts, bindings,
    fixture.diagnosis, undefined, journal)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, snapshot: fixture.anchor,
    universe: fixture.seed, taskIds: ['task-0'], baseline } as unknown as JsonValue
  const operationId = digestJson(['diagnosis-pointer-fault', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'diagnose',
    operationId, idempotencyKey: operationId, kind: 'gepa.diagnose', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { diagnosisInputTokens: 100, diagnosisOutputTokens: 100 } }
  const realDiagnose = fixture.diagnosis.diagnose
  let physicalCalls = 0
  fixture.diagnosis.diagnose = async request => { physicalCalls++; return realDiagnose(request) }
  await expect(provider.submit(envelope)).rejects.toMatchObject({ name: 'ProviderReconcileError',
    cause: { message: 'diagnosis pointer disk unavailable' } })
  expect(physicalCalls).toBe(1)
  expect((await provider.inspect(envelope)).status).toBe('replay-safe')
  expect((await provider.submit(envelope)).status).toBe('completed')
  expect(physicalCalls).toBe(1)
  const consumed = await journal.read<{ ref: string }>(
    `rounds/r/consumed-${digestJson([baseline.stagePlanDigest, baseline.snapshotDigest]).slice(7)}`)
  expect(consumed?.ref).toMatch(/^sha256:/)
})

it.each(['running', 'partially-complete', 'complete', 'not-started'] as const)(
  'inspects an expired started evaluation exactly once when physical status is %s', async status => {
    const root = mkdtempSync(join(tmpdir(), `gepa-expired-${status}-`)); roots.push(root)
    const fixture = fixtures(4)
    const { plan, result } = evaluatedFixture(fixture.seed,
      scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
    const artifacts = new FileArtifactStore(join(root, 'artifacts'))
    const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
      harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
    } })
    const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
      manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
    const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
    const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
      plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
    const operationId = digestJson(['expired-status', status, root]).slice(7)
    const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
      operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
      implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
      limits: { rolloutCells: 1, repairCells: 0 } }
    let physicalCalls = 0, inspectCalls = 0, phase: 'initial' | 'expired' = 'initial'
    fixture.provider.evaluate = async () => { physicalCalls++; throw new Error('initial physical response lost') }
    fixture.provider.inspectEvaluation = async () => {
      inspectCalls++
      if (phase === 'initial') return { status: 'running', handle: 'original-worker' }
      if (status === 'running') return { status: 'running', handle: 'original-worker' }
      if (status === 'partially-complete') return { status, cells: result.cells }
      if (status === 'complete') return { status, result: { cells: result.cells } }
      return { status: 'not-started' }
    }
    const first = provider.beginLegacyInvocation({ callerSignal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000 })
    expect((await provider.submit(envelope)).status).toBe('running')
    first()
    phase = 'expired'
    inspectCalls = 0
    const expired = provider.beginLegacyInvocation({ callerSignal: new AbortController().signal,
      deadlineAt: Date.now() - 1 })
    try {
      await provider.inspect(envelope)
      const pending = await provider.legacyPending(envelope)
      if (status === 'complete') expect(pending).toBeNull()
      else if (status === 'partially-complete') expect(pending).toEqual({ state: status,
        reason: 'completed evaluation cells are saved; remaining batches have not started' })
      else expect(pending).toEqual({ state: status,
        ...(status === 'running' ? { handle: 'original-worker' } : {}),
        reason: 'deadline reached while external execution was unresolved' })
      const submission = await provider.submit(envelope)
      expect(submission.status).toBe(status === 'running' ? 'running' : 'completed')
      expect(physicalCalls).toBe(1)
      expect(inspectCalls).toBe(1)
      if (status === 'partially-complete') {
        if (submission.status !== 'completed' || submission.completion.outcome.kind !== 'result')
          throw new Error('partial timeout was not sealed')
        const resultRef = (submission.completion.outcome.value as { resultRef: Parameters<FileArtifactStore['getJson']>[0] }).resultRef
        expect(artifacts.getJson(resultRef)).toMatchObject({ cells: result.cells,
          failure: { kind: 'budget-exhausted', code: 'time' } })
      }
    } finally { expired() }
  })

it('uses one terminal inspection failure without reinspecting or rerunning the original evaluation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-terminal-inspection-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
  const operationId = digestJson(['terminal-inspection', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: 1, repairCells: 0 } }
  let physicalCalls = 0, inspectCalls = 0, terminal = false
  fixture.provider.evaluate = async () => { physicalCalls++; throw new Error('evaluation response lost') }
  fixture.provider.inspectEvaluation = async () => {
    inspectCalls++
    if (terminal) throw new SearchExecutionFailure('worker-exited', 'worker exited', 'worker:failure-17')
    return { status: 'running', handle: 'worker-17' }
  }
  const first = provider.beginLegacyInvocation()
  expect((await provider.submit(envelope)).status).toBe('running')
  first()
  terminal = true; inspectCalls = 0
  const resumed = provider.beginLegacyInvocation({ callerSignal: new AbortController().signal,
    deadlineAt: Date.now() - 1 })
  try {
    await provider.inspect(envelope)
    const submission = await provider.submit(envelope)
    expect(submission.status).toBe('completed')
    if (submission.status !== 'completed') throw new Error('terminal result missing')
    expect(submission.completion.outcome.kind).toBe('result')
    expect(physicalCalls).toBe(1)
    expect(inspectCalls).toBe(1)
  } finally { resumed() }
})

it.each([
  ['undefined response', undefined],
  ['unknown status', { status: 'bogus' }],
  ['empty running handle', { status: 'running', handle: '' }],
  ['empty partial cells', { status: 'partially-complete', cells: [] }],
] as const)('rejects an invalid %s from physical evaluation inspection', async (_label, observed) => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-invalid-inspection-')); roots.push(root)
  const fixture = fixtures(4)
  const { plan } = evaluatedFixture(fixture.seed,
    scopeFixture(fixture.seed, ['task-0']), fixture.anchor, () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const provider = new GepaEvaluationProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const input = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, universe: fixture.seed,
    plan, snapshot: fixture.anchor, processMode: 'off' } as unknown as JsonValue
  const operationId = digestJson(['invalid-inspection', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'evaluate',
    operationId, idempotencyKey: operationId, kind: 'gepa.evaluate', input, inputDigest: jsonDigest(input),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }),
    limits: { rolloutCells: 1, repairCells: 0 } }
  fixture.provider.evaluate = async () => { throw new Error('physical response lost') }
  fixture.provider.inspectEvaluation = async () => observed as never
  const dispose = provider.beginLegacyInvocation()
  try {
    await expect(provider.submit(envelope)).rejects.toMatchObject({ name: 'ProviderProtocolError',
      cause: { name: 'SearchProtocolError' } })
  } finally { dispose() }
})

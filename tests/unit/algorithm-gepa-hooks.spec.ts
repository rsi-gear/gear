import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { CallId, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import type { CompletionEnvelope, OperationEnvelope, ProviderInspection, ProviderManifest, ProviderSubmission } from '../../src/algorithm/contracts.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { VerifiedExecutionAdapter, type ExecutionReceipt, type ExecutionResult, type PhysicalExecutionPort } from '../../src/algorithm/providers/execution.js'
import { createPhysicalGepaHooks, GepaPhysicalExecutionError } from '../../src/algorithm/providers/gepa-hooks.js'
import { GepaGenerationProvider } from '../../src/algorithm/providers/gepa-operations.js'
import { createWorkspaceEditAdapter, WorkspaceEditSessionRegistry } from '../../src/algorithm/providers/workspace-edit.js'
import { createWorkspaceEditDshHost } from '../../src/algorithm/providers/workspace-edit-host.js'
import { HarnessBuilder } from '../../src/harness/builder.js'
import { seal } from '../../src/search/contracts.js'
import { deliveredWorkplan } from '../../src/search/diagnosis.js'
import type { SearchExecutionHooks } from '../../src/search/runtime.js'
import { evaluatedFixture, scopeFixture, universe } from '../../src/search/testing.js'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { SkillCandidateFiles } from '../../src/skill/files.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { metaAgent } from '../helpers/research-fixture.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

async function setup(report: { workplanRead: boolean; accessedRefs: string[] }, nullHarness = false) {
  const fixture = await createGitHarnessFixture()
  cleanup.push(() => rm(fixture.root, { force: true, recursive: true }))
  const root = await mkdtemp(join(tmpdir(), 'gear-gepa-physical-'))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'gepa-physical.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } })
  const builder = new HarnessBuilder({ repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
    dshBaseRef: fixture.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: { compile: async () => undefined } })
  await builder.initialize()
  const parent = await builder.searchSnapshot('parent', fixture.championRef)
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness',
    commitOid: fixture.championRef, manifestDigest: fixture.manifest.digest }, 'harness.directory.v1')
  const bindingSetRef = bindings.create({ harness })
  const workplan = seal({ candidateId: 'candidate', parentSnapshotDigest: parent.digest,
    requiredDiagnosisRefs: ['evidence-ref'], generationBudget: { maxTokens: 200, maxModelRequests: 2,
      deadlineAt: Date.now() + 60_000 } })
  const delivery = seal({ workplan, dossier: seal({ sourceDossierDigest: sha256('dossier') }), findings: [] })
  const rawInput = { delivery, parent, baseline: { snapshotDigest: parent.digest, cells: [{ evidenceRef: 'evidence-ref' }] },
    baselineContext: {}, idempotencyKey: sha256('gepa-physical-operation'), signal: new AbortController().signal }
  const input = rawInput as unknown as Parameters<SearchExecutionHooks['generate']>[0]
  class FakeEditPort implements PhysicalExecutionPort {
    readonly manifest: ProviderManifest & { kind: 'execution.workspace-edit'; structuredResultSchema: { type: 'object' } } = {
      kind: 'execution.workspace-edit', implementationDigest: sha256('fake-physical-edit'),
      execution: 'external', supportsInspect: true, meteredDimensions: ['model.requests', 'model.tokens'],
      hardLimitDimensions: ['model.requests'], inputSchema: { type: 'object', additionalProperties: true },
      outputSchema: { type: 'object', additionalProperties: true }, structuredResultSchema: { type: 'object' } }
    calls = 0
    private completion?: CompletionEnvelope
    describe() { return structuredClone(this.manifest) }
    async preflight(_envelope: OperationEnvelope) { }
    async submit(envelope: OperationEnvelope): Promise<ProviderSubmission> {
      this.calls++
      const structuredResult = { schemaVersion: 1, sessionId: 'physical-session', changedPaths: ['plugins/context.ts'],
        workplanRead: report.workplanRead, accessedRefs: report.accessedRefs,
        commitOid: fixture.championRef, manifestDigest: fixture.manifest.digest }
      const producedArtifactRef = artifacts.putJson(nullHarness ? null : { schemaVersion: 1, kind: 'git-harness',
        commitOid: fixture.championRef, manifestDigest: fixture.manifest.digest }, 'harness.directory.v1')
      const structuredResultRef = artifacts.putJson(structuredResult, 'execution.workspace-edit.result.v1')
      const evidenceRef = artifacts.putJson({ sessionId: 'physical-session' }, 'execution.workspace-edit.evidence.v1')
      const executionReceipt: ExecutionReceipt = { schemaVersion: 1,
        providerImplementationDigest: this.manifest.implementationDigest, operationId: envelope.operationId,
        inputDigest: envelope.inputDigest, loadedBindingSetDigest: envelope.bindingSetRef.digest,
        evidenceDigest: evidenceRef.digest, actualBindings: { harness: harness.digest },
        executionIdentity: sha256('physical-session'), structuredResultDigest: jsonDigest(structuredResult),
        bindingUse: 'executed' }
      const receiptRef = artifacts.putJson(executionReceipt as unknown as JsonValue, 'execution.receipt.v1')
      const validationReceiptRef = artifacts.putJson({ valid: true, producedDigest: producedArtifactRef.digest },
        'execution.workspace-edit.validation.v1')
      const value: ExecutionResult = { requestedBindingSetDigest: envelope.bindingSetRef.digest,
        actualBindings: { harness }, evidenceRef, receiptRef, producedArtifactRef,
        structuredResult, structuredResultRef, validationReceiptRef }
      this.completion = { operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
        inputDigest: envelope.inputDigest, implementationDigest: this.manifest.implementationDigest,
        outcome: { kind: 'result', value: value as unknown as JsonValue }, receipt: {
          source: 'workspace-edit', scope: 'operation', operationId: envelope.operationId,
          cursor: sha256('usage'), cumulative: { 'model.requests': 1, 'model.tokens': 41 } } }
      return { status: 'completed', completion: this.completion }
    }
    async inspect(_envelope: OperationEnvelope): Promise<ProviderInspection> {
      return this.completion ? { status: 'completed', completion: this.completion } : { status: 'not-started' }
    }
    async cancel(_envelope: OperationEnvelope): Promise<ProviderInspection> { return { status: 'unknown' } }
    async collect(_envelope: OperationEnvelope): Promise<CompletionEnvelope> {
      if (!this.completion) throw new Error('result absent')
      return this.completion
    }
  }
  const port = new FakeEditPort()
  const editor = new VerifiedExecutionAdapter(port, artifacts, bindings, ['harness'])
  const options = { root: join(root, 'gepa-hook'), artifacts, bindings, builder, editor,
    campaignId: 'physical-gepa', roleId: 'gepa.editor',
    snapshotBindings: { [parent.digest]: bindingSetRef }, expectedMeterSource: 'workspace-edit',
    hostIdentityDigest: sha256('physical-host') }
  return { input, options, port }
}

describe('operation-owned physical GEPA generation', () => {
  it('settles an expired workplan before touching the editor with explicit zero usage', async () => {
    const f = await setup({ workplanRead: true, accessedRefs: ['evidence-ref'] })
    const { digest: ignoredPlanDigest, ...planBody } = f.input.delivery.workplan
    const workplan = seal({ ...planBody, generationBudget: { ...planBody.generationBudget,
      deadlineAt: Date.now() - 1 } })
    const { digest: ignoredDeliveryDigest, ...deliveryBody } = f.input.delivery
    const input = { ...f.input, delivery: seal({ ...deliveryBody, workplan }) }
    const result = await createPhysicalGepaHooks(f.options).generate(input)
    expect(result).toMatchObject({ reason: 'generation-budget-unbounded-or-exhausted',
      usage: { requests: 0, tokens: 0 } })
    expect(f.port.calls).toBe(0)
  })

  it('reports not-started when the bridge journal is absent before any editor effect', async () => {
    const f = await setup({ workplanRead: true, accessedRefs: ['evidence-ref'] })
    expect(await createPhysicalGepaHooks(f.options).inspectGenerationOutcome(f.input.idempotencyKey))
      .toEqual({ status: 'not-started' })
    expect(f.port.calls).toBe(0)
  })

  it('recovers a bridge intent after confirmed not-started inner dispatch using the original key', async () => {
    const f = await setup({ workplanRead: true, accessedRefs: ['evidence-ref'] })
    const submit = f.options.editor.submit.bind(f.options.editor)
    vi.spyOn(f.options.editor, 'submit').mockRejectedValueOnce(new Error('bridge process stopped before dispatch'))
      .mockImplementation(submit)
    await expect(createPhysicalGepaHooks(f.options).generate(f.input)).rejects.toThrow(/before dispatch/)
    expect(f.port.calls).toBe(0)
    const restarted = createPhysicalGepaHooks(f.options)
    expect(await restarted.inspectGenerationOutcome(f.input.idempotencyKey)).toEqual({ status: 'not-started' })
    const observed = await restarted.generate(f.input)
    expect(observed.snapshot).toBeDefined()
    expect(f.port.calls).toBe(1)
  })

  it('does not launch an editor if the frozen deadline expires after bridge intent but before dispatch', async () => {
    const f = await setup({ workplanRead: true, accessedRefs: ['evidence-ref'] })
    vi.spyOn(f.options.editor, 'submit').mockRejectedValueOnce(new Error('bridge process stopped before dispatch'))
    await expect(createPhysicalGepaHooks(f.options).generate(f.input)).rejects.toThrow(/before dispatch/)
    expect(f.port.calls).toBe(0)
    const later = f.input.delivery.workplan.generationBudget.deadlineAt + 1
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      const restarted = createPhysicalGepaHooks(f.options)
      expect(await restarted.inspectGenerationOutcome(f.input.idempotencyKey)).toEqual({ status: 'not-started' })
      expect(await restarted.generate(f.input)).toMatchObject({
        reason: 'generation-budget-unbounded-or-exhausted', usage: { tokens: 0, requests: 0 } })
      expect(f.port.calls).toBe(0)
    } finally { clock.mockRestore() }
  })

  it('waits on an uncertain inner inspection without resubmitting or inventing zero usage', async () => {
    const f = await setup({ workplanRead: true, accessedRefs: ['evidence-ref'] })
    vi.spyOn(f.options.editor, 'submit').mockRejectedValueOnce(new Error('dispatch response lost'))
    await expect(createPhysicalGepaHooks(f.options).generate(f.input)).rejects.toThrow(/response lost/)
    vi.spyOn(f.options.editor, 'inspect').mockResolvedValue({ status: 'unknown' })
    expect(await createPhysicalGepaHooks(f.options).inspectGenerationOutcome(f.input.idempotencyKey))
      .toEqual({ status: 'unknown' })
    expect(f.port.calls).toBe(0)
  })

  it.each([
    { workplanRead: false, accessedRefs: ['evidence-ref'], code: 'gepa_candidate_proof_invalid' },
    { workplanRead: true, accessedRefs: [], code: 'gepa_consumption_proof_invalid' },
  ])('seals a deterministic $code with actual usage and does not resubmit after restart', async ({ workplanRead, accessedRefs, code }) => {
    const f = await setup({ workplanRead, accessedRefs })
    const hooks = createPhysicalGepaHooks(f.options)
    await expect(hooks.generate(f.input)).rejects.toMatchObject({ name: 'GepaPhysicalExecutionError',
      code, usage: { tokens: 41, requests: 1 } } satisfies Partial<GepaPhysicalExecutionError>)
    const restarted = createPhysicalGepaHooks(f.options)
    expect(await restarted.inspectGenerationOutcome(f.input.idempotencyKey)).toEqual({ status: 'error',
      code, usage: { tokens: 41, requests: 1 },
      message: expect.any(String) })
    expect(f.port.calls).toBe(1)
  })

  it('seals a malformed produced artifact as a measured proof error, not an unknown operation', async () => {
    const f = await setup({ workplanRead: true, accessedRefs: ['evidence-ref'] }, true)
    const hooks = createPhysicalGepaHooks(f.options)
    await expect(hooks.generate(f.input)).rejects.toMatchObject({ name: 'GepaPhysicalExecutionError',
      code: 'gepa_candidate_proof_invalid', usage: { requests: 1, tokens: 41 } })
    expect(await createPhysicalGepaHooks(f.options).inspectGenerationOutcome(f.input.idempotencyKey))
      .toMatchObject({ status: 'error', code: 'gepa_candidate_proof_invalid' })
    expect(f.port.calls).toBe(1)
  })

  it('runs real DSH evidence tools and Git edit, then settles one outer GEPA receipt across restart', async () => {
    const fixture = await createGitHarnessFixture()
    cleanup.push(() => rm(fixture.root, { force: true, recursive: true }))
    const root = await mkdtemp(join(tmpdir(), 'gear-gepa-dsh-'))
    cleanup.push(() => rm(root, { force: true, recursive: true }))
    const ctx = new Context()
    new AgentRegistry(ctx); new SessionStore(ctx)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new ToolRuntime(ctx); new LlmRuntime(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    cleanup.push(() => ctx.fiber.dispose())
    ctx.on('session/flush', async () => {})
    ctx.provide('agentPresets', { mount: async () => {} } as never)
    const artifacts = new FileArtifactStore(join(root, 'artifacts'))
    const bindings = new BindingStore(artifacts, { id: 'gepa-real-harness.v1', slots: {
      harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } })
    const builder = new HarnessBuilder({ repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
      dshBaseRef: fixture.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
      compiler: { compile: async () => undefined } })
    const manager = new CandidateWorkspaceManager({ repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
      rootForEvolution: id => join(root, 'workspaces', id), maxFiles: 3, maxBytes: 50_000, maxDiffBytes: 50_000 })
    await builder.initialize(); await manager.initialize()
    const parent = await builder.searchSnapshot('parent', fixture.championRef)
    const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness',
      commitOid: fixture.championRef, manifestDigest: fixture.manifest.digest }, 'harness.directory.v1')
    const bindingSetRef = bindings.create({ harness })
    const seed = universe(4), scope = scopeFixture(seed, ['task-0'])
    const baselineRow = evaluatedFixture(seed, scope, parent, () => ({ outcome: 0 }))
    const evidenceRef = baselineRow.result.cells[0]!.evidenceRef
    const dossier = seal({ parentSnapshotDigest: parent.digest, universeDigest: seed.digest,
      taskIds: ['task-0'], baselineEvidenceDigests: [evidenceRef], facts: [{ taskId: 'task-0',
        evidenceRefs: [evidenceRef], status: 'supported-hypothesis' as const, familyId: 'family',
        hypothesis: 'Repair context value', modificationPaths: ['plugins/context.ts'] }],
      classifierIntegrity: sha256('classifier'), sanitizationPolicyDigest: sha256('sanitization') })
    const workplan = seal({ candidateId: 'candidate', batchId: 'batch', parentSnapshotDigest: parent.digest,
      dossierDigest: dossier.digest, clusterDigest: sha256('cluster'), familyId: 'family',
      hypothesis: 'Repair context value', targetTaskIds: ['task-0'], requiredDiagnosisRefs: [evidenceRef],
      modificationPaths: ['plugins/context.ts'], scopeDigest: scope.digest,
      localStagePlanDigest: baselineRow.plan.digest,
      modificationBoundaryRule: { requiredSeedTaskIds: ['task-0'], onInsufficientScope: 'retain-research-only' as const },
      generationBudget: { maxTokens: 600, maxModelRequests: 5, deadlineAt: Date.now() + 15_000 } })
    let requests = 0
    class ToolEditor extends LlmAdapter {
      async *stream(_request: GenerateOptions): AsyncGenerator<StreamChunk> {
        requests++
        const names = ['workplan_read', 'diagnosis_read', 'workspace_read', 'workspace_edit']
        const step = (requests - 1) % 5
        if (step < names.length) {
          const name = names[step]!
          const args = name === 'diagnosis_read' ? { ref: evidenceRef }
            : name === 'workspace_read' ? { path: 'plugins/context.ts' }
            : name === 'workspace_edit' ? { path: 'plugins/context.ts', oldString: 'value = 1',
              newString: 'value = 2', expectedDigest: `sha256:${sha256('export const value = 1\n')}` } : {}
          const id = CallId(`gepa-${requests}`)
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'text-delta', index: 0, text: 'Completed the assigned Git edit.' }
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    ctx.llm.registerAdapter(['p'], new ToolEditor())
    const sessions = new WorkspaceEditSessionRegistry(join(root, 'access'))
    const files = new SkillCandidateFiles(manager, { maxReadBytes: 50_000 })
    const host = createWorkspaceEditDshHost(ctx, sessions, files, manager, builder)
    vi.spyOn(host.offloading, 'pressure').mockResolvedValue({ tokens: 10, fixedTokens: 5, basis: 'offline-fixture' })
    const editor = createWorkspaceEditAdapter({ root: join(root, 'editor'), host, sessions, artifacts, bindings,
      builder, workspaceManager: manager, roles: [{ id: 'gepa.editor', spec: metaAgent(),
        instruction: 'Read the assigned workplan and diagnosis, then edit the bound file.',
        maxModelRequests: 5, maxTokens: 600, timeoutMs: 60_000 },
      { id: 'gepa.invalid', spec: metaAgent(), instruction: 'Return validated scientific JSON.',
        maxModelRequests: 5, maxTokens: 600, timeoutMs: 60_000,
        resultSchema: { type: 'object', required: ['predictedFixes'], properties: {
          predictedFixes: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } }],
      hostRuntimeDigest: sha256('real-gepa-host'), currentHostRuntimeDigest: () => sha256('real-gepa-host'),
      accessPolicyDigest: sha256('real-gepa-policy'), requiredSlots: ['harness'], authorize: () => {},
      campaignBudget: { 'model.requests': { unit: 'requests', source: 'workspace-edit', capability: 'hard', limit: 5 },
        'model.tokens': { unit: 'tokens', source: 'workspace-edit', capability: 'stop', limit: 600 } } })
    const hookOptions = { root: join(root, 'hook'), artifacts, bindings, builder, editor, campaignId: 'gepa-campaign',
      roleId: 'gepa.editor', snapshotBindings: { [parent.digest]: bindingSetRef },
      expectedMeterSource: 'workspace-edit', hostIdentityDigest: sha256('real-gepa-host') }
    const hooks = createPhysicalGepaHooks(hookOptions)
    const outerRoot = join(root, 'outer')
    const provider = new GepaGenerationProvider(outerRoot, artifacts, bindings, hooks, hooks.implementationDigest)
    const input = { workplan, dossier, scope, parent, plan: baselineRow.plan,
      baseline: baselineRow.result, universe: seed, findings: [], processMode: 'off' }
    const operationId = sha256('real-gepa-operation')
    const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId, campaignId: 'gepa-campaign',
      decisionIndex: 0, localKey: 'generate', kind: 'gepa.generate', input: input as unknown as JsonValue,
      inputDigest: jsonDigest(input), implementationDigest: provider.describe().implementationDigest,
      bindingSetRef, limits: { generationTokens: 600, generationRequests: 5 } }
    const first = await provider.submit(envelope)
    expect(first.status).toBe('completed')
    if (first.status !== 'completed' || first.completion.outcome.kind !== 'result') throw new Error('GEPA candidate missing')
    expect(first.completion.receipt?.cumulative).toEqual({ generationTokens: 200, generationRequests: 5 })
    const generated = first.completion.outcome.value as unknown as { generatedRef: Parameters<FileArtifactStore['getJson']>[0] }
    const physical = artifacts.getJson(generated.generatedRef) as { snapshot: { commit: string }; receipt: { accessedRefs: string[] } }
    expect((await builder.readHarnessFile(physical.snapshot.commit, 'plugins/context.ts')).content)
      .toBe('export const value = 2\n')
    expect(physical.receipt.accessedRefs).toEqual([evidenceRef])
    expect(requests).toBe(5)
    const editorRecord = JSON.parse(await readFile(join(root, 'editor', 'operations', `${operationId}.json`), 'utf8'))
    expect(editorRecord.status).toBe('completed')
    const generation = JSON.parse(await readFile(join(root, 'editor', 'generation', 'meta-context',
      'executions', `${operationId}.json`), 'utf8'))
    expect(generation.deadlineAt).toBeLessThanOrEqual(workplan.generationBudget.deadlineAt)
    const restartedHooks = createPhysicalGepaHooks(hookOptions)
    const restarted = new GepaGenerationProvider(outerRoot, artifacts, bindings,
      restartedHooks, restartedHooks.implementationDigest)
    expect(await restarted.inspect(envelope)).toMatchObject({ status: 'completed', completion: {
      receipt: { cumulative: { generationTokens: 200, generationRequests: 5 } } } })
    const delivered = deliveredWorkplan(workplan, dossier, [], scope)
    const reused = await restartedHooks.generate({ delivery: delivered, parent, baseline: baselineRow.result,
      baselineContext: { universe: seed, plan: baselineRow.plan, scope, processMode: 'off' },
      idempotencyKey: operationId, signal: new AbortController().signal })
    expect(reused.snapshot?.commit).toBe(physical.snapshot.commit)
    expect(requests).toBe(5)

    const failingHooks = createPhysicalGepaHooks({ ...hookOptions,
      root: join(root, 'hook-invalid'), roleId: 'gepa.invalid' })
    const failingRoot = join(root, 'outer-invalid')
    const failingProvider = new GepaGenerationProvider(failingRoot, artifacts, bindings,
      failingHooks, failingHooks.implementationDigest)
    const failureId = sha256('real-gepa-invalid-scientific-result')
    const failureEnvelope: OperationEnvelope = { ...envelope, operationId: failureId,
      idempotencyKey: failureId, localKey: 'invalid-generate',
      implementationDigest: failingProvider.describe().implementationDigest }
    expect(await failingProvider.submit(failureEnvelope)).toMatchObject({ status: 'completed', completion: {
      outcome: { kind: 'error', code: 'workspace_edit_invalid_scientific_result' },
      receipt: { cumulative: { generationTokens: 200, generationRequests: 5 } } } })
    const recoveredFailure = new GepaGenerationProvider(failingRoot, artifacts, bindings,
      createPhysicalGepaHooks({ ...hookOptions, root: join(root, 'hook-invalid'), roleId: 'gepa.invalid' }),
      failingHooks.implementationDigest)
    expect(await recoveredFailure.inspect(failureEnvelope)).toMatchObject({ status: 'completed', completion: {
      outcome: { kind: 'error', code: 'workspace_edit_invalid_scientific_result' },
      receipt: { cumulative: { generationTokens: 200, generationRequests: 5 } } } })
    expect(requests).toBe(10)

    const cancellingHooks = createPhysicalGepaHooks({ ...hookOptions, root: join(root, 'hook-cancel') })
    const cancellingProvider = new GepaGenerationProvider(join(root, 'outer-cancel'), artifacts, bindings,
      cancellingHooks, cancellingHooks.implementationDigest)
    const cancellationId = sha256('real-gepa-cancel-before-editor')
    const cancellationEnvelope: OperationEnvelope = { ...envelope, operationId: cancellationId,
      idempotencyKey: cancellationId, localKey: 'cancel-generate',
      implementationDigest: cancellingProvider.describe().implementationDigest }
    const submitEditor = vi.spyOn(editor, 'submit').mockRejectedValueOnce(new Error('dispatch response lost'))
    expect((await cancellingProvider.submit(cancellationEnvelope)).status).toBe('running')
    expect(requests).toBe(10)
    expect((await cancellingProvider.inspect(cancellationEnvelope)).status).toBe('not-started')
    expect(submitEditor).toHaveBeenCalledTimes(1)
    expect(await cancellingProvider.cancel(cancellationEnvelope)).toMatchObject({ status: 'completed', completion: {
      outcome: { kind: 'error', code: 'workspace_edit_cancelled' },
      receipt: { cumulative: { generationTokens: 0, generationRequests: 0 } } } })
    expect((await cancellingProvider.submit(cancellationEnvelope)).status).toBe('completed')
    expect(requests).toBe(10)
    expect(submitEditor).toHaveBeenCalledTimes(1)

    const noBridgeHooks = createPhysicalGepaHooks({ ...hookOptions, root: join(root, 'hook-not-started') })
    const noBridgeRoot = join(root, 'outer-not-started')
    const noBridgeProvider = new GepaGenerationProvider(noBridgeRoot, artifacts, bindings,
      noBridgeHooks, noBridgeHooks.implementationDigest)
    const noBridgeId = sha256('real-gepa-outer-intent-before-bridge')
    const noBridgeEnvelope: OperationEnvelope = { ...envelope, operationId: noBridgeId,
      idempotencyKey: noBridgeId, localKey: 'recover-before-bridge',
      implementationDigest: noBridgeProvider.describe().implementationDigest }
    const actualGenerate = noBridgeHooks.generate.bind(noBridgeHooks)
    vi.spyOn(noBridgeHooks, 'generate').mockRejectedValueOnce(new Error('process stopped before bridge intent'))
      .mockImplementation(actualGenerate)
    expect((await noBridgeProvider.submit(noBridgeEnvelope)).status).toBe('running')
    expect((await noBridgeProvider.inspect(noBridgeEnvelope)).status).toBe('not-started')
    expect(requests).toBe(10)
    expect((await noBridgeProvider.submit(noBridgeEnvelope)).status).toBe('completed')
    expect(requests).toBe(15)
  })
})

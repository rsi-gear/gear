import { mkdtemp, rm } from 'node:fs/promises'
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
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { jsonDigest } from '../../src/algorithm/schema.js'
import { createWorkspaceEditAdapter, WorkspaceEditSessionRegistry } from '../../src/algorithm/providers/workspace-edit.js'
import { createWorkspaceEditDshHost } from '../../src/algorithm/providers/workspace-edit-host.js'
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js'
import { SkillCandidateFiles } from '../../src/skill/files.js'
import { HarnessBuilder } from '../../src/harness/builder.js'
import { CompilerCheckError, uncheckedRuntime } from '../../src/harness/check-report.js'
import { createGitHarnessFixture } from '../helpers/git-fixture.js'
import { metaAgent } from '../helpers/research-fixture.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(edit = true, loseFinalize = false, science: boolean | 'invalid' = false,
  hangAtCall?: number) {
  const fixture = await createGitHarnessFixture()
  cleanups.push(() => rm(fixture.root, { recursive: true, force: true }))
  const root = await mkdtemp(join(tmpdir(), 'gear-workspace-edit-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx); new LlmRuntime(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  cleanups.push(() => ctx.fiber.dispose())
  ctx.on('session/flush', async () => {})
  ctx.provide('agentPresets', { mount: async () => {} } as never)
  let calls = 0
  class Adapter extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls++
      if (calls === hangAtCall) {
        await new Promise<void>(resolve => {
          if (request.signal?.aborted) resolve()
          else request.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return
      }
      if (edit && calls <= 2) {
        const name = calls === 1 ? 'workspace_read' : 'workspace_edit'
        const args = calls === 1 ? { path: 'plugins/context.ts' }
          : { path: 'plugins/context.ts', oldString: 'value = 1', newString: 'value = 2',
            expectedDigest: `sha256:${sha256('export const value = 1\n')}` }
        const id = CallId(`edit-${calls}`)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: JSON.stringify(args) }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } }
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: science === 'invalid' ? '{broken-json'
          : science ? JSON.stringify({ predictedFixes: ['task-a'], riskTasks: ['task-b'] }) : 'Edited the plugin.' }
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['p'], new Adapter())
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'workspace-edit-fixture.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } })
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: fixture.championRef,
    manifestDigest: fixture.manifest.digest }, 'harness.directory.v1')
  const bindingSetRef = bindings.create({ harness })
  const builder = new HarnessBuilder({ repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
    dshBaseRef: fixture.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: { compile: async () => undefined } })
  const manager = new CandidateWorkspaceManager({ repositoryPath: fixture.repository, targetRoot: fixture.targetRoot,
    rootForEvolution: id => join(root, 'workspaces', id), maxFiles: 3, maxBytes: 50_000, maxDiffBytes: 50_000 })
  await builder.initialize(); await manager.initialize()
  if (loseFinalize) {
    const actual = builder.finalizeWorkspace.bind(builder)
    builder.finalizeWorkspace = async (...args) => { await actual(...args); throw new Error('lost finalization response') }
  }
  const sessions = new WorkspaceEditSessionRegistry(join(root, 'access'))
  const host = createWorkspaceEditDshHost(ctx, sessions,
    new SkillCandidateFiles(manager, { maxReadBytes: 50_000 }), manager, builder)
  vi.spyOn(host.offloading, 'pressure').mockResolvedValue({ tokens: 10, fixedTokens: 5, basis: 'offline-fixture' })
  const portOptions = { root: join(root, 'port'), host, sessions, artifacts, bindings, builder, workspaceManager: manager,
    roles: [{ id: 'rho.optimizer', spec: metaAgent(), instruction: 'Edit the bound plugin.',
      maxModelRequests: 3, maxTokens: 500, timeoutMs: 20_000,
      ...(science ? { resultSchema: { type: 'object' as const,
        required: ['predictedFixes', 'riskTasks'], properties: {
          predictedFixes: { type: 'array' as const, items: { type: 'string' as const } },
          riskTasks: { type: 'array' as const, items: { type: 'string' as const } },
        }, additionalProperties: false } } : {}) }],
    hostRuntimeDigest: sha256('offline-workspace-host'), currentHostRuntimeDigest: () => sha256('offline-workspace-host'),
    accessPolicyDigest: sha256('workspace-policy'), campaignBudget: {
      'model.requests': { unit: 'requests', source: 'workspace-edit', capability: 'hard' as const, limit: 5 },
      'model.tokens': { unit: 'tokens', source: 'workspace-edit', capability: 'stop' as const, limit: 1000 } },
    requiredSlots: ['harness'], authorize: (roleId: string) => { if (roleId !== 'rho.optimizer') throw new Error('role denied') } }
  const adapter = createWorkspaceEditAdapter(portOptions)
  const input = { roleId: 'rho.optimizer', baseBindingSetRef: bindingSetRef }
  const operationId = sha256('offline-workspace-operation')
  const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId, campaignId: 'offline-editor',
    decisionIndex: 0, localKey: 'edit', kind: 'execution.workspace-edit', input,
    inputDigest: jsonDigest(input), implementationDigest: adapter.describe().implementationDigest,
    bindingSetRef, limits: { 'model.requests': 3, 'model.tokens': 500 } }
  return { root, fixture, artifacts, bindings, builder, manager, adapter, envelope, portOptions, modelCalls: () => calls }
}

async function manualRevision(f: Awaited<ReturnType<typeof setup>>, parent: { commitOid: string; manifestDigest: string },
  update: (files: SkillCandidateFiles, sessionId: string) => Promise<void>) {
  const handle = await f.manager.create({ evolutionId: 'manualrevision', roundId: 'test',
    parentHarnessRef: parent.commitOid, parentHarnessDigest: parent.manifestDigest }, new AbortController().signal)
  const sessionId = `manual-${handle.workspaceId}`
  f.manager.bind(handle.workspaceId, sessionId)
  const files = new SkillCandidateFiles(f.manager, { maxReadBytes: 50_000 })
  await update(files, sessionId)
  await f.builder.checkWorkspace(handle, new AbortController().signal)
  const summary = await f.manager.seal(handle.workspaceId)
  f.manager.markFinalizing(handle.workspaceId)
  await f.manager.verifySealed(handle.workspaceId, summary)
  const prepared = await f.builder.finalizeWorkspace(handle, summary, new AbortController().signal)
  await f.manager.markCommitted(handle.workspaceId)
  await f.manager.dispose(handle.workspaceId)
  return { commitOid: prepared.ref, manifestDigest: prepared.digest }
}

describe('physical DSH workspace edit operation', () => {
  it('edits a real isolated Git worktree, checks and seals the harness with measured model usage', async () => {
    const f = await setup()
    const first = await f.adapter.submit(f.envelope)
    expect(first.status).toBe('completed')
    if (first.status !== 'completed' || first.completion.outcome.kind !== 'result') throw new Error('editor result missing')
    const value = first.completion.outcome.value as unknown as { producedArtifactRef: Parameters<FileArtifactStore['getJson']>[0];
      structuredResult: { changedPaths: string[] }; validationReceiptRef: Parameters<FileArtifactStore['getJson']>[0] }
    const produced = f.artifacts.getJson(value.producedArtifactRef) as { commitOid: string }
    expect(produced.commitOid).not.toBe(f.fixture.championRef)
    expect((await f.builder.readHarnessFile(produced.commitOid, 'plugins/context.ts')).content).toBe('export const value = 2\n')
    expect(value.structuredResult.changedPaths).toEqual(['plugins/context.ts'])
    expect(f.artifacts.getJson(value.validationReceiptRef)).toMatchObject({ valid: true,
      producedDigest: value.producedArtifactRef.digest })
    expect(first.completion.receipt?.cumulative).toEqual({ 'model.requests': 3, 'model.tokens': 120 })
    expect((await createWorkspaceEditAdapter(f.portOptions).inspect(f.envelope)).status).toBe('completed')
    expect(f.modelCalls()).toBe(3)
  })

  it('persists prestart cancellation and rejects a delayed submit', async () => {
    const f = await setup()
    expect(await f.adapter.cancel(f.envelope)).toMatchObject({ status: 'cancelled', releaseConfirmed: true,
      receipt: { cumulative: { 'model.requests': 0, 'model.tokens': 0 } } })
    await expect(f.adapter.submit(f.envelope)).rejects.toThrow(/cancelled/)
    expect(f.modelCalls()).toBe(0)
  })

  it('does not release a started edit with unconfirmed model usage after cancellation', async () => {
    const f = await setup(true, false, false, 1)
    const submit = f.adapter.submit(f.envelope)
    for (let attempt = 0; attempt < 100 && f.modelCalls() === 0; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.modelCalls()).toBe(1)
    expect(await f.adapter.cancel(f.envelope)).toMatchObject({ status: 'unknown' })
    expect((await submit).status).toBe('running')
    expect((await f.adapter.inspect(f.envelope)).status).toBe('unknown')
    expect(f.modelCalls()).toBe(1)
  })

  it('settles a model turn with no edit as a measured no-result', async () => {
    const f = await setup(false)
    const result = await f.adapter.submit(f.envelope)
    expect(result).toMatchObject({ status: 'completed', completion: { outcome: {
      kind: 'no-result', reason: 'workspace-edit-no-change' },
      receipt: { cumulative: { 'model.requests': 1, 'model.tokens': 40 } } } })
    expect((await f.adapter.inspect(f.envelope)).status).toBe('completed')
  })

  it('settles a failed fixed compiler check without committing a bad candidate', async () => {
    const f = await setup()
    f.builder.checkWorkspace = async () => { throw new CompilerCheckError({ ok: false, status: 'failed',
      runtime: uncheckedRuntime('fixture') }) }
    const result = await f.adapter.submit(f.envelope)
    expect(result).toMatchObject({ status: 'completed', completion: { outcome: {
      kind: 'no-result', reason: 'workspace-edit-fixed-check-failed' },
      receipt: { cumulative: { 'model.requests': 3, 'model.tokens': 120 } } } })
    expect(f.modelCalls()).toBe(3)
  })

  it('seals validated model predictions separately from physical Git metadata', async () => {
    const f = await setup(true, false, true)
    const result = await f.adapter.submit(f.envelope)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed' || result.completion.outcome.kind !== 'result') throw new Error('edit missing')
    const value = result.completion.outcome.value as unknown as { structuredResult: {
      predictedFixes: string[]; riskTasks: string[]; commitOid: string; modelResultRef: Parameters<FileArtifactStore['getJson']>[0] } }
    expect(value.structuredResult.predictedFixes).toEqual(['task-a'])
    expect(f.artifacts.getJson(value.structuredResult.modelResultRef)).toEqual({
      predictedFixes: ['task-a'], riskTasks: ['task-b'] })
    expect(value.structuredResult.commitOid).not.toBe(f.fixture.championRef)
  })

  it('classifies malformed scientific JSON as a metered execution error, not a scientific no-result', async () => {
    const f = await setup(true, false, 'invalid')
    expect(await f.adapter.submit(f.envelope)).toMatchObject({ status: 'completed', completion: {
      outcome: { kind: 'error', code: 'workspace_edit_invalid_scientific_result' },
      receipt: { cumulative: { 'model.requests': 3, 'model.tokens': 120 } } } })
  })

  it('rejects a physical edit that never reads its assigned workplan with final measured usage', async () => {
    const f = await setup()
    const input = { ...f.envelope.input as Record<string, unknown>, delivery: {
      digest: sha256('delivery'), workplan: { digest: sha256('workplan'), requiredDiagnosisRefs: [],
        generationBudget: { deadlineAt: Date.now() + 20_000 } },
      dossier: { digest: sha256('dossier') }, findings: [] }, diagnosisEvidence: [] }
    const envelope = { ...f.envelope, input, inputDigest: jsonDigest(input) }
    expect(await f.adapter.submit(envelope)).toMatchObject({ status: 'completed', completion: {
      outcome: { kind: 'error', code: 'workspace_edit_workplan_not_consumed' },
      receipt: { cumulative: { 'model.requests': 3, 'model.tokens': 120 } } } })
    expect((await f.adapter.inspect(envelope)).status).toBe('completed')
    expect(f.modelCalls()).toBe(3)
  })

  it('freezes exactly one validated host projection before any workspace/model effect', async () => {
    const f = await setup()
    let projections = 0
    const adapter = createWorkspaceEditAdapter({ ...f.portOptions,
      editorContextDigest: sha256('editor projection policy'),
      editorContext: () => { projections++; return { roleId: 'rho.optimizer', task: 'bounded edit' } } })
    const envelope = { ...f.envelope, implementationDigest: adapter.describe().implementationDigest }
    expect((await adapter.submit(envelope)).status).toBe('completed')
    expect(projections).toBe(1)
    const rejected = createWorkspaceEditAdapter({ ...f.portOptions,
      editorContextDigest: sha256('oversized projection policy'),
      editorContext: () => ({ content: 'x'.repeat(20_000) }) })
    const other = { ...f.envelope, operationId: sha256('other-editor-op'),
      idempotencyKey: sha256('other-editor-op'), implementationDigest: rejected.describe().implementationDigest }
    await expect(rejected.submit(other)).rejects.toThrow(/projection exceeds prompt limit/)
    expect(f.modelCalls()).toBe(3)
  })

  it('restores exact named files from a prior sealed Git binding without another model request', async () => {
    const f = await setup()
    const edited = await f.adapter.submit(f.envelope)
    if (edited.status !== 'completed' || edited.completion.outcome.kind !== 'result') throw new Error('edit missing')
    const editedValue = edited.completion.outcome.value as unknown as {
      producedArtifactRef: Parameters<FileArtifactStore['getJson']>[0] }
    const editedHarness = f.artifacts.getJson(editedValue.producedArtifactRef) as {
      commitOid: string; manifestDigest: string }
    const currentGit = await manualRevision(f, editedHarness, async (files, sessionId) => {
      await files.write(sessionId, 'plugins/temporary.ts', 'export const temporary = true\n', null)
    })
    const current = f.bindings.create({ harness: f.artifacts.putJson({ schemaVersion: 1,
      kind: 'git-harness', ...currentGit }, 'harness.directory.v1') })
    const files = new SkillCandidateFiles(f.portOptions.workspaceManager, { maxReadBytes: 50_000 })
    const restore = createWorkspaceEditAdapter({ ...f.portOptions, root: join(f.root, 'restore-port'), files,
      roles: [{ id: 'ahe.rollback', spec: metaAgent(), instruction: 'Restore measured predecessor files.',
        maxModelRequests: 1, maxTokens: 100, timeoutMs: 20_000,
        restore: { sourceBindingField: 'restoreFromBindingSetRef', filesField: 'files' } }],
      authorize: (roleId: string) => { if (roleId !== 'ahe.rollback') throw new Error('restore role denied') } })
    const input = { roleId: 'ahe.rollback', baseBindingSetRef: current,
      restoreFromBindingSetRef: f.envelope.bindingSetRef, files: ['plugins/context.ts', 'plugins/temporary.ts'] }
    const operationId = sha256('offline-restore-operation')
    const envelope: OperationEnvelope = { ...f.envelope, operationId, idempotencyKey: operationId,
      localKey: 'rollback', input, inputDigest: jsonDigest(input),
      implementationDigest: restore.describe().implementationDigest, bindingSetRef: current,
      limits: { 'model.requests': 0, 'model.tokens': 0 } }
    const result = await restore.submit(envelope)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed' || result.completion.outcome.kind !== 'result') throw new Error('restore missing')
    const value = result.completion.outcome.value as unknown as { producedArtifactRef: Parameters<FileArtifactStore['getJson']>[0];
      structuredResult: { restoredFiles: string[]; restoredFromCommit: string } }
    const physical = f.artifacts.getJson(value.producedArtifactRef) as { commitOid: string }
    expect((await f.builder.readHarnessFile(physical.commitOid, 'plugins/context.ts')).content)
      .toBe('export const value = 1\n')
    await expect(f.builder.readHarnessFile(physical.commitOid, 'plugins/temporary.ts')).rejects.toThrow()
    expect((await f.builder.readHarnessFile(physical.commitOid, 'preset/agent.cordis.yml')).content)
      .toBe('- name: ./plugins/context.js\n')
    expect(value.structuredResult.restoredFiles).toEqual(['plugins/context.ts', 'plugins/temporary.ts'])
    expect(value.structuredResult.restoredFromCommit).toBe(f.fixture.championRef)
    expect(result.completion.receipt?.cumulative).toEqual({ 'model.requests': 0, 'model.tokens': 0 })
    expect((await restore.inspect(envelope)).status).toBe('completed')
    expect(f.modelCalls()).toBe(3)
  })

  it('recreates a deleted source file while preserving every unlisted harness file', async () => {
    const f = await setup(false)
    const initial = { commitOid: f.fixture.championRef, manifestDigest: f.fixture.manifest.digest }
    const source = await manualRevision(f, initial, async (files, sessionId) => {
      await files.write(sessionId, 'prompts/restore.md', 'measured guidance\n', null)
    })
    const current = await manualRevision(f, source, async (files, sessionId) => {
      const item = await files.read(sessionId, 'prompts/restore.md')
      await files.remove(sessionId, 'prompts/restore.md', item.digest)
    })
    const sourceRef = f.bindings.create({ harness: f.artifacts.putJson({ schemaVersion: 1,
      kind: 'git-harness', ...source }, 'harness.directory.v1') })
    const currentRef = f.bindings.create({ harness: f.artifacts.putJson({ schemaVersion: 1,
      kind: 'git-harness', ...current }, 'harness.directory.v1') })
    const restore = createWorkspaceEditAdapter({ ...f.portOptions, root: join(f.root, 'restore-deleted'),
      files: new SkillCandidateFiles(f.manager, { maxReadBytes: 50_000 }),
      roles: [{ id: 'restore', spec: metaAgent(), instruction: 'Restore exact files.', maxModelRequests: 1,
        maxTokens: 100, timeoutMs: 20_000,
        restore: { sourceBindingField: 'source', filesField: 'files' } }], authorize: () => {} })
    const input = { roleId: 'restore', baseBindingSetRef: currentRef,
      source: sourceRef, files: ['prompts/restore.md'] }
    const operationId = sha256('restore-deleted')
    const envelope: OperationEnvelope = { ...f.envelope, operationId, idempotencyKey: operationId,
      kind: 'execution.workspace-edit', localKey: 'restore-deleted', input,
      inputDigest: jsonDigest(input), implementationDigest: restore.describe().implementationDigest,
      bindingSetRef: currentRef, limits: { 'model.requests': 0, 'model.tokens': 0 } }
    const result = await restore.submit(envelope)
    if (result.status !== 'completed' || result.completion.outcome.kind !== 'result')
      throw new Error('deleted file was not restored')
    const output = result.completion.outcome.value as unknown as {
      producedArtifactRef: Parameters<FileArtifactStore['getJson']>[0] }
    const git = f.artifacts.getJson(output.producedArtifactRef) as { commitOid: string }
    expect((await f.builder.readHarnessFile(git.commitOid, 'prompts/restore.md')).content).toBe('measured guidance\n')
    expect((await f.builder.readHarnessFile(git.commitOid, 'plugins/context.ts')).content)
      .toBe('export const value = 1\n')
    expect(f.modelCalls()).toBe(0)
  })

  it('rejects protected restore paths and foreign source schemas before creating a workspace', async () => {
    const f = await setup(false)
    const adapter = createWorkspaceEditAdapter({ ...f.portOptions, root: join(f.root, 'restore-invalid'),
      files: new SkillCandidateFiles(f.manager, { maxReadBytes: 50_000 }),
      roles: [{ id: 'restore', spec: metaAgent(), instruction: 'Restore exact files.', maxModelRequests: 1,
        maxTokens: 100, timeoutMs: 20_000,
        restore: { sourceBindingField: 'source', filesField: 'files' } }], authorize: () => {} })
    const create = vi.spyOn(f.manager, 'create')
    for (const path of ['plugins/.git/config', 'plugins/package.json', 'plugins/foo//bar',
      'plugins/context.ts/', 'plugins/../context.ts']) {
      const input = { roleId: 'restore', baseBindingSetRef: f.envelope.bindingSetRef,
        source: f.envelope.bindingSetRef, files: [path] }
      const envelope = { ...f.envelope, input, inputDigest: jsonDigest(input),
        implementationDigest: adapter.describe().implementationDigest }
      await expect(adapter.submit(envelope)).rejects.toThrow(/restore source or file list is invalid/)
    }
    const input = { roleId: 'restore', baseBindingSetRef: f.envelope.bindingSetRef,
      source: { ...f.envelope.bindingSetRef, schemaId: 'foreign-schema' }, files: ['plugins/context.ts'] }
    const envelope = { ...f.envelope, input, inputDigest: jsonDigest(input),
      implementationDigest: adapter.describe().implementationDigest }
    await expect(adapter.submit(envelope)).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
    expect(f.modelCalls()).toBe(0)
  })

  it('never redoes the Git edit after an uncertain finalization response', async () => {
    const f = await setup(true, true)
    expect((await f.adapter.submit(f.envelope)).status).toBe('running')
    expect((await f.adapter.inspect(f.envelope)).status).toBe('unknown')
    expect(f.modelCalls()).toBe(3)
  })
})

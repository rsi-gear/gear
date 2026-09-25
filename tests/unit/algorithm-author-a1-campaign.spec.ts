import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { verifyAuthorOutputGraph } from '../../src/algorithm/author/graph.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { TaskViewAuthority } from '../../src/algorithm/data/tasks.js';
import { AlgorithmRuntime } from '../../src/algorithm/runtime/engine.js';
import { LocalDurableProvider } from '../../src/algorithm/runtime/providers.js';
import type { BindingSchema, CampaignSpec, OperationProvider, ProviderManifest } from '../../src/algorithm/contracts.js';
import { AuthorAlgorithmAdapter, authorizeInitialOrDerivedHarness } from '../../src/algorithm/author/adapter.js';
import { AuthorObserveProvider, AuthorCheckpointProvider } from '../../src/algorithm/author/providers.js';
import { AuthorProcessReplayPort } from '../../src/algorithm/author/process-port.js';
import { createPythonAuthorReplayPort, type SealedPythonReplayPort } from '../../src/algorithm/author/python-port.js';
import { createTasksSampleProvider } from '../../src/algorithm/providers/task-sampling.js';
import { AUTHOR_WIRE_VERSION, AUTHOR_WIRE_VERSION_V2, type HarnessAgentV1 } from '../../src/algorithm/author/index.js';

const roots: string[] = [];
const pythonPorts: SealedPythonReplayPort[] = [];
afterEach(async () => {
  await Promise.all(pythonPorts.splice(0).map(port => port.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'gear-author-a1-campaign-')); roots.push(root); return root; };
const workerPath = resolve('lib/algorithm/author/worker-entry.js');
const modulePath = resolve('tests/fixtures/algorithm-author-a1-campaign.mjs');
const pythonFixtureDir = resolve('packages/python-sdk/tests/fixtures');
const sdkPath = resolve('packages/python-sdk/src');
const interpreter = [process.env.GEAR_TEST_PYTHON, process.env.GEAR_ALGORITHM_TEST_PYTHON,
  'python3.12', 'python3.11', '/opt/homebrew/bin/python3.11', 'python3'].find(candidate => {
  if (!candidate) return false;
  try { return execFileSync(candidate, ['-c', 'import sys; print(int(sys.version_info >= (3,11)))'],
    { encoding: 'utf8', timeout: 3000 }).trim() === '1'; } catch { return false; }
});
const bindingSchema: BindingSchema = { id: 'a1-campaign.bindings.v1', slots: {
  harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
} };
const profileDigest = sha256('a1-campaign-profile');
const commitOid = 'a'.repeat(40);
const manifestDigest = `sha256:${sha256('a1-campaign-manifest')}`;
const configSchema = { type: 'object' as const, required: ['goal'], properties: { goal: { type: 'string' as const } },
  additionalProperties: false };
const capabilities = { version: 'gear.author.capabilities.v1' as const, lockDigest: sha256('a1-campaign-lock'),
  roles: { analyst: { template: 'read-only-analyst' as const, kind: 'execution.role' as const } },
  operationLimits: { 'execution.role': {}, 'tasks.sample': {} }, execution: {} };
const kinds = ['tasks.consume', 'execution.workspace-edit', 'bindings.derive', 'execution.rollout', 'author.measurement'];
const manifest = (kind: string): ProviderManifest => ({ kind, implementationDigest: sha256(`fixture.${kind}.v1`),
  execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
  inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'any' } });

type Language = 'typescript' | 'python';
async function create(root: string, language: Language, tracked = false, dropRollout = false) {
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const bindings = new BindingStore(artifacts, bindingSchema);
  const harnessRef = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid, manifestDigest }, 'harness.directory.v1');
  const initialBindingSetRef = bindings.create({ harness: harnessRef });
  const initialAgent: HarnessAgentV1 = { schemaVersion: 1, kind: 'harness-agent', bindingSetRef: initialBindingSetRef,
    executionProfileDigest: profileDigest };
  const contentRefs = [0, 1, 2].map(index => artifacts.putJson({ task: index }, 'task.content.v1'));
  const experienceRef = artifacts.putJson({ schemaVersion: 1,
    source: { namespace: 'campaign', sourceId: 'a1-fixture', cursor: { namespace: 'campaign:a1-fixture', value: '1' } },
    sourceManifestDigest: sha256('a1-source-manifest'), sourceIndexVersion: '1',
    sourceEntriesDigest: sha256('a1-source-entries'), provenance: 'verified', purpose: 'research',
    projections: [], labelsExposed: false, authorityId: 'a1-fixture',
    entries: contentRefs.map((taskRef, index) => ({ id: `task-${index}`, kind: 'task-trajectory',
      taskId: `task-${index}`, taskRef, exposure: { seenInTraining: false, graderLabelExposed: false } }))
  }, 'experience.view.v1');
  const authority = new TaskViewAuthority(artifacts, 'a1-campaign-authority', Buffer.alloc(32, 7));
  const taskViewRef = authority.seal({ schemaVersion: 1, sourceExperienceViewDigest: experienceRef.digest,
    tasks: contentRefs.map((contentRef, index) => ({ id: `task-${index}`, contentRef, purpose: 'development' as const,
      exposure: { seenInTraining: false, graderLabelExposed: false }, ancestry: [] })) });
  const data = { taskViewRef };
  const spec: CampaignSpec = { campaignId: `a1-${language}`, config: { goal: 'verify v2' }, initialBindingSetRef, budget: {} };
  const port = language === 'typescript'
    ? new AuthorProcessReplayPort(tracked ? resolve('tests/fixtures/algorithm-author-a1-tracked-campaign.mjs') : modulePath,
      'sample', workerPath, 10_000, undefined, undefined, AUTHOR_WIRE_VERSION_V2)
    : await createPythonAuthorReplayPort({ configDir: pythonFixtureDir, module: tracked ? 'author_a1_tracked_campaign.py' : 'author_a1_campaign.py', export: 'sample',
      interpreter: interpreter!, sdkPath, wireVersion: AUTHOR_WIRE_VERSION_V2 });
  if (language === 'python') pythonPorts.push(port as SealedPythonReplayPort);
  const adapter = new AuthorAlgorithmAdapter({ id: 'a1-campaign', wireVersion: AUTHOR_WIRE_VERSION_V2,
    implementationDigest: port.sourceDigest, hostIdentityDigest: port.hostDigest, bindingSchema, artifacts, bindings,
    replay: language === 'typescript' ? request => (port as AuthorProcessReplayPort).replay(request) : port as SealedPythonReplayPort,
    initialAgent, data, capabilities, configSchema, requiredOperationKinds: kinds,
    executionProfileDigest: profileDigest, trustedAgentPolicyDigest: sha256('fixture.agent-policy.v1'), maxFrontierWaves: 10,
    verifyHarnessGit: (oid, digest) => { if (oid !== commitOid || digest !== manifestDigest) throw new Error('Git harness drift'); },
    authorizeSelectedAgent: authorizeInitialOrDerivedHarness });
  const role = new LocalDurableProvider(join(root, 'provider', 'execution.role'), manifest('execution.role'), envelope => {
    if ((envelope.input as { roleId: string }).roleId !== 'analyst') throw new Error('Unauthorized role');
    const evidenceRef = artifacts.putJson({ role: 'analyst' }, 'execution.role.evidence.v1');
    const receiptRef = artifacts.putJson({ operationId: envelope.operationId }, 'execution.receipt.v1');
    const structuredResult = { approved: true };
    const structuredResultRef = artifacts.putJson(structuredResult, 'execution.structured-result.v1');
    return { outcome: { kind: 'result', value: { requestedBindingSetDigest: initialBindingSetRef.digest,
      actualBindings: { harness: harnessRef }, evidenceRef, receiptRef, structuredResult, structuredResultRef } } };
  });
  const sample = createTasksSampleProvider({ artifacts, authority, resolveGrant: campaignId => {
    if (campaignId !== spec.campaignId) throw new Error('Wrong campaign grant');
    return { allowedExperienceViewDigests: [experienceRef.digest] };
  }, accessPolicyDigest: sha256('a1-campaign-policy'), maxCount: 2 });
  const unused = kinds.filter(kind => kind !== 'bindings.derive').map(kind => new LocalDurableProvider(
    join(root, 'provider', kind), manifest(kind),
    () => {
      if (kind === 'execution.rollout' && tracked)
        return { outcome: { kind: 'error' as const, code: 'TASK_FAILED', message: 'sealed business failure' } };
      throw new Error(`Unused fixture provider ${kind} invoked`);
    }, kind === 'execution.rollout' && dropRollout ? { dropSubmitResponseOnce: true } : {}));
  const providers: OperationProvider[] = [role, sample, ...unused, new AuthorObserveProvider(),
    new AuthorCheckpointProvider(artifacts, bindings, { wireVersion: 'v2', executionProfileDigest: profileDigest })];
  const runtime = new AlgorithmRuntime(root, adapter, providers, spec, { artifacts });
  return { runtime, adapter, role, rollout: unused.find(provider => provider.describe().kind === 'execution.rollout')!,
    port, initialAgent, artifacts, bindings };
}

for (const language of ['typescript', 'python'] as const) {
  (language === 'python' && !interpreter ? it.skip : it)(`${language} v2 Campaign replays three real worker waves and resumes cold with original keys`, async () => {
    const root = makeRoot();
    const first = await create(root, language);
    expect(first.adapter.describe().requiredOperationKinds).toEqual(expect.arrayContaining([
      'execution.role', 'tasks.sample', 'author.checkpoint', 'author.observe', 'tasks.consume', 'bindings.derive']));
    for (let attempt = 0; attempt < 10 && (first.runtime.snapshot()?.decisionIndex ?? 0) < 2; attempt++)
      await first.runtime.tick();
    const before = first.runtime.snapshot()!;
    expect(before.decisionIndex).toBe(2);
    const keys = Object.values(before.operations).map(item => item.envelope.idempotencyKey).sort();
    if (language === 'python') await (first.port as SealedPythonReplayPort).close();
    const resumed = await create(root, language);
    expect(resumed.port.sourceDigest).toBe(first.port.sourceDigest);
    expect(resumed.port.hostDigest).toBe(first.port.hostDigest);
    expect(Object.values(resumed.runtime.snapshot()!.operations).map(item => item.envelope.idempotencyKey).sort()).toEqual(keys);
    expect(await resumed.runtime.runUntilBlocked(40)).toBe('complete');
    expect(resumed.role.submitCalls).toBe(0);
    const history = resumed.adapter.readHistory(resumed.runtime.snapshot()!);
    expect(history.map(item => item.kind)).toEqual(['execution.role', 'tasks.sample', 'author.checkpoint']);
    expect(resumed.adapter.readResult(resumed.runtime.snapshot()!)).toMatchObject({ selected: resumed.initialAgent,
      outputs: { archive: { ref: { kind: 'artifact', schemaId: 'author.output-entry.v1' } }, selectedTaskIds: expect.any(Array) } });
    expect(resumed.runtime.snapshot()!.activeBindingSetRef).toEqual(resumed.initialAgent.bindingSetRef);
  });
}

it('rejects v1 requests at an explicitly v2 TypeScript port before spawning a worker', async () => {
  const port = new AuthorProcessReplayPort(modulePath, 'sample', workerPath, 10_000, undefined, undefined, AUTHOR_WIRE_VERSION_V2);
  await expect(port.replay({ version: AUTHOR_WIRE_VERSION, input: { initialAgent: null, data: {}, config: {} }, history: [] }))
    .rejects.toThrow(/version/);
});


it('rejects a selected Agent absent from this Campaign even when its CAS and profile exist', async () => {
  const root = makeRoot();
  const base = await create(root, 'typescript');
  const otherCommit = 'b'.repeat(40);
  const otherManifest = `sha256:${sha256('other-manifest')}`;
  const otherHarness = base.artifacts.putJson({ schemaVersion: 1, kind: 'git-harness',
    commitOid: otherCommit, manifestDigest: otherManifest }, 'harness.directory.v1');
  const selected: HarnessAgentV1 = { ...base.initialAgent, bindingSetRef: base.bindings.create({ harness: otherHarness }) };
  const adapter = new AuthorAlgorithmAdapter({ ...base.adapter.options, wireVersion: AUTHOR_WIRE_VERSION_V2,
    initialAgent: base.initialAgent, capabilities, configSchema, requiredOperationKinds: kinds,
    executionProfileDigest: profileDigest, trustedAgentPolicyDigest: sha256('fixture.agent-policy.v1'), replay: async () => ({ status: 'completed', result: { selected } }),
    verifyHarnessGit: (oid, digest) => { if (![[commitOid, manifestDigest], [otherCommit, otherManifest]]
      .some(([knownOid, knownDigest]) => knownOid === oid && knownDigest === digest)) throw new Error('Git harness drift'); },
    authorizeSelectedAgent: authorizeInitialOrDerivedHarness });
  await expect(adapter.initialize({ campaignId: 'forgery', decisionIndex: 0,
    activeBindingSetRef: base.initialAgent.bindingSetRef, config: { goal: 'verify v2' } }))
    .rejects.toThrow('not produced by this Campaign');
  const wrongProfile = { ...selected, executionProfileDigest: sha256('wrong-profile') };
  const wrong = new AuthorAlgorithmAdapter({ ...base.adapter.options, wireVersion: AUTHOR_WIRE_VERSION_V2,
    initialAgent: base.initialAgent, capabilities, configSchema, requiredOperationKinds: kinds,
    executionProfileDigest: profileDigest, trustedAgentPolicyDigest: sha256('fixture.agent-policy.v1'), replay: async () => ({ status: 'completed', result: { selected: wrongProfile } }),
    verifyHarnessGit: () => undefined, authorizeSelectedAgent: authorizeInitialOrDerivedHarness });
  await expect(wrong.initialize({ campaignId: 'forgery', decisionIndex: 0,
    activeBindingSetRef: base.initialAgent.bindingSetRef, config: { goal: 'verify v2' } }))
    .rejects.toThrow('profile identity drift');
});

it('checks v2 checkpoint identity on direct submit and rejects unlisted graph schemas', async () => {
  const root = makeRoot();
  const base = await create(root, 'typescript');
  const mutablePolicy: { wireVersion: 'v1' | 'v2'; executionProfileDigest: string } =
    { wireVersion: 'v2', executionProfileDigest: profileDigest };
  const checkpoint = new AuthorCheckpointProvider(base.artifacts, base.bindings, mutablePolicy);
  const frozenManifest = checkpoint.describe();
  mutablePolicy.wireVersion = 'v1'; mutablePolicy.executionProfileDigest = sha256('caller-mutated-profile');
  expect(checkpoint.describe()).toEqual(frozenManifest);
  expect(checkpoint.policy).toEqual({ wireVersion: 'v2', executionProfileDigest: profileDigest });
  const input = { name: 'proof', value: { healthy: true }, schema: 'author.archive.v1' };
  const envelope = { operationId: sha256('checkpoint-op'), idempotencyKey: sha256('checkpoint-key'),
    campaignId: 'a1-direct', decisionIndex: 0, localKey: 'a.r.s0', kind: 'author.checkpoint',
    input, inputDigest: jsonDigest(input), implementationDigest: checkpoint.describe().implementationDigest,
    bindingSetRef: base.initialAgent.bindingSetRef, limits: {}, startsBudgetClock: false };
  expect((await checkpoint.submit(envelope)).status).toBe('completed');
  expect(() => checkpoint.submit({ ...envelope, inputDigest: sha256('drift') })).toThrow('identity drift');
  expect(() => checkpoint.collect({ ...envelope, limits: { calls: 1 } })).toThrow('must not meter');
  const unknown = base.artifacts.putJson({ arbitrary: true }, 'custom.unverified.v1');
  expect(() => verifyAuthorOutputGraph(base.artifacts, base.bindings, { output: unknown },
    { wireVersion: 'v2', executionProfileDigest: profileDigest })).toThrow('undeclared artifact ref schema');
});

(interpreter ? it : it.skip)('rejects v1 requests at an explicitly v2 Python port before replay', async () => {
  const port = await createPythonAuthorReplayPort({ configDir: pythonFixtureDir, module: 'author_a1_campaign.py',
    export: 'sample', interpreter: interpreter!, sdkPath, wireVersion: AUTHOR_WIRE_VERSION_V2 });
  pythonPorts.push(port);
  await expect(port({ version: AUTHOR_WIRE_VERSION, input: { initialAgent: null, data: {}, config: {} }, history: [] }))
    .rejects.toThrow(/replay request/);
});

it('walks declared v2 task lineage and workspace-edit result edges without accepting hidden refs', async () => {
  const root = makeRoot();
  const base = await create(root, 'typescript');
  const policy = { wireVersion: 'v2' as const, executionProfileDigest: profileDigest };
  const missingSource = base.artifacts.putJson({ schemaVersion: 1,
    sourceExperienceViewDigest: sha256('missing-experience'), tasks: [] }, 'task.view.v1');
  expect(() => verifyAuthorOutputGraph(base.artifacts, base.bindings, { taskViewRef: missingSource }, policy)).toThrow();
  const missingParent = base.artifacts.putJson({ schemaVersion: 1,
    parentTaskViewDigest: sha256('missing-parent'), tasks: [] }, 'task.view.v1');
  expect(() => verifyAuthorOutputGraph(base.artifacts, base.bindings, { taskViewRef: missingParent }, policy)).toThrow();
  const modelResultRef = base.artifacts.putJson({ approved: true }, 'execution.workspace-edit.model-result.v1');
  const editResult = base.artifacts.putJson({ schemaVersion: 1, modelResultRef }, 'execution.workspace-edit.result.v1');
  expect(() => verifyAuthorOutputGraph(base.artifacts, base.bindings, { editResult }, policy)).not.toThrow();
  const missingModel = base.artifacts.putJson({ schemaVersion: 1,
    modelResultRef: { ...modelResultRef, digest: sha256('missing-model') } }, 'execution.workspace-edit.result.v1');
  expect(() => verifyAuthorOutputGraph(base.artifacts, base.bindings, { editResult: missingModel }, policy)).toThrow();
  const opaque = base.artifacts.putJson({ hiddenRef: modelResultRef }, 'execution.structured-result.v1');
  expect(() => verifyAuthorOutputGraph(base.artifacts, base.bindings, { opaque }, policy))
    .toThrow('undeclared typed reference');
});

it('freezes v2 trusted Agent policy identity and rejects unknown adapter wire values', async () => {
  const root = makeRoot();
  const base = await create(root, 'typescript');
  const changed = new AuthorAlgorithmAdapter({ ...base.adapter.options, wireVersion: AUTHOR_WIRE_VERSION_V2,
    initialAgent: base.initialAgent, capabilities, configSchema, requiredOperationKinds: kinds,
    executionProfileDigest: profileDigest, trustedAgentPolicyDigest: sha256('different-agent-policy'),
    verifyHarnessGit: () => undefined, authorizeSelectedAgent: authorizeInitialOrDerivedHarness });
  expect(changed.describe().implementationDigest).not.toBe(base.adapter.describe().implementationDigest);
  expect(() => new AuthorAlgorithmAdapter({ ...base.adapter.options,
    wireVersion: 'gear.author.replay.unknown' as never })).toThrow('Unsupported author adapter wire version');
  const { wireVersion: _omittedWire, ...withoutWire } = base.adapter.options as typeof base.adapter.options &
    { wireVersion?: string };
  expect(() => new AuthorAlgorithmAdapter({ ...withoutWire, capabilities } as never))
    .toThrow('explicit v2 wire version');
});

for (const language of ['typescript', 'python'] as const) {
  (language === 'python' && !interpreter ? it.skip : it)(`${language} v2 tracked business failure retains its kernel ID across lost reply and cold replay`, async () => {
    const root = makeRoot();
    const first = await create(root, language, true, true);
    await first.runtime.tick();
    const pending = first.runtime.snapshot()!;
    const [localKey, record] = Object.entries(pending.operations)[0]!;
    const originalId = record.envelope.operationId;
    expect(originalId).toMatch(/^[a-f0-9]{64}$/);
    await expect(first.adapter.reduce({ campaignId: `a1-${language}`, decisionIndex: 1,
      activeBindingSetRef: first.initialAgent.bindingSetRef, config: { goal: 'verify v2' },
      state: pending.state, completed: { [localKey]: { kind: 'error', code: 'TASK_FAILED', message: 'sealed business failure' } } }))
      .rejects.toThrow('operation ID projection missing');
    expect(await first.runtime.runUntilBlocked(2)).toBe('waiting');
    expect(first.adapter.readHistory(first.runtime.snapshot()!)).toEqual([]);
    if (language === 'python') await (first.port as SealedPythonReplayPort).close();
    const recovered = await create(root, language, true);
    expect(recovered.port.sourceDigest).toBe(first.port.sourceDigest);
    expect(Object.values(recovered.runtime.snapshot()!.operations)[0]!.envelope.operationId).toBe(originalId);
    expect(await recovered.runtime.runUntilBlocked(20)).toBe('complete');
    expect(recovered.rollout.submitCalls).toBe(0);
    const history = recovered.adapter.readHistory(recovered.runtime.snapshot()!);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: 'execution.rollout', operationId: originalId,
      outcome: { kind: 'error', code: 'TASK_FAILED' } });
    expect(recovered.adapter.readResult(recovered.runtime.snapshot()!)).toMatchObject({
      selected: recovered.initialAgent,
      outputs: { tracked: { operationId: originalId, outcome: { kind: 'error', code: 'TASK_FAILED' } } },
    });
  });
}

it('rejects missing, malformed and repeated kernel IDs before v2 history is appended', async () => {
  const root = makeRoot();
  const base = await create(root, 'typescript');
  const adapter = new AuthorAlgorithmAdapter({ ...base.adapter.options, wireVersion: AUTHOR_WIRE_VERSION_V2,
    initialAgent: base.initialAgent, capabilities, configSchema, requiredOperationKinds: kinds,
    executionProfileDigest: profileDigest, trustedAgentPolicyDigest: sha256('fixture.agent-policy.v1'),
    verifyHarnessGit: () => undefined, authorizeSelectedAgent: authorizeInitialOrDerivedHarness,
    replay: async () => ({ status: 'waiting', frontier: [
      { address: 'r/s0', kind: 'custom.a', definitionVersion: 'algorithm.v2', input: {} },
      { address: 'r/s1', kind: 'custom.b', definitionVersion: 'algorithm.v2', input: {} },
    ] }) });
  const context = { campaignId: 'a1-kernel-ids', decisionIndex: 0,
    activeBindingSetRef: base.initialAgent.bindingSetRef, config: { goal: 'verify v2' } };
  const decision = await adapter.initialize(context);
  const reduce = (completedOperationIds?: Record<string, string>) => adapter.reduce({ ...context, decisionIndex: 1,
    state: decision.nextState, completed: { 'a.r.s0': { kind: 'result', value: null },
      'a.r.s1': { kind: 'error', code: 'BUSINESS', message: 'failed' } },
    ...(completedOperationIds ? { completedOperationIds } : {}) });
  await expect(reduce()).rejects.toThrow('projection missing');
  await expect(reduce({ 'a.r.s0': sha256('one'), 'a.r.s1': 'bad-id' })).rejects.toThrow('ID missing');
  await expect(reduce({ 'a.r.s0': sha256('same'), 'a.r.s1': sha256('same') })).rejects.toThrow('ID missing, invalid or repeated');
  await expect(reduce({ 'a.r.s0': sha256('one'), 'a.r.s1': sha256('two'), extra: sha256('extra') }))
    .rejects.toThrow('projection missing');
});

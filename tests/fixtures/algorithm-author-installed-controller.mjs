import { join } from 'node:path';
import { FileArtifactStore, sha256 } from '../../lib/algorithm/artifacts.js';
import { BindingStore } from '../../lib/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../lib/algorithm/runtime/engine.js';
import { LocalDurableProvider } from '../../lib/algorithm/runtime/providers.js';
import { AuthorAlgorithmAdapter, authorizeInitialOrDerivedHarness } from '../../lib/algorithm/author/adapter.js';
import { createInstalledAuthorReplayPort } from '../../lib/algorithm/author/process-port.js';
import { AuthorObserveProvider, AuthorCheckpointProvider } from '../../lib/algorithm/author/providers.js';
import { AUTHOR_WIRE_VERSION_V2 } from '../../lib/algorithm/author/index.js';

const [projectRoot, stateRoot, phase] = process.argv.slice(2);
if (!projectRoot || !stateRoot || !['before', 'after'].includes(phase)) throw new Error('controller args invalid');
const bindingSchema = { id: 'installed-author.bindings.v1', slots: {
  harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
} };
const profileDigest = sha256('installed-author-profile');
const commitOid = 'a'.repeat(40);
const manifestDigest = `sha256:${sha256('installed-author-manifest')}`;
const configSchema = { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } }, additionalProperties: false };
const capabilities = { version: 'gear.author.capabilities.v1', lockDigest: sha256('installed-author-lock'),
  roles: {}, operationLimits: {}, execution: {} };
const baseKinds = ['tasks.sample', 'tasks.consume', 'execution.workspace-edit',
  'execution.rollout', 'author.measurement'];
const manifest = kind => ({ kind, implementationDigest: sha256(`installed-fixture.${kind}.v1`),
  execution: 'trusted-local', supportsInspect: true, meteredDimensions: [],
  inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'any' } });
const artifacts = new FileArtifactStore(join(stateRoot, 'artifacts'));
const bindings = new BindingStore(artifacts, bindingSchema);
const harnessRef = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid, manifestDigest }, 'harness.directory.v1');
const initialBindingSetRef = bindings.create({ harness: harnessRef });
const initialAgent = { schemaVersion: 1, kind: 'harness-agent', bindingSetRef: initialBindingSetRef,
  executionProfileDigest: profileDigest };
const port = createInstalledAuthorReplayPort({ projectRoot, module: 'algorithm.ts', exportName: 'sample' });
const adapter = new AuthorAlgorithmAdapter({ id: 'installed-author', wireVersion: AUTHOR_WIRE_VERSION_V2,
  implementationDigest: port.sourceDigest, hostIdentityDigest: port.hostDigest, bindingSchema, artifacts, bindings,
  replay: request => port.replay(request), initialAgent, data: {}, capabilities, configSchema,
  requiredOperationKinds: ['proof.step'], executionProfileDigest: profileDigest,
  trustedAgentPolicyDigest: sha256('installed-fixture.agent-policy.v1'), maxFrontierWaves: 10,
  verifyHarnessGit: (oid, digest) => { if (oid !== commitOid || digest !== manifestDigest) throw new Error('Git harness drift'); },
  authorizeSelectedAgent: authorizeInitialOrDerivedHarness });
const proof = new LocalDurableProvider(join(stateRoot, 'provider', 'proof.step'), manifest('proof.step'),
  envelope => ({ outcome: { kind: 'result', value: { n: envelope.input.n } } }));
const unused = baseKinds.map(kind => new LocalDurableProvider(join(stateRoot, 'provider', kind), manifest(kind),
  () => { throw new Error(`Unused fixture provider invoked: ${kind}`); }));
const providers = [proof, ...unused, new AuthorObserveProvider(),
  new AuthorCheckpointProvider(artifacts, bindings, { wireVersion: 'v2', executionProfileDigest: profileDigest })];
const spec = { campaignId: 'installed-author-campaign', config: { goal: 'external' }, initialBindingSetRef, budget: {} };
const runtime = new AlgorithmRuntime(stateRoot, adapter, providers, spec, { artifacts });
if (phase === 'before') {
  for (let i = 0; i < 30 && (runtime.snapshot()?.decisionIndex ?? 0) < 2; i++) await runtime.tick();
  if (runtime.snapshot()?.decisionIndex !== 2) throw new Error('Expected two frontier waves before cold exit');
} else {
  if (await runtime.runUntilBlocked(40) !== 'complete') throw new Error('External author campaign did not complete');
}
const snapshot = runtime.snapshot();
console.log(JSON.stringify({ phase: snapshot?.phase, decisionIndex: snapshot?.decisionIndex,
  sourceDigest: port.sourceDigest, hostDigest: port.hostDigest, submitCalls: proof.submitCalls,
  keys: Object.values(snapshot?.operations ?? {}).map(item => item.envelope.idempotencyKey).sort(),
  history: adapter.readHistory(snapshot).map(item => item.kind),
  historyIds: adapter.readHistory(snapshot).map(item => item.operationId),
  ...(phase === 'after' ? { result: adapter.readResult(snapshot) } : {}) }));

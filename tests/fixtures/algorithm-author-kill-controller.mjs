import { join, resolve } from 'node:path';
import { FileArtifactStore, sha256 } from '../../lib/algorithm/artifacts.js';
import { BindingStore } from '../../lib/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../lib/algorithm/runtime/engine.js';
import { LocalDurableProvider } from '../../lib/algorithm/runtime/providers.js';
import { AuthorAlgorithmAdapter } from '../../lib/algorithm/author/adapter.js';
import { AuthorObserveProvider, AuthorCheckpointProvider } from '../../lib/algorithm/author/providers.js';
import { AuthorProcessReplayPort } from '../../lib/algorithm/author/process-port.js';

const root = process.argv[2];
const schema = { id: 'author-a0.bindings.v1', slots: {} };
const artifacts = new FileArtifactStore(join(root, 'artifacts'));
const bindingStore = new BindingStore(artifacts, schema);
const initialBindingSetRef = bindingStore.create({});
const kindManifest = (kind, dimensions = []) => ({ kind, implementationDigest: sha256(`${kind}.fake.v1`),
  execution: 'trusted-local', supportsInspect: true, meteredDimensions: dimensions,
  inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'any' } });
const physical = ['author.role', 'author.edit', 'author.rollout', 'author.measure'].map(kind =>
  new LocalDurableProvider(join(root, 'provider', kind), kindManifest(kind, kind === 'author.rollout' ? ['calls'] : []), envelope => {
    const input = envelope.input;
    const outcome = kind === 'author.role' ? { kind: 'result', value: { prompt: `role-${input.input.branch}` } }
      : kind === 'author.edit' ? { kind: 'result', value: { revision: `revision-${input.branch}` } }
      : kind === 'author.rollout' ? { kind: 'result', value: { label: input.label, passed: true } }
      : { kind: 'result', value: { scored: true } };
    return { outcome, ...(kind === 'author.rollout' ? { receipt: { source: 'rollout', scope: 'operation', operationId: envelope.operationId,
      cursor: 'done', cumulative: { calls: 1 } } } : {}) };
  }));
const port = new AuthorProcessReplayPort(resolve('tests/fixtures/algorithm-author-a0.mjs'), 'sample',
  resolve('lib/algorithm/author/worker-entry.js'));
const adapter = new AuthorAlgorithmAdapter({ id: 'a0-sample', implementationDigest: port.sourceDigest,
  hostIdentityDigest: port.hostDigest, bindingSchema: schema, artifacts, bindings: bindingStore,
  replay: request => port.replay(request), initialAgent: null, data: {}, maxFrontierWaves: 200, clock: () => 123456 });
const runtime = new AlgorithmRuntime(root, adapter, [...physical, new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindingStore)],
  { campaignId: 'author-a0', config: { rounds: 1 }, initialBindingSetRef,
    budget: { calls: { unit: 'call', limit: 50, source: 'rollout', capability: 'stop' } } }, { artifacts });
await runtime.tick(); // role intents committed, no effect yet
await runtime.tick(); // role effects and edit intents committed
process.stdout.write('SECOND_INTENT_COMMITTED\n');
setInterval(() => {}, 1000);

import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { FileArtifactStore, sha256 } from '../../lib/algorithm/artifacts.js';
import { BindingStore } from '../../lib/algorithm/bindings.js';
import { AlgorithmRuntime } from '../../lib/algorithm/runtime/engine.js';
import { LocalDurableProvider } from '../../lib/algorithm/runtime/providers.js';
import { AuthorAlgorithmAdapter } from '../../lib/algorithm/author/adapter.js';
import { AuthorObserveProvider, AuthorCheckpointProvider } from '../../lib/algorithm/author/providers.js';
import { createPythonAuthorReplayPort } from '../../lib/algorithm/author/python-port.js';

const [root, phase, interpreter] = process.argv.slice(2);
if (!root || !['before', 'after'].includes(phase) || !interpreter)
  throw new Error('expected root, before|after, and Python >=3.11 interpreter');

const schema = { id: 'author-py-kill.bindings.v1', slots: {} };
const artifacts = new FileArtifactStore(join(root, 'artifacts'));
const bindings = new BindingStore(artifacts, schema);
const initialBindingSetRef = bindings.create({});
const port = await createPythonAuthorReplayPort({ configDir: resolve('packages/python-sdk/tests/fixtures'),
  module: 'author_kill_sample.py', export: 'sample', interpreter,
  sdkPath: resolve('packages/python-sdk/src'), timeoutMs: 30_000 });
try {
const adapter = new AuthorAlgorithmAdapter({ id: 'author-py-kill', implementationDigest: port.sourceDigest,
  hostIdentityDigest: port.hostDigest, bindingSchema: schema, artifacts, bindings, replay: port,
  initialAgent: null, data: {}, maxFrontierWaves: 30, clock: () => 123456 });
const effectPath = join(root, 'effects.jsonl');
const physical = ['author.role', 'author.edit', 'author.rollout', 'author.measure'].map(kind =>
  new LocalDurableProvider(join(root, 'provider', kind), {
    kind, implementationDigest: sha256(`${kind}.py-kill-fake.v1`),
    execution: 'trusted-local', supportsInspect: true,
    meteredDimensions: kind === 'author.rollout' ? ['calls'] : [],
    inputSchema: { type: 'object', additionalProperties: true }, outputSchema: { type: 'any' },
  }, envelope => {
    fs.appendFileSync(effectPath, `${JSON.stringify({ kind, operationId: envelope.operationId,
      idempotencyKey: envelope.idempotencyKey, localKey: envelope.localKey })}\n`);
    const input = envelope.input;
    const value = kind === 'author.role' ? { prompt: `role-${input.input.label}` }
      : kind === 'author.edit' ? { revision: `revision-${input.label}` }
      : kind === 'author.rollout' ? { task: input.task, passed: true }
      : kind === 'author.measure' ? { score: 1 } : {};
    return { outcome: { kind: 'result', value }, ...(kind === 'author.rollout'
      ? { receipt: { source: 'rollout', scope: 'operation', operationId: envelope.operationId,
        cursor: 'done', cumulative: { calls: 1 } } } : {}) };
  }));
const runtime = new AlgorithmRuntime(root, adapter,
  [...physical, new AuthorObserveProvider(), new AuthorCheckpointProvider(artifacts, bindings)],
  { campaignId: 'author-py-kill', config: {}, initialBindingSetRef,
    budget: { calls: { unit: 'call', limit: 50, source: 'rollout', capability: 'stop' } } }, { artifacts });

function pending(snapshot) {
  return Object.values(snapshot.operations).filter(record => record.status === 'intent')
    .map(record => ({ operationId: record.envelope.operationId,
      idempotencyKey: record.envelope.idempotencyKey, kind: record.envelope.kind })).sort((a, b) =>
      a.operationId.localeCompare(b.operationId));
}

if (phase === 'before') {
  if (runtime.snapshot() !== null) throw new Error('before phase needs fresh Campaign');
  await runtime.tick(); // role intents are committed, with no physical effect yet.
  await runtime.tick(); // role results are sealed; edit intents are committed.
  const state = runtime.snapshot();
  const roles = adapter.readHistory(state).filter(item => item.kind === 'author.role');
  const edits = pending(state);
  if (roles.length !== 2 || edits.length !== 2 || edits.some(item => item.kind !== 'author.edit'))
    throw new Error('failed to reach committed role results and edit intent breakpoint');
  process.stdout.write(`SECOND_INTENT_COMMITTED ${JSON.stringify({ pending: edits })}\n`);
  setInterval(() => {}, 1000);
} else {
  const state = runtime.snapshot();
  if (!state || state.phase !== 'running') throw new Error('after phase needs prior Campaign');
  const originalPending = pending(state);
  if (originalPending.length !== 2 || originalPending.some(item => item.kind !== 'author.edit'))
    throw new Error('cold controller did not load original edit intents');
  const rolesBefore = adapter.readHistory(state).filter(item => item.kind === 'author.role').length;
  const status = await runtime.runUntilBlocked(100);
  const final = runtime.snapshot();
  const history = adapter.readHistory(final);
  const effects = fs.readFileSync(effectPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  process.stdout.write(`AFTER_RESULT ${JSON.stringify({ status, phase: final.phase,
    originalPending, rolesBefore, roleSubmitCallsAfterRestart: physical[0].submitCalls,
    spentCalls: final.spent.calls,
    historyRoles: history.filter(item => item.kind === 'author.role').length,
    historyRollouts: history.filter(item => item.kind === 'author.rollout').length,
    effects })}\n`);
}
} finally { await port.close(); }

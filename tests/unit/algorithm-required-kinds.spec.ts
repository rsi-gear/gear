import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ALGORITHM_API_VERSION, AlgorithmRuntime, LocalDurableProvider, sha256 } from '../../src/algorithm/index.js';
import type { Algorithm, CampaignSpec } from '../../src/algorithm/contracts.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('admits only a complete required operation catalog before a campaign is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-required-kinds-')); paths.push(root);
  const algorithm: Algorithm = { describe: () => ({ id: 'required-kinds', apiVersion: ALGORITHM_API_VERSION,
    implementationDigest: sha256('recipe'), stateSchema: { type: 'object' }, configSchema: { type: 'object' },
    bindingSchema: { id: 'empty', slots: {} }, requiredOperationKinds: ['toy.echo', 'bindings.derive'] }),
  initialize: () => ({ nextState: {}, complete: true }), reduce: () => ({ nextState: {}, complete: true }) };
  const spec: CampaignSpec = { campaignId: 'required-kinds', config: {},
    initialBindingSetRef: { kind: 'binding-set', digest: sha256('empty-bindings'), schemaId: 'empty' }, budget: {} };
  expect(() => new AlgorithmRuntime(join(root, 'campaign'), algorithm, [], spec))
    .toThrow('Required operation provider missing: toy.echo');
  const provider = new LocalDurableProvider(join(root, 'provider'), { kind: 'toy.echo',
    implementationDigest: sha256('provider'), execution: 'trusted-local', supportsInspect: true,
    meteredDimensions: [], inputSchema: { type: 'any' }, outputSchema: { type: 'any' } },
  () => ({ outcome: { kind: 'result', value: null } }));
  const admitted = new AlgorithmRuntime(join(root, 'campaign'), algorithm, [provider], spec);
  expect(admitted.snapshot()).toBeNull();
});

it('resolves required provider kinds from own frozen config strings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-required-config-kind-')); paths.push(root);
  const algorithm: Algorithm = { describe: () => ({ id: 'configured-kind', apiVersion: ALGORITHM_API_VERSION,
    implementationDigest: sha256('configured-recipe'), stateSchema: { type: 'object' },
    configSchema: { type: 'object' }, bindingSchema: { id: 'empty', slots: {} },
    requiredOperationKindsFromConfig: ['evaluationKind'] }),
  initialize: () => ({ nextState: {}, complete: true }), reduce: () => ({ nextState: {}, complete: true }) };
  const spec = (config: CampaignSpec['config']): CampaignSpec => ({ campaignId: 'configured-kind', config,
    initialBindingSetRef: { kind: 'binding-set', digest: sha256('empty-bindings'), schemaId: 'empty' }, budget: {} });
  expect(() => new AlgorithmRuntime(join(root, 'campaign'), algorithm, [], spec({})))
    .toThrow('Required operation kind config must be an own string value: evaluationKind');
  expect(() => new AlgorithmRuntime(join(root, 'campaign'), algorithm, [], spec({ evaluationKind: 4 })))
    .toThrow('Required operation kind config must be an own string value: evaluationKind');
  expect(() => new AlgorithmRuntime(join(root, 'campaign'), algorithm, [], spec({ evaluationKind: 'trial.evaluate' })))
    .toThrow('Required operation provider missing: trial.evaluate');
  const provider = new LocalDurableProvider(join(root, 'provider'), { kind: 'trial.evaluate',
    implementationDigest: sha256('evaluation-provider'), execution: 'trusted-local', supportsInspect: true,
    meteredDimensions: [], inputSchema: { type: 'any' }, outputSchema: { type: 'any' } },
  () => ({ outcome: { kind: 'result', value: null } }));
  expect(new AlgorithmRuntime(join(root, 'campaign'), algorithm, [provider], spec({ evaluationKind: 'trial.evaluate' })).snapshot()).toBeNull();
});

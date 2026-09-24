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

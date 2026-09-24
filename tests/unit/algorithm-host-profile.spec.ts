import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { algorithmCommand } from '../../src/algorithm/cli.js';
import { sha256 } from '../../src/algorithm/artifacts.js';

const python = process.env.GEAR_ALGORITHM_TEST_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON ?? 'python3';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('constructs an algorithm and strict provider from a sealed host profile without author CAS paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-profile-')); roots.push(root);
  const selfDigest = sha256('strict-provider-self');
  const source = `const selfDigest = '${selfDigest}';
const provider = {
  describe() { return { kind: 'toy.profile', implementationDigest: selfDigest, execution: 'trusted-local',
    supportsInspect: true, meteredDimensions: [], inputSchema: { type: 'any' }, outputSchema: { type: 'any' } }; },
  preflight(envelope) { if (envelope.implementationDigest !== selfDigest) throw Error('inner provider identity changed'); },
  async submit(envelope) { this.preflight(envelope); return { status: 'completed', completion: {
    operationId: envelope.operationId, idempotencyKey: envelope.idempotencyKey,
    inputDigest: envelope.inputDigest, implementationDigest: envelope.implementationDigest,
    outcome: { kind: 'result', value: envelope.input } } }; },
  async inspect() { return { status: 'not-started' }; },
  async cancel() { return { status: 'cancelled', releaseConfirmed: true }; },
  async collect(envelope) { return (await this.submit(envelope)).completion; },
};
export const host = { create(context) {
  if (context.campaignId !== 'profile-test') throw Error('wrong frozen context');
  return { providers: [provider], algorithm: {
    describe() { return { id: 'profile-algorithm', apiVersion: 'gear.algorithm.experimental.v1',
      implementationDigest: '${sha256('profile-algorithm')}', stateSchema: { type: 'object' },
      configSchema: { type: 'object' }, bindingSchema: { id: 'empty', slots: {} },
      requiredOperationKinds: ['toy.profile'] }; },
    initialize() { return { nextState: {}, operations: [{ localKey: 'call', kind: 'toy.profile', input: { answer: 42 } }] }; },
    reduce({ completed }) { return { nextState: { answer: completed.call.value.answer }, complete: true }; },
  } }; }
};
`;
  await writeFile(join(root, 'profile.mjs'), source);
  const configPath = join(root, 'gear.algorithm.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, kind: 'algorithm-campaign',
    campaignId: 'profile-test', stateDir: './.gear/profile-test',
    hostProfile: { language: 'typescript', module: './profile.mjs', export: 'host' },
    config: {}, budget: {} }));
  const lines: string[] = [];
  await algorithmCommand(['check', configPath], line => lines.push(line));
  expect(JSON.parse(lines.at(-1)!).providers).toEqual(['toy.profile']);
  await algorithmCommand(['run', configPath], line => lines.push(line));
  expect(JSON.parse(lines.at(-1)!).status).toBe('complete');
  expect(JSON.parse(lines.at(-1)!).snapshot.state).toMatchObject({ answer: 42 });
  expect(JSON.parse(lines.at(-1)!).snapshot.spec.components['host-profile'].implementationDigest).toMatch(/^[a-f0-9]{64}$/);
});


it('closes host-owned resources when admission fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-profile-close-')); roots.push(root);
  await writeFile(join(root, 'profile.mjs'), `import { writeFileSync } from 'node:fs';
export const host = { create(context) { return { providers: [],
  algorithm: { describe() { return { id: 'needs-provider', apiVersion: 'gear.algorithm.experimental.v1',
    implementationDigest: '${sha256('needs-provider')}', stateSchema: { type: 'object' },
    configSchema: { type: 'object' }, bindingSchema: { id: 'empty', slots: {} },
    requiredOperationKinds: ['missing.provider'] }; },
    initialize() { return { nextState: {}, complete: true }; },
    reduce() { return { nextState: {}, complete: true }; } },
  close() { writeFileSync(context.stateDir + '/closed.txt', 'closed'); } }; } };
`);
  const configPath = join(root, 'gear.algorithm.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, kind: 'algorithm-campaign',
    campaignId: 'close-test', stateDir: './.gear/close-test',
    hostProfile: { language: 'typescript', module: './profile.mjs', export: 'host' }, config: {}, budget: {} }));
  await expect(algorithmCommand(['check', configPath], () => undefined)).rejects.toThrow('Required operation provider missing');
  expect(await readFile(join(root, '.gear/close-test/closed.txt'), 'utf8')).toBe('closed');
});

it('makes an init campaign ID legal for a numeric directory name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-numeric-parent-')); roots.push(root);
  const project = join(root, '2026-demo');
  await algorithmCommand(['init', project, 'python'], () => undefined);
  const config = JSON.parse(await readFile(join(project, 'gear.algorithm.json'), 'utf8')) as { campaignId: string };
  expect(config.campaignId).toMatch(/^campaign-2026-demo-[a-f0-9-]+$/);
});

it('rejects CommonJS require in the closed TypeScript author tree before importing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gear-cjs-closure-')); roots.push(root);
  await writeFile(join(root, 'profile.mjs'), `export const host = { create() { return { providers: [] }; } };\n`);
  await writeFile(join(root, 'helper.cjs'), `module.exports = require('fs');\n`);
  const configPath = join(root, 'gear.algorithm.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, kind: 'algorithm-campaign',
    campaignId: 'cjs-test', stateDir: './.gear/cjs-test',
    hostProfile: { language: 'typescript', module: './profile.mjs', export: 'host' }, config: {}, budget: {} }));
  await expect(algorithmCommand(['check', configPath], () => undefined))
    .rejects.toThrow('CommonJS require needs a separately sealed bundle');
});

it('freezes a host-resolved artifact ref into a Python algorithm config and restores the same ref', async () => {
  const version = JSON.parse(execFileSync(python, ['-c',
    'import json,sys;print(json.dumps(sys.version_info[:2]))'], { encoding: 'utf8' })) as [number, number];
  if (version[0] < 3 || version[0] === 3 && version[1] < 11) throw new Error('Python >=3.11 required');
  const root = await mkdtemp(join(tmpdir(), 'gear-profile-python-')); roots.push(root);
  await writeFile(join(root, 'profile.mjs'), `export const host = { create(context) {
  const ref = context.artifacts.putJson({ source: 'host-authorized-fixture', count: 1 }, 'fixture.view.v1');
  return { providers: [], config: { experienceViewRef: ref } };
} };\n`);
  await writeFile(join(root, 'algorithm.py'), `from gear_algorithm import AlgorithmManifest
class HostConfigured:
    def describe(self):
        return AlgorithmManifest('host-configured-python', {'type':'object'},
            {'type':'object','properties':{'experienceViewRef':{'type':'any'}},
             'required':['experienceViewRef'],'additionalProperties':False},
            {'id':'empty','slots':{}})
    def initialize(self, context):
        return {'nextState': {'viewDigest': context['config']['experienceViewRef']['digest']}, 'complete': True}
    def reduce(self, context):
        return {'nextState': context['state'], 'complete': True}
algorithm = HostConfigured()
`);
  const configPath = join(root, 'gear.algorithm.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, kind: 'algorithm-campaign',
    campaignId: 'profile-python', stateDir: './.gear/profile-python',
    algorithm: { language: 'python', interpreter: python, sdkPath: join(process.cwd(), 'packages/python-sdk/src'),
      module: './algorithm.py', export: 'algorithm' },
    hostProfile: { language: 'typescript', module: './profile.mjs', export: 'host' },
    config: {}, budget: {} }));
  const lines: string[] = [];
  await algorithmCommand(['check', configPath], line => lines.push(line));
  await algorithmCommand(['run', configPath], line => lines.push(line));
  const completed = JSON.parse(lines.at(-1)!) as { snapshot: { state: { viewDigest: string };
    spec: { config: { experienceViewRef: { digest: string } } } } };
  expect(completed.snapshot.state.viewDigest).toBe(completed.snapshot.spec.config.experienceViewRef.digest);
  await algorithmCommand(['resume', configPath], line => lines.push(line));
  expect((JSON.parse(lines.at(-1)!) as typeof completed).snapshot.state.viewDigest).toBe(completed.snapshot.state.viewDigest);
});

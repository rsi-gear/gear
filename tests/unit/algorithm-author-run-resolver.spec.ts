import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { checkAuthorRun, explainAuthorRun, resolveAuthorStaticRun, type AuthorPhysicalResolution,
  type AuthorProfileV1, type AuthorRunSpecV2, type AuthorStaticResolution } from '../../src/algorithm/author/run-resolver.js';
import type { ProviderManifest } from '../../src/algorithm/contracts.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import { dshStructuredRoleOperationSchema } from '../../src/algorithm/providers/roles.js';
import { workspaceEditOperationSchema } from '../../src/algorithm/providers/workspace-edit.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(path: string, value: unknown): void { writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`); }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gear-author-a1-resolve-')); roots.push(root);
  const project = join(root, 'project'); const dataset = join(root, 'dataset'); const repository = join(root, 'repository');
  mkdirSync(join(project, 'prompts'), { recursive: true }); mkdirSync(repository);
  await standardSearchDataset(root, 1, 'dataset');
  const originalManifest = readFileSync(join(dataset, 'benchmark.adapter.json'), 'utf8');
  execFileSync('git', ['init', '-q', '-b', 'main', repository]);
  mkdirSync(join(repository, 'harness')); write(join(repository, 'harness', 'agent.txt'), 'initial harness\n');
  execFileSync('git', ['-C', repository, 'add', '.']);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial']);
  const runPath = join(project, 'run.yaml'), profilePath = join(root, 'lab.yaml'), rolesPath = join(project, 'roles.yaml');
  const runtimeConfig = join(root, 'runtime.yaml'), hitchStorage = join(root, 'hitch.yaml');
  const bin = join(root, 'node_modules', '.bin'); const packageBin = join(root, 'node_modules', 'hitch', 'bin');
  mkdirSync(bin, { recursive: true }); mkdirSync(packageBin, { recursive: true });
  const hitchExecutable = join(bin, 'hitch'), hitchTarget = join(packageBin, 'hitch.js');
  const promptPath = join(project, 'prompts', 'optimizer.md');
  write(join(project, 'algorithm.py'), 'from gear_algorithm.author import algorithm\n');
  write(promptPath, 'Edit only the authorized Harness files.\n');
  write(runtimeConfig, { schemaVersion: 1, sampling: { repetitions: 2 } });
  write(hitchTarget, 'fake installed Hitch package bytes');
  symlinkSync(relative(bin, hitchTarget), hitchExecutable);
  write(hitchStorage, 'storage: local\n');
  const run: AuthorRunSpecV2 = { schemaVersion: 2,
    algorithm: { language: 'python', module: './algorithm.py', export: 'search' }, profile: 'lab',
    roles: './roles.yaml', inputs: { initialAgent: { profileAlias: 'initialAgent' },
      searchTasks: { profileAlias: 'searchTasks' } }, config: { rounds: 2 } };
  const profile: AuthorProfileV1 = { schemaVersion: 1, id: 'lab', template: 'local-harness', runtimeConfig,
    workspace: { repository, harnessRoot: 'harness', stateRoot: join(root, 'state') },
    hitch: { executable: hitchExecutable, storageConfig: hitchStorage },
    models: { meta: 'lab-meta', target: 'lab-target' },
    inputs: { initialAgent: { gitRef: 'main' }, searchTasks: { compiledDataset: dataset, purpose: 'development' } },
    roleTemplates: ['harness-editor', 'read-only-analyst'],
    editing: { allowedPaths: ['harness/**'], maxFiles: 20, maxBytes: 262144, maxDiffBytes: 131072 },
    evaluation: { metric: 'pass_rate', passThreshold: 1, requireAllTrialsValid: true },
    operationLimits: { modelRequests: 4, modelTokens: 20000, timeoutMs: 120000 },
    budgetDefaults: { modelRequests: 100, modelTokens: 500000, rolloutTrials: 200 } };
  const roles = { schemaVersion: 1, roles: { optimizer: { template: 'harness-editor', prompt: './prompts/optimizer.md',
    inputSchema: 'sdk:harness-edit-input.v1', resultSchema: 'sdk:harness-edit-result.v1' },
    'my-diagnoser': { template: 'read-only-analyst', prompt: './prompts/optimizer.md',
      inputSchema: 'sdk:analyst-input.v1', resultSchema: 'sdk:analyst-result.v1' } } };
  write(runPath, run); write(profilePath, profile); write(rolesPath, roles);
  return { root, project, runPath, profilePath, rolesPath, promptPath, dataset, originalManifest, runtimeConfig, run, profile, roles };
}
const baseKinds = ['tasks.sample', 'tasks.consume', 'execution.workspace-edit', 'bindings.derive',
  'execution.rollout', 'author.measurement', 'author.checkpoint', 'author.observe', 'execution.role'];
const recordedPhysicalMeters = JSON.parse(readFileSync(new URL('../fixtures/author-a1-physical-provider-meters.json', import.meta.url), 'utf8')) as {
  providers: { kind: string; execution: 'external'; meteredDimensions: string[]; hardLimitDimensions: string[] }[] };
function physical(source: AuthorStaticResolution): AuthorPhysicalResolution {
  const manifest = (kind: string): ProviderManifest => {
    const recorded = recordedPhysicalMeters.providers.find(row => row.kind === kind);
    return { kind, implementationDigest: 'a'.repeat(64),
      execution: recorded?.execution ?? 'trusted-local', supportsInspect: true,
      inputSchema: { type: 'any' }, outputSchema: { type: 'any' },
      meteredDimensions: recorded?.meteredDimensions ?? [],
      hardLimitDimensions: recorded?.hardLimitDimensions ?? [] };
  };
  const schema = (role: AuthorStaticResolution['roles'][number], side: 'input' | 'result') =>
    role.template === 'harness-editor' ? workspaceEditOperationSchema(side) : dshStructuredRoleOperationSchema(side);
  const roleSchemas = Object.fromEntries(source.roles.map(role => [role.name, {
    input: { id: role.inputSchema, schema: role.schemaFiles.input?.schema ?? schema(role, 'input'),
      sourceDigest: role.schemaFiles.input?.sha256 ?? jsonDigest(schema(role, 'input')) },
    result: { id: role.resultSchema, schema: role.schemaFiles.result?.schema ?? schema(role, 'result'),
      sourceDigest: role.schemaFiles.result?.sha256 ?? jsonDigest(schema(role, 'result')) },
  }]));
  return { sourceClosureDigest: source.source.moduleTreeDigest, runtimeConfigDigest: source.source.runtimeConfigDigest,
    algorithm: { definitionDigest: 'b'.repeat(64), environmentDigest: '6'.repeat(64), requiredKinds: [],
      configSchema: { type: 'object', required: ['rounds'],
        properties: { rounds: { type: 'integer' } }, additionalProperties: false } },
    git: { commit: execFileSync('git', ['-C', source.profile.workspace.repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['-C', source.profile.workspace.repository, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
      manifestDigest: `sha256:${'e'.repeat(64)}` },
    dataset: { schemaVersion: 1, digest: `sha256:${'f'.repeat(64)}`, taskIds: source.datasetTaskIds, purpose: 'development' },
    models: { meta: { alias: 'lab-meta', provider: 'fake', model: 'm1', destinationDigest: '1'.repeat(64) },
      target: { alias: 'lab-target', provider: 'fake', model: 'm2', destinationDigest: '2'.repeat(64) } },
    hitch: { executableDigest: source.source.hitchExecutableDigest, storageDigest: source.source.hitchStorageDigest,
      capabilityDigest: '3'.repeat(64), daemon: true },
    execution: { environmentDigest: '4'.repeat(64), samplingDigest: '5'.repeat(64), unseededRepetitions: true },
    providerManifests: baseKinds.map(manifest),
    budgetSources: { 'model.requests': 'model', 'model.tokens': 'model', 'rollout.trials': 'rollout' },
    budgetPlan: { 'model.requests': { unit: 'call', limit: 100, source: 'model', capability: 'stop' },
      'model.tokens': { unit: 'token', limit: 500000, source: 'model', capability: 'stop' },
      'rollout.trials': { unit: 'trial', limit: 200, source: 'rollout', capability: 'stop' } },
    providerMeters: recordedPhysicalMeters.providers.map(row => ({ kind: row.kind,
      source: row.kind === 'execution.rollout' ? 'rollout' : 'model', dimensions: row.meteredDimensions })),
    roleSchemas, editScopeEnforced: true };
}

it('resolves arbitrary allowed role names and prompt bytes into the same check/explain lock candidate without effects', async () => {
  const item = await fixture(); let reads = 0;
  const inspector = { inspect: (source: AuthorStaticResolution) => { reads++; return physical(source); } };
  const checked = await checkAuthorRun({ runPath: item.runPath, profilePath: item.profilePath, inspector });
  const explained = await explainAuthorRun({ runPath: item.runPath, profilePath: item.profilePath, inspector });
  expect(reads).toBe(2);
  expect(checked.lockDigest).toBe(explained.resolved.lockDigest);
  expect(checked.static.roles.map(role => role.name)).toEqual(['my-diagnoser', 'optimizer']);
  expect(explained.text).toContain('my-diagnoser -> read-only-analyst');
  expect(checked.static.roles[1]!.prompt.text).toBe(readFileSync(item.promptPath, 'utf8'));
  expect(checked.requiredKinds).toContain('execution.role');
  expect(checked.metering.profileDimensions).toEqual({ modelRequests: 'model.requests',
    modelTokens: 'model.tokens', rolloutTrials: 'rollout.trials' });
  expect(checked.metering.operationLimits['execution.workspace-edit']).toEqual({
    'model.requests': 4, 'model.tokens': 20000 });
  expect(checked.metering.operationLimits['execution.rollout']).toEqual({ 'rollout.trials': 1 });
  write(item.promptPath, 'New prompt bytes\n');
  const changed = await checkAuthorRun({ runPath: item.runPath, profilePath: item.profilePath, inspector });
  expect(changed.lockDigest).not.toBe(checked.lockDigest);
});

it('rejects bad roles, source paths, grants, limits and unsupported task/sampling inputs before inspection', async () => {
  const item = await fixture();
  item.roles.roles.optimizer.template = 'not-granted'; write(item.rolesPath, item.roles);
  expect(() => resolveAuthorStaticRun(item)).toThrow('template not granted');
  item.roles.roles.optimizer.template = 'harness-editor'; write(item.rolesPath, item.roles);
  item.profile.editing.allowedPaths = ['../secrets/**']; write(item.profilePath, item.profile);
  expect(() => resolveAuthorStaticRun(item)).toThrow('Editing path grant unsupported');
  item.profile.editing.allowedPaths = ['harness/**']; item.profile.operationLimits.modelRequests = 0;
  write(item.profilePath, item.profile);
  expect(() => resolveAuthorStaticRun(item)).toThrow('positive safe integer');
  item.profile.operationLimits.modelRequests = 4; write(item.profilePath, item.profile);
  item.run.algorithm.module = '../outside.py'; write(item.runPath, item.run);
  expect(() => resolveAuthorStaticRun(item)).toThrow('safe relative path');
  item.run.algorithm.module = './algorithm.py'; write(item.runPath, item.run);
  write(join(item.dataset, 'benchmark.adapter.json'), { schema_version: '2', kind: 'gear-harbor-benchmark', tasks: [{ task_id: 'task1' }] });
  expect(() => resolveAuthorStaticRun(item)).toThrow('compiled dataset schema v1 only');
  write(join(item.dataset, 'benchmark.adapter.json'), item.originalManifest);
  const numericTask = JSON.parse(item.originalManifest) as { tasks: { task_id: string }[] };
  numericTask.tasks[0]!.task_id = '1-task'; write(join(item.dataset, 'benchmark.adapter.json'), numericTask);
  expect(resolveAuthorStaticRun(item).datasetTaskIds).toEqual(['1-task']);
  write(join(item.dataset, 'benchmark.adapter.json'), item.originalManifest);
  write(item.runtimeConfig, { schemaVersion: 1, sampling: { temperature: 0.4 } });
  expect(() => resolveAuthorStaticRun(item)).toThrow('sampling unsupported');
});

it('fails closed when physical model, provider, budget or role-schema resolution is incomplete', async () => {
  const item = await fixture(); const source = resolveAuthorStaticRun(item);
  const inspect = async (edit: (value: AuthorPhysicalResolution) => void) => {
    const value = physical(source); edit(value);
    await expect(checkAuthorRun({ runPath: item.runPath, profilePath: item.profilePath,
      inspector: { inspect: () => value } })).rejects.toThrow();
  };
  await inspect(value => { value.models.meta.alias = 'unregistered'; });
  await inspect(value => { delete (value.models as Partial<typeof value.models>).target; });
  await inspect(value => { value.providerManifests = value.providerManifests.filter(row => row.kind !== 'author.measurement'); });
  await inspect(value => { value.algorithm.requiredKinds = ['my-metric.compute']; });
  await inspect(value => { value.providerManifests[0]!.outputSchema = { type: 'number', exclusiveMinimum: 0 } as never; });
  await inspect(value => { value.providerManifests[0]!.supportsInspect = false as never; });
  await inspect(value => { value.providerManifests[0]!.hardLimitDimensions = ['unmetered']; });
  await inspect(value => { value.providerManifests.find(row => row.kind === 'tasks.sample')!.meteredDimensions = ['model.requests']; });
  await inspect(value => { value.providerManifests.find(row => row.kind === 'tasks.consume')!.meteredDimensions = ['rollout.trials']; });
  await inspect(value => { value.providerManifests.find(row => row.kind === 'author.measurement')!.hardLimitDimensions = ['model.requests']; });
  await inspect(value => { value.budgetSources['model.requests'] = 'unmetered'; });
  await inspect(value => { value.budgetPlan['model.tokens']!.limit = 2; });
  await inspect(value => { value.providerMeters[0]!.dimensions = ['modelRequests', 'modelTokens']; });
  await inspect(value => { value.budgetPlan.modelRequests = value.budgetPlan['model.requests']!; });
  await inspect(value => { value.roleSchemas['my-diagnoser']!.input.id = 'different'; });
  await inspect(value => { value.roleSchemas['my-diagnoser']!.input.schema = { type: 'object', additionalProperties: true }; });
  await inspect(value => { value.editScopeEnforced = false as never; });
  await inspect(value => { value.algorithm.configSchema = { type: 'string' }; });
});

it('rejects unknown SDK role aliases before inspection, and self-attested replacement schemas', async () => {
  const item = await fixture();
  item.roles.roles['my-diagnoser'].inputSchema = 'sdk:analyst-input.typo';
  write(item.rolesPath, item.roles);
  expect(() => resolveAuthorStaticRun(item)).toThrow('SDK schema unsupported');
  item.roles.roles['my-diagnoser'].inputSchema = 'sdk:harness-edit-input.v1';
  write(item.rolesPath, item.roles);
  expect(() => resolveAuthorStaticRun(item)).toThrow('SDK schema unsupported');
  item.roles.roles['my-diagnoser'].inputSchema = 'sdk:analyst-input.v1';
  write(item.rolesPath, item.roles);
  const source = resolveAuthorStaticRun(item), forged = physical(source);
  const replacement = { type: 'object' as const, additionalProperties: true as const };
  forged.roleSchemas.optimizer!.input = { id: 'sdk:harness-edit-input.v1', schema: replacement,
    sourceDigest: jsonDigest(replacement) };
  await expect(checkAuthorRun({ runPath: item.runPath, profilePath: item.profilePath,
    inspector: { inspect: () => forged } })).rejects.toThrow('SDK schema identity invalid');
});

it('freezes a custom analyst schema file and rejects schema bytes changed during inspection', async () => {
  const item = await fixture();
  mkdirSync(join(item.project, 'schemas'));
  const schemaPath = join(item.project, 'schemas', 'diagnostic.json');
  write(schemaPath, { type: 'object', required: ['goal'], properties: { goal: { type: 'string' } }, additionalProperties: false });
  item.roles.roles['my-diagnoser'].inputSchema = './schemas/diagnostic.json'; write(item.rolesPath, item.roles);
  const source = resolveAuthorStaticRun(item);
  expect(source.roles[0]!.schemaFiles.input?.sha256).toHaveLength(64);
  const checked = await checkAuthorRun({ runPath: item.runPath, profilePath: item.profilePath,
    inspector: { inspect: physical } });
  expect(checked.physical.roleSchemas['my-diagnoser']!.input.schema).toEqual(source.roles[0]!.schemaFiles.input?.schema);
  await expect(checkAuthorRun({ runPath: item.runPath, profilePath: item.profilePath,
    inspector: { inspect: current => {
      write(schemaPath, { type: 'object', additionalProperties: false });
      return physical(current);
    } } })).rejects.toThrow('sources changed while inspecting');
});

it('rejects a prompt changed during the read-only physical inspection before publishing a lock candidate', async () => {
  const item = await fixture();
  await expect(checkAuthorRun({ runPath: item.runPath, profilePath: item.profilePath,
    inspector: { inspect: source => { write(item.promptPath, 'Prompt changed after static read\n'); return physical(source); } } }))
    .rejects.toThrow('sources changed while inspecting');
});

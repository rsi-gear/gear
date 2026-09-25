import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import type { JsonSchema, JsonValue } from '../schema.js';
import { assertJson, assertSchema, canonicalJson, jsonDigest, validateSchema } from '../schema.js';
import type { BudgetPlan, ProviderManifest } from '../contracts.js';
import { authorSourceClosureDigest } from './identity.js';
import { isExactGitCommit } from '../../types.js';
import { validateProviderManifest } from '../runtime/provider-manifest.js';
import { dshStructuredRoleOperationSchema } from '../providers/roles.js';
import { workspaceEditOperationSchema } from '../providers/workspace-edit.js';

export type AuthorRunSpecV2 = {
  schemaVersion: 2;
  algorithm: { language: 'python' | 'typescript'; module: string; export: string };
  profile: string;
  roles: string;
  inputs: { initialAgent: { profileAlias: 'initialAgent' }; searchTasks: { profileAlias: 'searchTasks' } };
  config: JsonValue;
};
export type AuthorProfileV1 = {
  schemaVersion: 1; id: string; template: 'local-harness'; runtimeConfig: string;
  workspace: { repository: string; harnessRoot: string; stateRoot: string };
  hitch: { executable: string; storageConfig: string };
  models: { meta: string; target: string };
  inputs: { initialAgent: { gitRef: string }; searchTasks: { compiledDataset: string; purpose: 'development' } };
  roleTemplates: ('harness-editor' | 'read-only-analyst')[];
  editing: { allowedPaths: string[]; maxFiles: number; maxBytes: number; maxDiffBytes: number };
  evaluation: { metric: string; passThreshold: number; requireAllTrialsValid: boolean };
  operationLimits: { modelRequests: number; modelTokens: number; timeoutMs: number };
  budgetDefaults: { modelRequests: number; modelTokens: number; rolloutTrials: number };
};
export type AuthorRoleV1 = { template: 'harness-editor' | 'read-only-analyst'; prompt: string;
  inputSchema: string; resultSchema: string };
export type AuthorRolesV1 = { schemaVersion: 1; roles: Record<string, AuthorRoleV1> };
export type FrozenAuthorSchemaFile = { path: string; sha256: string; schema: JsonSchema };
export type FrozenAuthorRoleV1 = Omit<AuthorRoleV1, 'prompt'> & { name: string;
  prompt: { path: string; sha256: string; text: string };
  schemaFiles: { input?: FrozenAuthorSchemaFile; result?: FrozenAuthorSchemaFile } };
export type AuthorStaticResolution = {
  runPath: string; profilePath: string; sourceRoot: string; modulePath: string;
  run: AuthorRunSpecV2; profile: AuthorProfileV1; roles: FrozenAuthorRoleV1[];
  source: { runDigest: string; profileDigest: string; rolesDigest: string; moduleTreeDigest: string;
    runtimeConfigDigest: string; datasetManifestDigest: string; hitchExecutableDigest: string; hitchStorageDigest: string };
  datasetTaskIds: string[];
};

/** A future physical host implements this read-only admission boundary; it must never submit work. */
export interface AuthorCapabilityInspector {
  inspect(input: AuthorStaticResolution): Promise<AuthorPhysicalResolution> | AuthorPhysicalResolution;
}
export type AuthorPhysicalResolution = {
  sourceClosureDigest: string; runtimeConfigDigest: string;
  algorithm: { definitionDigest: string; environmentDigest: string; configSchema: JsonSchema;
    /** Literal custom ctx.operation kinds found in the frozen author source. */
    requiredKinds: string[] };
  git: { commit: string; tree: string; manifestDigest: string };
  dataset: { schemaVersion: 1; digest: string; taskIds: string[]; purpose: 'development' };
  models: { meta: { alias: string; provider: string; model: string; destinationDigest: string };
    target: { alias: string; provider: string; model: string; destinationDigest: string } };
  hitch: { executableDigest: string; storageDigest: string; capabilityDigest: string; daemon: true };
  execution: { environmentDigest: string; samplingDigest: string; unseededRepetitions: true };
  providerManifests: ProviderManifest[];
  budgetSources: { 'model.requests': string; 'model.tokens': string; 'rollout.trials': string };
  budgetPlan: BudgetPlan;
  providerMeters: { kind: string; source: string; dimensions: string[] }[];
  roleSchemas: Record<string, { input: { id: string; schema: JsonSchema; sourceDigest: string };
    result: { id: string; schema: JsonSchema; sourceDigest: string } }>;
  editScopeEnforced: true;
};
export type ResolvedAuthorRun = { schemaVersion: 1; kind: 'author.run.lock.candidate.v1';
  static: AuthorStaticResolution; physical: AuthorPhysicalResolution; requiredKinds: string[];
  metering: { profileDimensions: { modelRequests: 'model.requests'; modelTokens: 'model.tokens';
    rolloutTrials: 'rollout.trials' }; operationLimits: {
      'execution.role': { 'model.requests': number; 'model.tokens': number };
      'execution.workspace-edit': { 'model.requests': number; 'model.tokens': number };
      'execution.rollout': { 'rollout.trials': 1 };
    }; operationTimeoutMs: number };
  lockDigest: string };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], label: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} required`);
  for (const key of Object.keys(value)) if (!required.includes(key)) throw new Error(`${label}.${key} unsupported`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} required`);
  return value;
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} needs positive safe integer`);
  return value as number;
}
/** Controller/CAS identity uses a bare SHA-256 hex digest. */
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} needs SHA-256 digest`);
  return value;
}
/** Gear dataset and Harness manifest identities use the namespaced digestJson/digestDatasetRef form. */
function gearDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
    throw new Error(`${label} needs sha256: digest`);
  return value;
}
function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)
    || value === '.' || value === '..') throw new Error('Dataset task ID invalid');
  return value;
}
function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function contained(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}
function boundedRead(path: string, maxBytes: number, label: string): Buffer {
  if (statSync(path).size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  const fd = openSync(path, 'r'); const chunks: Buffer[] = []; let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (size === 0) break;
      total += size;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, size));
    }
  } finally { closeSync(fd); }
  return Buffer.concat(chunks, total);
}
function regular(path: string, label: string, maxBytes = 4 * 1024 * 1024): { path: string; bytes: Buffer; sha256: string } {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} symlink is not a frozen source`);
  const real = realpathSync(path);
  if (!lstatSync(real).isFile()) throw new Error(`${label} must be a regular file`);
  const bytes = boundedRead(real, maxBytes, label);
  return { path: real, bytes, sha256: hash(bytes) };
}
function executable(named: string): { path: string; sha256: string } {
  const path = resolve(named); const info = lstatSync(path);
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error('Hitch executable must resolve to a file');
  const target = realpathSync(path);
  if (!lstatSync(target).isFile()) throw new Error('Hitch executable target must be a regular file');
  const bytesDigest = hash(boundedRead(target, 64 * 1024 * 1024, 'Hitch executable'));
  return { path, sha256: jsonDigest({ link: info.isSymbolicLink() ? readlinkSync(path) : null,
    resolvedTarget: target, bytesDigest }) };
}
function closedFile(root: string, base: string, named: string, label: string, maxBytes?: number): ReturnType<typeof regular> {
  const path = resolve(base, text(named, label));
  const file = regular(path, label, maxBytes);
  if (!contained(root, file.path)) throw new Error(`${label} escapes author source root`);
  return file;
}
function yaml(path: string, label: string): { value: unknown; sha256: string; path: string } {
  const file = regular(path, label, 1024 * 1024);
  const value: unknown = loadYaml(file.bytes.toString('utf8'), { schema: JSON_SCHEMA, filename: file.path });
  assertJson(value);
  return { value, sha256: file.sha256, path: file.path };
}
function pathString(value: unknown, label: string): string {
  const named = text(value, label);
  if (!isAbsolute(named)) throw new Error(`${label} must be absolute`);
  return named;
}
function relativeRoot(value: unknown, label: string): string {
  const named = text(value, label);
  const trimmed = named.startsWith('./') ? named.slice(2) : named;
  if (isAbsolute(named) || !trimmed || trimmed.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..')
    || trimmed.includes('\\')) throw new Error(`${label} must be a safe relative path`);
  return trimmed;
}
function name(value: unknown, label: string): string {
  const named = text(value, label);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(named)) throw new Error(`${label} name invalid`);
  return named;
}
function sdkRoleSchema(template: AuthorRoleV1['template'], side: 'input' | 'result', id: string): JsonSchema {
  const expected = template === 'harness-editor' ? `sdk:harness-edit-${side}.v1` : `sdk:analyst-${side}.v1`;
  if (id !== expected) throw new Error(`Role ${template} ${side} SDK schema unsupported: ${id}`);
  return template === 'harness-editor' ? workspaceEditOperationSchema(side) : dshStructuredRoleOperationSchema(side);
}

export function parseAuthorRunSpec(value: unknown): AuthorRunSpecV2 {
  assertJson(value); const run = object(value, 'RunSpec');
  exact(run, ['schemaVersion', 'algorithm', 'profile', 'roles', 'inputs', 'config'], 'RunSpec');
  if (run.schemaVersion !== 2) throw new Error('RunSpec schemaVersion 2 required');
  const algorithm = object(run.algorithm, 'RunSpec.algorithm');
  exact(algorithm, ['language', 'module', 'export'], 'RunSpec.algorithm');
  if (algorithm.language !== 'python' && algorithm.language !== 'typescript') throw new Error('Algorithm language unsupported');
  relativeRoot(algorithm.module, 'RunSpec.algorithm.module');
  name(algorithm.export, 'RunSpec.algorithm.export');
  name(run.profile, 'RunSpec.profile');
  relativeRoot(run.roles, 'RunSpec.roles');
  const inputs = object(run.inputs, 'RunSpec.inputs');
  exact(inputs, ['initialAgent', 'searchTasks'], 'RunSpec.inputs');
  for (const alias of ['initialAgent', 'searchTasks'] as const) {
    const item = object(inputs[alias], `RunSpec.inputs.${alias}`);
    exact(item, ['profileAlias'], `RunSpec.inputs.${alias}`);
    if (item.profileAlias !== alias) throw new Error(`RunSpec.inputs.${alias} alias unsupported`);
  }
  return structuredClone(value) as AuthorRunSpecV2;
}

export function parseAuthorProfile(value: unknown): AuthorProfileV1 {
  assertJson(value); const profile = object(value, 'Profile');
  exact(profile, ['schemaVersion', 'id', 'template', 'runtimeConfig', 'workspace', 'hitch', 'models', 'inputs',
    'roleTemplates', 'editing', 'evaluation', 'operationLimits', 'budgetDefaults'], 'Profile');
  if (profile.schemaVersion !== 1 || profile.template !== 'local-harness') throw new Error('Profile local-harness v1 required');
  name(profile.id, 'Profile.id'); pathString(profile.runtimeConfig, 'Profile.runtimeConfig');
  const workspace = object(profile.workspace, 'Profile.workspace');
  exact(workspace, ['repository', 'harnessRoot', 'stateRoot'], 'Profile.workspace');
  pathString(workspace.repository, 'Profile.workspace.repository');
  relativeRoot(workspace.harnessRoot, 'Profile.workspace.harnessRoot');
  pathString(workspace.stateRoot, 'Profile.workspace.stateRoot');
  const hitch = object(profile.hitch, 'Profile.hitch');
  exact(hitch, ['executable', 'storageConfig'], 'Profile.hitch');
  pathString(hitch.executable, 'Profile.hitch.executable'); pathString(hitch.storageConfig, 'Profile.hitch.storageConfig');
  const models = object(profile.models, 'Profile.models'); exact(models, ['meta', 'target'], 'Profile.models');
  name(models.meta, 'Profile.models.meta'); name(models.target, 'Profile.models.target');
  const inputs = object(profile.inputs, 'Profile.inputs'); exact(inputs, ['initialAgent', 'searchTasks'], 'Profile.inputs');
  const initial = object(inputs.initialAgent, 'Profile.inputs.initialAgent');
  exact(initial, ['gitRef'], 'Profile.inputs.initialAgent'); text(initial.gitRef, 'Profile.inputs.initialAgent.gitRef');
  const tasks = object(inputs.searchTasks, 'Profile.inputs.searchTasks');
  exact(tasks, ['compiledDataset', 'purpose'], 'Profile.inputs.searchTasks');
  pathString(tasks.compiledDataset, 'Profile.inputs.searchTasks.compiledDataset');
  if (tasks.purpose !== 'development') throw new Error('A1 search tasks require development purpose');
  if (!Array.isArray(profile.roleTemplates) || profile.roleTemplates.length === 0
    || new Set(profile.roleTemplates).size !== profile.roleTemplates.length
    || profile.roleTemplates.some(template => template !== 'harness-editor' && template !== 'read-only-analyst'))
    throw new Error('Profile.roleTemplates unsupported');
  const editing = object(profile.editing, 'Profile.editing');
  exact(editing, ['allowedPaths', 'maxFiles', 'maxBytes', 'maxDiffBytes'], 'Profile.editing');
  if (!Array.isArray(editing.allowedPaths) || editing.allowedPaths.length === 0
    || new Set(editing.allowedPaths).size !== editing.allowedPaths.length) throw new Error('Profile.editing.allowedPaths invalid');
  const harnessRoot = workspace.harnessRoot as string;
  for (const raw of editing.allowedPaths) {
    const allowed = text(raw, 'Profile.editing.allowedPaths');
    if (allowed !== harnessRoot && !allowed.startsWith(`${harnessRoot}/`)
      || allowed.split('/').some(segment => !segment || segment === '.' || segment === '..')
      || !/^[A-Za-z0-9_./*-]+$/.test(allowed)
      || allowed.includes('*') && !allowed.endsWith('/**')) throw new Error(`Editing path grant unsupported: ${allowed}`);
  }
  positive(editing.maxFiles, 'Profile.editing.maxFiles'); positive(editing.maxBytes, 'Profile.editing.maxBytes');
  positive(editing.maxDiffBytes, 'Profile.editing.maxDiffBytes');
  const evaluation = object(profile.evaluation, 'Profile.evaluation');
  exact(evaluation, ['metric', 'passThreshold', 'requireAllTrialsValid'], 'Profile.evaluation');
  name(evaluation.metric, 'Profile.evaluation.metric');
  if (typeof evaluation.passThreshold !== 'number' || !Number.isFinite(evaluation.passThreshold)
    || evaluation.passThreshold < 0 || evaluation.passThreshold > 1 || evaluation.requireAllTrialsValid !== true)
    throw new Error('A1 evaluation requires supported pass threshold and all-valid policy');
  const limits = object(profile.operationLimits, 'Profile.operationLimits');
  exact(limits, ['modelRequests', 'modelTokens', 'timeoutMs'], 'Profile.operationLimits');
  for (const [key, limit] of Object.entries(limits)) positive(limit, `Profile.operationLimits.${key}`);
  const budgets = object(profile.budgetDefaults, 'Profile.budgetDefaults');
  exact(budgets, ['modelRequests', 'modelTokens', 'rolloutTrials'], 'Profile.budgetDefaults');
  for (const [key, limit] of Object.entries(budgets)) positive(limit, `Profile.budgetDefaults.${key}`);
  return structuredClone(value) as AuthorProfileV1;
}

export function parseAuthorRoles(value: unknown, profile: AuthorProfileV1): AuthorRolesV1 {
  assertJson(value); const catalog = object(value, 'Roles'); exact(catalog, ['schemaVersion', 'roles'], 'Roles');
  if (catalog.schemaVersion !== 1) throw new Error('Roles schemaVersion 1 required');
  const roles = object(catalog.roles, 'Roles.roles');
  if (Object.keys(roles).length === 0) throw new Error('At least one role required');
  for (const [id, raw] of Object.entries(roles)) {
    name(id, 'Role'); const role = object(raw, `Roles.roles.${id}`);
    exact(role, ['template', 'prompt', 'inputSchema', 'resultSchema'], `Roles.roles.${id}`);
    if (role.template !== 'harness-editor' && role.template !== 'read-only-analyst'
      || !profile.roleTemplates.includes(role.template)) throw new Error(`Role ${id} template not granted`);
    relativeRoot(role.prompt, `Role ${id} prompt`);
    const inputSchema = text(role.inputSchema, `Role ${id} inputSchema`);
    const resultSchema = text(role.resultSchema, `Role ${id} resultSchema`);
    for (const [side, schema] of [['input', inputSchema], ['result', resultSchema]] as const)
      if (schema.startsWith('sdk:')) sdkRoleSchema(role.template, side, schema);
      else relativeRoot(schema, `Role ${id} ${side} schema`);
    if (role.template === 'harness-editor' && (role.inputSchema !== 'sdk:harness-edit-input.v1'
      || role.resultSchema !== 'sdk:harness-edit-result.v1')) throw new Error(`Role ${id} editor SDK schema unsupported`);
  }
  return structuredClone(value) as AuthorRolesV1;
}

/** Static source/profile resolution does no model, rollout, provider submit or state writes. */
export function resolveAuthorStaticRun(options: { runPath: string; profilePath: string }): AuthorStaticResolution {
  const runFile = yaml(options.runPath, 'RunSpec file');
  const sourceRoot = realpathSync(dirname(runFile.path));
  const run = parseAuthorRunSpec(runFile.value);
  const profileFile = yaml(options.profilePath, 'Profile file');
  const profile = parseAuthorProfile(profileFile.value);
  if (profile.id !== run.profile) throw new Error('RunSpec profile alias does not match selected profile');
  const module = closedFile(sourceRoot, sourceRoot, run.algorithm.module, 'Algorithm module');
  if (!module.path.endsWith(run.algorithm.language === 'python' ? '.py' : '.ts'))
    throw new Error('Algorithm module extension does not match language');
  const rolesFile = closedFile(sourceRoot, sourceRoot, run.roles, 'Roles file', 1024 * 1024);
  const roleSource = yaml(rolesFile.path, 'Roles file');
  const roles = parseAuthorRoles(roleSource.value, profile);
  const frozenRoles = Object.entries(roles.roles).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([id, role]): FrozenAuthorRoleV1 => {
      const prompt = closedFile(sourceRoot, dirname(rolesFile.path), role.prompt, `Role ${id} prompt`, 64 * 1024);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(prompt.bytes);
      if (!content.trim()) throw new Error(`Role ${id} prompt empty`);
      const schemaFile = (named: string, side: string): FrozenAuthorSchemaFile | undefined => {
        if (named.startsWith('sdk:')) return undefined;
        const file = closedFile(sourceRoot, dirname(rolesFile.path), named, `Role ${id} ${side} schema`, 64 * 1024);
        const parsed: unknown = loadYaml(file.bytes.toString('utf8'), { schema: JSON_SCHEMA, filename: file.path });
        assertJson(parsed); assertSchema(parsed as JsonSchema);
        return { path: file.path, sha256: file.sha256, schema: parsed as JsonSchema };
      };
      const input = schemaFile(role.inputSchema, 'input'); const result = schemaFile(role.resultSchema, 'result');
      return { name: id, template: role.template, inputSchema: role.inputSchema, resultSchema: role.resultSchema,
        prompt: { path: prompt.path, sha256: prompt.sha256, text: content },
        schemaFiles: { ...(input ? { input } : {}), ...(result ? { result } : {}) } };
    });
  const datasetManifest = regular(join(profile.inputs.searchTasks.compiledDataset, 'benchmark.adapter.json'),
    'Compiled dataset manifest', 1024 * 1024);
  const dataset = JSON.parse(datasetManifest.bytes.toString('utf8')) as unknown;
  assertJson(dataset); const manifest = object(dataset, 'Compiled dataset manifest');
  if (manifest.schema_version !== '1' || manifest.kind !== 'gear-harbor-benchmark'
    || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0)
    throw new Error('A1 supports compiled dataset schema v1 only');
  const ids = manifest.tasks.map((raw, index) => {
    const task = object(raw, `Dataset.task.${index}`);
    gearDigest(task.task_digest, `Dataset.task.${index}.task_digest`);
    return taskId(task.task_id);
  });
  if (new Set(ids).size !== ids.length) throw new Error('Compiled dataset task IDs repeated');
  const runtimeConfig = regular(profile.runtimeConfig, 'Runtime config', 1024 * 1024);
  const runtime = loadYaml(runtimeConfig.bytes.toString('utf8'), { schema: JSON_SCHEMA, filename: runtimeConfig.path });
  assertJson(runtime); const settings = object(runtime, 'Runtime config');
  if (Object.hasOwn(settings, 'recipe') || Object.hasOwn(settings, 'spec'))
    throw new Error('Legacy recipe/EvolutionSpec cannot serve as A1 runtime config');
  const sampling = settings.sampling === undefined ? undefined : object(settings.sampling, 'Runtime config sampling');
  if (sampling && (sampling.seed !== undefined || sampling.temperature !== undefined))
    throw new Error('Seeded/temperature Hitch sampling unsupported in A1');
  const hitchExecutable = executable(profile.hitch.executable);
  const hitchStorage = regular(profile.hitch.storageConfig, 'Hitch storage config', 1024 * 1024);
  const sourceTreeDigest = authorSourceClosureDigest(sourceRoot);
  const stable = (path: string, expected: string, label: string, maxBytes?: number) => {
    if (regular(path, label, maxBytes).sha256 !== expected) throw new Error(`${label} changed while resolving run`);
  };
  stable(runFile.path, runFile.sha256, 'RunSpec file', 1024 * 1024);
  stable(profileFile.path, profileFile.sha256, 'Profile file', 1024 * 1024);
  stable(rolesFile.path, roleSource.sha256, 'Roles file', 1024 * 1024);
  stable(runtimeConfig.path, runtimeConfig.sha256, 'Runtime config', 1024 * 1024);
  stable(datasetManifest.path, datasetManifest.sha256, 'Compiled dataset manifest', 1024 * 1024);
  if (executable(hitchExecutable.path).sha256 !== hitchExecutable.sha256)
    throw new Error('Hitch executable changed while resolving run');
  stable(hitchStorage.path, hitchStorage.sha256, 'Hitch storage config', 1024 * 1024);
  for (const role of frozenRoles) stable(role.prompt.path, role.prompt.sha256, `Role ${role.name} prompt`, 64 * 1024);
  for (const role of frozenRoles) for (const schema of Object.values(role.schemaFiles))
    stable(schema.path, schema.sha256, `Role ${role.name} schema`, 64 * 1024);
  if (authorSourceClosureDigest(sourceRoot) !== sourceTreeDigest) throw new Error('Author source tree changed while resolving run');
  return { runPath: runFile.path, profilePath: profileFile.path, sourceRoot, modulePath: module.path,
    run, profile, roles: frozenRoles, datasetTaskIds: ids, source: { runDigest: runFile.sha256,
      profileDigest: profileFile.sha256, rolesDigest: roleSource.sha256,
      moduleTreeDigest: sourceTreeDigest, runtimeConfigDigest: runtimeConfig.sha256,
      datasetManifestDigest: datasetManifest.sha256, hitchExecutableDigest: hitchExecutable.sha256,
      hitchStorageDigest: hitchStorage.sha256 } };
}

const baseKinds = ['tasks.sample', 'tasks.consume', 'execution.workspace-edit', 'bindings.derive',
  'execution.rollout', 'author.measurement', 'author.checkpoint', 'author.observe'];
const profileBudgetDimensions = { modelRequests: 'model.requests', modelTokens: 'model.tokens',
  rolloutTrials: 'rollout.trials' } as const;

/** check, explain and eventual run share this resolver; no physical operation can be submitted here. */
export async function resolveAuthorRun(options: { runPath: string; profilePath: string; inspector: AuthorCapabilityInspector }): Promise<ResolvedAuthorRun> {
  const source = resolveAuthorStaticRun(options);
  const physical = await options.inspector.inspect(structuredClone(source));
  if (physical.sourceClosureDigest !== source.source.moduleTreeDigest
    || physical.runtimeConfigDigest !== source.source.runtimeConfigDigest)
    throw new Error('Author package/runtime source identity changed during check');
  digest(physical.algorithm.definitionDigest, 'Algorithm definition');
  digest(physical.algorithm.environmentDigest, 'Algorithm environment');
  assertSchema(physical.algorithm.configSchema);
  validateSchema(physical.algorithm.configSchema, source.run.config);
  if (!Array.isArray(physical.algorithm.requiredKinds) || new Set(physical.algorithm.requiredKinds).size !== physical.algorithm.requiredKinds.length
    || physical.algorithm.requiredKinds.some(kind => !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(kind)
      || /^author\.(?:role|edit|rollout|measure)$/.test(kind)))
    throw new Error('Algorithm literal operation kinds invalid');
  if (!isExactGitCommit(physical.git.commit) || !isExactGitCommit(physical.git.tree))
    throw new Error('Git commit/tree OID invalid');
  gearDigest(physical.git.manifestDigest, 'Git harness manifest');
  if (physical.dataset.schemaVersion !== 1 || physical.dataset.purpose !== 'development'
    || canonicalJson(physical.dataset.taskIds) !== canonicalJson(source.datasetTaskIds))
    throw new Error('Compiled dataset identity/purpose unsupported');
  gearDigest(physical.dataset.digest, 'Compiled dataset');
  if (Object.keys(physical.models).sort().join(',') !== 'meta,target')
    throw new Error('Model registration must resolve exact meta/target destinations');
  for (const [kind, model] of Object.entries(physical.models)) {
    if (model.alias !== source.profile.models[kind as 'meta' | 'target'] || !model.provider || !model.model)
      throw new Error(`Model ${kind} alias/registration unresolved`);
    digest(model.destinationDigest, `Model ${kind} destination`);
  }
  if (physical.hitch.executableDigest !== source.source.hitchExecutableDigest
    || physical.hitch.storageDigest !== source.source.hitchStorageDigest || physical.hitch.daemon !== true)
    throw new Error('Hitch executable/storage/daemon capability unresolved');
  digest(physical.hitch.capabilityDigest, 'Hitch capability');
  if (physical.execution.unseededRepetitions !== true) throw new Error('Unseeded Hitch repetitions unsupported');
  digest(physical.execution.environmentDigest, 'Execution environment');
  digest(physical.execution.samplingDigest, 'Execution sampling');
  if (physical.editScopeEnforced !== true) throw new Error('Workspace allowedPaths enforcement unavailable');
  if (Object.keys(physical.roleSchemas).sort().join(',') !== source.roles.map(role => role.name).sort().join(','))
    throw new Error('Physical role schema instances do not match declared roles');
  for (const role of source.roles) {
    const resolved = physical.roleSchemas[role.name]!;
    for (const side of ['input', 'result'] as const) {
      const id = side === 'input' ? role.inputSchema : role.resultSchema;
      const actual = resolved[side];
      if (!actual || actual.id !== id) throw new Error(`Role ${role.name} ${side} schema identity drift`);
      digest(actual.sourceDigest, `Role ${role.name} ${side} schema source`);
      assertSchema(actual.schema);
      const authorFile = role.schemaFiles[side];
      if (authorFile && (actual.sourceDigest !== authorFile.sha256
        || canonicalJson(actual.schema) !== canonicalJson(authorFile.schema)))
        throw new Error(`Role ${role.name} ${side} schema file changed`);
      if (!authorFile) {
        const trusted = sdkRoleSchema(role.template, side, id);
        if (actual.sourceDigest !== jsonDigest(trusted)
          || canonicalJson(actual.schema) !== canonicalJson(trusted))
          throw new Error(`Role ${role.name} ${side} SDK schema identity invalid`);
      }
    }
  }
  const requiredKinds = [...new Set([...baseKinds,
    ...(source.roles.some(role => role.template === 'read-only-analyst') ? ['execution.role'] : []),
    ...physical.algorithm.requiredKinds])].sort();
  const manifests = new Map(physical.providerManifests.map(manifest => [manifest.kind, manifest]));
  if (manifests.size !== physical.providerManifests.length) throw new Error('Duplicate provider kinds');
  for (const manifest of physical.providerManifests) validateProviderManifest(manifest);
  for (const kind of ['tasks.sample', 'tasks.consume', 'bindings.derive', 'author.checkpoint', 'author.observe', 'author.measurement']) {
    const manifest = manifests.get(kind);
    if (manifest?.execution !== 'trusted-local' || manifest.meteredDimensions.length !== 0
      || (manifest.hardLimitDimensions?.length ?? 0) !== 0)
      throw new Error(`Pure provider ${kind} must be unmetered and trusted-local`);
  }
  for (const kind of requiredKinds) {
    const manifest = manifests.get(kind);
    if (!manifest) throw new Error(`Required provider ${kind} unavailable`);
  }
  const declaredMeters = new Map<string, AuthorPhysicalResolution['providerMeters'][number]>();
  for (const meter of physical.providerMeters) {
    const manifest = manifests.get(meter.kind);
    if (!manifest || declaredMeters.has(meter.kind) || !meter.source || new Set(meter.dimensions).size !== meter.dimensions.length
      || meter.dimensions.length === 0 || meter.dimensions.some(dimension =>
        !manifest.meteredDimensions.includes(dimension) || physical.budgetSources[dimension as keyof typeof physical.budgetSources] !== meter.source))
      throw new Error(`Provider meter ${meter.kind} does not match physical manifest and budget source`);
    declaredMeters.set(meter.kind, meter);
  }
  for (const kind of requiredKinds) {
    const manifest = manifests.get(kind)!;
    const budgeted = manifest.meteredDimensions.filter(dimension => Object.hasOwn(physical.budgetPlan, dimension));
    if (budgeted.length === 0) continue;
    const meter = declaredMeters.get(kind);
    if (!meter || canonicalJson([...meter.dimensions].sort()) !== canonicalJson([...budgeted].sort())
      || budgeted.some(dimension => physical.budgetPlan[dimension]!.capability === 'hard'
        && !manifest.hardLimitDimensions?.includes(dimension)))
      throw new Error(`Required provider ${kind} does not enforce its frozen Campaign dimensions`);
  }
  for (const [dimension, budgetSource] of Object.entries(physical.budgetSources)) {
    if (!Object.values(profileBudgetDimensions).includes(dimension as typeof profileBudgetDimensions[keyof typeof profileBudgetDimensions]) || !budgetSource
      || !physical.providerMeters.some(meter => meter.source === budgetSource
        && meter.dimensions.includes(dimension) && manifests.get(meter.kind)?.meteredDimensions.includes(dimension)))
      throw new Error(`Budget ${dimension} has no metered provider source`);
  }
  if (Object.keys(physical.budgetSources).sort().join(',') !== 'model.requests,model.tokens,rollout.trials')
    throw new Error('Budget source mapping incomplete');
  for (const [profileDimension, limit] of Object.entries(source.profile.budgetDefaults)) {
    const dimension = profileBudgetDimensions[profileDimension as keyof typeof profileBudgetDimensions];
    const budget = physical.budgetPlan[dimension];
    if (!budget || budget.limit !== limit || budget.source !== physical.budgetSources[dimension]
      || typeof budget.unit !== 'string' || !budget.unit || !['hard', 'stop'].includes(budget.capability))
      throw new Error(`Budget ${dimension} is not mapped to the frozen Campaign plan`);
  }
  if (Object.keys(physical.budgetPlan).sort().join(',') !== 'model.requests,model.tokens,rollout.trials')
    throw new Error('Campaign budget plan has unsupported dimensions');
  const modelLimits = { 'model.requests': source.profile.operationLimits.modelRequests,
    'model.tokens': source.profile.operationLimits.modelTokens };
  const metering = { profileDimensions: profileBudgetDimensions, operationLimits: {
    'execution.role': modelLimits, 'execution.workspace-edit': modelLimits,
    'execution.rollout': { 'rollout.trials': 1 as const },
  }, operationTimeoutMs: source.profile.operationLimits.timeoutMs };
  const body = { schemaVersion: 1 as const, kind: 'author.run.lock.candidate.v1' as const,
    static: source, physical: structuredClone(physical), requiredKinds, metering };
  if (jsonDigest(resolveAuthorStaticRun(options)) !== jsonDigest(source))
    throw new Error('Author run sources changed while inspecting capabilities');
  assertJson(body);
  return { ...body, lockDigest: jsonDigest(body) };
}

export async function checkAuthorRun(options: Parameters<typeof resolveAuthorRun>[0]): Promise<ResolvedAuthorRun> {
  return resolveAuthorRun(options);
}
export async function explainAuthorRun(options: Parameters<typeof resolveAuthorRun>[0]): Promise<{ resolved: ResolvedAuthorRun; text: string }> {
  const resolved = await resolveAuthorRun(options);
  const { static: source, physical } = resolved;
  return { resolved, text: [
    `algorithm: ${source.modulePath}:${source.run.algorithm.export} (${source.run.algorithm.language})`,
    `profile: ${source.profile.id} -> ${source.profile.template}`,
    `models: meta ${physical.models.meta.alias} -> ${physical.models.meta.provider}/${physical.models.meta.model}; target ${physical.models.target.alias} -> ${physical.models.target.provider}/${physical.models.target.model}`,
    `tasks: ${source.profile.inputs.searchTasks.purpose}, ${physical.dataset.taskIds.length} compiled v1 tasks, ${physical.dataset.digest}`,
    ...source.roles.map(role => `role: ${role.name} -> ${role.template}, prompt ${role.prompt.sha256}, ${role.inputSchema} / ${role.resultSchema}`),
    `write scope: ${source.profile.editing.allowedPaths.join(', ')}`,
    `providers: ${resolved.requiredKinds.join(', ')}`,
    `budget sources: ${canonicalJson(physical.budgetSources)}`,
    `Hitch: ${physical.hitch.capabilityDigest}, unseeded repetitions`,
    `lock candidate: ${resolved.lockDigest}`,
  ].join('\n') };
}

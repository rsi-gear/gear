import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import * as ts from 'typescript';
import { HarnessBuilder } from '../../harness/builder.js';
import { SubprocessHarnessCompiler } from '../../harness/compiler.js';
import { HitchCliEvaluator } from '../../evaluator/hitch-cli.js';
import { isExactGitCommit } from '../../types.js';
import { inspectStandardCompiledDatasetV1 } from '../../search/compiled-dataset-v1.js';
import { resolveMetric } from '../../objective/contracts.js';
import { canonicalJson, jsonDigest } from '../schema.js';
import { createRestrictedAlgorithmDshHost } from '../dsh-host.js';
import { sourceTreeDigest } from '../loader.js';
import { readBoundedRegularFile } from '../../state/bounded-file.js';
import type { AuthorStaticResolution } from './run-resolver.js';
import { parseNeutralRuntimeConfig, type NeutralRuntimeConfigV1 } from './neutral-runtime-config.js';

export type InspectedInitialHarness = { commit: string; tree: string; manifestDigest: string };
export type InspectedSearchDataset = { schemaVersion: 1; digest: string; taskIds: string[]; purpose: 'development' };
export type InspectedHitchCapability = { runtimeIdentity: string; capabilityDigest: string; daemon: true };
export type RegisteredMetaModel = { destinationId: string; currentDestinationId(): string };
export type InspectedMetaModel = { alias: string; provider: string; model: string; destinationDigest: string;
  registrationSourceDigest: string };
export type AuthorReadOnlyPhysicalProbe = { runtimeConfigDigest: string; git: InspectedInitialHarness;
  dataset: InspectedSearchDataset; hitch: InspectedHitchCapability; metaModel: InspectedMetaModel };

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 10_000,
    maxBuffer: 8 * 1024 }).trim();
}

/** Read-only Git/Harness probe using the same HarnessBuilder validator used by physical edits. */
export async function inspectAuthorInitialHarness(source: AuthorStaticResolution,
  runtime: NeutralRuntimeConfigV1): Promise<InspectedInitialHarness> {
  const repository = resolve(source.profile.workspace.repository);
  if (resolve(runtime.hitch.repositoryPath) !== repository
    || resolve(runtime.hitch.executable) !== resolve(source.profile.hitch.executable))
    throw new Error('Neutral runtime repository or Hitch executable differs from profile');
  if (runtime.compiler.targetRoot !== undefined
    && runtime.compiler.targetRoot !== source.profile.workspace.harnessRoot)
    throw new Error('Neutral compiler target root differs from profile');
  const builder = new HarnessBuilder({ ...runtime.builder, repositoryPath: repository,
    targetRoot: source.profile.workspace.harnessRoot,
    compiler: new SubprocessHarnessCompiler(runtime.compiler) });
  await builder.initialize();
  const ref = source.profile.inputs.initialAgent.gitRef;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.split('/').some(part => part === '.' || part === '..'))
    throw new Error('Initial Harness Git ref is not a safe branch or exact commit');
  const commit = git(repository, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!isExactGitCommit(commit)) throw new Error('Initial Harness did not resolve to an exact Git commit');
  const manifest = await builder.readManifest(commit);
  const tree = git(repository, ['rev-parse', '--verify', `${commit}^{tree}`]);
  if (!isExactGitCommit(tree)) throw new Error('Initial Harness Git tree OID invalid');
  return { commit, tree, manifestDigest: manifest.digest };
}

/** Uses the same standard v1 task-byte verifier as staged search projection. */
export async function inspectAuthorSearchDataset(source: AuthorStaticResolution): Promise<InspectedSearchDataset> {
  const dataset = await inspectStandardCompiledDatasetV1(source.profile.inputs.searchTasks.compiledDataset);
  const ids = dataset.manifest.tasks.map(task => task.task_id);
  if (canonicalJson(ids) !== canonicalJson(source.datasetTaskIds))
    throw new Error('Compiled search task list changed after static resolution');
  // The first author measurement admits only a complete binary pass predicate. The profile threshold
  // is not an alternative scorer, so reject values the physical measurement cannot apply.
  if (source.profile.evaluation.requireAllTrialsValid !== true
    || source.profile.evaluation.metric !== 'pass_rate'
    || source.profile.evaluation.passThreshold !== 1)
    throw new Error('A1 physical measurement requires all valid trials and pass_rate threshold 1');
  const metricName = source.profile.evaluation.metric;
  const raw = dataset.manifest.raw_metrics;
  if (!raw || raw.schema_version !== '1' || !Array.isArray(raw.metrics))
    throw new Error('A1 evaluation needs a standard raw metric registry');
  const metric = raw.metrics.find(row => row.id === metricName);
  if (!metric) throw new Error(`Evaluation metric ${metricName} absent from compiled dataset`);
  resolveMetric(metric);
  return { schemaVersion: 1, digest: dataset.sourceDigest, taskIds: ids, purpose: 'development' };
}

/** Hitch's own read-only CLI protocol verifies version, daemon health and actual capabilities. */
export async function inspectAuthorHitchCapability(source: AuthorStaticResolution,
  runtime: NeutralRuntimeConfigV1, signal: AbortSignal): Promise<InspectedHitchCapability> {
  if (runtime.hitch.controlPlane?.mode !== 'daemon'
    || resolve(runtime.hitch.repositoryPath) !== resolve(source.profile.workspace.repository)
    || resolve(runtime.hitch.executable) !== resolve(source.profile.hitch.executable))
    throw new Error('Neutral Hitch configuration does not match the profile daemon');
  const evaluator = new HitchCliEvaluator(runtime.hitch);
  const described = await evaluator.inspectRuntimeCapability(signal);
  return { runtimeIdentity: described.runtimeIdentity,
    capabilityDigest: jsonDigest({ runtimeIdentity: described.runtimeIdentity,
      capabilities: described.capabilities, options: runtime.hitch }), daemon: true };
}

/** Low-level trusted-host probe. Its callback is not an admission source; the aggregate loader supplies it from frozen module bytes. */
export async function inspectAuthorMetaModel(source: AuthorStaticResolution,
  runtime: NeutralRuntimeConfigV1,
  registerModel: (llm: LlmRuntime) => RegisteredMetaModel | Promise<RegisteredMetaModel>,
  expectedModuleDigest?: string): Promise<InspectedMetaModel> {
  const destination = runtime.modelDestinations.meta;
  if (destination.alias !== source.profile.models.meta) throw new Error('Meta model alias differs from profile');
  if (lstatSync(destination.registrationModule).isSymbolicLink())
    throw new Error('Meta model registration module cannot be a symlink');
  const registrationPath = realpathSync(destination.registrationModule);
  const moduleBytes = () => readBoundedRegularFile(registrationPath, 4 * 1024 * 1024,
    'Meta model registration module');
  const moduleDigest = createHash('sha256').update(await moduleBytes()).digest('hex');
  if (expectedModuleDigest !== undefined && moduleDigest !== expectedModuleDigest)
    throw new Error('Meta model registration source changed after frozen module load');
  const registrationSourceDigest = await sourceTreeDigest(dirname(registrationPath),
    runtime.runtimeResources.filter(path => resolve(path) !== registrationPath));
  let registration: RegisteredMetaModel | undefined;
  const dsh = await createRestrictedAlgorithmDshHost(async llm => { registration = await registerModel(llm); });
  try {
    const llm = dsh.context.llm;
    if (!registration || registration.destinationId !== destination.destinationId
      || registration.currentDestinationId() !== destination.destinationId
      || !llm.listProviders().some(provider => provider.id === destination.provider))
      throw new Error('Meta model adapter or destination registration unresolved');
    const modelInfo = await llm.resolveModelInfo(destination.provider, destination.model);
    if (!modelInfo || registration.currentDestinationId() !== destination.destinationId)
      throw new Error('Meta model route changed during read-only inspection');
    if (createHash('sha256').update(await moduleBytes()).digest('hex') !== moduleDigest
      || await sourceTreeDigest(dirname(registrationPath), runtime.runtimeResources.filter(path => resolve(path) !== registrationPath))
        !== registrationSourceDigest)
      throw new Error('Meta model registration source changed during inspection');
    return { alias: destination.alias, provider: destination.provider, model: destination.model,
      registrationSourceDigest,
      destinationDigest: jsonDigest({ destinationId: destination.destinationId,
        provider: destination.provider, model: destination.model, modelInfo,
        registrationSourceDigest, moduleDigest }) };
  } finally { await dsh.close(); }
}

/** This first physical probe admits a single-file administrator module; transitive package imports need a later closed loader. */
function assertSingleFileRegistrationModule(bytes: Buffer, path: string): void {
  if (!path.endsWith('.mjs')) throw new Error('Meta model registration module must be .mjs');
  const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier
      || ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      throw new Error('Meta model registration module imports are outside the frozen single-file closure');
    ts.forEachChild(node, visit);
  }
  visit(source);
}

async function loadFrozenRegistration(path: string): Promise<{ registerModel: (llm: LlmRuntime) =>
  RegisteredMetaModel | Promise<RegisteredMetaModel>; moduleDigest: string }> {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Meta model registration module cannot be a symlink');
  const bytes = await readBoundedRegularFile(path, 4 * 1024 * 1024, 'Meta model registration module');
  assertSingleFileRegistrationModule(bytes, path);
  // data: loads exactly the inspected bytes and cannot follow a replaced path. Imports are rejected above.
  const loaded: unknown = await import(`data:text/javascript;base64,${bytes.toString('base64')}`);
  if (!loaded || typeof loaded !== 'object' || !('registerModel' in loaded)
    || typeof loaded.registerModel !== 'function')
    throw new Error('Meta model registration module must export registerModel(llm)');
  return { registerModel: loaded.registerModel as (llm: LlmRuntime) =>
    RegisteredMetaModel | Promise<RegisteredMetaModel>,
  moduleDigest: createHash('sha256').update(bytes).digest('hex') };
}

/** A usable partial preflight for future check/run; it deliberately cannot claim a complete capability lock. */
export async function inspectAuthorReadOnlyPhysicalInputs(source: AuthorStaticResolution,
  signal: AbortSignal): Promise<AuthorReadOnlyPhysicalProbe> {
  if (lstatSync(source.profile.runtimeConfig).isSymbolicLink())
    throw new Error('Neutral runtime config cannot be a symlink');
  const configPath = realpathSync(source.profile.runtimeConfig);
  const configBytes = () => readBoundedRegularFile(configPath, 1024 * 1024, 'Neutral runtime config');
  const bytes = await configBytes();
  const runtimeConfigDigest = createHash('sha256').update(bytes).digest('hex');
  if (runtimeConfigDigest !== source.source.runtimeConfigDigest)
    throw new Error('Neutral runtime config changed after static resolution');
  const runtime = parseNeutralRuntimeConfig(loadYaml(bytes.toString('utf8'), { schema: JSON_SCHEMA, filename: configPath }));
  if (runtime.modelDestinations.meta.alias !== source.profile.models.meta
    || runtime.modelDestinations.target.alias !== source.profile.models.target)
    throw new Error('Neutral runtime model aliases differ from profile');
  const git = await inspectAuthorInitialHarness(source, runtime);
  signal.throwIfAborted();
  const dataset = await inspectAuthorSearchDataset(source);
  signal.throwIfAborted();
  const hitch = await inspectAuthorHitchCapability(source, runtime, signal);
  const registration = await loadFrozenRegistration(runtime.modelDestinations.meta.registrationModule);
  const metaModel = await inspectAuthorMetaModel(source, runtime, registration.registerModel,
    registration.moduleDigest);
  if (createHash('sha256').update(await configBytes()).digest('hex') !== runtimeConfigDigest)
    throw new Error('Neutral runtime config changed during physical inspection');
  return { runtimeConfigDigest, git, dataset, hitch, metaModel };
}

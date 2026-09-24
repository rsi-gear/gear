import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { EvolutionSpec } from '../types.js';
import { CandidateWorkspaceManager } from '../candidate/workspace.js';
import type { CandidateWorkspaceOptions } from '../candidate/workspace.js';
import { HarnessBuilder, type HarnessBuilderOptions } from '../harness/builder.js';
import { SubprocessHarnessCompiler, type SubprocessCompilerOptions } from '../harness/compiler.js';
import { HitchCliEvaluator, type HitchCliEvaluatorOptions } from '../evaluator/hitch-cli.js';
import { createDefaultFreshHostProfile } from './default-host.js';
import { createRestrictedAlgorithmDshHost } from './dsh-host.js';
import { implementationClosureDigest } from './data/identity.js';
import type { AlgorithmHostContext, AlgorithmHostProfile } from './host-profile.js';
import { assertJson, jsonDigest } from './schema.js';

type RoleSettings = { instruction: string; maxModelRequests: number; maxTokens: number; timeoutMs: number };
type Recipe = 'rho' | 'ahe' | 'evo';
export type ConfiguredFreshHostSettings = {
  schemaVersion: 1;
  recipe: Recipe;
  spec: EvolutionSpec;
  workspaceRoot: string;
  authorityId: string;
  builder: Omit<HarnessBuilderOptions, 'compiler'>;
  compiler: SubprocessCompilerOptions;
  hitch: HitchCliEvaluatorOptions;
  workspace: Omit<CandidateWorkspaceOptions, 'rootForEvolution'>;
  operationLimits: Record<string, Record<string, number>>;
  roles: Record<string, RoleSettings>;
  modelDestination: { id: string; module: string; provider: string; model: string };
  /** All scripts and local files loaded by the configured external processes. */
  runtimeResources: string[];
  allowedTaskIds?: string[];
  maxTasks?: number;
  passThreshold?: number;
  evoSkillDisclosureId?: string;
};

export type ConfiguredModelRegistration = { destinationId: string; currentDestinationId(): string };
export type ConfiguredFreshHostOptions = {
  /** JSON and module must live in the TS entry's closed source directory. */
  settingsPath: string;
  registerModel(llm: LlmRuntime): ConfiguredModelRegistration | Promise<ConfiguredModelRegistration>;
};

function contained(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset));
}

function closedFile(configDir: string, named: string): string {
  const path = resolve(configDir, named);
  const root = realpathSync(configDir), real = realpathSync(path);
  if (!contained(root, real) || lstatSync(path).isSymbolicLink() || !lstatSync(real).isFile()) {
    throw new Error(`Configured host file is outside its regular source closure: ${named}`);
  }
  return real;
}

function resourcePath(configDir: string, named: string): string {
  if (typeof named !== 'string' || !named) throw new Error('Runtime resource path must be nonempty');
  return isAbsolute(named) ? realpathSync(named) : closedFile(configDir, named);
}

function fileDigest(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Configured executable path must be absolute: ${path}`);
  const real = realpathSync(path);
  if (!lstatSync(real).isFile()) throw new Error(`Configured executable is not a file: ${path}`);
  return createHash('sha256').update(readFileSync(real)).digest('hex');
}

function hitchEnvironmentDigest(): string {
  const values: Record<string, string | undefined> = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  const hash = createHash('sha256');
  for (const name of Object.keys(values).sort()) {
    const value = values[name] ?? '';
    hash.update(String(Buffer.byteLength(name))); hash.update('\0'); hash.update(name);
    hash.update(String(Buffer.byteLength(value))); hash.update('\0'); hash.update(value);
  }
  return hash.digest('hex');
}

function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

const roleIds: Record<Recipe, { science: string[]; feedback: string[]; editor: string[] }> = {
  rho: { science: ['rho.difficulty', 'rho.diagnoser'], feedback: ['rho.self-preference'], editor: ['rho.optimizer'] },
  ahe: { science: ['ahe.attributor'], feedback: [], editor: ['ahe.evolver', 'ahe.rollback'] },
  evo: { science: ['evo.retriever', 'evo.proposer', 'evo.curator'], feedback: [], editor: [] },
};

function readSettings(context: AlgorithmHostContext, path: string): ConfiguredFreshHostSettings {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  assertJson(raw);
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') throw new Error('Host settings must be JSON object');
  const settings = raw as unknown as ConfiguredFreshHostSettings;
  if (settings.schemaVersion !== 1 || !Object.hasOwn(roleIds, settings.recipe))
    throw new Error('Unsupported configured fresh host settings');
  if (!settings.spec || !settings.builder || !settings.compiler || !settings.hitch || !settings.workspace
    || !settings.operationLimits || !settings.roles || !settings.modelDestination
    || !Array.isArray(settings.runtimeResources)) {
    throw new Error('Configured host is missing physical service settings');
  }
  for (const [name, pathValue] of Object.entries({ workspaceRoot: settings.workspaceRoot,
    repositoryPath: settings.builder.repositoryPath, hitchRepositoryPath: settings.hitch.repositoryPath,
    workspaceRepositoryPath: settings.workspace.repositoryPath, compilerCommand: settings.compiler.command,
    hitchExecutable: settings.hitch.executable })) {
    if (typeof pathValue !== 'string' || !isAbsolute(pathValue)) throw new Error(`${name} must be an absolute path`);
  }
  if (settings.builder.repositoryPath !== settings.hitch.repositoryPath
    || settings.builder.repositoryPath !== settings.workspace.repositoryPath
    || settings.builder.targetRoot !== settings.workspace.targetRoot) {
    throw new Error('Configured physical services must use one Git repository and target root');
  }
  if (settings.modelDestination.provider !== settings.spec.metaAgent.model.provider
    || settings.modelDestination.model !== settings.spec.metaAgent.model.model
    || typeof settings.modelDestination.id !== 'string' || !settings.modelDestination.id) {
    throw new Error('Configured model destination does not match frozen EvolutionSpec');
  }
  closedFile(context.configDir, settings.modelDestination.module);
  const resources = new Set(settings.runtimeResources.map(named => resourcePath(context.configDir, named)));
  for (const argument of settings.compiler.args ?? []) {
    if (/\.(?:cjs|js|mjs|py|sh)$/u.test(argument)) {
      if (!isAbsolute(argument) || !resources.has(realpathSync(argument))) {
        throw new Error(`Compiler script argument needs absolute path and runtimeResources entry: ${argument}`);
      }
    }
  }
  const wanted = Object.values(roleIds[settings.recipe]).flat().sort();
  if (Object.keys(settings.roles).sort().join('\0') !== wanted.join('\0'))
    throw new Error(`Configured roles must be exactly: ${wanted.join(', ')}`);
  for (const [id, role] of Object.entries(settings.roles)) {
    if (!role || typeof role.instruction !== 'string' || !role.instruction.trim())
      throw new Error(`Configured role ${id} needs an instruction`);
    positive(role.maxModelRequests, `${id}.maxModelRequests`);
    positive(role.maxTokens, `${id}.maxTokens`);
    positive(role.timeoutMs, `${id}.timeoutMs`);
  }
  if (settings.recipe !== 'rho' && (typeof settings.passThreshold !== 'number'
    || !Number.isFinite(settings.passThreshold) || settings.passThreshold < 0 || settings.passThreshold > 1)) {
    throw new Error('AHE/Evo require a pass threshold in [0,1]');
  }
  if (settings.recipe === 'evo' && !settings.evoSkillDisclosureId)
    throw new Error('Evo requires an explicit Skill model disclosure destination');
  return settings;
}

/**
 * Host administrator's one-time, closed JSON setup for fresh RHO/AHE/Evo.
 * It installs the existing physical services; scientific Python code sees only
 * host-sealed refs and operation kinds. No model session continuation is implied.
 */
export async function createConfiguredFreshHostProfile(context: AlgorithmHostContext,
  options: ConfiguredFreshHostOptions): Promise<AlgorithmHostProfile> {
  const settingsPath = closedFile(context.configDir, options.settingsPath);
  const settings = readSettings(context, settingsPath);
  const modelPath = closedFile(context.configDir, settings.modelDestination.module);
  const implementation = implementationClosureDigest(['configured-host'], 'configured-fresh-host-v1');
  const fingerprint = (): string => {
    const current = readSettings(context, settingsPath);
    return jsonDigest({ implementation, settings: current,
      modelModule: fileDigest(modelPath), compiler: fileDigest(current.compiler.command),
      hitch: fileDigest(current.hitch.executable), node: process.version, executable: process.execPath,
      hitchEnvironmentDigest: hitchEnvironmentDigest(),
      runtimeResources: current.runtimeResources.map(named => {
        const path = resourcePath(context.configDir, named);
        return { path, digest: fileDigest(path) };
      }) });
  };
  const frozenFingerprint = fingerprint();
  const frozenRuntimeDigest = jsonDigest({ fingerprint: frozenFingerprint,
    destination: settings.modelDestination.id });
  const frozenDisclosureDigest = jsonDigest({ destination: settings.modelDestination,
    fingerprint: frozenFingerprint, currentDestination: settings.modelDestination.id });
  const compiler = new SubprocessHarnessCompiler(structuredClone(settings.compiler));
  const builder = new HarnessBuilder({ ...structuredClone(settings.builder), compiler });
  const evaluator = new HitchCliEvaluator(structuredClone(settings.hitch));
  const workspaceManager = new CandidateWorkspaceManager({ ...structuredClone(settings.workspace),
    rootForEvolution: id => join(context.stateDir, 'candidate-workspaces', id) });
  await builder.initialize();
  await workspaceManager.initialize();
  let registration: ConfiguredModelRegistration | undefined;
  const dsh = await createRestrictedAlgorithmDshHost(async llm => { registration = await options.registerModel(llm); });
  try {
    if (!registration || registration.destinationId !== settings.modelDestination.id
      || registration.currentDestinationId() !== settings.modelDestination.id) {
      throw new Error('Registered DSH model destination differs from host settings');
    }
    const llm = dsh.context.llm;
    if (!llm.listProviders().some(provider => provider.id === settings.modelDestination.provider)) {
      throw new Error('Configured model provider has no registered DSH adapter');
    }
    await llm.resolveModelInfo(settings.modelDestination.provider, settings.modelDestination.model);
    const registered = registration;
    const currentDestination = () => {
      const value = registered.currentDestinationId();
      if (value !== settings.modelDestination.id) throw new Error('Configured model destination changed');
      if (!llm.listProviders().some(provider => provider.id === settings.modelDestination.provider)) {
        throw new Error('Configured DSH adapter route disappeared');
      }
      return value;
    };
    const ids = roleIds[settings.recipe];
    const role = (id: string) => ({ id, spec: structuredClone(settings.spec.metaAgent) as import('../types.js').DshMetaAgentSpec,
      instruction: settings.roles[id]!.instruction, maxModelRequests: settings.roles[id]!.maxModelRequests,
      maxTokens: settings.roles[id]!.maxTokens, timeoutMs: settings.roles[id]!.timeoutMs });
    const structuredRole = (id: string) => ({ ...role(id),
      inputSchema: { type: 'object' as const, additionalProperties: true },
      resultSchema: { type: 'object' as const, additionalProperties: true } });
    return await createDefaultFreshHostProfile(context, {
      recipe: settings.recipe, spec: settings.spec, workspaceRoot: settings.workspaceRoot,
      authorityId: settings.authorityId, builder, evaluator, workspaceManager,
      operationLimits: settings.operationLimits,
      ...(settings.allowedTaskIds ? { allowedTaskIds: settings.allowedTaskIds } : {}),
      ...(settings.maxTasks === undefined ? {} : { maxTasks: settings.maxTasks }),
      dshContext: dsh.context,
      roleDefinitions: ids.science.map(structuredRole),
      feedbackRoleDefinitions: ids.feedback.map(structuredRole),
      workspaceEditRoles: ids.editor.map(role),
      modelRuntimeDigest: frozenRuntimeDigest,
      currentModelRuntimeDigest: () => jsonDigest({ fingerprint: fingerprint(), destination: currentDestination() }),
      modelDisclosurePolicyDigest: frozenDisclosureDigest,
      currentModelDisclosurePolicyDigest: () => jsonDigest({ destination: settings.modelDestination,
        fingerprint: fingerprint(), currentDestination: currentDestination() }),
      authorizeModelRole: (roleId, envelope) => {
        if (!Object.hasOwn(settings.roles, roleId) || envelope.campaignId !== context.campaignId) {
          throw new Error('Model role is outside the configured campaign destination');
        }
        if (fingerprint() !== frozenFingerprint) throw new Error('Configured host runtime drift');
        currentDestination();
      },
      ...(settings.passThreshold === undefined ? {} : { passThreshold: settings.passThreshold }),
      ...(settings.recipe === 'evo' ? { evoSkillDisclosure: {
        policyDigest: jsonDigest({ destination: settings.evoSkillDisclosureId, fingerprint: frozenFingerprint }),
        currentPolicyDigest: () => jsonDigest({ destination: settings.evoSkillDisclosureId,
          fingerprint: fingerprint() }),
        authorize: () => { if (fingerprint() !== frozenFingerprint) throw new Error('Skill disclosure destination drift');
          currentDestination(); },
      } } : {}),
      closeHost: () => dsh.close(),
    });
  } catch (error) {
    await dsh.close();
    throw error;
  }
}

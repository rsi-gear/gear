import { isAbsolute } from 'node:path';
import type { DshMetaAgentSpec } from '../../types.js';
import { isExactGitCommit } from '../../types.js';
import type { SubprocessCompilerOptions } from '../../harness/compiler.js';
import { HitchCliEvaluator, type HitchCliEvaluatorOptions } from '../../evaluator/hitch-cli.js';
import { assertJson, type JsonValue } from '../schema.js';

/** Administrator-owned physical service settings, independent of EvolutionSpec and any recipe. */
export type NeutralRuntimeConfigV1 = {
  schemaVersion: 1;
  builder: { dshBaseRef: string; toolchainRef: string; sandboxProfileRef: string; allowedImports: string[] };
  compiler: SubprocessCompilerOptions;
  hitch: HitchCliEvaluatorOptions;
  sampling: { repetitions: number };
  taskBudgetMs: number;
  /** Pre-existing administrator keys; ordinary author projects never provision them. */
  authority?: { issuerId: string; taskKeyFile: string; evidenceKeyFile: string };
  modelDestinations: {
    meta: { alias: string; destinationId: string; provider: string; model: string;
      registrationModule: string; spec: DshMetaAgentSpec };
    target: { alias: string; destinationId: string; provider: string; model: string; routeFile?: string };
  };
  /** Admin-declared scripts and assets used by the compiler and model registration. */
  runtimeResources: string[];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const field of required) if (!Object.hasOwn(value, field)) throw new Error(`${label}.${field} required`);
  for (const field of Object.keys(value)) if (![...required, ...optional].includes(field)) throw new Error(`${label}.${field} unsupported`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} required`);
  return value;
}
function absolute(value: unknown, label: string): string {
  const path = text(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return path;
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be positive safe integer`);
  return value as number;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.includes('\0')))
    throw new Error(`${label} must be a string array`);
  return value;
}

/** This parser only admits a physical configuration; it never registers a model or runs Hitch. */
export function parseNeutralRuntimeConfig(value: unknown): NeutralRuntimeConfigV1 {
  assertJson(value);
  const config = object(value, 'Runtime config');
  exact(config, ['schemaVersion', 'builder', 'compiler', 'hitch', 'sampling', 'taskBudgetMs', 'modelDestinations',
    'runtimeResources'], ['authority'], 'Runtime config');
  if (config.schemaVersion !== 1) throw new Error('Neutral runtime config version 1 required');
  const builder = object(config.builder, 'Runtime builder');
  exact(builder, ['dshBaseRef', 'toolchainRef', 'sandboxProfileRef', 'allowedImports'], [], 'Runtime builder');
  if (!isExactGitCommit(text(builder.dshBaseRef, 'Runtime builder base')))
    throw new Error('Runtime builder base must be exact Git commit');
  text(builder.toolchainRef, 'Runtime builder toolchain');
  text(builder.sandboxProfileRef, 'Runtime builder sandbox');
  strings(builder.allowedImports, 'Runtime builder allowedImports');
  const compiler = object(config.compiler, 'Runtime compiler');
  exact(compiler, ['command'], ['args', 'timeoutMs', 'env', 'sandboxMode', 'linuxIsolation', 'targetRoot',
    'reportProtocol', 'runtimeRoot', 'maxReportBytes', 'readPaths'], 'Runtime compiler');
  absolute(compiler.command, 'Runtime compiler command');
  if (compiler.args !== undefined) strings(compiler.args, 'Runtime compiler args');
  if (compiler.readPaths !== undefined) strings(compiler.readPaths, 'Runtime compiler readPaths').forEach((path, index) =>
    absolute(path, `Runtime compiler readPaths[${index}]`));
  if (compiler.env !== undefined) {
    for (const [key, entry] of Object.entries(object(compiler.env, 'Runtime compiler env'))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string')
        throw new Error('Runtime compiler env invalid');
    }
  }
  if (compiler.timeoutMs !== undefined) positive(compiler.timeoutMs, 'Runtime compiler timeoutMs');
  if (compiler.maxReportBytes !== undefined) positive(compiler.maxReportBytes, 'Runtime compiler maxReportBytes');
  if (compiler.runtimeRoot !== undefined) absolute(compiler.runtimeRoot, 'Runtime compiler runtimeRoot');
  if (compiler.reportProtocol !== undefined && compiler.reportProtocol !== 'gear-runtime-check-v1')
    throw new Error('Runtime compiler report protocol unsupported');
  if (compiler.sandboxMode !== undefined && !['required', 'disabled'].includes(compiler.sandboxMode as string))
    throw new Error('Runtime compiler sandbox mode unsupported');
  const hitch = object(config.hitch, 'Runtime Hitch');
  exact(hitch, ['executable', 'repositoryPath', 'harnessId', 'root', 'model', 'attempts', 'maxConcurrent',
    'setupTimeoutMs', 'terminationGraceMs', 'maxOutputBytes', 'maxTrajectoryOutputBytes', 'sampling',
    'agentArgs', 'passEnv', 'controlPlane'], ['maxTrajectoryAnalysisBytes', 'maxTrajectoryEventsBytes',
    'trajectoryCacheEntries', 'trajectoryCacheBytes', 'allowUnavailableVerifierDiagnosis'], 'Runtime Hitch');
  absolute(hitch.executable, 'Runtime Hitch executable');
  absolute(hitch.repositoryPath, 'Runtime Hitch repositoryPath');
  strings(hitch.agentArgs, 'Runtime Hitch agentArgs');
  strings(hitch.passEnv, 'Runtime Hitch passEnv');
  if (hitch.seeds !== undefined || Object.keys(object(hitch.sampling, 'Runtime Hitch sampling')).length !== 0)
    throw new Error('Neutral Hitch sampling must be unseeded and evaluator-controlled');
  const control = object(hitch.controlPlane, 'Runtime Hitch controlPlane');
  if (control.mode !== 'daemon') throw new Error('Neutral Hitch requires daemon mode');
  new HitchCliEvaluator(hitch as unknown as HitchCliEvaluatorOptions);
  const sampling = object(config.sampling, 'Runtime sampling');
  exact(sampling, ['repetitions'], [], 'Runtime sampling');
  positive(sampling.repetitions, 'Runtime sampling repetitions');
  positive(config.taskBudgetMs, 'Runtime taskBudgetMs');
  if (config.authority !== undefined) {
    const authority = object(config.authority, 'Runtime authority');
    exact(authority, ['issuerId', 'taskKeyFile', 'evidenceKeyFile'], [], 'Runtime authority');
    text(authority.issuerId, 'Runtime authority issuerId');
    absolute(authority.taskKeyFile, 'Runtime authority taskKeyFile');
    absolute(authority.evidenceKeyFile, 'Runtime authority evidenceKeyFile');
    if (authority.taskKeyFile === authority.evidenceKeyFile)
      throw new Error('Task and evidence authority key files must differ');
  }
  const models = object(config.modelDestinations, 'Runtime model destinations');
  exact(models, ['meta', 'target'], [], 'Runtime model destinations');
  for (const channel of ['meta', 'target'] as const) {
    const destination = object(models[channel], `Runtime ${channel} model`);
    exact(destination, ['alias', 'destinationId', 'provider', 'model', ...(channel === 'meta' ? ['registrationModule', 'spec'] : [])],
      channel === 'target' ? ['routeFile'] : [], `Runtime ${channel} model`);
    for (const field of ['alias', 'destinationId', 'provider', 'model']) text(destination[field], `Runtime ${channel}.${field}`);
    if (channel === 'target' && destination.routeFile !== undefined)
      absolute(destination.routeFile, 'Runtime target routeFile');
    if (channel === 'meta') {
      absolute(destination.registrationModule, 'Runtime meta registrationModule');
      const spec = object(destination.spec, 'Runtime meta DSH spec');
      if (object(spec.runtime, 'Runtime meta DSH runtime').type !== 'dsh'
        || object(spec.model, 'Runtime meta DSH model').provider !== destination.provider
        || object(spec.model, 'Runtime meta DSH model').model !== destination.model)
        throw new Error('Runtime meta DSH spec does not match model destination');
    }
  }
  if (hitch.model !== object(models.target, 'Runtime target model').model)
    throw new Error('Runtime Hitch target model does not match registered destination');
  const resources = strings(config.runtimeResources, 'Runtime resources');
  if (resources.length > 64 || new Set(resources).size !== resources.length) throw new Error('Runtime resources must be unique and bounded');
  resources.forEach((path, index) => absolute(path, `Runtime resources[${index}]`));
  if (!resources.includes(object(models.meta, 'Runtime meta model').registrationModule as string))
    throw new Error('Runtime meta registration module must be an explicit resource');
  const routeFile = object(models.target, 'Runtime target model').routeFile;
  if (routeFile !== undefined && !resources.includes(routeFile as string))
    throw new Error('Runtime target route file must be an explicit resource');
  return structuredClone(value as JsonValue) as unknown as NeutralRuntimeConfigV1;
}

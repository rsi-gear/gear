import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { CandidateWorkspaceManager } from '../candidate/workspace.js';
import { SkillCandidateFiles } from '../skill/files.js';
import { sanitizePublicValue } from '../meta/sanitize.js';
import type { OperationEnvelope } from './contracts.js';
import { assertDigest } from './artifacts.js';
import { implementationClosureDigest } from './data/identity.js';
import { createEvoSkillCapabilities, type EvoSkillDisclosureGrant } from './providers/evo-skills.js';
import { createDshStructuredAdapter, createEvidenceDshRoleHost, DshRoleSessionRegistry,
  type StructuredRoleDefinition } from './providers/roles.js';
import { createTrustedRolloutFeedbackAdapter } from './providers/trusted-feedback.js';
import { verifyCompletedRolloutProducer } from './providers/rollout-evidence.js';
import { createWorkspaceEditAdapter, WorkspaceEditSessionRegistry,
  type WorkspaceEditRoleDefinition } from './providers/workspace-edit.js';
import { createWorkspaceEditDshHost } from './providers/workspace-edit-host.js';
import { createFreshRecipeHostProfile, type FreshRecipeHostOptions } from './fresh-profile.js';
import type { AlgorithmHostContext, AlgorithmHostProfile } from './host-profile.js';
import { assertJson, jsonDigest, type JsonValue } from './schema.js';

type Recipe = FreshRecipeHostOptions['recipe'];
type BaseOptions = Omit<FreshRecipeHostOptions, 'physicalHost' | 'skillOverlay'>;
export type DefaultFreshHostOptions = BaseOptions & {
  /** A trusted application configures this restricted DSH Context once for its authors. */
  dshContext: Context;
  workspaceManager: CandidateWorkspaceManager;
  roleDefinitions: StructuredRoleDefinition[];
  feedbackRoleDefinitions?: StructuredRoleDefinition[];
  workspaceEditRoles?: WorkspaceEditRoleDefinition[];
  /** Fingerprint the installed model, preset, tools, and destination; re-read before each call. */
  modelRuntimeDigest: string;
  currentModelRuntimeDigest(): string;
  modelDisclosurePolicyDigest: string;
  currentModelDisclosurePolicyDigest(): string;
  authorizeModelRole(roleId: string, envelope: OperationEnvelope): Promise<void> | void;
  /** Required for AHE/Evo: trusted score policy over complete Hitch trials. */
  passThreshold?: number;
  /** Required for Evo: explicit permission to expose the bound library to this model destination. */
  evoSkillDisclosure?: EvoSkillDisclosureGrant;
  maxRoleEvidenceRequests?: number;
  maxWorkspaceReadBytes?: number;
  closeHost?(): Promise<void> | void;
};

function exactCatalog(roles: readonly { id: string }[], required: readonly string[], label: string): void {
  const found = roles.map(role => role.id).sort();
  if (found.join('\0') !== [...required].sort().join('\0')) {
    throw new Error(`${label} must declare exactly: ${required.join(', ')}`);
  }
}
function ids(recipe: Recipe): { roles: string[]; feedback: string[]; editors: string[] } {
  if (recipe === 'rho') return { roles: ['rho.difficulty', 'rho.diagnoser'],
    feedback: ['rho.self-preference'], editors: ['rho.optimizer'] };
  if (recipe === 'ahe') return { roles: ['ahe.attributor'], feedback: [],
    editors: ['ahe.evolver', 'ahe.rollback'] };
  return { roles: ['evo.retriever', 'evo.proposer', 'evo.curator'], feedback: [], editors: [] };
}

/** One host-owned assembly point for built-in physical providers; recipe JSON contains only science parameters. */
export async function createDefaultFreshHostProfile(context: AlgorithmHostContext,
  options: DefaultFreshHostOptions): Promise<AlgorithmHostProfile> {
  let closed = false;
  const closeHost = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await options.closeHost?.();
  };
  try {
  // Host-owned policy is captured once; live identity callbacks below may only reject drift.
  options = { ...options, spec: structuredClone(options.spec),
    operationLimits: structuredClone(options.operationLimits),
    roleDefinitions: structuredClone(options.roleDefinitions),
    ...(options.feedbackRoleDefinitions ? { feedbackRoleDefinitions: structuredClone(options.feedbackRoleDefinitions) } : {}),
    ...(options.workspaceEditRoles ? { workspaceEditRoles: structuredClone(options.workspaceEditRoles) } : {}),
    ...(options.allowedTaskIds ? { allowedTaskIds: [...options.allowedTaskIds] } : {}),
    ...(options.evoSkillDisclosure ? { evoSkillDisclosure: { ...options.evoSkillDisclosure } } : {}) };
  context = Object.freeze({ ...context, config: structuredClone(context.config), budget: structuredClone(context.budget) });
  assertDigest(options.modelRuntimeDigest);
  assertDigest(options.modelDisclosurePolicyDigest);
  if (options.currentModelRuntimeDigest() !== options.modelRuntimeDigest
    || options.currentModelDisclosurePolicyDigest() !== options.modelDisclosurePolicyDigest) {
    throw new Error('Configured model runtime or destination policy changed');
  }
  const required = ids(options.recipe);
  exactCatalog(options.roleDefinitions, required.roles, 'Science role catalog');
  exactCatalog(options.feedbackRoleDefinitions ?? [], required.feedback, 'Feedback role catalog');
  exactCatalog(options.workspaceEditRoles ?? [], required.editors, 'Workspace editor catalog');
  const workspaceEditRoles = (options.workspaceEditRoles ?? []).map(role => role.id === 'ahe.evolver'
    ? { ...role, resultSchema: { type: 'object' as const,
      required: ['predictedFixes', 'riskTasks'], properties: {
        predictedFixes: { type: 'array' as const, items: { type: 'string' as const } },
        riskTasks: { type: 'array' as const, items: { type: 'string' as const } },
      }, additionalProperties: false } } : role.id === 'ahe.rollback'
      ? { ...role, restore: { sourceBindingField: 'restoreFromBindingSetRef', filesField: 'files' } }
      : role);
  if (options.recipe === 'evo' ? !options.evoSkillDisclosure : !!options.evoSkillDisclosure)
    throw new Error('Evo Skill model disclosure must be configured only for Evo');
  if (options.recipe !== 'rho' && options.passThreshold === undefined)
    throw new Error('AHE/Evo need a host-frozen physical pass threshold');
  const closureDigest = implementationClosureDigest(['default-host', 'fresh-profile'],
    'builtin-physical-fresh-host-v1');
  const hostRuntimeDigest = (skillDigest: string | null): string => jsonDigest({
    closureDigest, configuredModelRuntimeDigest: options.modelRuntimeDigest,
    disclosurePolicyDigest: options.modelDisclosurePolicyDigest, skillDigest });
  const currentRuntimeDigest = (skillDigest: string | null): string => jsonDigest({
    closureDigest, configuredModelRuntimeDigest: options.currentModelRuntimeDigest(),
    disclosurePolicyDigest: options.currentModelDisclosurePolicyDigest(), skillDigest });
  const overlayIdentity = jsonDigest({ closureDigest, recipe: options.recipe,
    workspace: { repositoryPath: options.workspaceManager.options.repositoryPath,
      targetRoot: options.workspaceManager.options.targetRoot,
      maxFiles: options.workspaceManager.options.maxFiles,
      maxBytes: options.workspaceManager.options.maxBytes,
      maxDiffBytes: options.workspaceManager.options.maxDiffBytes },
    disclosurePolicyDigest: options.modelDisclosurePolicyDigest });
  const { dshContext: _context, workspaceManager: _workspace, roleDefinitions: _roleDefinitions,
    feedbackRoleDefinitions: _feedbackRoles, workspaceEditRoles: _editors,
    modelRuntimeDigest: _runtime, currentModelRuntimeDigest: _currentRuntime,
    modelDisclosurePolicyDigest: _disclosure, currentModelDisclosurePolicyDigest: _currentDisclosure,
    authorizeModelRole: _authorize, passThreshold: _threshold,
    evoSkillDisclosure: _evoDisclosure, maxRoleEvidenceRequests: _requests,
    maxWorkspaceReadBytes: _readBytes, closeHost: _close, ...fresh } = options;
  return await createFreshRecipeHostProfile(context, { ...fresh,
    ...(options.recipe === 'evo' ? { skillOverlay: { workspaceManager: options.workspaceManager,
      hostIdentityDigest: overlayIdentity } } : {}),
    physicalHost: ({ research, bindings }) => {
      const accessPolicyDigest = jsonDigest({ research: research.accessPolicyDigest, closureDigest,
        disclosure: options.modelDisclosurePolicyDigest, recipe: options.recipe });
      const grant = (principalId: string) => {
        if (![...required.roles, ...required.feedback].includes(principalId)) throw new Error('Unknown physical role grant');
        return { ...research.campaignGrant, principalId };
      };
      const authorized = (allowed: string[]) => async (roleId: string, envelope: OperationEnvelope) => {
        if (!allowed.includes(roleId) || envelope.campaignId !== context.campaignId)
          throw new Error('Physical role is outside the campaign host policy');
        if (options.currentModelDisclosurePolicyDigest() !== options.modelDisclosurePolicyDigest)
          throw new Error('Model destination disclosure policy changed');
        if (roleId === 'ahe.rollback') verifyAheRestore(context, envelope,
          Number((context.config as Record<string, unknown>).rolloutsPerTask));
        await options.authorizeModelRole(roleId, envelope);
      };
      const roleSessions = new DshRoleSessionRegistry();
      const evo = options.recipe === 'evo' ? createEvoSkillCapabilities({
        artifacts: context.artifacts, bindings, disclosure: options.evoSkillDisclosure! }) : undefined;
      const roleHost = createEvidenceDshRoleHost(options.dshContext, roleSessions, research.evidence, grant,
        options.maxRoleEvidenceRequests ?? 100, {
          stateRoot: context.stateDir, artifacts: context.artifacts,
          trajectoryReader: options.evaluator, heldOutRef: options.spec.datasets.heldOut.ref,
          maxRequests: options.maxRoleEvidenceRequests ?? 100,
        }, evo?.mount);
      const slots = options.recipe === 'evo' ? ['harness', 'skills'] : ['harness'];
      const role = createDshStructuredAdapter({ root: join(context.stateDir, 'physical', 'role'),
        kind: 'execution.role', host: roleHost, sessionRoles: roleSessions,
        artifacts: context.artifacts, bindings, roles: options.roleDefinitions,
        accessPolicyDigest, hostRuntimeDigest: hostRuntimeDigest(evo?.implementationDigest ?? null),
        currentHostRuntimeDigest: () => currentRuntimeDigest(evo?.implementationDigest ?? null),
        campaignBudget: context.budget, requiredSlots: slots,
        authorize: authorized(required.roles), ...(evo ? { publisher: evo.publisher } : {}) });
      const providers = [role];
      if (options.recipe === 'rho') {
        const feedbackSessions = new DshRoleSessionRegistry();
        const feedbackHost = createEvidenceDshRoleHost(options.dshContext, feedbackSessions,
          research.evidence, grant, options.maxRoleEvidenceRequests ?? 100, {
            stateRoot: context.stateDir, artifacts: context.artifacts,
            trajectoryReader: options.evaluator, heldOutRef: options.spec.datasets.heldOut.ref,
            maxRequests: options.maxRoleEvidenceRequests ?? 100,
          });
        providers.push(createDshStructuredAdapter({ root: join(context.stateDir, 'physical', 'feedback'),
          kind: 'execution.feedback', host: feedbackHost, sessionRoles: feedbackSessions,
          artifacts: context.artifacts, bindings, roles: options.feedbackRoleDefinitions!,
          accessPolicyDigest, hostRuntimeDigest: hostRuntimeDigest(null),
          currentHostRuntimeDigest: () => currentRuntimeDigest(null), campaignBudget: context.budget,
          requiredSlots: slots, authorize: authorized(required.feedback) }));
      } else {
        providers.push(createTrustedRolloutFeedbackAdapter({ root: join(context.stateDir, 'physical', 'feedback'),
          stateRoot: context.stateDir, artifacts: context.artifacts, bindings,
          taskAuthority: research.taskAuthority,
          allowedExperienceViewDigests: campaignId => campaignId === context.campaignId
            ? [research.experienceViewRef.digest] : [],
          passThreshold: options.passThreshold!,
          expectedAheRepeats: options.recipe === 'ahe'
            ? Number((context.config as Record<string, unknown>).rolloutsPerTask) : 1,
          accessPolicyDigest }));
      }
      if (required.editors.length) {
        const sessions = new WorkspaceEditSessionRegistry(join(context.stateDir, 'physical', 'edit-sessions'));
        const files = new SkillCandidateFiles(options.workspaceManager,
          { maxReadBytes: options.maxWorkspaceReadBytes ?? 256 * 1024 });
        const editHost = createWorkspaceEditDshHost(options.dshContext, sessions,
          files, options.workspaceManager, options.builder);
        providers.push(createWorkspaceEditAdapter({ root: join(context.stateDir, 'physical', 'edit'),
          host: editHost, sessions, artifacts: context.artifacts, bindings, builder: options.builder,
          workspaceManager: options.workspaceManager, files, roles: workspaceEditRoles,
          hostRuntimeDigest: hostRuntimeDigest(null), currentHostRuntimeDigest: () => currentRuntimeDigest(null),
          accessPolicyDigest, campaignBudget: context.budget, requiredSlots: ['harness'],
          editorContextDigest: jsonDigest({ closureDigest, recipe: options.recipe,
            projection: 'scientific-editor-context-v1' }),
          editorContext: (roleId, envelope): JsonValue => {
            const input = envelope.input as Record<string, JsonValue>;
            const names = roleId === 'rho.optimizer' ? ['proposalIndex', 'diagnoses']
              : roleId === 'ahe.evolver'
                ? ['measurement', 'bestMeasured', 'predictionVerdict', 'evidenceReports', 'evidenceTraces', 'attribution']
                : ['files', 'predictionVerdict'];
            const projected = Object.fromEntries(names.filter(name => input[name] !== undefined)
              .map(name => [name, input[name]]));
            const safe = sanitizePublicValue(projected, options.spec.datasets.heldOut.ref, []);
            assertJson(safe);
            return safe;
          },
          authorize: authorized(required.editors) }));
      }
      return { providers, close: closeHost };
    } });
  }
  catch (error) {
    try { await closeHost(); }
    catch (cleanupError) { if (error instanceof Error && error.cause === undefined) error.cause = cleanupError; }
    throw error;
  }
}

function verifyAheRestore(context: AlgorithmHostContext, envelope: OperationEnvelope, repeats: number): void {
  const input = envelope.input as Record<string, unknown>;
  const prior = input.previousMeasurement as Record<string, unknown> | undefined;
  const source = input.restoreFromBindingSetRef as { digest?: unknown; schemaId?: unknown } | undefined;
  if (!prior || !source || !prior.bindingSetRef || jsonDigest(prior.bindingSetRef) !== jsonDigest(source)
    || typeof source.digest !== 'string' || source.digest === envelope.bindingSetRef.digest
    || !Number.isSafeInteger(repeats) || repeats < 1) {
    throw new Error('AHE rollback requires the distinct prior measured binding');
  }
  const rollouts = prior.authorizedRollouts as Record<string, unknown> | undefined;
  const taskPassed = prior.taskPassed as Record<string, unknown> | undefined;
  if (!rollouts || !taskPassed || Object.keys(rollouts).length !== (context.config as Record<string, unknown>).taskCount
    || Object.keys(rollouts).sort().join('\0') !== Object.keys(taskPassed).sort().join('\0'))
    throw new Error('AHE rollback prior measurement lacks its physical task cohort');
  for (const [taskId, tuples] of Object.entries(rollouts)) {
    if (typeof taskPassed[taskId] !== 'boolean' || !Array.isArray(tuples) || tuples.length !== repeats)
      throw new Error('AHE rollback prior task measurement is incomplete');
    for (const [repeatIndex, tuple] of tuples.entries()) {
      const producer = verifyCompletedRolloutProducer({ stateRoot: context.stateDir,
        artifacts: context.artifacts }, envelope, tuple as { evidenceRef: import('./contracts.js').ArtifactRef;
        receiptRef: import('./contracts.js').ArtifactRef });
      if (producer.taskId !== taskId || producer.bindingSetDigest !== source.digest
        || producer.producerInput.recipePhase !== 'ahe.measure'
        || producer.producerInput.executedRevisionDigest !== source.digest
        || producer.producerInput.repeatIndex !== repeatIndex) {
        throw new Error('AHE rollback source does not match completed prior measurements');
      }
    }
  }
}

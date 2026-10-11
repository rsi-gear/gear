/** Host-side wiring shared by every explicit-state algorithm. */
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { CandidateWorkspaceManager } from '../../candidate/workspace.js';
import type { HarnessBuilder } from '../../harness/builder.js';
import { SkillCandidateFiles } from '../../skill/files.js';
import type { OperationEnvelope, OperationProvider } from '../contracts.js';
import { implementationClosureDigest } from '../data/identity.js';
import { readExperienceView } from '../data/experience.js';
import { readMeasurement } from '../data/measurement.js';
import { createDshStructuredAdapter, createEvidenceDshRoleHost, DshRoleSessionRegistry,
  type StructuredRoleDefinition } from '../providers/roles.js';
import { createWorkspaceEditAdapter, WorkspaceEditSessionRegistry,
  type WorkspaceEditRoleDefinition } from '../providers/workspace-edit.js';
import { createWorkspaceEditDshHost } from '../providers/workspace-edit-host.js';
import { jsonDigest, type JsonValue } from '../schema.js';
import { readCommittedOperations } from './committed-rollout-resolver.js';
import type { HitchExecutionHostOptions, ModelExecutionServices } from './host.js';
import type { AlgorithmHostContext } from '../host-profile.js';

export type DshModelServicesOptions = {
  dshContext: Context;
  builder: HarnessBuilder;
  workspaceManager: CandidateWorkspaceManager;
  editors: WorkspaceEditRoleDefinition[];
  analysts?: StructuredRoleDefinition[];
  /** Fingerprint the configured model, tools, presets, and authorized destination. */
  runtimeDigest: string;
  currentRuntimeDigest(): string;
  authorize(roleId: string, envelope: OperationEnvelope): Promise<void> | void;
  maxEvidenceRequests?: number;
  close?(): Promise<void> | void;
};
type Capabilities = Parameters<NonNullable<HitchExecutionHostOptions['modelServices']>>[1];

/** Reuse the physical editing and evidence-role providers, without recipe-specific catalogs. */
export function createDshModelServices(context: AlgorithmHostContext, capabilities: Capabilities,
  options: DshModelServicesOptions): ModelExecutionServices {
  const { artifacts, stateDir, campaignId } = context;
  const { bindings, research, accessPolicyDigest } = capabilities;
  const roles: ModelExecutionServices['roles'] = {}, providers: OperationProvider[] = [];
  for (const [kind, definitions] of [['editor', options.editors], ['analyst', options.analysts ?? []]] as const)
    for (const role of definitions) {
      if (Object.hasOwn(roles, role.id)) throw new Error(`Duplicate model role ${role.id}`);
      roles[role.id] = kind;
    }
  const authorize = async (roleId: string, envelope: OperationEnvelope): Promise<void> => {
    if (!Object.hasOwn(roles, roleId) || envelope.campaignId !== campaignId) throw new Error('Model role is outside host grant');
    if (options.currentRuntimeDigest() !== options.runtimeDigest) throw new Error('Model runtime or destination changed');
    await options.authorize(roleId, envelope);
  };
  if (options.analysts?.length) {
    const sessions = new DshRoleSessionRegistry();
    const view = readExperienceView(artifacts, research.experienceViewRef);
    const evidenceContext = JSON.stringify({ viewRef: research.experienceViewRef, asOf: view.source.cursor });
    const host = createEvidenceDshRoleHost(options.dshContext, sessions, research.evidence, principalId => {
      if (roles[principalId] !== 'analyst') throw new Error('Evidence role is not granted');
      return { ...research.campaignGrant, principalId };
    }, options.maxEvidenceRequests ?? 100);
    providers.push(createDshStructuredAdapter({ root: join(stateDir, 'model', 'roles'), kind: 'execution.role',
      host, sessionRoles: sessions, artifacts, bindings,
      roles: options.analysts.map(role => ({ ...role,
        instruction: `${role.instruction}\nAuthorized research evidence context: ${evidenceContext}` })),
      accessPolicyDigest, hostRuntimeDigest: options.runtimeDigest, currentHostRuntimeDigest: options.currentRuntimeDigest,
      campaignBudget: context.budget, requiredSlots: ['harness'], authorize }));
  }
  if (options.editors.length) {
    const sessions = new WorkspaceEditSessionRegistry(join(stateDir, 'model', 'edit-sessions'));
    const files = new SkillCandidateFiles(options.workspaceManager, { maxReadBytes: 256 * 1024 });
    const host = createWorkspaceEditDshHost(options.dshContext, sessions, files, options.workspaceManager, options.builder);
    providers.push(createWorkspaceEditAdapter({ root: join(stateDir, 'model', 'edit'), host, sessions,
      artifacts, bindings, builder: options.builder, workspaceManager: options.workspaceManager, files, roles: options.editors,
      hostRuntimeDigest: options.runtimeDigest, currentHostRuntimeDigest: options.currentRuntimeDigest,
      accessPolicyDigest, campaignBudget: context.budget, requiredSlots: ['harness'], authorize,
      editorContextDigest: implementationClosureDigest(['author/dsh-model-services'], 'measured-editor-feedback-v1'),
      editorContext(_roleId, envelope): JsonValue {
        const input = envelope.input as { proposalIndex: number; feedback?: { measurementRef: import('../contracts.js').ArtifactRef;
          comparisonKey: string } };
        if (!input.feedback) return { proposalIndex: input.proposalIndex };
        const measured = readMeasurement(artifacts, input.feedback.measurementRef);
        if (measured.subjectBindings.digest !== envelope.bindingSetRef.digest
          || measured.comparisonKey !== input.feedback.comparisonKey
          || !readCommittedOperations(join(stateDir, 'campaign'), campaignId).some(operation =>
            operation.envelope.kind === 'author.measurement' && operation.outcome.kind === 'result'
            && (operation.outcome.value as { measurementRef?: { digest: string } }).measurementRef?.digest === input.feedback!.measurementRef.digest))
          throw new Error('Editor feedback must be a committed measurement of its parent');
        return { proposalIndex: input.proposalIndex, feedback: { metrics: measured.metrics,
          evidenceRefs: measured.evidenceRefs, taskViewRef: measured.condition.taskViewRef } };
      } }));
  }
  return { providers, roles, ...(options.close ? { close: options.close } : {}) };
}

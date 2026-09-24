import type { EvolutionSpec } from '../types.js';
import { HarnessBuilder } from '../harness/builder.js';
import { HitchCliEvaluator } from '../evaluator/hitch-cli.js';
import type { CandidateWorkspaceManager } from '../candidate/workspace.js';
import type { AlgorithmHostContext, AlgorithmHostProfile } from './host-profile.js';
import type { ArtifactRef, BindingSchema, OperationProvider } from './contracts.js';
import { BindingStore } from './bindings.js';
import { FreshSeedExperienceSource } from './data/fresh-seed.js';
import { createFreshHitchRolloutContext } from './data/fresh-rollout-context.js';
import { implementationClosureDigest } from './data/identity.js';
import { readExperienceView } from './data/experience.js';
import { prepareTaskViewFromExperience } from './data/tasks.js';
import { HitchRolloutPort } from './providers/hitch.js';
import { VerifiedExecutionAdapter } from './providers/execution.js';
import { validateSkillOverlaySelection } from './providers/skill-overlay.js';
import { createResearchProfileFromSource, type SealedResearchProfile } from './research-profile.js';
import { assertJson, jsonDigest, type JsonValue } from './schema.js';

export type FreshRecipeKind = 'rho' | 'ahe' | 'evo';
export type FreshPhysicalHostInput = {
  context: AlgorithmHostContext;
  research: SealedResearchProfile;
  bindings: BindingStore;
  harnessRef: ArtifactRef;
  rollout: VerifiedExecutionAdapter;
  rolloutIdentity: { samplingDigest: string; environmentDigest: string };
};
export type FreshPhysicalHost = { providers: OperationProvider[]; close?(): Promise<void> | void };
export type FreshRecipeHostOptions = {
  recipe: FreshRecipeKind;
  spec: EvolutionSpec;
  workspaceRoot: string;
  authorityId: string;
  builder: HarnessBuilder;
  evaluator: HitchCliEvaluator;
  /** Host-owned reservations, not science-author writable operation JSON. */
  operationLimits: Record<string, Record<string, number>>;
  allowedTaskIds?: readonly string[];
  maxTasks?: number;
  /** Evo only: host-owned initial library and physical Git Skill injection capability. */
  initialSkillsRef?: ArtifactRef;
  skillOverlay?: { workspaceManager: CandidateWorkspaceManager; hostIdentityDigest: string };
  /** Build DSH role, trusted feedback and physical workspace-edit adapters. */
  physicalHost(input: FreshPhysicalHostInput): Promise<FreshPhysicalHost> | FreshPhysicalHost;
};

const bindingSchema = (recipe: FreshRecipeKind): BindingSchema => ({ id: `${recipe}.bindings.v1`,
  slots: { harness: { schemaId: 'harness.directory.v1', required: true, replaceable: recipe !== 'evo' },
    ...(recipe === 'evo' ? { skills: { schemaId: 'skills.library.v1', required: true, replaceable: true } } : {}) } });

/** Host-owned fresh seed setup; recipe authors supply scientific parameters only. */
export async function createFreshRecipeHostProfile(context: AlgorithmHostContext,
  options: FreshRecipeHostOptions): Promise<AlgorithmHostProfile> {
  const science = context.config;
  if (!science || typeof science !== 'object' || Array.isArray(science)) throw new Error('Fresh recipe science config must be an object');
  if (Object.hasOwn(science, 'operationLimits') || Object.hasOwn(science, 'experienceViewRef')
    || Object.hasOwn(science, 'taskViewRef') || Object.hasOwn(science, 'samplingDigest')
    || Object.hasOwn(science, 'environmentDigest') || Object.hasOwn(science, 'asOf')
    || Object.hasOwn(science, 'historyTraceAvailable')) {
    throw new Error('Fresh recipe host-owned refs, digests and reservations cannot be author supplied');
  }
  const repeats = options.recipe === 'rho' ? science.baselineRepeats
    : options.recipe === 'ahe' ? science.rolloutsPerTask : 1;
  if (!Number.isSafeInteger(repeats) || (repeats as number) < (options.recipe === 'rho' ? 2 : 1))
    throw new Error('Fresh recipe needs a positive frozen rollout repetition plan');
  if (options.recipe === 'evo' ? !options.skillOverlay : !!options.skillOverlay || !!options.initialSkillsRef)
    throw new Error('Evo requires a physical Skill overlay; other fresh recipes cannot bind it');
  assertJson(options.operationLimits);
  const source = new FreshSeedExperienceSource({ spec: options.spec, campaignId: context.campaignId,
    workspaceRoot: options.workspaceRoot, authorityId: options.authorityId,
    ...(options.maxTasks === undefined ? {} : { maxTasks: options.maxTasks }) });
  const research = await createResearchProfileFromSource(context, { source, authorityId: options.authorityId,
    ...(options.allowedTaskIds ? { allowedTaskIds: options.allowedTaskIds } : {}) });
  const view = readExperienceView(context.artifacts, research.experienceViewRef);
  const initial = options.spec.initialHarness;
  if (!/^[a-f0-9]{40}$/u.test(initial.ref) || !/^sha256:[a-f0-9]{64}$/u.test(initial.digest))
    throw new Error('Fresh initial harness must name an exact Git commit and manifest digest');
  const manifest = await options.builder.readManifest(initial.ref);
  if (manifest.digest !== initial.digest) throw new Error('Fresh initial harness manifest identity drift');
  const harnessRef = context.artifacts.putJson({ schemaVersion: 1, kind: 'git-harness',
    commitOid: initial.ref, manifestDigest: manifest.digest }, 'harness.directory.v1');
  const bindings = new BindingStore(context.artifacts, bindingSchema(options.recipe));
  const skillsRef = options.recipe === 'evo' ? options.initialSkillsRef
    ?? context.artifacts.putJson({ schemaVersion: 1, skills: [] }, 'skills.library.v1') : undefined;
  if (skillsRef) {
    const library = context.artifacts.getJson(skillsRef) as { skills?: Array<{ contentRef: ArtifactRef }> };
    if (!Array.isArray(library.skills)) throw new Error('Initial Evo Skills library invalid');
    const bindingSetRef = bindings.create({ harness: harnessRef, skills: skillsRef });
    validateSkillOverlaySelection({ baseHarness: { commitOid: initial.ref, manifestDigest: manifest.digest },
      bindingSetRef, skillsLibraryRef: skillsRef,
      selectedSkillRefs: library.skills.map(skill => skill.contentRef),
      artifacts: context.artifacts, bindings });
  }
  const accessPolicyDigest = jsonDigest({ research: research.accessPolicyDigest,
    freshProfileImplementation: implementationClosureDigest(['fresh-profile'], 'fresh-physical-v1'),
    recipe: options.recipe });
  const freshContext = await createFreshHitchRolloutContext({ spec: options.spec, campaignId: context.campaignId,
    workspaceRoot: options.workspaceRoot, minRepetitions: repeats as number });
  const port = await HitchRolloutPort.create({ freshContext, workspaceRoot: options.workspaceRoot,
    stateRoot: context.stateDir, artifacts: context.artifacts, bindings,
    taskAuthority: research.taskAuthority,
    allowedExperienceViewDigests: campaignId => {
      if (campaignId !== context.campaignId) throw new Error('Fresh task campaign grant mismatch');
      return [research.experienceViewRef.digest];
    }, accessPolicyDigest, builder: options.builder,
    evaluator: options.evaluator, campaignBudget: context.budget,
    ...(options.skillOverlay ? { skillOverlay: options.skillOverlay } : {}) });
  const rollout = new VerifiedExecutionAdapter(port, context.artifacts, bindings,
    options.recipe === 'evo' ? ['harness', 'skills'] : ['harness']);
  const rolloutIdentity = port.profile();
  const physical = await options.physicalHost({ context, research, bindings, harnessRef, rollout, rolloutIdentity });
  try {
    const providers = [...research.providers, rollout, ...physical.providers];
    const kinds = new Set<string>();
    for (const provider of providers) {
      const declared = provider.describe();
      if (kinds.has(declared.kind)) throw new Error(`Fresh host has duplicate operation provider: ${declared.kind}`);
      kinds.add(declared.kind);
      for (const dimension of declared.meteredDimensions) {
        const reserved = options.operationLimits[declared.kind]?.[dimension];
        if (!Number.isFinite(reserved) || (reserved as number) < 0 || !context.budget[dimension]) {
          throw new Error(`Fresh host operation reservation missing: ${declared.kind}.${dimension}`);
        }
      }
    }
    for (const kind of options.recipe === 'evo' ? ['execution.role', 'execution.feedback']
      : ['execution.role', 'execution.feedback', 'execution.workspace-edit']) {
      if (!kinds.has(kind)) throw new Error(`Fresh ${options.recipe.toUpperCase()} physical host missing: ${kind}`);
    }
    const recipeKinds = new Set(options.recipe === 'evo'
      ? ['tasks.consume', 'execution.role', 'execution.rollout', 'execution.feedback', 'bindings.derive']
      : ['evidence.query', 'evidence.read', 'tasks.select', 'tasks.consume', 'execution.role',
        'execution.rollout', 'execution.feedback', 'execution.workspace-edit', 'bindings.derive']);
    const operationLimits = Object.fromEntries(Object.entries(options.operationLimits)
      .filter(([kind]) => recipeKinds.has(kind)));
    const resolved: Record<string, JsonValue> = { ...science,
      ...(options.recipe === 'evo' ? {} : { historyTraceAvailable: false }),
      ...(options.recipe === 'evo' ? {} : { experienceViewRef: research.experienceViewRef, asOf: view.source.cursor }),
      samplingDigest: rolloutIdentity.samplingDigest, environmentDigest: rolloutIdentity.environmentDigest,
      operationLimits };
    if (options.recipe === 'ahe' || options.recipe === 'evo') {
      const count = options.recipe === 'ahe' ? science.taskCount
        : options.allowedTaskIds?.length ?? view.entries.filter(entry => entry.kind === 'task-trajectory').length;
      if (!Number.isSafeInteger(count) || (count as number) < 1)
        throw new Error('Fresh AHE/Evo task count invalid');
      const allowed = new Set(options.allowedTaskIds ?? view.entries.map(entry => entry.taskId).filter((id): id is string => !!id));
      const selected = view.entries.filter(entry => entry.kind === 'task-trajectory' && entry.taskId && allowed.has(entry.taskId))
        .slice(0, count as number).map(entry => ({ id: entry.taskId!,
          purpose: options.recipe === 'evo' ? 'train' as const : 'development' as const }));
      if (selected.length !== count) throw new Error('AHE task count exceeds authorized fresh seed tasks');
      resolved.taskViewRef = research.taskAuthority.seal(prepareTaskViewFromExperience(context.artifacts,
        research.experienceViewRef, selected));
    }
    return { providers, bindings: { harness: harnessRef, ...(skillsRef ? { skills: skillsRef } : {}) }, config: resolved,
      ...(physical.close ? { close: () => physical.close!() } : {}) };
  } catch (error) {
    await physical.close?.();
    throw error;
  }
}

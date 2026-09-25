import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, OperationEnvelope, OperationProvider } from './contracts.js';
import { FileArtifactStore } from './artifacts.js';
import { EvidenceService, type EvidenceGrant } from './data/evidence.js';
import { readExperienceView, sealExperienceView, type ExperienceProjection,
  type ExperienceSourceAuthority, type SourceSelector } from './data/experience.js';
import { TaskViewAuthority, readTaskView } from './data/tasks.js';
import { implementationClosureDigest } from './data/identity.js';
import { createEvidenceProviders } from './providers/evidence.js';
import { createTasksConsumeProvider, createTasksSelectProvider } from './providers/tasks.js';
import { durableCreate } from './providers/provider-record.js';
import { canonicalJson, jsonDigest } from './schema.js';
import type { AlgorithmHostContext } from './host-profile.js';

export type SealedResearchProfileOptions = {
  /** This ref is a host grant. Do not derive it from untrusted recipe configuration. */
  authorizedExperienceViewRef: ArtifactRef;
  authorityId: string;
  allowedTaskIds?: readonly string[];
};

export type SealedResearchProfile = {
  providers: OperationProvider[];
  evidence: EvidenceService;
  taskAuthority: TaskViewAuthority;
  experienceViewRef: ArtifactRef;
  accessPolicyDigest: string;
  campaignGrant: EvidenceGrant;
};
export type SelectableResearchSource = ExperienceSourceAuthority & { selector(): Promise<SourceSelector> };

function persistentKey(directory: string, name: string): Buffer {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  if (!existsSync(path)) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, randomBytes(32)); fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error(`Host authority key is invalid: ${name}`);
  return key;
}

function restrictTaskProvider(provider: OperationProvider, artifacts: FileArtifactStore,
  allowedTaskIds: readonly string[] | undefined): OperationProvider {
  if (!allowedTaskIds) return provider;
  const allowed = new Set(allowedTaskIds);
  const check = (envelope: OperationEnvelope): void => {
    if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input))
      throw new Error('Research task input invalid');
    if (envelope.kind === 'tasks.select') {
      const tasks = envelope.input.tasks;
      if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task !== 'object'
        || Array.isArray(task) || typeof task.id !== 'string' || !allowed.has(task.id))) {
        throw new Error('Research task selection exceeds task grant');
      }
    } else if (envelope.kind === 'tasks.consume') {
      const ref = envelope.input.taskViewRef as ArtifactRef;
      const view = readTaskView(artifacts, ref);
      if (view.tasks.some(task => !allowed.has(task.id))) throw new Error('Research task consumption exceeds task grant');
    }
  };
  return { describe: () => provider.describe(),
    preflight: envelope => { check(envelope); return provider.preflight(envelope); },
    submit: envelope => { check(envelope); return provider.submit(envelope); },
    inspect: envelope => { check(envelope); return provider.inspect(envelope); },
    cancel: envelope => { check(envelope); return provider.cancel(envelope); },
    collect: envelope => { check(envelope); return provider.collect(envelope); } };
}

/** Install operations for one already authorized and sealed research view. */
export function createSealedResearchProfile(context: AlgorithmHostContext,
  options: SealedResearchProfileOptions): SealedResearchProfile {
  const { artifacts, stateDir, campaignId, budget } = context;
  const ref = options.authorizedExperienceViewRef;
  const view = readExperienceView(artifacts, ref);
  if (view.provenance !== 'verified' || view.purpose !== 'research' || view.labelsExposed !== false
    || view.authorityId !== options.authorityId)
    throw new Error('Research profile needs a verified label-free sealed view');
  if (!options.authorityId) throw new Error('Research authority identity required');
  const allowedTasks = options.allowedTaskIds === undefined ? undefined : [...options.allowedTaskIds];
  if (allowedTasks && (new Set(allowedTasks).size !== allowedTasks.length
    || allowedTasks.some(id => !view.entries.some(entry => entry.taskId === id)))) {
    throw new Error('Research profile task grant exceeds sealed view');
  }
  const authorityRoot = join(stateDir, 'host-authority');
  const evidenceKey = persistentKey(authorityRoot, 'evidence.key');
  const taskKey = persistentKey(authorityRoot, 'tasks.key');
  const keyDigests = [evidenceKey, taskKey].map(key => createHash('sha256').update(key).digest('hex'));
  const accessPolicyDigest = jsonDigest({ campaignId, authorityId: options.authorityId,
    authorizedViewDigest: ref.digest, allowedTasks: allowedTasks ?? null,
    projections: view.projections, keyDigests,
    profileImplementationDigest: implementationClosureDigest(['research-profile', 'providers/provider-record'],
      'verified-research-grants-v1') });
  const evidence = new EvidenceService(artifacts, evidenceKey);
  const taskAuthority = new TaskViewAuthority(artifacts, options.authorityId, taskKey);
  const grant = (principalId: string): EvidenceGrant => ({ principalId,
    viewDigests: [ref.digest], projections: view.projections as ExperienceProjection[],
    ...(allowedTasks ? { taskIds: allowedTasks } : {}) });
  const taskGrant = (requestedCampaignId: string): { allowedExperienceViewDigests: readonly string[] } => {
    if (requestedCampaignId !== campaignId) throw new Error('Research task campaign grant mismatch');
    return { allowedExperienceViewDigests: [ref.digest] };
  };
  const providers = [
    ...createEvidenceProviders(join(stateDir, 'research-providers', 'evidence'), evidence,
      principalId => { if (principalId !== campaignId) throw new Error('Research evidence campaign grant mismatch'); return grant(principalId); },
      accessPolicyDigest, budget),
    restrictTaskProvider(createTasksSelectProvider(join(stateDir, 'research-providers', 'tasks-select'), artifacts,
      taskAuthority, taskGrant, accessPolicyDigest), artifacts, allowedTasks),
    restrictTaskProvider(createTasksConsumeProvider(join(stateDir, 'research-providers', 'tasks-consume'), artifacts,
      taskAuthority, taskGrant, accessPolicyDigest), artifacts, allowedTasks),
  ];
  return { providers, evidence, taskAuthority, experienceViewRef: ref, accessPolicyDigest,
    campaignGrant: grant(campaignId) };
}

/** Ask a host authority to seal the view; a recipe never passes raw task paths or grants. */
export async function createResearchProfileFromSource(context: AlgorithmHostContext,
  options: { source: SelectableResearchSource; authorityId: string;
    projections?: ExperienceProjection[]; allowedTaskIds?: readonly string[] }): Promise<SealedResearchProfile> {
  const projections = options.projections ?? ['overview', 'task-report'];
  const pinPath = join(context.stateDir, 'host-authority', 'research-view.json');
  let pin: { schemaVersion: 1; authorityId: string; selector: SourceSelector;
    projections: ExperienceProjection[]; experienceViewRef: ArtifactRef };
  if (existsSync(pinPath)) {
    pin = JSON.parse(readFileSync(pinPath, 'utf8')) as typeof pin;
  } else {
    const selector = await options.source.selector();
    const experienceViewRef = await sealExperienceView(context.artifacts, options.source, selector, 'research', projections);
    const candidate = { schemaVersion: 1 as const, authorityId: options.authorityId,
      selector, projections, experienceViewRef };
    mkdirSync(join(context.stateDir, 'host-authority'), { recursive: true, mode: 0o700 });
    pin = durableCreate(pinPath, JSON.stringify(candidate)) ? candidate
      : JSON.parse(readFileSync(pinPath, 'utf8')) as typeof pin;
  }
  const view = readExperienceView(context.artifacts, pin.experienceViewRef);
  if (pin.schemaVersion !== 1 || pin.authorityId !== options.authorityId
    || canonicalJson(pin.projections) !== canonicalJson(projections)
    || canonicalJson(pin.selector) !== canonicalJson(view.source)
    || view.authorityId !== options.authorityId || view.purpose !== 'research') {
    throw new Error('Frozen research source selection or grant changed');
  }
  const experienceViewRef = pin.experienceViewRef;
  return createSealedResearchProfile(context, { authorizedExperienceViewRef: experienceViewRef,
    authorityId: options.authorityId,
    ...(options.allowedTaskIds ? { allowedTaskIds: options.allowedTaskIds } : {}) });
}

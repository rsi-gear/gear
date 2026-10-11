import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, sha256 } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { jsonDigest } from '../../src/algorithm/schema.js';
import type { ArtifactRef, OperationEnvelope } from '../../src/algorithm/contracts.js';
import { FreshSeedExperienceSource } from '../../src/algorithm/data/fresh-seed.js';
import { createFreshHitchRolloutContext } from '../../src/algorithm/data/fresh-rollout-context.js';
import { sealExperienceView } from '../../src/algorithm/data/experience.js';
import { TaskViewAuthority, readTaskView, taskViewFromExperience } from '../../src/algorithm/data/tasks.js';
import { HitchRolloutPort, createHitchRolloutAdapter } from '../../src/algorithm/providers/hitch.js';
import { CandidateWorkspaceManager } from '../../src/candidate/workspace.js';
import { HarnessBuilder, type HarnessCompiler } from '../../src/harness/builder.js';
import type { CompilerCheckReport } from '../../src/harness/check-report.js';
import type { HarnessManifest } from '../../src/types.js';
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js';
import { createRecordedHitchCliFixture } from '../helpers/algorithm-hitch-recorded-cli.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { evolutionSpec } from '../helpers/research-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const markdown = '---\nname: verify-change\ndescription: Verify a change using focused checks.\n---\n\n# Verify Change\n\nRun the focused check.\n';
const contentDigest = `sha256:${createHash('sha256').update(markdown).digest('hex')}`;

class PhysicalSkillCheck implements HarnessCompiler {
  readonly runtimeValidation = true;
  async compile(worktree: string, _signal: AbortSignal, manifest?: HarnessManifest): Promise<CompilerCheckReport> {
    const content = await readFile(join(worktree, 'harness', 'skills', 'verify-change', 'SKILL.md'), 'utf8');
    if (content !== markdown) throw new Error('Physical Skill bytes differ from the selected body');
    const passed = { status: 'passed' as const };
    return { ok: true, status: 'passed', runtime: { schemaVersion: 1,
      candidateDigest: manifest!.digest, identity: { name: 'fixture-runtime', version: '1', lockDigest: sha256('runtime') },
      load: passed, promptAssembly: passed, skillDiscovery: { status: 'passed', checked: 1, expected: 1 },
      skillRead: { status: 'passed', checked: 1, expected: 1 }, cleanup: passed,
      skills: [{ name: 'verify-change', path: 'skills/verify-change/SKILL.md',
        provider: 'filesystem', contentDigest, read: 'passed' }] } };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-hitch-skill-')); roots.push(root);
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const seed = await standardSearchDataset(root, 2, 'seed');
  const held = await standardSearchDataset(root, 1, 'held-out');
  const base = evolutionSpec();
  const spec = { ...base, initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } },
    rollout: { ...base.rollout, repetitions: 1 } };
  const freshContext = await createFreshHitchRolloutContext({ spec, campaignId: 'skill-campaign', workspaceRoot: root,
    minRepetitions: 1 });
  const artifacts = new FileArtifactStore(join(root, 'artifacts'));
  const source = new FreshSeedExperienceSource({ spec, campaignId: 'skill-campaign', workspaceRoot: root,
    authorityId: 'fixture-host' });
  const viewRef = await sealExperienceView(artifacts, source, await source.selector(), 'research', ['overview', 'task-report']);
  const rawTaskRef = taskViewFromExperience(artifacts, viewRef, [{ id: 'task-1', purpose: 'development' }]);
  const authority = new TaskViewAuthority(artifacts, 'fixture-task-host', Buffer.alloc(32, 5));
  const taskViewRef = authority.seal(readTaskView(artifacts, rawTaskRef));
  const task = readTaskView(artifacts, taskViewRef).tasks[0]!;
  const bindings = new BindingStore(artifacts, { id: 'evo.bindings.v1', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: false },
    skills: { schemaId: 'skills.library.v1', required: true, replaceable: true },
  } });
  const harness = artifacts.putJson({ schemaVersion: 1, kind: 'git-harness', commitOid: git.championRef,
    manifestDigest: git.manifest.digest }, 'harness.directory.v1');
  const skillBody = artifacts.putJson({ schemaVersion: 1, markdown }, 'skills.body.v1');
  const skillsLibrary = artifacts.putJson({ schemaVersion: 1,
    skills: [{ name: 'verify-change', contentRef: skillBody }] }, 'skills.library.v1');
  const bindingSetRef = bindings.create({ harness, skills: skillsLibrary });
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1',
    compiler: new PhysicalSkillCheck() });
  const stateRoot = join(root, 'algorithm-state');
  const workspaceManager = new CandidateWorkspaceManager({ repositoryPath: git.repository,
    targetRoot: git.targetRoot, rootForEvolution: id => join(root, 'workspaces', id),
    maxFiles: 4, maxBytes: 100_000, maxDiffBytes: 100_000 });
  await workspaceManager.initialize(); await builder.initialize();
  const recorded = await createRecordedHitchCliFixture('0.2.8', {},
    { followSubmission: true, controlPlane: { mode: 'daemon', requireModelCapture: false } }, git);
  const options = { freshContext, workspaceRoot: root, stateRoot, artifacts, bindings,
    taskAuthority: authority, allowedExperienceViewDigests: () => [viewRef.digest],
    accessPolicyDigest: sha256('skill-policy'), builder, evaluator: recorded.evaluator,
    campaignBudget: { 'rollout.trials': { unit: 'trials', limit: 4, source: 'hitch-rollout', capability: 'hard' as const } },
    skillOverlay: { workspaceManager, hostIdentityDigest: sha256('skill-overlay-host') } };
  const port = await HitchRolloutPort.create(options);
  const adapter = await createHitchRolloutAdapter(options);
  const input = { task, taskViewRef, skillBindingSetDigest: bindingSetRef.digest,
    injectedSkillRefs: [skillBody], samplingDigest: port.profile().samplingDigest,
    environmentDigest: port.profile().environmentDigest, recipePhase: 'evo.batch' };
  const operationId = sha256('skill-rollout-operation');
  const envelope: OperationEnvelope = { operationId, idempotencyKey: operationId, campaignId: 'skill-campaign',
    decisionIndex: 0, localKey: 'rollout', kind: 'execution.rollout', input,
    inputDigest: jsonDigest(input), implementationDigest: adapter.describe().implementationDigest,
    bindingSetRef, limits: { 'rollout.trials': 1 } };
  return { root, git, artifacts, builder, recorded, adapter, options, envelope, skillBody, skillsLibrary, stateRoot };
}

describe('Hitch Evo Skill overlay physical dispatch (recorded CLI, no model call)', () => {
  it('preflights without a workspace, then dispatches the checked derived Git commit and resumes once', async () => {
    const f = await fixture();
    await f.adapter.preflight(f.envelope);
    expect(gitOutput(f.git.repository, ['rev-list', '--count', 'HEAD'])).toBe('2');
    const workspaceRoot = join(f.root, 'workspaces');
    await expect(readdir(workspaceRoot)).rejects.toThrow();
    const started = await f.adapter.submit(f.envelope);
    expect(started.status).toBe('running');
    const completed = await f.adapter.inspect(f.envelope);
    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed' || completed.completion.outcome.kind !== 'result') throw new Error('missing result');
    const result = completed.completion.outcome.value as unknown as { receiptRef: ArtifactRef; evidenceRef: ArtifactRef };
    const receipt = f.artifacts.getJson(result.receiptRef) as Record<string, unknown>;
    expect(receipt.injectedSkillDigests).toEqual([f.skillBody.digest]);
    expect(receipt.executedHarnessCommit).not.toBe(f.git.championRef);
    const overlayRef = receipt.skillOverlayReceiptRef as ArtifactRef;
    const overlayReceipt = f.artifacts.getJson(overlayRef) as Record<string, unknown>;
    expect(overlayReceipt.commitOid).toBe(receipt.executedHarnessCommit);
    expect((await f.builder.readHarnessFile(String(receipt.executedHarnessCommit),
      'skills/verify-change/SKILL.md')).content).toBe(markdown);
    const evidence = f.artifacts.getJson(result.evidenceRef) as { evidence: { actualCommit: string } };
    expect(evidence.evidence.actualCommit).toBe(receipt.executedHarnessCommit);
    expect(completed.completion.receipt?.cumulative).toEqual({ 'rollout.trials': 1 });
    const restarted = await createHitchRolloutAdapter(f.options);
    expect((await restarted.inspect(f.envelope)).status).toBe('completed');
    expect(gitOutput(f.git.repository, ['rev-list', '--count', 'HEAD'])).toBe('2');
    const calls = (await readFile(f.recorded.invocationLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args[0] === 'eval' && args[1] === 'submit')).toHaveLength(1);
  });

  it('rejects forged selected Skill before creating a workspace or daemon submission', async () => {
    const f = await fixture();
    const unrelated = f.artifacts.putJson({ schemaVersion: 1, markdown: markdown.replace('Run the focused check.', 'Different body.') },
      'skills.body.v1');
    const input = { ...(f.envelope.input as object), injectedSkillRefs: [unrelated] };
    await expect(f.adapter.preflight({ ...f.envelope, input, inputDigest: jsonDigest(input) }))
      .rejects.toThrow(/absent from the bound library/);
    await expect(readdir(join(f.root, 'workspaces'))).rejects.toThrow();
    expect(existsSync(f.recorded.invocationLog)).toBe(false);
  });

  it('cancels before submit without materializing a Skill workspace or dispatching Hitch', async () => {
    const f = await fixture();
    const cancelled = await f.adapter.cancel(f.envelope);
    expect(cancelled).toMatchObject({ status: 'cancelled', releaseConfirmed: true,
      receipt: { cumulative: { 'rollout.trials': 0 } } });
    await expect(f.adapter.submit(f.envelope)).rejects.toThrow(/cancelled before submission/);
    await expect(readdir(join(f.root, 'workspaces'))).rejects.toThrow();
    expect(existsSync(f.recorded.invocationLog)).toBe(false);
  });

  it('keeps a lost overlay finalization unknown and never dispatches the base harness', async () => {
    const f = await fixture();
    const original = f.builder.finalizeWorkspace.bind(f.builder);
    f.builder.finalizeWorkspace = async (...args) => {
      await original(...args);
      throw new Error('lost Git finalization response');
    };
    await expect(f.adapter.submit(f.envelope)).rejects.toThrow(/lost Git finalization response/);
    f.builder.finalizeWorkspace = original;
    const reopened = await createHitchRolloutAdapter(f.options);
    expect((await reopened.inspect(f.envelope)).status).toBe('unknown');
    expect(gitOutput(f.git.repository, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(existsSync(f.recorded.invocationLog)).toBe(false);
  });
});

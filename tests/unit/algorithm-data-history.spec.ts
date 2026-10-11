import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvolutionRegistryStore } from '../../src/state/evolution.js';
import { digestJson } from '../../src/state/digest.js';
import { HistoricalSeedExperienceSource } from '../../src/algorithm/data/history-source.js';
import { FileArtifactStore } from '../../src/algorithm/artifacts.js';
import { readExperienceView, sealExperienceView } from '../../src/algorithm/data/experience.js';
import { taskViewFromExperience, readTaskView } from '../../src/algorithm/data/tasks.js';
import { evidence, evolutionSpec, roundFixture, SHA } from '../helpers/research-fixture.js';
import { standardSearchDataset } from '../helpers/standard-search-dataset.js';
import { trajectoryAnalysis, trajectoryReader } from '../helpers/trajectory-fixture.js';
import type { EvaluationCondition, RefinementRound } from '../../src/types.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'gear-physical-history-')); paths.push(path);
  const workspace = join(path, 'workspace');
  const seed = await standardSearchDataset(workspace, 2, 'seed');
  const held = await standardSearchDataset(workspace, 1, 'held-out');
  const spec = { ...evolutionSpec(), datasets: { seed: { ref: 'seed', digest: seed.digest }, heldOut: { ref: 'held-out', digest: held.digest } } };
  const registry = new EvolutionRegistryStore(join(path, 'registry'));
  await registry.createEvolution({ spec, champion: { schemaVersion: 2, ref: spec.initialHarness.ref,
    manifestDigest: spec.initialHarness.digest, updatedAt: 'now' } });
  const base = roundFixture({ workspaceRoot: workspace, seedTaskRef: 'seed', heldOutRef: 'held-out' });
  function condition(original: EvaluationCondition, dataset: { ref: string; digest: string }): EvaluationCondition {
    const { conditionId: ignored, ...body } = original;
    return { ...body, dataset, conditionId: digestJson({ ...body, dataset }) };
  }
  const seedCondition = condition(base.plan.seed, { ref: 'seed', digest: seed.digest });
  const heldCondition = condition(base.plan.heldOut, { ref: 'held-out', digest: held.digest });
  const plan = { ...base.plan, seed: seedCondition, heldOut: heldCondition,
    digest: digestJson({ roundId: base.roundId, taskSampler: base.plan.taskSampler, seed: seedCondition, heldOut: heldCondition }) };
  const round: RefinementRound = { ...base, plan };
  await registry.stateStore(spec.evolutionId).writeRound(round);
  return { path, workspace, seed, held, spec, registry, round };
}

describe('physical historical seed source', () => {
  it('seals real task bytes and exact dataset/task digests; rejects changed source after selection', async () => {
    const setup = await fixture();
    const source = new HistoricalSeedExperienceSource({ registry: setup.registry, evolutionId: setup.spec.evolutionId,
      roundId: setup.round.roundId, workspaceRoot: setup.workspace, authorityId: 'trusted-history' });
    const selector = await source.selector();
    const { snapshot } = await source.resolve(selector, 'research');
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]!.task?.prompt).toBe('seed fixture task 0\n');
    expect(snapshot.entries[0]!.taskReport.narrative).toContain('Instruction:\nseed fixture task 0\n');
    expect(snapshot.entries[0]!.taskReport.narrative).not.toContain('held-out');
    expect(snapshot.entries[0]!.task?.executionSource?.datasetDigest).toBe(setup.seed.digest);
    expect(snapshot.entries[0]!.task?.executionSource?.taskContentDigest).toMatch(/^sha256:/);
    const artifacts = new FileArtifactStore(join(setup.path, 'artifacts'));
    const view = await sealExperienceView(artifacts, source, selector, 'research', ['overview', 'task-report']);
    const reportRef = readExperienceView(artifacts, view).entries[0]!.taskReportRef!;
    expect(artifacts.getJson(reportRef)).toMatchObject({ narrative: expect.stringContaining('seed fixture task 0') });
    const tasks = taskViewFromExperience(artifacts, view, [{ id: 'task-0', purpose: 'development' }]);
    const selected = readTaskView(artifacts, tasks).tasks[0]!;
    expect(artifacts.getJson(selected.contentRef)).toMatchObject({ prompt: 'seed fixture task 0\n', executionSource: {
      datasetDigest: setup.seed.digest,
    } });
    await writeFile(join(setup.seed.ref, 'task-0', 'instruction.md'), 'modified task\n');
    await expect(source.resolve(selector, 'research')).rejects.toThrow(/dataset changed/);
  });

  it('binds paged real Hitch trajectory to saved seed run and redacts grader fields', async () => {
    const setup = await fixture();
    const prior = evidence(setup.round.plan.seed, setup.round.targetHarnessRef);
    await setup.registry.stateStore(setup.spec.evolutionId).writeRound({ ...setup.round, baseline: prior });
    const runId = prior.trials[0]!.runId!;
    const analysis = trajectoryAnalysis(runId, [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'work on task' }] } },
      { type: 'tool/result', data: { message: 'tool output', graderLabel: 'PRIVATE-GRADER', score: 0.5 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    ]);
    const source = new HistoricalSeedExperienceSource({ registry: setup.registry, evolutionId: setup.spec.evolutionId,
      roundId: setup.round.roundId, workspaceRoot: setup.workspace, authorityId: 'trusted-history',
      evaluationId: prior.evalId, trajectoryReader: trajectoryReader(new Map([[runId, analysis]])) });
    const { snapshot } = await source.resolve(await source.selector(), 'research');
    const trace = snapshot.entries.find(entry => entry.taskId === 'task-1')!.traceChunks.map(chunk => chunk.text).join('\n');
    expect(trace).toContain(runId);
    expect(trace).toContain(analysis.source.canonicalSha256);
    expect(trace).toContain('tool/result');
    expect(trace).not.toContain('PRIVATE-GRADER');
    expect(trace).not.toContain('0.5');
    expect(snapshot.entries.find(entry => entry.taskId === 'task-0')!.traceChunks).toEqual([]);
  });

  it('retrieves truncated tool details only through canonical-digest-bound Hitch field pages', async () => {
    const setup = await fixture();
    const prior = evidence(setup.round.plan.seed, setup.round.targetHarnessRef);
    await setup.registry.stateStore(setup.spec.evolutionId).writeRound({ ...setup.round, baseline: prior });
    const runId = prior.trials[0]!.runId!;
    const analysis = trajectoryAnalysis(runId, [
      { type: 'tool/result', data: { message: 'original tool result' } },
    ]);
    analysis.coverage.content = 'excerpted';
    analysis.redactions = [{ ruleId: 'hitch-secret-field', count: 1 }];
    (analysis.events[0] as { data: { message?: unknown } }).data.message = {
      preview: 'incomplete preview', bytes: 100, sha256: SHA('a'), truncated: true,
      source: { runId, seq: 0, field: 'data.message' },
    };
    const reader = trajectoryReader(new Map([[runId, analysis]]));
    const original = reader.inspectTrajectoryEvents.bind(reader);
    let detailCalls = 0;
    reader.inspectTrajectoryEvents = async (requested, query, signal) => {
      if (query.field) {
        detailCalls++;
        expect(query).toMatchObject({ seqStart: 0, seqEnd: 0, field: 'data.message',
          canonicalSha256: analysis.source.canonicalSha256, limit: 1 });
        return { schemaVersion: 1, kind: 'trajectory-events-page', runId: requested,
          canonicalSha256: analysis.source.canonicalSha256,
          filter: { seqStart: 0, seqEnd: 0, field: 'data.message' },
          events: [{ type: 'tool/result', seq: 0, value: 'complete bounded tool output' }],
          totalMatches: 1, eof: true };
      }
      return original(requested, query, signal);
    };
    const source = new HistoricalSeedExperienceSource({ registry: setup.registry, evolutionId: setup.spec.evolutionId,
      roundId: setup.round.roundId, workspaceRoot: setup.workspace, authorityId: 'trusted-history',
      evaluationId: prior.evalId, trajectoryReader: reader });
    const { snapshot } = await source.resolve(await source.selector(), 'research');
    const trace = snapshot.entries.find(entry => entry.taskId === 'task-1')!.traceChunks.map(chunk => chunk.text).join('\n');
    expect(detailCalls).toBeGreaterThan(0);
    expect(trace).toContain('complete bounded tool output');
    expect(trace).not.toContain('incomplete preview');
    expect(trace).toContain('hitch-secret-field');
  });
});

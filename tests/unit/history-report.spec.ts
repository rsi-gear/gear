import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runHistoryInspect } from '../../src/history/report-cli.js';
import { inspectHistoricalRoundReport } from '../../src/history/report.js';
import { RefineStateStore } from '../../src/state/store.js';
import { evidence, roundFixture } from '../helpers/research-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'gear-history-report-'));
  roots.push(root);
  await mkdir(join(root, 'rounds'));
  const base = roundFixture();
  const baseline = evidence(base.plan.seed, base.targetHarnessRef, 0);
  const round = roundFixture({ status: 'failed', failure: { phase: 'candidate-generation', message: 'private failure body' },
    baseline, candidatePool: [{ ...base.candidatePool[0]!, status: 'failed',
      failure: { phase: 'candidate-generation', message: 'private candidate body' } }] });
  const path = join(root, 'rounds', `${round.roundId}.json`);
  const bytes = Buffer.from(JSON.stringify(round));
  await writeFile(path, bytes);
  return { root, path, round, bytes };
}
async function sourceBytes(root: string): Promise<Record<string, string>> {
  const files = await readdir(join(root, 'rounds'));
  return Object.fromEntries(await Promise.all(files.map(async name => [name, sha256(await readFile(join(root, 'rounds', name)))])));
}

it('reads a failed round with valid zero-reward evidence as a record, without changing its source', async () => {
  const f = await setup();
  const initialize = vi.spyOn(RefineStateStore.prototype, 'initialize');
  const before = await sourceBytes(f.root);
  try {
    const report = await inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId,
      expectedByteSha256: sha256(f.bytes) });
    expect(report).toMatchObject({ schemaVersion: 1, roundStatus: 'failed', failurePresent: true,
      failurePhase: 'candidate-generation',
      provenance: { byteSha256: sha256(f.bytes), trust: 'record-only' },
      evidence: { baseline: { availability: 'recorded-complete', plannedTrialCount: 1,
        validTrialCount: 1, invalidTrialCount: 0, validZeroRewardCount: 1 },
        finalSeedCandidate: { availability: 'absent' } },
      candidates: [{ status: 'failed', sealedVersionPresent: false, executableStatus: 'unavailable',
        seedEvidence: { availability: 'absent' } }] });
    expect(JSON.stringify(report)).not.toContain('private failure body');
    expect(JSON.stringify(report)).not.toContain('task-1');
    expect(await sourceBytes(f.root)).toEqual(before);
    expect(await readdir(f.root)).toEqual(['rounds']);
    expect(initialize).not.toHaveBeenCalled();
  } finally { initialize.mockRestore(); }
});

it('keeps recorded partial evidence separate from a failed round and from absent candidate evidence', async () => {
  const f = await setup();
  const round = structuredClone(f.round);
  const baseline = round.baseline!;
  baseline.completeness = 'partial';
  baseline.plannedTrialCount = 2;
  baseline.invalidTrials = [{ taskName: 'task-2', trialName: 'trial-2', runId: 'run_' + '2'.repeat(32),
    attempt: 1, status: 'errored', invalidReason: 'infrastructure' }];
  await writeFile(f.path, JSON.stringify(round));
  const report = await inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: round.roundId });
  expect(report.roundStatus).toBe('failed');
  expect(report.evidence.baseline).toEqual({ availability: 'recorded-partial', plannedTrialCount: 2,
    validTrialCount: 1, invalidTrialCount: 1, validZeroRewardCount: 1 });
  expect(report.candidates[0]?.seedEvidence).toEqual({ availability: 'absent' });
});

it('does not infer primary reward from the first unrelated metric', async () => {
  const f = await setup();
  const round = structuredClone(f.round);
  round.baseline!.trials[0]!.rewards = { cost: 0, quality: 1 };
  await writeFile(f.path, JSON.stringify(round));
  const report = await inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: round.roundId });
  expect(report.evidence.baseline).toEqual({ availability: 'recorded-complete', plannedTrialCount: 1,
    validTrialCount: 1, invalidTrialCount: 0 });
  expect(report.evidence.baseline).not.toHaveProperty('validZeroRewardCount');
});

it('fails closed on missing, malformed, drifting and mismatched source records', async () => {
  const f = await setup();
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: 'missing' }))
    .rejects.toMatchObject({ code: 'source-record-missing' });
  await expect(inspectHistoricalRoundReport({ sourceRoot: join(f.root, 'absent-root'), roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'source-record-missing' });
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: '../escape' }))
    .rejects.toMatchObject({ code: 'source-path-invalid' });
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId,
    expectedByteSha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'source-identity-drift' });
  await writeFile(f.path, Buffer.from([0xc3, 0x28]));
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'source-record-invalid' });
  await writeFile(f.path, JSON.stringify({ ...f.round, roundId: 'other' }));
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'round-id-mismatch' });
  await writeFile(f.path, JSON.stringify({ ...f.round, schemaVersion: 999 }));
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'source-version-unsupported' });
  await writeFile(f.path, JSON.stringify({ ...f.round, status: 'impossible' }));
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'source-record-invalid' });
});

it('rejects oversized and symlinked source records before reading', async () => {
  const f = await setup();
  await writeFile(f.path, Buffer.alloc(16 * 1024 * 1024 + 1));
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'source-record-invalid' });
  await rm(f.path);
  const outside = join(f.root, 'outside.json');
  await writeFile(outside, JSON.stringify(f.round));
  await symlink(outside, f.path);
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'source-record-invalid' });
  expect(await readdir(f.root)).toEqual(['outside.json', 'rounds']);
  await rm(join(f.root, 'rounds'), { recursive: true });
  const external = await mkdtemp(join(tmpdir(), 'gear-history-external-'));
  roots.push(external);
  await writeFile(join(external, `${f.round.roundId}.json`), JSON.stringify(f.round));
  await symlink(external, join(f.root, 'rounds'));
  await expect(inspectHistoricalRoundReport({ sourceRoot: f.root, roundId: f.round.roundId }))
    .rejects.toMatchObject({ code: 'source-path-invalid' });
});

it('adapts `history inspect` arguments to one JSON result and throws on errors', async () => {
  const f = await setup();
  const output: string[] = [];
  expect(await runHistoryInspect(['inspect', f.root, '--round', f.round.roundId,
    '--sha256', sha256(f.bytes)], line => output.push(line))).toBe(0);
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toMatchObject({ roundStatus: 'failed',
    provenance: { byteSha256: sha256(f.bytes), trust: 'record-only' } });
  await expect(runHistoryInspect(['inspect', f.root], line => output.push(line)))
    .rejects.toMatchObject({ code: 'source-path-invalid' });
  await expect(runHistoryInspect(['inspect', f.root, '--round', 'missing'], line => output.push(line)))
    .rejects.toMatchObject({ code: 'source-record-missing' });
  expect(output).toHaveLength(1);
});

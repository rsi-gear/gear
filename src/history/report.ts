/** Read a retained refinement round as a report, without reopening its runtime. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { assertJson } from '../algorithm/schema.js';
import { RefineStateStore } from '../state/store.js';
import type { EvaluationEvidence, RefinementRound } from '../types.js';

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PHASE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

type EvidenceAvailability = 'absent' | 'recorded-complete' | 'recorded-partial';
export type HistoricalEvidenceSummary = {
  availability: EvidenceAvailability;
  /** Counted only from valid, completed trials in the structurally checked round record. */
  validZeroRewardCount?: number;
  plannedTrialCount?: number;
  validTrialCount?: number;
  invalidTrialCount?: number;
};
export type HistoricalRoundReportV1 = {
  schemaVersion: 1;
  provenance: { kind: 'legacy-round-record'; sourceRoot: string; evolutionId: string; roundId: string;
    byteSha256: string; trust: 'record-only' };
  roundStatus: RefinementRound['status'];
  failurePresent: boolean;
  failurePhase?: string;
  decision?: RefinementRound['decision'];
  candidates: Array<{ candidateId: string; status: RefinementRound['candidatePool'][number]['status'];
    sealedVersionPresent: boolean; executableStatus: 'unavailable' | 'not-verified';
    seedEvidence: HistoricalEvidenceSummary; heldOutEvidence: HistoricalEvidenceSummary }>;
  attempts: Array<{ provider: string; evalId: string;
    phase: NonNullable<RefinementRound['evaluationAttempts']>[number]['phase'];
    status: NonNullable<RefinementRound['evaluationAttempts']>[number]['status'] }>;
  evidence: {
    baseline: HistoricalEvidenceSummary;
    parentBaselines: Array<{ parentCandidateId: string; evidence: HistoricalEvidenceSummary }>;
    finalSeedBaseline: HistoricalEvidenceSummary;
    finalSeedCandidate: HistoricalEvidenceSummary;
    finalHeldOutBaseline: HistoricalEvidenceSummary;
    finalHeldOutCandidate: HistoricalEvidenceSummary;
  };
};

export type HistoricalReportCode = 'source-path-invalid' | 'source-record-missing' | 'source-record-invalid'
  | 'source-identity-drift' | 'round-id-mismatch' | 'source-version-unsupported';
export class HistoricalReportError extends Error {
  constructor(readonly code: HistoricalReportCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HistoricalReportError';
  }
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function sameOrInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}
function errorForSource(error: unknown, label: string): HistoricalReportError {
  if (error instanceof HistoricalReportError) return error;
  const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'source-record-missing' : 'source-record-invalid';
  return new HistoricalReportError(code, `${label}: ${String(error)}`);
}
function sameStat(left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: typeof left): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function boundedRead(handle: FileHandle): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_RECORD_BYTES + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > MAX_RECORD_BYTES)
      throw new HistoricalReportError('source-record-invalid', 'round record exceeds the 16 MiB read bound');
    chunks.push(chunk.subarray(0, bytesRead));
  }
}
async function readRoundBytes(sourceRoot: string, roundId: string): Promise<Buffer> {
  const roundsPath = join(sourceRoot, 'rounds');
  const path = join(roundsPath, `${roundId}.json`);
  let beforePath;
  let canonicalPath: string;
  try {
    const rounds = await lstat(roundsPath);
    if (!rounds.isDirectory() || rounds.isSymbolicLink())
      throw new HistoricalReportError('source-path-invalid', 'rounds directory is not a direct directory');
    canonicalPath = await realpath(path);
    if (!sameOrInside(canonicalPath, sourceRoot))
      throw new HistoricalReportError('source-path-invalid', 'round record escapes the explicit source root');
    beforePath = await lstat(path, { bigint: true });
  } catch (error) { throw errorForSource(error, 'round record path cannot be inspected'); }
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > BigInt(MAX_RECORD_BYTES))
    throw new HistoricalReportError('source-record-invalid', 'round record is not a bounded regular file');
  let handle: FileHandle;
  try { handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { throw errorForSource(error, 'round record cannot be opened'); }
  try {
    const beforeFd = await handle.stat({ bigint: true });
    if (!beforeFd.isFile() || !sameStat(beforeFd, beforePath))
      throw new HistoricalReportError('source-identity-drift', 'round record changed before read');
    const bytes = await boundedRead(handle);
    const secondPass = await boundedRead(handle);
    const afterFd = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameStat(beforeFd, afterFd) || !sameStat(beforePath, afterPath)
      || bytes.length !== Number(beforeFd.size) || !bytes.equals(secondPass))
      throw new HistoricalReportError('source-identity-drift', 'round record changed during read');
    return bytes;
  } catch (error) {
    if (error instanceof HistoricalReportError) throw error;
    throw new HistoricalReportError('source-record-invalid', `round record read failed: ${String(error)}`);
  } finally { await handle.close(); }
}
function evidenceSummary(value: EvaluationEvidence | undefined): HistoricalEvidenceSummary {
  if (value === undefined) return { availability: 'absent' };
  const rewards = value.trials.map(trial => trial.rewards.reward);
  const validZeroRewardCount = rewards.every(reward => typeof reward === 'number' && Number.isFinite(reward))
    ? rewards.filter(reward => reward === 0).length : undefined;
  return { availability: value.completeness === 'complete' ? 'recorded-complete' : 'recorded-partial',
    plannedTrialCount: value.plannedTrialCount, validTrialCount: value.trials.length,
    invalidTrialCount: value.invalidTrials.length,
    ...(validZeroRewardCount === undefined ? {} : { validZeroRewardCount }) };
}

export async function inspectHistoricalRoundReport(options: { sourceRoot: string; roundId: string;
  expectedByteSha256?: string }): Promise<HistoricalRoundReportV1> {
  if (typeof options.sourceRoot !== 'string' || !isAbsolute(options.sourceRoot) || options.sourceRoot.includes('\0')
    || typeof options.roundId !== 'string' || !SAFE_ID.test(options.roundId)
    || options.expectedByteSha256 !== undefined && !SHA256.test(options.expectedByteSha256))
    throw new HistoricalReportError('source-path-invalid', 'source root, round ID or expected SHA-256 is invalid');
  let sourceRoot: string;
  try { sourceRoot = await realpath(resolve(options.sourceRoot)); }
  catch (error) { throw errorForSource(error, 'source root cannot be resolved'); }
  const bytes = await readRoundBytes(sourceRoot, options.roundId);
  const byteSha256 = sha256(bytes);
  if (options.expectedByteSha256 !== undefined && byteSha256 !== options.expectedByteSha256)
    throw new HistoricalReportError('source-identity-drift', 'round record differs from expected byte SHA-256');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertJson(value);
  } catch (error) {
    throw new HistoricalReportError('source-record-invalid', `round record is not strict UTF-8 JSON: ${String(error)}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)
    && 'schemaVersion' in value && value.schemaVersion !== 1)
    throw new HistoricalReportError('source-version-unsupported', 'round record schemaVersion is unsupported');
  if (value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.roundId === 'string' && value.roundId !== options.roundId)
    throw new HistoricalReportError('round-id-mismatch', 'round ID differs from selected file name');
  let round: RefinementRound;
  try { round = new RefineStateStore(sourceRoot).parseRound(value); }
  catch (error) { throw new HistoricalReportError('source-record-invalid', `round record fails legacy validation: ${String(error)}`); }
  if (round.roundId !== options.roundId)
    throw new HistoricalReportError('round-id-mismatch', 'round ID differs from selected file name');
  const final = round.evaluation;
  const failurePhase = round.failure?.phase;
  return {
    schemaVersion: 1,
    provenance: { kind: 'legacy-round-record', sourceRoot, evolutionId: round.evolutionId,
      roundId: round.roundId, byteSha256, trust: 'record-only' },
    roundStatus: round.status,
    failurePresent: round.failure !== undefined,
    ...(typeof failurePhase === 'string' && SAFE_PHASE.test(failurePhase) ? { failurePhase } : {}),
    ...(round.decision === undefined ? {} : { decision: round.decision }),
    candidates: round.candidatePool.map(candidate => ({ candidateId: candidate.candidateId,
      status: candidate.status, sealedVersionPresent: candidate.sealedVersion !== undefined,
      executableStatus: candidate.sealedVersion === undefined ? 'unavailable' : 'not-verified',
      seedEvidence: evidenceSummary(candidate.seedEvaluation),
      heldOutEvidence: evidenceSummary(candidate.heldOutEvaluation) })),
    attempts: (round.evaluationAttempts ?? []).map(attempt => ({ provider: attempt.provider,
      evalId: attempt.evalId, phase: attempt.phase, status: attempt.status })),
    evidence: { baseline: evidenceSummary(round.baseline),
      parentBaselines: (round.parentBaselines ?? []).map(parent => ({ parentCandidateId: parent.parentCandidateId,
        evidence: evidenceSummary(parent.evidence) })),
      finalSeedBaseline: evidenceSummary(final?.seedBaseline),
      finalSeedCandidate: evidenceSummary(final?.seedCandidate),
      finalHeldOutBaseline: evidenceSummary(final?.heldOutBaseline),
      finalHeldOutCandidate: evidenceSummary(final?.heldOutCandidate) },
  };
}

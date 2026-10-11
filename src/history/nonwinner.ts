/** Read an old sealed non-winner into a new Campaign without opening its runtime. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ArtifactRef, BindingSetRef } from '../algorithm/contracts.js';
import { FileArtifactStore } from '../algorithm/artifacts.js';
import { BindingStore } from '../algorithm/bindings.js';
import { assertJson, type JsonValue } from '../algorithm/schema.js';
import { MutationValidationError, type HarnessBuilder } from '../harness/builder.js';
import type { EvolutionSpec, HarnessManifest, RefinementRound, SealedCandidateVersion } from '../types.js';
import { isExactGitCommit } from '../types.js';
import { validateEvolutionSpec } from '../state/evolution.js';
import { digestJson } from '../state/digest.js';
import { RefineStateStore } from '../state/store.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RAW_SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;

export type HistoricalImportCode = 'source-path-invalid' | 'source-record-missing' | 'source-record-invalid'
  | 'source-identity-drift' | 'candidate-not-found' | 'candidate-unsealed' | 'candidate-not-nonwinner'
  | 'candidate-object-missing' | 'candidate-integrity' | 'repository-mismatch'
  | 'repository-transfer-unsupported' | 'destination-invalid';

export class HistoricalImportError extends Error {
  constructor(readonly code: HistoricalImportCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HistoricalImportError';
  }
}

export type HistoricalCandidateSelector = {
  /** Existing state root; never used as a destination. */
  sourceRoot: string;
  evolutionId: string;
  roundId: string;
  candidateId: string;
  /** Explicit physical Git repository; never inferred from round.workspaceRoot. */
  repositoryPath: string;
  targetRoot: string;
  /** Configured by the new trusted profile with the expected substrate identity. */
  builder: Pick<HarnessBuilder, 'repositoryPath' | 'targetRoot' | 'options' | 'verifyHistoricalCandidateLineage' | 'readManifest'>;
};

export type HistoricalNonWinnerInspection = {
  schemaVersion: 1;
  source: { sourceRoot: string; evolutionId: string; roundId: string; candidateId: string;
    registryByteSha256: string; specByteSha256: string; roundByteSha256: string; specDigest: string;
    roundStatus: RefinementRound['status']; decision?: NonNullable<RefinementRound['decision']> };
  repository: { repositoryPath: string; targetRoot: string; retention: 'pinned-existing-repository' };
  sealedVersion: SealedCandidateVersion;
  manifest: HarnessManifest;
  /** Patch digest is a recorded source identity, not reconstructed by this reader. */
  patchDigestVerification: 'recorded-only';
};

export type HistoricalNonWinnerImportOptions = HistoricalCandidateSelector & {
  newCampaignId: string;
  executionProfileDigest: string;
  /** New profile must use the same trusted Git object database. Cross-repo copying is a separate step. */
  destinationRepositoryPath: string;
  repositoryRetention: 'pinned-existing-repository';
  destinationArtifacts: FileArtifactStore;
  destinationBindings: BindingStore;
  /** Other refs must come from the new profile's own CAS and BindingSchema. */
  otherNewProfileSlots?: Record<string, ArtifactRef>;
};

export type HistoricalNonWinnerImport = {
  harnessRef: ArtifactRef;
  bindingSetRef: BindingSetRef;
  provenanceRef: ArtifactRef;
  inspection: HistoricalNonWinnerInspection;
};

function id(value: string, label: string): void {
  if (typeof value !== 'string' || !SAFE_ID.test(value))
    throw new HistoricalImportError('source-path-invalid', `${label} must be a safe exact ID`);
}
function absolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))
    throw new HistoricalImportError('source-path-invalid', `${label} must be an explicit absolute path`);
  return resolve(value);
}
function byteSha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
async function sourceFile(path: string, sourceRoot: string): Promise<{ sha256: string; value: unknown }> {
  let info;
  try {
    const resolved = await realpath(path);
    if (!sameOrInside(resolved, sourceRoot))
      throw new HistoricalImportError('source-path-invalid', `source record escapes explicit source root: ${path}`);
    info = await lstat(path);
  }
  catch (error) {
    if (error instanceof HistoricalImportError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new HistoricalImportError('source-record-missing', `source record is missing: ${path}`);
    throw new HistoricalImportError('source-record-invalid', `source record cannot be inspected: ${path} (${String(error)})`);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_FILE_BYTES)
    throw new HistoricalImportError('source-record-invalid', `source record is not a bounded regular file: ${path}`);
  let handle;
  try { handle = await open(path, 'r'); }
  catch (error) {
    throw new HistoricalImportError('source-identity-drift', `source record changed before bounded read: ${path} (${String(error)})`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_SOURCE_FILE_BYTES)
      throw new HistoricalImportError('source-record-invalid', `source record grew beyond bound: ${path}`);
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SOURCE_FILE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SOURCE_FILE_BYTES)
        throw new HistoricalImportError('source-record-invalid', `source record grew beyond bound: ${path}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if ((await handle.stat()).size !== opened.size || total !== opened.size)
      throw new HistoricalImportError('source-identity-drift', `source record changed during read: ${path}`);
  } catch (error) {
    if (error instanceof HistoricalImportError) throw error;
    throw new HistoricalImportError('source-record-invalid', `bounded source read failed: ${path} (${String(error)})`);
  } finally { await handle.close(); }
  const bytes = Buffer.concat(chunks, total);
  if (bytes.length !== info.size)
    throw new HistoricalImportError('source-identity-drift', `source record changed during read: ${path}`);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); assertJson(value); }
  catch (error) { throw new HistoricalImportError('source-record-invalid', `source JSON is invalid: ${path} (${String(error)})`); }
  return { sha256: byteSha256(bytes), value };
}
function exactRef(value: SealedCandidateVersion, evolutionId: string): void {
  if (!isExactGitCommit(value.commitOid) || !isExactGitCommit(value.treeOid)
    || !SHA256.test(value.manifestDigest) || !SHA256.test(value.patchDigest)
    || value.immutableRef !== `refs/dsh-refine/evolutions/${evolutionId}/candidates/${value.commitOid}`)
    throw new HistoricalImportError('candidate-integrity', 'sealed candidate identity or immutable ref is invalid');
}
function sameOrInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel);
}

async function canonicalDestination(path: string): Promise<string> {
  let cursor = absolutePath(path, 'destinationRoot');
  const absent: string[] = [];
  while (true) {
    try { return resolve(await realpath(cursor), ...absent); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      absent.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

const execFileAsync = promisify(execFile);

/** Call before constructing a destination FileArtifactStore, which itself creates directories. */
export async function assertSeparatedHistoryDestination(sourceRoot: string, destinationRoot: string,
  repositoryPath: string, gitExecutable = 'git'): Promise<void> {
  let source: string; let repository: string; let gitCommon: string;
  try {
    source = await realpath(absolutePath(sourceRoot, 'sourceRoot'));
  } catch (error) {
    if (error instanceof HistoricalImportError) throw error;
    const code: HistoricalImportCode = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'source-record-missing' : 'source-record-invalid';
    throw new HistoricalImportError(code, `source root cannot be resolved: ${String(error)}`);
  }
  try {
    repository = await realpath(absolutePath(repositoryPath, 'repositoryPath'));
    const { stdout } = await execFileAsync(gitExecutable, ['-C', repository, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8', maxBuffer: 8192, timeout: 10_000 });
    const rawCommon = stdout.trim();
    if (!rawCommon || rawCommon.includes('\0')) throw new Error('Git common directory is empty or invalid');
    gitCommon = await realpath(resolve(repository, rawCommon));
  } catch (error) {
    if (error instanceof HistoricalImportError) throw error;
    throw new HistoricalImportError('repository-mismatch', `trusted source repository/common directory cannot be resolved: ${String(error)}`);
  }
  let destination: string;
  try { destination = await canonicalDestination(destinationRoot); }
  catch (error) {
    if (error instanceof HistoricalImportError) throw error;
    throw new HistoricalImportError('destination-invalid', `new Campaign CAS path cannot be resolved: ${String(error)}`);
  }
  for (const [label, protectedRoot] of [['old state', source], ['source repository', repository], ['Git common directory', gitCommon]] as const) {
    if (sameOrInside(destination, protectedRoot) || sameOrInside(protectedRoot, destination))
      throw new HistoricalImportError('destination-invalid', `new Campaign CAS overlaps ${label}`);
  }
}

/** Inspect source bytes and every Git harness artifact; no legacy state initializer or writer is called. */
export async function inspectHistoricalNonWinner(selector: HistoricalCandidateSelector): Promise<HistoricalNonWinnerInspection> {
  id(selector.evolutionId, 'evolutionId'); id(selector.roundId, 'roundId'); id(selector.candidateId, 'candidateId');
  let sourceRoot: string;
  try { sourceRoot = await realpath(absolutePath(selector.sourceRoot, 'sourceRoot')); }
  catch (error) {
    if (error instanceof HistoricalImportError) throw error;
    const code: HistoricalImportCode = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'source-record-missing' : 'source-record-invalid';
    throw new HistoricalImportError(code, `source root cannot be read: ${String(error)}`);
  }
  const repositoryPath = absolutePath(selector.repositoryPath, 'repositoryPath');
  if (repositoryPath !== selector.builder.repositoryPath || selector.targetRoot !== selector.builder.targetRoot)
    throw new HistoricalImportError('repository-mismatch', 'explicit repositoryPath/targetRoot differ from trusted builder');
  const evolutionRoot = join(sourceRoot, 'evolutions', selector.evolutionId);
  const paths = [join(sourceRoot, 'registry.json'), join(evolutionRoot, 'spec.json'),
    join(evolutionRoot, 'rounds', `${selector.roundId}.json`)] as const;
  const [registryFile, specFile, roundFile] = await Promise.all([
    sourceFile(paths[0], sourceRoot), sourceFile(paths[1], sourceRoot), sourceFile(paths[2], sourceRoot),
  ]);
  const registry = registryFile.value;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)
    || (registry as { schemaVersion?: unknown }).schemaVersion !== 1
    || !Array.isArray((registry as { evolutions?: unknown }).evolutions))
    throw new HistoricalImportError('source-record-invalid', 'registry schema is invalid');
  const entries = (registry as { evolutions: unknown[] }).evolutions;
  const seen = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new HistoricalImportError('source-record-invalid', 'registry entry is invalid');
    const row = raw as Record<string, unknown>;
    if (typeof row.evolutionId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(row.evolutionId)
      || seen.has(row.evolutionId) || typeof row.specDigest !== 'string' || !SHA256.test(row.specDigest)
      || !['active', 'archived'].includes(String(row.status)) || typeof row.createdAt !== 'string'
      || !row.createdAt || typeof row.updatedAt !== 'string' || !row.updatedAt)
      throw new HistoricalImportError('source-record-invalid', 'registry entry identity is invalid');
    seen.add(row.evolutionId);
  }
  const selected = entries.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as { evolutionId?: unknown }).evolutionId === selector.evolutionId);
  if (selected.length !== 1) throw new HistoricalImportError('source-record-invalid', 'registry evolution entry missing or duplicated');
  const entry = selected[0] as { specDigest?: unknown; status?: unknown };
  if (typeof entry.specDigest !== 'string' || !SHA256.test(entry.specDigest)
    || !['active', 'archived'].includes(String(entry.status)))
    throw new HistoricalImportError('source-record-invalid', 'registry evolution entry is invalid');
  const store = new RefineStateStore(evolutionRoot, selector.evolutionId);
  let spec: EvolutionSpec; let round: RefinementRound;
  try {
    spec = validateEvolutionSpec(specFile.value as EvolutionSpec);
    round = store.parseRound(roundFile.value);
  } catch (error) { throw new HistoricalImportError('source-record-invalid', `spec/round validation failed: ${String(error)}`); }
  if (digestJson(spec) !== entry.specDigest || spec.evolutionId !== selector.evolutionId
    || round.roundId !== selector.roundId)
    throw new HistoricalImportError('source-identity-drift', 'registry/spec/round identity changed');
  if (!['rejected', 'rejected-for-substrate'].includes(round.status))
    throw new HistoricalImportError('candidate-not-nonwinner', 'A1 importer requires an explicitly rejected terminal round');
  const candidate = round.candidatePool.find(row => row.candidateId === selector.candidateId);
  if (!candidate) throw new HistoricalImportError('candidate-not-found', 'candidate ID is absent from source round');
  if (!candidate.sealedVersion) throw new HistoricalImportError('candidate-unsealed', 'candidate has no sealedVersion');
  if (round.promotedCandidateId === candidate.candidateId)
    throw new HistoricalImportError('candidate-not-nonwinner', 'candidate was promoted as winner');
  exactRef(candidate.sealedVersion, selector.evolutionId);
  let manifest: HarnessManifest;
  try {
    await selector.builder.verifyHistoricalCandidateLineage(candidate.sealedVersion, candidate.parentHarnessRef);
    manifest = await selector.builder.readManifest(candidate.sealedVersion.commitOid);
    if (manifest.digest !== candidate.sealedVersion.manifestDigest || manifest.parentRef !== candidate.parentHarnessRef)
      throw new HistoricalImportError('candidate-integrity', 'candidate manifest or parent identity drift');
    const parent = await selector.builder.readManifest(candidate.parentHarnessRef);
    if (candidate.parentHarnessRef === round.targetHarnessRef && parent.digest !== round.targetHarnessDigest)
      throw new HistoricalImportError('candidate-integrity', 'round parent manifest identity drift');
    await selector.builder.verifyHistoricalCandidateLineage(candidate.sealedVersion, candidate.parentHarnessRef);
  } catch (error) {
    if (error instanceof HistoricalImportError) throw error;
    const code: HistoricalImportCode = error instanceof TypeError || error instanceof MutationValidationError
      ? 'candidate-integrity' : 'candidate-object-missing';
    throw new HistoricalImportError(code, String(error));
  }
  const after = await Promise.all(paths.map(path => sourceFile(path, sourceRoot)));
  if (after.some((file, index) => file.sha256 !== [registryFile, specFile, roundFile][index]!.sha256))
    throw new HistoricalImportError('source-identity-drift', 'source registry/spec/round bytes changed during inspection');
  return { schemaVersion: 1,
    source: { sourceRoot, evolutionId: selector.evolutionId, roundId: selector.roundId,
      candidateId: selector.candidateId, registryByteSha256: registryFile.sha256,
      specByteSha256: specFile.sha256, roundByteSha256: roundFile.sha256,
      specDigest: entry.specDigest, roundStatus: round.status,
      ...(round.decision === undefined ? {} : { decision: round.decision }) },
    repository: { repositoryPath, targetRoot: selector.targetRoot, retention: 'pinned-existing-repository' },
    sealedVersion: structuredClone(candidate.sealedVersion), manifest: structuredClone(manifest),
    patchDigestVerification: 'recorded-only' };
}

/** Reinspect before writing only to a new Campaign CAS; original state and Git are untouched. */
export async function importHistoricalNonWinner(options: HistoricalNonWinnerImportOptions): Promise<HistoricalNonWinnerImport> {
  id(options.newCampaignId, 'newCampaignId');
  if (!RAW_SHA256.test(options.executionProfileDigest))
    throw new HistoricalImportError('destination-invalid', 'new executionProfileDigest must be SHA-256');
  const repositoryPath = absolutePath(options.repositoryPath, 'repositoryPath');
  const destinationRepositoryPath = absolutePath(options.destinationRepositoryPath, 'destinationRepositoryPath');
  if (repositoryPath !== destinationRepositoryPath || options.repositoryRetention !== 'pinned-existing-repository')
    throw new HistoricalImportError('repository-transfer-unsupported', 'Git object transfer is not implemented; new profile must pin the existing repository');
  if (options.destinationBindings.artifacts !== options.destinationArtifacts
    || options.destinationBindings.schema.slots.harness?.schemaId !== 'harness.directory.v1'
    || !options.destinationBindings.schema.slots.harness.required
    || Object.hasOwn(options.otherNewProfileSlots ?? {}, 'harness'))
    throw new HistoricalImportError('destination-invalid', 'new profile CAS/BindingSchema is invalid for a harness');
  await assertSeparatedHistoryDestination(options.sourceRoot, options.destinationArtifacts.root,
    options.repositoryPath, options.builder.options.gitExecutable ?? 'git');
  const inspection = await inspectHistoricalNonWinner(options);
  const derivedFrom = { kind: 'historical-nonwinner', source: inspection.source,
    repository: inspection.repository, sealedVersion: { ...inspection.sealedVersion },
    artifactCount: inspection.manifest.artifacts.length, patchDigestVerification: inspection.patchDigestVerification };
  const provenance: JsonValue = { schemaVersion: 1, kind: 'history-import', newCampaignId: options.newCampaignId,
    executionProfileDigest: options.executionProfileDigest, derivedFrom,
    inheritedBudget: false, inheritedPendingOperations: false, inheritedMeasurements: false };
  assertJson(provenance);
  const harnessRef = options.destinationArtifacts.putJson({ schemaVersion: 1, kind: 'git-harness',
    commitOid: inspection.sealedVersion.commitOid, manifestDigest: inspection.sealedVersion.manifestDigest },
  'harness.directory.v1');
  const provenanceRef = options.destinationArtifacts.putJson(provenance, 'history.import.v1');
  const bindingSetRef = options.destinationBindings.create({ ...(options.otherNewProfileSlots ?? {}), harness: harnessRef });
  return { harnessRef, provenanceRef, bindingSetRef, inspection };
}

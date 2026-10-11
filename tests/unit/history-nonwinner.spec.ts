import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileArtifactStore } from '../../src/algorithm/artifacts.js';
import { BindingStore } from '../../src/algorithm/bindings.js';
import { HarnessBuilder, digestContent } from '../../src/harness/builder.js';
import { assertSeparatedHistoryDestination, importHistoricalNonWinner, inspectHistoricalNonWinner } from '../../src/history/nonwinner.js';
import { EvolutionRegistryStore } from '../../src/state/evolution.js';
import { createGitHarnessFixture, gitOutput } from '../helpers/git-fixture.js';
import { evolutionSpec, roundFixture, SHA } from '../helpers/research-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function treeBytes(path: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  async function visit(directory: string, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await visit(join(directory, item.name), relative);
      else output[relative] = hash(await readFile(join(directory, item.name)));
    }
  }
  await visit(path);
  return output;
}
async function setup() {
  const git = await createGitHarnessFixture(); roots.push(git.root);
  const harness = join(git.repository, git.targetRoot);
  await writeFile(join(harness, 'plugins/context.ts'), 'export const value = 2\n');
  const artifacts = [];
  for (const path of ['plugins/context.ts', 'preset/agent.cordis.yml']) {
    const content = await readFile(join(harness, ...path.split('/')));
    artifacts.push({ path, digest: digestContent(content), bytes: content.length });
  }
  const manifestIdentity = { schemaVersion: 1 as const, parentRef: git.championRef,
    dshBaseRef: git.baseRef, toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1', artifacts };
  const manifest = { ...manifestIdentity, digest: digestContent(JSON.stringify(manifestIdentity)) };
  await writeFile(join(harness, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  gitOutput(git.repository, ['add', git.targetRoot]); gitOutput(git.repository, ['commit', '-m', 'rejected nonwinner']);
  const commitOid = gitOutput(git.repository, ['rev-parse', 'HEAD']);
  const treeOid = gitOutput(git.repository, ['rev-parse', `${commitOid}^{tree}`]);
  const immutableRef = `refs/dsh-refine/evolutions/evo-1/candidates/${commitOid}`;
  gitOutput(git.repository, ['update-ref', immutableRef, commitOid]);
  const sealedVersion = { commitOid, treeOid, manifestDigest: manifest.digest,
    patchDigest: SHA('a'), immutableRef };
  const spec = { ...evolutionSpec(), initialHarness: { ref: git.championRef, digest: git.manifest.digest },
    toolchainRef: 'node-22-tsc', sandboxProfileRef: 'sandbox-v1' };
  const sourceRoot = join(git.root, 'old-state');
  const registry = new EvolutionRegistryStore(sourceRoot);
  await registry.createEvolution({ spec, champion: { schemaVersion: 2, ref: git.championRef,
    manifestDigest: git.manifest.digest, updatedAt: 'now' } });
  const candidateId = 'round-1-candidate-0';
  const round = roundFixture({ status: 'rejected', decision: 'rejected', targetHarnessRef: git.championRef,
    targetHarnessDigest: git.manifest.digest, candidatePool: [{ candidateId, roundId: 'round-1',
      parentHarnessRef: git.championRef, parentCandidateIds: [`initial-${git.championRef}`],
      status: 'discarded', sealedVersion }] });
  await registry.stateStore(spec.evolutionId).writeRound(round);
  const compile = vi.fn(async () => { throw new Error('historical inspection must not compile'); });
  const builder = new HarnessBuilder({ repositoryPath: git.repository, targetRoot: git.targetRoot,
    dshBaseRef: git.baseRef, toolchainRef: spec.toolchainRef, sandboxProfileRef: spec.sandboxProfileRef,
    compiler: { compile } });
  const selector = { sourceRoot, evolutionId: spec.evolutionId, roundId: round.roundId, candidateId,
    repositoryPath: git.repository, targetRoot: git.targetRoot, builder };
  const destinationRoot = join(git.root, 'new-campaign-cas');
  await assertSeparatedHistoryDestination(sourceRoot, destinationRoot, git.repository);
  const artifactsStore = new FileArtifactStore(destinationRoot);
  const bindings = new BindingStore(artifactsStore, { id: 'a1-new-profile.bindings.v1',
    slots: { harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true } } });
  const importOptions = { ...selector, newCampaignId: 'new-campaign', executionProfileDigest: 'd'.repeat(64),
    destinationRepositoryPath: git.repository, repositoryRetention: 'pinned-existing-repository' as const,
    destinationArtifacts: artifactsStore, destinationBindings: bindings };
  return { git, sourceRoot, round, sealedVersion, selector, importOptions, artifactsStore, bindings, compile };
}

it('inspects a real sealed nonwinner and derives a new CAS binding without changing old state or running effects', async () => {
  const f = await setup();
  await rm(join(f.sourceRoot, 'experiments.tsv'));
  const before = await treeBytes(f.sourceRoot);
  const inspected = await inspectHistoricalNonWinner(f.selector);
  expect(inspected.sealedVersion).toEqual(f.sealedVersion);
  expect(inspected.manifest.artifacts).toHaveLength(2);
  expect(inspected.source.roundStatus).toBe('rejected');
  expect(inspected.patchDigestVerification).toBe('recorded-only');
  const imported = await importHistoricalNonWinner(f.importOptions);
  expect(imported.inspection).toEqual(inspected);
  expect(f.artifactsStore.getJson(imported.harnessRef)).toEqual({ schemaVersion: 1, kind: 'git-harness',
    commitOid: f.sealedVersion.commitOid, manifestDigest: f.sealedVersion.manifestDigest });
  expect(f.bindings.read(imported.bindingSetRef).slots.harness).toEqual(imported.harnessRef);
  expect(f.artifactsStore.getJson(imported.provenanceRef)).toMatchObject({
    newCampaignId: 'new-campaign', executionProfileDigest: 'd'.repeat(64),
    inheritedBudget: false, inheritedPendingOperations: false, inheritedMeasurements: false,
    derivedFrom: { source: { candidateId: f.selector.candidateId, roundByteSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      repository: { repositoryPath: f.git.repository, retention: 'pinned-existing-repository' } },
  });
  expect(await treeBytes(f.sourceRoot)).toEqual(before);
  expect(existsSync(join(f.sourceRoot, 'experiments.tsv'))).toBe(false);
  expect(f.compile).not.toHaveBeenCalled();
});

it('fails closed on source drift, absent sealed candidate, moved immutable ref and cross-repository reuse', async () => {
  const f = await setup();
  await expect(importHistoricalNonWinner({ ...f.importOptions, destinationRepositoryPath: join(f.git.root, 'other-repo') }))
    .rejects.toMatchObject({ code: 'repository-transfer-unsupported' });
  const registryPath = join(f.sourceRoot, 'registry.json');
  const registryBytes = await readFile(registryPath);
  const registry = JSON.parse(registryBytes.toString('utf8'));
  registry.evolutions[0].specDigest = SHA('f');
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'source-identity-drift' });
  await writeFile(registryPath, registryBytes);
  const roundPath = join(f.sourceRoot, 'evolutions', f.selector.evolutionId, 'rounds', `${f.selector.roundId}.json`);
  const roundBytes = await readFile(roundPath);
  const noSeal = structuredClone(f.round);
  delete noSeal.candidatePool[0]!.sealedVersion;
  await writeFile(roundPath, `${JSON.stringify(noSeal)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'candidate-unsealed' });
  await writeFile(roundPath, roundBytes);
  gitOutput(f.git.repository, ['update-ref', f.sealedVersion.immutableRef, f.git.championRef]);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'candidate-integrity' });
  expect(f.compile).not.toHaveBeenCalled();
  expect(await readdir(join(f.artifactsStore.root, 'objects'))).toEqual([]);
});

it('reports missing source and missing Git object with stable reason codes', async () => {
  const f = await setup();
  await expect(inspectHistoricalNonWinner({ ...f.selector, candidateId: 'other' }))
    .rejects.toMatchObject({ code: 'candidate-not-found' });
  const roundPath = join(f.sourceRoot, 'evolutions', f.selector.evolutionId, 'rounds', `${f.selector.roundId}.json`);
  const round = structuredClone(f.round);
  round.candidatePool[0]!.sealedVersion!.commitOid = 'f'.repeat(40);
  round.candidatePool[0]!.sealedVersion!.immutableRef =
    `refs/dsh-refine/evolutions/${f.selector.evolutionId}/candidates/${'f'.repeat(40)}`;
  await writeFile(roundPath, `${JSON.stringify(round)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'candidate-object-missing' });
  expect(f.compile).not.toHaveBeenCalled();
});

it('rejects malformed decoded spec and round through their legacy validators', async () => {
  const f = await setup();
  const specPath = join(f.sourceRoot, 'evolutions', f.selector.evolutionId, 'spec.json');
  const originalSpec = await readFile(specPath);
  const badSpec = JSON.parse(originalSpec.toString('utf8'));
  badSpec.candidateGeneration.budget.finalizationReserveMs = -1;
  await writeFile(specPath, `${JSON.stringify(badSpec)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'source-record-invalid' });
  await writeFile(specPath, originalSpec);
  const roundPath = join(f.sourceRoot, 'evolutions', f.selector.evolutionId, 'rounds', `${f.selector.roundId}.json`);
  const badRound = structuredClone(f.round);
  badRound.status = 'invalid-status' as typeof badRound.status;
  await writeFile(roundPath, `${JSON.stringify(badRound)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'source-record-invalid' });
});

it('rejects source symlink escape and overlapping future destination before CAS construction', async () => {
  const f = await setup();
  const wouldBeCas = join(f.sourceRoot, 'new-campaign-cas');
  await expect(assertSeparatedHistoryDestination(f.sourceRoot, wouldBeCas, f.git.repository))
    .rejects.toMatchObject({ code: 'destination-invalid' });
  expect(existsSync(wouldBeCas)).toBe(false);
  const insideRepository = join(f.git.repository, 'new-campaign-cas');
  await expect(assertSeparatedHistoryDestination(f.sourceRoot, insideRepository, f.git.repository))
    .rejects.toMatchObject({ code: 'destination-invalid' });
  expect(existsSync(insideRepository)).toBe(false);
  await expect(assertSeparatedHistoryDestination(f.sourceRoot, f.git.root, f.git.repository))
    .rejects.toMatchObject({ code: 'destination-invalid' });
  const symlinked = join(f.git.root, 'repo-alias');
  await symlink(f.git.repository, symlinked);
  await expect(assertSeparatedHistoryDestination(f.sourceRoot, join(symlinked, 'new-campaign-cas'), f.git.repository))
    .rejects.toMatchObject({ code: 'destination-invalid' });
  expect(existsSync(join(f.git.repository, 'new-campaign-cas'))).toBe(false);
  const specPath = join(f.sourceRoot, 'evolutions', f.selector.evolutionId, 'spec.json');
  const outside = join(f.git.root, 'outside-spec.json');
  await writeFile(outside, await readFile(specPath));
  await rm(specPath);
  await symlink(outside, specPath);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'source-path-invalid' });
  await rm(specPath);
  await rm(join(f.sourceRoot, 'registry.json'));
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'source-record-missing' });
  expect(f.compile).not.toHaveBeenCalled();
});

it('rejects CAS overlap with a linked worktree Git common directory outside that worktree', async () => {
  const f = await setup();
  const linked = join(f.git.root, 'linked-worktree');
  gitOutput(f.git.repository, ['worktree', 'add', '--detach', linked, 'HEAD']);
  const insideCommon = join(f.git.repository, '.git', 'objects', 'new-campaign-cas');
  await expect(assertSeparatedHistoryDestination(f.sourceRoot, insideCommon, linked))
    .rejects.toMatchObject({ code: 'destination-invalid' });
  expect(existsSync(insideCommon)).toBe(false);
});

it('preserves source missing reason before attempting import into the new CAS', async () => {
  const f = await setup();
  const missingSourceRoot = join(f.git.root, 'missing-old-state');
  await expect(importHistoricalNonWinner({ ...f.importOptions, sourceRoot: missingSourceRoot }))
    .rejects.toMatchObject({ code: 'source-record-missing' });
  expect(existsSync(missingSourceRoot)).toBe(false);
  expect(await readdir(join(f.artifactsStore.root, 'objects'))).toEqual([]);
});

it('rejects a sealed candidate whose commit also changed fixed repository substrate', async () => {
  const f = await setup();
  const repository = f.git.repository;
  const candidateManifest = await readFile(join(repository, f.git.targetRoot, 'manifest.json'));
  execFileSync('git', ['-C', repository, 'reset', '--hard', f.git.championRef]);
  await writeFile(join(repository, 'package.json'), '{"name":"tampered-substrate","private":true}\n');
  await writeFile(join(repository, f.git.targetRoot, 'plugins/context.ts'), 'export const value = 2\n');
  await writeFile(join(repository, f.git.targetRoot, 'manifest.json'), candidateManifest);
  gitOutput(repository, ['add', '.']); gitOutput(repository, ['commit', '-m', 'candidate plus substrate']);
  const commitOid = gitOutput(repository, ['rev-parse', 'HEAD']);
  const sealedVersion = { ...f.sealedVersion, commitOid, treeOid: gitOutput(repository, ['rev-parse', `${commitOid}^{tree}`]),
    immutableRef: `refs/dsh-refine/evolutions/${f.selector.evolutionId}/candidates/${commitOid}` };
  gitOutput(repository, ['update-ref', sealedVersion.immutableRef, commitOid]);
  await expect(f.selector.builder.verifyHistoricalCandidateLineage(sealedVersion, f.git.championRef))
    .rejects.toThrow(/fixed substrate/);
  const round = structuredClone(f.round); round.candidatePool[0]!.sealedVersion = sealedVersion;
  const roundPath = join(f.sourceRoot, 'evolutions', f.selector.evolutionId, 'rounds', `${f.selector.roundId}.json`);
  await writeFile(roundPath, `${JSON.stringify(round)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'candidate-integrity' });
  expect(f.compile).not.toHaveBeenCalled();
});

it('rejects a forged recorded parent and a merge commit even when the target manifest remains sealed', async () => {
  const f = await setup();
  const repository = f.git.repository;
  const candidateManifest = JSON.parse((await readFile(join(repository, f.git.targetRoot, 'manifest.json'))).toString('utf8'));
  gitOutput(repository, ['reset', '--hard', f.git.championRef]);
  await writeFile(join(repository, f.git.targetRoot, 'plugins/context.ts'), 'export const value = 2\n');
  const { digest: _oldDigest, ...identity } = candidateManifest;
  identity.parentRef = f.sealedVersion.commitOid;
  const forgedManifest = { ...identity, digest: digestContent(JSON.stringify(identity)) };
  await writeFile(join(repository, f.git.targetRoot, 'manifest.json'), `${JSON.stringify(forgedManifest)}\n`);
  gitOutput(repository, ['add', f.git.targetRoot]); gitOutput(repository, ['commit', '-m', 'forged recorded parent']);
  const forgedCommit = gitOutput(repository, ['rev-parse', 'HEAD']);
  const forgedVersion = { ...f.sealedVersion, commitOid: forgedCommit,
    treeOid: gitOutput(repository, ['rev-parse', `${forgedCommit}^{tree}`]), manifestDigest: forgedManifest.digest,
    immutableRef: `refs/dsh-refine/evolutions/${f.selector.evolutionId}/candidates/${forgedCommit}` };
  gitOutput(repository, ['update-ref', forgedVersion.immutableRef, forgedCommit]);
  const round = structuredClone(f.round);
  round.candidatePool[0]!.parentHarnessRef = f.sealedVersion.commitOid;
  round.candidatePool[0]!.sealedVersion = forgedVersion;
  const roundPath = join(f.sourceRoot, 'evolutions', f.selector.evolutionId, 'rounds', `${f.selector.roundId}.json`);
  await writeFile(roundPath, `${JSON.stringify(round)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'candidate-integrity' });

  gitOutput(repository, ['checkout', '-b', 'merge-side', f.git.championRef]);
  await writeFile(join(repository, 'side.txt'), 'different history\n');
  gitOutput(repository, ['add', 'side.txt']); gitOutput(repository, ['commit', '-m', 'side branch']);
  const sideCommit = gitOutput(repository, ['rev-parse', 'HEAD']);
  gitOutput(repository, ['checkout', '--detach', f.sealedVersion.commitOid]);
  gitOutput(repository, ['merge', '--no-ff', '--no-edit', sideCommit]);
  const mergeCommit = gitOutput(repository, ['rev-parse', 'HEAD']);
  const mergeVersion = { ...f.sealedVersion, commitOid: mergeCommit,
    treeOid: gitOutput(repository, ['rev-parse', `${mergeCommit}^{tree}`]),
    immutableRef: `refs/dsh-refine/evolutions/${f.selector.evolutionId}/candidates/${mergeCommit}` };
  gitOutput(repository, ['update-ref', mergeVersion.immutableRef, mergeCommit]);
  const mergeRound = structuredClone(f.round); mergeRound.candidatePool[0]!.sealedVersion = mergeVersion;
  await writeFile(roundPath, `${JSON.stringify(mergeRound)}\n`);
  await expect(inspectHistoricalNonWinner(f.selector)).rejects.toMatchObject({ code: 'candidate-integrity' });
  expect(f.compile).not.toHaveBeenCalled();
});

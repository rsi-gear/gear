import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FileArtifactStore } from "./lib/algorithm/artifacts.js";
import { BindingStore } from "./lib/algorithm/bindings.js";
import { HarnessBuilder } from "./lib/harness/builder.js";
import { assertSeparatedHistoryDestination, inspectHistoricalNonWinner, importHistoricalNonWinner } from "./lib/history/nonwinner.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function main() {
  const [destinationRoot, codeRevision] = process.argv.slice(2);
  if (!destinationRoot || !/^\/tmp\/gear-author-a1-history-[a-z0-9-]+$/.test(destinationRoot) || !/^[a-f0-9]{40}$/.test(codeRevision)) throw new Error("Explicit fresh destination and code revision required");
  try {
    await lstat(destinationRoot);
    throw new Error("Destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const sourceRoot = "/root/gear-lab/state/failure-cluster-campaign-tb21-10x3-luna-20260925-standard";
  const repositoryPath = "/root/gear-lab/releases/failure-cluster-campaign-tb21-10x3-luna-20260925/target-luna-compat";
  const evolutionId = "7e0e34a1-0ec3-41d9-8a9c-595c942bbe16";
  const roundId = "f550375e-a597-4242-af0b-65f042e4d8a3";
  const candidateId = `${roundId}-candidate-0`;
  const watched = ["registry.json", "experiments.tsv", `evolutions/${evolutionId}/spec.json`, `evolutions/${evolutionId}/rounds/${roundId}.json`];
  const snapshot = async () => Object.fromEntries(await Promise.all(watched.map(async (path) => {
    try {
      return [path, hash(await readFile(join(sourceRoot, path)))];
    } catch (error) {
      if (error.code === "ENOENT") return [path, null];
      throw error;
    }
  })));
  const gitRefs = () => execFileSync("git", ["-C", repositoryPath, "for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" });
  const before = await snapshot();
  const refsBefore = gitRefs();
  let compileCalls = 0;
  const builder = new HarnessBuilder({
    repositoryPath,
    targetRoot: "harness",
    dshBaseRef: "2d80e60201a22409442d31f22c0c1df14b079549",
    toolchainRef: "dsh-rc2-codex-pnpm-11.7.0-luna-catalog-0.87.1",
    sandboxProfileRef: "harbor-terminal-bench-2.0",
    compiler: { async compile() {
      compileCalls++;
      throw new Error("History import must not compile");
    } }
  });
  const selector = { sourceRoot, evolutionId, roundId, candidateId, repositoryPath, targetRoot: "harness", builder };
  await assertSeparatedHistoryDestination(sourceRoot, destinationRoot, repositoryPath);
  const inspected = await inspectHistoricalNonWinner(selector);
  const artifacts = new FileArtifactStore(destinationRoot);
  const bindings = new BindingStore(artifacts, { id: "author-a1-history-probe.bindings.v1", slots: { harness: { schemaId: "harness.directory.v1", required: true, replaceable: true } } });
  const executionProfileDigest = hash(JSON.stringify({ kind: "history-import-only-probe", codeRevision, repositoryPath, targetRoot: "harness" }));
  const imported = await importHistoricalNonWinner({
    ...selector,
    newCampaignId: "a1-history-import-probe",
    executionProfileDigest,
    destinationRepositoryPath: repositoryPath,
    repositoryRetention: "pinned-existing-repository",
    destinationArtifacts: artifacts,
    destinationBindings: bindings
  });
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after) || refsBefore !== gitRefs() || compileCalls !== 0) throw new Error("Source changed or compile called");
  if (bindings.read(imported.bindingSetRef).slots.harness.digest !== imported.harnessRef.digest) throw new Error("New binding mismatch");
  const report = {
    schemaVersion: 1,
    codeRevision,
    node: process.version,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    source: { sourceRoot, evolutionId, roundId, candidateId },
    destinationRoot,
    repositoryPath,
    sourceBytesBefore: before,
    sourceBytesAfter: after,
    gitRefsSha256: hash(refsBefore),
    sealedVersion: inspected.sealedVersion,
    manifestDigest: inspected.manifest.digest,
    artifactCount: inspected.manifest.artifacts.length,
    patchDigestVerification: inspected.patchDigestVerification,
    imported: { harnessRef: imported.harnessRef, bindingSetRef: imported.bindingSetRef, provenanceRef: imported.provenanceRef },
    provenance: artifacts.getJson(imported.provenanceRef),
    checks: { sourceUnchanged: true, gitRefsUnchanged: true, newBindingReadable: true, compileCalls, hitchCalls: 0, modelCalls: 0 },
    limits: { profile: "import-only-probe-not-a-runnable-profile", build: false, evaluation: false, crossRepositoryTransfer: false, legacyJournalResume: false }
  };
  await writeFile(join(destinationRoot, "probe-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

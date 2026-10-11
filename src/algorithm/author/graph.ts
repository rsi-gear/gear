import type { ArtifactRef, BindingSetRef } from '../contracts.js';
import { FileArtifactStore } from '../artifacts.js';
import { BindingStore } from '../bindings.js';
import { canonicalJson, type JsonValue } from '../schema.js';
import { readTaskView } from '../data/tasks.js';
import { readExperienceView } from '../data/experience.js';
import { readMeasurement } from '../data/measurement.js';
import { assertHarnessAgentV1, type HarnessAgentV1 } from './a1-contract.js';

const authorContainers = new Set(['author.archive.v1', 'author.output-entry.v1', 'author.outputs.v1', 'author.result.v1']);
/** Physical producer artifacts are retained and schema-checked here. Their scientific semantics are verified by their producer. */
const physicalLeaves = new Set([
  'execution.role.evidence.v1', 'execution.workspace-edit.evidence.v1', 'execution.rollout.evidence.v1',
  'execution.receipt.v1', 'execution.structured-result.v1', 'execution.workspace-edit.validation.v1',
  'execution.workspace-edit.model-result.v1', 'execution.workspace-edit.failed-check.v1',
  'execution.rollout.task-report.v1', 'execution.rollout.trace-chunk.v1', 'execution.rollout.projection-receipt.v1',
]);
export type AuthorGraphPolicy = { wireVersion?: 'v1' | 'v2'; executionProfileDigest?: string };

/** Validate the CAS binding and harness descriptor. The trusted host separately verifies the Git commit and manifest. */
export function verifyHarnessAgentBinding(artifacts: FileArtifactStore, bindings: BindingStore,
  agent: HarnessAgentV1, executionProfileDigest: string): { commitOid: string; manifestDigest: string } {
  assertHarnessAgentV1(agent);
  if (!/^[a-f0-9]{64}$/.test(executionProfileDigest) || agent.executionProfileDigest !== executionProfileDigest)
    throw new Error('HarnessAgent execution profile identity drift');
  const bound = bindings.read(agent.bindingSetRef);
  const harness = bound.slots.harness;
  if (!harness || harness.schemaId !== 'harness.directory.v1')
    throw new Error('HarnessAgent binding lacks sealed harness.directory.v1');
  const value = artifacts.getJson(harness);
  if (!value || Array.isArray(value) || typeof value !== 'object' || value.schemaVersion !== 1
    || value.kind !== 'git-harness' || typeof value.commitOid !== 'string'
    || !/^[a-f0-9]{40}$/.test(value.commitOid) || typeof value.manifestDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(value.manifestDigest))
    throw new Error('HarnessAgent harness CAS artifact invalid');
  return { commitOid: value.commitOid, manifestDigest: value.manifestDigest };
}

/** Validate declared author-container edges and the finite A1 typed CAS references. Bare provenance digests,
 * Git objects, physical provider semantics and arbitrary model JSON are outside this CAS graph. Physical leaves
 * may not smuggle an undeclared typed reference; extending them requires a schema-specific edge reader. */
export function verifyAuthorOutputGraph(artifacts: FileArtifactStore, bindings: BindingStore, value: JsonValue,
  policy: AuthorGraphPolicy = {}): void {
  const v2 = policy.wireVersion === 'v2';
  if (v2 && !policy.executionProfileDigest) throw new Error('A1 output graph needs frozen execution profile');
  const seen = new Set<string>();
  let nodes = 0;
  const count = (): void => { if (++nodes > 8192) throw new Error('Author output graph exceeds node limit'); };
  const opaque = (node: JsonValue): void => {
    count();
    if (Array.isArray(node)) { node.forEach(opaque); return; }
    if (node === null || typeof node !== 'object') return;
    if (node.kind === 'artifact' || node.kind === 'binding-set' || node.kind === 'harness-agent')
      throw new Error('Physical leaf contains undeclared typed reference');
    for (const child of Object.values(node)) opaque(child);
  };
  const byDigest = (digest: string, schemaId: string): ArtifactRef => {
    const content = artifacts.getJsonByDigest(digest, schemaId);
    return { kind: 'artifact', digest, size: Buffer.byteLength(canonicalJson(content)),
      mediaType: 'application/json', schemaId };
  };
  const visit = (node: JsonValue): void => {
    count();
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== 'object') return;
    if (v2 && node.kind === 'harness-agent') {
      verifyHarnessAgentBinding(artifacts, bindings, node as HarnessAgentV1, policy.executionProfileDigest!);
      return;
    }
    if (node.kind === 'binding-set') {
      if (v2) {
        const bound = bindings.read(node as BindingSetRef);
        const harness = bound.slots.harness;
        if (!harness || harness.schemaId !== 'harness.directory.v1')
          throw new Error('A1 binding has no sealed harness');
        visit(harness);
      } else bindings.read(node as BindingSetRef);
      return;
    }
    if (node.kind === 'artifact') {
      const ref = node as ArtifactRef;
      if (ref.mediaType !== 'application/json' || !ref.schemaId
        || (!authorContainers.has(ref.schemaId) && !(v2 && (physicalLeaves.has(ref.schemaId)
          || ref.schemaId === 'harness.directory.v1' || ref.schemaId === 'task.view.v1'
          || ref.schemaId === 'measurement.record.v1' || ref.schemaId === 'execution.workspace-edit.result.v1'))))
        throw new Error(`Author output has undeclared artifact ref schema: ${ref.schemaId ?? ref.mediaType}`);
      const content = artifacts.getJson(ref); // check every supplied ref's metadata, even repeated digests
      const identity = `${ref.schemaId}:${ref.digest}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      if (authorContainers.has(ref.schemaId)) { visit(content); return; }
      if (ref.schemaId === 'harness.directory.v1') {
        if (!content || Array.isArray(content) || typeof content !== 'object'
          || content.schemaVersion !== 1 || content.kind !== 'git-harness'
          || typeof content.commitOid !== 'string' || !/^[a-f0-9]{40}$/.test(content.commitOid)
          || typeof content.manifestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(content.manifestDigest))
          throw new Error('A1 harness artifact malformed');
        opaque(content);
        return;
      }
      if (ref.schemaId === 'task.view.v1') {
        const view = readTaskView(artifacts, ref); // validates every task contentRef byte and declared task metadata
        if (view.sourceExperienceViewDigest) {
          const source = byDigest(view.sourceExperienceViewDigest, 'experience.view.v1');
          readExperienceView(artifacts, source); // validates every explicit projection/content reference
        }
        if (view.parentTaskViewDigest) visit(byDigest(view.parentTaskViewDigest, 'task.view.v1'));
        return;
      }
      if (ref.schemaId === 'measurement.record.v1') {
        const measurement = readMeasurement(artifacts, ref); // validates condition, metric schema and evidence refs
        bindings.read(measurement.subjectBindings);
        visit(measurement.condition.taskViewRef);
        return;
      }
      if (ref.schemaId === 'execution.workspace-edit.result.v1') {
        if (!content || Array.isArray(content) || typeof content !== 'object' || content.schemaVersion !== 1)
          throw new Error('Workspace-edit result artifact malformed');
        const modelResultRef = content.modelResultRef;
        for (const [field, child] of Object.entries(content)) if (field !== 'modelResultRef') opaque(child);
        if (modelResultRef !== undefined) {
          if (!modelResultRef || typeof modelResultRef !== 'object' || Array.isArray(modelResultRef)
            || modelResultRef.kind !== 'artifact' || modelResultRef.schemaId !== 'execution.workspace-edit.model-result.v1')
            throw new Error('Workspace-edit model result ref schema drift');
          visit(modelResultRef);
        }
        return;
      }
      if (physicalLeaves.has(ref.schemaId)) { opaque(content); return; }
      throw new Error(`Unhandled A1 artifact schema ${ref.schemaId}`);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
}

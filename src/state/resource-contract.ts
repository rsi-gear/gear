// Public resource dataset/selection contract; no Hitch runtime dependencies.
import { canonical, identity, object, parseResourceLock, portablePath, resourceId, sha, type Resource, type TaskResourceLock } from "./resource-protocol.js";
type Sha256 = `sha256:${string}`;
export interface ResourceTask {
  task_id: string;
  source_task_digest: Sha256;
  resource_closure_digest: Sha256;
  task_digest: Sha256;
  sourceTree: Extract<Resource, { kind: "tree" }>;
  lock: TaskResourceLock;
}
export interface ResourcePlan {
  protocol: "hitch-resource-plan@1";
  resolver: "hitch-resource-resolver@1";
  backend: "harbor-role-context@1";
  platform: string;
  task: ResourceTask;
  digest: Sha256;
}
export interface ResourceDataset {
  schema_version: "2";
  kind: "gear-harbor-benchmark";
  resource_protocol: "hitch-resource-lock@1";
  execution: { backend: "harbor-role-context@1"; resolver: "hitch-resource-resolver@1"; platform: string };
  required_capabilities: string[];
  benchmark: { id: string; revision: string };
  adapter: { id: string; revision: string; output_protocol: "gear-harbor-eval-result-v1" };
  scoring: { total_score: { source_metric: string; direction: "maximize" | "minimize"; range: readonly [number, number]; reducer: "task-macro-mean" }; process_score?: ResourceDataset["scoring"]["total_score"] };
  raw_metrics?: { schema_version: "1"; metrics: Array<Record<string, unknown>> };
  tasks: ResourceTask[];
  dataset_digest: Sha256;
}
export interface ResourceSelection {
  protocol: "hitch-resource-selection@1";
  sourceDatasetDigest: Sha256;
  manifest: Omit<ResourceDataset, "tasks" | "dataset_digest">;
  tasks: ResourceTask[];
  digest: Sha256;
}

export function parseResourceTask(value: unknown): ResourceTask {
  const raw = object(value, ["task_id", "source_task_digest", "resource_closure_digest", "task_digest", "sourceTree", "lock"]);
  const tree = object(raw.sourceTree, ["kind", "format", "manifestDigest"]);
  if (tree.kind !== "tree" || tree.format !== "hitch-tree@1") throw new TypeError("task source must be a versioned tree");
  const sourceTree = { kind: "tree" as const, format: "hitch-tree@1" as const, manifestDigest: sha(tree.manifestDigest) };
  const source = identity("hitch-source-task@1", sourceTree);
  if (sha(raw.source_task_digest) !== source) throw new TypeError("source task identity mismatch");
  const resource_closure_digest = sha(raw.resource_closure_digest), task_digest = identity("hitch-task@2", { source_task_digest: source, resource_closure_digest });
  if (sha(raw.task_digest) !== task_digest) throw new TypeError("resource task identity mismatch");
  return { task_id: portablePath(resourceId(raw.task_id)), sourceTree, source_task_digest: source, resource_closure_digest, task_digest, lock: parseResourceLock(raw.lock) };
}
export function parseResourceDataset(value: unknown): ResourceDataset {
  const raw = object(value, ["schema_version", "kind", "resource_protocol", "execution", "required_capabilities", "benchmark", "adapter", "scoring", "raw_metrics", "tasks", "dataset_digest"]);
  if (raw.schema_version !== "2" || raw.kind !== "gear-harbor-benchmark" || raw.resource_protocol !== "hitch-resource-lock@1") throw new TypeError("unsupported resource dataset");
  const execution = object(raw.execution, ["backend", "resolver", "platform"]);
  if (execution.backend !== "harbor-role-context@1" || execution.resolver !== "hitch-resource-resolver@1" || typeof execution.platform !== "string" || !/^linux\/(amd64|arm64)(\/v[0-9]+)?$/.test(execution.platform)) throw new TypeError("unsupported resource execution contract");
  const benchmark = object(raw.benchmark, ["id", "revision"]), adapter = object(raw.adapter, ["id", "revision", "output_protocol"]);
  for (const item of [benchmark, adapter]) if (typeof item.id !== "string" || !item.id || typeof item.revision !== "string" || !item.revision || item.revision === "latest") throw new TypeError("invalid benchmark/adapter identity");
  if (adapter.output_protocol !== "gear-harbor-eval-result-v1" || !Array.isArray(raw.tasks) || !raw.tasks.length) throw new TypeError("invalid resource dataset tasks or adapter");
  const scoring = object(raw.scoring, ["total_score", "process_score"]);
  for (const key of ["total_score", ...(scoring.process_score === undefined ? [] : ["process_score"])]) {
    const score = object(scoring[key], ["source_metric", "direction", "range", "reducer"]);
    if (typeof score.source_metric !== "string" || !score.source_metric || !["maximize", "minimize"].includes(String(score.direction)) || score.reducer !== "task-macro-mean"
      || !Array.isArray(score.range) || score.range.length !== 2 || !score.range.every(Number.isFinite) || score.range[0] >= score.range[1]) throw new TypeError("invalid resource scoring contract");
  }
  if (!Array.isArray(raw.required_capabilities) || raw.required_capabilities.some(c => typeof c !== "string") || new Set(raw.required_capabilities).size !== raw.required_capabilities.length) throw new TypeError("invalid resource dataset capabilities");
  if (raw.raw_metrics !== undefined) { const registry = object(raw.raw_metrics, ["schema_version", "metrics"]); if (registry.schema_version !== "1" || !Array.isArray(registry.metrics)) throw new TypeError("invalid raw metric registry"); }
  const tasks = raw.tasks.map(parseResourceTask), ids = tasks.map(t => t.task_id);
  if (new Set(ids.map(id => id.toLowerCase())).size !== ids.length || canonical(ids) !== canonical([...ids].sort())) throw new TypeError("resource dataset tasks must be sorted and unique");
  const { dataset_digest, ...body } = raw;
  if (sha(dataset_digest) !== identity("hitch-resource-dataset@2", body)) throw new TypeError("resource dataset digest mismatch");
  return { ...raw, tasks } as unknown as ResourceDataset;
}
export function selectResources(dataset: ResourceDataset, ids: string[]): ResourceSelection {
  const sorted = [...ids].sort(); if (!sorted.length || new Set(ids.map(id => id.toLowerCase())).size !== ids.length || sorted.some(id => !dataset.tasks.some(t => t.task_id === id))) throw new TypeError("invalid resource selection");
  const { tasks, dataset_digest, ...manifest } = dataset;
  const body = { protocol: "hitch-resource-selection@1" as const, sourceDatasetDigest: dataset_digest, manifest, tasks: tasks.filter(t => sorted.includes(t.task_id)) };
  return { ...body, digest: identity(body.protocol, body) };
}
export function parseResourceSelection(value: unknown): ResourceSelection {
  const raw = object(value, ["protocol", "sourceDatasetDigest", "manifest", "tasks", "digest"]);
  if (raw.protocol !== "hitch-resource-selection@1") throw new TypeError("unsupported resource selection");
  const { digest, ...body } = raw;
  if (sha(digest) !== identity(raw.protocol, body)) throw new TypeError("resource selection digest mismatch");
  sha(raw.sourceDatasetDigest);
  const manifest = object(raw.manifest, ["schema_version", "kind", "resource_protocol", "execution", "required_capabilities", "benchmark", "adapter", "scoring", "raw_metrics"]);
  const datasetBody = { ...manifest, tasks: raw.tasks };
  const dataset = parseResourceDataset({ ...datasetBody, dataset_digest: identity("hitch-resource-dataset@2", datasetBody) });
  return { ...raw, tasks: dataset.tasks } as unknown as ResourceSelection;
}

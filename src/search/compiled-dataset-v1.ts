import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digestDatasetRef } from '../state/dataset.js';
import { digestJson } from '../state/digest.js';
import { readBoundedRegularFile } from '../state/bounded-file.js';
import { resolveMetric } from '../objective/contracts.js';
import type { DatasetDescription } from './dataset-projection.js';

export type StandardCompiledDatasetV1 = { root: string; sourceDigest: string;
  manifest: DatasetDescription['manifest'] & { schema_version: '1' };
  tasks: { id: string; contentDigest: string }[] };

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be nonempty`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} digest invalid`);
  return value;
}
function scoring(value: unknown, label: string): void {
  const item = record(value, label);
  if (typeof item.source_metric !== 'string' || !item.source_metric
    || !['maximize', 'minimize'].includes(item.direction as string)
    || item.reducer !== 'task-macro-mean'
    || !Array.isArray(item.range) || item.range.length !== 2 || !item.range.every(Number.isFinite)
    || item.range[0] >= item.range[1]) throw new Error(`${label} scoring contract invalid`);
}

/** Shared standard-v1 task-byte verifier for search projection and author admission. */
export async function inspectStandardCompiledDatasetV1(named: string): Promise<StandardCompiledDatasetV1> {
  const root = resolve(named);
  if (!(await lstat(root)).isDirectory()) throw new Error('Compiled dataset must be a real directory');
  const sourceDigest = await digestDatasetRef(root);
  const manifestPath = join(root, 'benchmark.adapter.json');
  const raw: unknown = JSON.parse((await readBoundedRegularFile(manifestPath, 1024 * 1024,
    'Compiled dataset manifest')).toString('utf8'));
  const manifest = record(raw, 'Compiled dataset manifest');
  if (manifest.schema_version !== '1' || manifest.kind !== 'gear-harbor-benchmark')
    throw new Error('Only standard compiled dataset v1 is supported');
  const benchmark = record(manifest.benchmark, 'Compiled dataset benchmark');
  nonempty(benchmark.id, 'Compiled dataset benchmark ID'); nonempty(benchmark.revision, 'Compiled dataset benchmark revision');
  const adapter = record(manifest.adapter, 'Compiled dataset adapter');
  nonempty(adapter.id, 'Compiled dataset adapter ID'); nonempty(adapter.revision, 'Compiled dataset adapter revision');
  if (adapter.output_protocol !== 'gear-harbor-eval-result-v1') throw new Error('Compiled dataset output protocol unsupported');
  const scores = record(manifest.scoring, 'Compiled dataset scoring');
  scoring(scores.total_score, 'Compiled dataset total score');
  if (scores.process_score !== undefined) scoring(scores.process_score, 'Compiled dataset process score');
  if (manifest.raw_metrics !== undefined) {
    const metrics = record(manifest.raw_metrics, 'Compiled dataset raw metrics');
    if (metrics.schema_version !== '1' || !Array.isArray(metrics.metrics))
      throw new Error('Compiled dataset raw metric registry unsupported');
    const names = new Set<string>();
    for (const rawMetric of metrics.metrics) {
      const resolved = resolveMetric(rawMetric);
      if (names.has(resolved.id)) throw new Error('Compiled dataset raw metric repeated');
      names.add(resolved.id);
    }
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) throw new Error('Compiled dataset tasks required');
  const ids = new Set<string>();
  const tasks: StandardCompiledDatasetV1['tasks'] = [];
  for (const row of manifest.tasks) {
    const task = record(row, 'Compiled dataset task');
    const id = nonempty(task.task_id, 'Compiled dataset task ID');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) || id === '.' || id === '..' || ids.has(id))
      throw new Error('Compiled dataset task ID invalid or repeated');
    ids.add(id);
    const claimed = digest(task.task_digest, `Compiled dataset task ${id}`);
    const directory = join(root, id);
    if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, 'task.toml'))).isFile())
      throw new Error(`Compiled dataset task ${id} is not a standard task directory`);
    const actual = await digestDatasetRef(directory);
    if (claimed !== actual) throw new Error(`Compiled dataset task ${id} bytes differ from manifest`);
    tasks.push({ id, contentDigest: actual });
  }
  const { dataset_digest: _claimed, ...body } = manifest;
  if (digest(manifest.dataset_digest, 'Compiled dataset manifest') !== digestJson(body))
    throw new Error('Compiled dataset manifest digest mismatch');
  if (await digestDatasetRef(root) !== sourceDigest) throw new Error('Compiled dataset changed during inspection');
  return { root, sourceDigest, manifest: manifest as StandardCompiledDatasetV1['manifest'], tasks };
}

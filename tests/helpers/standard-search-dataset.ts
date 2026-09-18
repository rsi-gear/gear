import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digestDatasetRef } from '../../src/state/dataset.js'
import { digestJson } from '../../src/state/digest.js'

export async function standardSearchDataset(root: string, count: number, partition = 'seed', process = true): Promise<{ ref: string; digest: string }> {
  const ref = join(root, partition), tasks = []
  for (let index = 0; index < count; index++) {
    const id = `task-${index}`, task = join(ref, id)
    await mkdir(task, { recursive: true })
    await writeFile(join(task, 'task.toml'), 'version = "1.0"\n[verifier]\ntimeout_sec = 60\n')
    await writeFile(join(task, 'instruction.md'), `${partition} fixture task ${index}\n`)
    tasks.push({ task_id: id, task_digest: await digestDatasetRef(task) })
  }
  const score = { direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' }
  const manifest = { schema_version: '1', kind: 'gear-harbor-benchmark', benchmark: { id: 'self-contained-fixture', revision: 'v1' },
    adapter: { id: 'fixture', revision: 'v1', output_protocol: 'gear-harbor-eval-result-v1' },
    scoring: { total_score: { ...score, source_metric: 'completion' }, ...(process ? { process_score: { ...score, source_metric: 'partial_credit' } } : {}) }, tasks }
  await writeFile(join(ref, 'benchmark.adapter.json'), JSON.stringify({ ...manifest, dataset_digest: digestJson(manifest) }))
  return { ref, digest: await digestDatasetRef(ref) }
}

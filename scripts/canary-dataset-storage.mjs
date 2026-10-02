import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { digestDatasetRef } from '../lib/state/dataset.js'
import { digestJson } from '../lib/state/digest.js'
import { RefineStateStore } from '../lib/state/store.js'
import { describeDataset, projectDataset } from '../lib/search/dataset-projection.js'

if (process.argv[2] === 'child') {
  const [root, taskIds] = process.argv.slice(3), spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'))
  let lock
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await new RefineStateStore(root).acquireRoundLock() }
    catch (error) { if (attempt >= 200) throw error; await new Promise(resolve => setTimeout(resolve, 25)) }
  }
  try {
    const description = await describeDataset(spec, 'seed', root)
    console.log(JSON.stringify(await projectDataset(description, JSON.parse(taskIds), join(root, 'search'), { lock, signal: new AbortController().signal })))
  } finally { await lock.release() }
} else {
  const root = await mkdtemp(join(tmpdir(), 'gear-process-materialization-'))
  try {
    const dataset = join(root, 'dataset'); await mkdir(dataset)
    const tasks = []
    for (const id of ['task-0', 'task-1']) {
      const directory = join(dataset, id); await mkdir(join(directory, 'empty'), { recursive: true })
      await writeFile(join(directory, 'task.toml'), 'schema_version="1.4"\n')
      await writeFile(join(directory, 'input'), Buffer.alloc(1024 * 1024, 42))
      tasks.push({ task_id: id, task_digest: await digestDatasetRef(directory) })
    }
    const body = { schema_version: '1', kind: 'gear-harbor-benchmark', benchmark: { id: 'canary', revision: '1' }, adapter: { id: 'canary', revision: '1', output_protocol: 'gear-harbor-eval-result-v1' }, scoring: { total_score: { source_metric: 'reward', direction: 'maximize', range: [0, 1], reducer: 'task-macro-mean' } }, tasks }
    await writeFile(join(dataset, 'benchmark.adapter.json'), JSON.stringify({ ...body, dataset_digest: digestJson(body) }))
    const ref = { ref: dataset, digest: await digestDatasetRef(dataset) }
    await writeFile(join(root, 'spec.json'), JSON.stringify({ datasets: { seed: ref, heldOut: ref }, rollout: { repetitions: 1 }, taskBudgetMs: 1000, toolchainRef: 'canary', sandboxProfileRef: 'canary' }))
    const child = ids => new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', root, JSON.stringify(ids)], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''
      p.stdout.on('data', b => { out += b }); p.stderr.on('data', b => { err += b }); p.on('error', reject)
      p.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(Error(err)))
    })
    const [a, b, c] = await Promise.all([child(['task-0']), child(['task-0']), child(['task-0', 'task-1'])])
    assert.deepEqual(a, b); assert.notEqual(a.ref, c.ref)
    assert.equal((await readdir(join(root, 'search/datasets'))).length, 2)
    await writeFile(join(a.ref, 'task-0/input'), 'private mutation')
    assert.equal(await digestDatasetRef(dataset), ref.digest)
    assert.equal((await readFile(join(c.ref, 'task-0/input'))).length, 1024 * 1024)
    console.log(JSON.stringify({ processes: 3, canonicalProjections: 2, duplicatePublicationReused: true, sourceAndOverlappingProjectionIsolated: true }))
  } finally { await rm(root, { recursive: true, force: true }) }
}

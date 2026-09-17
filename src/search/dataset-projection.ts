import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { EvolutionSpec } from '../types.js'
import { digestDatasetRef } from '../state/dataset.js'
import { digestJson } from '../state/digest.js'
import { digest, invariant, seal, sorted } from './contracts.js'
import type { MetricContract, Partition, TaskUniverse } from './types.js'

interface ScoreDefinition { source_metric: string; direction: 'maximize' | 'minimize'; range: [number, number]; reducer: 'task-macro-mean' }
export interface DatasetDescription {
  root: string
  sourceDigest: string
  manifest: {
    schema_version: '1'; kind: 'gear-harbor-benchmark'; benchmark: { id: string; revision: string }
    adapter: { id: string; revision: string; output_protocol: 'gear-harbor-eval-result-v1' }
    scoring: { total_score: ScoreDefinition; process_score?: ScoreDefinition }
    tasks: Array<{ task_id: string; task_digest: string }>; dataset_digest: string
  }
  universe: TaskUniverse
}
/** The source is an ordinary compiled dataset. No evaluator-specific discovery protocol is needed. */
export async function describeDataset(spec: EvolutionSpec, partition: Partition, workspaceRoot: string): Promise<DatasetDescription> {
  const source = partition === 'seed' ? spec.datasets.seed : spec.datasets.heldOut, root = resolve(workspaceRoot, source.ref)
  const directory = await lstat(root).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  invariant(directory?.isDirectory(), 'Gear staged search requires a local compiled task dataset; resolve the dataset before admission')
  const sourceDigest = await digestDatasetRef(root)
  invariant(sourceDigest === source.digest, 'task dataset changed after evolution admission')
  const text = await readFile(join(root, 'benchmark.adapter.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  invariant(text, 'Gear staged search requires benchmark.adapter.json from the standard dataset compiler')
  const manifest = JSON.parse(text) as DatasetDescription['manifest']
  invariant(manifest.schema_version === '1' && manifest.kind === 'gear-harbor-benchmark' && manifest.adapter?.output_protocol === 'gear-harbor-eval-result-v1', 'staged search requires the existing standard benchmark manifest')
  invariant(typeof manifest.benchmark?.id === 'string' && typeof manifest.benchmark.revision === 'string'
    && typeof manifest.adapter.id === 'string' && typeof manifest.adapter.revision === 'string' && Array.isArray(manifest.tasks) && manifest.tasks.length > 0, 'invalid benchmark manifest')
  const ids = sorted(manifest.tasks.map(t => t.task_id))
  invariant(ids.length === manifest.tasks.length && ids.every(id => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(id) && id !== '.' && id !== '..'), 'invalid task directory manifest')
  const tasks: Array<{ id: string; contentDigest: string }> = []
  for (const id of ids) {
    digest(manifest.tasks.find(t => t.task_id === id)!.task_digest)
    invariant((await lstat(join(root, id))).isDirectory() && (await lstat(join(root, id, 'task.toml'))).isFile(), 'each task must be a self-contained standard task directory')
    tasks.push({ id, contentDigest: await digestDatasetRef(join(root, id)) })
  }
  const contract = (channel: 'outcome' | 'process', score: ScoreDefinition): MetricContract => {
    invariant(score && typeof score.source_metric === 'string' && ['maximize', 'minimize'].includes(score.direction)
      && score.reducer === 'task-macro-mean' && Array.isArray(score.range) && score.range.length === 2
      && score.range.every(Number.isFinite) && score.range[0] < score.range[1], 'invalid declared task scoring contract')
    return seal({ id: `${manifest.adapter.id}:${channel}`, revision: manifest.adapter.revision, channel,
      evidenceKind: channel === 'outcome' ? 'final-outcome' : 'final-state-partial-credit', granularity: 'trial', direction: score.direction,
      range: { min: score.range[0], max: score.range[1] }, normalization: { kind: 'fixed-linear', min: score.range[0], max: score.range[1] },
      comparisonQuantum: 1e-9, repetitionReducer: 'mean', applicableTaskSetDigest: digestJson(sorted(tasks.map(t => t.contentDigest))),
      group: digestJson({ channel, score, adapter: manifest.adapter }) })
  }
  const outcome = contract('outcome', manifest.scoring?.total_score), process = manifest.scoring.process_score && contract('process', manifest.scoring.process_score)
  invariant(await digestDatasetRef(root) === sourceDigest, 'source dataset changed while resolving task identities')
  const universe = seal({ partition, tasks: tasks.map(t => ({ ...t, outcome, ...(process ? { process } : {}), successUtility: 1, weight: 1, stratum: manifest.benchmark.id, estimatedCost: spec.taskBudgetMs })),
    conditionDigest: digestJson({ sourceDigest, scoring: manifest.scoring, rollout: spec.rollout, taskBudgetMs: spec.taskBudgetMs, toolchain: spec.toolchainRef, sandbox: spec.sandboxProfileRef }),
    // null means the existing evaluator controls randomness; do not invent a recorded seed.
    repetitions: Array.from({ length: spec.rollout.repetitions }, (_, index) => ({ index, seed: spec.rollout.seeds?.[index] ?? null })) })
  return { root, sourceDigest, manifest, universe }
}

/** Copies immutable task bytes into Gear-owned state, leaving the source dataset untouched. */
export async function projectDataset(description: DatasetDescription, taskIds: string[], stateRoot: string): Promise<{ ref: string; digest: string }> {
  const ids = sorted(taskIds)
  invariant(ids.length > 0 && ids.length === taskIds.length && ids.every(id => description.universe.tasks.some(t => t.id === id)), 'invalid subset task manifest')
  invariant(await digestDatasetRef(description.root) === description.sourceDigest, 'source dataset changed before subset preparation')
  const ref = join(stateRoot, 'datasets', digestJson({ source: description.sourceDigest, ids }).slice(7))
  const verify = async () => {
    for (const id of ids) invariant(await digestDatasetRef(join(ref, id)) === description.universe.tasks.find(t => t.id === id)!.contentDigest, 'prepared task content changed')
    const manifest = JSON.parse(await readFile(join(ref, 'benchmark.adapter.json'), 'utf8'))
    invariant(digestJson(manifest) === digestJson(projectedManifest), 'prepared dataset manifest changed')
    const entries = (await readdir(ref)).sort()
    invariant(digestJson(entries) === digestJson([...ids, 'benchmark.adapter.json'].sort()), 'prepared dataset has unexpected tasks or files')
    return { ref, digest: await digestDatasetRef(ref) }
  }
  const { dataset_digest: ignored, ...base } = description.manifest
  const body = { ...base, tasks: description.manifest.tasks.filter(t => ids.includes(t.task_id)) }
  const projectedManifest = { ...body, dataset_digest: digestJson(body) }
  try { await lstat(ref); return await verify() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(join(stateRoot, 'datasets'), { recursive: true })
  const temp = `${ref}.${crypto.randomUUID()}.tmp`
  try {
    await mkdir(temp)
    for (const id of ids) await cp(join(description.root, id), join(temp, id), { recursive: true, errorOnExist: true, force: false })
    await writeFile(join(temp, 'benchmark.adapter.json'), `${JSON.stringify(projectedManifest, null, 2)}\n`)
    invariant(await digestDatasetRef(description.root) === description.sourceDigest, 'source dataset changed during subset preparation')
    await rename(temp, ref)
    return await verify()
  } finally { await rm(temp, { recursive: true, force: true }) }
}

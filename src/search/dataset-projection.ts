import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { materializeTrees, removeOwnedTree, type MaterializationPolicy } from '../state/materialize-tree.js'
import type { WorkspaceLock } from '../state/store.js'
import type { EvolutionSpec } from '../types.js'
import { digestDatasetRef } from '../state/dataset.js'
import { digestJson } from '../state/digest.js'
import { digest, invariant, seal, sorted } from './contracts.js'
import type { MetricContract, Partition, TaskUniverse } from './types.js'
import { resolveMetric, resolveObjective } from '../objective/contracts.js'
import type { RawMetricDefinition } from '../objective/types.js'
import { parseResourceDataset, selectResources, type ResourceDataset } from '../state/resource-contract.js'
import { parseStrictJson } from '../state/resource-protocol.js'
import { readProjectionQuarantine } from '../state/projection-quarantine.js'

interface ScoreDefinition { source_metric: string; direction: 'maximize' | 'minimize'; range: readonly [number, number]; reducer: 'task-macro-mean' }
export interface DatasetDescription {
  root: string
  sourceDigest: string
  resourceManifest?: ResourceDataset
  manifest: {
    schema_version: '1' | '2'; kind: 'gear-harbor-benchmark'; benchmark: { id: string; revision: string }
    adapter: { id: string; revision: string; output_protocol: 'gear-harbor-eval-result-v1' }
    scoring: { total_score: ScoreDefinition; process_score?: ScoreDefinition }
    raw_metrics?: { schema_version: '1'; metrics: RawMetricDefinition[] }
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
  const raw = JSON.parse(text), resourceManifest = raw.schema_version === '2' ? parseResourceDataset(parseStrictJson(text)) : undefined
  const manifest = (resourceManifest ?? raw) as DatasetDescription['manifest']
  invariant((manifest.schema_version === '1' || resourceManifest) && manifest.kind === 'gear-harbor-benchmark' && manifest.adapter?.output_protocol === 'gear-harbor-eval-result-v1', 'staged search requires a supported standard benchmark manifest')
  invariant(typeof manifest.benchmark?.id === 'string' && typeof manifest.benchmark.revision === 'string'
    && typeof manifest.adapter.id === 'string' && typeof manifest.adapter.revision === 'string' && Array.isArray(manifest.tasks) && manifest.tasks.length > 0, 'invalid benchmark manifest')
  const ids = sorted(manifest.tasks.map(t => t.task_id))
  invariant(ids.length === manifest.tasks.length && ids.every(id => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(id) && id !== '.' && id !== '..'), 'invalid task directory manifest')
  const tasks: Array<{ id: string; contentDigest: string }> = []
  for (const id of ids) {
    digest(manifest.tasks.find(t => t.task_id === id)!.task_digest)
    invariant((await lstat(join(root, id))).isDirectory() && (await lstat(join(root, id, 'task.toml'))).isFile(), 'each task must be a self-contained standard task directory')
    tasks.push({ id, contentDigest: resourceManifest ? resourceManifest.tasks.find(t => t.task_id === id)!.task_digest : await digestDatasetRef(join(root, id)) })
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
  let rawMetricContracts: TaskUniverse['rawMetricContracts']
  if (spec.rawMetricsVersion === 1) {
    const registry = manifest.raw_metrics
    invariant(!registry || registry.schema_version === '1' && Array.isArray(registry.metrics), 'unsupported raw metric registry')
    const standard = (id: string, score: ScoreDefinition, field: string): RawMetricDefinition => ({ id, revision: manifest.adapter.revision,
      unit: 'score', direction: score.direction, source: { path: `scores.${field}`, extractor: 'number-v1' }, range: { min: score.range[0], max: score.range[1] },
      granularity: 'trial', repetitionReducer: 'mean', taskReducer: 'weighted-mean', comparisonPrecision: 1e-9 })
    const declarations = registry?.metrics ?? []
    invariant(new Set(declarations.map(d => d.id)).size === declarations.length, 'duplicate raw metric declaration')
    rawMetricContracts = [...declarations, ...[standard('total_score', manifest.scoring.total_score, 'totalScore'),
      ...(manifest.scoring.process_score ? [standard('process_score', manifest.scoring.process_score, 'processScore')] : [])].filter(d => !declarations.some(m => m.id === d.id))].map(resolveMetric)
    if (spec.objective) {
      const definition = { terms: spec.objective.terms.map(({ metric, weight, scale }) => ({ metric, weight, scale })),
        constraints: spec.objective.constraints.map(c => c.rule === 'minimum' ? { metric: c.metric, rule: c.rule, value: c.value }
          : { metric: c.metric, rule: c.rule, reference: c.reference, tolerance: c.tolerance }) }
      invariant(resolveObjective(definition, rawMetricContracts).digest === spec.objective.digest, 'dataset raw metric semantics differ from the frozen objective')
    }
  }
  invariant(await digestDatasetRef(root) === sourceDigest, 'source dataset changed while resolving task identities')
  const universe = seal({ partition, ...(rawMetricContracts ? { rawMetricContracts } : {}), ...(spec.objective ? { objective: spec.objective } : {}), tasks: tasks.map(t => ({ ...t, outcome, ...(process ? { process } : {}), successUtility: 1, weight: 1, stratum: manifest.benchmark.id, estimatedCost: spec.taskBudgetMs })),
    conditionDigest: digestJson({ sourceDigest, scoring: manifest.scoring, rollout: spec.rollout, taskBudgetMs: spec.taskBudgetMs, toolchain: spec.toolchainRef, sandbox: spec.sandboxProfileRef }),
    // null means the existing evaluator controls randomness; do not invent a recorded seed.
    repetitions: Array.from({ length: spec.rollout.repetitions }, (_, index) => ({ index, seed: spec.rollout.seeds?.[index] ?? null })) })
  return { root, sourceDigest, manifest, universe, ...(resourceManifest ? { resourceManifest } : {}) }
}

/** Copies immutable task bytes into Gear-owned state, leaving the source dataset untouched. */
export async function projectDataset(description: DatasetDescription, taskIds: string[], stateRoot: string,
  options: { lock: WorkspaceLock; signal: AbortSignal; policy?: MaterializationPolicy }): Promise<{ ref: string; digest: string }> {
  await options.lock.assertHeld(dirname(stateRoot))
  options.signal.throwIfAborted()
  const ids = sorted(taskIds)
  invariant(ids.length > 0 && ids.length === taskIds.length && ids.every(id => description.universe.tasks.some(t => t.id === id)), 'invalid subset task manifest')
  invariant(await digestDatasetRef(description.root) === description.sourceDigest, 'source dataset changed before subset preparation')
  if (description.resourceManifest) {
    const selection = selectResources(description.resourceManifest, ids)
    const directory = join(stateRoot, 'selections'), ref = join(directory, `${selection.digest.slice(7)}.json`)
    const bytes = `${JSON.stringify(selection, null, 2)}\n`
    await mkdir(directory, { recursive: true })
    const existing = await lstat(ref).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return undefined })
    if (existing) invariant(existing.isFile() && await readFile(ref, 'utf8') === bytes, 'resource selection changed')
    else {
      const temp = `${ref}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temp, bytes, { flag: 'wx' })
        invariant(await digestDatasetRef(description.root) === description.sourceDigest, 'source dataset changed during selection preparation')
        await options.lock.assertHeld(dirname(stateRoot)); options.signal.throwIfAborted(); await rename(temp, ref)
      }
      finally { await rm(temp, { force: true }) }
    }
    return { ref, digest: await digestDatasetRef(ref) }
  }
  const ref = join(stateRoot, 'datasets', digestJson({ source: description.sourceDigest, ids }).slice(7))
  const verify = async (directory: string) => {
    invariant((await lstat(directory)).isDirectory(), 'prepared dataset is not a directory')
    for (const id of ids) invariant(await digestDatasetRef(join(directory, id)) === description.universe.tasks.find(t => t.id === id)!.contentDigest, 'prepared task content changed')
    const manifest = JSON.parse(await readFile(join(directory, 'benchmark.adapter.json'), 'utf8'))
    invariant(digestJson(manifest) === digestJson(projectedManifest), 'prepared dataset manifest changed')
    const entries = (await readdir(directory)).sort()
    invariant(digestJson(entries) === digestJson([...ids, 'benchmark.adapter.json'].sort()), 'prepared dataset has unexpected tasks or files')
    return { ref, digest: await digestDatasetRef(directory) }
  }
  const { dataset_digest: ignored, ...base } = description.manifest
  const body = { ...base, tasks: description.manifest.tasks.filter(t => ids.includes(t.task_id)) }
  const projectedManifest = { ...body, dataset_digest: digestJson(body) }
  const exists = async () => { try { await lstat(ref); return true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return false } }
  const quarantine = await readProjectionQuarantine(stateRoot, basename(ref))
  // An ENOENT inside an existing canonical is corruption, never a cache miss.
  if (await exists()) {
    const prepared = await verify(ref)
    if (quarantine) {
      invariant(quarantine.location === 'canonical' && quarantine.digest === prepared.digest, 'quarantine projection identity mismatch')
      await options.lock.assertHeld(dirname(stateRoot)); options.signal.throwIfAborted()
      await rm(quarantine.directory, { recursive: true })
    }
    return prepared
  }
  if (quarantine) {
    const prepared = await verify(quarantine.tree)
    invariant(quarantine.location === 'quarantine' && quarantine.digest === prepared.digest, 'quarantine projection identity mismatch')
    await options.lock.assertHeld(dirname(stateRoot)); options.signal.throwIfAborted()
    await rename(quarantine.tree, ref); await rm(quarantine.directory, { recursive: true })
    return prepared
  }
  await mkdir(join(stateRoot, 'datasets'), { recursive: true })
  const owner = crypto.randomUUID(), temp = `${ref}.${owner}.tmp`
  const reports = join(stateRoot, 'materializations'), ownerPath = join(reports, 'owners', `${owner}.json`)
  await mkdir(dirname(ownerPath), { recursive: true })
  await writeFile(ownerPath, JSON.stringify({ schemaVersion: 1, kind: 'gear-materialization-owner', temp, ref,
    pid: process.pid, token: options.lock.token, createdAt: new Date().toISOString() }), { flag: 'wx' })
  try {
    await mkdir(temp)
    const report = await materializeTrees(ids.map(id => ({ source: join(description.root, id), destination: join(temp, id) })), options)
    options.signal.throwIfAborted()
    await writeFile(join(temp, 'benchmark.adapter.json'), `${JSON.stringify(projectedManifest, null, 2)}\n`)
    const prepared = await verify(temp)
    invariant(await digestDatasetRef(description.root) === description.sourceDigest, 'source dataset changed during subset preparation')
    await options.lock.assertHeld(dirname(stateRoot))
    options.signal.throwIfAborted()
    // rename may replace an empty directory. All producers/GC hold this lock;
    // check immediately before publication and preserve even empty corruption.
    if (await exists()) return verify(ref)
    // Publish ownership first. A failed/interrupted report write must never
    // leave a canonical tree that GC mistakes for an unowned legacy projection.
    // An unused report is harmless and the next materialization replaces it.
    const reportTemp = join(reports, `${owner}.tmp`)
    try {
      await writeFile(reportTemp, `${JSON.stringify({ schemaVersion: 1, kind: 'gear-materialization', ref, digest: prepared.digest,
        sourceRef: description.root, sourceDigest: description.sourceDigest, taskIds: ids, createdAt: new Date().toISOString(), report }, null, 2)}\n`, { flag: 'wx' })
      await rename(reportTemp, join(reports, `${basename(ref)}.json`))
    } finally { await rm(reportTemp, { force: true }) }
    await options.lock.assertHeld(dirname(stateRoot)); options.signal.throwIfAborted()
    try { await rename(temp, ref) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      return verify(ref)
    }
    options.signal.throwIfAborted()
    return prepared
  } finally { await removeOwnedTree(temp); await rm(ownerPath, { force: true }) }
}

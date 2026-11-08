#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Store, json, atomicJson } from './lib/store.mjs'
import { assert, compatible, digest, sha, validateCheckpoint } from './lib/contracts.mjs'
import { HitchBackend } from './lib/hitch-backend.mjs'
import { cli, isMain } from './lib/common.mjs'

export async function exportCheckpoint(store, reference, directory) {
  const checkpoint = validateCheckpoint(await store.get(reference)); await store.verifySources(checkpoint)
  await mkdir(join(directory, 'objects'), { recursive: true })
  const ids = [...new Set([...checkpoint.solutions.flatMap(s => s.files.map(f => f.digest)), ...checkpoint.history.flatMap(e => [e.execution.oofDigest, e.execution.predictionsDigest, ...(e.analysis?.artifacts ?? []).map(a => a.digest), e.analysis?.pluginCache?.digest]).filter(Boolean)])]
  for (const id of ids) await writeFile(join(directory, 'objects', id.slice(7)), await store.bytes(id), { mode: 0o444 })
  await atomicJson(join(directory, 'checkpoint.json'), checkpoint)
  return { checkpointRef: reference, checkpointDigest: checkpoint.digest, sourceObjects: ids.length }
}

export async function importCheckpoint(store, backend, expectedScope, directory) {
  const checkpoint = validateCheckpoint(await json(join(directory, 'checkpoint.json'))); compatible(expectedScope, checkpoint)
  const authenticatedSolutions = new Set()
  // Authenticate every historical experiment against its original public run
  // outputs. A digest alone is not evidence that a foreign history is trusted.
  for (const experiment of checkpoint.history) {
    const manifest = await backend.hitch(['runs', 'artifacts', 'list', experiment.rolloutRunId, '--json'], { executor: true })
    assert(checkpoint.sourceOutputManifests.includes(manifest.digest), 'history has no original output manifest')
    const destination = join(store.root, 'checkpoint-imports', experiment.rolloutRunId)
    await mkdir(join(store.root, 'checkpoint-imports'), { recursive: true })
    await backend.hitch(['runs', 'artifacts', 'export', experiment.rolloutRunId, '--manifest-digest', manifest.digest, '--out', destination, '--json'], { executor: true })
    const entry = manifest.entries.find(e => e.path === 'output/receipt.json'); assert(entry, 'history receipt unavailable')
    const bytes = await readFile(join(destination, entry.path)); assert(sha(bytes) === entry.sha256, 'history receipt changed')
    const actual = JSON.parse(bytes); assert(actual.protocol === 'analysis-rollout-output@1' && digest(actual.experiment) === digest(experiment), 'history is not original pre-score research evidence')
    for (const solution of actual.solutions) { assert(checkpoint.solutions.some(s => s.digest === solution.digest), 'missing original source'); authenticatedSolutions.add(solution.digest) }
  }
  assert(checkpoint.solutions.every(s => authenticatedSolutions.has(s.digest)), 'unauthenticated history source')
  for (const solution of checkpoint.solutions) for (const f of solution.files) {
    const bytes = await readFile(join(directory, 'objects', f.digest.slice(7)))
    assert(bytes.length === f.bytes && sha(bytes) === f.digest, 'incomplete source closure'); await store.putBytes(bytes)
  }
  for (const id of new Set(checkpoint.history.flatMap(e => [e.execution.oofDigest, e.execution.predictionsDigest, ...(e.analysis?.artifacts ?? []).map(a => a.digest), e.analysis?.pluginCache?.digest]).filter(Boolean))) {
    const bytes = await readFile(join(directory, 'objects', id.slice(7)))
    assert(sha(bytes) === id, 'missing or changed experiment evidence'); await store.putBytes(bytes)
  }
  return store.put(checkpoint)
}
export async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: { project: { type: 'string' }, ref: { type: 'string' }, directory: { type: 'string' } } })
  assert(v.project && v.directory, '--project and --directory required')
  const project = await json(join(resolve(v.project), 'project.json')), store = new Store(join(resolve(v.project), 'research'))
  const head = await store.load('projects', project.projectId)
  if (positionals[0] === 'export') console.log(JSON.stringify(await exportCheckpoint(store, v.ref ?? head.checkpoint, resolve(v.directory))))
  else if (positionals[0] === 'import') console.log(JSON.stringify({ checkpointRef: await importCheckpoint(store, new HitchBackend(store, project.backend), await store.get(head.checkpoint), resolve(v.directory)) }))
  else throw new Error('checkpoint action must be export or import; import does not move the project head')
}
if (isMain(import.meta.url)) cli(main)

import { join } from 'node:path'
import { canonicalDigest } from '../domain/canonical.js'
import { GearError } from '../domain/errors.js'
import type { CapturedImports, SourceImport } from '../domain/operator-run.js'
import type { RunSpec } from '../domain/run.js'
import type { TargetManifest } from '../domain/target.js'
import type { HarnessAdapter } from '../ports/harness.js'
import { RunStore } from '../adapters/storage/run-store.js'
import { StoredOperatorEffects } from '../adapters/storage/operator-effects.js'
import { TargetStore, targetManifest } from '../adapters/storage/targets.js'
import { validateAlgorithmWire } from '../domain/algorithm-schema.js'
import { operatorObjective } from '../domain/operator-objective.js'

/** Explicit imports copy immutable, bounded material from runs in this project only. */
export async function captureOperatorImports(
  root: string,
  runId: string,
  spec: RunSpec,
  anchor: TargetManifest,
  adapter: HarnessAdapter,
  requests: SourceImport[],
): Promise<CapturedImports> {
  if (
    requests.length > 128 ||
    new Set(requests.map((request) => request.name)).size !== requests.length ||
    new Set(requests.map((request) => canonicalDigest(request.ref))).size !== requests.length
  )
    throw new GearError('invalid-source-import', 'Imports require unique names and references, at most 128')
  const imports: CapturedImports = { bindings: [], candidates: [], artifacts: [] }
  const store = new RunStore(root)
  let bytes = 0
  for (const request of requests) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(request.name) ||
      !['material', 'evidence'].includes(request.purpose)
    )
      throw new GearError('invalid-source-import', 'Invalid import name or purpose')
    validateAlgorithmWire('SourceRef', request.ref, 2)
    if (request.ref.run_id === runId)
      throw new GearError('invalid-source-import', 'Import sources must belong to an existing run')
    const source = await store.read(request.ref.run_id)
    if (
      spec.operatorPolicy?.access?.exposure === 'blind' &&
      source.spec.operatorPolicy?.access?.exposure !== 'blind'
    )
      throw new GearError(
        'import-exposure-denied',
        'Blind runs cannot import material learned with scored feedback',
      )
    const future = spec.operatorPolicy?.access?.task_order?.slice(1) ?? []
    if (
      source.spec.benchmarkDigest === spec.benchmarkDigest &&
      source.spec.seedTasks.some((task) => future.includes(task.id))
    )
      throw new GearError(
        'import-future-task-denied',
        'This source run was admitted to future tasks in the same finite stream',
      )
    if ('candidate_id' in request.ref) {
      if (request.purpose !== 'material')
        throw new GearError(
          'import-purpose-mismatch',
          'Candidate source import does not authorize historical scores',
        )
      const ref = request.ref
      const candidate = source.candidates.find((candidate) => candidate.id === ref.candidate_id)
      if (!candidate || candidate.digest !== ref.digest)
        throw new GearError('import-identity-mismatch', 'Candidate import differs from its sealed source')
      const targets = new TargetStore(
        join(root, 'runs', source.id),
        adapter,
        source.spec.evaluationIdentity ?? source.spec.providerIdentity,
      )
      const material = (await new StoredOperatorEffects(targets).materials(source, [ref]))[0]!
      const resources = Object.entries(material.files!)
        .map(([path, file]) => ({ path, digest: canonicalDigest(file.content), executable: file.executable }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const manifest = targetManifest(
        adapter,
        spec.evaluationIdentity ?? spec.providerIdentity,
        anchor.baseRef,
        resources,
      )
      const imported = { id: 'import_' + request.name, parent_id: null, digest: manifest.digest }
      imports.candidates.push({ candidate: imported, files: material.files! })
      imports.bindings.push({ ...structuredClone(request), candidate: imported })
      bytes += Buffer.byteLength(JSON.stringify(material.files))
    } else {
      const ref = request.ref
      const artifact = source.operators?.artifacts.find(
        (artifact) => canonicalDigest(artifact.ref) === canonicalDigest(ref),
      )
      if (
        !artifact ||
        !['agent', 'optimization'].includes(ref.visibility) ||
        canonicalDigest({ kind: ref.kind, value: artifact.value, sources: artifact.sources }) !== ref.digest
      )
        throw new GearError(
          'import-identity-mismatch',
          'Artifact import differs from its sealed optimizer-visible source',
        )
      const evidence = ['assessment', 'evidence_set'].includes(ref.kind)
      if (evidence !== (request.purpose === 'evidence'))
        throw new GearError(
          'import-purpose-mismatch',
          'Historical scoring evidence requires a separate evidence import',
        )
      if (
        (evidence || artifact.external) &&
        (source.spec.benchmarkDigest !== spec.benchmarkDigest ||
          (source.spec.evaluationIdentity ?? source.spec.providerIdentity) !==
            (spec.evaluationIdentity ?? spec.providerIdentity))
      )
        throw new GearError(
          'import-conditions-mismatch',
          'Evidence and external artifacts require identical data and execution conditions',
        )
      if (
        evidence &&
        (canonicalDigest(operatorObjective(source.spec.objective)) !==
          canonicalDigest(operatorObjective(spec.objective)) ||
          source.spec.objectiveIdentity !== spec.objectiveIdentity)
      )
        throw new GearError(
          'import-objective-mismatch',
          'Evidence import changed the frozen objective or metric contracts',
        )
      if (evidence) {
        const value = artifact.value as {
          evidence?: { task_id: string }
          spec?: { tasks: Array<{ task_id: string }>; objective_ref: string }
        }
        if (value.spec && value.spec.objective_ref !== canonicalDigest(operatorObjective(spec.objective)))
          throw new GearError(
            'import-objective-mismatch',
            'Imported evidence set has a different comparison objective',
          )
        const ids = value.evidence
          ? [value.evidence.task_id]
          : (value.spec?.tasks.map((task) => task.task_id) ?? [])
        if (!ids.length || ids.some((id) => !spec.seedTasks.some((task) => task.id === id)))
          throw new GearError('import-task-scope', 'Imported evidence must belong to this run seed scope')
      }
      if (ref.kind === 'library') {
        const assets = (artifact.value as { assets?: Record<string, unknown> }).assets ?? {}
        if (
          Object.values(assets).some(
            (ref) => !requests.some((request) => canonicalDigest(request.ref) === canonicalDigest(ref)),
          )
        )
          throw new GearError(
            'import-dependency-required',
            'Import the referenced library assets explicitly with their own purposes',
          )
      }
      imports.artifacts.push(structuredClone(artifact))
      imports.bindings.push(structuredClone(request))
      bytes += Buffer.byteLength(JSON.stringify(artifact))
    }
    if (bytes > 32 * 1024 * 1024)
      throw new GearError('import-too-large', 'Imported material exceeds the frozen byte budget')
  }
  return imports
}

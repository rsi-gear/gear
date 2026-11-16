import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { RunStore } from '../../src/adapters/storage/run-store.js'
import { StoredOperatorEffects } from '../../src/adapters/storage/operator-effects.js'
import { captureOperatorImports } from '../../src/application/operator-imports.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { operatorArtifact } from '../../src/domain/operator-artifacts.js'
import type { RunSpec } from '../../src/domain/run.js'
import type { SourceImport } from '../../src/domain/operator-run.js'
import { authorizeSource } from '../../src/runtime/operator-runtime.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-source-import-'))
  roots.push(root)
  const adapter = new PiHarnessAdapter()
  const runtime = canonicalDigest('runtime')
  const sourceTargets = new TargetStore(join(root, 'runs/source'), adapter, runtime)
  await adapter.prepare(sourceTargets.path('anchor'))
  const manifest = await sourceTargets.seal('anchor', 'fixture')
  const spec: RunSpec = {
    version: 1,
    kind: 'refine',
    benchmarkDigest: canonicalDigest('data'),
    configDigest: canonicalDigest('config'),
    implementationIdentity: canonicalDigest('source'),
    providerIdentity: runtime,
    championRevision: null,
    targetSourceDigest: manifest.digest,
    lineage: null,
    algorithm: {
      name: 'fixture:Recipe',
      options: {},
      protocol_version: 2,
      component: {
        kind: 'module',
        entrypoint: 'fixture:Recipe',
        params: {},
        children: {},
        source_dependencies: [],
        package_dependencies: [],
        resources: [],
        state_schema_version: 1,
      },
    },
    validationMode: 'holdout',
    seed: '0',
    seedTasks: [{ id: 'task', family: 'test', estimated_cost: 1 }],
    heldOutTaskIds: [],
    anchor: { id: 'anchor', digest: manifest.digest, parent_id: null },
    budget: { rounds: 1, maxEvaluations: 10, maxCandidates: 2, repetitions: 1 },
    acceptance: { minimumGain: 0, maxHeldOutRegression: 0 },
    evaluationRepair: { maxRetries: 0, maxProjections: 0, backoffMs: [] },
    generationBudget: { version: 1, total: { model_requests: 10 }, perOperation: { model_requests: 1 } },
    operatorPolicy: {
      version: 2,
      capabilities: [],
      readBudget: { calls: 20, bytes: 1000000 },
      fixedPlan: { name: 'fixed', tasks: [{ task_id: 'task', slots: [0] }] },
    },
  }
  const store = new RunStore(root),
    source = await store.create('source', spec)
  const candidate = { run_id: 'source', candidate_id: 'anchor', digest: manifest.digest }
  const library = operatorArtifact(source, 'library', { data: { lesson: 'frozen knowledge' } }, [])
  const assessment = operatorArtifact(
    source,
    'assessment',
    {
      sample_id: 'old-sample',
      execution_identity: canonicalDigest('old-execution'),
      evidence: { task_id: 'task', score: 1 },
    },
    [candidate],
  )
  source.operators!.artifacts.push(library, assessment)
  await store.write(source)
  const destinationTargets = new TargetStore(join(root, 'runs/destination'), adapter, runtime)
  await adapter.prepare(destinationTargets.path('anchor'))
  await destinationTargets.seal('anchor', 'fixture')
  const capture = (requests: SourceImport[], destination = spec) =>
    captureOperatorImports(root, 'destination', destination, manifest, adapter, requests)
  return {
    root,
    adapter,
    spec,
    store,
    source,
    sourceTargets,
    destinationTargets,
    candidate,
    library,
    assessment,
    capture,
  }
}

it('copies an explicit source candidate and keeps donor reads bound to the admitted copy', async () => {
  const f = await fixture()
  const imports = await f.capture([{ name: 'donor', ref: f.candidate, purpose: 'material' }])
  const spec = structuredClone(f.spec)
  spec.operatorPolicy!.imports = imports.bindings
  for (const imported of imports.candidates)
    expect(
      (await f.destinationTargets.materialize(imported.candidate.id, 'anchor', imported.files)).digest,
    ).toBe(imported.candidate.digest)
  const journal = await f.store.create('destination', spec, [], imports)
  await chmod(join(f.sourceTargets.path('anchor'), 'AGENTS.md'), 0o600)
  await writeFile(join(f.sourceTargets.path('anchor'), 'AGENTS.md'), 'changed after import')
  authorizeSource(journal, f.candidate)
  const [copy] = await new StoredOperatorEffects(f.destinationTargets).materials(journal, [f.candidate])
  expect(copy!.files).toEqual(imports.candidates[0]!.files)
  expect(journal.candidates.map((item) => item.id)).toEqual(['anchor', 'import_donor'])
  expect(() => authorizeSource(journal, { ...f.candidate, digest: canonicalDigest('forged') })).toThrow(
    'Cross-run material requires explicit import',
  )
  await expect(f.capture([{ name: 'new', ref: f.candidate, purpose: 'material' }])).rejects.toBeDefined()
})

it('separates material from scoring authority and binds evidence to data, execution and objective', async () => {
  const f = await fixture()
  await expect(
    f.capture([{ name: 'score', ref: f.assessment.ref, purpose: 'material' }]),
  ).rejects.toMatchObject({ code: 'import-purpose-mismatch' })
  const request: SourceImport = { name: 'score', ref: f.assessment.ref, purpose: 'evidence' }
  const imports = await f.capture([request, { name: 'library', ref: f.library.ref, purpose: 'material' }])
  const spec = structuredClone(f.spec)
  spec.operatorPolicy!.imports = imports.bindings
  const journal = await f.store.create('destination', spec, [], imports)
  authorizeSource(journal, f.assessment.ref)
  expect(journal.operators!.samples).toEqual([])
  expect(journal.seedEvidence).toEqual([])
  expect(() => authorizeSource(journal, f.candidate)).toThrow('Cross-run material requires explicit import')
  for (const key of ['benchmarkDigest', 'providerIdentity'] as const) {
    const changed = { ...f.spec, [key]: canonicalDigest('changed') }
    await expect(f.capture([request], changed)).rejects.toMatchObject({ code: 'import-conditions-mismatch' })
  }
  await expect(
    f.capture([request], { ...f.spec, objectiveIdentity: canonicalDigest('new-metric') }),
  ).rejects.toMatchObject({ code: 'import-objective-mismatch' })
  await expect(
    f.capture([request], { ...f.spec, seedTasks: [{ id: 'other', family: 'test', estimated_cost: 1 }] }),
  ).rejects.toMatchObject({ code: 'import-task-scope' })
})

it('requires every nested library asset and rejects scored or future-task imports into blind streams', async () => {
  const f = await fixture()
  const linked = operatorArtifact(f.source, 'library', { assets: { donor: f.candidate } }, [f.candidate])
  f.source.operators!.artifacts.push(linked)
  await f.store.write(f.source)
  await expect(f.capture([{ name: 'linked', ref: linked.ref, purpose: 'material' }])).rejects.toMatchObject({
    code: 'import-dependency-required',
  })
  const requests: SourceImport[] = [{ name: 'library', ref: f.library.ref, purpose: 'material' }]
  const spec = structuredClone(f.spec)
  spec.operatorPolicy!.access = {
    exposure: 'blind',
    rollout_backend: 'scored_private',
    task_order: null,
    usage_metrics: [],
  }
  await expect(f.capture(requests, spec)).rejects.toMatchObject({ code: 'import-exposure-denied' })
  f.source.spec.operatorPolicy!.access = structuredClone(spec.operatorPolicy!.access)
  f.source.specDigest = canonicalDigest(f.source.spec)
  await f.store.write(f.source)
  spec.operatorPolicy!.access!.task_order = ['first', 'task']
  await expect(f.capture(requests, spec)).rejects.toMatchObject({ code: 'import-future-task-denied' })
  spec.operatorPolicy!.access!.task_order = null
  expect((await f.capture(requests, spec)).artifacts).toEqual([f.library])
})

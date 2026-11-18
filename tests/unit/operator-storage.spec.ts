import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PiHarnessAdapter } from '../../src/adapters/pi/harness.js'
import { TargetStore } from '../../src/adapters/storage/targets.js'
import { StoredOperatorEffects } from '../../src/adapters/storage/operator-effects.js'
import type { OperatorArtifact, OperatorCallEntry, OperatorMaterial } from '../../src/domain/operator-run.js'
import type { RunJournal } from '../../src/domain/run.js'
import type { Call, CandidateRef } from '../../src/domain/algorithm-wire-v2.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { operatorArtifact } from '../../src/domain/operator-artifacts.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const signal = () => new AbortController().signal
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const callEntry = (
  effect: Call['effect'],
  materials: OperatorMaterial[] = [],
  id = 'candidate',
): OperatorCallEntry => {
  const call: Call = {
    key: 'call',
    operator_ref: { entrypoint: 'test:Effect', configuration_digest: canonicalDigest('effect') },
    effect,
    output_schema_ref: { schema: {}, digest: canonicalDigest({}) },
  }
  return {
    id: canonicalDigest(call),
    requestDigest: canonicalDigest(call),
    call,
    status: 'submitted',
    operationIds: [],
    candidateId: id,
    materials,
    reservedReadBytes: 1024 * 1024,
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-operator-storage-'))
  roots.push(root)
  const adapter = new PiHarnessAdapter(),
    targets = new TargetStore(root, adapter, canonicalDigest('runtime'))
  await adapter.prepare(targets.path('anchor'))
  const manifest = await targets.seal('anchor', 'fixture')
  const anchor = { id: 'anchor', parent_id: null, digest: manifest.digest }
  const ref: CandidateRef = { run_id: 'run', candidate_id: 'anchor', digest: anchor.digest }
  const journal = {
    id: 'run',
    candidates: [anchor],
    spec: {},
    operators: { artifacts: [] },
  } as unknown as RunJournal
  const effects = new StoredOperatorEffects(targets)
  const materials = await effects.materials(journal, [ref])
  return { root, targets, effects, journal, ref, materials }
}

it('applies exact edits transactionally and returns sealed content and a real change', async () => {
  const f = await fixture(),
    original = await readFile(join(f.targets.path('anchor'), 'AGENTS.md'), 'utf8')
  const edit = {
    operation: 'replace' as const,
    path: 'AGENTS.md',
    expected_digest: hash(original),
    content: { content: 'Improved\n', encoding: 'utf-8' as const, executable: false },
    blob: null,
    patch: null,
    executable: null,
  }
  const failed = callEntry(
    {
      kind: 'candidate',
      input: {
        mode: 'edits',
        base: f.ref,
        sources: [],
        plan: {
          edits: [edit, { ...edit, path: '.pi/settings.json', expected_digest: hash('wrong original') }],
        },
      },
    },
    f.materials,
  )
  expect((await f.effects.execute(f.journal, failed, signal())).error?.code).toBe('edit-plan-conflict')
  await expect(access(f.targets.path('candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.targets.path('anchor'), 'AGENTS.md'), 'utf8')).toBe(original)
  const result = await f.effects.execute(
    f.journal,
    callEntry(
      { kind: 'candidate', input: { mode: 'edits', base: f.ref, sources: [], plan: { edits: [edit] } } },
      f.materials,
    ),
    signal(),
  )
  expect(result.candidate?.digest).toBe((await f.targets.verify('candidate')).digest)
  expect(result.value).toMatchObject({
    candidate: { run_id: 'run', candidate_id: 'candidate' },
    change: expect.any(Object),
  })
  expect(await readFile(join(f.targets.path('candidate'), 'AGENTS.md'), 'utf8')).toBe('Improved\n')
  expect(await readFile(join(f.targets.path('anchor'), 'AGENTS.md'), 'utf8')).toBe(original)
})

it('recovers the renamed candidate after losing manifest publication and rejects conflicting replay', async () => {
  const f = await fixture(),
    files = structuredClone(f.materials[0]!.files!)
  files['AGENTS.md']!.content = Buffer.from('new rules\n').toString('base64')
  const manifest = await f.targets.materialize('candidate', 'anchor', files)
  await unlink(join(f.root, 'target-manifests/candidate.json'))
  expect(await f.targets.materialize('candidate', 'anchor', files)).toEqual(manifest)
  files['AGENTS.md']!.content = Buffer.from('different rules\n').toString('base64')
  await expect(f.targets.materialize('candidate', 'anchor', files)).rejects.toMatchObject({
    code: 'candidate-construction-conflict',
  })
  expect((await f.targets.verify('candidate')).digest).toBe(manifest.digest)
})

it('does not publish a partial candidate when the harness rejects otherwise exact edits', async () => {
  const f = await fixture(),
    files = structuredClone(f.materials[0]!.files!)
  files['.pi/settings.json']!.content = Buffer.from('{"extensions":["/outside"]}').toString('base64')
  await expect(f.targets.materialize('candidate', 'anchor', files)).rejects.toMatchObject({
    code: 'candidate-harness-rejected',
  })
  await expect(access(f.targets.path('candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(f.targets.verify('anchor')).resolves.toMatchObject({ digest: f.ref.digest })
})

it('binds read cursors to exact material and reports UTF-8 byte completeness without truncation claims', async () => {
  const f = await fixture()
  const entry = callEntry({
    kind: 'read',
    input: { view: 'artifact', ref: f.ref, path: 'AGENTS.md', cursor: null, max_bytes: 3 },
  })
  const first = (await f.effects.execute(f.journal, entry, signal())).value as Record<string, unknown>
  expect(first).toMatchObject({ offset: 0, complete: false, encoding: 'base64' })
  expect(Buffer.from(first.content as string, 'base64')).toHaveLength(3)
  if (entry.call.effect.kind !== 'read' || entry.call.effect.input.view !== 'artifact')
    throw new Error('fixture')
  entry.call.effect.input.cursor = first.cursor as string
  const second = (await f.effects.execute(f.journal, entry, signal())).value as Record<string, unknown>
  expect(second.offset).toBe(3)
  entry.call.effect.input.path = '.pi/settings.json'
  await expect(f.effects.execute(f.journal, entry, signal())).rejects.toMatchObject({
    code: 'invalid-material-cursor',
  })
})

it('pages a frozen history snapshot even after newer events arrive, and separates author claims from facts', async () => {
  const f = await fixture()
  const events = [
    { id: 'generated', kind: 'generated', provenance: 'runtime' },
    { id: 'claimed', kind: 'published', provenance: 'author' },
    { id: 'evaluated', kind: 'evaluated', provenance: 'runtime' },
  ]
  const artifact: OperatorArtifact = {
    ref: { run_id: 'run', kind: 'history', digest: canonicalDigest(events), visibility: 'optimization' },
    value: { events },
    sources: [],
  }
  f.journal.operators!.artifacts.push(artifact)
  const entry = callEntry({
    kind: 'read',
    input: {
      view: 'history',
      snapshot: artifact.ref,
      query: { provenance: 'runtime' },
      cursor: null,
      limit: 1,
    },
  })
  const first = (await f.effects.execute(f.journal, entry, signal())).value as Record<string, unknown>
  expect(first.records).toEqual([events[0]])
  f.journal.operators!.artifacts.push({
    ...artifact,
    ref: { ...artifact.ref, digest: canonicalDigest('new') },
    value: { events: [...events, { id: 'new', kind: 'generated', provenance: 'runtime' }] },
  })
  if (entry.call.effect.kind !== 'read' || entry.call.effect.input.view !== 'history')
    throw new Error('fixture')
  entry.call.effect.input.cursor = first.cursor as string
  const second = (await f.effects.execute(f.journal, entry, signal())).value as Record<string, unknown>
  expect(second.records).toEqual([events[2]])
  expect(second.complete).toBe(true)
  entry.call.effect.input.query = null
  await expect(f.effects.execute(f.journal, entry, signal())).rejects.toMatchObject({
    code: 'invalid-material-cursor',
  })
})

it('binds immutable learning versions to different runnable target files and rejects unsupported or conflicting assets', async () => {
  const f = await fixture()
  const snapshot = (text: string) =>
    operatorArtifact(
      f.journal,
      'library',
      {
        data: {
          kind: 'target-files-v1',
          files: { 'AGENTS.md': { content: text, encoding: 'utf-8', executable: false } },
        },
      },
      [],
    )
  const first = snapshot('first instruction'),
    second = snapshot('second instruction')
  f.journal.operators!.artifacts.push(first, second)
  const a = await f.effects.prepareTarget(f.journal, f.ref, [first.ref])
  const b = await f.effects.prepareTarget(f.journal, f.ref, [second.ref])
  expect(a.id).not.toBe(b.id)
  expect(a.digest).not.toBe(b.digest)
  expect((await f.targets.materialize(a.id, 'anchor', a.files)).digest).toBe(a.digest)
  expect((await f.targets.materialize(b.id, 'anchor', b.files)).digest).toBe(b.digest)
  expect(await readFile(join(f.targets.path(a.id), 'AGENTS.md'), 'utf8')).toBe('first instruction')
  expect(await readFile(join(f.targets.path(b.id), 'AGENTS.md'), 'utf8')).toBe('second instruction')
  await expect(f.effects.prepareTarget(f.journal, f.ref, [first.ref, second.ref])).rejects.toMatchObject({
    code: 'target-asset-conflict',
  })
  const unsupported = operatorArtifact(
    f.journal,
    'library',
    { data: { kind: 'executable-improvement-harness-v1' } },
    [],
  )
  f.journal.operators!.artifacts.push(unsupported)
  await expect(f.effects.prepareTarget(f.journal, f.ref, [unsupported.ref])).rejects.toMatchObject({
    code: 'target-asset-unsupported',
  })
})

it('seals an explicit evidence selection and pages it without incorporating later observations', async () => {
  const f = await fixture()
  const assessments = [0, 1].map((slot) =>
    operatorArtifact(
      f.journal,
      'assessment',
      {
        sample_id: canonicalDigest(['sample', slot]),
        attempt_id: canonicalDigest(['attempt', slot]),
        evidence: {
          candidate_id: 'anchor',
          task_id: 'task',
          repetition: slot,
          status: slot ? 'environment_failed' : 'valid',
          score: slot ? null : 1,
        },
      },
      [f.ref],
    ),
  )
  f.journal.operators!.artifacts.push(...assessments)
  const entry = callEntry({
    kind: 'read',
    input: {
      view: 'evidence',
      limit: 1,
      cursor: null,
      spec: {
        candidate: f.ref,
        assessments: assessments.map((item) => item.ref),
        tasks: [{ task_id: 'task', slots: [0, 1] }],
        task_weights: [['task', 1]],
        objective_ref: canonicalDigest(null),
        reducer_ref: 'mean-v1',
        missing_policy: 'incomplete',
      },
    },
  })
  const first = await f.effects.execute(f.journal, entry, signal())
  expect(first.error).toBeUndefined()
  expect(first.value).toMatchObject({ offset: 0, total_records: 2, loaded: false, complete: false })
  if (entry.call.effect.kind !== 'read' || entry.call.effect.input.view !== 'evidence')
    throw new Error('fixture')
  entry.call.effect.input.cursor = (first.value as { cursor: string }).cursor
  const second = await f.effects.execute(f.journal, entry, signal())
  expect(second.value).toMatchObject({
    offset: 1,
    complete: true,
    records: [{ score: null, status: 'environment_failed' }],
  })
  expect(second.artifacts).toEqual(first.artifacts)
  entry.call.effect.input.spec.task_weights = [['task', 0.5]]
  await expect(f.effects.execute(f.journal, entry, signal())).rejects.toMatchObject({
    code: 'invalid-material-cursor',
  })
})

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { builtinPolicy, builtinPolicyImplementationDigest } from '../../src/adapters/python/builtin-policy.js'
import { ExperienceStore } from '../../src/adapters/storage/experience.js'
import {
  ExperienceFiles,
  MAX_EXPERIENCE_INDEX_BYTES,
  MAX_EXPERIENCE_ITEM_BYTES,
  MAX_EXPERIENCE_OBJECT_BYTES,
} from '../../src/adapters/storage/experience-files.js'
import { ProjectExperience } from '../../src/application/experience.js'
import type { TargetStore } from '../../src/adapters/storage/targets.js'
import type { Json } from '../../src/domain/algorithm-wire.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type {
  ExperienceChunk,
  ExperienceDescriptor,
  ExperienceIndexEntry,
  ExperienceIndexSnapshot,
  ExperienceRecord,
  LegacyExperienceSnapshot,
} from '../../src/domain/experience.js'
import type { RunJournal } from '../../src/domain/run.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function logical(id = 'candidate', run = 'run'): ExperienceRecord {
  return builtinPolicy<ExperienceRecord>('experience_record', {
    source: {
      run_id: run,
      benchmark_digest: canonicalDigest('benchmark'),
      evaluation_identity: canonicalDigest('evaluation'),
      objective_identity: canonicalDigest('objective'),
      objective_digest: canonicalDigest(null),
      generation_operation_id: canonicalDigest(id),
      evidence_digest: canonicalDigest(id),
    },
    candidate: { id, parent_id: 'anchor', digest: canonicalDigest(id) },
    parent: { id: 'anchor', parent_id: null, digest: canonicalDigest('anchor') },
    task_ids: ['seed-a', 'seed-b'],
    repetitions: 1,
    objective: null,
    evidence: ['anchor', id].flatMap((candidate_id) =>
      ['seed-a', 'seed-b'].map((task_id) => ({
        candidate_id,
        task_id,
        repetition: 0,
        status: 'valid',
        score: candidate_id === id ? 0 : 1,
      })),
    ),
    proposal: { hypothesis: 'Formatting 测试', rationale: 'Keep exact output', semantic_targets: ['format'] },
    change: { files: [{ path: 'AGENTS.md', change: 'modified', patch: '-old\n+测试🙂\n' }] },
  })
}
function indexed(records: ExperienceIndexEntry[], revision = 'first'): ExperienceIndexSnapshot {
  const body = {
    version: 3 as const,
    run_id: 'run',
    source_archive_digest: canonicalDigest(revision),
    implementation_identity: builtinPolicyImplementationDigest,
    records,
  }
  return { ...body, digest: canonicalDigest(body) }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gear-experience-storage-'))
  roots.push(root)
  const runRoot = join(root, 'run'),
    store = new ExperienceStore(join(runRoot, 'experience'))
  const originals = [logical('a'), logical('b')],
    entries = []
  for (const original of originals) entries.push(await store.persistRecord(original))
  const snapshot = indexed(entries)
  await store.save(snapshot)
  const application = new ProjectExperience(runRoot, null as unknown as TargetStore)
  const journal = { id: 'run', spec: { seedTasks: ['seed-a', 'seed-b'].map((id) => ({ id })) } } as RunJournal
  return { root, store, originals, entries, snapshot, application, journal }
}
async function gateway(path: string, request: Record<string, unknown>) {
  const sources = new URL('../../python', import.meta.url).pathname
  const bootstrap = `import sys;sys.path.insert(0,${JSON.stringify(sources)});from gear.experience import main;raise SystemExit(main())`
  return await new Promise<{ code: number; value: Record<string, unknown> }>((resolve, reject) => {
    const child = execFile(
      process.env.GEAR_PYTHON ?? 'python3',
      ['-I', '-B', '-c', bootstrap, path],
      { maxBuffer: 65536, encoding: 'utf8' },
      (error, stdout) => {
        if (error && typeof error.code !== 'number') {
          reject(error)
          return
        }
        try {
          resolve({ code: error ? Number(error.code) : 0, value: JSON.parse(stdout) })
        } catch {
          reject(new Error(stdout))
        }
      },
    )
    child.stdin!.end(JSON.stringify(request))
  })
}
const ref = (record: { digest: string }) => 'experience:' + record.digest.slice(7)
const snapshotPath = (store: ExperienceStore, snapshot: { digest: string }) =>
  join(store.root, snapshot.digest.slice(7) + '.json')
const objectPath = (store: ExperienceStore, digest: string) =>
  join(store.root, 'objects', digest.slice(7) + '.json')

it('keeps legacy v2 record refs, pages and cursor bindings without migrating the frozen bytes', async () => {
  const { store, originals, application, journal } = await fixture()
  const body = {
    version: 2 as const,
    run_id: 'run',
    source_archive_digest: canonicalDigest('legacy'),
    implementation_identity: builtinPolicyImplementationDigest,
    records: originals,
  }
  const snapshot: LegacyExperienceSnapshot = { ...body, digest: canonicalDigest(body) }
  await store.save(snapshot)
  const path = snapshotPath(store, snapshot),
    bytes = await readFile(path)
  const input = { snapshot_digest: snapshot.digest, ref: ref(originals[0]!), view: 'verifier', limit: 1 }
  const expected = builtinPolicy<Record<string, Json>>('experience_read', { ...input, records: originals })
  expect(await application.access(journal, input)).toEqual(expected)
  const first = await gateway(path, { action: 'read', ref: input.ref, view: input.view, limit: 1 })
  expect(first).toEqual({ code: 0, value: expected })
  const second = await gateway(path, {
    action: 'read',
    ref: input.ref,
    view: input.view,
    limit: 1,
    cursor: expected.next_cursor,
  })
  expect(second.value.items).not.toEqual(first.value.items)
  expect(
    await gateway(path, { action: 'read', ref: input.ref, view: 'diff', cursor: expected.next_cursor }),
  ).toMatchObject({ code: 1, value: { error: expect.stringContaining('different snapshot or query') } })
  expect(await store.read(snapshot.digest)).toEqual(snapshot)
  expect(await readFile(path)).toEqual(bytes)
  const oldBody = { ...body, implementation_identity: canonicalDigest('old-sources') },
    old = { ...oldBody, digest: canonicalDigest(oldBody) }
  await store.save(old)
  await expect(application.access(journal, { snapshot_digest: old.digest })).rejects.toMatchObject({
    code: 'experience-implementation-mismatch',
  })
})

it('reads historical v2 records with omitted optional metadata while enforcing explicit and v3 run ownership', async () => {
  const { store, application, journal, entries } = await fixture()
  const { digest: _recordDigest, verifier_trials: _verifier, ...historicalBody } = logical('historical')
  // Historical v2 accepted these empty mappings and records predating the verifier view.
  const recordBody = { ...historicalBody, source: {}, proposal: {} }
  const record = { ...recordBody, digest: canonicalDigest(recordBody) }
  const body = {
    version: 2 as const,
    run_id: 'run',
    source_archive_digest: canonicalDigest('historical'),
    implementation_identity: builtinPolicyImplementationDigest,
    records: [record],
  }
  const snapshot = { ...body, digest: canonicalDigest(body) },
    path = snapshotPath(store, snapshot)
  await writeFile(path, JSON.stringify(snapshot))
  const original = await readFile(path)
  expect(await store.read(snapshot.digest)).toEqual(snapshot)
  expect(await application.access(journal, { snapshot_digest: snapshot.digest })).toMatchObject({
    total: 1,
    items: [{ card: { ref: ref(record), rationale: '', hypothesis: '' } }],
  })
  const first = await gateway(path, { action: 'read', ref: ref(record), view: 'task-results', limit: 1 })
  expect(first).toMatchObject({ code: 0, value: { total: 2, items: [{ task_id: 'seed-a' }] } })
  expect(
    await gateway(path, {
      action: 'read',
      ref: ref(record),
      view: 'task-results',
      limit: 1,
      cursor: first.value.next_cursor,
    }),
  ).toMatchObject({ code: 0, value: { items: [{ task_id: 'seed-b' }] } })
  await store.save(await store.read(snapshot.digest))
  expect(await readFile(path)).toEqual(original)
  for (const run_id of ['another-run', null]) {
    const contradictoryBody = { ...recordBody, source: { run_id } }
    const contradictory = { ...contradictoryBody, digest: canonicalDigest(contradictoryBody) }
    const invalidBody = { ...body, records: [contradictory] },
      invalid = { ...invalidBody, digest: canonicalDigest(invalidBody) }
    const invalidPath = snapshotPath(store, invalid)
    await writeFile(invalidPath, JSON.stringify(invalid))
    await expect(store.read(invalid.digest)).rejects.toMatchObject({ code: 'experience-identity-mismatch' })
    expect(await gateway(invalidPath, { action: 'query' })).toMatchObject({ code: 1 })
  }
  const indexedEntry = structuredClone(entries[0]!)
  delete indexedEntry.source.run_id
  const { summary_digest: _summary, descriptor_digest: _descriptor, ...summary } = indexedEntry
  indexedEntry.summary_digest = canonicalDigest(summary)
  const invalidIndex = indexed([indexedEntry], 'missing-index-owner'),
    invalidPath = snapshotPath(store, invalidIndex)
  await writeFile(invalidPath, JSON.stringify(invalidIndex))
  await expect(store.read(invalidIndex.digest)).rejects.toMatchObject({
    code: 'experience-identity-mismatch',
  })
  expect(await gateway(invalidPath, { action: 'query' })).toMatchObject({ code: 1 })
})

it('publishes dependencies before the index, retries idempotently and rejects immutable replacement', async () => {
  const { store, snapshot, entries } = await fixture()
  const descriptor = await store.descriptor(snapshot, entries[0]!),
    dependency = descriptor.views.verifier[0]!
  const path = objectPath(store, dependency.digest),
    original = await readFile(path)
  const next = indexed(entries, 'next')
  await rm(path)
  await expect(store.save(next)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(snapshotPath(store, next))).rejects.toMatchObject({ code: 'ENOENT' })
  await store.persistRecord(logical('a'))
  expect(await readFile(path)).toEqual(original)
  await store.save(next)
  const info = await lstat(snapshotPath(store, next))
  await store.save(next)
  expect((await lstat(snapshotPath(store, next))).mtimeMs).toBe(info.mtimeMs)
  await writeFile(path, '{}')
  await expect(store.persistRecord(logical('a'))).rejects.toMatchObject({
    code: 'experience-identity-mismatch',
  })
})

it('recovers the exact link publication crash window and still refuses an external hardlink', async () => {
  const { store, snapshot } = await fixture()
  const path = snapshotPath(store, snapshot),
    temporary = path + '.' + randomUUID() + '.tmp'
  await link(path, temporary)
  await expect(store.read(snapshot.digest)).rejects.toMatchObject({ code: 'experience-file-invalid' })
  await store.save(snapshot)
  expect((await lstat(path)).nlink).toBe(1)
  await expect(lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await store.read(snapshot.digest)).toEqual(snapshot)
  await rm(path)
  await Promise.all([store.save(snapshot), store.save(snapshot)])
  expect((await lstat(path)).nlink).toBe(1)
  await link(path, path + '.external')
  await expect(store.save(snapshot)).rejects.toMatchObject({ code: 'experience-file-invalid' })
  await expect(store.read(snapshot.digest)).rejects.toMatchObject({ code: 'experience-file-invalid' })
})

it('queries only the index and reads only the requested record/view even with a missing unrelated blob', async () => {
  const { store, snapshot, entries, application, journal } = await fixture()
  const descriptor = await store.descriptor(snapshot, entries[0]!)
  await rm(objectPath(store, descriptor.views.verifier[0]!.digest))
  const path = snapshotPath(store, snapshot)
  expect(await application.access(journal, { snapshot_digest: snapshot.digest })).toMatchObject({ total: 2 })
  expect(await gateway(path, { action: 'query' })).toMatchObject({ code: 0, value: { total: 2 } })
  expect(
    await gateway(path, { action: 'read', ref: ref(entries[1]!), view: 'task-results', limit: 1 }),
  ).toMatchObject({ code: 0, value: { total: 2 } })
  expect(
    await gateway(path, { action: 'read', ref: ref(entries[0]!), view: 'verifier', limit: 1 }),
  ).toMatchObject({ code: 1 })
  await expect(store.copyClosure(snapshot, join(store.root, 'staged'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('binds indexed read cursors to snapshot, record and view and rejects file-like refs', async () => {
  const { store, snapshot, entries } = await fixture(),
    path = snapshotPath(store, snapshot)
  const input = { action: 'read', ref: ref(entries[0]!), view: 'task-results', limit: 1 }
  const first = await gateway(path, input),
    cursor = first.value.next_cursor
  expect(first).toMatchObject({ code: 0, value: { total: 2 } })
  for (const change of [{ ref: ref(entries[1]!) }, { view: 'verifier' }])
    expect(await gateway(path, { ...input, ...change, cursor })).toMatchObject({
      code: 1,
      value: { error: expect.stringContaining('different snapshot or query') },
    })
  const next = indexed(entries, 'next')
  await store.save(next)
  expect(await gateway(snapshotPath(store, next), { ...input, cursor })).toMatchObject({ code: 1 })
  expect(await gateway(path, { ...input, ref: '../private.json' })).toMatchObject({
    code: 1,
    value: { error: expect.stringContaining('outside the frozen snapshot') },
  })
})

it('rejects tampered, wrong-owner and held-out chunks in TS and the real Python gateway', async () => {
  const { store, snapshot, entries } = await fixture(),
    entry = entries[0]!
  const descriptor = await store.descriptor(snapshot, entry),
    pointer = descriptor.views.verifier[0]!
  const original = JSON.parse(await readFile(objectPath(store, pointer.digest), 'utf8')) as ExperienceChunk
  for (const field of ['task_id', 'candidate_id', 'evaluation_identity', 'run_id']) {
    const chunk = structuredClone(original)
    if (field === 'evaluation_identity' || field === 'run_id')
      chunk.owner[field] = canonicalDigest('different-evaluation')
    else {
      ;(chunk.items[0] as Record<string, Json>)[field] = field === 'task_id' ? 'HELD_OUT' : 'other-candidate'
      chunk.owner[field] = (chunk.items[0] as Record<string, Json>)[field]!
    }
    const { digest: _digest, ...chunkBody } = chunk
    chunk.digest = canonicalDigest(chunkBody)
    await writeFile(objectPath(store, chunk.digest), JSON.stringify(chunk))
    const changedDescriptor: ExperienceDescriptor = structuredClone(descriptor)
    changedDescriptor.views.verifier[0] = { ...pointer, digest: chunk.digest }
    const { digest: _descriptorDigest, ...descriptorBody } = changedDescriptor
    changedDescriptor.digest = canonicalDigest(descriptorBody)
    await writeFile(objectPath(store, changedDescriptor.digest), JSON.stringify(changedDescriptor))
    const changed = indexed([{ ...entry, descriptor_digest: changedDescriptor.digest }], field)
    await writeFile(snapshotPath(store, changed), JSON.stringify(changed))
    await expect(store.readItems(changed, changed.records[0]!, 'verifier', 0, 1)).rejects.toMatchObject({
      code: 'experience-identity-mismatch',
    })
    expect(
      await gateway(snapshotPath(store, changed), {
        action: 'read',
        ref: ref(entry),
        view: 'verifier',
        limit: 1,
      }),
    ).toMatchObject({ code: 1 })
  }
  await writeFile(objectPath(store, pointer.digest), JSON.stringify({ ...original, owner: {} }))
  await expect(store.readItems(snapshot, entry, 'verifier', 0, 1)).rejects.toMatchObject({
    code: 'experience-identity-mismatch',
  })
})

it('rejects symlinked stores/directories, hardlinks and oversized files before reading their contents', async () => {
  const { root, store, snapshot, entries } = await fixture(),
    entry = entries[0]!
  const descriptor = await store.descriptor(snapshot, entry),
    pointer = descriptor.views.verifier[0]!,
    path = objectPath(store, pointer.digest)
  const raw = await readFile(path)
  await rm(path)
  await writeFile(path + '.other', raw)
  await symlink(path + '.other', path)
  await expect(store.readItems(snapshot, entry, 'verifier', 0, 1)).rejects.toThrow()
  expect(
    await gateway(snapshotPath(store, snapshot), {
      action: 'read',
      ref: ref(entry),
      view: 'verifier',
      limit: 1,
    }),
  ).toMatchObject({ code: 1 })
  await rm(path)
  await writeFile(path, raw)
  await link(path, path + '.hardlink')
  await expect(store.readItems(snapshot, entry, 'verifier', 0, 1)).rejects.toThrow()
  expect(
    await gateway(snapshotPath(store, snapshot), {
      action: 'read',
      ref: ref(entry),
      view: 'verifier',
      limit: 1,
    }),
  ).toMatchObject({ code: 1 })
  await rm(path + '.hardlink')
  await rm(path)
  await mkdir(path)
  await expect(store.readItems(snapshot, entry, 'verifier', 0, 1)).rejects.toMatchObject({
    code: 'experience-file-invalid',
  })
  expect(
    await gateway(snapshotPath(store, snapshot), {
      action: 'read',
      ref: ref(entry),
      view: 'verifier',
      limit: 1,
    }),
  ).toMatchObject({ code: 1 })
  await rm(path, { recursive: true })
  await writeFile(path, Buffer.alloc(MAX_EXPERIENCE_OBJECT_BYTES + 1))
  await expect(store.readItems(snapshot, entry, 'verifier', 0, 1)).rejects.toMatchObject({
    code: 'experience-file-invalid',
  })
  expect(
    await gateway(snapshotPath(store, snapshot), {
      action: 'read',
      ref: ref(entry),
      view: 'verifier',
      limit: 1,
    }),
  ).toMatchObject({ code: 1 })
  await rm(join(store.root, 'objects'), { recursive: true })
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(store.root, 'objects'))
  await expect(store.descriptor(snapshot, entry)).rejects.toMatchObject({ code: 'experience-file-invalid' })
  const linked = join(root, 'linked')
  await symlink(store.root, linked)
  await expect(new ExperienceStore(linked).read(snapshot.digest)).rejects.toMatchObject({
    code: 'experience-file-invalid',
  })
})

it('fails oversized individual items and indexes explicitly without publishing an incomplete snapshot', async () => {
  const { store, snapshot } = await fixture()
  const record = logical('oversized')
  record.task_results[0] = { task_id: 'seed-a', data: 'x'.repeat(MAX_EXPERIENCE_ITEM_BYTES) }
  const { digest: _digest, ...body } = record
  record.digest = canonicalDigest(body)
  await expect(store.persistRecord(record)).rejects.toMatchObject({ code: 'experience-size-limit' })
  const huge = { ...snapshot, source_archive_digest: 'x'.repeat(MAX_EXPERIENCE_INDEX_BYTES) }
  await expect(
    new ExperienceFiles(store.root).publish(huge, MAX_EXPERIENCE_INDEX_BYTES),
  ).rejects.toMatchObject({ code: 'experience-size-limit' })
})

it('enforces actual v3 index file bytes and rejects cross-run and held-out index access', async () => {
  const { store, snapshot, entries, application, journal } = await fixture()
  await expect(
    application.access({ ...journal, id: 'another-run' }, { snapshot_digest: snapshot.digest }),
  ).rejects.toMatchObject({ code: 'experience-implementation-mismatch' })
  const entry = structuredClone(entries[0]!)
  entry.scope.task_ids.push('HELD_OUT')
  const { summary_digest: _summary, descriptor_digest: _descriptor, ...summaryBody } = entry
  entry.summary_digest = canonicalDigest(summaryBody)
  const heldOut = indexed([entry], 'held-out')
  await writeFile(snapshotPath(store, heldOut), JSON.stringify(heldOut))
  await expect(application.access(journal, { snapshot_digest: heldOut.digest })).rejects.toMatchObject({
    code: 'experience-implementation-mismatch',
  })
  const path = snapshotPath(store, snapshot),
    raw = await readFile(path)
  await writeFile(path, Buffer.concat([raw, Buffer.alloc(MAX_EXPERIENCE_INDEX_BYTES - raw.length + 1, 0x20)]))
  await expect(store.read(snapshot.digest)).rejects.toMatchObject({ code: 'experience-size-limit' })
  expect(await gateway(path, { action: 'query' })).toMatchObject({
    code: 1,
    value: { error: expect.stringContaining('index exceeds 4 MiB') },
  })
  await expect(store.read('sha256:../../private')).rejects.toMatchObject({
    code: 'invalid-experience-digest',
  })
})

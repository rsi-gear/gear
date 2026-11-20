import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { stageExperience } from '../../src/adapters/codex/experience.js'
import type { CodexJob } from '../../src/adapters/codex/contracts.js'
import { builtinPolicy } from '../../src/adapters/python/builtin-policy.js'
import { pythonObjective } from '../../src/adapters/python/objective.js'
import { ExperienceStore, MAX_EXPERIENCE_BYTES } from '../../src/adapters/storage/experience.js'
import { MAX_EXPERIENCE_OBJECT_BYTES } from '../../src/adapters/storage/experience-files.js'
import { exportRun } from '../../src/application/export.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import type { Json } from '../../src/domain/algorithm-wire.js'
import type {
  ExperienceContext,
  ExperienceDescriptor,
  ExperienceIndexSnapshot,
  ExperienceRecord,
  ExperienceView,
} from '../../src/domain/experience.js'
import { experienceViews } from '../../src/domain/experience.js'
import {
  capacityScores,
  experienceCapacityFixture,
  experienceFiles,
  jsonObject,
} from '../helpers/experience-capacity.js'

interface Page {
  snapshot_digest: string
  items: Json[]
  next_cursor: string | null
  total: number
  summary?: Json
  availability?: string
}
interface ReadPage {
  request: Record<string, unknown>
  page: Page
}
const roots: string[] = []
const asPage = (value: unknown): Page => value as Page
const ref = (record: ExperienceRecord | ExperienceIndexSnapshot['records'][number]) =>
  'experience:' + record.digest.slice(7)
const objectPath = (root: string, digest: string) => join(root, 'objects', digest.slice(7) + '.json')
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Exercise the staged argv and stdin contract using a real isolated Python process. */
async function pythonRead(argv: string[], request: Record<string, unknown>): Promise<Page> {
  return new Promise((resolve, reject) => {
    const child = execFile(argv[0]!, argv.slice(1), { maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stdout + stderr).trim() || error.message))
        return
      }
      try {
        expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(64 * 1024)
        resolve(JSON.parse(stdout) as Page)
      } catch (failure) {
        reject(failure)
      }
    })
    const { snapshot_digest: _snapshotDigest, ...gatewayRequest } = request
    child.stdin!.end(JSON.stringify(gatewayRequest))
  })
}

async function collectPages(
  request: Record<string, unknown>,
  expected: Json[],
  read: (request: Record<string, unknown>) => Promise<Page>,
): Promise<ReadPage[]> {
  const pages: ReadPage[] = []
  const items: Json[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const nextRequest: Record<string, unknown> = { ...request, ...(cursor ? { cursor } : {}) }
    const page = await read(nextRequest)
    expect(page.total).toBe(expected.length)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024)
    expect(page.snapshot_digest).toBe(request.snapshot_digest)
    if (page.next_cursor !== null) {
      expect(page.items.length).toBeGreaterThan(0)
      expect(cursors.has(page.next_cursor)).toBe(false)
      cursors.add(page.next_cursor)
    }
    pages.push({ request: nextRequest, page })
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor !== null)
  expect(items).toEqual(expected)
  return pages
}

function expectedItems(record: ExperienceRecord, view: ExperienceView, snapshotDigest: string): Json[] {
  if (view === 'task-results') return record.task_results
  if (view === 'verifier') return record.verifier_trials
  if (view === 'trajectory') return record.trajectory_refs as unknown as Json[]
  if (view === 'modification-use') return jsonObject(record.modification_use).trials as Json[]
  const page = builtinPolicy<Page>('experience_read', {
    records: [record],
    snapshot_digest: snapshotDigest,
    ref: ref(record),
    view,
    limit: 50,
  })
  expect(page.next_cursor).toBeNull()
  return page.items
}

it.each([8, 12] as const)(
  'captures, stages and independently exports 100 tasks × %i candidate outcomes beyond the old aggregate cap',
  async (candidateCount) => {
    const root = await mkdtemp(join(tmpdir(), 'gear-experience-capacity-'))
    roots.push(root)
    const fixture = await experienceCapacityFixture(root, candidateCount)
    const { experience, journal, store, targets, meta, runRoot, expectedScores } = fixture
    const evidenceDigest = canonicalDigest(journal.seedEvidence)
    const scoresBefore = capacityScores(journal.seedEvidence, journal.candidates)
    expect(scoresBefore).toEqual(expectedScores)
    expect(
      journal.seedEvidence.every((cell) => Buffer.byteLength(JSON.stringify(cell.verifier)) === 16 * 1024),
    ).toBe(true)

    // Observe the logical v2 policy output while retaining the actual immutable persistence path.
    const logicalRecords: ExperienceRecord[] = []
    const persistRecord = experience.store.persistRecord.bind(experience.store)
    const persistence = vi.spyOn(experience.store, 'persistRecord').mockImplementation(async (record) => {
      logicalRecords.push(structuredClone(record))
      return persistRecord(record)
    })
    const snapshot = await experience.capture(journal)
    persistence.mockRestore()
    expect(snapshot.version).toBe(3)
    expect(snapshot.records).toHaveLength(candidateCount)
    expect(logicalRecords).toHaveLength(candidateCount)
    const descriptors: ExperienceDescriptor[] = []
    for (const [index, record] of logicalRecords.entries()) {
      const { digest, ...body } = record
      expect(canonicalDigest(body)).toBe(digest)
      expect(snapshot.records[index]!.digest).toBe(digest)
      expect(snapshot.records[index]!.candidate).toEqual(record.candidate)
      expect(record.classification).toMatchObject({
        effect: 'improved',
        complete: true,
        improved_tasks: (index + 1) * 3,
        regressed_tasks: 0,
        unavailable_tasks: 0,
      })
      expect(record.scope.task_ids).toHaveLength(100)
      expect(record.verifier_trials).toHaveLength(200)
      descriptors.push(await experience.store.descriptor(snapshot, snapshot.records[index]!))
    }

    const legacyBody = { ...snapshot, version: 2 as const, records: logicalRecords }
    const { digest: _indexDigest, ...legacyWithoutDigest } = legacyBody
    const legacySnapshot = { ...legacyWithoutDigest, digest: canonicalDigest(legacyWithoutDigest) }
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacySnapshot))
    const verifierRefs = descriptors.flatMap((descriptor) => descriptor.views.verifier)
    const uniqueVerifierRefs = new Set(verifierRefs.map((reference) => reference.digest))
    const frequencies = new Map<string, number>()
    for (const reference of verifierRefs)
      frequencies.set(reference.digest, (frequencies.get(reference.digest) ?? 0) + 1)
    expect(verifierRefs).toHaveLength(candidateCount * 200)
    expect(verifierRefs.every((reference) => reference.count === 1)).toBe(true)
    expect(uniqueVerifierRefs.size).toBe((candidateCount + 1) * 100)
    expect([...frequencies.values()].filter((count) => count === candidateCount)).toHaveLength(100)
    expect([...frequencies.values()].filter((count) => count === 1)).toHaveLength(candidateCount * 100)
    const files = await experienceFiles(experience.store.root)
    const indexBytes = files.find((file) => file.path === snapshot.digest.slice(7) + '.json')!.bytes
    const detailFiles = files.filter((file) => file.path.startsWith('objects/'))
    const detailBytes = detailFiles.reduce((sum, file) => sum + file.bytes, 0)
    const closure = await experience.store.verifyClosure(snapshot)
    expect(legacyBytes).toBeGreaterThan(MAX_EXPERIENCE_BYTES)
    expect(detailBytes).toBeGreaterThan(MAX_EXPERIENCE_BYTES)
    expect(indexBytes).toBeLessThan(128 * 1024)
    expect(
      detailFiles.every(
        (file) =>
          file.bytes <= MAX_EXPERIENCE_OBJECT_BYTES ||
          descriptors.some((descriptor) => file.path === `objects/${descriptor.digest.slice(7)}.json`),
      ),
    ).toBe(true)
    expect(closure).toEqual({ files: files.length, bytes: indexBytes + detailBytes })
    console.info(
      'experience-capacity',
      JSON.stringify({
        tasks: 100,
        candidates: candidateCount,
        legacy_bytes: legacyBytes,
        index_bytes: indexBytes,
        unique_detail_bytes: detailBytes,
        detail_files: detailFiles.length,
        verifier_occurrences: verifierRefs.length,
        unique_verifier_objects: uniqueVerifierRefs.size,
        shared_anchor_objects: 100,
      }),
    )

    // Real capture still runs; reset the read spy only at its boundary to isolate card preparation.
    const capture = experience.capture.bind(experience)
    const reads = vi.spyOn(experience.store.files, 'read')
    const captureBoundary = vi.spyOn(experience, 'capture').mockImplementation(async (...args) => {
      const captured = await capture(...args)
      reads.mockClear()
      return captured
    })
    meta.experience = await experience.prepare(journal, meta)
    expect(meta.experience.snapshot_digest).toBe(snapshot.digest)
    expect(reads).not.toHaveBeenCalled()
    captureBoundary.mockRestore()
    const legacyContext = builtinPolicy<Omit<ExperienceContext, 'digest' | 'implementation_identity'>>(
      'experience_context',
      {
        records: logicalRecords,
        snapshot_digest: snapshot.digest,
        parent_id: meta.operation.candidate_id,
        evidence: meta.evidence,
        semantic_targets: ['formatting'],
      },
    )
    const contextBody = { ...legacyContext, implementation_identity: snapshot.implementation_identity }
    expect(meta.experience).toEqual({ ...contextBody, digest: canonicalDigest(contextBody) })
    expect(Buffer.byteLength(JSON.stringify(meta.experience.cards))).toBeLessThanOrEqual(12 * 1024)

    const access = async (params: Record<string, unknown>) => asPage(await experience.access(journal, params))
    const query = { snapshot_digest: snapshot.digest, limit: 10, parent_id: meta.operation.candidate_id }
    const queries = [
      query,
      {
        ...query,
        query: {
          query: 'formatting',
          paths: ['AGENTS.md'],
          semantic_targets: ['formatting'],
          effects: ['improved'],
          task_ids: ['task-99'],
        },
      },
      { ...query, query: { paths: ['unmodified.txt'] } },
    ]
    for (const request of queries) {
      reads.mockClear()
      const actual = await access(request)
      expect(actual).toEqual(builtinPolicy('experience_query', { ...request, records: logicalRecords }))
      expect(reads.mock.calls.some(([digest]) => uniqueVerifierRefs.has(digest))).toBe(false)
      if (actual.next_cursor) {
        const next = { ...request, cursor: actual.next_cursor }
        expect(await access(next)).toEqual(
          builtinPolicy('experience_query', { ...next, records: logicalRecords }),
        )
        await expect(access({ ...next, query: { paths: ['changed-query'] } })).rejects.toThrow(/cursor/u)
      }
    }
    const baselineQuery = await access(query)
    const brokenRecord = snapshot.records[1]!
    const goodRecord = snapshot.records[0]!
    reads.mockClear()
    await access({ ...query, ref: ref(brokenRecord), view: 'card' })
    expect(reads.mock.calls.some(([digest]) => uniqueVerifierRefs.has(digest))).toBe(false)
    reads.mockRestore()
    const brokenTrial = logicalRecords[1]!.verifier_trials.find(
      (item) => jsonObject(item).candidate_id === brokenRecord.candidate.id,
    )!
    let affectedRead: ReadPage | undefined
    let unrelatedRead: ReadPage | undefined
    let readCursor: ReadPage | undefined
    for (const [index, record] of logicalRecords.entries()) {
      for (const view of experienceViews) {
        const expected = expectedItems(record, view, snapshot.digest)
        const request = {
          snapshot_digest: snapshot.digest,
          ref: ref(record),
          view,
          limit: view === 'verifier' ? 3 : 50,
        }
        const pages = await collectPages(request, expected, access)
        if (index === 0 && view === 'verifier')
          expect(await access({ ...request, limit: 50 })).toEqual(pages[0]!.page)
        for (const { page } of pages) {
          if (view === 'modification-use')
            expect(page.summary).toEqual(jsonObject(record.modification_use).summary)
          if (view === 'trajectory') expect(page.availability).toBe('unavailable')
          for (const item of page.items) {
            const value = jsonObject(item)
            if (view === 'diff') expect(value.path).toBe('AGENTS.md')
            else expect(record.scope.task_ids).toContain(value.task_id)
            if (view === 'verifier' || view === 'trajectory')
              expect([record.parent.id, record.candidate.id]).toContain(value.candidate_id)
          }
        }
        if (view === 'verifier') {
          readCursor ??= pages.find((page) => typeof page.request.cursor === 'string')
          if (index === 1)
            affectedRead = pages.find(({ page }) =>
              page.items.some((item) => canonicalDigest(item) === canonicalDigest(brokenTrial)),
            )
          if (index === 0)
            unrelatedRead = pages.find(({ page }) =>
              page.items.some((item) => jsonObject(item).candidate_id === goodRecord.candidate.id),
            )
        }
      }
    }
    expect(affectedRead).toBeDefined()
    expect(unrelatedRead).toBeDefined()
    expect(readCursor).toBeDefined()
    await expect(access({ ...readCursor!.request, ref: ref(brokenRecord) })).rejects.toThrow(/cursor/u)
    await expect(access({ ...readCursor!.request, view: 'task-results' })).rejects.toThrow(/cursor/u)
    await expect(access({ ...query, ref: 'experience:' + 'e'.repeat(64), view: 'card' })).rejects.toThrow(
      /outside/u,
    )

    // Neither unreferenced experience files nor private research/journals belong in Meta.
    const orphan = { raw: 'PRIVATE_UNREFERENCED_OBJECT' }
    const orphanDigest = canonicalDigest(orphan)
    await writeFile(objectPath(experience.store.root, orphanDigest), JSON.stringify(orphan))
    const sandbox = join(root, 'sandbox')
    await mkdir(sandbox)
    const job = {
      input: {
        context: {
          targets: join(targets.runRoot, 'targets'),
          tasks: journal.spec.seedTasks,
          experiencePython: process.env.GEAR_PYTHON ?? process.env.GEAR_TRAINING_TEST_PYTHON,
        },
        request: meta,
      },
    } as unknown as CodexJob
    const staged = await stageExperience(job, sandbox)
    const argv = (staged.input as unknown as { reader: { argv: string[] } }).reader.argv
    const stagedRoot = join(sandbox, 'experience')
    const stagedFiles = await experienceFiles(stagedRoot)
    expect(stagedFiles.filter((file) => file.path.startsWith('objects/'))).toEqual(detailFiles)
    expect(
      stagedFiles.every(
        (file) =>
          file.path === 'snapshot.json' ||
          file.path.startsWith('objects/') ||
          file.path.startsWith('sources/'),
      ),
    ).toBe(true)
    for (const file of stagedFiles)
      expect(await readFile(join(stagedRoot, file.path), 'utf8')).not.toMatch(/PRIVATE_|HELD_OUT/u)
    expect(await pythonRead(argv, { action: 'query', ...query })).toEqual(baselineQuery)
    for (const view of experienceViews) {
      const record = logicalRecords[0]!
      await collectPages(
        { action: 'read', snapshot_digest: snapshot.digest, ref: ref(record), view, limit: 50 },
        expectedItems(record, view, snapshot.digest),
        (request) => pythonRead(argv, request),
      )
    }
    await expect(
      pythonRead(argv, { action: 'read', ...readCursor!.request, ref: ref(brokenRecord) }),
    ).rejects.toThrow(/cursor/u)
    await expect(
      pythonRead(argv, { action: 'read', ...readCursor!.request, view: 'task-results' }),
    ).rejects.toThrow(/cursor/u)
    await expect(
      pythonRead(argv, { action: 'read', ref: 'experience:' + 'e'.repeat(64), view: 'verifier' }),
    ).rejects.toThrow(/outside/u)

    // Retain an earlier Meta reservation as well as the completed run's latest index.
    journal.operations.push({
      request: meta,
      status: 'complete',
      reservedAttempts: 0,
      receipt: {
        result: {
          operation_id: meta.operationId,
          kind: 'diagnose_seed',
          candidate_id: meta.operation.candidate_id,
          status: 'complete',
          data: null,
        },
        candidate: null,
        evidence: [],
        physicalAttempts: 0,
        usage: {},
        provenance: null,
      },
    })
    journal.status = 'completed'
    await store.write(journal)
    const exported = await exportRun(root, journal)
    const manifest = JSON.parse(
      await readFile(join(exported.destination, 'experience-snapshots.json'), 'utf8'),
    ) as {
      version: number
      latest_snapshot_digest: string
      snapshot_digests: string[]
    }
    expect(manifest.version).toBe(3)
    expect(manifest.snapshot_digests).toContain(snapshot.digest)
    expect(manifest.snapshot_digests).toContain(manifest.latest_snapshot_digest)
    expect(manifest.snapshot_digests).toHaveLength(2)
    const exportedStore = new ExperienceStore(join(exported.destination, 'experience'))
    expect(await exportedStore.read(snapshot.digest)).toEqual(snapshot)
    const latestExported = await exportedStore.read(manifest.latest_snapshot_digest)
    expect(latestExported.version).toBe(3)
    expect(latestExported.records).toEqual(snapshot.records)
    expect(await exportedStore.verifyClosure(snapshot)).toEqual(closure)

    const brokenChunk = descriptors[1]!.views.verifier.find((reference) => {
      return !descriptors[0]!.views.verifier.some((other) => other.digest === reference.digest)
    })!
    expect(
      JSON.parse(await readFile(objectPath(experience.store.root, brokenChunk.digest), 'utf8')).items,
    ).toContainEqual(brokenTrial)
    await rm(objectPath(experience.store.root, brokenChunk.digest))
    await rm(objectPath(stagedRoot, brokenChunk.digest))
    expect(await access(query)).toEqual(baselineQuery)
    expect(await pythonRead(argv, { action: 'query', ...query })).toEqual(baselineQuery)
    expect((await pythonRead(argv, { action: 'read', ref: ref(brokenRecord), view: 'card' })).total).toBe(1)
    expect(await access(unrelatedRead!.request)).toEqual(unrelatedRead!.page)
    expect(await pythonRead(argv, { action: 'read', ...unrelatedRead!.request })).toEqual(unrelatedRead!.page)
    await expect(access(affectedRead!.request)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(pythonRead(argv, { action: 'read', ...affectedRead!.request })).rejects.toThrow()

    expect(canonicalDigest(journal.seedEvidence)).toBe(evidenceDigest)
    expect(capacityScores(journal.seedEvidence, journal.candidates)).toEqual(scoresBefore)
    const projectedScores = journal.candidates
      .map(
        (candidate) =>
          [
            candidate.id,
            pythonObjective.project({
              evidence: journal.seedEvidence.filter((cell) => cell.candidate_id === candidate.id),
              candidate_id: candidate.id,
              anchor_id: journal.spec.anchor.id,
              task_ids: journal.spec.seedTasks.map((task) => task.id),
              repetitions: 1,
              partition: 'seed',
              objective: null,
            }).score,
          ] as [string, number],
      )
      .sort((a, b) => b[1] - a[1])
    expect(projectedScores).toEqual(expectedScores)

    // The export's sanitized experience closure survives removal of every original journal/source.
    await rm(runRoot, { recursive: true, force: true })
    await expect(readFile(join(runRoot, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const independentSnapshot = (await exportedStore.read(snapshot.digest)) as ExperienceIndexSnapshot
    for (const [index, record] of logicalRecords.entries()) {
      for (const view of experienceViews) {
        const expected = expectedItems(record, view, snapshot.digest)
        const items: Json[] = []
        for (let start = 0; start < expected.length; start += 50) {
          items.push(
            ...(await exportedStore.readItems(
              independentSnapshot,
              independentSnapshot.records[index]!,
              view,
              start,
              50,
            )),
          )
        }
        expect(items).toEqual(expected)
      }
    }
    const exportArgv = [...argv.slice(0, -1), join(exportedStore.root, snapshot.digest.slice(7) + '.json')]
    expect(await pythonRead(exportArgv, { action: 'query', ...query })).toEqual(baselineQuery)
    expect(await pythonRead(exportArgv, { action: 'read', ...affectedRead!.request })).toEqual(
      affectedRead!.page,
    )
    expect(await exportedStore.verifyClosure(independentSnapshot)).toEqual(closure)
    await staged.dispose()
  },
  // Durable object writes, staged Python reads and independent exports need CI runtime headroom.
  480_000,
)

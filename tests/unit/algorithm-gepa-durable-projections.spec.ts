import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import {
  createGepaDurableProjectionHost, GEPA_ARCHIVE_VIEW_PROJECTION_SCHEMA,
  GEPA_SCIENCE_PROJECTION_SCHEMA,
} from '../../src/algorithm/providers/gepa-durable-projections.js'
import type { JsonValue } from '../../src/algorithm/schema.js'
import { buildArchive } from '../../src/search/archive.js'
import { seal } from '../../src/search/contracts.js'
import { MemorySearchStore, evaluatedFixture, fixtures, scopeFixture, settings } from '../../src/search/testing.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('replays a committed science projection after a lost journal acknowledgement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-projection-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts')), journal = new MemorySearchStore()
  const parents = seal({ archiveDigest: 'sha256:' + 'a'.repeat(64), batches: [] })
  const input = { roundId: 'r', stage: 'parents', objects: [{ name: 'parents',
    ref: artifacts.putJson(parents as unknown as JsonValue, 'gepa.legacy-journal-object.v1') }],
  supportRefs: [], consumptions: [] }
  const ref = artifacts.putJson(input as unknown as JsonValue, GEPA_SCIENCE_PROJECTION_SCHEMA)
  const create = () => createGepaDurableProjectionHost({ root: join(root, 'records'),
    roundId: 'r', artifacts, journal })
  const freeze = journal.freeze.bind(journal)
  let attempts = 0
  journal.freeze = async (...args) => {
    const saved = await freeze(...args)
    if (++attempts === 1) throw new Error('projection acknowledgement lost')
    return saved
  }
  await expect(create().project(ref)).rejects.toThrow('projection acknowledgement lost')
  expect(await journal.read('rounds/r/parents')).toEqual({ ref: parents.digest })
  await create().project(ref)
  expect(attempts).toBe(1)
  expect(await journal.object(parents.digest)).toEqual(parents)
})

it('projects archive-base and completion queue before parent sampling, with a frozen round scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-projection-')); roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts')), journal = new MemorySearchStore()
  const fixture = fixtures(4), config = settings()
  const { scope, plan, result } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']),
    fixture.anchor, () => ({ outcome: 1 }), { stage: 'baseline-probe' })
  const archive = buildArchive({ evolutionId: 'e', universe: fixture.seed, snapshots: [fixture.anchor],
    scopes: [scope], plans: [plan], results: [result], config: config.search,
    championId: fixture.anchor.candidateId })
  const archiveRef = artifacts.putJson(archive as unknown as JsonValue, 'gepa.research-archive.v1')
  const input = { roundId: 'r', baseArchiveRef: archiveRef, parentArchiveRef: archiveRef,
    completionRefs: [], publishParentView: true }
  const ref = artifacts.putJson(input as unknown as JsonValue, GEPA_ARCHIVE_VIEW_PROJECTION_SCHEMA)
  const host = createGepaDurableProjectionHost({ root: join(root, 'records'), roundId: 'r', artifacts, journal })
  expect(host.describe().schemaIds).toEqual([
    GEPA_ARCHIVE_VIEW_PROJECTION_SCHEMA, GEPA_SCIENCE_PROJECTION_SCHEMA])
  await host.project(ref)
  const basePointer = await journal.read<{ ref: string }>('rounds/r/archive-base')
  const completionsPointer = await journal.read<{ ref: string }>('rounds/r/completions')
  expect(await journal.object(basePointer!.ref)).toMatchObject({ archiveDigest: archive.digest })
  expect(await journal.object(completionsPointer!.ref)).toMatchObject({ refs: [] })
  expect(await journal.read('rounds/r/parent-archive')).toEqual({ ref: archive.digest })
  await host.project(ref)
  const wrongRound = artifacts.putJson({ ...input, roundId: 's' } as unknown as JsonValue,
    GEPA_ARCHIVE_VIEW_PROJECTION_SCHEMA)
  await expect(host.project(wrongRound)).rejects.toThrow('round drift')
})

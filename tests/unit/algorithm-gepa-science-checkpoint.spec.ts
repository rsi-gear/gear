import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaScienceCheckpointProvider, type GepaScienceCheckpointInput } from '../../src/algorithm/providers/gepa-science-checkpoint.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { seal } from '../../src/search/contracts.js'
import { digestJson } from '../../src/state/digest.js'
import { MemorySearchStore } from '../../src/search/testing.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gepa-science-checkpoint-'))
  roots.push(root)
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const journal = new MemorySearchStore()
  const provider = () => new GepaScienceCheckpointProvider(join(root, 'provider'), artifacts, journal)
  const parents = seal({ archiveDigest: jsonDigest('archive'), batches: [] })
  const input: GepaScienceCheckpointInput = { roundId: 'r', stage: 'parents',
    objects: [{ name: 'parents', ref: artifacts.putJson(parents as unknown as JsonValue,
      'gepa.legacy-journal-object.v1') }], supportRefs: [], consumptions: [] }
  const operationId = jsonDigest(['science', input])
  const envelope: OperationEnvelope = { campaignId: 'campaign-r', decisionIndex: 0,
    localKey: 'checkpoint-science-parents', kind: 'gepa.science-checkpoint', operationId,
    idempotencyKey: operationId, input: input as unknown as JsonValue,
    inputDigest: jsonDigest(input as unknown as JsonValue),
    implementationDigest: provider().describe().implementationDigest,
    bindingSetRef: { kind: 'binding-set', digest: jsonDigest('binding'), schemaId: 'fixture-binding' }, limits: {} }
  return { artifacts, journal, provider, parents, input, envelope }
}

describe('GEPA science checkpoint provider', () => {
  it('replays the same frozen pointer after its first acknowledgement is lost', async () => {
    const f = await fixture()
    const freeze = f.journal.freeze.bind(f.journal)
    let writes = 0
    f.journal.freeze = async (...args) => {
      const value = await freeze(...args)
      writes++
      if (writes === 1) throw new Error('lost checkpoint acknowledgement')
      return value
    }
    await expect(f.provider().submit(f.envelope)).rejects.toMatchObject({
      name: 'ProviderReconcileError', cause: new Error('lost checkpoint acknowledgement'),
    })
    expect(await f.journal.read('rounds/r/parents')).toEqual({ ref: f.parents.digest })
    expect((await f.provider().inspect(f.envelope)).status).toBe('replay-safe')
    const completed = await f.provider().submit(f.envelope)
    expect(completed.status).toBe('completed')
    expect(writes).toBe(2)
    expect((await f.provider().inspect(f.envelope)).status).toBe('completed')
    expect(await f.journal.object(f.parents.digest)).toEqual(f.parents)
  })

  it('persists cancel-before-submit without publishing a late science decision', async () => {
    const f = await fixture()
    expect(await f.provider().cancel(f.envelope)).toEqual({ status: 'cancelled', releaseConfirmed: true })
    expect((await f.provider().inspect(f.envelope)).status).toBe('cancelled')
    await expect(f.provider().submit(f.envelope)).rejects.toThrow('Cancelled GEPA science checkpoint')
    expect(await f.journal.read('rounds/r/parents')).toBeUndefined()
  })

  it('publishes decision support and evidence consumption before the local phase pointer', async () => {
    const f = await fixture()
    const support = seal({ generatedDigest: jsonDigest('candidate'), baselineDigest: jsonDigest('baseline') })
    const result = seal({ stagePlanDigest: jsonDigest('plan'), snapshotDigest: jsonDigest('snapshot'), cells: [] })
    const local = seal({ entries: [], reasons: [] })
    const expansion = seal({ skipped: [], exclusions: [] })
    const decisions = seal({ decisions: [{ supportDigest: support.digest }] })
    const input: GepaScienceCheckpointInput = { roundId: 'r', stage: 'local',
      objects: [
        { name: 'local', ref: f.artifacts.putJson(local, 'gepa.legacy-journal-object.v1') },
        { name: 'expansion', ref: f.artifacts.putJson(expansion, 'gepa.legacy-journal-object.v1') },
        { name: 'local-stage-decisions', ref: f.artifacts.putJson(decisions, 'gepa.legacy-journal-object.v1') },
      ], supportRefs: [f.artifacts.putJson(support, 'gepa.legacy-journal-object.v1')],
      consumptions: [{ resultRef: f.artifacts.putJson(result, 'gepa.stage-result.v1'),
        consumerDigest: local.digest }] }
    const envelope: OperationEnvelope = { ...f.envelope, localKey: 'checkpoint-science-local',
      operationId: jsonDigest(['science', input]), idempotencyKey: jsonDigest(['science', input]),
      input: input as unknown as JsonValue, inputDigest: jsonDigest(input as unknown as JsonValue) }
    const consumed = `rounds/r/consumed-${digestJson([result.stagePlanDigest, result.snapshotDigest]).slice(7)}`
    const write = f.journal.write.bind(f.journal)
    let supportWasReadable = false, interrupted = false
    f.journal.write = async (...args) => {
      if (args[0] === 'rounds/r/local' && !interrupted) {
        interrupted = true
        supportWasReadable = (await f.journal.object(support.digest)).digest === support.digest
        throw new Error('local pointer unavailable')
      }
      return write(...args)
    }
    await expect(f.provider().submit(envelope)).rejects.toMatchObject({ name: 'ProviderReconcileError' })
    expect(supportWasReadable).toBe(true)
    expect(await f.journal.read(consumed)).toMatchObject({ ref: expect.any(String) })
    expect(await f.journal.read('rounds/r/local')).toBeUndefined()
    expect((await f.provider().inspect(envelope)).status).toBe('replay-safe')
    expect((await f.provider().submit(envelope)).status).toBe('completed')
    expect(await f.journal.read('rounds/r/local')).toEqual({ ref: local.digest })
    expect(await f.journal.object(support.digest)).toEqual(support)
  })

  it('rejects a stage name outside its closed journal projection before any write', async () => {
    const f = await fixture()
    const badInput = { ...f.input, objects: [{ ...f.input.objects[0]!, name: 'terminal' }] }
    const envelope: OperationEnvelope = { ...f.envelope, input: badInput as unknown as JsonValue,
      inputDigest: jsonDigest(badInput as unknown as JsonValue) }
    await expect(f.provider().preflight(envelope)).rejects.toThrow('stage objects invalid')
    expect(await f.journal.read('rounds/r/terminal')).toBeUndefined()
  })
})

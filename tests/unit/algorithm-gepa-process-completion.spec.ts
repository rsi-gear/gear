import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileArtifactStore } from '../../src/algorithm/artifacts.js'
import { BindingStore } from '../../src/algorithm/bindings.js'
import type { OperationEnvelope } from '../../src/algorithm/contracts.js'
import { GepaProcessCompletionProvider, type GepaProcessCompletionInput } from '../../src/algorithm/providers/gepa-process-completion.js'
import { jsonDigest, type JsonValue } from '../../src/algorithm/schema.js'
import { evaluatedFixture, fixtures, revise, scopeFixture } from '../../src/search/testing.js'
import { digestJson } from '../../src/state/digest.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('only projects an owned cell under its original per-cell key, then seals the physical result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gepa-process-provider-')); roots.push(root)
  const fixture = fixtures(4, true)
  const { result } = evaluatedFixture(fixture.seed, scopeFixture(fixture.seed, ['task-0']), fixture.anchor,
    () => ({ outcome: 0 }), { stage: 'baseline-probe' })
  const base = result.cells[0]!
  const artifacts = new FileArtifactStore(join(root, 'artifacts'))
  const bindings = new BindingStore(artifacts, { id: 'harness', slots: {
    harness: { schemaId: 'harness.directory.v1', required: true, replaceable: true },
  } })
  const harness = artifacts.putJson({ commitOid: fixture.anchor.commit,
    manifestDigest: fixture.anchor.manifestDigest }, 'harness.directory.v1')
  const observedKeys: string[] = []
  fixture.provider.completeProcess = async (cell, key) => {
    observedKeys.push(key)
    return revise(cell, { process: { status: 'available', rawValue: 0.5,
      contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } })
  }
  const provider = new GepaProcessCompletionProvider(join(root, 'operations'), artifacts, bindings, fixture.provider)
  const baseKey = digestJson(['r', 'repair-a', result.digest])
  const input: GepaProcessCompletionInput = { roundIdentity: { evolutionId: 'e', roundId: 'r' }, repairId: 'repair-a',
    currentRef: artifacts.putJson(result as unknown as JsonValue, 'gepa.stage-result.v1'),
    cachedRef: artifacts.putJson({ schemaVersion: 1, cells: [] }, 'gepa.cached-cells.v1'),
    baseKey, cellRef: artifacts.putJson(base as unknown as JsonValue, 'gepa.evidence-cell.v1'),
    deadlineAt: Date.now() + 60_000 }
  const operationId = digestJson(['process', root]).slice(7)
  const envelope: OperationEnvelope = { campaignId: 'search-r', decisionIndex: 0, localKey: 'process',
    operationId, idempotencyKey: operationId, kind: 'gepa.process-complete',
    input: input as unknown as JsonValue, inputDigest: jsonDigest(input as unknown as JsonValue),
    implementationDigest: provider.describe().implementationDigest, bindingSetRef: bindings.create({ harness }), limits: {} }
  const forged = revise(base, { evidenceRef: 'unowned-cell' })
  const forgedInput = { ...input, cellRef: artifacts.putJson(forged as unknown as JsonValue, 'gepa.evidence-cell.v1') }
  await expect(provider.preflight({ ...envelope, input: forgedInput as unknown as JsonValue,
    inputDigest: jsonDigest(forgedInput as unknown as JsonValue) })).rejects.toThrow('not part of this repair')
  expect((await provider.submit(envelope)).status).toBe('completed')
  expect(observedKeys).toEqual([digestJson([baseKey, base.digest])])
  const completed = await provider.inspect(envelope)
  expect(completed.status).toBe('completed')
  if (completed.status !== 'completed' || completed.completion.outcome.kind !== 'result') throw new Error('missing projection')
  const value = completed.completion.outcome.value as { executionRef: Parameters<typeof artifacts.getJson>[0] }
  expect(artifacts.getJson(value.executionRef)).toMatchObject({ schemaVersion: 1,
    cells: [{ process: { status: 'available', rawValue: 0.5 } }] })

  fixture.provider.inspectProcess = async () => ({ status: 'running', handle: 'projection-worker' })
  fixture.provider.completeProcess = async () => { throw new Error('lost projection response') }
  const pendingProvider = new GepaProcessCompletionProvider(join(root, 'pending'), artifacts, bindings, fixture.provider)
  const pendingId = digestJson(['pending-process', root]).slice(7)
  const pendingEnvelope = { ...envelope, operationId: pendingId, idempotencyKey: pendingId,
    implementationDigest: pendingProvider.describe().implementationDigest }
  expect(await pendingProvider.submit(pendingEnvelope)).toEqual({ status: 'running', handle: 'projection-worker' })
  expect(await pendingProvider.legacyPending(pendingEnvelope)).toEqual({ state: 'running',
    handle: 'projection-worker', reason: 'lost projection response' })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { digestJson } from '../../src/state/digest.js'
import { FailureClusterSearch, SearchEvidencePending } from '../../src/search/engine.js'
import { SearchExecutionFailure, SearchOperationPending } from '../../src/search/recovery.js'
import * as repairTiming from '../../src/search/repair.js'
import { validateSettings } from '../../src/search/contracts.js'
import { completeEvidence, validOutcome } from '../../src/search/evidence.js'
import { fixtures, MemorySearchStore, revise, settings } from '../../src/search/testing.js'
import type { AutomaticEvaluationRepair, EvidenceCell, PendingSearchEvidence, StageResult } from '../../src/search/types.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function setup(count = 20, process = false) {
  const f = fixtures(count, process), config = settings(), store = new MemorySearchStore()
  const request = { evolutionId: 'automatic-recovery', roundId: 'r', roundIndex: 0, maxCandidates: 2,
    anchor: f.anchor, championRevisionDigest: digestJson('revision'), settings: config }
  const engine = (journal = store) => new FailureClusterSearch(journal, f.provider, f.diagnosis, f.hooks)
  const run = (journal = store, signal = new AbortController().signal) => engine(journal).run(request, signal)
  return { ...f, store, config, request, engine, run }
}
async function pending(store: MemorySearchStore) { return (await store.read<PendingSearchEvidence>('rounds/r/pending-evidence'))! }
function invalid(cell: EvidenceCell) {
  return revise(cell, { status: 'invalid', outcomeCertified: false,
    outcome: { status: 'invalid', contractDigest: cell.identity.outcomeContractDigest, reason: 'injected execution failure' } })
}

describe('automatic pre-consumption evaluation repair', () => {
  it('preserves omitted repair settings and resolves bounded defaults', () => {
    const f = setup()
    delete f.config.search.evaluationStages.repair
    expect(() => validateSettings(f.config, f.seed, f.heldOut, 2)).not.toThrow()
    expect(repairTiming.evaluationRepairPolicy(f.config)).toEqual({ maxAttempts: 3, backoffMs: [15000, 60000, 180000], jitterMs: 1000 })
    f.config.search.evaluationStages.repair = { maxAttempts: 0, backoffMs: [0], jitterMs: 0 }
    expect(() => validateSettings(f.config, f.seed, f.heldOut, 2)).not.toThrow()
  })

  it.each([{ maxAttempts: -1 }, { maxAttempts: .5 }, { jitterMs: -1 }, { backoffMs: [] }, { backoffMs: [.5] }, { backoffMs: [NaN] }])('rejects invalid repair settings before execution: %j', repair => {
    const f = setup()
    f.config.search.evaluationStages.repair = repair
    expect(() => validateSettings(f.config, f.seed, f.heldOut, 2)).toThrow()
    expect(f.executions).toEqual([])
    expect(f.store.checkpoint()).toEqual([])
  })

  it.each(['baseline-probe', 'local', 'bridge', 'global-seed', 'held-out'] as const)('repairs a settled invalid %s slot before freezing its decision', async stage => {
    const f = setup(), evaluate = f.provider.evaluate
    let original: StageResult | undefined, failed = false
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (!failed && input.plan.stage === stage && (stage === 'baseline-probe' || input.snapshot.candidateId !== 'anchor')) {
        failed = true
        const bad = [invalid(cells[0]!), ...cells.slice(1)]
        original = { stagePlanDigest: input.plan.digest, snapshotDigest: input.snapshot.digest, cells: bad, settled: true,
          digest: digestJson({ stagePlanDigest: input.plan.digest, snapshotDigest: input.snapshot.digest, cells: bad, settled: true }) }
        return bad
      }
      return cells
    }
    const outcome = await f.run()
    expect(failed).toBe(true)
    expect(outcome.championChanged).toBe(true)
    const originalPointer = (await f.store.read<{ ref: string }>(`rounds/r/evaluation-${digestJson([original!.stagePlanDigest, original!.snapshotDigest]).slice(7)}`))!
    original = await f.store.object<StageResult>(originalPointer.ref)
    const automatic = (await f.store.read<AutomaticEvaluationRepair>(`rounds/r/automatic-repair-${original.digest.slice(7)}`))!
    expect(automatic.originalRef).toBe(original!.digest)
    expect(automatic.attempts).toHaveLength(1)
    const completed = await f.store.object<StageResult>(automatic.attempts[0]!.resultRef!)
    expect(completed.cells.every(validOutcome)).toBe(true)
    expect(completed.cells).toEqual(expect.arrayContaining(original!.cells.filter(validOutcome)))
    expect(f.executions.find(e => e.key === digestJson(['r', automatic.attempts[0]!.id, original!.digest]))?.count).toBe(1)
    const executions = [...f.executions]
    expect(await f.run()).toEqual(outcome)
    expect(f.executions).toEqual(executions)
  })

  it('repairs 99/100 to 100/100 with one new execution and preserves every valid zero', async () => {
    const f = setup(100), evaluate = f.provider.evaluate
    let first = true, originalCells: EvidenceCell[] = []
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (first) { first = false; originalCells = cells.slice(0, 99); return [...originalCells, invalid(cells[99]!)] }
      return cells
    }
    await f.run()
    expect(f.executions.slice(0, 2).map(e => e.count)).toEqual([100, 1])
    const repairedPointer = f.store.checkpoint().find(([key]) => key.startsWith('rounds/r/repair-') && !key.includes('input') && !key.includes('result'))![1] as { ref: string }
    const repaired = await f.store.object<StageResult>(repairedPointer.ref)
    expect(repaired.cells).toHaveLength(100)
    expect(repaired.cells.every(validOutcome)).toBe(true)
    const zeros = originalCells.filter(c => c.outcome.status === 'available' && c.outcome.rawValue === 0)
    expect(zeros).toHaveLength(80)
    expect(repaired.cells).toEqual(expect.arrayContaining(zeros))
  })

  it('exhausts a fixed attempt count without consuming or rejecting the stage, then permits manual repair', async () => {
    const f = setup(), evaluate = f.provider.evaluate
    f.config.search.evaluationStages.repair = { maxAttempts: 2, backoffMs: [0], jitterMs: 0 }
    f.provider.evaluate = async input => (await evaluate(input)).map((cell, index) => input.plan.stage === 'baseline-probe' && index === 0 ? invalid(cell) : cell)
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const first = await pending(f.store), participant = first.participants![0]!
    expect(first).toMatchObject({ state: 'infrastructure-incomplete', reasonCodes: ['automatic-repair-exhausted'] })
    expect(participant.attempts.map(a => a.number)).toEqual([1, 2])
    expect(f.executions.map(e => e.count)).toEqual([20, 1, 1])
    expect(await f.store.read('rounds/r/terminal')).toBeUndefined()
    expect(await f.store.read('rounds/r/commit')).toBeUndefined()
    expect(await f.store.archive()).toBeUndefined()
    expect(await f.store.read('active-round')).toEqual({ roundId: 'r' })
    const restarted = new MemorySearchStore(f.store.checkpoint()), executions = f.executions.length
    await expect(f.run(restarted)).rejects.toBeInstanceOf(SearchEvidencePending)
    expect((await pending(restarted)).resultRefs).toEqual(first.resultRefs)
    expect(f.executions).toHaveLength(executions)
    f.provider.evaluate = evaluate
    await f.engine(restarted).repairEvaluation('r', 'operator', participant.originalRef, new AbortController().signal)
    expect((await f.run(restarted)).championChanged).toBe(true)
    expect(await restarted.read('rounds/r/pending-evidence')).toBeNull()
  })

  it('persists the original attempt ID and due time across a crash before backoff', async () => {
    const f = setup(), evaluate = f.provider.evaluate
    f.config.search.evaluationStages.repair = { maxAttempts: 3, backoffMs: [15000, 60000, 180000], jitterMs: 0 }
    let first = true, crashed = false
    f.provider.evaluate = async input => { const cells = await evaluate(input); if (first) { first = false; return cells.slice(1) } return cells }
    const write = f.store.write.bind(f.store)
    vi.spyOn(f.store, 'write').mockImplementation(async (key, value) => {
      await write(key, value)
      if (!crashed && key === 'rounds/r/pending-evidence') { crashed = true; throw new Error('crashed before repair delay') }
    })
    await expect(f.run()).rejects.toThrow('crashed before repair delay')
    const before = await pending(f.store), attempt = before.participants![0]!.attempts[0]!
    expect(attempt.notBefore - attempt.scheduledAt).toBe(15000)
    expect(f.executions).toHaveLength(1)
    vi.spyOn(Date, 'now').mockReturnValue(attempt.notBefore + 1)
    const restarted = new MemorySearchStore(f.store.checkpoint())
    expect((await f.run(restarted)).championChanged).toBe(true)
    const repair = (await restarted.read<AutomaticEvaluationRepair>(`rounds/r/automatic-repair-${before.resultRefs[0]!.slice(7)}`))!
    expect(repair.attempts).toHaveLength(1)
    expect(repair.attempts[0]).toMatchObject({ id: attempt.id, notBefore: attempt.notBefore, scheduledAt: attempt.scheduledAt, state: 'complete' })
  })

  it('cancels during backoff and resumes the same scheduled attempt without new work', async () => {
    const f = setup(), evaluate = f.provider.evaluate, controller = new AbortController()
    f.config.search.evaluationStages.repair = { backoffMs: [15000], jitterMs: 0 }
    let first = true
    f.provider.evaluate = async input => { const cells = await evaluate(input); if (first) { first = false; return cells.slice(1) } return cells }
    const sleep = vi.spyOn(repairTiming, 'waitForRepair').mockImplementationOnce(async (_due, signal) => {
      controller.abort(new Error('operator stopped')); signal.throwIfAborted()
    })
    await expect(f.run(f.store, controller.signal)).rejects.toThrow('operator stopped')
    const before = await pending(f.store), attempt = before.participants![0]!.attempts[0]!
    expect(f.executions).toHaveLength(1)
    sleep.mockRestore()
    vi.spyOn(Date, 'now').mockReturnValue(attempt.notBefore + 1)
    expect((await f.run(new MemorySearchStore(f.store.checkpoint()))).championChanged).toBe(true)
    expect(f.executions[1]?.count).toBe(1)
  })

  it.each(['round.cells', 'round.repairCells', 'evolution.repairCells'] as const)('retains incomplete evidence when automatic repair reaches %s', async resource => {
    const f = setup(), evaluate = f.provider.evaluate
    if (resource === 'round.cells') f.config.budgets.round.maxNewRolloutCells = 20
    else if (resource === 'round.repairCells') f.config.budgets.round.maxRepairCells = 0
    else f.config.budgets.evolution.maxRepairCells = 0
    f.provider.evaluate = async input => (await evaluate(input)).map((cell, index) => index === 0 ? invalid(cell) : cell)
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const details = await pending(f.store)
    expect(details.reasonCodes).toEqual([`budget-exhausted:${resource}`])
    expect(details.participants![0]!.attempts).toHaveLength(1)
    expect(f.executions).toHaveLength(1)
    expect(await f.store.read('rounds/r/terminal')).toBeUndefined()
    const ledger = await f.store.read('budget')
    await expect(f.run(new MemorySearchStore(f.store.checkpoint()))).rejects.toBeInstanceOf(SearchEvidencePending)
    expect(f.executions).toHaveLength(1)
    expect(await f.store.read('budget')).toEqual(ledger)
  })

  it('stops an automatic backoff at the original deadline without spending another execution', async () => {
    vi.useFakeTimers()
    const f = setup(), evaluate = f.provider.evaluate
    f.config.budgets.round.timeoutMs = 100
    f.config.search.evaluationStages.repair = { backoffMs: [15000], jitterMs: 0 }
    f.provider.evaluate = async input => (await evaluate(input)).slice(1)
    vi.spyOn(repairTiming, 'waitForRepair').mockImplementationOnce(async (_due, signal) => {
      await vi.advanceTimersByTimeAsync(101)
      signal.throwIfAborted()
    })
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const details = await pending(f.store)
    expect(details).toMatchObject({ state: 'infrastructure-incomplete', reasonCodes: ['budget-exhausted:time'] })
    expect(details.participants![0]!.attempts[0]!.state).toBe('scheduled')
    expect(f.executions).toHaveLength(1)
    expect(await f.store.read('rounds/r/terminal')).toBeUndefined()
  })

  it.each(['unknown', 'running'] as const)('keeps a %s automatic repair under the original key without resubmitting', async state => {
    const f = setup(), evaluate = f.provider.evaluate, inspect = f.provider.inspectEvaluation!
    let first = true, repairKey = '', ready = false, repairCalls = 0
    f.provider.evaluate = async input => {
      const cells = await evaluate(input)
      if (input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor') {
        if (first) { first = false; return cells.slice(1) }
        repairCalls++; repairKey = input.idempotencyKey; throw new Error('repair response lost')
      }
      return cells
    }
    f.provider.inspectEvaluation = async input => input.idempotencyKey === repairKey && !ready
      ? state === 'running' ? { status: 'running', handle: 'original-remote-job' } : { status: 'unknown', reason: 'no verified terminal state' }
      : inspect(input)
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    const before = await pending(f.store), original = before.participants![0]!.originalRef, attempt = before.participants![0]!.attempts[0]!
    const restarted = new MemorySearchStore(f.store.checkpoint()), ledger = await f.store.read('budget')
    await expect(f.run(restarted)).rejects.toBeInstanceOf(SearchOperationPending)
    expect(await restarted.read('budget')).toEqual(ledger)
    expect(repairCalls).toBe(1)
    expect((await pending(restarted)).participants![0]!.attempts[0]!.id).toBe(attempt.id)
    const saved = (await restarted.object<{ startedAt: number; digest: string }>((await restarted.read<{ ref: string }>('rounds/r/admission'))!.ref)).startedAt
    vi.spyOn(Date, 'now').mockReturnValue(saved + f.config.budgets.round.timeoutMs + 1)
    ready = true
    // The original held-out repair can be read and promoted after its deadline
    // without another external invocation.
    expect((await f.run(restarted)).championChanged).toBe(true)
    expect(repairCalls).toBe(1)
    const automatic = (await restarted.read<AutomaticEvaluationRepair>(`rounds/r/automatic-repair-${original.slice(7)}`))!
    expect(automatic.attempts).toHaveLength(1)
    expect(automatic.attempts[0]!.state).toBe('complete')
    expect((await restarted.object<StageResult>(automatic.attempts[0]!.resultRef!)).cells).toHaveLength(f.heldOut.tasks.length)
  })

  it('uses process projection without rerunning an independently certified outcome', async () => {
    const f = setup(20, true), evaluate = f.provider.evaluate
    let gap: EvidenceCell | undefined, projections = 0
    f.provider.evaluate = async input => (await evaluate(input)).map((cell, index) => {
      if (!gap && index === 0 && input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor') {
        gap = revise(cell, { process: { status: 'missing', contractDigest: cell.identity.processContractDigest!, reason: 'original projection not ready' } }); return gap
      }
      return cell
    })
    f.provider.completeProcess = async cell => { projections++; return revise(cell, { process: { status: 'available', rawValue: 1, contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } }) }
    expect((await f.run()).championChanged).toBe(true)
    expect(projections).toBe(1)
    expect(f.executions.filter(e => e.stage === 'held-out' && e.participant !== 'anchor')).toHaveLength(1)
  })

  it.each(['unknown', 'running'] as const)('reconciles a %s original-artifact projection without another submission', async state => {
    const f = setup(20, true), evaluate = f.provider.evaluate
    let gap = false, calls = 0, ready = false, projectionKey = '', projected: EvidenceCell | undefined
    f.provider.evaluate = async input => (await evaluate(input)).map((cell, index) => {
      if (!gap && index === 0 && input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor') {
        gap = true
        return revise(cell, { process: { status: 'missing', contractDigest: cell.identity.processContractDigest!, reason: 'projection not ready' } })
      }
      return cell
    })
    f.provider.completeEvidence = async (cell, key) => {
      calls++; projectionKey = key
      projected = revise(cell, { process: { status: 'available', rawValue: 1,
        contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } })
      throw new Error('projection response lost')
    }
    f.provider.inspectEvidence = async (_cell, key) => {
      expect(key).toBe(projectionKey)
      return ready ? { status: 'complete', result: { cells: [projected!] } }
        : state === 'running' ? { status: 'running', handle: 'original-projection-job' }
          : { status: 'unknown', reason: 'projection still uncertain' }
    }
    await expect(f.run()).rejects.toBeInstanceOf(SearchOperationPending)
    const restarted = new MemorySearchStore(f.store.checkpoint()), ledger = await f.store.read('budget')
    await expect(f.run(restarted)).rejects.toBeInstanceOf(SearchOperationPending)
    expect(await restarted.read('budget')).toEqual(ledger)
    expect(calls).toBe(1)
    const admission = await restarted.object<{ startedAt: number; digest: string }>((await restarted.read<{ ref: string }>('rounds/r/admission'))!.ref)
    vi.spyOn(Date, 'now').mockReturnValue(admission.startedAt + f.config.budgets.round.timeoutMs + 1)
    ready = true
    expect((await f.run(restarted)).championChanged).toBe(true)
    expect(calls).toBe(1)
    expect(f.executions.filter(execution => execution.stage === 'held-out' && execution.participant !== 'anchor')).toHaveLength(1)
  })

  it('preserves search progress while repairing process evidence required by local promotion', async () => {
    const f = setup(20, true), evaluate = f.provider.evaluate
    f.config.search.process.mode = 'off'; f.config.promotion.process.mode = 'required'
    let gap = false, projections = 0
    f.provider.evaluate = async input => (await evaluate(input)).map((cell, index) => {
      if (!gap && index === 0 && input.plan.stage === 'local' && input.snapshot.candidateId !== 'anchor') {
        gap = true
        return revise(cell, { process: { status: 'missing', contractDigest: cell.identity.processContractDigest!, reason: 'local projection not ready' } })
      }
      return cell
    })
    f.provider.completeEvidence = async cell => {
      projections++
      return revise(cell, { process: { status: 'available', rawValue: 1,
        contractDigest: cell.identity.processContractDigest!, evidenceRef: cell.evidenceRef } })
    }
    expect((await f.run()).championChanged).toBe(true)
    expect(gap).toBe(true); expect(projections).toBe(1)
  })

  it('keeps unsupported process/assertion projections pending without spending repair attempts', async () => {
    const f = setup(20, true), evaluate = f.provider.evaluate
    f.config.promotion.protectedAssertions = [{ taskId: 'task-0', partition: 'seed', assertionId: 'new-check', schemaDigest: digestJson('assertion-schema'), rule: 'must-pass' }]
    f.provider.evaluate = async input => (await evaluate(input)).map(cell => input.plan.stage === 'bridge' && input.snapshot.candidateId !== 'anchor'
      ? revise(cell, { process: { status: 'missing', contractDigest: cell.identity.processContractDigest!, reason: 'artifact absent' } }) : cell)
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    const details = await pending(f.store)
    expect(details.reasonCodes).toEqual(['unsupported-evidence-projection'])
    expect(details.participants![0]!.attempts).toEqual([])
    expect(details.participants![0]!.missingSlots.some(s => s.channel === 'assertion')).toBe(true)
    expect(await f.store.read('rounds/r/nomination')).toBeUndefined()
    expect(await f.store.read('rounds/r/commit')).toBeUndefined()
    expect(f.promotions).toEqual([])
  })

  it('appends missing assertions while preserving outcome and every existing assertion byte-for-byte', async () => {
    const f = setup(), evaluate = f.provider.evaluate, schema = digestJson('assertion-schema')
    f.config.promotion.protectedAssertions = [{ taskId: 'task-0', partition: 'seed', assertionId: 'new', schemaDigest: schema, rule: 'must-pass' }]
    f.provider.evaluate = async input => (await evaluate(input)).map(cell => revise(cell, { assertions: [{ id: 'old', schemaDigest: schema, status: 'passed' }] }))
    let projections = 0, original: EvidenceCell | undefined, complete: EvidenceCell | undefined
    f.provider.completeEvidence = async cell => {
      projections++; original = cell
      complete = revise(cell, { assertions: [...cell.assertions!, { id: 'new', schemaDigest: schema, status: 'passed' }] })
      return complete
    }
    expect((await f.run()).championChanged).toBe(true)
    expect(projections).toBeGreaterThan(0)
    expect(complete!.outcome).toEqual(original!.outcome)
    const result = revise({ stagePlanDigest: digestJson('plan'), snapshotDigest: f.anchor.digest, cells: [original!], settled: true, digest: '' }, {})
    expect(() => completeEvidence(result, [revise(complete!, { assertions: [{ id: 'old', schemaDigest: schema, status: 'failed' }, complete!.assertions![1]!] })])).toThrow('existing assertion')
    expect(() => completeEvidence(result, [revise(complete!, { assertions: [...complete!.assertions!, complete!.assertions![0]!] })])).toThrow('duplicate assertion')
    expect(() => completeEvidence(result, [revise(complete!, { outcome: { status: 'available', rawValue: 0, contractDigest: complete!.identity.outcomeContractDigest, evidenceRef: complete!.evidenceRef } })])).toThrow('valid outcome')
  })

  it('blocks repair of consumed diagnosis probes while leaving unconsumed held-out evidence repairable', async () => {
    const f = setup(), evaluate = f.provider.evaluate
    let heldOut = false
    f.config.search.evaluationStages.repair = { maxAttempts: 0, backoffMs: [0], jitterMs: 0 }
    f.provider.evaluate = async input => { const cells = await evaluate(input); if (input.plan.stage === 'held-out' && input.snapshot.candidateId !== 'anchor') { heldOut = true; return cells.slice(1) } return cells }
    await expect(f.run()).rejects.toBeInstanceOf(SearchEvidencePending)
    expect(heldOut).toBe(true)
    const consumed = f.store.checkpoint().filter(([key]) => key.startsWith('rounds/r/consumed-'))
    let probeRef: string | undefined
    for (const [, pointer] of consumed) {
      const marker = await f.store.object<{ consumer: string; resultDigest: string; digest: string }>((pointer as { ref: string }).ref)
      if (marker.consumer === 'diagnosis') probeRef = marker.resultDigest
    }
    expect(probeRef).toBeDefined()
    await expect(f.engine().repairEvaluation('r', 'bad-probe', probeRef!, new AbortController().signal)).rejects.toThrow('stage already consumed')
    f.provider.evaluate = evaluate
    await f.engine().repairEvaluation('r', 'unconsumed', (await pending(f.store)).participants![0]!.originalRef, new AbortController().signal)
    expect((await f.run()).championChanged).toBe(true)
  })

  it('leaves complete stages unchanged and allocates no automatic repair state', async () => {
    const f = setup()
    expect((await f.run()).championChanged).toBe(true)
    expect(f.store.checkpoint().some(([key]) => key.startsWith('rounds/r/automatic-repair-'))).toBe(false)
    expect(await f.store.read('rounds/r/pending-evidence')).toBeUndefined()
    expect(new Set(f.executions.map(e => e.key)).size).toBe(f.executions.length)
  })
})

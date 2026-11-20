import type { Json } from './algorithm-wire.js'
import type { SourceRef } from './algorithm-wire-v2.js'
import type { OperatorArtifact } from './operator-run.js'
import type { RunJournal } from './run.js'
import { canonicalDigest } from './canonical.js'

export function operatorArtifact(
  journal: RunJournal,
  kind: string,
  value: Json,
  sources: SourceRef[],
): OperatorArtifact {
  return {
    ref: {
      run_id: journal.id,
      kind,
      digest: canonicalDigest({ kind, value, sources }),
      visibility: 'optimization',
    },
    value,
    sources,
  }
}

/** Runtime facts and author interpretations retain distinct provenance in every snapshot. */
export function operatorHistory(journal: RunJournal): OperatorArtifact {
  const events: Json[] = []
  for (const call of journal.operators!.calls) {
    if (!call.result) continue
    const effect = call.call.effect
    if (effect.kind === 'read') continue
    const candidateId =
      effect.kind === 'candidate'
        ? call.candidateId
        : effect.kind === 'meta' || effect.kind === 'execute'
          ? effect.input.candidate.candidate_id
          : null
    const kind =
      call.screening && call.screening.verdict.status !== 'allow'
        ? 'screened'
        : effect.kind === 'candidate'
          ? 'generated'
          : effect.kind === 'execute'
            ? effect.input.exposure === 'blind'
              ? 'executed'
              : 'evaluated'
            : effect.kind === 'library'
              ? effect.input.mode === 'commit'
                ? 'library_committed'
                : 'library_publication'
              : effect.kind === 'stream'
                ? 'task_completed'
                : effect.kind
    events.push({
      id: canonicalDigest([call.id, 'completion']),
      kind,
      provenance: 'runtime',
      call: call.result.ref,
      candidate_id: candidateId,
      status: call.result.status,
      sources:
        effect.kind === 'execute'
          ? [effect.input.candidate, ...effect.input.assets]
          : call.materials.map((material) => material.ref),
      sample_ids: call.sampleIds ?? [],
      artifacts: call.result.artifacts,
      usage: call.result.usage,
      ...(call.screening ? { screening: call.screening as unknown as Json } : {}),
    })
  }
  for (const decision of journal.operators!.decisions) {
    for (const [index, record] of decision.decision.records.entries())
      events.push({
        id: canonicalDigest([journal.id, decision.stepId, index]),
        kind: typeof record.kind === 'string' ? record.kind : 'author_record',
        provenance: 'author',
        step_id: decision.stepId,
        record,
      })
    const terminal = decision.decision.terminal
    if (terminal)
      events.push({
        id: canonicalDigest([journal.id, decision.stepId, terminal]),
        kind: terminal.kind === 'nominate' ? 'nominated' : 'stopped',
        provenance: 'runtime',
        candidate_id: terminal.candidate?.candidate_id ?? null,
        outcome: terminal.outcome,
      })
  }
  if (journal.gate.status !== 'not_run' && journal.spec.operatorPolicy?.access?.exposure !== 'blind')
    events.push({
      id: canonicalDigest([journal.id, journal.gate, journal.championId]),
      kind: journal.status === 'completed' && journal.championId === journal.nomineeId ? 'published' : 'gate',
      provenance: 'runtime',
      candidate_id: journal.nomineeId,
      gate: journal.gate,
    })
  return operatorArtifact(journal, 'history', { events }, [])
}

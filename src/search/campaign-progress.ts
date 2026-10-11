import type { JsonValue } from '../algorithm/schema.js'
import type { SearchJournal } from './store.js'
import type { SearchProgress } from './types.js'

type Phase = SearchProgress['phase'] | 'held-out'
type Inner = { phase: string; bridgePlan?: unknown; globalPlan?: unknown; heldOutPlan?: unknown }
type Outer = { phase: string; inner?: Inner | null; pendingScienceStage?: string | null;
  bootstrapResultRef?: unknown; finalArchiveRef?: unknown }

/** Replays only the old phase boundaries reached by a frozen Campaign decision. */
export class CampaignPhaseProgress {
  private emitted = new Set<Phase>()
  constructor(readonly journal: SearchJournal, readonly roundId: string,
    readonly callback: ((phase: Phase) => Promise<void> | void) | undefined) {}

  private reached(state: JsonValue | null): Phase[] {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return []
    const outer = state as Outer
    if (outer.phase === 'objective-initial-harness' || outer.phase === 'complete') return []
    const phases: Phase[] = ['bootstrap']
    if (['bootstrap', 'bootstrap-publication', 'bootstrap-failure-progress', 'archive-view-checkpoint'].includes(outer.phase)
      || outer.phase === 'terminal-publication' && !outer.finalArchiveRef) return phases
    const inner = outer.inner
    if (!inner) return phases
    if (outer.phase === 'science-checkpoint' && outer.pendingScienceStage === 'parents') return phases
    phases.push('scope-preparation')
    if (outer.phase === 'science-checkpoint' && outer.pendingScienceStage === 'scope-preparation'
      || inner.phase === 'scope-preparation') return phases
    phases.push('diagnosis-planning')
    if (outer.phase === 'science-checkpoint' && outer.pendingScienceStage === 'planning'
      || ['parent-probe', 'diagnosis', 'planning-probe'].includes(inner.phase)) return phases
    phases.push('generation')
    if (inner.phase === 'generation') return phases
    phases.push('local')
    if (outer.phase === 'science-checkpoint' && outer.pendingScienceStage === 'local'
      || inner.phase === 'local') return phases
    if (inner.bridgePlan) phases.push('bridge')
    if (outer.phase === 'science-checkpoint' && outer.pendingScienceStage === 'nomination'
      || inner.phase.startsWith('bridge')) return phases
    if (inner.globalPlan) phases.push('global-seed')
    if (inner.phase.startsWith('global')) return phases
    if (outer.phase === 'seed-research-checkpoint' || inner.phase === 'seed-research') return phases
    phases.push('seed-research-complete')
    if (inner.heldOutPlan) phases.push('held-out')
    return phases
  }

  async reach(state: JsonValue | null): Promise<void> {
    for (const phase of this.reached(state)) {
      if (this.emitted.has(phase)) continue
      if (phase !== 'held-out') {
        const key = `rounds/${this.roundId}/progress`
        const prior = await this.journal.read<SearchProgress>(key)
        await this.journal.write(key, { evaluations: [], decisions: [], ...prior, phase })
      }
      await this.callback?.(phase)
      this.emitted.add(phase)
    }
  }
}

import type { RunPlan } from '../application/run-plan.js'

export function formatRunPlan(plan: RunPlan): string {
  const generation = plan.limits.generation
  const limits = (value: typeof generation.total) =>
    `requests ${value.model_requests ?? 'unlimited'}, tokens ${value.tokens ?? 'unlimited'}`
  const timeouts = plan.limits.timeouts
  const providerTimeouts = (['target', 'meta'] as const).flatMap((role) => {
    const values = timeouts.provider?.[role]
    return values === undefined || values === null
      ? [`${role}: timeout limits unreported.`]
      : values.map((value) => `${role}: ${value.name} ${value.milliseconds} ms (${value.scope}).`)
  })
  const seconds = (value: number | null | undefined) =>
    value === null || value === undefined ? 'runtime default / unreported' : `${value} s`
  return (
    [
      `Refine plan (${plan.state}${plan.run_id ? `, ${plan.run_id}` : ''})`,
      `Tasks: ${plan.tasks.seed.length} seed, ${plan.tasks.held_out_count} held-out; ${plan.repetitions} repetitions.`,
      `Baseline: ${plan.baseline.reusable_slots}/${plan.baseline.logical_slots} verified slots reused; ${plan.baseline.new_physical_trials} new trials needed.`,
      `Limits: ${plan.limits.rounds} rounds, ${plan.limits.new_candidates} new candidates, ${plan.limits.physical_trial_attempts} physical trial attempts including baseline, final validation and repairs.`,
      `Generation and diagnosis: total ${limits(generation.total)}; per operation ${limits(generation.perOperation)} (bounded by any remaining total).`,
      `Final validation: ${plan.final_gate.physical_trials_for_anchor_and_nominee} trials for initial Target and nominee; ${plan.validation_mode}.`,
      ...providerTimeouts,
      `Harbor task declarations (Target runtime: ${timeouts.provider?.taskRuntime ?? 'unreported'}):`,
      ...timeouts.task_declarations.groups.map(
        (group) =>
          `  ${group.count} ${group.partition} tasks: agent ${seconds(group.deadlines?.agent_seconds)}, verifier ${seconds(group.deadlines?.verifier_seconds)}, environment build ${seconds(group.deadlines?.environment_build_seconds)}, verifier build ${seconds(group.deadlines?.verifier_build_seconds)}.`,
      ),
      'No whole-run deadline is configured. Provider-call timeouts do not confirm that remote work stopped.',
      ...plan.warnings.map(
        (warning) =>
          ({
            'shared-set-research-no-independent-validation': 'Same-set research: no independent validation.',
            'baseline-unaffordable': plan.next_action,
            'final-gate-unaffordable-after-baseline':
              'The remaining budget cannot fund independent final validation; increase max_evaluations for a new run.',
          })[warning] ?? warning,
      ),
    ].join('\n') + '\n'
  )
}

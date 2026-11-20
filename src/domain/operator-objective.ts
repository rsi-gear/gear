import type { ObjectiveConfiguration } from './objective.js'

/** Optimizer comparison semantics omit private final-gate protection rules. */
export function operatorObjective(objective: ObjectiveConfiguration | undefined) {
  return objective ? { definition: objective.definition, metrics: objective.metrics } : null
}

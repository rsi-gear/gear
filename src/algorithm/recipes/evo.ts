import type { PythonRecipeFacade } from './rho.js';

/** Replayable Evo-Harness batches are implemented once, in Python. */
export const evoRecipe: PythonRecipeFacade = {
  language: 'python',
  module: 'gear_algorithm.recipes.evo',
  export: 'algorithm',
  requiredOperationKinds: ['tasks.consume', 'execution.role', 'execution.rollout', 'execution.feedback', 'bindings.derive'],
};

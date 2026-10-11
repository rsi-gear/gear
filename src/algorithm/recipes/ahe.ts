import type { PythonRecipeFacade } from './rho.js';

/** Delayed-measurement AHE is implemented once, in Python. */
export const aheRecipe: PythonRecipeFacade = {
  language: 'python',
  module: 'gear_algorithm.recipes.ahe',
  export: 'algorithm',
  requiredOperationKinds: ['tasks.consume', 'evidence.query', 'evidence.read', 'execution.rollout',
    'execution.feedback', 'execution.role', 'execution.workspace-edit', 'bindings.derive'],
};

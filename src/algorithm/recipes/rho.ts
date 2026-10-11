/** The scientific RHO implementation lives in the Python gear_algorithm package. */
export type PythonRecipeFacade = Readonly<{
  language: 'python';
  module: string;
  export: string;
  requiredOperationKinds: readonly string[];
}>;

export const rhoRecipe: PythonRecipeFacade = {
  language: 'python',
  module: 'gear_algorithm.recipes.rho',
  export: 'algorithm',
  requiredOperationKinds: ['evidence.query', 'evidence.read', 'tasks.select', 'tasks.consume',
    'execution.role', 'execution.rollout', 'execution.feedback', 'execution.workspace-edit', 'bindings.derive'],
};

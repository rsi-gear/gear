/** Target resource ownership. Meta hosts and evaluation providers are separate ports. */
export interface MutationPolicy {
  writableRoots: readonly string[]
  protectedNames: readonly string[]
  allowedImports: readonly string[]
}
export interface HarnessDescription {
  adapterRef: { id: string; version: string }
  resources: readonly string[]
  guide: string
  runtimeSourceMutation: boolean
}
export interface HarnessExecutionSpec {
  harnessId: string
  workingDirectory: string
  entrypoint: string
  resourcePaths: string[]
  agentArgs?: string[]
}
export interface HarnessAdapter {
  describe(): HarnessDescription
  readonly mutationPolicy: MutationPolicy
  prepare(directory: string): Promise<void>
  check(directory: string): Promise<void>
  executionSpec(directory: string): HarnessExecutionSpec
  /** Populate a trusted container build context from one verified snapshot. */
  materialize?(directory: string, environment: string): Promise<{ dockerfile: string; agentArgs: string[] }>
}

/** Native DSH entry and public project execution API. Algorithms are authored in Python. */
export { name, inject, Config, apply, type ProjectPluginConfig } from './adapters/dsh/project-plugin.js'
export {
  ProjectApplication,
  type ProjectBindings,
  type ProjectRuntimeContext,
  type EvaluateOptions,
  type RefineOptions,
} from './application/project-service.js'
export { ProjectController } from './application/project-controller.js'
export { createProjectControlPlane } from './application/control-plane.js'
export { initProject } from './application/init.js'
export { resolveProject } from './application/project-config.js'
export { DshHarnessAdapter } from './adapters/dsh/harness.js'
export { PiHarnessAdapter } from './adapters/pi/harness.js'
export { GearError } from './domain/errors.js'
export type { HarnessAdapter, MutationPolicy } from './ports/harness.js'
export type {
  OperationProvider,
  OperationCancellation,
  OperationRequest,
  OperationReceipt,
  OperationInspection,
  ProviderCapabilities,
} from './ports/operations.js'
export type { ProjectConfig, CompiledBenchmark } from './domain/project.js'
export type { RunSpec, RunJournal } from './domain/run.js'
export type { RunPlan } from './application/run-plan.js'
export type { ObjectiveDefinition, RawMetricDefinition, RawMetricContract, ProtectedMetric } from './domain/objective.js'

export { setup, type SetupOptions } from './application/setup.js'
export { doctor } from './application/doctor.js'
export { createProfile, selectProjectProfile, type CreateProfileOptions } from './application/profile-service.js'
export { listProfiles, saveProfile, selectDefaultProfile, type Profile, type ProfileRole } from './application/profile-store.js'

export { prepareBenchmarkImport, applyBenchmarkImport, type BenchmarkImportOptions } from './application/benchmark-import.js'
export { probeBenchmark, type BenchmarkProbeOptions } from './application/benchmark-probe.js'

export {
  parseRunOutputManifest,
  parseRunOutputExport,
  type RunOutputManifest,
  type RunOutputIdentity,
  type RunOutputExport,
} from './adapters/hitch/run-artifacts.js'

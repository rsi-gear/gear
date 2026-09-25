import type { Algorithm, ArtifactRef, BudgetPlan, OperationProvider } from './contracts.js';
import type { FileArtifactStore } from './artifacts.js';
import type { JsonValue } from './schema.js';

/** Host-owned construction context. A profile grants capabilities; recipe JSON cannot do so. */
export type AlgorithmHostContext = Readonly<{
  campaignId: string;
  configDir: string;
  stateDir: string;
  config: JsonValue;
  budget: BudgetPlan;
  artifacts: FileArtifactStore;
}>;

export type AlgorithmHostProfile = {
  /** May construct a recipe such as GRPO whose constructor needs the artifact store. */
  algorithm?: Algorithm;
  providers: OperationProvider[];
  /** Host-sealed initial slot values. The profile must verify their provenance. */
  bindings?: Record<string, ArtifactRef>;
  /** Complete scientific configuration after host-sealed refs are added. */
  config?: JsonValue;
  /** Release host-owned model sessions, sockets, and workspace resources. */
  close?(): Promise<void> | void;
};

export interface AlgorithmHostProfileFactory {
  create(context: AlgorithmHostContext): Promise<AlgorithmHostProfile> | AlgorithmHostProfile;
}

export interface AlgorithmFactory {
  create(context: AlgorithmHostContext): Promise<Algorithm> | Algorithm;
}

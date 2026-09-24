# Failure-cluster GEPA on common operations (experimental)

This recipe runs one search round per `AlgorithmRuntime` campaign. The public `createGepaRound` helper seals the first round's seed and held-out universes, parent archive, bindings, settings, and evolution budget. After the campaign completes, `nextGepaRound` reads its sealed archive and active binding, increments the round index, and carries cumulative measured usage into the next round's budget. Use a fresh campaign ID and round ID for each round. Pending operations in an old `FailureClusterSearch` journal must finish under that same old runtime; this helper does not import uncertain work.

```ts
import { AlgorithmRuntime, BindingStore, FileArtifactStore } from 'rsi-gear/algorithm'
import {
  createGepaRound, nextGepaRound,
  GepaEvaluationProvider, GepaDiagnosisProvider, GepaGenerationProvider,
  createPhysicalGepaHooks,
} from 'rsi-gear/algorithm/gepa'
import { createWorkspaceEditAdapter } from 'rsi-gear/algorithm/harness'

const first = createGepaRound({
  campaignId: 'search-round-0',
  options: {
    evolutionId: 'search-study', roundId: 'round-0', roundIndex: 0,
    maxCandidates: 2, anchor, seed, heldOut, archive, settings,
    bindingSchema, snapshotBindings, artifacts, deadlineAt,
    // Optional: an admitted ParentSelectionPolicy. Pass the same policy to nextGepaRound.
    parentPolicy,
  },
  evolutionBudget,
})

// The host owns the restricted DSH context, exact model/role configuration,
// Git HarnessBuilder, CandidateWorkspaceManager, and their sealed identity.
// The editor is an inner physical service, not a second Campaign operation.
const editor = createWorkspaceEditAdapter({
  root: editorRoot, host: dshHost, sessions, artifacts, bindings,
  builder, workspaceManager, roles: [gepaEditorRole],
  hostRuntimeDigest, currentHostRuntimeDigest, accessPolicyDigest,
  campaignBudget: editorMeterBudget, requiredSlots: ['harness'], authorize,
})
const generationHooks = createPhysicalGepaHooks({
  root: generationRoot, artifacts, bindings, builder, editor,
  campaignId: first.spec.campaignId, roleId: gepaEditorRole.id,
  snapshotBindings: first.options.snapshotBindings,
  expectedMeterSource: editorMeterBudget['model.tokens'].source,
  hostIdentityDigest,
})
const providers = [
  new GepaEvaluationProvider(providerRoot, artifacts, bindings, physicalSearchProvider, archive),
  new GepaDiagnosisProvider(providerRoot, artifacts, bindings, physicalDiagnosisProvider),
  new GepaGenerationProvider(providerRoot, artifacts, bindings,
    generationHooks, generationHooks.implementationDigest),
]
const runtime = new AlgorithmRuntime(campaignRoot, first.algorithm, providers, first.spec)
await runtime.runUntilBlocked()

const completed = runtime.snapshot()
if (completed?.phase === 'complete') {
  const second = nextGepaRound(completed, nextArtifacts, {
    campaignId: 'search-round-1', roundId: 'round-1', deadlineAt: nextDeadlineAt,
    parentPolicy,
  })
  // Construct fresh providers and a new physical hook with second.options.snapshotBindings,
  // second.spec.campaignId, and operation-owned roots for this round.
}
```

`snapshotBindings` maps each archive snapshot digest to a BindingSet whose `harness` artifact seals that snapshot's exact Git commit and manifest. The first archive and all its snapshot bindings come from the trusted host or a completed prior campaign. A custom parent policy can be used with the round helpers when its frozen `ref` is supplied again on subsequent rounds. As with other in-process JavaScript hooks, the host must attest the policy's actual implementation and configuration; a policy ref alone does not prove a closure's source code. The three required operation kinds are `gepa.evaluate`, `gepa.diagnose`, and `gepa.generate`.

The common recipe calls the existing parent selector, failure clustering, scope sampler, archive builder, bridge selector, evidence profiles, and promotion gates. It stores stage results and research in the seed archive; held-out evidence is evaluated only after the seed gate and is not admitted into parent sampling. The evaluation provider verifies cached cells against the physical SearchProvider before reuse, freezes the missing-cell list before execution, and records separate rollout and repair-cell usage. A missing budget yields an explicit no-result outcome without a new physical evaluation. A stop-capability overrun records actual measured usage and ends the round before further work. Unknown submission or cancellation keeps the original operation pending; recovery inspects its original key rather than creating a new key.

The physical generation hook writes an intent before calling the restricted DSH editor. The model must use `workplan_read` and `diagnosis_read` for every assigned diagnosis ref, then edit through the operation-owned workspace tools. The editor checks and seals the actual Git harness. The hook verifies the checked artifact and physical snapshot, seals a workplan-consumption receipt, and maps the editor's final cumulative `model.tokens`/`model.requests` to the outer `gepa.generate` operation's `generationTokens`/`generationRequests`. Only that outer operation enters the Campaign budget ledger. A missing workplan read, missing diagnosis read, or invalid model result is a typed execution error with measured usage; it is not a scientific no-candidate. After a lost response, inspection is read-only. Only a confirmed `not-started` inner edit permits the kernel to resubmit the **same** outer key; unknown work remains pending. Cancellation of an unstarted inner edit writes a tombstone before releasing its zero reservation.

This path does not yet import extra finding handoffs from a legacy SearchJournal. Parent `findingRefs` must resolve to frozen `ResearchFinding` objects in `options.findings`; an absent ref rejects admission. `nextGepaRound` accepts `findings` to add newly sealed parent findings. The evaluation provider can complete missing process or objective raw metrics from the original run when its physical SearchProvider implements `completeProcess`; `inspectProcess` permits recovery after an uncertain response. It persists the original projection key and verifies that the completion does not change an already valid outcome. An unknown projection remains pending. If the old provider lacks the completion capability, the operation reports an explicit capability error with final usage; it does not turn missing evidence into a scientific loss. An invalid outcome cell can be evaluated again under the repair-cell budget. The old standalone `repairEvaluation` and legacy pending-completion import are not present. `tests/unit/algorithm-gepa-hooks.spec.ts` exercises the physical DSH tools, real isolated Git commit, outer receipt, and restart behavior with an offline model adapter; actual model quality and paper-level performance remain unverified.

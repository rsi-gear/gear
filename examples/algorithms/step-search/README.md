# One author API, several algorithms

These are small, executable teaching algorithms. Their control structures are inspired by GEPA, RHO/RRSI and DGM; they are not complete paper reproductions.

| File | Author-owned behavior |
| --- | --- |
| `best_of_n.py` / `best_of_n.ts` | Propose a batch, evaluate it, select the best valid result. |
| `gepa_style.py` | Feed a committed measurement into the next improvement and stop after finite rounds. |
| `rho_style.py` | Read real prompts, choose a coreset, compare candidates and apply a minimum-gain acceptance rule. |
| `dgm_style.py` | Retain evaluated nonwinners in a reproduction archive and visit different parents. |

Install the npm tarball and Python wheel built from this checkout using the [local-artifact quickstart](../../../docs/algorithm-author-cli.zh-CN.md), initialize with `gear algorithm init ./demo python`, and replace `algorithm.py` with one of these files. `check`, `run`, and `resume` all use `gear.algorithm.json`. The generated recorded host supplies four teaching tasks and deterministic candidate scores. Every example uses exactly the same services and host; changing algorithms requires no host/kernel branch.

State returned by `ctx.run` must contain all information needed after restart. Pure work in an uncommitted step can repeat. Module globals and library caches do not persist. `Result.ok` distinguishes infrastructure failure; `Evaluation.comparable` distinguishes valid measurements, including zero, from invalid/incomplete evaluation. Algorithms decide how to respond to each.

The TypeScript example is a real `.ts` module with State and Config types. `results.get<T>` is explicitly caller-typed. The package test compiles it with strict settings and runs the installed package.

## 物理执行

`physical-host.mjs` is an executable administrator-owned assembly. Copy it and an authorized `model.mjs` into the author project, provide `host.settings.json`, and replace `host:"recorded"` with:

```json
"hostProfile": {"language":"typescript","module":"./physical-host.mjs","export":"hostProfile"}
```

The settings contain these existing physical-service options:

| Field | Required contents |
| --- | --- |
| `builder` | HarnessBuilder options: exact Git repository, targetRoot, dshBaseRef, toolchainRef, sandboxProfileRef. |
| `compiler` | SubprocessHarnessCompiler options including command, fixed runtime scripts and sandbox/check-report settings. |
| `hitch` | HitchCliEvaluator options including repositoryPath, executable, isolated root, model, attempts, sampling and daemon controlPlane. |
| `workspace` | CandidateWorkspaceManager options except rootForEvolution; include allowedPaths and file/byte/diff limits. |
| `execution` | workspaceRoot, datasetRoot (standard compiled v1), initialHarness `{commitOid,manifestDigest}`, authorityId, taskBudgetMs, rolloutProviderDigest; optional repetitions/maxTrials/maxProposals. |
| `metaAgent` | Existing DSH role spec with runtime, preset, authorized model and sampling. |
| `editors` | Role ID to instruction/maxModelRequests/maxTokens/timeoutMs. Use `optimizer` for these examples. |
| `analysts` | Optional role catalog with inputSchema/resultSchema and the same finite model limits. |
| `operationLimits` | Reservations for execution.rollout, execution.workspace-edit, optional execution.role and metered evidence.query/read. |
| `runtimeResources` | Absolute or project-relative immutable model/compiler/runtime dependency files to fingerprint. |

`model.mjs` exports `async registerModel(llm, context)`, registering the real DSH adapter/plugin in that Context. `model.template.mjs` explicitly requires real administrator registration; it is not a model implementation. Use the adapter package and API verified in your authorized environment. Credentials stay in the existing host environment. The host checks the model route and fingerprints its configuration and declared resources; it cannot attest remote model weights.

Campaign budget uses the actual provider receipt sources. Existing Hitch commonly uses `hitch-rollout` for rollout.trials; model.requests/model.tokens share the configured DSH receipt source. Token accounting uses stop capability. Keep evidence reservations when those dimensions are metered. The task source is a verified, label-free ExperienceView; task selection, real prompts and role evidence tools share that source. Measured editor feedback must refer to a committed measurement of its parent.

All algorithms use this same assembly. The physical host does not know GEPA/RHO/DGM phases. The recorded package test does not claim a real model, compiler or Hitch result. A finite physical probe can use the baseline algorithm in the author guide, selecting one task, or best-of-N with n=1. SIGINT stops local observation; an unknown model turn may require external reconciliation.

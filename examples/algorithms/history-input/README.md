# Sealed history input for algorithm recipes

The host supplies an `ExperienceSourceAuthority`, an `EvidenceGrantResolver`, and a `TaskViewGrantResolver`. A recipe supplies only a source selector or sealed refs. It cannot grant itself access by placing a path, role ID, or permission flag in an operation input.

For an existing evolution with an old sealed `experienceSnapshot`, construct `LegacyEvolutionExperienceSource` with a trusted `RefineStateStore`, evolution ID, and snapshot round ID. Call `selector()` and then `sealExperienceView(...)`. The source cursor is the old snapshot digest; a changed round or missing immutable record fails import. The bridge emits **seed-summary** entries containing source identity and proposer claims only. It omits task IDs, runnable prompts, physical traces, rewards, effect classifications, held-out results, grader labels, and private feedback. A recipe cannot select these summaries as tasks. Older evolutions without a sealed `experienceSnapshot` need separate trusted admission; this adapter will not invent one.

For **real historical tasks**, `HistoricalSeedExperienceSource` separately verifies a registered evolution, saved round, compiled seed dataset and each task's content digest. It seals sanitized `instruction.md` text as a task/report. When the host selects an exact seed `evaluationId` already saved in that round and supplies a bounded `HitchTrajectoryReader`, it also verifies canonical SHA-256 and complete event-page coverage before sealing real `trace-chunk` projections. With no saved evaluation it grants only `overview`/`task-report`. Neither route exposes held-out, grader labels, rewards or private feedback to research roles.

For a **new Campaign without an old GEPA round**, `FreshSeedExperienceSource` instead admits the compiled seed dataset and exact initial Git Harness. Its task prompt/report is real, but `historyTraceAvailable=false` and there are no historical `trace-chunk` entries. The host grants only `overview`/`task-report`; new rollout events are read through a distinct role tool after verifying the completed producer's `evidenceRef` and `receiptRef`. Do not label a seed summary or an empty fresh projection as prior execution evidence.

The Python or TypeScript recipe can then issue these operations:

```json
{"kind":"evidence.query","input":{"viewRef":"<ExperienceViewRef>","asOf":{"namespace":"legacy-evolution:evo-1","value":"<snapshot digest>"},"projection":"overview","pageSize":10}}
{"kind":"evidence.read","input":{"viewRef":"<ExperienceViewRef>","asOf":{"namespace":"legacy-evolution:evo-1","value":"<snapshot digest>"},"contentDigest":"<returned content digest>"}}
{"kind":"tasks.select","input":{"experienceViewRef":"<Task-capable ExperienceViewRef>","tasks":[{"id":"<verified historical task ID>","purpose":"development"}]}}
{"kind":"tasks.consume","input":{"taskViewRef":"<TaskViewRef>","cursor":{"viewDigest":"<TaskViewRef digest>","nextIndex":0},"count":10}}
```

Refs above are placeholders for the full artifact-ref objects. The host grants `tasks.select` access to the exact experience view digest. The same host `TaskViewAuthority` signs the selected view; `tasks.consume` verifies that signature and the authorized experience root. The algorithm does not need to update a grant list between decisions. New final-test tasks cannot be selected or published by a recipe; they require independent trusted admission. A role's evidence tool facade binds its role ID when constructed and calls the same query/read service, including authorization, tokens, and receipts.

For Campaign budgets, `createEvidenceProviders(...)` derives `evidence.items` and/or `evidence.bytes` metering from the frozen Campaign budget. Each configured dimension must be reserved in the operation intent. A final operation-scoped receipt records actual use, including zero. Without these budget dimensions the page still reports usage, but Campaign spending is not limited by evidence usage. These providers currently reject a `hard` evidence budget; the available bound is `stop`.

`measurement.record` requires a trusted evaluator verifier. Its metric schema artifact has schema ID `measurement.metric-schema.v1` and this JSON shape:

```json
{"schemaVersion":1,"metrics":{"reward":{"unit":"points","minimum":0,"maximum":100}}}
```

The execution adapter validates actual loaded bindings, the physical provider identity, environment/sampling receipts, and evidence refs. [Physical host details](physical-host.md) and the [administrator setup](../host-setup/README.md) cover current Hitch rollout, DSH roles, trusted feedback, operation-owned workspace editing and verified Evo Skill overlay. Their integration tests use offline LLM adapters, real Git workspaces and a recorded Hitch CLI; no authorized live model or Hitch service run is claimed here.

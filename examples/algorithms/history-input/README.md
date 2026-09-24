# Sealed history input for algorithm recipes

The host supplies an `ExperienceSourceAuthority`, an `EvidenceGrantResolver`, and a `TaskViewGrantResolver`. A recipe supplies only a source selector or sealed refs. It cannot grant itself access by placing a path, role ID, or permission flag in an operation input.

For an existing evolution with an old sealed `experienceSnapshot`, construct `LegacyEvolutionExperienceSource` with a trusted `RefineStateStore`, evolution ID, and snapshot round ID. Call `selector()` and then `sealExperienceView(...)`. The source cursor is the old snapshot digest; a changed round or missing immutable record fails import. The bridge emits **seed-summary** entries containing source identity and proposer claims only. It omits task IDs, runnable prompts, physical traces, rewards, effect classifications, held-out results, grader labels, and private feedback. A recipe cannot select these summaries as tasks. Older evolutions without a sealed `experienceSnapshot` need separate trusted admission; this adapter will not invent one. Real historical task and trajectory projections require independent verified source readers, beyond this summary-only adapter.

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

The execution adapter validates actual loaded bindings, the physical provider identity, environment/sampling receipts, and evidence refs. It is only a port contract: a physical Hitch reservation/inspect/submit/cancel bridge and a role runner still have to be wired in before real model execution can be claimed.

# Understand results and evidence

Read coverage and scoring together. A useful improvement claim identifies the exact versions, comparable tasks and the decision that followed.

## Two Marketing metrics

The strict pass rate is the mean of `task_completed_correctly`: every scored assertion must pass for a task to count. Objective completion (`partial_credit`) averages the fraction of scored assertions satisfied per task and is diagnostic. It is not a trajectory-quality score and does not replace strict completion. Assertion exclusions can change the denominator; inspect verifier details before interpreting a change. See [upstream scoring](https://github.com/zapier/AutomationBench#scoring).

Report passed/valid tasks, invalid slots, physical executions and paired wins/regressions. Do not compare a nine-task local score directly with another candidate's different fifteen-task scope.

## Official Marketing references

The figures plot pass rate against objective completion and mark official private held-out references with `*`. Both reference metrics are Marketing-specific, retrieved on 2026-09-14:

| Official configuration | Pass rate · Zapier | Objectives completed · AA |
| --- | --- | --- |
| GPT-6 Astra max* | 50.00% | 83.68% |
| Gemini 3.8 Flash high* | 43.00% | 77.98% |

The horizontal coordinate comes from [Zapier's By domain → Marketing leaderboard](https://zapier.com/benchmarks). The vertical coordinate comes from [Artificial Analysis's Objectives Completed by Domain → Marketing](https://artificialanalysis.ai/evaluations/automationbench-aa). These combine separately published Marketing measurements, not two values attested to one run. Fable is omitted because the referenced domain table does not publish its Marketing pass rate.

AA's completion pools achieved objectives, regardless of guardrail violations. Our local `partial_credit` averages the fraction of all assertions satisfied per task, including guardrails. AA's headline Score is a different metric and is not plotted. The figure footnote records the source and scoring differences.

Our experiments use 100 public Marketing tasks that also supplied optimization evidence; the starred references use private held-out tasks. The overlaid points provide context and do not establish official SOTA. See the [public/private split](https://github.com/zapier/AutomationBench#public-vs-official-scores).

## Terminal-Bench 2.1 references

The README's leading-model scores for Terminal-Bench 2.1 come from the [official Terminal-Bench 2.1 leaderboard](https://www.tbench.ai/?version=2.1), using its Resolution Rate metric. Gear's scores come from our local evaluations.

## Read the decision and provenance

Check candidate commit/manifest, model and actual effort, dataset identity, runtime, valid slots and original failures. Retained candidates and champions serve different purposes. A human-authorized promotion after evidence repair should not be described as an uninterrupted automatic held-out success.

```bash
hitch --root /absolute/hitch-state eval inspect EVAL_ID --json
hitch --root /absolute/hitch-state trajectory inspect RUN_ID
```

Use the version-matched Hitch guide for query syntax and Rear for visual comparison. Rear should point at the same Gear/Hitch state roots. It is optional and read-only.

## Source artifacts

The examples ship exact Harness files, manifests, the final retained patch, Meta input text and a compact evidence index. [Chart data](../assets/marketing-results.json) records scope, source hashes, decisions and caveats. Downloadable bundles contain reviewed source and summaries, not credentials or full private control-plane logs. The published summaries do not replace native trial evidence for re-import.

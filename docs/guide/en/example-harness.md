# Example 1: evolve a harness for Marketing

Use Gear to improve an agent's Harness from real failure evidence. Five rounds raised Luna medium's strict pass rate from 27% to 36% on the public Marketing research set; the retained Harness later scored 50% with Luna max.

![Pass rate versus object completion: original DSH with Luna medium, Marketing evolution, separate max-effort evaluations, native Codex + Astra, and starred official Marketing model references.](../assets/marketing-harness-evolution.svg)

The horizontal axis is strict pass rate; the vertical axis is object completion (local `partial_credit`). Arrows connect retained iterations; the dashed arrow changes effort to max without another Meta round. Model references marked `*` use official held-out Marketing results: pass rate from Zapier and objectives completed from AA. [Metric definitions](results.md). The figures use zoomed axes with the same limits in both examples. [Chart data and sources](../assets/marketing-results.json).

## Initial prompt

```text
Use the Refine Skill to optimize the Harness for all 100 public
AutomationBench Marketing tasks.
Use Astra ultra as Meta and DSH + Luna medium for rollouts.
Run five rounds of optimization with the same model and evaluation settings.
```

## What changed across five rounds

| Round | Candidate pass rate | Retained champion | What happened |
| --- | --- | --- | --- |
| Initial | 27/100 | 27/100 | Original DSH with generic repository-task guidance. |
| 1 | 24/100 | 27/100 | Endpoint discovery followed by business-content reads. Evaluation result recovered after a CLI exit failure; the original failed round was preserved. |
| 2 | 33/100 | 33/100 | Source-backed business operations: read procedures, track scope and destination contracts. Originally accepted at 33/99; a later zero-score completion supplies this full-set point. |
| 3 | 36/100 | 36/100 | Resolve standing procedures, amendments and existing destinations before mutation. |
| 4 | 36/100 | 36/100 | Structured CLI request transport; partial credit improved, and the sealed zero-minimum-gain policy accepted it. |
| 5 | 34/100 | 36/100 | Record-set and payload consistency helpers; strict success fell, so this change was rejected. |

The final retained version is round 4, `8b651c53cadfe70de39078e93d8cb9c3958b9c38`. Round 5's changes are absent from the exported champion. The [chart data and notes](../assets/marketing-results.json) distinguish recovered evidence, completion and decisions.

## The last retained Meta change

Round 4 added `structured-cli-requests.md` and `structured-cli-requests/request.py`, then connected them through the policy and business-operations workflow. The helper serializes readable JSON into CLI arguments and checks UTF-8 round trips for encoded content. This targets content corruption caused by hand-written quoting or copied encodings; it does not resolve business rules or choose the correct records.

Read the [exact patch](../../../examples/automationbench-marketing/last-meta-change.patch). The mechanism is available to the Target through ordinary workflow reads, not a native Skill. Passing runtime checks shows the load path is valid; the experiment did not separately measure adoption of every helper in every trajectory.

The core instruction added to the workflow (excerpt from the actual patch):

```diff
+# Structured CLI requests
+
+Keep the reviewed request as readable JSON. Let code handle quoting, nested
+serialization, and encoding; carry encoded output directly into the destination
+call without copying it through a model message.
+
+Use this procedure only with the adapter, tool names, and argument schema
+provided by the current task. It does not discover endpoints, decide recipients,
+select records, or authorize writes. Resolve those with the operational workflow.
```

## The resulting Harness

```text
harness/
  plugins/policy.js
  preset/agent.cordis.yml
  workflows/source-backed-operations.md
  workflows/resolve-workflow-sources.md
  workflows/structured-cli-requests.md
  workflows/structured-cli-requests/request.py
  manifest.json
```

[Download the source bundle](../assets/marketing-harness-example.zip), [browse the source](../../../examples/automationbench-marketing/README.md), or verify the local checkout:

```bash
node examples/automationbench-marketing/inspect.mjs
```

The bundle includes the exact Harness source, historical manifest, retained patch, Meta input, provenance and inspection helper. To execute it, import it into a fresh carrier using the [integration lab](../../../examples/dsh-codex-luna/README.md). This creates new identities and new results; it does not recreate the original experiment by copying state files.

## Results and limits

Target model, medium effort, public task set and evaluation contract were fixed during the five rounds. The original and final full-set pass rates were 27% and 36%, a 9-point observed gain. Partial credit moved from about 75.37% to 81.19%.

A separate evaluation of the final Harness changed effort to max and scored 50/100, with 100 valid tasks. It involved no additional Meta round. Do not attribute the 36% → 50% increase to another Harness mutation.

Official model points appear on the same chart with `*`; their task scope and completion definition differ from this local experiment. These public tasks were used for optimization, so this case makes no independent generalization or official SOTA claim. See [scoring and comparability](results.md).

## Continue with a different algorithm

[Example 2](example-algorithm.md) begins from this exact 36% champion and explains a new search procedure. It has its own configuration, three-round record and resulting Harness.

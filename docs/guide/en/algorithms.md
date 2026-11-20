# Choose and run an algorithm

Complete algorithms are exported from `gear.algorithms`. Start with a recipe, then replace its components as your experiment requires. [Quick start](quickstart.md) prepares the Python package, project, benchmark and execution profiles used below.

| Algorithm | Main behavior | Feedback used by the algorithm |
| --- | --- | --- |
| [GEPA](#gepa) | Staged candidate search | Scored task evidence |
| [RandomSearch](#randomsearch) | Random parents and exploratory proposals | Scored task evidence |
| [OPRO](#opro) | Prompt updates from scored history | Scores and execution evidence |
| [ACE](#ace) | Incremental playbook updates | Scores and execution evidence |
| [RRSI](#rrsi) | Screen proposed edits before evaluation | Critic results and scored evidence |
| [DarwinX](#darwinx) | Prompt updates with fresh-sample confirmation | Scored evidence from additional executions |
| [Harness2](#harness2) | Continual learning across an ordered task stream | Target outputs and message trajectories; scores remain private |

## Common Python entrypoint

For a configured DSH project:

```python
from gear import Project
from gear.algorithms import ACE, GEPA, OPRO, RRSI, DarwinX, Harness2, RandomSearch

project = Project.open("./my-benchmark")
recipe = OPRO(prompt_path="prompts/system.md")
plan = project.plan_refine(algorithm=recipe, rounds=2)
print(plan)
run = project.refine(algorithm=recipe, rounds=2)
print(run.id, run.report.summary)
```

Choose one recipe from the sections below. Planning checks admission without model calls; running uses the project's [budgets](configuration.md#generation-and-diagnosis-budgets). In a notebook, use `await project.aplan_refine(...)` and `await project.arefine(...)` with the same arguments.

OPRO, ACE, RRSI, DarwinX and Harness2 default to Pi's `AGENTS.md`. For a standard DSH target, pass `prompt_path="prompts/system.md"`. The path must exist in the Target and be allowed by its mutation policy. GEPA and RandomSearch use the Target's authorized editable resources instead of this single prompt parameter.

All seven support the Python class entrypoint. The built-in CLI/YAML short names are currently `gepa` and `random-search`; the Python SDK captures the other classes and their configured components for the runtime. `gear algorithm test` covers those two recipes and parent policies, not every exported algorithm.

## GEPA

```python
recipe = GEPA(promotion_widths=(2, 1), global_gate="no_regression")
```

Search proceeds through local, bridge and global task scopes. `promotion_widths` controls how many candidates advance within each parent batch. `global_gate="no_regression"` requires bridge evidence at least as good as the parent's before the full seed evaluation. Candidate and evaluation budgets are separate settings.

Replace `parent_policy`, `sampler`, `proposal_planner`, `ranker` or `stop_rule`. The [4 → 2 → 1 tutorial](example-algorithm.md#configure-a-4-2-1-batch) explains scope growth and execution counts.

## RandomSearch

```python
recipe = RandomSearch()
```

RandomSearch uses random parent selection, exploratory proposals and full-task evaluation. Its default proposer does not need a separate diagnosis call. Custom proposal planners can explicitly enable diagnosis with `diagnose=True`.

It exposes the same parent, sampling, proposal, ranking and stopping components as GEPA. Use it when your experiment needs a simple search baseline with explicit evaluation and generation budgets.

## OPRO

```python
recipe = OPRO(prompt_path="prompts/system.md")
```

Each round proposes a prompt update from scored history, materializes the exact edit, evaluates it and compares it with the current prompt on a common task scope. `rounds=2` allows two proposal rounds, subject to available budgets.

A candidate must have complete evidence and satisfy the configured constraints. An eligible candidate can replace a current prompt that violates those constraints; otherwise it must improve the comparison score. ACE, RRSI and DarwinX share this adoption rule.

Replace `proposer`, `reader`, `editor`, `evaluator` or `ranker`. Reports expose the retained candidate and any final nomination/gate decision; a completed round does not imply that its proposed update was accepted.

## ACE

```python
recipe = ACE(prompt_path="prompts/system.md")
```

ACE proposes additions, replacements and removals to a playbook with stable entry IDs. It renders the proposed playbook into the prompt, evaluates the candidate and retains improving updates. The `merger` component controls how the playbook delta is applied; proposal, editing, evaluation and comparison components are also replaceable.

## RRSI

```python
recipe = RRSI(prompt_path="prompts/system.md")
```

RRSI adds a `ScreenedEvaluate` composition: exact edit checks, a Meta critic and a screening decision precede task execution. A rejected candidate consumes no target evaluation for that screening path; a critic call still uses the Meta budget. Replace `screen` or its components to change this behavior. [Component customization](example-algorithm.md) shows nested parameter updates.

## DarwinX

```python
recipe = DarwinX(prompt_path="prompts/system.md")
```

DarwinX builds on OPRO with confirmation enabled by default. It requests fresh executions for the anchor, current best and new candidate before confirming an update. These additional executions count against the target budget. Fresh execution describes the requested sampling behavior; statistical independence still depends on the provider's actual randomness.

## Harness2

Harness2 learns reusable target instructions from outputs and trajectories across an ordered stream. Configure blind access and the exact admitted seed task IDs:

```python
from gear import Project
from gear.algorithms import Harness2
from gear.core import AccessPolicy

project = Project.open("./my-benchmark")
task_order = ("sum-01", "sum-02")  # Replace with your admitted seed task IDs.
recipe = Harness2(prompt_path="prompts/system.md")
access = AccessPolicy(
    exposure="blind",
    rollout_backend="scored_private",
    task_order=task_order,
)
run = project.refine(algorithm=recipe, access=access, rounds=2)
print(run.report.summary["operators"]["outcome"])
```

Here `rounds=2` means two rollout-and-learning steps **per task**: two tasks produce four steps; ten tasks produce twenty. Each step uses the previous published instruction library. The task stream advances after learning is committed, so these dependent steps run in order.

When the target output is available but its trajectory is missing, reflection continues with the output alone. An unavailable target execution ends the algorithm with a failed outcome, without a Meta call for that step.

`scored_private` permits Hitch to score the target for operator-side reporting. Scores, expected answers and verifier feedback are hidden from the algorithm and its Meta calls. The result is a versioned instruction library, task outputs and stream progress; library publication is separate from champion promotion. See [reports](results.md#algorithm-and-learning-results).

Replace `rollout`, `reflect`, `reader`, `commit`, `publish` or `complete`. [Recovery](evolutions.md#retry-a-settled-read-only-meta-failure) preserves completed target outputs and published learning when an eligible reflection fails.

## Real-model validation

The validation completed on 2026-11-18 used ten AutomationBench Marketing tasks, Hitch/Codex + GPT 5.6 Luna low for Meta, and Hitch/DSH + the same model and effort for Target. Six algorithms ran two rounds; Harness2 ran two learning steps per task. Existing accepted runs were retained, and Harness2 continued in its original run.

| Algorithm | Observed execution result | Target observations |
| --- | --- | --- |
| GEPA | Two rounds, strict verification passed | 30 valid |
| RandomSearch | Two rounds, strict verification passed | 30 valid |
| OPRO | Two rounds, read-only verification passed | 30 valid; no rerun |
| ACE | Two rounds; one failed target checked separately | 29 valid + 1 invalid original; 1 valid supplement |
| RRSI | Two rounds, including critic rejection | 20 valid |
| DarwinX | Two rounds and final evaluation; one failed target checked separately | 89 valid + 1 invalid original; 1 valid supplement |
| Harness2 | 20 learning steps, 20 successful library publications | 20 valid; 9 reused from before recovery |

ACE and DarwinX's independent supplements do not replace their original failed observations or alter algorithm decisions. Harness2 preserved eight learning steps and nine completed targets, then added twelve reflections and eleven target executions. Its original failed reflection remains in usage accounting and is linked to the successful recovery.

The [validation summary](../assets/algorithm-validation.json) records source revisions, task IDs, run IDs, journal digests and counts. This verifies execution, accounting and recovery on a small task set. Valid observations include valid zero scores; these counts do not measure task pass rates, optimization gains or complete reproduction of the named papers. Historical Marketing performance results belong to their separately pinned experiments.

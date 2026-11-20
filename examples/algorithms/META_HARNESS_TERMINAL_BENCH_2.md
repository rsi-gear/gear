# Meta-Harness: Terminal-Bench 2

This example pins the official [Meta-Harness TB2 reference](https://github.com/stanford-iris-lab/meta-harness/tree/8123ccabe2b19fa1123090b2e5f1bacc20963ce8/reference_examples/terminal_bench_2) and its [TB2 proposer instructions](https://github.com/stanford-iris-lab/meta-harness/blob/8123ccabe2b19fa1123090b2e5f1bacc20963ce8/reference_examples/terminal_bench_2/.claude/skills/meta-harness-terminal-bench-2/SKILL.md).

## Reference-to-Gear mapping

| Mechanism | Pinned TB2 reference | Gear 0.2.4 adaptation |
| --- | --- | --- |
| Proposer | Claude Opus 4.6 analysis subagent reads scores, candidate source, and successful and failed trajectories, then proposes one general mechanism | One configured Gear Meta operation reads authorized full candidate snapshots, comparable seed scores, per-task outcomes, and captured agent-visible seed trajectories. Its model must be recorded from the selected provider profile. |
| Base selection | Proposer chooses an existing agent implementation or the baseline | Proposer returns `base_candidate_id`; Python accepts any complete candidate from this run. It does not choose by aggregate score alone. |
| Candidate count | One new agent variant for each iteration | One `GenerateCandidate` call per iteration. |
| Stopping | The reference requests exactly one variant per iteration; the outer loop controls the iteration count | Stop after the configured number of rounds, or when the generation budget is exhausted. A refused/failed proposer call consumes a round. |
| Evaluation | Full official set of 89 Terminal-Bench 2 tasks; default 2 trials per task | Pin the same 89-task manifest, then use Gear's deterministic holdout import (about 80% seed / 20% held-out task groups). Exact IDs are frozen in the generated split manifest; Meta sees seed tasks only. This narrows the search set relative to the official full-set path. |
| Budgets | Reference default: one search iteration, 2 trials per task, concurrency 50; optional full-evaluation winner pass uses 5 trials | Example pins one iteration and 2 repetitions. `gear.yaml` controls physical evaluations, concurrency/provider settings, and generation budgets. Gear's independent held-out promotion gate remains enabled. |

## Intentional differences

Gear does not launch the reference's analysis and implementation subagents, does not reproduce `pending_eval.json`, and uses its configured Meta/target providers in place of the reference's Claude Code plus Harbor/Runloop-or-Modal setup. Gear uses a single Meta diagnosis followed by a separate candidate-generation call. Gear also retains its independent held-out nomination gate. These are adaptation gaps; this implementation does not claim a paper reproduction or the reference's reported performance.

Candidate snapshots are exposed through Gear's authorized source material interface. It provides complete files up to the runtime's frozen 8 MiB total source-material limit (and 1 MiB per file); this preserves historical source that Gear's 64 KiB diff display omits. Captured baseline and candidate trajectories are passed from the `Execute` result's per-task records when their visibility is `agent` or `optimization`; evaluation-private artifacts are excluded. Missing baseline captures are labeled explicitly. Evaluation and evidence reads remain seed-scoped and page through Gear's evidence reader. Material beyond those runtime size limits is not readable by this algorithm and is a remaining fidelity gap.

## Prepare and run

Prepare a Gear project from the official [Terminal-Bench 2.1 dataset](https://github.com/harbor-framework/terminal-bench-2-1/tree/12b7565679ce5006230b820666353673a133db93), including its pinned `tasks/dataset.toml`. Gear's holdout import deterministically assigns task groups to seed and held-out partitions; keep the resulting `splits.json` and import digest with the run. Configure the Target profile to run the selected Terminal-Bench agent harness and the Meta profile for diagnosis/generation. Record the actual model identifiers, harness revision, concurrency, and costs in the resulting run report.

Set these project limits in `gear.yaml` before running:

```yaml
budget:
  rounds: 1
  max_candidates: 1
  repetitions: 2
  max_evaluations: 400
generation:
  max_model_requests: 20
  max_tokens: 120000
```

From the Gear checkout, install the CLI and Python SDK, initialize a project, import the pinned native Harbor tasks, and apply the reviewed import plan:

```sh
npm ci
npm pack
npm install --global ./rsi-gear-0.2.4.tgz
python -m pip install ./python
gear setup --hitch --target dsh --python python3.12
gear init gear-meta-tb2 --target dsh
cd gear-meta-tb2
gear benchmark import /path/to/terminal-bench-2-1/tasks --template harbor
gear benchmark import --apply import_REPLACE_WITH_PLAN_ID
gear benchmark check
```

After configuring the target and Meta profiles and the budgets above, run:

```sh
python /path/to/gear/examples/algorithms/run_meta_harness_terminal_bench_2.py "$PWD"
```

## Initial result

**Not run.** There is no valid baseline score, diagnosis, generated candidate, before/after score, or model cost for this v0.2.4 adaptation yet. Do not substitute the official paper result. Run the single-task bring-up first, then record each seed task's baseline and candidate outcome, the selected parent, the actual source change, model settings, and measured cost here after a live run.

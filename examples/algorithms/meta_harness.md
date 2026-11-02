# Meta-Harness: Terminal-Bench 2 reference mapping

This example pins the official Terminal-Bench 2 skill to
[`8123ccabe2b19fa1123090b2e5f1bacc20963ce8`](https://github.com/stanford-iris-lab/meta-harness/blob/8123ccabe2b19fa1123090b2e5f1bacc20963ce8/reference_examples/terminal_bench_2/.claude/skills/meta-harness-terminal-bench-2/SKILL.md).
The benchmark task IDs are pinned to the
[`terminal-bench-2-1` manifest at `dde3cd95b80ff25af5abd99a80b6513a018ad3b4`](https://github.com/harbor-framework/terminal-bench-2-1/blob/dde3cd95b80ff25af5abd99a80b6513a018ad3b4/tasks/dataset.toml).
The runner compares the planned seed IDs with the full manifest task-name set,
including missing, unexpected, and duplicate IDs; checking only the count is
not sufficient. This pins task membership, while the prepared benchmark and
the supplied revision label must still point to the corresponding immutable
dataset content. The selected variant evaluates all 89 tasks, defaults to two
trials per task, and requires one new agent variant on every iteration. Its
evaluation environment pins `HARBOR_MODEL` to
`anthropic/claude-opus-4-6`; the proposer is launched through Claude Code with
the `opus` alias, while the prompt names that same model. The proposer analyzes
results and successful and failed trajectories; the outer loop owns benchmark
execution.

## Reference-to-Gear mapping

| Mechanism                          | Pinned reference                                                                                                                                           | Gear behavior                                                                                                                                                                                                                                                                                                             | Relationship                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Proposer                           | Claude Code uses `model="opus"`, `effort="max"`, and a prompt naming `anthropic/claude-opus-4-6`; it chooses one general mechanism for one candidate       | Meta-Harness supplies a Python-owned prompt and schema that ask the proposer to inspect the seed archive, choose one eligible base, and describe one general mechanism; Gear requires the profile's declared model ID to identify Opus 4.6                                                                                 | Mechanism mapped; provider, model selection, and effort wiring adapted                         |
| Analysis/implementation delegation | The skill launches one Agent subagent to analyze the archive, then one Agent subagent to implement the selected candidate and write `pending_eval.json`    | Gear records separate `diagnose_seed` and `generate_candidate` operations, with one candidate per round; it does not launch nested Agent subagents or use the reference's `pending_eval.json` handoff                                                                                                                     | Mapped to Gear operations; nested subagent orchestration and handoff format are not reproduced |
| Target harness                     | Harbor runs the `TerminusKira` subclass of `Terminus2`; task-agent calls use `anthropic/claude-opus-4-6`                                                   | Gear runs its configured Target adapter on imported Harbor tasks; the Target profile is pinned to `anthropic/claude-opus-4-6`                                                                                                                                                                                             | Adapted; Gear does not execute the reference's Python `TerminusKira` class                     |
| Baselines/preflight                | Compares Kira and Terminus2 baselines; import-validates each proposal and runs a one-task smoke test before its full evaluation                            | Gear starts from one sealed anchor and admits candidates through its generation and seed-evaluation lifecycle; there is no equivalent one-task smoke-evaluation stage                                                                                                                                                     | Adapted; baseline set and candidate screening differ                                           |
| Parent/base                        | Proposer chooses a useful historical implementation after examining the archive                                                                            | Diagnosis receives every candidate with complete global seed evidence and its task scores; the proposer returns `base_candidate_id`; Gear validates that ID against the frozen eligible list and uses it as the generation parent                                                                                         | Mapped for candidates with complete comparable seed evidence                                   |
| Candidate count                    | One per iteration                                                                                                                                          | One global candidate per iteration                                                                                                                                                                                                                                                                                        | Mapped                                                                                         |
| Stop behavior                      | The skill runs one iteration and explicitly forbids stopping because the frontier looks optimal or aborting early; the outer loop owns benchmark execution | Gear creates one candidate per active Meta round, including when all seed tasks pass. Configured rounds and hard candidate/evaluation limits bound the Gear run                                                                                                                                                           | Adapted; Gear's run wrapper owns those additional bounds                                       |
| Evaluation                         | Full 89-task Terminal-Bench 2 set; two trials per task by default                                                                                          | Configure the project with the same 89 seed tasks and `repetitions: 2`; Gear independently enforces its held-out gate                                                                                                                                                                                                     | Adapted; no held-out examples are exposed to the proposer                                      |
| Historical evidence                | Baseline plus every evaluated candidate, scores, and successful/failed trajectories, including rejected candidates                                         | The first diagnosis receives baseline evidence, verified baseline source, and authorized baseline trajectory refs. Later diagnoses receive the paginated seed archive. Each record includes both successful and failed seed outcomes and trajectory refs; candidate source is available losslessly through `source` pages | Mapped within Gear's admitted seed scope                                                       |
| Evaluation gate                    | Reference benchmark loop                                                                                                                                   | Gear keeps its independent held-out promotion gate                                                                                                                                                                                                                                                                        | Intentional Gear adaptation                                                                    |

Each operation supplies its algorithm-specific prompt and response schema in
`Operation.payload.meta`. Gear's runtime handles the generic model call and
returns the fixed `{"declined": bool, "data": ...}` envelope. Meta-Harness
validates the response and the selected base in its own Python algorithm step;
the shared TypeScript adapter does not know Meta-Harness field names or parse its
search decisions.

The history reader exposes all seed-evaluated candidates in the frozen run
snapshot, not just selected parents. Use the `source` view for complete source;
`diff` is a compact convenience view and may omit a patch that exceeds its
bound. Pagination keeps each response bounded. Baseline source is copied into
the diagnosis sandbox read-only after verifying its sealed target digest.

Gear only permits a proposed base with complete global seed evidence, so
partially evaluated candidates remain visible in the archive but cannot become
parents. Gear also retains its independent held-out promotion gate and wraps
the reference's one-iteration action in Gear's bounded run lifecycle. These
are documented adaptations to Gear's evidence and promotion contracts. They do
not establish a performance reproduction; do not use the reference paper's
scores as Gear results. The target-harness adaptation also changes the agent
implementation surface: the reference evolves a Python `Terminus2` subclass,
while this Gear example evolves its configured Target artifact through the
adapter. Treat those scores as separate experiments even when they share task
IDs and model.

## Runnable experiment

Fetch the official task source at the pinned commit:

```sh
git clone https://github.com/harbor-framework/terminal-bench-2-1.git
git -C terminal-bench-2-1 checkout dde3cd95b80ff25af5abd99a80b6513a018ad3b4
```

Provide a separate Harbor task directory for Gear's promotion gate. It must not
reuse a task ID, family, exact instruction, or input file content from the 89
reference tasks. The helper verifies those boundaries, checks out no files, and
copies both sources into a new working tree while writing `metadata.split =
"seed"` or `metadata.split = "held_out"` into each copied `task.toml`. The source
directories remain unchanged. These extra tasks are an intentional Gear
adaptation and are excluded from the reported 89-task reference evaluation.
Make each task's declared Docker images available locally so Gear can record
their registry digests.

```sh
python /path/to/gear/examples/algorithms/prepare_meta_harness_tb2.py \
  --dataset-repo /path/to/terminal-bench-2-1 \
  --heldout-source /path/to/independent-harbor-tasks \
  --output /path/to/prepared/tasks
```

The helper requires a clean dataset checkout at the pinned commit and verifies
that its `tasks/dataset.toml` names match all 89 reference IDs before copying.
It prints the resulting split counts and IDs. Keep the held-out source revision
or digest with the eventual run report.

In the Gear checkout, build the CLI and install its Python package:

```sh
npm ci
npm run build
python -m pip install -e python
```

Initialize a Gear project, copy
[`meta_harness_tb2.project.yaml`](meta_harness_tb2.project.yaml) to its
`gear.yaml`, and set its target and Meta profile IDs. Then preview/apply the
native Harbor import:

```sh
node /path/to/gear/lib/cli.js init /path/to/project --target pi
cp /path/to/gear/examples/algorithms/meta_harness_tb2.project.yaml /path/to/project/gear.yaml
node /path/to/gear/lib/cli.js --project /path/to/project benchmark import /path/to/prepared/tasks --template harbor
node /path/to/gear/lib/cli.js --project /path/to/project benchmark import --apply <plan-id-from-preview>
```

Applying the import updates the benchmark path in `gear.yaml`. Review the split
preview, then use the runner's `--plan-only` mode below; it verifies the exact
89 task IDs are in `seed` before any evaluation. The runner defaults to and only
accepts the matching revision label
`terminal-bench/terminal-bench-2-1@dde3cd95b80ff25af5abd99a80b6513a018ad3b4`.
Set both the Meta proposer and Target profiles to Claude Opus 4.6
(`claude-opus-4-6` for the proposer and `anthropic/claude-opus-4-6` for the
task agent). This pins Gear's declared model IDs; proposer execution still uses
Gear's provider and session wiring instead of Claude Code's `opus` alias and
`max` effort setting. Configure the highest effort supported by the selected
Meta provider and record that value with the results; Gear's provider-specific
effort controls do not guarantee Claude Code's exact `max` behavior. The
imported seed split must contain the 89 reference
tasks, with a separate held-out set for Gear's final gate. The runner refuses a
plan unless it has all 89 reference
tasks in the seed split, two repetitions, one candidate slot per requested
round, a separate held-out set, and enough physical trials for the full seed
evaluations plus the final gate. It records at most two Meta operations per
round (one diagnosis and one generation); use that as the generation request
budget and record the Meta token usage from the final report. The Codex Meta
provider cannot enforce an aggregate token cap before a model call, so this
example does not claim a hard token budget; do not configure one unless the
selected provider advertises and enforces that capability.

```sh
python -m pip install -e /path/to/gear/python
python examples/algorithms/run_meta_harness_tb2.py --project PATH/TO/PROJECT --rounds 10 --proposer-model "<exact Meta profile model>" --evaluation-model "<exact target profile model>" --plan-only
python examples/algorithms/run_meta_harness_tb2.py --project PATH/TO/PROJECT --rounds 10 --proposer-model "<exact Meta profile model>" --evaluation-model "<exact target profile model>" --output tb2-meta-harness.json
```

The runner records the pinned reference, dataset source revision, compiled Gear
benchmark digest, and model identifiers,
seed task IDs, held-out count, requested rounds, candidate/generation/evaluation
budgets, explicit `metaSampling` temperature and reasoning effort, dry-run plan,
Gear run ID, and final report in the output JSON. The
model labels must exactly match the `meta.profile` and `target.profile` used by
the project. The runner reads the selected profile files and checks that both
proposer and Target use the pinned Claude Opus 4.6 model. Its output records both
profile names and model IDs; Gear's plan contains their provider identities.
`--rounds` is the
maximum number of algorithm rounds. Score-frontier completion and all-pass seed
outcomes do not by themselves stop Meta-Harness; the run ends at its configured
round limit or when Gear's candidate, evaluation, or generation capacity cannot
fund another iteration.

## Current local outcome

No live Terminal-Bench 2 run or model evaluation has been performed for this
change. The checked-in result is therefore `not run`; no pass rate, cost, or
paper comparison is claimed. After a run, preserve the JSON report and record
the exact project configuration, model identifiers, dataset revision, task
split, seed, total evaluations, generated candidates, costs, per-task outcomes,
and held-out result alongside it.

The CPU-only local conformance command is:

```sh
PYTHONPATH=python python -m gear algorithm test meta-harness
```

It checks Gear's deterministic algorithm contract. It does not run the
benchmark, call a model, or establish performance fidelity.

The current local conformance results are `status: passed`, 5 algorithm steps,
with operations `evaluate_seed:global`, `diagnose_seed:global`,
`generate_candidate:global`, two comparable `evaluate_seed:global` operations,
and `nominate:global`. The focused archive, Meta-Harness, and runner suite also
passes all 37 Python tests. These are implementation checks; the Terminal-Bench
experiment remains not run until a configured project, pinned task dataset,
and model profiles are available.

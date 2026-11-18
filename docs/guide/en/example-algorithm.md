# Customize an algorithm in Python

Complete algorithms are available in `gear.algorithms`. Reusable strategies live in
`gear.search`: parents, sampling, proposal, ranking, stopping and workflow.
GEPA and RandomSearch compose these shared capabilities. Other operations are
available from `core`, `evaluation`, `memory` and `training`.

## Start with parameters

Begin with a [complete algorithm](algorithms.md). Components support `get_params`, `set_params` and `clone`, including nested configuration before a run starts:

```python
from gear.algorithms import RRSI
from gear.core import clone

recipe = RRSI(prompt_path="prompts/system.md")
recipe.set_params(screen__edit_check__max_changed_bytes=32_768)
variant = clone(recipe)
print(variant.get_params(deep=True)["screen__edit_check__max_changed_bytes"])
```

Cloning copies component configuration, not learned state. Configuration is frozen at admission; changing an object does not change an existing run. Use a new configured recipe for a new experiment, or [resume](evolutions.md) to continue the original one.

## Replace a component

For GEPA, replace the parent policy with a named function:

```python
# my_policy.py
from gear.search.parents import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain("no eligible parent")
    return ParentPlan.single(rng.choice(view.eligible, key="parent"), view.candidate_limit)
```

```sh
python -m gear algorithm test my_policy:select_parent
python -m gear algorithm test gepa
python -m gear algorithm test random-search
```

```python
from gear import Project
from gear.algorithms import GEPA
from my_policy import select_parent

run = Project.open(".").refine(algorithm=GEPA(parent_policy=select_parent), rounds=1)
print(run.report.summary)
```

The three tests require only the base Python package and make no model calls.
A real project needs the npm runtime and configured execution profiles. In a
notebook use `await project.arefine(...)`.

Use the [six-module index](../../search-algorithm-authoring.zh-CN.md) to locate
implementations and typed contracts. Policies consume authorized seed views and
return JSON state plus explicit operations. The runtime owns budgets, execution,
evidence identities, the held-out gate and champion CAS.

Admission freezes source and declared dependencies. Local functions, lambdas
and undeclared dependencies are not resumable algorithm configurations. Changed
code gets a new identity. Historical TypeScript selector/search subpaths are
no longer public exports.

## Compose operators

Pure operators such as `ApplyEdits` and `CheckEdits` return values directly. External operators such as `Meta`, `Evaluate` and `Rollout` return a `Call`, executed after a `Decision` submits it. Read results using the saved call reference. This minimal algorithm performs one review and returns its result; save it as `review_algorithm.py`:

```python
from gear.core import Meta, MetaInput
from gear.search import Algorithm, Decision, Terminal


class Review(Algorithm):
    def __init__(self, critic=None):
        self.critic = critic if critic is not None else Meta(
            "Review the target instructions and explain one possible improvement.",
            {"type": "object", "properties": {"reason": {"type": "string"}},
             "required": ["reason"], "additionalProperties": False},
        )

    def step(self, view, state):
        if state.data.get("pending"):
            result = view.results.require(state.data["pending"])
            return Decision(
                state, reason="review finished",
                terminal=Terminal("stop", outcome={
                    "status": result.status, "review": result.value,
                }),
            )
        call = self.critic(
            MetaInput(view.anchor, tuple(task.id for task in view.tasks)),
            key="review/0",
        )
        return Decision(state.updated(pending=call.ref), (call,), "request review")
```

```python
from gear import Project
from review_algorithm import Review

run = Project.open(".").refine(algorithm=Review(), rounds=1)
print(run.report.summary["operators"]["outcome"])
```

The review consumes Meta budget without modifying or evaluating the Target; check the outcome status before using its value. Split dependent external work across steps and save call references and phases in state so recovery can continue from them. A `Call` itself cannot be awaited or executed. See the [operator author guide](../../algorithm-operators.zh-CN.md) for offline component checks, material access, screening, libraries and task streams.

## Configure a 4-2-1 batch

`GEPA(promotion_widths=(2, 1))` is the default: within each parent batch,
rank candidates on the same local scope and send up to two to bridge, then
send the top eligible bridge candidate to global seed evaluation. These are
candidate limits, separate from the task sampling ratios. Expansion does not
require a candidate to score strictly above its parent. Disqualified candidates
remain excluded; incomplete evidence for any participant prevents the batch
from advancing. The runtime applies the final acceptance gate separately.

Global seed evaluation is the largest stage: at 100 tasks it accounts for 60 of
the 170 new candidate cells in a 4 → 2 → 1 batch. With
`GEPA(global_gate="no_regression")`, a bridge candidate reaches it only if its
bridge score is at least its parent's on the same tasks; ties advance. When
every bridge candidate regresses, the batch ends without global evaluation and
the candidates stay in the research archive. The default `"any"` keeps the
behavior described above.

For a project with a configured benchmark, Target and execution profiles, use
this `gear.yaml` to allow four generated candidates in one round:

```yaml
version: 1
benchmark: ./benchmark.yaml
target: {adapter: dsh, path: ./target, profile: default-target}
meta: {profile: default-meta}
algorithm: {name: gepa, options: {promotion_widths: [2, 1]}}
objective: {metric: pass_rate}
validation: {mode: research}
budget: {rounds: 1, max_candidates: 4, max_evaluations: 400, repetitions: 1}
```

The default parent policy makes one batch. A 4 → 2 → 1 run also needs four
actionable proposals, successful generation and sufficient Meta and evaluation
budgets. `budget.max_candidates` limits generation across the entire run;
`ScopedFrontier(batch_count=...)` controls parent batches, while
`promotion_widths` applies independently to each batch. Multiple batches can
therefore produce multiple global candidates. New runs freeze their configured
options; existing runs resume with their original options. See [configuration](configuration.md)
for budgets and independent held-out validation.

With the default sampler, sufficiently populated task pools give 8% local +
4% shared + 3% cross tasks, then 40% bridge and 100% global. Counts round up,
and the actual local union may be smaller when pools are exhausted. For one
batch with four eligible candidates, nested scopes, one repetition per task
and reuse of valid cells, the candidate-only cost is:

| Seed tasks | Local tasks per candidate | Bridge tasks | New candidate executions |
| --- | ---: | ---: | ---: |
| 100 | 15 | 40 | `4 × 15 + 2 × (40 − 15) + (100 − 40) = 170` |
| 1,000 | 150 | 400 | `4 × 150 + 2 × (400 − 150) + (1,000 − 400) = 1,700` |

Baseline, parent scope completion, held-out and repair executions are additional
and share the run budget. The YAML's 400-attempt limit is an illustrative
100-task research budget, not a cost guarantee. If a stage cannot fit its
remaining budget, the flow stops without shrinking the frozen scope or
exceeding the limit.

The historical Marketing experiment used the same 4 → 2 → 1 candidate limits,
but its pinned [TypeScript source](../assets/staged-search-source.zip) created
separate local scopes for failure families and allocated bridge places by
family rotation. The current Python workflow ranks a parent's batch on one
shared local scope and has its own nomination and acceptance rules. Matching
the widths does not reproduce the full historical algorithm; historical
results are not measurements of the current Python implementation.

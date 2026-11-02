# Customize an algorithm in Python

The author API is `gear.algorithms`. GEPA and RandomSearch share six contracts:
parents, sampling, proposal, ranking, stopping and stage composition. GEPA is
an instance of these common module contracts.

Replace its parent policy with a named function:

```python
# my_policy.py
from gear.algorithms import ParentInput, ParentPlan, RandomSource


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

## Configure a 4 → 2 → 1 batch

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

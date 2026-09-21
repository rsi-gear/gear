# Raw metrics and Refine objectives

Refine retains the benchmark's original results and calculates a separate
`objective_score` from the user's weights. The supported execution path is
`failure-cluster-gepa-v1`. New admissions on a legacy execution path are rejected;
existing evolutions keep their frozen behavior when continued.

Pass the definition through `control.start` (including `gear-refine request`):

```json
{"objective":{"terms":[{"metric":"pass_rate","weight":0.5},{"metric":"process_score","weight":0.5}]}}
```

The formula is `Σ weight × (raw metric / scale)`. Scale defaults to 1 and must be
positive. Weights may be negative; Gear neither normalizes them nor clips the
score. Use a fixed scale of 100 when combining a 0–100 process score with a 0–1
pass rate. To penalize usage, add a declared metric such as
`{"metric":"total_tokens","weight":-0.1,"scale":100000}`. Original units and
values remain available. This is a configurable quality/efficiency objective,
not the official SoL-Pi formula.

Omission selects strict pass rate. The dataset must explicitly declare how a
trial passes. Neither a positive reward nor a score range implies success.
Constraints are optional; without them the weights allow tradeoffs. For example:

```json
{"metric":"pass_rate","rule":"no_regression","reference":"initial_baseline","tolerance":0}
```

Place that entry in `objective.constraints` to preserve initial quality. The
reference is the initial harness in the same partition, not the current
champion. Constraint failure preserves the score and blocks promotion. The
optional search setting `promotion.objective` specifies `minimumGain`,
`maxSeedRegression`, and `maxHeldOutRegression`, all zero by default. Global seed
improvement must exceed the minimum; `allowNeutral` explicitly permits a tie.

## Dataset contracts

Add a versioned registry to `benchmark.adapter.json`. For a benchmark whose
documented pass predicate is exactly `total_score == 1`, a declaration is:

```json
{
  "raw_metrics": {
    "schema_version": "1",
    "metrics": [{
      "id": "pass_rate",
      "revision": "1",
      "unit": "ratio",
      "direction": "maximize",
      "source": {"path": "scores.totalScore", "extractor": "equals-v1", "equals": 1},
      "range": {"min": 0, "max": 1},
      "granularity": "trial",
      "repetitionReducer": "mean",
      "taskReducer": "weighted-mean",
      "comparisonPrecision": 1e-9
    }]
  }
}
```

Use the benchmark's actual predicate. `boolean-v1` accepts an explicit boolean;
`number-v1` preserves a finite numeric metric. Source paths address `scores`,
`rewards`, the complete imported `originalResult` row, or the imported `verifier`
artifact (for example `verifier.result.rewards.quality`). The adapter preserves
verifier artifacts for successful and failed runs and verifies their run and
trial/attempt bindings. Selecting a verifier metric requires that capability;
missing or corrupt verifier evidence cannot supply an available metric. Standard total/process
channels are registered from the manifest's scoring declarations; no process
channel is invented for total-only datasets. Arbitrary custom IDs use the same
registry and can be selected directly without registering a scoring profile.

Usage declarations additionally require a `measurement` contract covering kind
(`actual`, `api-equivalent`, `counter`, or `wall-clock`), scope, provider/model
identities, price snapshot for monetary metrics, token accounting, time boundary
and retry attribution. The runtime must actually emit the declared source. Gear
retains the full source row even when no objective uses its fields; it never
interprets absent usage as zero or estimates missing cost from a metric name.

All nonzero terms and constraints must support the same per-trial scope. Trial
values are averaged within each task, then combined with frozen task weights.
Global and held-out use uniform task weights. Repetitions do not change task
weight. `observationTotal` is a separate physical ledger total; the objective uses
the task mean `value`. Dataset-only aggregates cannot drive a staged frontier.

## Evidence and reuse

The returned `resolvedObjective` contains the frozen contracts and formula.
Seed status and Meta assignments expose `rawMetrics`, contributions and the
separate `objectiveScore`. Trial `passStatus` reports `passed`, `failed` or
`unavailable` from the declared predicate. Private original artifacts stay behind their existing
access boundary; held-out evidence never enters the research archive or Meta
baseline. Missing or invalid selected metrics block scoring; an invalid original
envelope cannot be rescued using an embedded number.

`experiments.tsv` includes `seed_raw_metrics` and `seed_objective` JSON columns.
The objective column identifies a local or seed-evaluation scope and retains the
formula, score, contributions and constraint results. Compare local candidates
only within the same scope. Held-out decisions remain in the private round record.

The public `resolveObjective`, `aggregateRawMetrics`, and `scoreObjective` APIs
can calculate a different weighted score from compatible stored raw evidence
without running a task. Changing weights leaves raw execution identities intact
and produces a new objective/evidence identity. Start a new evolution for search
under that definition; continue/resume cannot replace an existing objective or
reuse its old rankings and promotion decisions.

For example, using a saved seed profile and its universe:

```ts
import { resolveObjective, scoreObjective } from 'rsi-gear'

const objective = resolveObjective({ terms: [
  { metric: 'pass_rate', weight: 0.8 },
  { metric: 'process_score', weight: 0.2 },
] }, universe.rawMetricContracts)
const rescored = scoreObjective(objective, profile.rawMetrics, profile.objectiveScore.scopeDigest)
```

This creates new derived evidence without mutating the profile or executing a
rollout. An objective with `no_regression` also requires its frozen, matching
`initial_baseline` as the fourth argument.

See the [complete contract](refine-objective-spec.zh-CN.md) and
[Skill protocol](../skills/refine/references/protocol.md).

# Gear user guide

These pages describe Gear 0.2.2 and its project-based API.
Python defines optimization policies; the durable runtime executes evaluations,
candidate generation, recovery and final validation. The CLI, Python SDK,
native DSH Skill and project socket use the same application service.

## Choose an entrypoint

- [Quick start](quickstart.md): create an editable benchmark, check it without model calls, then run one task.
- [Python algorithms](example-algorithm.md): write a search workflow or replace a GEPA parent policy.
- [Target harness](target-harness.md): choose native DSH or Pi resources.
- [Model training](training.md): use `gear.training` with its independent experiment lifecycle.

## Algorithm entry points

Each recipe in `python/gear/algorithms/` has an `algorithm.py`. Read ADAS for a draft-and-reflect workflow, RandomSearch for a single global comparison, or GEPA for staged promotion. The author API is `gear.algorithms`. The runtime persists operations, accounts for budget and applies the acceptance rules.

Training lives in `python/gear/training/`, separated into contracts, loop,
storage, runtime, backends, data, script entrypoints and related responsibilities.

## Verification scope

Static benchmarks, CPU policies, native DSH/Pi extension loading and installed
package offline journeys have coverage. The production Meta runner, authentication
setup, real-model journey and advanced metric migration remain in progress; see
the [implementation record](../../refactor-progress.zh-CN.md). Historical Marketing
examples describe their pinned research experiments, not current setup instructions
or independent held-out performance evidence.

Continue with [configuration](configuration.md), [tasks](datasets.md),
[run management](evolutions.md), [reports](results.md) and [troubleshooting](troubleshooting.md).

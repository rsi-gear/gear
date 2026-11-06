# Gear user guide

These pages describe Gear 0.2.2 and its project-based API.
Python defines optimization policies; the durable runtime executes evaluations,
candidate generation, recovery and final validation. The CLI, Python SDK,
native DSH Skill and project socket use the same application service.

## Choose an entrypoint

- [Quick start](quickstart.md): create an editable benchmark, check it without model calls, then run one task.
- [Python algorithms](example-algorithm.md): replace a parent policy or edit the six shared algorithm modules.
- [Target harness](target-harness.md): choose native DSH or Pi resources.
- [Model training](training.md): use `gear.training` with its independent experiment lifecycle.

## Six algorithm modules

| File | Responsibility |
| --- | --- |
| `parents.py` | Parents, sampling probabilities and candidate quotas |
| `sampling.py` | Seed task sets and weights |
| `proposal.py` | Diagnosis and candidate planning |
| `ranking.py` | Candidate comparison over complete, shared scopes |
| `stopping.py` | Termination |
| `algorithm.py` | Stage order and policy composition |

GEPA and RandomSearch instantiate the same public contracts. TypeScript owns
execution and fixed validation; it does not expose a second algorithm author API.
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

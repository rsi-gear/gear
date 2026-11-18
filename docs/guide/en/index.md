# Gear user guide

Gear provides callable Python algorithms and reusable operators for improving agent harnesses. This guide describes the APIs in this Gear 0.2.2 source tree; use the matching source build in [quick start](quickstart.md). Python defines the algorithm, while the runtime coordinates execution, budgets, persistence and recovery.

## Choose your next step

- [Quick start](quickstart.md): install the CLI and Python SDK, prepare a project and run an algorithm.
- [Choose and run an algorithm](algorithms.md): GEPA, RandomSearch, OPRO, ACE, RRSI, DarwinX and Harness2, with examples and their feedback requirements.
- [Customize an algorithm in Python](example-algorithm.md): change parameters, replace components and compose operators.
- [Tasks and scoring](datasets.md): define task rewards and benchmark inputs; [configuration](configuration.md) controls aggregate objectives and budgets.
- [Runs and recovery](evolutions.md): continue saved progress, retry an eligible failed reflection and inspect accounting.
- [Reports](results.md): read candidate scores, learning outputs, library publications and task-stream progress.
- [Target harness](target-harness.md) and [Meta integration](meta-agents.md): configure execution through Hitch.
- [Model training](training.md): use the separate experimental `gear.training` lifecycle.

## Where capabilities live

| Python entrypoint | Purpose |
| --- | --- |
| `gear.algorithms` | Complete algorithms passed to `Project.refine` |
| `gear.core` | Components, state, Meta calls, candidate materialization and edit checks |
| `gear.evaluation` | Task execution, evidence and candidate comparison |
| `gear.memory` | History, archives, playbooks and versioned instruction libraries |
| `gear.training` | Training data, model updates and training workflows |
| `gear.search` | Search strategies, screening and workflow composition |

The six search strategy modules are `parents`, `sampling`, `proposal`, `ranking`, `stopping` and `workflow`. For example, `ApplyEdits` and `CheckEdits` come from `gear.core`; they are reusable capabilities rather than complete algorithms. Pure operators return values directly. Operators that need external work return calls for the runtime to execute.

## Verification scope

All seven algorithms have small-scale real-model execution coverage on ten AutomationBench Marketing tasks, with two rounds per algorithm and two steps per task for Harness2. The [algorithm page](algorithms.md#real-model-validation) distinguishes strict checks, ACE/DarwinX's independent target supplements and Harness2's continuation from saved learning state. It also links the recorded source revisions and journal digests.

These checks establish execution, budget accounting and recovery. Historical Marketing performance examples describe their separately pinned experiments. Model training retains its own [verification scope](training.md#verification-scope).

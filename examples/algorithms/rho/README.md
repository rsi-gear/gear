# RHO recipe host profile

`algorithm.py` changes the history coreset policy in one Python file. The
recipe reads only an authorized, sealed ExperienceView through `evidence.query`
and `evidence.read` (`overview`, `task-report`, and `trace-chunk` projections),
selects real historical tasks through `tasks.select`, and
uses repeated baseline rollouts, directory proposals and paired unlabeled
self-preferences. A candidate is accepted only when its mean preference is
positive. The `harness` binding must be a `harness.directory.v1` artifact.

The host must supply an ExperienceView, TaskView authority, binding provider,
and physical `execution.role`, `execution.rollout`, `execution.feedback`, and
`execution.workspace-edit` providers. Its frozen Campaign config must reserve
each metered provider dimension in `operationLimits` by operation kind, using
the matching Campaign budget/source. This directory is an author template;
the current standalone CLI has no host-profile factory for those capabilities.
The CPU tests validate recipe state and sealed operation wiring. They do not
claim a live model run or paper reproduction.

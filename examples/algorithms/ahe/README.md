# AHE recipe host profile

`algorithm.py` exports the delayed-measurement AHE loop. A round first measures
the revision actually executed, verifies predictions against per-task changes,
investigates sealed reports and attribution, optionally rolls back files, then
proposes the next revision. `bestMeasured` remains separate from an unmeasured
proposal. The host must bind a `harness.directory.v1` artifact and supply
TaskView, evidence (`task-report` and `trace-chunk` projections), rollout,
feedback, role and workspace-edit providers. The frozen Campaign config must
reserve each metered kind's dimensions in `operationLimits` with the matching
budget/source.

This is a host-profile template pending the CLI's physical-provider factory;
it is not a claim of a live Hitch/model run or paper reproduction.

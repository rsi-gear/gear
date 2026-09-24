# Evo-Harness recipe host profile

`algorithm.py` exports replayable TaskView batches. The `skills` binding is
frozen for each batch; retrieved skill artifact refs must be physically injected
into a rollout, feedback is gathered for every task, and a curator can add,
merge, revise or skip skills. The cursor and new skill binding are committed in
the same decision. The host must provide a `skills.library.v1` binding, a
TaskView authority, and physical role/rollout/feedback providers.
The frozen Campaign config must reserve each metered provider dimension in
`operationLimits` by operation kind.

The current Hitch adapter has no verified dynamic skill-injection port, so
this template cannot be presented as a live model run. CPU recipe tests use a
controlled port and do not reproduce paper results.

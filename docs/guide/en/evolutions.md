# Runs and recovery

Commands accept `--project DIRECTORY` and `--json`. A standalone evaluation
also has its own run and budget ledger.

```sh
gear evaluate --split seed --limit 1
gear refine --rounds 1
gear report RUN_ID
gear resume RUN_ID
gear cancel RUN_ID
gear export RUN_ID
```

`resume` recovers the original run, inspecting existing submissions first and
reusing saved decisions. An unknown submission outcome is not an unsubmitted operation.
`cancel` persists the request and propagates it to the provider; inspect the
report for confirmation. Service shutdown preserves recoverable state and is
different from a user cancellation.

`export` requires a completed run and verifies the retained snapshot before
exporting its target, manifest and report. Repeated exports return the same
location; modified existing exports are rejected.

A new `refine` creates a new run inheriting the current promoted candidate.
Resume does not add rounds or replace an algorithm. Provenance preserves the
relationship to previous candidates, evaluations and usage.

The natural-language entrypoint uses the same operations. Socket `run.refine`
and `run.evaluate` accept stable request IDs: retry a lost response with the
same ID and parameters to recover the same run. Different parameters cause
an admission conflict. See the [control plane](../../harness-agnostic-refine-skill.md).

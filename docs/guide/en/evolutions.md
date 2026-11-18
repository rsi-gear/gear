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

## Retry a settled read-only Meta failure

Ordinary `project.resume(run_id)` continues an unfinished run. A v2 algorithm can also explicitly retry a failed read-only Meta call while its algorithm state remains at that call, including a run that stopped with a failed outcome. The runtime confirms the old execution stopped, the receipt matches and all usage is known before reusing target outputs, the learning library and saved state.

First inspect `gear report RUN_ID --json`. Supply the actual `run_id` and `failed_operation_id` below. The failed request's `request.operationId` is in `operations` in `.gear/runs/RUN_ID/journal.json`; inspect this record without editing it. It differs from a call ID in `operators.calls`. Replace the illustrative limits with the new cumulative limits approved for that run:

```python
from gear import Project

project = Project.open(".")
recovered = project.resume(
    run_id,
    retry_operation=failed_operation_id,
    generation={
        "max_tokens": 1_000_000,
        "per_operation": {"max_tokens": 300_000},
    },
)
print(recovered.id, recovered.report.summary["meta_recoveries"])
```

`max_tokens` is the run's total limit including historical consumption, not an additional allowance. This example sets a total of 1,000,000 and a per-operation limit of 300,000. Omitted dimensions retain their previous limits; limits can only be explicitly increased. Omit `generation` if the existing allowance is sufficient. Editing project configuration does not amend an old run's budget.

The CLI accepts the same request; `generation.json` contains the `generation` object above:

```sh
gear resume RUN_ID --retry-operation FAILED_OPERATION_ID --generation-config generation.json
```

Recovery retains the run ID, frozen specification, all old operations and their usage. Exact historical journal bytes are checkpointed; a new attempt receives a new operation ID. `meta_recoveries` records the link, and `recovered_operation_ids` lists only failures with successful successors. Repeating the same failed ID and options does not create another attempt. If the new attempt fails, explicitly select its new failed ID.

This entrypoint applies to v2 read-only `Meta` calls. It does not apply to candidate generation, unknown usage, metering violations, user-cancelled runs, advanced algorithm state or incompatible execution conditions. Unknown outcomes must first be inspected through ordinary recovery, not resent as settled failures. Target repair counts, rounds and target budgets retain their original limits.

## Binding changes after a Hitch restart

When only the host environment binding changes, add `environment_binding=original_public_binding` to the recovery request above, or use CLI `--environment-binding-config FILE`. This is the original public binding, not credentials. The runtime must prove that model, code, resources, task artifacts, capabilities, credential-variable selection and Meta identity are unchanged before recording the old and new actual execution identities. Historical results stay intact; later samples use the new identity.

This continues the Gear algorithm and retries the failed reflection. It does not resume an internal Codex session or allow arbitrary model/code changes in an old experiment. See the [operator author guide](../../algorithm-operators.zh-CN.md#调用与恢复) for binding fields and complete constraints.

The natural-language entrypoint uses the same operations. Socket `run.refine`
and `run.evaluate` accept stable request IDs: retry a lost response with the
same ID and parameters to recover the same run. Different parameters cause
an admission conflict. See the [control plane](../../harness-agnostic-refine-skill.md).

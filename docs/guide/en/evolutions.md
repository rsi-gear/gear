# Run and manage evolutions

Start a new experiment, inspect its state, then explicitly continue, repair or publish the result. The examples below are DSH Skill invocations.

## Start and inspect

```text
/refine --rounds 1 --name marketing --focus workflow,tool
/refine status
/refine status EVOLUTION_ID
/refine status EVOLUTION_ID ROUND_ID
```

Replace IDs with returned values. A plain `/refine` always creates a new evolution. `--budget MILLISECONDS` sets the per-trial timeout, not total spending or the Meta generation deadline. `--from initial`, `--from published` or an exact commit selects the starting version.

Watch generation, evaluation coverage and terminal decisions. A completed round can retain its old champion. A failed control-plane operation does not by itself establish a candidate's quality.

## Continue the sealed experiment

```text
/refine continue EVOLUTION_ID --rounds 2 --focus workflow
```

Only `--rounds` and `--focus` can be changed on continue. The experiment keeps its datasets, models, budgets, runtime and component identities. The default path creates candidates from the current accepted champion. An unpromoted candidate does not become the next code parent merely because its research record remains visible.

## Repair evaluation slots

```text
/refine rerun EVOLUTION_ID ROUND_ID --eval EVAL_ID --invalid
/refine rerun EVOLUTION_ID ROUND_ID --eval EVAL_ID --task TASK_ID
```

Use status to identify repairable evidence. With multiple attempts, task repair covers each invalid or missing attempt for that task while preserving valid slots. Direct mode requires Hitch 0.2.5+; daemon mode requires 0.2.6+ and an active daemon for that state root. Credential wrappers may impose stricter limitations.

Do not restart the original launch script to repair a running evaluation. Inspect the existing IDs first. The staged research path has an additional archive evidence-completion lifecycle; see [Example 2](example-algorithm.md).

## Publish or roll back

```text
/refine publish EVOLUTION_ID
/refine rollback EVOLUTION_ID EXACT_ACCEPTED_COMMIT
```

Automatic promotion updates an evolution champion under its sealed policy. Publish changes the workspace default; rollback selects a previously accepted version for that evolution. They are explicit operator actions. Keep the distinction when interpreting a historical manual promotion.

## Standalone clients

The external Refine Skill uses `control.start`, `control.status`, `control.continue`, `control.rerun`, `control.publish` and `control.rollback`. Field names and envelopes are defined in the [protocol reference](../../../skills/refine/references/protocol.md). Start with the Skill rather than translating DSH command text into guessed JSON.

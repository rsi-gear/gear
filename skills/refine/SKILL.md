---
name: refine
description: Create, evaluate, refine, inspect, resume, cancel, and export a Gear benchmark project through the shared CLI, Python SDK, or native DSH project service. Use when the user asks to improve an agent harness with measured task results.
---

# Refine a Gear project

Use Gear as the authority for project state, sealed candidates, evaluation,
algorithm decisions, budgets, and champion acceptance. You operate the project;
its configured Meta and Target profiles execute separate managed jobs.

For Kaggle/MLE-bench research projects, also read
[the data-analysis harness protocol](references/data-analysis-harness.md).
The analysis provider maps one seed slot to five sequential experiments and one
fixed C5 delivery. Use the current Project API with `validation.mode: research`;
Python algorithms own selection and promotion.

## Connect

Use the native `refine_request` tool when available. It calls the same application
service as `gear` and Python `gear.Project`. Read
[the project protocol](references/protocol.md) before constructing tool calls.
The operator session's model settings do not replace the project's Meta profile.

Otherwise use the `gear` CLI in the selected project directory, or pass
`--project DIRECTORY`. A persistent server is optional; normal CLI commands
manage their own run. Check `gear --help` when the executable or project is unclear.
Do not ask the user to assemble socket messages or fill implementation digests.

## Work through the project

1. For a new project, run `gear setup`, inspect `gear doctor`, then
   `gear init DIRECTORY --target dsh|pi --template text|files` as needed.
   Dependency availability, model authentication, and successful evaluation are
   separate facts. Use `gear profile create` and `gear profile use` (or the
   corresponding `profile.*` methods) to configure them. Never request key values;
   accept environment variable names or provider auth-directory references.
   Doctor's local login check does not prove remote model access. Report missing
   preparation from actual diagnostics before the authorized smoke run.
2. For existing tasks, use `gear benchmark import SOURCE` (native Harbor adds
   `--template harbor`). Review the proposed task split and apply its plan ID.
   Keep families together and use `--research` only when shared-set research is intended.
   Inspect `gear config explain` and run `gear benchmark check`. Preview a task
   with `gear benchmark preview TASK_ID`; inspect its positive and negative
   verifier fixtures. Help the user edit ordinary task data and intent config.
   Use `gear benchmark probe --scorer` for a seed environment build and container
   verifier self-test without a model. Building may download dependencies. Native
   Harbor tasks without declared fixtures report scorer `not_run` explicitly.
3. Run a seed smoke test with `gear evaluate --split seed --limit 1`. Report its
   actual coverage. One successful task is not a complete baseline.
4. Inspect `gear refine --rounds N --dry-run` or `run.plan` and explain task
   scope, repetitions, verified baseline reuse, physical attempt and Meta limits,
   and any final-validation budget warning. Preview does not create a run or call
   a model; admission rechecks current inputs and freezes its own plan. Continue
   the authorized experiment with `gear refine --rounds N` or `run.refine`.
   A reused smoke slot covers only that task/repetition; historical usage stays
   separate from the new run's budget. Do not turn preview into an additional
   approval step when the user already authorized execution.
   The Python algorithm chooses parents, tasks, proposals, ranking, and stopping;
   the runtime admits operations, validates evidence, and applies the final gate.
   Never infer an improvement from a candidate's explanation alone.
5. Read `gear report RUN_ID` or `run.report`. Distinguish valid zero scores,
   scoring failures, environment failures, and missing evidence. Surface the
   observed budget, gate, retained target, and next action.
   Use `gear archive RUN_ID` or `run.archive` for seed-only scope comparisons and
   historical parent/ranking records. Task leaders are descriptive; do not treat
   them as a newly computed final parent distribution or a promotion result.
   Use `experience.query` / `experience.read` for actual-parent seed edit outcomes
   and verified diffs. Preserve snapshot_digest for pagination. Trajectory content
   currently reports not_captured; do not interpret an empty list as no history.
6. For an interrupted run, resume its exact ID. Do not start a replacement run
   simply because a reply was lost. For a background creation request, choose a
   stable `request_id` and reuse it on retry; a changed request needs a new ID.
   A run marked `needs_recovery` requires explicit `run.resume`.
7. Cancel with `gear cancel RUN_ID` when asked. A client disconnect does not
   cancel a background run; stopping its service leaves recoverable state.
8. Export a completed run with `gear export RUN_ID`. Export is a local artifact;
   publishing it or deploying it elsewhere is a separate user action.

## Editing and evidence

Use [the Target guide](references/target-harness-editing.md) to understand resource
boundaries, and [the DSH guide](references/dsh-target-harness.md) for DSH-specific
composition and hooks. Pi uses native `.pi` resources and `AGENTS.md`.

Prepare author changes in the project's public Target source. Do not edit
`.gear` journals, frozen algorithm sources, target manifests, or sealed candidates.
A new source or algorithm version starts a new run; resume uses frozen inputs.
Keep credentials in provider-supported profile/auth locations.

Use seed observations to diagnose and propose changes. Independent held-out data
belongs to the final acceptance gate, and must not become optimization feedback.
When configuration explicitly selects research mode, clearly report that it is
shared-set research without independent validation.

## Algorithm authors

All strategies live in Python. Each recipe has the same six files: `parents.py`,
`sampling.py`, `proposal.py`, `ranking.py`, `stopping.py`, and `algorithm.py`.
Use public `gear.algorithms` contracts and the offline testkit. A named importable
Python function can replace one policy without changing TypeScript. Run
`gear algorithm test` before an experiment, and preserve the algorithm's declared
source and package dependencies in its frozen identity.

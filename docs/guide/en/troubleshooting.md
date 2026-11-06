# Troubleshooting

Save the run ID and call `gear report RUN_ID --json` first. Do not edit journals,
delete ownership locks or replace sealed files to bypass recovery checks.

| Symptom | Action |
| --- | --- |
| `python-not-configured` | Run `gear setup --python python3.12` or configure an explicit `GEAR_PYTHON` |
| `profile-unavailable` | Check profile names and directory; complete model authentication separately |
| `unknown-config-field` | Use the current project schema and `gear config explain` |
| `budget-baseline-unaffordable` | Increase the physical attempt budget or reduce task scope in a new run |
| `admission-conflict` | Reuse original parameters when retrying an ID; use a new ID for a new experiment |
| `state-busy` | Wait for the owner; do not delete an active service's socket or lock |
| `needs_recovery` / unknown provider outcome | Repair the provider and `gear resume RUN_ID`, preserving operation IDs |
| `evaluation_repairs.blocked` | Check retry/budget exhaustion, repair the environment and start a new run with revised limits; resume cannot increase the original allowance |
| `frozen-repair-policy-missing` | This run lacks the current frozen repair policy; preserve its evidence and create a new run instead of editing the journal |
| `evidence_projections.blocked` | Check unsupported provider/metric, disabled projection or exhausted attempts; unavailable channels remain explicit and are never rerun for a better score |
| `hitch-projection-source-changed` | Original provider fields were rewritten; preserve the sealed receipt and investigate the source instead of replacing it |
| `changes.status: unavailable` | Frozen Target resources or configuration could not be verified; scores/accounting stay readable, but export requires intact sealed resources |
| `algorithm-message-too-large` | Inspect the numeric request/limit and view, evidence, completed, state and algorithm byte counts; unchanged oversized input cannot succeed on retry |
| `algorithm-handshake-mismatch` | Check the runtime and frozen worker protocol/identity; the 64 MiB runtime deliberately rejects an old 4 MiB worker |
| Identity mismatch | Preserve evidence; restore the correct dependency or start a new experiment identity |
| Scorer or environment failure | Repair scoring/execution; do not treat this as a valid model zero |

Doctor reports dependencies, provider capabilities, images and local credential sources separately.
`not_configured` means the referenced credentials are missing; `provider_managed` requires custom-provider checks.
`model_access: not_checked` means remote authorization is unverified, even when local prerequisites allow an attempted smoke test.
See the [implementation record](../../refactor-progress.zh-CN.md) for actual
model, GPU and container-extension verification.

The Python algorithm protocol limits each request and response to 64 MiB
(67,108,864 bytes), including the UTF-8 JSON envelope and trailing newline.
Both ends must advertise exactly the same limit. Gear retains all verifier
observations, raw metrics, completed results and algorithm state. The per-verifier
16 KiB bound does not bound their total; arbitrary raw metrics, completed data or
state can still exceed the frame limit. Large frames also need memory for JSON
serialization, validation and parsing within the decision timeout.

New runs freeze the current Python protocol source into their implementation
identity. Existing runs resume their original frozen source and recorded identity;
installing this capacity change alone does not recover a run frozen at 4 MiB.
Preserve its evidence and use a compatible runtime, create a new run, or prepare a
separate reviewed migration that accounts for the immutable identities. The
runtime does not replace frozen source or rewrite a journal to pass the handshake.

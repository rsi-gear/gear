# Troubleshoot a run

Inspect the existing evolution and evaluation IDs before starting replacement work. Preserve the evidence that explains the failure.

## Symptoms and next actions

| Symptom | Check | Next action |
| --- | --- | --- |
| No `/refine` in DSH | Plugin enabled, Skill catalog and model configuration | Follow plugin setup; load the packaged Skill. |
| Socket connection fails | Server ready output and `GEAR_REFINE_SOCKET` | Use the returned path and keep that server alive. |
| Identity mismatch | Runtime, full Skill bundle, model and sampling | Restore the sealed identity or create a new evolution. |
| `initialChampion is required` | Target bootstrap output | Supply exact ref and manifest; do not invent digests. |
| Manifest mismatch | Imported source, substrate and generated manifest | Re-bootstrap new source; do not rewrite old evidence. |
| Candidate runtime is `not_checked` | Compiler/report protocol/runtimeRoot | Configure the real checker and inspect each coverage stage. |
| No candidate assignment yet | Baseline progress and generation state | Baseline may still be running; inspect status. |
| Meta timed out during diagnosis | Remaining failed runs and generation budget | Use allowed recovery; a new attempt does not erase round limits. |
| Hitch evaluation failed | Doctor, native result, verifier and invalid slots | Repair supported slots using the existing evolution/eval IDs. |
| Candidate declined or not promoted | Diagnosis and comparison | This can be a valid outcome; inspect the rationale. |

## Useful checks

```bash
hitch eval doctor --json
gear-refine request control.status '{}'
node examples/automationbench-marketing/inspect.mjs
```

Run the request command only with an active standalone server/socket. For DSH use `/refine status`. A stale `running` projection is not enough to decide whether to restart work; inspect the execution's actual result and lifecycle.

## Evidence and recovery boundaries

Valid score zero means the task failed its assertions. Missing verifier evidence, container startup errors and invalid trajectory records require diagnosis; they should not be silently scored as model failures or retried as a whole dataset.

A stale lease must no longer be used. The Skill handles recoverable API actions in order. If the response requires operator action, fix that concrete cause rather than editing Gear state JSON. The [detailed operations guide](../../plugin-installation-and-usage.md) covers platform and legacy issues.

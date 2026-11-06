# Editing the Target Harness

The Refine Skill is the project operator entrypoint. Start a run through
`run.refine`, inspect `run.report`, and use `run.resume` or `run.cancel` for an
existing run. Candidate generation belongs to the configured Meta provider;
there is no Meta lease or candidate editing method on this control plane.
The methods and retry rules are in [protocol.md](protocol.md).

## Adapter boundaries

Use the selected Target adapter, its mutation policy, and the exact parent
snapshot. DSH and Pi have different native layouts:

| Adapter | Editable resources | How they are loaded |
| --- | --- | --- |
| DSH | `preset/`, `plugins/`, `prompts/`, `skills/`, `workflows/` | Cordis preset connects plugins; the fixed patch supplies Skill discovery |
| Pi | `AGENTS.md`, `.pi/settings.json`, `.pi/extensions/`, `.pi/skills/`, `.pi/prompts/` | Pi discovers these project-local resources |

For DSH, read [dsh-target-harness.md](dsh-target-harness.md) before changing a
hook or its registration. Pi extensions export a default function accepting
`ExtensionAPI`; they do not use Cordis plugin rows. Pi settings cannot redirect
packages, extensions, skills, prompts or themes outside the sealed resources.

Dependency manifests, lockfiles, Git metadata and `manifest.json` are fixed.
Symlinks, hardlinks and path escapes are rejected. Core rebuilds
content identities and manifests; a model-supplied digest is not authoritative.
Never edit `.gear/` snapshots, stored evidence or run journals directly.

## Evidence before an intervention

The Meta provider receives seed task contracts and the authorized seed feedback
for its operation. Expected answers remain private to the verifier; held-out
tasks and results are not an input to the search algorithm or Meta diagnosis.
The operator's `benchmark.preview` is an authoring tool and must not be used to
add private answers to a Meta prompt.

Trace a failure through the task instruction, Target decision, tool result and
verification. Distinguish a missing check, a check of the wrong property, lost
context, an ineffective procedure and an environment failure. A truncated
report is not evidence that the Target saw truncated content. Use the available
seed evidence before attributing a failure to the harness.

A proposed intervention should explain the causal gap, the editable mechanism
that addresses it, and the observations that could disprove the hypothesis.
Choose reusable behavior rather than embedding benchmark answers. Environment
or scorer failures require repair; they are not a reason to teach the Target
to evade evaluation.

## Proposal and validation

Python's proposal planner defines the hypothesis and scope. The Meta provider
applies its proposed changes to the reserved candidate derived from the exact
parent. Core verifies the parent, checks the adapter's resource boundary and
validates the native configuration before sealing a new immutable candidate.

Directory membership alone does not mean a resource is active. A DSH prompt
asset needs a loaded plugin; a workflow file needs an explicit connection.
A Pi extension must use the selected runtime's API. Preserve the working
composition and verify the connection made by each new resource.

Review the exported resources and the run report for comparable seed scores,
valid coverage, invalid slots and actual consumption. Static configuration checks,
real runtime loading and model behavior provide different evidence. A passing
load check does not show that a model used the Skill or that every custom hook
executed. Record those limits when interpreting a result.

Only a fixed final nominee reaches the core-owned validation gate. An
independent held-out result cannot be fed back into the same search to choose
another nominee. Export the accepted result with `run.export`; core verifies
the sealed content and produces an immutable export.

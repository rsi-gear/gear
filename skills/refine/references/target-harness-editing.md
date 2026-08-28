# Editing the Target Harness

Use this guide after claiming a Meta assignment and before changing candidate
files. The protocol and schemas are in [protocol.md](protocol.md).

When the candidate manifest or tree identifies Gear's DeepSeek Harness carrier,
read [dsh-target-harness.md](dsh-target-harness.md) before choosing a file or
hook. It documents the locked DSH version, the actual load graph, all five
editable roots, native tool interception APIs, and complete wiring examples.

## Authority and workspace model

The Meta Agent is optimizing the Target Agent's harness, not solving the seed
task itself. Gear creates a private candidate from an exact parent commit and
exposes it as `/candidate/harness` through structured calls.

There are two distinct read surfaces:

- `harness.current` and `harness.read` inspect the immutable parent described by
  its manifest. Use them to establish the exact baseline identity and, when
  useful, compare parent bytes.
- `candidate.tree` and `candidate.read` inspect the mutable candidate copy. All
  edits must go through `candidate.write`, `candidate.edit`, or
  `candidate.remove`.

Never inspect the host checkout, candidate worktree, Git repository, Gear state,
Hitch state, credentials, or held-out dataset directly. A path exposed in an
error or response is not authorization to access it.

## What can be changed

Only these top-level roots are editable:

| Root | Typical responsibility | Common semantic targets |
| --- | --- | --- |
| `preset/` | Composition and registration of harness resources | routing, context, tool, skill, workflow |
| `plugins/` | Prompt injection, hooks, tool wiring, policies, verifiers | context, pre_action, routing, post_action, action_verifier, tool, compaction |
| `prompts/` | System/developer prompt fragments and reusable instructions | context, routing, compaction |
| `skills/` | Target Agent skills and their supporting references/scripts | skill |
| `workflows/` | Multi-step Target Agent procedures | workflow |

The table is a routing aid, not a filename convention. Inspect the candidate
tree and existing composition before deciding which artifact controls the
observed behavior. In particular, directory membership never proves that DSH
loads a resource; its DSH-specific composition must make the resource live.

The following are fixed substrate and cannot be edited: `manifest.json`, Git
metadata, package manifests, dependency lockfiles, files outside the five roots,
symlinks, hardlinks, and binary files. Do not try to bypass these boundaries.
Gear rebuilds artifact hashes and the harness manifest when it seals a valid
candidate.

## Evidence-to-edit workflow

### 1. Establish the assignment

Record the assignment's `roundId`, `candidateId`, `parentHarnessRef`, baseline
summary, trials, advisory focus, and evidence policy. The advisory focus narrows
attention but does not override observed evidence.

Call:

1. `harness.current` to obtain the exact parent manifest;
2. `candidate.tree` to discover editable resources;
3. `seed_tasks.load` to understand the public seed contracts;
4. `hitch.status` or trajectory index mode to confirm the baseline evidence.

Do not assume a standard harness layout beyond the five editable roots.

### 2. Diagnose every failed baseline run

A failed run is a baseline trial with zero/negative reward, `errored` status, or
an explicit failure record. Query every such run by its returned `runId`.

Start at `offset: 0` with a small `limit`. The first page includes diagnostics
such as event counts, tool errors, and final-message excerpts. Page with the
returned `nextOffset`; a byte bound can make a page shorter than the requested
limit. Read only as far as needed to identify the causal chain:

```text
task contract
  -> Target Agent decision
  -> tool/action result
  -> verification performed or omitted
  -> observed failure
```

Distinguish these cases:

- **Harness-controllable behavior:** missing context, poor routing, unsafe
  pre-action behavior, unexamined tool output, weak verification, a misleading
  skill/workflow, or compaction loss. A candidate edit may be justified.
- **Target task implementation bug with a reusable harness cause:** change the
  general instruction, hook, skill, or verifier that led to the mistake; do not
  encode the task's answer.
- **Infrastructure or invalid evaluation:** do not edit the harness to mask it.
  Finish the active assignment only as the evidence allows; after the round
  reports a repairable failed evaluation, `control.rerun` may be used for the
  exact advertised slot.
- **No supported causal link:** decline the candidate.

Held-out task identities, trajectories, and rewards are intentionally
unavailable. Do not infer or optimize for hidden task contents.

### 3. Choose a generalizable intervention

Before editing, state internally:

- the exact observed behavior that caused the failure;
- the evidence reference and relevant event(s);
- the harness artifact that controls that behavior;
- why the proposed change should alter that behavior;
- what unrelated behaviors must remain unchanged.

Prefer the smallest change that breaks the causal chain. Avoid:

- task names, expected answers, grader details, or literal patches for a seed
  task;
- broad rewrites when one existing policy or resource is responsible;
- duplicating an instruction already present elsewhere;
- adding a file without registering or referencing it;
- changing multiple semantic targets without evidence for each;
- claiming an expected score or guaranteed improvement.

Use `semanticTargets` at finalization to describe the actual behavior changed,
not merely the directory edited.

## Safe mutation patterns

Every update uses optimistic concurrency. A read returns a SHA-256 digest; the
matching digest must be supplied when editing, overwriting, or removing that
file. If Gear reports that the file changed, read it again and reassess rather
than retrying with a guessed digest.

### Modify an existing file

1. `candidate.read` the file.
2. Use `candidate.edit` with enough `oldString` context to make it unique and
   the returned `expectedDigest`.
3. Read the file again when another edit to the same file is required, because
   the previous digest is now stale.

Example arguments, excluding the lease envelope:

```json
{
  "path": "plugins/policy.js",
  "oldString": "exact unique observed text",
  "newString": "replacement text",
  "expectedDigest": "sha256:<digest returned by candidate.read>"
}
```

Use `replaceAll: true` only when every occurrence is intentionally equivalent.
For a whole-file rewrite, use `candidate.write` with the current digest instead
of trying to construct a fragile edit.

### Create and connect a resource

Create a file with `candidate.write` and `expectedDigest: null`. Then update the
existing preset, plugin, skill, or workflow that loads it. Inspect the local
composition syntax; do not invent registration syntax from another harness.

```json
{
  "path": "prompts/compatibility.md",
  "text": "Focused reusable guidance.\n",
  "expectedDigest": null
}
```

A created but unreachable resource is not a complete candidate. If connecting
it would require a protected package/dependency change, decline instead.

### Remove a resource

First remove every live reference from editable composition files. Then read the
resource and call `candidate.remove` with its current digest. Never remove a
shared resource solely because one seed trajectory did not use it.

### Multi-file changes

Read each file independently and retain its own digest. Apply edits in dependency
order: implementation/resource first, registration second, removal last. After
each mutation, use the newly returned digest for any further operation on that
file.

## Validate the candidate

Call `candidate.diff` before the compiler check. Review the authoritative patch,
not a reconstruction from memory. Confirm:

- every changed file supports the stated causal hypothesis;
- no seed answer, hidden-task guess, credential, host path, or unrelated cleanup
  entered the patch;
- new files are connected and removed files are no longer referenced;
- the patch fits within the existing fixed toolchain and dependencies;
- `semanticTargets` and `expectedOutcome` describe the diff accurately.

Then call `candidate.check` with `{"check":"compiler"}`. This is the fixed
candidate build/validation pipeline; it does not prove task improvement. If it
fails, repair only the candidate defect reported by the check, then inspect the
diff and check again. Never bypass the check or modify the manifest manually.

## Finalize or decline

Finalize only after:

- the baseline summary has been observed;
- every failed baseline run has been queried at least once from offset zero;
- the evidence supports the proposed causal link;
- the diff is coherent and nonempty;
- `candidate.check` succeeds.

The rationale should name the observed failure pattern and why this exact
harness change addresses it. `expectedOutcome` should state a measurable
behavioral expectation without promising a score. Cite only baseline `evalId`
or `runId` values actually returned and inspected in the active assignment.

Decline when evidence is inconclusive, behavior is not harness-controllable, the
only possible edit would expose a seed answer, or the required change needs
protected substrate. A decline still requires an evidence-based rationale and
the observed baseline references. Never create a cosmetic diff merely to avoid
declining.

Finalization or decline concludes the assignment. Stop using that lease and poll
`control.status`; Gear owns compilation sealing, candidate evaluation, held-out
gating, selection, and promotion.

## Worked reasoning example

This example illustrates the method, not a universal rule. Suppose a public
interface task uses an underspecified integer type. The trajectory shows that
the Target Agent silently chooses a narrow representation and self-tests only
small values. A generalizable candidate could strengthen an existing
verification policy to surface interface ambiguity and test boundary/external
compatibility. Hard-coding the wider type, naming the task, or embedding grader
expectations would be seed-specific and should not be proposed.

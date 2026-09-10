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

Start with the compact diagnostic card. It shows the task, verifier failure,
and the final 80,000 characters of the chronological message transcript while
omitting raw stream chunks and protocol metadata. Each tool-result preview is
at most 2,000 characters. Use `earlierRef` for messages before the window and
expand `detailRef` for a complete long result; use `find` when searching is more
efficient than paging it.
Read only as far as needed to identify the causal chain:

```text
task contract
  -> Target Agent decision
  -> tool/action result
  -> verification performed or omitted
  -> observed failure
```

Locate what the Target Agent actually received and could act on. Missing or
truncated output, lost state, misleading tool semantics, and an incorrect
skill/workflow are different from misinterpreting complete, correct evidence.
Expand relevant previews before attributing missing information to the harness:
the diagnostic card's truncation does not prove the Target saw truncated output.

Check what the verification actually established, not just whether a command
ran or returned zero. Compare its inputs, assertions, execution conditions, and
artifact with the public task requirements and the observed failure. Distinguish
a missing check from a check of the wrong property. Check for conflicts between
the public contract and the evaluator before treating a rejected result as an
agent failure; evaluator-only knowledge must not become candidate behavior.

Classify the failure and assess intervention opportunities separately:

- **Supported harness gap:** trace the decision to a specific instruction,
  interface, routing, state, or feedback defect in the current harness. Explain
  how an editable mechanism would change what the Target sees or does there.
- **Task implementation or reasoning mistake:** this identifies the immediate
  cause, not whether the harness could help. Locate an earlier decision where
  a reusable procedure, preserved state, structured operation, or bounded check
  could have prevented or detected the mistake using information available to
  the Target. An existing instruction does not establish that such support is
  already effective. Conversely, the mistake alone does not justify a reminder
  or an executable mechanism.
- **Infrastructure or invalid evaluation:** do not edit the harness to mask it.
  Finish the active assignment only as the evidence allows; after the round
  reports a repairable failed evaluation, `control.rerun` may be used for the
  exact advertised slot.
- **No supported causal link:** decline after assessing the relevant observable
  decision, not solely because the failure is labeled a reasoning error or the
  harness already says to verify.

Test the explanation against relevant accessible seed evidence, including a
successful run facing a similar decision or a failure with a different cause
when available. Seek comparisons that could change the diagnosis; do not read
every success by default. Note missing comparisons or contradictory evidence
as uncertainty rather than treating repeated failures as proof of one cause.

Group evidence by the decision or missing capability, not just by task domain
or the symptom "verification failed." Unrelated failures need not share one
fix. A supported mechanism for a subset can justify a candidate; explain its
trigger, what would change at the cited decision, and what remains unsolved.

Held-out task identities, trajectories, and rewards are intentionally
unavailable. Do not infer or optimize for hidden task contents.

### 3. Choose a generalizable intervention

Generalization concerns the mechanism and its applicability, not just removing
task names. Before editing, establish:

- the observed decision, supporting evidence, and the harness gap;
- why the proposed mechanism should change that decision on other tasks;
- the observable conditions where it applies and where it should stay inactive;
- the main regression risk or cost, including false triggers and extra context
  or execution time.

A mechanism may serve a recognizable class of tasks within a shared harness;
it need not activate for every task. Limited seed evidence supports a hypothesis,
not a claim of demonstrated generalization. Keep these conclusions concise in
the finalization fields described below.

Choose the mechanism from the causal boundary, not from whichever candidate
file already exists:

| Observable boundary | Usually prefer | Use shared prompt/context only when |
| --- | --- | --- |
| Stable guidance needed on nearly every request | `context` | The rule is broadly applicable and has no narrower reliable trigger |
| Recognizable class of tasks needing substantial instructions | `skill` | The instructions truly belong in every request instead of being loaded on demand |
| Repeatable multi-step procedure | `workflow` | The procedure is short, universal guidance rather than an executable sequence |
| Tool call can be allowed, denied, or questioned before execution | `pre_action` or guard | The condition cannot be observed reliably from the structured call |
| Tool result can be validated or corrected after execution | `post_action` or `action_verifier` | No deterministic result signal can distinguish the failure |
| The Target Agent lacks an operation or structured interface | `tool` | Existing tools suffice and only their use needs guidance |
| Relevant state is lost during summarization | `compaction` | The information was missing before compaction rather than discarded by it |

The absence of a file for the preferred mechanism does not make that mechanism
unavailable. Create and wire the smallest supported artifact when the candidate
toolchain exposes the necessary extension point. Conversely, do not invent an
executable hook when the evidence supplies no deterministic trigger.

Compare plausible mechanisms where the diagnosed gap is observable. Lack of
one universal verifier does not by itself justify a shared prompt: bounded
checks, clearer tool feedback, state retention, or an on-demand procedure may
fit the evidence. Use the same standard for every option: causal fit, reliable
activation, and cost outside the affected cases. Do not enumerate every option
or add code merely to avoid a prompt edit. Retain a prompt change when guidance
is the supported gap and a narrower mechanism offers no clear benefit.
Do not add a policy for infrastructure failures or behavior already performed
correctly in the cited trajectory.

Prefer the smallest change that breaks the causal chain. Avoid:

- task names, expected answers, grader details, or literal patches for a seed
  task;
- broad rewrites when one existing policy or resource is responsible;
- aggregating unrelated seed remedies into one always-on instruction block;
- duplicating an instruction already present elsewhere;
- adding a file without registering or referencing it;
- changing multiple semantic targets without evidence for each;
- claiming an expected score or guaranteed improvement.

Smallest refers to behavioral scope and cost, not line count. A scoped skill
with a helper or a local hook may be smaller in effect than a rule injected into
every request. Moving the same reminder into a skill is not a new mechanism:
identify the procedure, operation, evidence, or feedback it adds, how it becomes
active, and why it should help beyond the cited task.

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
For Gear's DSH carrier, the fixed `skill-filesystem` configuration already
connects `harness/skills`. An ordinary `skills/<name>/SKILL.md` and its bundle
resources need no candidate loader or preset edit; see
[dsh-target-harness.md](dsh-target-harness.md).

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

Call `meta.call` with capability `candidate.diff` before the compiler check.
Review the authoritative patch, not a reconstruction from memory. Confirm:

- every changed file supports the stated causal hypothesis;
- no seed answer, hidden-task guess, credential, host path, or unrelated cleanup
  entered the patch;
- new files are connected and removed files are no longer referenced;
- the patch fits within the existing fixed toolchain and dependencies;
- `semanticTargets` and `expectedOutcome` describe the diff accurately.

Then call `meta.call` with capability `candidate.check` and arguments
`{"check":"compiler"}`. Inspect each coverage stage: `static`, `compiler`,
`runtime.load`, `runtime.promptAssembly`, `runtime.skillDiscovery`, `runtime.skillRead`, and
`runtime.cleanup`. `not_checked` means no evidence was collected for that
stage; a successful no-op compiler does not prove runtime loading. Configured
runtime checks use an isolated copy with a matching manifest; do not edit the
manifest yourself. Check availability via `harness.current.validation`.
Prompt assembly includes dynamic context, strict variables and visible tool
schemas. It does not execute arbitrary tool/hook bodies, routing/compaction
callbacks, or workflow scripts; record those remaining behavior checks.

This is the fixed candidate build/validation pipeline;
it does not prove task improvement. If it fails, repair only the candidate
defect reported by the check, then inspect the diff and check again. Never
bypass the check or modify the manifest manually.

## Finalize or decline

Finalize only after:

- the baseline summary has been observed;
- every failed baseline run has been queried and required evidence reads are
  complete, as reported by `finalizationReadiness`;
- the evidence supports the proposed causal link;
- the diff is coherent and nonempty;
- `candidate.check` succeeds.

Use the existing finalization fields; no separate report is needed:

- `rationale`: summarize the observed harness gap, supporting or conflicting
  evidence, why this mechanism fits better than plausible alternatives, its
  applicability beyond the seed tasks, and the main risk or uncertainty.
- `expectedOutcome`: predict an observable change at the affected decision or
  tool boundary and what should remain unchanged outside it. State what result
  would undermine the hypothesis; do not promise a score.

Cite only baseline `evalId` or `runId` values actually returned and inspected in
the active assignment. Build success establishes validity, and seed improvement
is feedback on this hypothesis; neither alone demonstrates generalization.

Decline when evidence is inconclusive, behavior is not harness-controllable, the
only possible edit would expose a seed answer, or the required change needs
protected substrate. A decline still requires an evidence-based rationale and
the observed baseline references. Never create a cosmetic diff merely to avoid
declining.
For a plausible intervention that the evidence does not support, briefly state
the missing signal, comparison, or capability in the existing rationale. Do not
enumerate every artifact type or invent a candidate merely to fill this account.

Finalization or decline concludes the assignment. Stop using that lease and poll
`control.status`; Gear owns compilation sealing, candidate evaluation, held-out
gating, selection, and promotion.

## Worked examples

These examples illustrate evidence standards, not required interventions.
Suppose failed runs on unrelated tasks treat a background command's launch
acknowledgment as completion. Full transcripts and the current tool wrapper
show that it labels a still-running process as finished. A successful foreground
run shows that an actual exit status is interpreted correctly. This supports
correcting the wrapper's structured state and feedback for background commands,
if that wrapper is editable. The trigger is a live process without an exit
status; completed foreground commands should keep their existing behavior.
Check that the correction preserves the handle needed to await completion.

The prediction is that the Target distinguishes launch from completion and
retrieves the final result before relying on it. If it still treats a clearly
reported running state as success, that weakens the feedback hypothesis. A
generic reminder to verify would not repair the observed incorrect state.

Conversely, suppose a failed run receives and understands complete test output
but introduces an isolated algorithm error. Its procedure already checks the
relevant contract, and inspected comparisons reveal no supported reusable
prevention or detection mechanism in the editable harness.
Decline with that evidence and uncertainty instead of adding another "test
carefully" rule or encoding the seed's correct algorithm.

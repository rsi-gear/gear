# DSH Target Harness Authoring Guide

This reference is mandatory when the Refine target is Gear's DeepSeek Harness
(DSH) carrier. It describes the carrier shipped with Gear and the DSH
`0.1.0-rc.8` APIs that the carrier locks. Do not transfer these exact APIs to a
different DSH version without inspecting that version's source.

The API contracts and examples below were audited against the official
`dsh-v0.1.0-rc.8` tag at commit
`141eb6fef83422698aef7a981029e843e8161534`. The primary source locations are
`packages/core/tools`, `packages/core/system-prompt`, `packages/core/agent`,
`packages/skill/skill-filesystem`, `packages/workflow`,
`packages/preset/agent-presets`, and `apps/cli/config/agent-presets` in the
DeepSeek Harness repository.

The protocol and candidate mutation rules are in [protocol.md](protocol.md) and
[target-harness-editing.md](target-harness-editing.md). This document explains
what the editable DSH files mean and how to connect them.

## The load graph, not the directory names, controls behavior

Gear permits candidate artifacts under five roots, but DSH does not
automatically scan all five:

| Root | Meaning in the Gear DSH carrier | Automatically loaded? | How it becomes active |
| --- | --- | --- | --- |
| `preset/` | Cordis composition: the list of plugins and providers that form the target overlay | Yes, but only `preset/agent.cordis.yml` | Gear's fixed loader includes this exact file |
| `plugins/` | Native Cordis/DSH plugins: prompt sections, hooks, policies, tools, and resource loaders | No | Add a relative `name` row to the preset |
| `prompts/` | Reusable model-facing prompt text | No | A loaded plugin must read it and register a prompt section or context |
| `skills/` | On-demand Agent Skills and their bundle resources | No | A loaded `dsh-skill-filesystem` provider must scan the directory |
| `workflows/` | Reusable multi-step procedures or DSH workflow-tool script templates | No | A loaded plugin or skill must expose the procedure to the model |

The effective graph is therefore:

```text
Gear fixed target loader
  -> preset/agent.cordis.yml
       -> plugins/*.js
            -> prompts/*.md
            -> workflows/*.md or *.js
       -> @deepseek-ai/dsh-skill-filesystem
            -> skills/<skill-name>/SKILL.md
```

An unreferenced file in `plugins/`, `prompts/`, `skills/`, or `workflows/`
does nothing. Creating the file and creating its connection are one logical
candidate change.

The fixed carrier also owns the sandbox, approval mode, dependencies,
toolchain, target loader, and `manifest.json`. Candidate code must not try to
replace or weaken those pieces. Gear rebuilds the artifact list and manifest
when it seals a valid candidate.

## How the Meta Agent may edit these files

Use the candidate-scoped tools exposed by the active Meta adapter; never use an
unscoped host path, Git command, shell redirect, or IPython filesystem API to
reach the candidate.

In harness-neutral skill mode, mutations cross the Gear lease API:

- `candidate.edit` replaces a unique observed substring in an existing text
  file;
- `candidate.write` creates a file with `expectedDigest: null`, or replaces a
  whole observed file with its current digest;
- `candidate.remove` deletes an observed file with its current digest.

Use `candidate.tree` and `candidate.read` before those mutations and carry the
new observation digest forward after each change. Modifications are not
restricted to `candidate.edit`.

In Native DSH Meta mode, Gear instead scopes DSH's standard `read`, `write`,
`edit`, `glob`, `grep`, and optional sandboxed `bash` tools to the active
candidate. Use those standard tools directly; do not look for unavailable
`candidate.*` aliases. In either mode, IPython is an analysis scratchpad and
grants no additional candidate or host filesystem authority.

## `preset/`: composition entrypoint

`preset/agent.cordis.yml` is a top-level YAML list of named Cordis plugin rows.
A minimal row is:

```yaml
- id: terminal-bench-policy
  name: ../plugins/policy.js
```

The important fields are:

| Field | Meaning |
| --- | --- |
| `id` | Stable row identity inside the composition; keep it unique |
| `name` | Plugin module specifier |
| `config` | Configuration passed to the plugin after its schema/default processing |
| `inject` | Optional composition-level service dependency override; normally the plugin's exported `inject` is clearer |
| `disabled` | Optional boolean/`!!js` expression; a disabled row has no effect |

Resolution rules:

- `../plugins/policy.js` is relative to `preset/agent.cordis.yml`.
- A bare package such as `@deepseek-ai/dsh-skill-filesystem` resolves from the
  fixed harness installation. It must already be in the locked toolchain; a
  candidate cannot add dependencies.
- YAML `!!js` expressions may use the loader's `baseUrl`, which is the URL of
  the preset directory. Use it when a package config needs an absolute path.
- Use `process.getBuiltinModule(...)` inside `!!js` instead of assuming an
  imported YAML helper.

Example composition connecting one policy plugin, one prompt loader, one
isolated skill provider, and one workflow-guidance loader:

```yaml
- id: target-policy
  name: ../plugins/policy.js

- id: target-prompt-pack
  name: ../plugins/prompt-pack.js

- id: target-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: gear-target
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('../skills/', baseUrl))"

- id: target-workflow-guidance
  name: ../plugins/workflow-guidance.js
```

The Gear rc8 carrier already supplies the main DSH services and model-facing
tools. Do not duplicate base rows merely because a service is injected by a
custom plugin. For example, the custom skill row above adds a uniquely named
provider to the existing `ctx.skills` registry; it does not add a second skill
registry or a second `tool-skill` row.

## `plugins/`: native DSH extensions

DSH is built on Cordis and treats capabilities as plugins. A local JavaScript
plugin uses ESM named exports:

```js
export const name = 'target-policy'
export const inject = ['systemPrompt', 'tools']

export function apply(ctx) {
  // Register prompt sections, hooks, guards, or tools here.
}
```

Rules for local plugins:

- Export `name`, optional `inject`, optional `Config`, and `apply` by name. Do
  not use a default export.
- `inject` lists services that must exist before the plugin activates. Use the
  exact context service keys, such as `systemPrompt`, `tools`, `skills`, or
  `workflowEngine`.
- Prefer registrations owned by Cordis effects: `ctx.on(...)`,
  `ctx.systemPrompt.section(...)`, and `ctx.tools.guard(...)` return or create
  reversible registrations tied to the plugin fiber.
- Use `ctx.effect(...)` when the plugin owns an external resource such as a
  watcher, timer, child process, or temporary mount, and make its disposer
  reach quiescence.
- Waterfall listeners must call and return `next()` when they delegate. A
  return without `next()` short-circuits downstream listeners.
- Do not keep mutable cross-session state unless the policy deliberately owns
  process-wide state and has a cleanup/reconstruction design.

### Static context example

Use `systemPrompt.section` for stable instructions that should be present in
every request. Sections render in ascending `order`. In rc8, `-100` is the
harness identity, `0` is the persona, and tool guidance normally occupies
`100` through `199`; an overlay policy can use an otherwise unclaimed order
such as `50`.

`plugins/policy.js`:

```js
export const name = 'terminal-bench-evolution-policy'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'harness:terminal-bench-policy',
    order: 50,
    text: `Inspect the task environment before changing it.
After editing, run the narrowest relevant verification and report its result.`,
  })
}
```

`preset/agent.cordis.yml`:

```yaml
- id: terminal-bench-policy
  name: ../plugins/policy.js
```

Use `systemPrompt.context({ name, order, text })` for a current runtime snapshot
that is re-evaluated at assembly time. Use `agent.inject(message)` for a
source-attributed context message that should be queued at a specific session
or step boundary. Do not hide model-visible dynamic instructions in an
unlogged in-memory variable.

## Native pre-action and post-action hooks

`pre_action` and `post_action` are Gear semantic target names. Their native DSH
rc8 equivalents are the tool pipeline:

```text
tools/pre-execute
  -> monotonic tools.guard checks
  -> tools/execute
  -> tool body
  -> tools/post-execute
  -> definition finalizeContent
  -> tools/result
```

Use the points as follows:

| Intent | DSH API | Can change outcome? |
| --- | --- | --- |
| Allow, deny, or request approval before a tool runs | `tools/pre-execute` | Yes |
| Final synchronous denial that another waterfall listener cannot undo | `ctx.tools.guard(...)` | Yes, deny only |
| Timeout, retry, latency, or around-dispatch instrumentation | `tools/execute` | Yes; wraps dispatch |
| Accept, replace, enrich, or block a normalized result | `tools/post-execute` | Yes |
| Observe the frozen final result | `tools/result` | No |

The `@deepseek-ai/dsh-hooks-codex` and
`@deepseek-ai/dsh-hooks-claude-code` packages are compatibility bridges for
existing external command-hook configuration. Do not use those bridges for a
new native target policy. A native plugin receives the full structured DSH
execution and result objects without a shell/JSON compatibility boundary.

### `pre_action`: allow, deny, or ask

Exact rc8 decision shapes:

```text
{ kind: 'allow' }
{ kind: 'deny', reason: string }
{ kind: 'ask', reason?: string }
```

Example that rejects one clearly unsafe shell pattern and delegates every
other call:

```js
export const name = 'target-pre-action-policy'
export const inject = ['tools']

function shellCommand(exec) {
  if (exec.name !== 'bash') return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  const command = exec.arguments.command
  return typeof command === 'string' ? command : undefined
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const command = shellCommand(exec)
    if (command !== undefined && /(?:^|\s)git\s+reset\s+--hard(?:\s|$)/u.test(command)) {
      return {
        kind: 'deny',
        reason: 'destructive repository reset is outside the target task policy',
      }
    }
    return next()
  })
}
```

The `ToolExecution` provides `callId`, `rootCallId`, `name`, frozen parsed
`arguments`, optional calling `agent`, `signal`, and correlation identity. A
pre-execute listener cannot rewrite arguments: DSH has already logged and
presented them. Deny or ask, or delegate unchanged.

If a rule must be monotonic, register a guard instead of relying on waterfall
ordering:

```js
export const name = 'target-monotonic-guard'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.guard((exec) => {
    if (exec.name !== 'bash') return undefined
    const args = exec.arguments
    const command = typeof args === 'object' && args !== null
      ? args.command
      : undefined
    return typeof command === 'string' && command.includes('forbidden-marker')
      ? 'command contains a forbidden marker'
      : undefined
  })
}
```

A guard is synchronous and returns only a denial reason or `undefined`. Use
`tools/pre-execute` when the decision requires async work or an `ask` result.

### `post_action`: inspect, preserve, or replace

Every thrown tool also reaches `tools/post-execute` as a normalized failure.
The result is one of:

```text
{ isError: false, value, content, ... }
{ isError: true, error, content, ... }
```

Exact post decision shapes:

```text
{ kind: 'accept' }
{ kind: 'accept', content: ContentBlock[] }
{ kind: 'accept', value: JsonValue }
{ kind: 'accept', additionalContexts: UserMessage[] }
{ kind: 'block', feedback: ContentBlock[] }
```

An accept decision may replace `content` or `value`, never both. Calling
`next()` accepts the current result unchanged and preserves cooperation with
other listeners.

Example that removes a secret-shaped token from text output while preserving
non-text content blocks:

```js
export const name = 'target-post-action-policy'
export const inject = ['tools']

const SECRET = /\bsk-[A-Za-z0-9_-]{16,}\b/gu

export function apply(ctx) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'bash' || result.isError) return next()

    const content = result.content.map((block) => (
      block.type === 'text'
        ? { ...block, text: block.text.replace(SECRET, '[redacted]') }
        : block
    ))
    return { kind: 'accept', content }
  })
}
```

Only replace a projection when the evidence requires it. Replacing content can
discard tool-specific presentation or detail; `return next()` is the safe
default.

### `action_verifier`: block a misleading success

An action verifier is normally a `tools/post-execute` listener that converts a
nominally successful result into corrective feedback. Example: a test command
that exits successfully but reports that it ran no tests should not count as
verification.

```js
export const name = 'target-action-verifier'
export const inject = ['tools']

function textContent(blocks) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function commandOf(exec) {
  if (exec.name !== 'bash') return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  return typeof args.command === 'string' ? args.command : undefined
}

export function apply(ctx) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const command = commandOf(exec)
    if (command === undefined || result.isError) return next()
    if (!/\b(?:pytest|vitest|jest|cargo\s+test|go\s+test)\b/u.test(command)) {
      return next()
    }

    const output = textContent(result.content)
    if (/\b(?:no tests ran|0 tests|no test files found)\b/iu.test(output)) {
      return {
        kind: 'block',
        feedback: [{
          type: 'text',
          text: 'The command did not exercise any tests. Select and run a real relevant test target.',
        }],
      }
    }
    return next()
  })
}
```

Post-execute blocking does not roll back side effects that already happened.
Anything that must be prevented must be checked in `tools/pre-execute` or a
monotonic guard. Use post-execute for result validation and self-correction.

Register any of the hook plugins from the preset, for example:

```yaml
- id: target-pre-action-policy
  name: ../plugins/pre-action.js

- id: target-post-action-policy
  name: ../plugins/post-action.js

- id: target-action-verifier
  name: ../plugins/action-verifier.js
```

## `prompts/`: text assets loaded by a plugin

A prompt file is inert until a plugin reads and registers it. Keep reusable
prose in `prompts/` and lifecycle/API code in `plugins/`.

`prompts/verification.md`:

```markdown
## Verification policy

Before reporting completion, run the narrowest check that exercises the
changed behavior. Distinguish a passing check from a check that selected no
tests, and report the exact command and outcome.
```

`plugins/prompt-pack.js`:

```js
import { readFile } from 'node:fs/promises'

export const name = 'target-prompt-pack'
export const inject = ['systemPrompt']

export async function apply(ctx) {
  const text = await readFile(
    new URL('../prompts/verification.md', import.meta.url),
    'utf8',
  )
  ctx.systemPrompt.section({
    name: 'harness:verification-policy',
    order: 51,
    text: text.trim(),
  })
}
```

`preset/agent.cordis.yml`:

```yaml
- id: target-prompt-pack
  name: ../plugins/prompt-pack.js
```

Prefer a prompt asset when several plugins or procedures share substantial
text. For a two-line fixed policy, an inline `systemPrompt.section` is simpler
and avoids an unnecessary file and registration edit.

## `skills/`: on-demand instruction bundles

Use a skill when detailed instructions are useful only for a recognizable
class of tasks. Skills keep the full body out of every request until selected.

The rc8 filesystem provider recognizes exactly one level of either form:

```text
skills/<name>/SKILL.md
skills/<name>.md
```

It does not recursively discover `skills/group/<name>/SKILL.md`. A directory
bundle may contain `references/`, `scripts/`, and `assets/` beside `SKILL.md`.

`skills/verify-change/SKILL.md`:

```markdown
---
name: verify-change
description: Select and run focused verification after changing a software repository.
whenToUse: Use after an implementation or configuration change and before claiming completion.
---

# Verify Change

Inspect the affected package's existing test commands. Run the narrowest test
that covers the changed behavior, then the broader package check when risk
justifies it. Treat zero selected tests as no verification. Report the command,
exit status, and any remaining gap.
```

Connect the Gear-level `skills/` sibling directory with an isolated provider:

```yaml
- id: target-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: gear-target
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('../skills/', baseUrl))"
```

Why every config field matters here:

- `providerName` must be unique because the fixed carrier already has its
  normal filesystem provider.
- `includeDefaultRoots: false` prevents this added provider from rediscovering
  project, user, and bundled skills under a second provider identity.
- `../skills/` is relative to the `preset/` directory represented by
  `baseUrl`; `fileURLToPath` produces the absolute path the provider expects.

Skill names must be kebab-case. Frontmatter requires `name` and `description`;
`whenToUse`, `metadata`, `disable-model-invocation`, and `user-invocable` are
optional. A malformed invocation boolean fails closed and removes the skill
from discovery. The Gear carrier's existing `dsh-tool-skill` consumer exposes
model-invocable skills; do not add a duplicate consumer row.

## `workflows/`: reusable procedures, not an auto-scanned registry

DSH rc8's built-in model-facing `workflow` tool executes a model-supplied plain
JavaScript orchestration body through `ctx.workflowEngine`. The tool accepts:

- `meta`: `name`, `description`, optional `whenToUse`, and optional `phases`;
- `script`: a plain JavaScript body with top-level `await` and a final JSON
  return value;
- optional object-shaped `args` exposed to the script.

Inside the script, rc8 exposes `agent`, `parallel`, `pipeline`, `phase`, and
`log`. It does not scan the Gear `workflows/` directory. A reusable workflow
file must therefore be exposed as guidance by a plugin or on-demand skill.

`workflows/diagnose-and-verify.md`:

```markdown
## Diagnose and verify workflow

Use only for a change broad enough to benefit from multiple independent
reviews. Supply the DSH `workflow` tool with metadata separate from the script.
Include the user's task, relevant repository paths, and observed failures in
each subagent's prompt. This is a Target task workflow, not harness evolution.

Metadata:

    {"name":"diagnose-and-verify","description":"Parallel diagnosis followed by an independent verification review"}

Script body:

    phase('diagnosis')
    const findings = await parallel([
      () => agent('For the user-requested repository change, inspect the failing behavior and relevant implementation; report the likely cause with evidence.', { label: 'diagnose-a', phase: 'diagnosis' }),
      () => agent('Independently inspect the affected interfaces and tests for alternative causes and regression risks in the user-requested change.', { label: 'diagnose-b', phase: 'diagnosis' }),
    ])
    phase('review')
    const review = await agent(
      `Review these findings, reconcile disagreements, and propose focused verification:\n${JSON.stringify(findings)}`,
      { label: 'review', phase: 'review' },
    )
    return { findings, review }

For one or two ordinary delegations, use the normal subagent tools instead of
paying the workflow-tool schema and orchestration overhead.
```

`plugins/workflow-guidance.js`:

```js
import { readFile } from 'node:fs/promises'

export const name = 'target-workflow-guidance'
export const inject = ['systemPrompt']

export async function apply(ctx) {
  const text = await readFile(
    new URL('../workflows/diagnose-and-verify.md', import.meta.url),
    'utf8',
  )
  ctx.systemPrompt.section({
    name: 'harness:workflow:diagnose-and-verify',
    order: 90,
    text: text.trim(),
  })
}
```

`preset/agent.cordis.yml`:

```yaml
- id: target-workflow-guidance
  name: ../plugins/workflow-guidance.js
```

This example is always visible. If the procedure is long or rarely useful,
move the complete instructions into a skill bundle instead of keeping an
always-on workflow prompt. A sibling `workflows/` file still needs plugin code
to read it; the skill filesystem provider does not scan that root. Do not add
another workflow engine or tool row unless the observed candidate tree proves
the fixed profile does not already provide them.

## Other useful DSH extension points

Use these only when baseline evidence identifies the corresponding cause:

| Gear semantic target | DSH rc8 mechanism | Notes |
| --- | --- | --- |
| `context` | `systemPrompt.section`, `systemPrompt.context`, `agent.inject`, `agent/pre-step` | Static prompt, runtime snapshot, queued durable context, or step decision are different lifecycles |
| `routing` | Prompt/tool guidance, `agent/request`, tool restrictions in an agent scope | `agent/request` changes model call config, not messages |
| `tool` | `ctx.tools.register`, existing tool config, or scoped restriction | A custom tool needs a complete schema, canonical output contract, renderer, and cancellation-aware executor |
| `compaction` | Existing compaction plugin config and compaction extension points | Preserve model-visible policy and durable reconstruction; do not treat a summary prompt as ordinary static context |

Agent loop points commonly used by native plugins are:

| Point | Mode | Purpose |
| --- | --- | --- |
| `agent/session-start` | emit | Seed context with `agent.inject()`; cannot veto startup |
| `agent/pre-step` | waterfall | Reject a proposed step or replace the messages entering it |
| `agent/request` | waterfall | Replace provider/model request configuration; cannot mutate messages |
| `agent/turn-stopping` | serial | Observe the stop boundary and use `agent.steer()` when another step is required |

As with tool waterfalls, return `next()` to delegate. Model-visible dynamic
content must use the appropriate logged/inbox channel so session replay can
reconstruct what the model saw.

## Complete small layout

A coherent candidate using all five roots could look like:

```text
preset/
  agent.cordis.yml
plugins/
  policy.js
  pre-action.js
  action-verifier.js
  prompt-pack.js
  workflow-guidance.js
prompts/
  verification.md
skills/
  verify-change/
    SKILL.md
workflows/
  diagnose-and-verify.md
```

Its preset must connect every live resource:

```yaml
- id: target-policy
  name: ../plugins/policy.js

- id: target-pre-action
  name: ../plugins/pre-action.js

- id: target-action-verifier
  name: ../plugins/action-verifier.js

- id: target-prompt-pack
  name: ../plugins/prompt-pack.js

- id: target-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: gear-target
    includeDefaultRoots: false
    customSkillDirs:
      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('../skills/', baseUrl))"

- id: target-workflow-guidance
  name: ../plugins/workflow-guidance.js
```

Do not create this whole layout by default. It demonstrates the connections;
the actual candidate should contain only the smallest evidence-supported set.

## Review checklist before the candidate check

Inspect the authoritative diff with `candidate.diff` in skill mode or
`candidate_diff` in Native DSH Meta mode, then confirm all of the following:

- `preset/agent.cordis.yml` remains a valid top-level list with unique row ids.
- Every new plugin uses named ESM exports and declares its required services.
- Every waterfall path either returns a deliberate decision or returns
  `next()`.
- A pre-action rule does not attempt to rewrite frozen tool arguments.
- A post-action decision does not specify both `content` and `value`.
- A post-action block is not being mistaken for rollback of an executed side
  effect.
- Every prompt, skill, and workflow resource has a live connection.
- The skill provider uses a unique provider name and the correct
  `../skills/` `baseUrl` path.
- No candidate adds a package, edits fixed sandbox/approval behavior, or
  writes `manifest.json`.
- The change is general to the observed failure pattern and contains no seed
  answer or held-out guess.

Then use `meta.call` with capability `candidate.check` and arguments
`{"check":"compiler"}` in skill mode, or call `candidate_check` in Native DSH
Meta mode. A successful compiler check proves the carrier can load and validate
the candidate; it does not prove the behavioral hypothesis, which remains
subject to Gear evaluation.

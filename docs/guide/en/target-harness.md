# Prepare a Target harness

A Target is a buildable, exact Git revision. Gear edits the declared Harness tree while a fixed carrier supplies the runtime and evaluation entrypoint.

## Use the example carrier

The [bootstrap in Quick start](quickstart.md) creates a separate repository and records its substrate, initial champion and manifest. Keep Gear source, Target source, task workspaces and state roots distinct. Hitch prepares the selected Target revision as an immutable artifact for container evaluation.

```text
target/
  fixed/                  # loader, target configuration, verifier
  harness/
    preset/agent.cordis.yml
    plugins/policy.js
    workflows/            # optional procedures and helpers
    skills/               # native Skills when supported by the carrier
    manifest.json
```

A new file must be reachable from the actual loading path. A Markdown workflow is not automatically a native Skill. The Marketing snapshots use explicit workflow reads; their policy points the agent at installed resources.

## Verify before evaluating

`candidate.check` reports static and compiler/runtime coverage. The DSH checker can verify loading, prompt assembly and native Skill discovery/read behavior. Passing those checks does not prove arbitrary tool bodies, hooks or business workflows executed correctly. Add a targeted runtime scenario when needed, then run a real smoke evaluation.

Use an absolute compiler executable. Pin `compiler.runtimeRoot` to the installed Target runtime and set `reportProtocol: gear-runtime-check-v1` for the structured DSH report. A no-op compiler without this protocol reports runtime coverage as `not_checked`.

## Reuse the final Harness

```bash
node examples/automationbench-marketing/inspect.mjs
node examples/automationbench-marketing/inspect.mjs examples/evolution-search
```

Inspection verifies the shipped source against its historical manifest. To run it in a new carrier, use `GEAR_INITIAL_HARNESS` during bootstrap. The new carrier receives a fresh manifest and commit; historical metrics remain attached to their original revisions.

Keep credentials in host configuration. They do not belong in the candidate tree, Git history or exported Harness. The [DSH editing reference](../../../skills/refine/references/dsh-target-harness.md) describes actual hooks, tools, native Skills and load paths.

# Prepare a Target harness

`gear init --target dsh` or `gear init --target pi` creates a native editable
carrier. `target.path` points to its resource directory. Select the Target and
the candidate-generating Meta profile independently.

| Adapter | Editable resources |
| --- | --- |
| DSH | `preset/`, `plugins/`, `prompts/`, `skills/`, `workflows/` |
| Pi | `AGENTS.md`, `.pi/settings.json`, `.pi/extensions/`, `.pi/skills/`, `.pi/prompts/` |

DSH wires plugins in `preset/agent.cordis.yml`; the fixed patch supplies Skill
discovery. An unconnected prompt file is inert. Pi uses native project discovery;
settings cannot redirect packages/extensions/skills/prompts/themes outside the
sealed local resources.

The outer Harbor container provides the evaluation boundary. DSH's fixed
container patch uses `danger-full-access` and `approval.policy: never`; Pi uses
native automatic approval. These evaluation settings do not modify the host
carrier. See the [container test guide](../../testing/target-headless.zh-CN.md)
for real CLI loading, native tool execution and separate verifier checks.

Dependency manifests, lockfiles, Git metadata and manifests are fixed. Core
checks resource boundaries, seals exact content and verifies execution identity.
Editable resources do not grant permission to modify the upstream runtime source.

[Profiles](configuration.md) fix runtime version, model and container. Each
evaluation uses its sealed candidate; editing `.gear/` cannot legitimately
change an admitted experiment.

See the [native DSH resource guide](../../../skills/refine/references/dsh-target-harness.md)
for wiring examples. Host extension loading, container materialization and model
adoption are distinct verification layers; consult the
[implementation record](../../refactor-progress.zh-CN.md) for observed results.

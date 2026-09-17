# Connect your Meta agent

Choose a Meta host independently of the Target model. Both connection paths use the same bundled Refine Skill and restricted candidate/evidence protocol.

## Standalone server and external Skill

Install the package, prepare the Target and datasets, and create a configuration using the [standalone field-by-field example](../../harness-agnostic-refine-skill.md). Replace every path and digest with real values; the sample is a template.

```bash
npm install --global rsi-gear@latest
GEAR_SKILL_PATH="$(npm root -g)/rsi-gear/skills/refine"
gear-refine skill-identity --path "$GEAR_SKILL_PATH"
gear-refine serve --config /absolute/path/to/gear-refine.json
```

Copy or link the entire `skills/refine` directory into the host's supported Skill location, including references and invocation metadata. Use the same bundle for configuration and execution. Do not hash only `SKILL.md`.

The server prints a ready JSON object. Keep it running and set the returned socket path in the Meta host's environment:

```bash
export GEAR_REFINE_SOCKET=/absolute/path/from/ready/refine.sock
gear-refine request control.status '{}'
```

Invoke Refine through your host's Skill interface or `/refine` where supported. You can also ask in natural language: “Use the Refine Skill to optimize AutomationBench Marketing for one round, with Codex + Astra as Meta and DSH + Luna for rollouts.” Use a Meta session whose actual runtime/model matches that configuration.

## DSH native Skill

Install Gear as shown in [Quick start](quickstart.md), then add it to the DSH profile with `dsh plugin --profile web add rsi-gear@latest` and enable the configured `refine` row using the [DSH profile setup](../../plugin-installation-and-usage.md#6-启用并配置-profile). Skill mode is the default. DSH publishes the packaged Skill and a `refine_request` bridge. The native `/refine` gesture loads the Skill into the current agent.

```text
/refine --rounds 1 --focus workflow,tool
/refine status
```

When identity fields are omitted together, the plugin derives the DSH runtime and bundled Skill identity. The bridge verifies Skill loading and the configured model/sampling settings. It does not attest all other tools, prior history or OS permissions of the host session. `metaAdapter.kind: dsh` selects the older direct-session compatibility adapter; see [legacy setup](../../plugin-installation-and-usage.md).

## Identity and lifecycle

External clients must provide an exact runtime type/version/integrity, Skill ID/bundle digest, provider/model and sampling identity. `gear-refine skill-identity` computes the Skill bundle digest; it does not attest your external executable or configure its model. Obtain runtime identity from the actual installed artifact and configure the host consistently.

The Skill handles start, claim, evidence diagnosis, file edits, checks, finalize/decline, and later assignments. The operator should not manually reconstruct lease envelopes. [The protocol](../../../skills/refine/references/protocol.md) is the authoritative contract.

A plain start creates a new evolution. Give the existing ID when continuing. Changing the model, Skill, runtime or sealed sampling requires a new evolution rather than silently changing an old experiment.

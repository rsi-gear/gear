# Skill and Meta integration

The operator assistant manages a project through the bundled `refine` Skill or project API. The Python algorithm decides which operations to request. Meta proposes edits, reflects on evidence or critiques candidates; the Target executes benchmark tasks. Meta and Target use independently selected profiles and may use different models.

## Codex execution through Hitch

The bundled `gear-meta-codex` bridge sends Meta operations through **Gear → Hitch → Codex**. Gear authorizes inputs, allocates budgets and validates results. Hitch runs and isolates Codex, proxies model requests, enforces the per-operation allowance, and supplies durable receipts, inspection and cancellation.

Use `gear profile create NAME --kind codex --model YOUR_AVAILABLE_MODEL` and select that profile for the Meta role. Meta normally shares the selected Hitch Target profile's executable and root; an explicit `configuration.hitch` can select a separate Hitch installation. Hitch must advertise `isolated_agent_run: "1"` and `generation_budget: "1"`; admission rejects incompatible versions. See [runner configuration](../../codex-meta-runner.zh-CN.md) and [generation budgets](configuration.md#generation-and-diagnosis-budgets).

Meta receives only authorized task inputs, feedback and artifacts. Expected answers, held-out data and private journals are excluded. Credentials remain on Hitch's trusted side. A custom process provider must supply its own isolation and budget enforcement.

## Skill and project socket

The ordinary CLI needs no persistent server. For socket integration:

```sh
gear serve --project /absolute/path/to/project --socket /tmp/gear-project.sock
gear --socket /tmp/gear-project.sock request run.refine '{"rounds":1}' --request-id first-round
```

The native DSH plugin takes the project location:

```yaml
- id: refine
  name: rsi-gear
  config:
    projectRoot: /absolute/path/to/project
```

It publishes the `refine` Skill, `refine_request` tool and `/gear` command,
all backed by `ProjectController`. For example, ask it to check the benchmark,
try one seed task, run one round and explain the report.

External assistants can install the complete npm `skills/refine` directory and
invoke the CLI or project socket. The project protocol exposes benchmark,
config, algorithm and run operations; it does not accept the retired candidate
lease methods.

The [seven-algorithm validation](algorithms.md#real-model-validation) exercised real Hitch/Codex Meta calls and Hitch/DSH Target execution on ten Marketing tasks. This verifies that recorded configuration and scope; it does not certify every provider or claim the papers' performance results. Interrupted runs and eligible failed reflections use [Gear recovery](evolutions.md), which reuses completed work and inspects the original Hitch operations.

See the [control-plane reference](../../harness-agnostic-refine-skill.md) for
methods, request IDs and shutdown semantics.

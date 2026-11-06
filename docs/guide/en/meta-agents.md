# Skill and Meta integration

The operator assistant manages a project through the bundled `refine` Skill.
The Meta profile in `gear.yaml` performs candidate generation. These are
separate roles and may use different models.

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
lease methods. Meta process inputs contain only seed tasks and authorized
feedback. The bundled `gear-meta-codex` now implements this operation protocol,
OS isolation, durable receipts, cancellation and inspection. Custom process
profiles do not automatically receive its sandbox. See the [runner configuration
and verification scope](../../codex-meta-runner.zh-CN.md). Live authentication
and a real model loop remain unverified.

See the [control-plane reference](../../harness-agnostic-refine-skill.md) for
methods, request IDs and shutdown semantics.

# dsh-plugin-refine

`dsh-plugin-refine` is a distributable DeepSeek Harness (DSH) plugin for
meta-managed evolution of an isolated target harness. The control-plane plugin
owns refinement rounds, a persistent meta-agent session, content-addressed
harness mutations, and session-aware IPython notebooks. The package also
exports `dsh-plugin-refine/worker`, the role-scoped plugin loaded inside a
target worker.

The package deliberately does not load target harness code in the control
plane. Candidate evaluation is an injected service boundary; the Hitch/Harbor
provider is not part of this release.

## Installation

```sh
npm install dsh-plugin-refine
```

Mount the control-plane entry from a DSH composition:

```yaml
- id: refine
  name: dsh-plugin-refine
  config:
    workspaceRoot: /absolute/path/to/workspace
    harnessRoot: /absolute/path/to/harness-store
    metaPreset: refine-meta
    metaHarnessRef: meta-v1
    metaModel:
      provider: deepseek
      model: deepseek-chat
    dshRevision: 0.1.0-rc.8
    toolchainRef: node-22-tsc
    sandboxProfileRef: isolated-v1
    seedTaskRef: 0123456789abcdef0123456789abcdef01234567
    heldOutRef: fedcba9876543210fedcba9876543210fedcba98
    taskBudgetMs: 300000
    compiler:
      command: /opt/dsh-toolchain/bin/build-target-harness
      args: []
      env: {}
    allowedImports: ["@deepseek-ai/", "node:"]
```

The composition must also provide DSH `agents`, `agentPresets`, `commands`,
`tools`, and the standard session/system-prompt services. A deployment-specific
evaluation plugin must provide the `refineEvaluator` service before rounds can
be admitted.

The command plane accepts:

```text
/refine <seed-task-ref> [--rounds N] [--budget MILLISECONDS] [--target SEMANTIC_TARGET]
/refine status [ROUND_ID]
/refine rollback <VERIFIED_HARNESS_REF>
```

Multi-round batches retain one workspace lock, stop on infrastructure failure,
and otherwise advance serially from the current accepted champion. Rollback
accepts only an immutable harness ref previously accepted by a recorded round.

Load the worker entry only inside the isolated worker composition:

```yaml
- id: refine-worker
  name: dsh-plugin-refine/worker
  config:
    role: target
    targetHarnessRef: sha256:...
    targetPreset: target-...
    sandboxProfileRef: isolated-v1
```

## Runtime requirements

- Node.js 22.19+ (or 24+), matching DSH.
- Public DSH `0.1.0-rc.8` packages supplied by the host deployment.
- Python 3 with IPython for `ipython_input`. The executable is configurable.

Target/candidate isolation, scoped credentials, and a real evaluator remain
deployment responsibilities. The plugin fails closed when no evaluator is
installed; it never falls back to evaluating candidate code in the control
plane.

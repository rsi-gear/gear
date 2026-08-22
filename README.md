# GEAR

**General Evolution Architecture for Agents**

GEAR 是一个面向智能体持续演进的通用架构。它将 Agent 运行、轨迹评测和数据基础设施解耦，并通过评测反馈持续改进 Harness、Seed Tasks 和模型能力。

![GEAR Architecture](docs/gear-architecture.png)

## 核心模块

### Supervisor

Supervisor 负责协调每轮演进，并根据评测结果决定更新 Harness 或 Seed Tasks。

- **Data Infra**：管理 Seed Task、Trajectory、可视化标注与数据版本。
- **Evolution Agent**：根据历史轨迹和评测反馈生成新的 Harness 或 Seed Tasks。

### Agent

Agent 由以下部分动态装配：

- **Harness Loader**：加载 Prompt、Skill、Tool 和 Workflow 等运行配置。
- **Model Loader**：加载 Base Model 或指定 Checkpoint。
- **Agent Runtime**：通过 CLI Adapter 管理 Session 和 Context，可接入 Codex、Claude Code、Pi 等 Agent CLI。

### Evaluator

Evaluator 接收 Agent 产生的轨迹并返回评测结果与训练信号，包括：

- **Harbour Runner**：执行任务并回放或调用轨迹。
- **Evaluator Model**：对任务完成质量和行为轨迹进行评判。
- **Rule-based Judges**：计算可验证指标、成本与安全约束。
- **Domain Expert Annotations**：为评测提供人工标注和监督信号。

## 演进路径

### 路径 A：Harness / Skill Evolution

Rollout Agent 与 Target Agent 使用相同模型。系统保持模型不变，通过 Seed Tasks 生成轨迹、完成评测，并根据反馈持续改进 Harness、Skill、Prompt、Tool 或 Workflow。

### 路径 B：Seed Task & Model Evolution

Rollout Agent 在演进后的 Seed Tasks 上生成轨迹，Evaluator 为轨迹提供 reward 和反馈。随后 Target Model Trainer 使用这些数据执行 SFT、RL 或 OPD，得到新的 Target Model，并重新加载到 Agent Runtime 中接受评测。

## 一轮演进流程

1. Supervisor 提出新的 Harness 或 Seed Tasks。
2. Harness Loader 和 Model Loader 装配 Agent。
3. Data Infra 提供 Task Spec 和运行环境。
4. Rollout Agent 执行任务并生成 Trajectory。
5. Evaluator 对轨迹进行评分、标注并生成反馈。
6. 路径 B 使用 trajectory 与 reward 更新 Target Model。
7. 新模型重新加载到 Agent Runtime 中进行评测。
8. 评测结果返回 Supervisor，开始下一轮演进。

## 设计目标

- 支持 Harness、Seed Task 和 Model 三个层面的独立演进。
- 统一管理任务、轨迹、标注和模型版本。
- 支持自动评测、规则评测与专家标注组合。
- 兼容不同 Agent CLI、模型和训练方式。

## DSH Refine Plugin

### dsh-plugin-refine

`dsh-plugin-refine` is a distributable DeepSeek Harness (DSH) plugin for
meta-managed evolution of an isolated target harness. The control-plane plugin
owns refinement rounds, a persistent meta-agent session, Git-versioned
harness mutations, and session-aware IPython notebooks. Each target harness
version is an exact Git commit in a complete DSH source repository. The package also
exports `dsh-plugin-refine/worker`, the role-scoped plugin loaded inside a
target worker.

The package deliberately does not load target harness code in the control
plane. Its production evaluator invokes an installed Hitch CLI and reuses
Hitch's existing `deepseek` adapter and Harbor backend; it does not import
Hitch internals.

### Installation

```sh
dsh plugin --profile web add dsh-plugin-refine
```

The package declares a DSH bundle containing a disabled `refine` row. Enable
and configure that row in the profile's own `cordis.patch.yml`; installation
alone does not start the control plane.

Mount the control-plane entry from a DSH composition:

```yaml
- id: refine
  name: dsh-plugin-refine
  config:
    workspaceRoot: /absolute/path/to/workspace
    dshRepository: /absolute/path/to/clean-complete-dsh-repository
    targetRoot: harness
    metaPreset: refine-meta
    metaHarnessRef: meta-v1
    metaModel:
      provider: deepseek
      model: deepseek-chat
    dshBaseRef: 0123456789abcdef0123456789abcdef01234567
    toolchainRef: node-22-tsc
    sandboxProfileRef: isolated-v1
    metaSandbox:
      mode: required
    seedTaskRef: /absolute/path/to/harbor-seed-dataset
    heldOutRef: /absolute/path/to/harbor-held-out-dataset
    taskBudgetMs: 300000
    compiler:
      command: /opt/dsh-toolchain/bin/build-target-harness
      args: []
      env: {}
    allowedImports: ["@deepseek-ai/", "node:"]
    hitch:
      executable: hitch
      harnessId: deepseek
      model: deepseek-chat
      attempts: 1
      maxConcurrent: 4
      setupTimeoutMs: 1800000
      terminationGraceMs: 5000
      maxOutputBytes: 8388608
      maxTrajectoryOutputBytes: 67108864
      agentArgs: []
      passEnv: []
    initialChampion:
      schemaVersion: 2
      ref: fedcba9876543210fedcba9876543210fedcba98
      manifestDigest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      updatedAt: "2026-08-21T00:00:00.000Z"
```

The composition must also provide DSH `agents`, `agentPresets`, `commands`,
`tools`, and the standard session/system-prompt services. The configured DSH
repository must be clean; `dshBaseRef` and the champion ref must be exact full
commit OIDs. The plugin creates detached worktrees and commits candidates itself.

The command plane accepts:

```text
/refine <seed-task-ref> [--rounds N] [--budget MILLISECONDS] [--target SEMANTIC_TARGET]
/refine status [ROUND_ID]
/refine rollback <VERIFIED_HARNESS_REF>
```

Multi-round batches retain one workspace lock, stop on infrastructure failure,
and otherwise advance serially from the current accepted champion. Rollback
accepts only an immutable harness ref previously accepted by a recorded round.

For run-centered Hitch builds, each successful eval trial records its immutable
`run_id`. The round wake includes the authoritative baseline summary and task
results. A refine-meta session can use the schema-rich `trajectory_query` tool
(or the equivalent persistent-Python `trajectory.query`) without refs to read
the active round index, then pass `refs: [evalIdOrRunId]` for a complete-run
diagnostic summary plus a bounded raw event page. Arbitrary, cross-round, and
held-out refs are rejected. Before a proposal is accepted, Gear verifies that
the mutation cites observed current-baseline evidence and that Meta inspected
the whole-run diagnostics for every failed baseline trial. The audit is stored
on the round record.

The fixed MetaHarness mounts `harness_current`, `harness_read`,
`seed_tasks_load`, `trajectory_query`, `hitch_status`, and
`submit_refinement_proposal` as direct DSH tools alongside `ipython_input`.
IPython remains the persistent composition/scratch environment; it is not the
only discovery or control surface. Its Python objects have explicit signatures
and docstrings, so `help(trajectory.query)` describes the same typed contract.

Load the worker entry only inside the isolated worker composition:

```yaml
- id: refine-worker
  name: dsh-plugin-refine/worker
  config:
    role: target
    targetHarnessRef: 0123456789abcdef0123456789abcdef01234567
    targetManifestDigest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    targetPreset: target-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    sandboxProfileRef: isolated-v1
```

The control-plane plugin provides `ctx.targetWorkers`. Use
`createCurrent(...)` for a new target session so it pins the current champion;
use `create(...)` with a previously accepted exact commit only when resuming an
older session. The registry verifies the commit and manifest before launch.

### Runtime requirements

- Node.js 22.19+ (or 24+), matching DSH.
- Public DSH `0.1.0-rc.8` packages supplied by the host deployment.
- Python 3 with IPython for `ipython_input`. The executable is configurable.
- Meta notebooks require OS-level sandbox support by default: macOS uses the
  built-in `sandbox-exec`; Linux requires Bubblewrap, `socat`, and ripgrep.
  The sandbox runtime is pinned as a package dependency. Windows is not yet a
  supported control-plane host.
- For production evaluation, an installed Hitch `0.2.x` CLI plus Harbor. Local-only
  candidates additionally require Hitch's local-exact-commit transport capability.

The meta kernel is air-gapped, receives a sanitized environment, and can read
and write only its per-session scratch directory plus its Python runtime. Its
logical workspace path is retained solely as session identity; it is not the
kernel's filesystem cwd. `metaSandbox.mode: disabled` exists only for trusted
local diagnosis and invalidates held-out secrecy and the typed-API-only claim.

Target/candidate isolation and scoped credentials remain deployment
responsibilities because those processes run in TargetWorker/Harbor rather
than the control-plane meta sandbox. Hitch/Harbor failures fail the round; the
plugin never falls back to evaluating candidate code in the control plane.

Persisted artifact-era state is intentionally incompatible. Remove or migrate
old `.dsh-refine` state before switching to schema version 2; a `sha256:`
artifact ref is never interpreted as a Git commit.

See [Gear ↔ Hitch CLI integration](docs/hitch-dsh-integration.md) and the
[Hitch local exact commit → Harbor transport requirements](docs/hitch-local-commit-harbor-requirements.md).
For the isolated 1-seed + 1-held-out Terminal-Bench 2.0 setup used during local
development, see the [evolve lab runbook](docs/evolve-lab-runbook.md).

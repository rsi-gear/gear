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
owns refinement rounds, a persistent meta-agent session, content-addressed
harness mutations, and session-aware IPython notebooks. The package also
exports `dsh-plugin-refine/worker`, the role-scoped plugin loaded inside a
target worker.

The package deliberately does not load target harness code in the control
plane. Candidate evaluation is an injected service boundary; the Hitch/Harbor
provider is not part of this release.

### Installation

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

### Runtime requirements

- Node.js 22.19+ (or 24+), matching DSH.
- Public DSH `0.1.0-rc.8` packages supplied by the host deployment.
- Python 3 with IPython for `ipython_input`. The executable is configurable.

Target/candidate isolation, scoped credentials, and a real evaluator remain
deployment responsibilities. The plugin fails closed when no evaluator is
installed; it never falls back to evaluating candidate code in the control
plane.

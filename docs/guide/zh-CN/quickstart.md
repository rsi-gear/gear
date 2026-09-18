# 快速开始

在 Codex、Claude Code、DSH，或其他能够加载 Skill 并调用 Gear 的 Agent 中使用 Refine Skill。用自然语言说明 benchmark、Meta Agent、rollout Agent 和优化轮数，即可开始优化。

## 让 Agent 帮你安装

把下面的 prompt 复制给你正在使用的 Agent，让它完成安装和配置：

```text
请按照 https://rsigear.xyz/docs/gear/zh/quickstart 在当前环境中安装 Gear。
通过 npm 安装 rsi-gear@latest 和 agent-hitch@latest，并检查所需依赖。
把 Gear 自带的完整 Refine Skill 接入我当前使用的 Agent，并配置它与 Gear 的连接。
使用我实际的任务路径、目标 harness 和模型配置；缺少必要信息时再询问我。
完成后验证 Skill 能否连接 Gear，告诉我检查结果，以及如何开始第一次优化。
```

下面是手动安装和发起第一次优化的步骤。

## 1. 安装 Gear

需要 Node.js 22.19+ 或 24+、Git。安装 Gear 和 Hitch；本例同时安装 DSH，作为 rollout Agent：

```bash
npm install --global rsi-gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
hitch eval setup harbor
```

Harbor 任务需要 Docker 已启动，Python/IPython 和 sandbox 依赖见[平台安装说明](../../plugin-installation-and-usage.md)。Gear 包含 `gear-refine` CLI 和完整 Refine Skill。

## 2. 将 Skill 接入你的 Agent

找到已安装的 Skill bundle：

```bash
GEAR_REFINE_SKILL="$(npm root -g)/rsi-gear/skills/refine"
gear-refine skill-identity --path "$GEAR_REFINE_SKILL"
```

使用宿主支持的安装方式，把整个目录加入 Agent 的 Skill catalog，保留其中的 references。Codex、Claude Code 和其他兼容宿主连接 Gear 独立控制面，按照[连接 Meta Agent](meta-agents.md)配置并启动：

```bash
gear-refine serve --config /absolute/path/to/gear-refine.json
```

保持 server 运行，将返回的 `socketPath` 设置为使用 Skill 的 Agent 环境中的 `GEAR_REFINE_SOCKET`。

首次运行前，准备 [Target Harness](target-harness.md)、[benchmark 任务](datasets.md)和 [Standalone 配置](../../harness-agnostic-refine-skill.md)。可以让 Agent 根据真实仓库、任务路径和已安装 runtime 的身份协助完成配置。Meta 和 rollout 模型分别认证。

Meta 与 rollout 可以独立选择。本例使用：

| 角色 | Runtime 与模型 | 职责 |
| --- | --- | --- |
| Meta Agent | Codex + Astra | 通过 Refine Skill 阅读失败证据、改进 Harness。 |
| Rollout Agent | DSH + Luna | 使用各候选 Harness 执行 benchmark 任务。 |

在本例的 Meta 会话中使用 Codex + Astra，让 Gear 配置与实际模型和采样设置一致。DSH 在这里提供 Target runtime。如果也选择 DSH 作为 Meta 宿主，可使用其[原生 Skill 接入](meta-agents.md#dsh-原生-skill)。

## 3. 用自然语言发起优化

通过 Agent 的 Skill 入口加载 Refine，或在支持的宿主中使用 `/refine`。也可以直接用自然语言说：

```text
使用 Refine Skill 优化 AutomationBench 中 Marketing 的部分。
Meta Agent 用 Codex + Astra，rollout 用 DSH + Luna，优化 1 轮。
```

这段指令指定 benchmark 范围、两个 Agent 的配置和轮数，使用前面准备好的 Harness 与任务路径。Gear 评测 baseline，让 Meta 根据允许读取的失败证据修改 Harness，检查并评测候选，记录最终保留的版本。

```text
展示这次优化的结果，以及保留的 Harness 修改。
以相同配置继续 evolution EVOLUTION_ID，再优化 2 轮。
```

继续已有实验时提供返回的 evolution ID。[进化管理](evolutions.md)介绍状态查询、修复与发布。

接下来阅读[案例一：优化 Marketing Harness](example-harness.md)或[案例二：定制进化算法](example-algorithm.md)。模型权重优化使用独立的[实验性训练流程](training.md)。

# Gear 用户指南

Gear 提供可直接调用的 Python 算法与可复用算子，用于改进 Agent Harness。本指南描述当前 Gear 0.2.4 源码中的 API，按[快速开始](quickstart.md)构建匹配版本。Python 定义算法，运行层协调执行、预算、持久化和恢复。

## 选择下一步

- [快速开始](quickstart.md)：安装 CLI 和 Python SDK，准备项目并运行算法。
- [选择和运行算法](algorithms.md)：GEPA、RandomSearch、OPRO、ACE、RRSI、DarwinX、Harness2 的示例与反馈要求。
- [用 Python 修改算法](example-algorithm.md)：修改参数、替换组件和组合算子。
- [任务与评分](datasets.md)：定义任务奖励和 benchmark 输入；[配置](configuration.md)控制聚合目标和预算。
- [运行与恢复](evolutions.md)：接续已有进度、重试符合条件的失败反思并核对用量。
- [阅读报告](results.md)：查看候选评分、学习输出、知识库发布和任务流进度。
- [Target Harness](target-harness.md) 与 [Meta 接入](meta-agents.md)：配置通过 Hitch 执行的模型和环境。
- [模型训练](training.md)：使用独立的实验性 `gear.training` 流程。

## 能力放在哪里

| Python 入口 | 用途 |
| --- | --- |
| `gear.algorithms` | 可交给 `Project.refine` 的完整算法 |
| `gear.core` | 组件、状态、Meta 调用、候选构造和编辑检查 |
| `gear.evaluation` | 任务执行、证据和候选比较 |
| `gear.memory` | 历史、档案、playbook 和版本化指令库 |
| `gear.training` | 训练数据、模型更新和训练流程 |
| `gear.search` | 搜索策略、筛查和流程组合 |

六类搜索策略为 `parents`、`sampling`、`proposal`、`ranking`、`stopping`、`workflow`。例如 `ApplyEdits`、`CheckEdits` 来自 `gear.core`，属于可复用能力。纯算子直接返回值，需要外部执行的算子返回调用请求，由运行层执行。

## 当前验证范围

七个算法已经完成 AutomationBench 十个 Marketing 任务的小规模真实模型运行验证；每算法两轮，Harness2 为每题两步。[算法页](algorithms.md#真实模型验证)分别说明严格检查、ACE/DarwinX 的独立目标补测，以及 Harness2 从已有学习状态接续的验证，并提供源码版本和 journal 摘要。

这些检查验证执行、预算计量和恢复。历史 Marketing 效果案例属于各自固定版本的实验；模型训练保留独立的[验证范围](training.md#验证范围)。

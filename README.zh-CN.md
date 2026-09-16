# Gear

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-加入讨论-5865F2?logo=discord)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md) · [用户指南](https://rsigear.xyz/docs/gear/zh) · [案例](https://rsigear.xyz/docs/gear/zh/examples/marketing-harness)

**用可验证的评测反馈，持续改进 Agent Harness。**

Gear 使用 Meta Agent 将任务轨迹转化为 Harness 修改，在配对条件下评测确切 Git 版本，记录应保留或晋升的候选。改进 Prompt、Skill、Tool 和 Workflow，并保存每项决定背后的证据。

```text
Seed 任务 → Baseline 证据 → Harness 修改 → 配对评测 → 选择
```

> **Pre-alpha。** Gear 0.1.0 支持本地研究和集成；状态格式及扩展 API 可能变化。当前包名为 `gear`。

## 为什么使用 Gear？

- **从经验中改进。** Meta 诊断真实失败，提出可以复用的机制。
- **衡量每项修改。** 比较确切候选和 baseline，保留研究记录与已接受 champion。
- **研究不同算法。** 组合生成、采样、判分、评估、选择和晋升组件。
- **保留可运行结果。** 导出带 manifest、diff 和评测来源的版本化 Harness。

Gear 管理搜索和晋升，[Hitch](https://github.com/rsi-gear/agent-hitch)负责执行与证据，[Rear](https://github.com/rsi-gear/rear)提供可选的只读工作台。

## 两个完整案例

### 1. 优化 Marketing Harness

在 AutomationBench 公开 Marketing 100 题研究集上，五轮迭代将 **Luna medium 的严格通过率从 27% 提升到 36%**。最终保留 Harness 在独立 max 档评测中达到 **50%**。

![五轮 Harness 迭代的候选与 champion 分数；独立 max 评测与官方私有集榜单分别标注。](docs/guide/assets/marketing-harness-evolution.svg)

[案例一](docs/guide/zh-CN/example-harness.md)展示输入指令、最后保留的 Meta 修改、被拒绝候选，以及[可运行 Harness 源码](examples/automationbench-marketing/README.zh-CN.md)。

### 2. 修改进化算法

从前一个 champion 开始，通过共享失败诊断和 **4 → 2 → 1 分阶段评测**运行三轮，medium 达到 **40%**；最终 Harness 在独立 max 档评测中达到 **53%**。

[算法案例](docs/guide/zh-CN/example-algorithm.md)解释个体、父代选择、Meta 变异、适应度、研究 archive 和晋升。提供可运行的选择器组件，以及实际分阶段实现的配置和最终 Harness。这个变异式进化版本没有 crossover；三轮实测候选都来自同一父代。

两个案例均在公开研究集上获取优化反馈，没有独立 held-out 验证。官方榜单使用另一套私有集，参考分数不构成官方 SOTA 证据，见[指标、来源和比较规则](docs/guide/zh-CN/results.md)。

## 快速开始

安装 Gear 和 Hitch。本例使用 DSH 执行 rollout：

```bash
npm install --global gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
hitch eval setup harbor
```

把随包 [Refine Skill](skills/refine/SKILL.md) 接入 Codex、Claude Code、DSH 或其他兼容 Agent。按照[快速开始](docs/guide/zh-CN/quickstart.md)连接 Gear、准备 Harness 和 benchmark，分别配置 Meta 与 rollout Agent。通过宿主的 Skill 入口或支持的 `/refine` 调用，也可以直接用自然语言说：

```text
使用 Refine Skill 优化 AutomationBench 中 Marketing 的部分。
Meta Agent 用 Codex + Astra，rollout 用 DSH + Luna，优化 1 轮。
```

Meta 提出 Harness 修改，rollout Agent 执行 benchmark 任务。[Meta 接入](docs/guide/zh-CN/meta-agents.md)说明独立控制面与 DSH 原生接入。模型权重优化使用独立的[实验性训练流程](docs/guide/zh-CN/training.md)。

## 工作方式

Evolution 封存数据集、模型/采样设置、组件实现和预算。Candidate 是带已验证 manifest 的确切 Git 提交。默认搜索从已接受 champion 生成候选，评估 seed 证据，选择 survivor 与 finalist，再应用配置的晋升规则。研究留档、evolution 晋升和工作区发布是三个不同决定。

Meta 与 Target 分别配置。内置 Target builder 当前使用 DSH，新增类型需要 builder 和 rollout 集成。算法组件遵守版本、工作区边界、证据对等、held-out 隔离和原子状态更新合同。[配置](docs/guide/zh-CN/configuration.md) · [操作](docs/guide/zh-CN/evolutions.md) · [组件接口](src/evolution/components.ts)。

## 实验性模型训练

`gear-refine training` 协调 Slime GRPO 更新、精确 token 捕获、完整 checkpoint 与不可变模型评估，生命周期独立于 Harness 进化。[训练概览](docs/guide/zh-CN/training.md)说明部署与认证范围；已有 GPU 验证记录不代表模型质量提升。

长期方向包含与 Harness 一起演进任务和模型，见[愿景](docs/vision.md)。

## 文档与开发

- [用户指南](docs/guide/zh-CN/index.md)：配置、任务、操作、结果与排错。
- [Harness 示例](examples/automationbench-marketing/README.zh-CN.md)和[算法示例](examples/evolution-search/README.zh-CN.md)。
- [DSH 集成 lab](examples/dsh-codex-luna/README.md)与[详细安装](docs/plugin-installation-and-usage.md)。
- [训练合同与 GPU 认证](docs/training/README.zh-CN.md)。

```bash
npm run typecheck
npm test
npm run build
npm run pack:check
node --test examples/evolution-search/selection.test.mjs
```

图表由[版本化数据](docs/guide/assets/marketing-results.json)通过 `python scripts/render-guide-charts.py` 生成，需要 matplotlib 3.7+。指南源位于 `docs/guide`，gear-pages 导入带校验和的快照。[文档维护说明](docs/guide/README.md)介绍同步与验证；训练 CPU 测试配置见[训练指南](docs/guide/zh-CN/training.md)。

## 社区与许可

欢迎在 [rsi-gear/gear](https://github.com/rsi-gear/gear) 提交具体问题和 PR，或加入 [Discord](https://discord.gg/cZ4NBbHDk)。说明修改希望保留的实验或兼容合同。

[MIT](LICENSE)。

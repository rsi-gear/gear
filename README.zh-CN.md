<div align="center">

# Gear

**面向 harness 递归进化的模块化框架。**

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear?cacheSeconds=300)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-加入讨论-5865F2?logo=discord)](https://discord.gg/ZduvAtS2k)
[![项目主页](https://img.shields.io/badge/Project-website-2F6F5E)](https://rsi-gear.github.io/)

[English](README.md) | [简体中文](README.zh-CN.md) · [用户指南](https://rsigear.xyz/docs/gear/zh) · [案例](https://rsigear.xyz/docs/gear/zh/examples/evolution-search)

</div>

![RSI 实践：AutomationBench 进化实验回放](docs/guide/assets/automationbench-evolution-replay-zh.gif)

<p align="center">
  <strong>RSI 实践：AutomationBench 进化实验回放</strong>
</p>

Gear 是一套开源优化框架，用于提升 AI Agent 在真实世界任务中的表现。

要让 Agent 适应目标场景，首先准备一个包含代表性任务、具有明确验收标准的 benchmark。你可以使用现有 benchmark，也可以[构建自己的任务集](docs/guide/zh-CN/datasets.md)。在这个 benchmark 上运行 [Refine Skill](skills/refine/SKILL.md)。Gear 会利用评测结果，迭代改进 Agent 的模型、指令、工具和工作流程。

下面两个案例对比了 Luna Max 搭配 Gear 优化的 harness，与 Astra Max 搭配 Codex 在相同 AutomationBench 任务中的执行轨迹，展示它们如何读取信息、应用规则，并交付最终结果。

<table>
  <tr>
    <th width="50%">落地页告警</th>
    <th width="50%">精选摘要优化</th>
  </tr>
  <tr>
    <td><a href="docs/guide/assets/landing-page-alerts-replay.mp4"><img src="docs/guide/assets/landing-page-alerts-replay.gif" width="100%" alt="轨迹回放：Luna Max 搭配 GEAR 将 Careers 纳入告警，Astra Max 搭配 Codex 则遗漏了该页面。"></a></td>
    <td><a href="docs/guide/assets/featured-snippet-replay.mp4"><img src="docs/guide/assets/featured-snippet-replay.gif" width="100%" alt="轨迹回放：Luna Max 搭配 GEAR 将用户点名的 crm pricing 加入队列，Astra Max 搭配 Codex 则遗漏了该关键词。"></a></td>
  </tr>
  <tr>
    <td>计分项通过数：Luna <strong>5/5</strong> · Astra <strong>4/5</strong><br><a href="docs/guide/assets/landing-page-alerts-replay.mp4">观看完整尺寸视频</a></td>
    <td>计分项通过数：Luna <strong>2/2</strong> · Astra <strong>1/2</strong><br><a href="docs/guide/assets/featured-snippet-replay.mp4">观看完整尺寸视频</a></td>
  </tr>
</table>

## 实验结果

![GPT 5.6 Luna + DSH 在 Coding、Marketing 和 Support 上的任务通过率，对比 Base（medium）、Gear（medium）和 Gear（max）；右侧展示 Marketing 各已评测 harness 轮次的任务通过率和目标完成率。](https://rsi-gear.github.io/assets/marketing-evolution-overview.svg?v=f0a2e5849038)

[SVG](docs/guide/assets/marketing-evolution-overview.svg) · 数据：[Coding](docs/guide/assets/coding-results.json)、[Marketing](docs/guide/assets/marketing-results.json)、[Support](docs/guide/assets/support-results.json)

### 同模型、同推理档位的 harness 对比

每组对比固定模型和推理档位。Luna 对比原始 DSH harness 与 Gear 优化后的 DSH harness；Astra 对比 Codex 与 Gear 优化后的 DSH harness。

| 模型（推理档位） | Harness | Marketing 通过率 | Marketing 目标完成率 | Support 通过率 | Support 目标完成率 | Terminal-Bench 2.1 通过率 |
| --- | --- | --- | --- | --- | --- | --- |
| GPT 5.6 Luna (medium) | DSH (Base) | 27.0% | 75.4% | 17.0% | 72.9% | 52.8% |
| GPT 5.6 Luna (medium) | DSH + Gear | **40.0%** | **83.9%** | **25.0%** | **81.3%** | **62.9%** |
| Δ（百分点） | | +13.0 | +8.5 | +8.0 | +8.4 | +10.1 |
| GPT 6 Astra (max) | Codex | 57.0% | 84.1% | 35.0% | 88.4% | 86.7% |
| GPT 6 Astra (max) | DSH + Gear | **61.0%** | **86.3%** | **39.0%** | **88.7%** | **87.6%** |
| Δ（百分点） | | +4.0 | +2.2 | +4.0 | +0.3 | +0.9 |

任务通过率是通过全部计分项的任务占比。目标完成率先计算每题满足的计分目标比例，再对任务取平均。Δ 表示绝对提升的百分点，不是相对提升百分比。表中数值保留一位小数。

### 补充评测：Luna 的 max 推理档位

优化后的 DSH harness 还使用 GPT 5.6 Luna 的 max 推理档位进行了评测：

| 任务集 | 任务通过率 | 目标完成率 |
| --- | --- | --- |
| AutomationBench / Marketing | **53.0%** | **88.9%** |
| AutomationBench / Support | **27.0%** | **82.4%** |
| Terminal-Bench 2.1 | **84.3%** | — |

这些结果来自另行开展的更高推理档位评测；相对 Luna medium 基线的提升同时包含 harness 和推理档位的变化。破折号表示该指标未报告。

在 Marketing 上，Luna max 搭配 Gear 的目标完成率为 **88.88%**，Astra max 搭配 Codex 为 **84.08%**；两者任务通过率分别为 **53%** 和 **57%**。另一次费用对比中，两种模型使用同一版优化后的 DSH harness（`a0740800`），**Luna max 平均每题 API 等价费用约为 $0.0568，Astra max 为 $1.1858，Luna 低 95.21%**。详见 [Token 消耗与计费口径](docs/marketing-token-cost.zh-CN.md)。

## 快速开始

通过 **Refine Skill**，你可以在 Codex、Claude Code、DSH 或其他兼容的 Agent 环境中使用 Gear。你可以使用已有 benchmark，也可以用 [Harbor 格式](docs/guide/zh-CN/datasets.md)定义自己的任务。

安装及依赖准备步骤，见[快速开始](docs/guide/zh-CN/quickstart.md)。

**让 Agent 帮你安装。** 把下面的 prompt 复制给你正在使用的 Agent：

```text
请按照 https://rsigear.xyz/docs/gear/zh/quickstart 在当前环境中安装 Gear。
通过 npm 安装 rsi-gear@latest 和 agent-hitch@latest，并检查所需依赖。
把 Gear 自带的完整 Refine Skill 接入我当前使用的 Agent，并配置它与 Gear 的连接。
使用我实际的任务路径、目标 harness 和模型配置；缺少必要信息时再询问我。
完成后验证 Skill 能否连接 Gear，告诉我检查结果，以及如何开始第一次优化。
```

也可以手动安装 Gear 和负责运行评测的 [Hitch](https://github.com/rsi-gear/agent-hitch)。下面用 DSH 作为执行任务的 Agent：

```bash
npm install --global rsi-gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
hitch eval setup harbor
```

按照[安装指南](docs/guide/zh-CN/quickstart.md)，把随包的 [Refine Skill](skills/refine/SKILL.md) 接入你的 Agent，并连接任务集。然后使用宿主支持的 `/refine`，或者直接用自然语言说：

```text
使用 Refine Skill 优化 AutomationBench 中 Marketing 的任务表现。
用 Codex + Astra 提出改进，用 DSH + Luna 执行任务。
运行一轮优化。
```

负责提出改进的 Agent 叫作 **Meta Agent**。它和执行任务的 Agent 可以使用不同的模型。

## 算法设计

![Gear 的内外层学习循环：通过执行、诊断与进化，迭代 harness、seed tasks 和模型。](docs/guide/assets/gear-loop-light.svg)

Gear 采用受 **meta-learning（元学习）** 启发的双层架构，将任务级执行与评测反馈驱动的 harness 优化分为内外两层。

- **内层：任务执行与评测。** 在给定且固定的模型与 harness 配置下，任务 Agent 与任务环境交互，生成执行轨迹和任务结果。评测器依据预先定义的标准对其进行评估，为外层优化提供证据。
- **外层：harness 优化。** Meta Agent 分析执行轨迹与评测反馈，识别失败模式并提出候选 harness 修改。Gear 的优化算法根据配置的优化目标与评测预算，对候选进行评估和选择，确定后续迭代使用的 harness。

模型周围的指令、工具和工作流程，合称 **harness**。Gear 的设计目标是让**模型与 harness 共同进化**：修改 harness，改善做事方法；训练模型，提升模型本身的能力；两者都由任务结果指导。当前已实现 harness 进化，模型训练已有实验性路径，完整的联合迭代闭环仍在建设中。

### 哪些组件可以进化？

优化仅限于你授权 Gear 修改的组件。

| 组件 | 可以改变什么 | 当前状态 |
| --- | --- | --- |
| Prompt 与策略 | 任务指令、系统提示、采取行动时遵循的规则。 | 已支持 |
| 工具与 hooks | 工具实现，以及工具执行前后运行的 hooks。 | 已支持 |
| Skills 与工作流 | 可复用的操作方法、辅助脚本和执行步骤。 | 已支持 |
| 上下文管理 | 让 Agent 看到哪些信息，如何压缩和总结较长的历史记录。 | 已支持 |
| 模型权重 | 利用任务反馈，通过训练更新模型参数。 | 实验性；完整训练与评测闭环仍在建设中 |

### 可定制的算法组件

Gear 的进化循环包含 **Diagnose（诊断）→ Evolve（进化）→ Evaluate（评测）→ Promote（晋升）** 四个阶段。你可以定制各阶段中的以下模块。

| 阶段 | 模块 | 可以定制什么 |
| --- | --- | --- |
| Diagnose（诊断） | Parent selection（父代选择） | 从符合条件的 harness 版本中选择父代，并分配每个父代的候选生成数量。 |
| Evolve（进化） | Proposal planning（提案规划） | 如何利用诊断反馈，规划候选修改。 |
| Evaluate（评测） | Task sampling（任务采样） | 每个阶段评测哪些任务，以及如何设置任务得分的权重。 |
| Evaluate（评测） | Scoring rule（评分规则） | 如何对任务结果评分，并通过可配置的权重与约束组合评测指标。 |
| Promote（晋升） | Candidate ranking（候选排序） | 如何比较在相同任务和评测条件下运行的候选。 |

运行层负责执行任务、保存评测证据和完成最终验收。你可以参考[算法示例](docs/guide/zh-CN/example-algorithm.md)和 [Python 组件接口](python/gear/algorithms/__init__.py)，基于这些组件开发算法。

你可以[定义加权优化目标](docs/guide/zh-CN/configuration.md#加权目标和保护任务)，组合已声明的通过率、过程分、费用或 token，并保留所有原始计量。

## 看看两个完整案例

- [优化 Marketing harness](docs/guide/zh-CN/example-harness.md)：了解五轮 harness 优化，从初始配置到最终保留的 harness。
- [定制优化算法](docs/guide/zh-CN/example-algorithm.md)：修改 Gear 如何提出候选改动、选择评测任务和保留候选。Marketing 实验采用 GEPA 的一种变体，将更多评测预算分配给有潜力的候选。

## 架构

![Gear 架构：Task Registry 与 Agent 汇入优化引擎，Evaluator 将轨迹写入 Trajectory Storage，存储向引擎返回反馈并为 Trainer 提供训练数据。引擎更新 seed task 和 harness，Trainer 更新模型；右上角的 Serve、Diagnose、Evolve 圆形循环与数据流动画同步，底层由 Hitch 支持。](docs/guide/assets/gear-architecture-light.svg)

[深入了解 Hitch](https://github.com/rsi-gear/agent-hitch)

## Roadmap

Gear 目前已支持 harness 优化。完整学习循环中的两个组件仍在建设中：

- [ ] **迭代模型训练与评测。** 利用任务反馈训练模型、评测更新后的模型，并重复这一过程。已有[实验性训练流程](docs/guide/zh-CN/training.md)，但完整的模型迭代闭环尚未完成。
- [ ] **自动生成 seed tasks。** 根据任务失败情况，构造有针对性的练习任务，即 *seed tasks*，并将其纳入后续优化轮次。这套自动生成任务的闭环尚未完成。

## 引用

如果在研究中使用 Gear，请引用以下预印本。[项目主页](https://rsi-gear.github.io/#citation)提供当前引用信息；arXiv 链接尚未发布。

```bibtex
@unpublished{tang2026gear,
  title  = {{GEAR}: An Open General Evolutionary Architecture for
            Recursive Self-Improvement of {LLM} Agent Harness},
  author = {Tang, Yehui and Zhu, Guanqi and Xia, Shao-Jun and
            Chen, Xin and Geng, Mengzhe and Du, Hongyang and Tang, Yuhao},
  year   = {2026},
  note   = {Preprint},
  url    = {https://github.com/rsi-gear/gear}
}
```

## 一起完善 Gear

阅读[用户指南](docs/guide/zh-CN/index.md)，查看[示例代码](examples/evolution-search/README.zh-CN.md)，或加入 [Discord](https://discord.gg/ZduvAtS2k) 讨论。

本地开发：

```bash
npm ci
npm run typecheck
npm run build
npm test
```

[贡献指南](CONTRIBUTING.md) · [文档维护说明](docs/guide/README.md) · [GitHub Issues](https://github.com/rsi-gear/gear/issues) · [MIT 许可](LICENSE)

模型评测可接入[独立推理副本池](docs/training/standalone-inference.zh-CN.md)，显式配置张量并行、副本与 trial 并发。

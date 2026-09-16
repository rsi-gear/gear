# Gear

**Adapt your agent to any task. 让你的 Agent 学会做好你的任务。**

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-加入讨论-5865F2?logo=discord)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md) · [用户指南](https://rsigear.xyz/docs/gear/zh) · [案例](https://rsigear.xyz/docs/gear/zh/examples/evolution-search)

给 Gear 一组能检查对错的任务。它会让 AI Agent 尝试完成任务，找出失败的原因，再改进指令、工具和做事步骤，让 Agent 越做越好。

## 小模型，也能和顶尖模型掰手腕

在 **AutomationBench 的 100 个公开 Marketing 任务**上，Gear 将 **GPT 5.6 Luna max 的过程分提升到 88.88%，高于 Codex + GPT 6 Astra max 的 84.08%**；**任务通过率达到 53%，接近 Astra 的 57%**。小模型平均完成了更多评分要求，整题通过率也已接近前沿模型。

![案例二：Gear 优化后的 harness 搭配 GPT 5.6 Luna max，过程分为 88.88%、任务通过率为 53%；Codex 搭配 GPT 6 Astra max 的对应结果为 84.08% 和 57%。](docs/guide/assets/marketing-staged-search.svg)

## 已验证的任务

当前算力预算有限，我们先在下面的任务集上验证优化效果，并公开优化前、优化后和领先模型（SOTA）的对照结果。

| 已验证任务集 | 指标 | 优化前 · medium | 优化后 · medium → max | SOTA 模型参考 |
| --- | --- | ---: | ---: | ---: |
| AutomationBench / Marketing · 100 题 | 任务通过率 | 27% | **40% → 53%** | 57% |
| AutomationBench / Marketing · 100 题 | 过程分 | 75.37% | **83.87% → 88.88%** | 84.08% |

优化前后使用 DSH + GPT 5.6 Luna，对照使用 Codex + GPT 6 Astra max，均在同一组 100 个公开任务上评测。**Medium → medium 展示 harness 改进的效果；max 档额外增加了推理预算。** 过程分表示完成了多少评分要求，任务通过则要求整道题的评分要求全部满足。

这组公开任务也用于指导优化。表中的 SOTA 模型参考是我们对 Astra 的实测，官方榜单使用另一组私有测试任务，在图中以星号标出。[评分方式与来源](docs/guide/zh-CN/results.md) · [完整实验](docs/guide/zh-CN/example-algorithm.md)。

## 快速开始

Gear 是一个可以通过 **Skill** 调用的优化库，能接入 Codex、Claude Code、DSH 或其他兼容 Agent。你可以使用已有 benchmark，也可以用 [Harbor 格式](docs/guide/zh-CN/datasets.md)定义自己的任务。

安装 Gear 和负责运行评测的 [Hitch](https://github.com/rsi-gear/agent-hitch)。下面用 DSH 作为执行任务的 Agent：

```bash
npm install --global gear@latest agent-hitch@latest @deepseek-ai/dsh@latest
hitch eval setup harbor
```

按照[安装指南](docs/guide/zh-CN/quickstart.md)，把随包的 [Refine Skill](skills/refine/SKILL.md) 接入你的 Agent，并连接任务集。然后使用宿主支持的 `/refine`，或者直接用自然语言说：

```text
使用 Refine Skill 优化 AutomationBench 中 Marketing 的任务表现。
用 Codex + Astra 提出改进，用 DSH + Luna 执行任务。
运行一轮优化。
```

负责提出改进的 Agent 叫作 **Meta Agent**。它和执行任务的 Agent 可以使用不同的模型。

## 算法设计：学习如何改进自己

Gear 采用 **meta-learning（元学习）**的设计：一层负责做任务，另一层学习如何改进做任务的 Agent。

- **内层：完成任务。** 执行任务的 Agent 使用当前模型、指令和工具，尝试解题。
- **外层：改进 Agent。** Meta Agent 阅读成绩和失败记录，提出修改，再通过评测找出更好的版本。

模型周围的指令、工具和工作流程，合称 **harness**。Gear 的设计目标是让**模型与 harness 共同进化**：修改 harness，改善做事方法；训练模型，提升模型本身的能力；两者都由任务结果指导。当前已实现 harness 进化，模型训练已有实验性路径，完整的联合迭代闭环仍在建设中。

### 哪些组件可以进化？

在你允许 Gear 编辑的范围内：

| 组件 | 可以改变什么 | 当前状态 |
| --- | --- | --- |
| Prompt 与策略 | 任务指令、系统提示、采取行动时遵循的规则。 | 已支持 |
| 工具与 hooks | 工具代码，以及工具运行前后的检查和处理。 | 已支持 |
| Skills 与工作流 | 可复用的操作方法、辅助脚本和执行步骤。 | 已支持 |
| 上下文管理 | 让 Agent 看到哪些信息，如何压缩和总结较长的历史记录。 | 已支持 |
| Harness 组合 | 使用哪些插件和服务，以及如何配置它们。 | 已支持 |
| 模型权重 | 利用任务反馈训练模型本身。 | 实验性；完整迭代闭环尚未完成 |

你还可以修改**优化算法本身**：如何提出修改、挑选任务、执行和评分、比较候选，以及决定保留哪个版本。[案例二](docs/guide/zh-CN/example-algorithm.md)用基于 GEPA 的搜索展示了这些可替换模块。

Gear 保存每一版改动和结果，你可以查看过程，也可以直接使用最终的 harness。

## 看看两个完整案例

- [优化 Marketing harness](docs/guide/zh-CN/example-harness.md)：从初始指令开始，跟着五轮修改走到最终产物。
- [定制进化算法](docs/guide/zh-CN/example-algorithm.md)：修改 Gear 如何提出改进、挑选测试任务、保留更好的版本。Marketing 实验采用 GEPA 的一种变体：先测试几个想法，再把更多评测机会分给有希望的方案。

## 一起完善 Gear

阅读[用户指南](docs/guide/zh-CN/index.md)，查看[示例代码](examples/evolution-search/README.zh-CN.md)，或加入 [Discord](https://discord.gg/cZ4NBbHDk) 讨论。

本地开发：

```bash
npm ci
npm run typecheck
npm run build
npm test
```

[文档维护说明](docs/guide/README.md) · [GitHub Issues](https://github.com/rsi-gear/gear/issues) · [MIT 许可](LICENSE)

## Roadmap

Gear 现在已经可以改进 harness。更完整的学习循环，还有两块能力正在建设：

- [ ] **迭代模型本身。** 用任务结果训练模型，再测试新版本，持续改进。已有[实验性训练流程](docs/guide/zh-CN/training.md)，但完整的模型迭代闭环尚未完成。
- [ ] **把失败任务变成新的练习题。** 根据 Agent 做错的任务，构造有针对性的起始任务，也就是 *seed tasks*，用于下一轮优化，帮助它练习薄弱环节。这套自动生成任务的闭环尚未完成。

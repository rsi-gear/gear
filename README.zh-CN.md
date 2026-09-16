# Gear

**Adapt your agent to any task. 让你的 Agent 学会做好你的任务。**

[![GitHub release](https://img.shields.io/github/v/release/rsi-gear/gear)](https://github.com/rsi-gear/gear/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-加入讨论-5865F2?logo=discord)](https://discord.gg/cZ4NBbHDk)

[English](README.md) | [简体中文](README.zh-CN.md) · [用户指南](https://rsigear.xyz/docs/gear/zh) · [案例](https://rsigear.xyz/docs/gear/zh/examples/evolution-search)

给 Gear 一组能检查对错的任务。它会让 AI Agent 尝试完成任务，找出失败的原因，再改进指令、工具和做事步骤，让 Agent 越做越好。

## 小模型，也能和顶尖模型掰手腕

在 **AutomationBench 的 100 个公开 Marketing 任务**上，Gear 帮助 **GPT 5.6 Luna 完成了 53 个任务**，接近 **Codex + GPT 6 Astra max 的 57 个**。小模型与前沿模型的差距，缩小到了四个任务。

![案例二：Gear 将 GPT 5.6 Luna 在 medium 档的通过数从 27 提升到 40，max 档达到 53；Codex 搭配 GPT 6 Astra max 通过 57 个任务，Gear 优化后的 harness 搭配 Astra max 通过 61 个。](docs/guide/assets/marketing-staged-search.svg)

| Agent 配置 | 模型与推理档位 | 通过任务数 / 100 |
| --- | --- | ---: |
| 原始 DSH | GPT 5.6 Luna medium | 27 |
| Gear 优化后的 DSH | GPT 5.6 Luna medium | 40 |
| Gear 优化后的 DSH | GPT 5.6 Luna max | **53** |
| Codex | GPT 6 Astra max | **57** |
| Gear 优化后的 DSH | GPT 6 Astra max | **61** |

在相同推理档位下，Gear 把 Luna 的成绩从 27 提升到 40。再给优化后的 Agent 更多推理时间（`max` 档），成绩达到 53。同一套改进后的指令和工具，搭配 Astra max 时达到了 61。

只有满足全部评分要求，任务才算通过。这组公开任务也用于指导优化；图中带星号的结果来自另一组官方私有测试任务。详见[评分方式与来源](docs/guide/zh-CN/results.md)。

[案例二](docs/guide/zh-CN/example-algorithm.md)展示了使用的算法、具体改动和可运行代码。

## Gear 是怎么做到的？

模型需要指令、工具，以及使用工具的方法。这些配套部分合称 **harness**。Gear 用一个简单的循环来改进它：

1. **先试一遍。** 看看 Agent 已经能完成哪些任务。
2. **找出原因。** 另一个 Agent 阅读失败记录，提出改进办法。
3. **做出修改。** 调整指令、工具、技能或完成任务的步骤。
4. **重新测试。** 对比成绩，保留有用的修改，再继续下一轮。

你来决定优化哪些任务、运行几轮。Gear 保存每一版改动和结果，你可以查看过程，也可以直接使用最终的 harness。

Gear 是一个可以通过 **Skill** 调用的优化库，能接入 Codex、Claude Code、DSH 或其他兼容 Agent。你可以使用已有 benchmark，也可以用 [Harbor 格式](docs/guide/zh-CN/datasets.md)定义自己的任务。

## 快速开始

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

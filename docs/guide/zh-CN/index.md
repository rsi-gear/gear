# Gear 用户指南

Gear 是一个可通过 Skill 调用的 Agent 优化算法库。给定现有 benchmark，或使用 Harbor 格式定义自己的 benchmark，Gear 就能根据评测反馈自动优化 Agent Harness 和模型。

## 选择阅读路径

- [快速开始](quickstart.md)：安装 `rsi-gear@latest`，将 Refine Skill 接入 Codex、Claude Code 等 Agent，用自然语言发起优化。
- [案例一：优化 Marketing Harness](example-harness.md)：五轮迭代、初始指令、最终保留修改；固定 Luna medium，通过率从 27% 到 36%。
- [案例二：定制进化算法](example-algorithm.md)：七类可定制算法模块、精英选择器，以及实际的 4 → 2 → 1 分阶段搜索实验。
- [模型训练](training.md)：实验性 Slime 训练路径、部署条件与验证范围。

## 可以进化哪些部分

| 部分 | Gear 可以优化的内容 |
| --- | --- |
| 提示词与策略 | 系统提示词、行为规则和任务指令。 |
| 工具与 hooks | 工具定义、实现，以及 Agent 执行动作前后的 hooks。 |
| Skills 与 workflows | 可复用流程、辅助程序，以及 Agent 发现和使用它们的方式。 |
| 上下文管理 | 通过 Harness 扩展点调整上下文组装、注入和压缩。 |
| Harness 组合 | 启用哪些插件和 provider，以及它们的配置。 |
| 模型权重 · 实验性 | 固定 Harness 和数据集，通过 Slime GRPO 训练更新模型。 |

从 [Harness 进化案例](example-harness.md)开始，了解如何[准备可编辑的 Target](target-harness.md)，或探索[模型训练](training.md)。

## 可以修改哪些算法组件

| 组件 | 可以修改的内容 |
| --- | --- |
| 候选生成 | 候选槽位，以及在可用父代之间的分配方式。 |
| 任务采样 | 任务选择、评测范围和重复次数。 |
| Rollout 后端 | 如何执行候选版本并产出评测证据。 |
| 适应度评分 | 根据评测证据计算哪些指标。 |
| 候选评估 | 排序依据，以及可选的 verifier 推理。 |
| 生存者选择 | 保留哪些候选，包括精英保留、多样性和平分处理。 |
| Champion 晋升 | 替换当前 champion 的接受阈值与配对评测检查。 |

组合这些组件来定义自己的搜索算法。[案例二](example-algorithm.md)介绍扩展接口、精英选择器和分阶段评测设计。

## 支持范围与版本

本指南对应 Gear 0.1.0，包名为 `rsi-gear`，目前为 pre-alpha。Standalone 的 Meta 接口不绑定宿主 Harness；内置 Target builder 当前围绕 DSH。Hitch 支持某个 Harness，并不自动意味着 Gear 已有对应的 Target builder。

分阶段搜索案例使用[来源记录](example-algorithm.md#实现与版本)中固定的实现；不能将其配置当成所有 0.1.0 checkout 都支持的开关。历史 Marketing 实验使用公开研究集，并从同一批任务获取优化反馈，没有独立 held-out 结果。

## 继续使用

依次阅读[连接 Meta](meta-agents.md)、[准备 Target](target-harness.md)、[准备任务](datasets.md)、[管理进化](evolutions.md)和[理解结果](results.md)。部署时可查阅[配置参考](configuration.md)与[排错指南](troubleshooting.md)。

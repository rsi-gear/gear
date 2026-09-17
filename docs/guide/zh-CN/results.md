# 理解结果与证据

一起检查覆盖率和分数。一个有用的改进结论应明确版本、可比任务，以及随后作出的决定。

## Marketing 的两个指标

严格通过率是 `task_completed_correctly` 的均值：一题的全部计分断言满足才算通过。`partial_credit` 是断言完成比例，仅用于诊断，不是轨迹质量分，也不能替代完整任务成功。断言排除规则可能改变分母，解释变化前应查看 verifier 详情，见[上游评分定义](https://github.com/zapier/AutomationBench#scoring)。

报告通过数/有效题数、无效槽位、物理执行数、配对改善与退步。不能把一个候选的 9 题 local 分数与另一个候选的不同 15 题直接比较。

## 官方 Marketing 参考

图中横轴为通过率、纵轴为目标完成度；官方私有 held-out 参考用 `*` 标记。两个参考指标均为 Marketing 分项，查询日期为 2026-09-14：

| 官方配置 | 通过率 · Zapier | 目标完成度 · AA |
| --- | --- | --- |
| GPT-6 Astra max* | 50.00% | 83.68% |
| Gemini 3.8 Flash high* | 43.00% | 77.98% |

横坐标来自 [Zapier 的 By domain → Marketing 榜单](https://zapier.com/benchmarks)，纵坐标来自 [Artificial Analysis 的 Objectives Completed by Domain → Marketing](https://artificialanalysis.ai/evaluations/automationbench-aa)。这两个坐标汇集分别公开的 Marketing 测量，不表示同一次评测的两个指标。Fable 未出现在图中，因为该分项榜单未公开其 Marketing 通过率。

AA 的完成度汇总已达成的 objectives，不考虑 guardrail 是否违反；本地 `partial_credit` 先计算每题全部断言（包含 guardrail）的通过比例，再对任务求平均。AA headline Score 是另一项指标，未用于图中。图底注明来源与评分口径差异。

本地实验使用参与过优化的 100 道公开 Marketing 题，带星号的参考使用私有 held-out 题。同图展示提供背景参考，不构成官方 SOTA 证明。见[公开与私有集说明](https://github.com/zapier/AutomationBench#public-vs-official-scores)。

## Terminal-Bench 2.1 参考来源

README 中 Terminal-Bench 2.1 的领先模型成绩来自 [Terminal-Bench 2.1 官方榜单](https://www.tbench.ai/?version=2.1)，使用榜单的 Resolution Rate（任务通过率）指标。Gear 的成绩来自本地评测。

## 阅读决定与来源

检查 candidate commit/manifest、模型与实际 effort、数据身份、runtime、有效槽位和原始失败。研究候选留档与 champion 用途不同。补证后由用户授权的晋升，也应如实记录，不能描述为无中断的自动 held-out 晋升。

```bash
hitch --root /absolute/hitch-state eval inspect EVAL_ID --json
hitch --root /absolute/hitch-state trajectory inspect RUN_ID
```

查询语法以对应版本的 Hitch 指南为准；也可用 Rear可视化对比。Rear 指向相同的 Gear/Hitch state roots，是可选只读工具。

## 来源材料

示例提供确切 Harness 文件、manifest、最后保留补丁、Meta 输入和简明证据索引。[图表数据](../assets/marketing-results.json)记录范围、来源 hash、决定与限制。下载包包含检查后的源码和摘要，不包含凭据或完整私有控制面日志；公开摘要不能代替原生 trial 证据导回实验存储。

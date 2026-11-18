# 选择和运行算法

完整算法从 `gear.algorithms` 导入。先调用现成算法，再按实验需要替换其中的组件。[快速开始](quickstart.md)介绍下文所需的 Python 包、项目、benchmark 和执行 profile。

| 算法 | 主要行为 | 算法使用的反馈 |
| --- | --- | --- |
| [GEPA](#gepa) | 分阶段候选搜索 | 已评分的任务证据 |
| [RandomSearch](#randomsearch) | 随机父代与探索性提案 | 已评分的任务证据 |
| [OPRO](#opro) | 根据评分历史更新提示词 | 得分与执行证据 |
| [ACE](#ace) | 增量更新 playbook | 得分与执行证据 |
| [RRSI](#rrsi) | 提案先筛查再评测 | critic 结果与评分证据 |
| [DarwinX](#darwinx) | 提示词更新与新样本确认 | 额外执行产生的评分证据 |
| [Harness2](#harness2) | 按任务顺序持续学习 | 目标输出和消息轨迹；评分保持私有 |

## 统一的 Python 入口

对于已经配置好的 DSH 项目：

```python
from gear import Project
from gear.algorithms import ACE, GEPA, OPRO, RRSI, DarwinX, Harness2, RandomSearch

project = Project.open("./my-benchmark")
recipe = OPRO(prompt_path="prompts/system.md")
plan = project.plan_refine(algorithm=recipe, rounds=2)
print(plan)
run = project.refine(algorithm=recipe, rounds=2)
print(run.id, run.report.summary)
```

从下文选择一个 `recipe`。预览会检查准入条件，不调用模型；正式运行使用项目中的[预算](configuration.md#生成与诊断预算)。Notebook 中使用 `await project.aplan_refine(...)` 和 `await project.arefine(...)`，参数相同。

OPRO、ACE、RRSI、DarwinX、Harness2 的默认提示词路径是 Pi 的 `AGENTS.md`。标准 DSH Target 传入 `prompt_path="prompts/system.md"`；文件须存在且在允许修改的范围内。GEPA 和 RandomSearch 使用 Target 授权的可编辑资源，不使用这个单文件参数。

七个算法都支持 Python 类入口。当前 CLI/YAML 内置短名为 `gepa` 和 `random-search`；其他算法由 Python SDK 捕获类及其组件配置后交给运行时。`gear algorithm test` 覆盖这两个算法和父代策略，并非所有已导出算法的通用测试入口。

## GEPA

```python
recipe = GEPA(promotion_widths=(2, 1), global_gate="no_regression")
```

搜索按 local、bridge、global 任务范围逐步推进。`promotion_widths` 控制每个父代批次进入后续阶段的候选数；`global_gate="no_regression"` 要求候选在 bridge 范围的表现不低于父代，才进入完整 seed 评测。候选生成预算和评测预算单独配置。

可替换 `parent_policy`、`sampler`、`proposal_planner`、`ranker`、`stop_rule`。[4 → 2 → 1 教程](example-algorithm.md#配置-4-2-1-候选批次)说明范围扩展及执行次数。

## RandomSearch

```python
recipe = RandomSearch()
```

RandomSearch 使用随机父代、探索性提案和全任务评估。默认提案不需要单独的诊断调用；自定义提案策略可以通过 `diagnose=True` 显式开启诊断。

它与 GEPA 提供相同的父代、采样、提案、排名和停止组件，适合需要明确生成和评测预算的简单搜索基线。

## OPRO

```python
recipe = OPRO(prompt_path="prompts/system.md")
```

每轮根据评分历史提出提示词修改，构造精确编辑后的候选，再在共同任务范围内评测和比较。`rounds=2` 表示最多两轮提案，仍受可用预算限制。

新候选必须证据完整且满足配置的约束。当前提示词违反约束时，合格的新候选可以替换它；否则需要比较分数提高。ACE、RRSI、DarwinX 复用这一采纳规则。

可替换 `proposer`、`reader`、`editor`、`evaluator`、`ranker`。报告展示保留候选以及最终提名和接受门结果；某轮完成不代表它提出的修改被采纳。

## ACE

```python
recipe = ACE(prompt_path="prompts/system.md")
```

ACE 对具有稳定条目 ID 的 playbook 提出增加、替换和删除操作，将新 playbook 写入提示词，评测候选后保留有效更新。`merger` 控制如何应用条目变化；提案、编辑、评估和比较组件也可替换。

## RRSI

```python
recipe = RRSI(prompt_path="prompts/system.md")
```

RRSI 增加 `ScreenedEvaluate` 组合：精确编辑检查、Meta critic 和筛查判定先于目标执行。筛查拒绝的候选不会进入这一评测路径；critic 调用仍消耗 Meta 预算。替换 `screen` 或其子组件即可修改行为，[组件定制](example-algorithm.md)给出嵌套参数修改示例。

## DarwinX

```python
recipe = DarwinX(prompt_path="prompts/system.md")
```

DarwinX 在 OPRO 上默认开启确认阶段，为 anchor、当前最佳版本和新候选请求 fresh 执行样本，再确认更新。额外执行计入目标评测预算。fresh 描述重新执行的采样请求；统计独立性仍取决于 provider 实际支持的随机条件。

## Harness2

Harness2 根据输出和轨迹持续学习可复用的目标指令。配置 blind 访问与本次准入的确切 seed 任务顺序：

```python
from gear import Project
from gear.algorithms import Harness2
from gear.core import AccessPolicy

project = Project.open("./my-benchmark")
task_order = ("sum-01", "sum-02")  # 替换为实际准入的 seed 任务 ID。
recipe = Harness2(prompt_path="prompts/system.md")
access = AccessPolicy(
    exposure="blind",
    rollout_backend="scored_private",
    task_order=task_order,
)
run = project.refine(algorithm=recipe, access=access, rounds=2)
print(run.report.summary["operators"]["outcome"])
```

这里的 `rounds=2` 表示**每题**执行两次 rollout 与学习：两题共四步，十题共二十步。每步使用此前发布的指令库，学习提交后才推进任务流，因此这些具有学习依赖的步骤按顺序执行。

目标输出可用但轨迹缺失时，反思会仅基于输出继续；目标执行不可用时，算法以失败结果结束，该步不再发起 Meta 调用。

`scored_private` 允许 Hitch 在内部评分供操作者查看；算法及其 Meta 调用看不到评分、标准答案和 verifier 反馈。结果是版本化指令库、任务输出和任务流进度；库发布与 champion 晋级是独立事件。详见[报告](results.md#算法与学习结果)。

可替换 `rollout`、`reflect`、`reader`、`commit`、`publish`、`complete`。符合条件的反思失败后，[续跑](evolutions.md#重试已结算的只读-meta-失败)会保留已完成的目标输出和已发布学习结果。

## 真实模型验证

2026-11-18 完成的验证使用 AutomationBench 的十个 Marketing 任务，Meta 为 Hitch/Codex + GPT 5.6 Luna low，Target 为 Hitch/DSH + 同模型同推理档位。六个算法各运行两轮，Harness2 为每题两步。已经验收的运行保留原结果，Harness2 在原 run 中接续。

| 算法 | 实际运行结果 | 目标观测 |
| --- | --- | --- |
| GEPA | 两轮，严格检查通过 | 30 次有效 |
| RandomSearch | 两轮，严格检查通过 | 30 次有效 |
| OPRO | 两轮，只读复核通过 | 30 次有效；没有重跑 |
| ACE | 两轮完成，单独补验一条目标失败 | 原 29 次有效、1 次无效；另有 1 次有效补测 |
| RRSI | 两轮，覆盖 critic 拒绝分支 | 20 次有效 |
| DarwinX | 两轮及最终评测完成，单独补验一条目标失败 | 原 89 次有效、1 次无效；另有 1 次有效补测 |
| Harness2 | 20 步学习、20 次知识库发布成功 | 20 次有效；其中 9 次为恢复前已有结果 |

ACE、DarwinX 的独立补测不替换原失败观测，也不修改算法当时的决策。Harness2 保留了八步学习和九次目标执行，再补十二次反思、十一次目标执行。原失败反思继续计入用量，并通过恢复记录关联成功的新尝试。

[验证摘要](../assets/algorithm-validation.json)记录源码版本、任务 ID、run ID、journal 摘要及计数。该实验检查小规模任务集上的执行、计量和恢复；有效观测包括有效零分，这些数量不代表任务通过率、优化收益或同名论文的完整复现。历史 Marketing 效果数据属于各自固定版本的实验。

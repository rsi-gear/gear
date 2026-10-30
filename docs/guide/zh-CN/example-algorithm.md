# 用 Python 修改算法

`MetaHarness` 将 Meta-Harness 外层循环适配到 Gear：每个候选都在完整 seed 集上评测，从完整证据中得分最高的候选继续生成，并要求 Gear Meta worker 使用有界只读 seed 历史中的候选差异、分数和执行轨迹来支撑单个提案。提名后仍由 Gear 独立执行 held-out gate。这是对论文方法的 Gear 适配，不代表复现论文中的特定 harness 或其报告结果。

公开作者 API 是 `gear.algorithms`。GEPA 和 RandomSearch 都由父代、采样、提案、排名、停止和阶段编排六个模块组成；GEPA 是公共模块合同的实例。

下面用一个命名函数替换父代策略：

```python
# my_policy.py
from gear.algorithms import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain("no eligible parent")
    return ParentPlan.single(rng.choice(view.eligible, key="parent"), view.candidate_limit)
```

```sh
python -m gear algorithm test my_policy:select_parent
python -m gear algorithm test gepa
python -m gear algorithm test random-search
python -m gear algorithm test meta-harness
```

```python
from gear import Project
from gear.algorithms import GEPA
from my_policy import select_parent

run = Project.open(".").refine(algorithm=GEPA(parent_policy=select_parent), rounds=1)
print(run.report.summary)
```

前三个测试只需要基础 Python 包，不调用模型。真实项目调用需要 npm runtime 和已配置的执行 profiles。Notebook 使用 `await project.arefine(...)`。

从 [六模块索引](../../search-algorithm-authoring.zh-CN.md)定位代码和类型合同。策略输入只有允许的 seed 投影，返回 JSON 状态和明确操作。运行层负责预算、执行、证据身份、held-out gate 和 champion CAS。

源码与声明依赖在 admission 时冻结；局部函数、lambda 和未声明的依赖不能作为可恢复的算法配置。修改代码产生新身份。历史 TS selector/search 子路径已从公开导出中移除。

## 配置 4 → 2 → 1 候选批次

`GEPA(promotion_widths=(2, 1))` 是默认配置：每个父代批次的候选在同一 local scope 内排名，最多两个进入 bridge，再让 bridge 中排名最高的合格候选进入全量 seed 评测。这是候选数量限制，与任务采样比例独立。扩评不要求候选分数严格高于父代；违反约束的候选仍被排除，任一参与者证据不完整时整批不晋级。最终接受门由运行层单独执行。

项目已配置 benchmark、Target 和执行 profiles 后，可用以下 `gear.yaml` 允许一轮最多生成四个候选：

```yaml
version: 1
benchmark: ./benchmark.yaml
target: {adapter: dsh, path: ./target, profile: default-target}
meta: {profile: default-meta}
algorithm: {name: gepa, options: {promotion_widths: [2, 1]}}
objective: {metric: pass_rate}
validation: {mode: research}
budget: {rounds: 1, max_candidates: 4, max_evaluations: 400, repetitions: 1}
```

默认父代策略只分配一个批次。实际形成 4 → 2 → 1 还需要四个可执行提案、生成成功以及充足的 Meta 和评测预算。`budget.max_candidates` 是整个 run 的生成上限；`ScopedFrontier(batch_count=...)` 控制父代批数，`promotion_widths` 则分别作用于每个批次，因此多批可能产生多个全量候选。新 run 会冻结当时配置的选项，已有 run 恢复时沿用原选项。预算与独立 held-out 配置见[配置指南](configuration.md)。

默认采样器在各任务池充足时使用 8% local + 4% shared + 3% cross，然后扩到 40% bridge、100% global。数量向上取整；任务池不足时实际 local 并集可能更小。单批四个合格候选、各阶段范围嵌套、每题一次运行并复用有效 cells 时，仅候选的新增执行量如下：

| Seed 任务数 | 每候选 local 任务数 | Bridge 任务数 | 候选新增执行量 |
| --- | ---: | ---: | ---: |
| 100 | 15 | 40 | `4 × 15 + 2 × (40 − 15) + (100 − 40) = 170` |
| 1,000 | 150 | 400 | `4 × 150 + 2 × (400 − 150) + (1,000 − 400) = 1,700` |

Baseline、父代 scope 补评、held-out 和修补执行另计，共享整个 run 的预算。YAML 中 400 次上限是面向 100 题同集研究的示例预算，不是成本保证。阶段无法放入剩余预算时，流程停止，不缩小已冻结范围，也不超支。

历史 Marketing 实验也使用 4 → 2 → 1 候选限制，但其固定的 [TypeScript 源码](../assets/staged-search-source.zip) 为不同失败类别建立独立 local scope，并按类别轮转分配 bridge 名额。当前 Python 流程在一个父代批次共用的 local scope 内排名，提名与最终接受规则也由当前实现定义。恢复宽度不代表完整复现历史算法，历史结果不能作为当前 Python 实现的性能实测。

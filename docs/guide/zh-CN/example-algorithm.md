# 用 Python 修改算法

完整算法从 `gear.algorithms` 使用；可复用策略位于 `gear.search` 的父代、采样、提案、排名、停止和编排六个模块。GEPA 和 RandomSearch 组合这些公共能力；其他算子分别从 core、evaluation、memory、training 使用。

## 先修改参数

从[完整算法](algorithms.md)开始。组件支持 `get_params`、`set_params` 和 `clone`，可在运行前修改嵌套配置：

```python
from gear.algorithms import RRSI
from gear.core import clone

recipe = RRSI(prompt_path="prompts/system.md")
recipe.set_params(screen__edit_check__max_changed_bytes=32_768)
variant = clone(recipe)
print(variant.get_params(deep=True)["screen__edit_check__max_changed_bytes"])
```

clone 复制组件配置，不复制学习状态。准入后配置被冻结；修改已运行对象不会改变既有 run。新实验用新的配置对象，继续原实验用[恢复入口](evolutions.md)。

## 替换组件

以 GEPA 为例，用一个命名函数替换父代策略：

```python
# my_policy.py
from gear.search.parents import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain("no eligible parent")
    return ParentPlan.single(rng.choice(view.eligible, key="parent"), view.candidate_limit)
```

```sh
python -m gear algorithm test my_policy:select_parent
python -m gear algorithm test gepa
python -m gear algorithm test random-search
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

## 组合算子

`ApplyEdits`、`CheckEdits` 等纯算子直接返回值；`Meta`、`Evaluate`、`Rollout` 等外部算子返回 `Call`，提交 `Decision` 后由运行时执行。结果通过保存的调用引用读取。下面的最小算法执行一次审查并返回结果，保存为 `review_algorithm.py`：

```python
from gear.core import Meta, MetaInput
from gear.search import Algorithm, Decision, Terminal


class Review(Algorithm):
    def __init__(self, critic=None):
        self.critic = critic if critic is not None else Meta(
            "Review the target instructions and explain one possible improvement.",
            {"type": "object", "properties": {"reason": {"type": "string"}},
             "required": ["reason"], "additionalProperties": False},
        )

    def step(self, view, state):
        if state.data.get("pending"):
            result = view.results.require(state.data["pending"])
            return Decision(
                state, reason="review finished",
                terminal=Terminal("stop", outcome={
                    "status": result.status, "review": result.value,
                }),
            )
        call = self.critic(
            MetaInput(view.anchor, tuple(task.id for task in view.tasks)),
            key="review/0",
        )
        return Decision(state.updated(pending=call.ref), (call,), "request review")
```

```python
from gear import Project
from review_algorithm import Review

run = Project.open(".").refine(algorithm=Review(), rounds=1)
print(run.report.summary["operators"]["outcome"])
```

审查使用 Meta 预算，不修改或评测 Target；检查 outcome 的 `status` 后再使用结果。有依赖的外部工作拆成多个 step，把调用引用和阶段写入 state，恢复时即可接着读取结果。`Call` 本身不能 await 或执行。离线组件检查、材料读取、筛查、知识库和任务流的完整说明见[算子作者指南](../../algorithm-operators.zh-CN.md)。

## 配置 4-2-1 候选批次

`GEPA(promotion_widths=(2, 1))` 是默认配置：每个父代批次的候选在同一 local scope 内排名，最多两个进入 bridge，再让 bridge 中排名最高的合格候选进入全量 seed 评测。这是候选数量限制，与任务采样比例独立。扩评不要求候选分数严格高于父代；违反约束的候选仍被排除，任一参与者证据不完整时整批不晋级。最终接受门由运行层单独执行。

全量 seed 评测是最大的阶段：100 题时，4 → 2 → 1 批次新增的 170 个候选 cells 中有 60 个来自这一阶段。使用 `GEPA(global_gate="no_regression")` 时，bridge 候选只有在同一批题上的 bridge 分数不低于父代时才进入全量评测，分数相同也可晋级。所有 bridge 候选都退步时，本批不做全量评测，候选仍保留在研究档案中。默认值 `"any"` 保持上述行为。

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

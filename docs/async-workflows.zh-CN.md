# 用 async 工作流编写搜索算法

`WorkflowAlgorithm` 在普通的 Python `run(ctx)` 中调用角色和评测，背后使用 Gear 已有的决策、操作持久化、预算和验收。完整例子在 [`async_workflow.py`](../examples/algorithms/async_workflow.py)。

```python
from gear import Project
from async_workflow import ReflectAndEdit

project = Project.open(".")
run = project.refine(algorithm=ReflectAndEdit(), rounds=1)
```

把例子的目录加入 Python 导入路径，或将该文件放到项目中可以导入的位置。与现有自定义 `step` 算法一样，算法类必须定义在模块顶层。项目冻结源文件和配置后运行，恢复使用同一版本。

## 定义角色与调用

```python
from gear.algorithms import Role, WorkflowAlgorithm

class MySearch(WorkflowAlgorithm):
    roles = {
        "analyst": Role(prompt="提出一次改进。", schema={"type": "string"}),
        "editor": Role(
            prompt="根据输入修改允许的候选文件。",
            schema={"type": "string"},
            edits=True,
        ),
    }

    async def run(self, ctx):
        diagnosis = await ctx.roles.call("analyst", key="diagnose")
        if not diagnosis.ok:
            return ctx.result(reason="analysis declined")
        edit = await ctx.roles.call("editor", inputs=diagnosis.data, key="edit")
        if not edit.ok:
            return ctx.result(reason="editing declined")
        measurement = await ctx.evaluate(edit.candidate, key="screen")
        if measurement.ok:
            return ctx.result(selected=edit.candidate, reason="candidate measured")
        return ctx.result(reason="incomplete measurement")
```

角色名由算法声明。当前两类角色分别使用 `diagnose_seed` 与 `generate_candidate`，都交给项目配置的 Meta provider。使用 Codex profile 时会启动 Codex Agent。`Role` 的提示词和 JSON Schema 通过已有自定义 Meta 合同交给执行器。`RoleResult.data` 是解开 `declined/data` 信封的算法响应，输出的业务含义仍由算法判断。编辑成功后 `edit.candidate` 指向通过当前 Harness 检查并封存的版本，`edit.change` 提供执行层读出的真实差异。

`ctx.inputs.anchor` 是初始候选，`ctx.inputs.rounds` 与 `repetitions` 是冻结的运行参数，`ctx.data.seed` 只包含授权 seed 任务。`ctx.evaluate` 返回该候选在请求范围内的证据和完成状态。正式更新 champion 仍通过当前独立 seed/held-out 验收；返回一个已测候选并不代表它已经被采用。

## 同一次编辑参考其他版本

Codex 执行器支持把本次运行中已封存的候选作为只读参考目录交给 editor。例如，算法保存了此前生成的 donor 引用后可以调用：

```python
edit = await ctx.roles.call(
    "editor", candidate=parent, references={"donor": donor},
    inputs="参考 donor 的修改，在当前工作副本中实现。", key="recombine",
)
```

Codex 从 input.json.references.donor.directory 找到参考目录，可以读取其文件。引用通过候选 ID 和内容摘要固定，参考目录不会进入新候选。该能力目前用于编辑角色，执行器须声明支持 candidateReferences。其他 provider 未声明时在提交前报告不兼容。它提供一次编辑中的多版本阅读；连续多次编辑同一份未封存草稿的接口仍待实现。

## 恢复与调用键

每次角色调用和评测使用唯一而稳定的 `key`，如 `round/2/edit/0`。从头重走算法纯计算时，SDK 根据保存的键、请求摘要和操作回执返回原结果。修改同一个键的请求或改变已执行的调用顺序会报错。外部任务已执行但回复丢失时，现有运行器先查询原任务的状态，避免重复请求。

调用键标识工作流中的事件。两个不同的评测键代表两个流程事件，当前运行器仍按候选、任务和 repetition 复用已存在的试验槽位，因此换一个键不会产生新的独立采样。

循环、排序和选父代可以使用普通 Python。会影响控制流的预算和历史证据读取应通过带键的 SDK 读取。预算快照保存当时的值；证据读取保存当时选中的槽位及其内容摘要。后来增加的证据行不进入这次历史读取，已经观察的槽位若被替换或补充了指标而改变摘要，恢复会明确报告不兼容。外部 I/O 仍受生产 Python worker 的隔离限制。

已有运行继续使用冻结的算法源码与 provider identity 校验。升级执行器后，未完成运行如果遇到 provider 实现或执行条件的身份变化，会报告 provider-identity-mismatch；需使用该运行匹配的执行器版本恢复。新能力不会重写旧运行的身份或迁移其未完成操作。

## CPU 合成试验

例子可以直接用公共 conformance kit 验证控制流。回复由测试显式提供，分数也是合成观察。

```sh
PYTHONPATH=python:examples/algorithms python3 - <<'PY'
from async_workflow import ReflectAndEdit
from gear.algorithms.testkit import toy_round

print(toy_round(
    ReflectAndEdit(),
    meta_response=lambda operation: "Fix arithmetic and preserve the output format.",
))
PY
```

这个测试检查决策合同、确定性和预算行为。真实运行还需配置 Meta 与评测 provider。工作流目前沿用固定的候选/任务/repetition 试验槽位；不同 `key` 的重复评测会复用已有完整槽位。可恢复草稿、派生题面、独立新测量组和单独的单次模型执行器属于后续执行能力。

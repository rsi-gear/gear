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

角色名由算法声明。当前两类角色分别使用 `diagnose_seed` 与 `generate_candidate`，按角色查找项目配置的 Meta provider，未绑定的角色使用 meta.profile。使用 Codex profile 时会启动 Codex Agent。`Role` 的提示词和 JSON Schema 通过已有自定义 Meta 合同交给执行器。`RoleResult.data` 是解开 `declined/data` 信封的算法响应，输出的业务含义仍由算法判断。编辑成功后 `edit.candidate` 指向通过当前 Harness 检查并封存的版本，`edit.change` 提供执行层读出的真实差异。

`ctx.inputs.anchor` 是初始候选，`ctx.inputs.rounds` 与 `repetitions` 是冻结的运行参数，`ctx.data.seed` 只包含授权 seed 任务。`ctx.evaluate` 返回该候选在请求范围内的证据和完成状态。正式更新 champion 仍通过当前独立 seed/held-out 验收；返回一个已测候选并不代表它已经被采用。

## 草稿和文件资源

单次 editor 调用成功后交付封存候选。ADAS、RRSI 等需要先连续编辑一份草稿再决定是否封存，可直接使用工作区接口。下面是流程节选；可以直接交给 Project.refine 的完整角色定义和算法见 [ReviewedEdit](../examples/algorithms/draft_workflow.py)。

```python
draft = await ctx.workspaces.open(base=ctx.inputs.anchor, key="draft/open")
candidate = None
for attempt in range(3):
    edited = await ctx.workspaces.edit(
        "editor", workspace=draft, inputs=feedback, key=f"draft/edit/{attempt}",
    )
    if not edited.ok:
        break
    draft = edited.revision
    changes = await ctx.artifacts.diff(ctx.inputs.anchor, draft, key=f"diff/{attempt}")
    review = await ctx.roles.call("critic", inputs=changes, key=f"review/{attempt}")
    if review.ok and review.data["accept"]:
        candidate = await ctx.workspaces.seal(draft, key="draft/seal")
        break
    feedback = review.data
if candidate is None:
    await ctx.workspaces.discard(draft, key="draft/discard")
```

每次编辑产生可恢复的草稿修订，只有 seal 登记候选；编辑或评审的模型消耗逐次计量。discard 结束草稿流程，已产生的操作与用量继续保留。调用失败时也可按算法策略丢弃修订或选择已有候选。配方可根据真实文件差异拒绝越过本模块范围的修改，Harness 的可修改路径由执行层检查。

```python
layout = await ctx.artifacts.list(ctx.inputs.anchor, key="layout")
path = layout["harness"]["instructionFile"]
files = await ctx.artifacts.read(ctx.inputs.anchor, paths=[path], key="prompt")
child = await ctx.artifacts.apply(
    base=ctx.inputs.anchor, edits={path: new_prompt}, key="new-prompt",
)
```

资源路径由 Harness 描述给出。Pi 的主指令是 AGENTS.md，DSH 是 prompts/system.md；通用算法读取 instructionFile。skillRoot 用于定位技能库，resources、mutation_policy 和 diff 供配方执行自己的修改规则。apply 中的多个文件作为一个草稿修订写入，None 表示删除。所有修改仍通过 Harness 许可检查。

## 独立测量、派生输入与研究结果

在 gear.yaml 中声明搜索可反复访问的 train/dev，它们是 benchmark seed 的互斥子集。held-out 继续由验收服务保留。

```yaml
research_data:
  train: [train-1, train-2]
  dev: [dev-1]
  include_train_labels: true
  allow_derived_inputs: true
  report_only: true
```

ctx.data.question(task) 返回该题面；明确开启 include_train_labels 时，ctx.data.expected(task) 可读训练参考答案。dev 参考答案不提供给搜索。算法选择把授权标签传给反思角色；评测目标默认仍只收到题面和候选资源。

```python
first = await ctx.measure(candidate, tasks=ctx.data.train, group="first", key="first")
fresh = await ctx.measure(candidate, tasks=ctx.data.train, group="second", key="second")
reused = await ctx.measure(candidate, tasks=ctx.data.train, group="first", key="read-first")
retry_task = ctx.data.derive(ctx.data.train[0], feedback + original_question, id="retry")
retry = await ctx.measure(candidate, tasks=[retry_task], key="retry")
return ctx.result(selected=candidate, nominate=False, data={"online_score": online_score})
```

同一候选和试验组固定任务实例与重复次数；相同组复用原观察，不同组生成独立试验。派生输入保存原任务来源和实际题面摘要，评分继续使用原任务的验证器。在线算法由配方只汇总每批学习前首测，反思后重试另记。

TrialResult.observations 按请求实例和重复顺序提供逐条证据、实际输出、目标执行状态、轨迹引用和用量。provider 无法给出某项数据时保留 None，按成本做选择的算法应明确检查完整性。ctx.measure 的结果进入研究试验记录，与 ctx.evaluate 使用的正式验收证据分开。report_only 将默认结果留作研究交付，report 的 algorithm_result 标为算法报告，并保留正式 champion。需要正式采用时应先补齐既定验收所需证据，再提名由原协议验收。

## 按角色选择执行器

在 gear.yaml 中把已注册的角色名映射到现有 profile 名。省略 roles 时，调用继续使用默认 Meta profile。

```yaml
meta:
  profile: codex-editor
  roles:
    analyst: plain-model
    editor: codex-editor
```

角色指令和输出结构仍由 Python 的 Role 定义。profile 选择执行方式和模型；运行身份包含整个角色映射及各执行器的身份。恢复和取消按已保存操作中的角色路由，取消连接使用准入时保存的配置。

plain-model 可以用下面的 JSON 文件注册，再在环境里配置 GEAR_ANALYST_API_KEY。它通过 Chat Completions 协议执行一次结构化请求，支持 HTTPS；本地服务测试也可使用回环地址的 HTTP。

```json
{
  "kind": "model",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "model": "<服务提供的模型名>",
  "apiKeyEnv": "GEAR_ANALYST_API_KEY",
  "passEnv": ["GEAR_ANALYST_API_KEY"],
  "maxCompletionTokens": 2048,
  "timeoutMs": 60000
}
```

```sh
gear profile create plain-model --from plain-model.json
```

model profile 用于只读角色，直接把角色输入和授权 seed 证据发给模型，不提供文件工具。回复按角色的 JSON Schema 在本地再次校验（Draft 7），请求次数与服务返回的 token 用量持久保存。HTTP 请求没有自动重试；连接中断而无法确认回复时，保留未知状态，需要核实原请求。当前 generationBudget 是整组 Meta 请求/token 的单一能力标记，因此 model 与 Codex profile 均不接受硬 generation 总限额配置；maxCompletionTokens 限制这次回复长度，不能作为输入加输出总 token 上限。研究预算仍记录实际消耗，评测和候选额度由原运行器预留和约束。

## 同一次编辑参考其他版本

Codex 执行器支持把本次运行中已封存的候选作为只读参考目录交给 editor。例如，算法保存了此前生成的 donor 引用后可以调用：

```python
edit = await ctx.roles.call(
    "editor", candidate=parent, references={"donor": donor},
    inputs="参考 donor 的修改，在当前工作副本中实现。", key="recombine",
)
```

Codex 从 input.json.references.donor.directory 找到参考目录，可以读取其文件。引用通过候选 ID 和内容摘要固定，参考目录不会进入新候选。该能力目前用于编辑角色，执行器须声明支持 candidateReferences。其他 provider 未声明时在提交前报告不兼容。references 同样可传给 ctx.workspaces.edit，让草稿编辑器同时阅读其他候选。

Codex 角色还可以读取已固定的 JSON 材料。例如先用 ctx.artifacts.material(value, key="analysis-material") 保存算法整理的授权观察，再把返回引用传给 roles.call 或 workspaces.edit 的 materials={"analysis": material}。执行器在 input.json.materials 中给出只读 JSON 文件路径。材料记录来源操作与摘要；算法整理的解释仍具有算法报告的属性。

## 恢复与调用键

每次角色调用和评测使用唯一而稳定的 `key`，如 `round/2/edit/0`。从头重走算法纯计算时，SDK 根据保存的键、请求摘要和操作回执返回原结果。修改同一个键的请求或改变已执行的调用顺序会报错。外部任务已执行但回复丢失时，现有运行器先查询原任务的状态，避免重复请求。

调用键标识工作流中的事件。对 ctx.evaluate，两个不同的评测键仍按候选、任务和 repetition 复用已存在的试验槽位；独立采样由 ctx.measure 的不同试验组表达。

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

这个测试检查决策合同、确定性和预算行为。真实运行还需配置 Meta 与评测 provider。标准 ctx.evaluate 沿用固定候选/任务/repetition 槽位，独立试验使用 ctx.measure。草稿和引用目录需要支持这些能力的编辑器；任意 Harness 运行时代码修改仍受适配器声明及实际构建运行能力约束。

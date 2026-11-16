# 可组合算法算子作者指南

`gear.ops` 是协议 v2 的 Python 作者入口。纯算子直接返回值；外部工作由 `Call` 描述，并在 `Decision` 提交后执行。算法模块中的选择、排序、编辑规则和阶段流程均留在 Python。TS 验证权限，预约预算，封存结果并恢复未完成调用。

`gear.algorithms.GEPA`、`RandomSearch` 和六策略接口继续走 v1。新算法继承 `gear.ops.Algorithm` 明确启用 v2；不能修改旧 run 的协议号或实现身份来迁移。

## 调用与恢复

```python
from gear.ops import Algorithm, Decision, Meta, MetaInput, Terminal

class Review(Algorithm):
    def __init__(self, critic=None):
        self.critic = critic if critic is not None else Meta(
            "Review the candidate instructions.",
            {"type": "object", "properties": {"reason": {"type": "string"}},
             "required": ["reason"], "additionalProperties": False},
        )

    def step(self, view, state):
        if state.data.get("pending"):
            result = view.results.require(state.data["pending"])
            return Decision(state, reason="review completed",
                            terminal=Terminal("stop", outcome=result.value))
        call = self.critic(MetaInput(view.anchor, tuple(t.id for t in view.tasks)),
                           key="review/0")
        return Decision(state.updated(pending=call.ref), (call,), "request review")
```

把类放在可导入的 `.py` 文件中，调用 `Project.open().refine(algorithm=Review())`。`plan_refine` 可以先检查准入条件。Meta provider 必须声明 `operatorMeta`；能力不足在收费调用前拒绝。

`Call` 不能 await 或自行执行。`view.results.require(ref)` 只查已投影的终结结果；失败时读取 `status/error`，不能把缺失值当作零分。可用 `require(ref, decode=EvidenceSet.from_dict)` 显式解码类型。不同调用之间有依赖时分成多个 step；同一 Decision 的调用只能引用已提交产物。

同 key、同请求复用原调用；同 key 换输入报 `call-key-conflict`。state、Decision、调用键及预算同一次提交。模型回执丢失时先 inspect，已封存候选和已发布库通过原身份恢复。状态应保存 `CallRef`、数据和阶段，不能保存 Python 对象或依赖实例持续存活。

## 组件、参数与依赖

`Module` 支持 `get_params`、`set_params`、`named_children`、`describe` 与 `clone`。例如 `recipe.set_params(screen__critic__max_tokens=512)` 只改变尚未准入的配置。clone 重建配置树，不复制运行缓存。子模块、命名函数、配置、schema、声明资源和依赖进入冻结身份。可使用 callable dataclass，不强制继承 Module；lambda、闭包和循环组件图不支持。

构造函数只保存配置。资源通过 `source_resources=(("prompt", "prompt.txt"),)` 声明，SDK 捕获字节，worker 用 `resource_bytes(component, "prompt")` 读取冻结副本。额外源码通过 `source_dependencies`，安装包通过 `package_dependencies` 声明。普通 import 检查会拒绝未声明包；OS 沙箱仍是文件与网络隔离边界。

状态使用 `StateTree`，由 `state.updated(...)` 产生新版本。改变 `state_schema_version` 后不能静默加载旧状态。有随机行为的模块显式使用 `view.random("module/path", "call-key")`，`Sequential` 为子模块隔离随机键。

`gear.ops.testing.check_operator` 可离线检查参数往返、clone、重复构造、输入变动和可观测 I/O。它是作者诊断工具，不能替代运行沙箱或真实持久执行测试。

## 材料与精确编辑

`CandidateRef` 绑定 owner run、candidate ID 和 manifest digest；`ArtifactRef` 绑定 kind、digest 和可见性。路径不授予权限。`GenerateInput.base` 是实际修改基底，`sources` 是额外只读 donor。多个来源进入独立只读材料目录；provenance 记录实际授予的来源，不证明模型使用了每个来源。

`ApplyEdits(ApplyInput(files, plan))` 是纯变换；`MaterializeCandidate(MaterializeInput(base, plan, sources))` 才申请落盘。`FileEdit` 支持 create/replace/delete/精确 unified patch，绑定原内容 SHA-256。新文件使用 `expected_digest=None` 表示 absent。冲突、模糊 patch、符号链接、越界路径、harness 校验失败都不会发布半个候选。精确编辑消耗候选配额，不消耗 Meta token。

`ReadArtifact` 返回 base64 字节页，包括 ref、path、content_digest、offset、total_bytes、complete 和 cursor。`complete` 只表示本次读取的材料字节已覆盖；目标轨迹自身还有 `content_complete`，不能把两者混同。cursor 必须随相同 ref/path/页大小继续使用。收齐后：

```python
import json
from gear.ops import decode_artifact_pages, EvidenceSet

raw = decode_artifact_pages(tuple(saved_pages))
collection = json.loads(raw)
# 大 Evaluate 集合以 ReadArtifact 读取时，补上封套中的 ref 和 loaded：
evidence = EvidenceSet.from_dict({**collection, "ref": saved_ref, "loaded": True})
```

`decode_artifact_pages` 检查连续覆盖、混入其他材料、重复/缺页及完整字节摘要。读取限制默认每页最多 1 MiB；Meta 材料每文件最多 1 MiB、总计 8 MiB。大材料用分页显式筛选后再交给 Meta，不能将截断 diff 宣称为完整编辑上下文。

## 样本与比较

- `SamplePlan(..., mode="ensure", plan_id="fixed")` 使用 admission 冻结的任务槽；不同 Call 扩大任务范围时只执行尚缺的槽。
- `mode="fresh", plan_id=None` 从新的调用键创建独立计划；恢复仍是原计划。新 sample ID 不证明统计独立性，报告保留 provider 实际随机条件。
- `mode="reuse", plan_id=None, evidence_set=ref` 只复用明确集合；缺失或有效执行身份不一致即失败。blind 使用 `execution_set`，scored 使用 `evidence_set`。外来历史证据不导入旧执行的可运行身份。

失败 retry 保留 sample ID，改变 attempt ID；指标补投影不增加物理执行。`Evaluate` 返回不可变 EvidenceSet，追加样本不会改旧集合。`SelectEvidence` 纯构造选择，`ReadEvidence` 封存并分页加载；`EvidenceSet.from_pages` 检查页覆盖和去重。合并多个 fresh 计划时使用不重叠的任务槽，避免把同一个比较槽的多个 assessment 混入一次归约。

`CompareCandidates(ComparisonInput(plan, sets, view.objective, baseline))` 要求明确共同任务、权重、槽、reducer 和 objective。配置 objective 时复用既有 Python 指标公式；相对 baseline 的指标需要显式 baseline。未加载、缺失、评分失败和约束不满足分别报告，失败不能缩小分母或伪装为任务零分。完整示例见 [OPRO](../examples/algorithms/operators/opro.py)。

算法内部采纳、任务输出选择、库发布、champion gate 是独立事件。终止 `nominate` 才请求最终 gate；作者的 fresh 样本不会混入独立冻结的 seed/held-out 验收。

## 筛查

`ScreenedEvaluate` 是 Python 组合模块，返回子状态和 calls。静态检查、可选 Meta critic、判定、执行逐步推进；父算法保存子状态。拒绝或材料不足产生 `ScreenResult(status="screened")`，不构造 benchmark 调用。

需要强制前置检查时，额外向 SDK 传入 `ScreeningPolicy(critic, edit_check, predicate)`，三个组件也必须属于根配置树。运行层从真实候选材料与 critic 回执重建输入，在独立 worker 中判定。缺少/伪造回执拒绝预约；独立判定拒绝保留可查询的 `screening-rejected` 结果。只改算法 globals 或 state 无法绕过。含目标资产的筛查必须授予 critic 相同资产，最终 nomination 还需针对实际候选本身的通过证明。

## blind、学习库与有限任务流

```python
from gear import Project
from gear.ops import AccessPolicy
from harness2 import BlindLearning  # examples/algorithms/operators/harness2.py

run = Project.open().refine(
    algorithm=BlindLearning(),
    access=AccessPolicy(exposure="blind", rollout_backend="scored_private",
                        task_order=("sum-01", "sum-02")),
)
```

`scored_private` 明确允许 Hitch 内部评分，费用照实计入；评分、评分失败、verifier、评分派生信息不进入算法、Meta、history、research 或 reader。目标状态从独立执行记录取得，评分失败不触发目标重跑。仅开放任务输入、目标输出和目标消息轨迹。目标记录与轨迹不可读时保留不确定性，不猜测成功。

Hitch reader 使用既有公开读取接口，无需修改 Hitch 核心。目标轨迹采用 `target-messages-v1` 投影；保留消息文本及工具交互，排除私有诊断、verifier、usage 与未知扩展。Hitch 本身返回摘录或多模态块不支持时，明确标注 `content_complete=false`/`omitted`。这不等于全量原始多模态轨迹；需要它的算法必须检查完整性，不能据摘录声称完成论文复现。

`CommitLibrary` 创建不可变快照，`PublishLibrary` 以 expected_revision 做 CAS。冲突返回 conflict，不自动改用最新 head。稳定 commit ID 能在回执丢失且 head 已再次推进后恢复原发布结果。库发布不发布 champion。

普通知识可作为 Meta 只读上下文。影响目标的文件放进 `TargetFiles(files).to_dict()`，作为 `CommitLibraryInput.data`，再把 snapshot 放入 `ExecutionInput.assets`。运行层封存实际叠加文件，版本进入执行身份；相同候选、不同库不会误用缓存。重叠路径、不可支持的资产类型和 mutation policy 越界被拒绝。

任务顺序在 admission 冻结。`view.stream.current_task/revision` 是权威进度，Python cursor 只是算法状态。`CompleteTask` 独占 Decision，绑定当前任务、sample、可用输出、库引用和 expected_revision；成功原子提交才开放下一任务。伪造研究记录或修改 state 不推进任务。反馈在后续任务仍保持 blind。

## 跨 run 显式导入

```python
from gear.ops import ImportSource

run = project.refine(
    algorithm=recipe,
    imports=(ImportSource("donor", old_candidate, "material"),
             ImportSource("history", old_evidence_set, "evidence")),
)
```

首版支持同一项目内已封存的 run。候选复制为 `view.candidate("import_donor")`；原 ref 可作为只读 donor，执行或 nomination 使用本 run 的别名。artifact 保留原 ref，在 `view.assets` 可发现。库包含命名引用时，每个引用也要显式导入。

源码导入不授予评分。evidence 额外校验 benchmark、执行条件、objective 和指标实现、任务范围；不会进入最终 gate 或把旧 sample 变成新 run 的可执行缓存。blind 不接受来自 scored run 的材料；有限流还拒绝曾获准接触未来任务的源 run。该检查按源 run 的准入范围保守判定，不推断某段文字实际用了哪些标签。

## 能力与资源界限

组件 `requirements()` 由递归配置汇总，在 admission 与动态 Call 预约时检查。`view.capabilities` 给出本 run 的支持集合。当前条件边界：

| 能力 | 当前支持 |
| --- | --- |
| 普通 ensure/fresh/reuse | provider 自身随机性；controlled/paired seed、额外 sampling parameters 明确拒绝 |
| blind | 仅显式允许的 scored_private，需独立 target projection 与 artifact reader |
| unscored / Score | P3，未开放；不静默降级 |
| 目标策略用量白名单 | 当前不开放；未知/partial 不填零。Meta/critic 用现有 generation ledger |
| 可执行 improvement harness | 未开放 `improvement_harness_execution`；作为上下文的代码不代表执行了它 |
| Codex 每 Call token 上限 | CLI 无法保证时拒绝 max_tokens；其他支持该预算的 provider 可使用 |
| 自定义 schema | 有界 JSON schema 子集；不支持的关键字在收费前拒绝 |

默认读预算 1024 次/64 MiB；每 Decision state 与研究记录各 2 MiB；每 Call 请求和结果各 2 MiB；保留结果最多 32 MiB，算子 journal 128 MiB，最多 4096 个调用及 10000 个决策。并行批次按待返回结果上界预约，超过容量在执行前拒绝。大执行集合改为 artifact 分页，不截断后假称 loaded。

v1/v2 保留独立解码与执行路径。恢复同时校验原 provider、投影及源码身份；版本不兼容时使用匹配 runtime 完成或取消旧 run，不重算旧 identity。v2 history/research/report 保存完整生命周期索引，作者理由标为 author，运行事实标为 runtime。Meta 的历史输入由显式 sources/读取调用提供。

## 示例与验证

示例均位于 [examples/algorithms/operators](../examples/algorithms/operators)：

| 文件 | 展示机制 |
| --- | --- |
| compatibility.py | GEPA/RandomSearch 原六策略与 v1 行为检查 |
| opro.py | 显式评分历史、Meta 提示词更新、精确构造与共同范围比较 |
| ace.py | 稳定条目 ID、确定性 delta、事务性候选写入 |
| rrsi.py | 可替换 critic/check/evaluator、显式子状态、拒绝不评测 |
| darwinx.py | 暂准入后以两个 fresh 计划追加确认 |
| harness2.py | blind 输出、Meta 学习、版本化目标文件、CAS 与 CompleteTask |

这些是框架机制示例。测试使用离线 provider、真实隔离 worker、实际封存与恢复路径；不代表已完成论文模型效果或完整搜索机制复现。

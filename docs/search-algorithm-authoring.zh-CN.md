# Python 算法开发索引

公开入口是 `gear.algorithms`。算法返回决策，TypeScript 运行层验证、持久化并执行这些决策。算法不能直接提交评测、查询 held-out 或更新 champion。

## 修改位置

每套算法都包含相同的六个文件。GEPA 和 RandomSearch 是公共合同的两个实例，彼此不继承策略实现。

| 要修改的行为 | 公共合同 | GEPA 实现 | RandomSearch 实现 |
| --- | --- | --- | --- |
| 父代和候选配额 | `ParentPolicy` | `gepa/parents.py` | `random_search/parents.py` |
| 任务范围和评分权重 | `TaskSampler` | `gepa/sampling.py` | `random_search/sampling.py` |
| 消费诊断、规划候选 | `ProposalPlanner` | `gepa/proposal.py` | `random_search/proposal.py` |
| 在完整共同范围比较候选 | `CandidateRanker` | `gepa/ranking.py` | `random_search/ranking.py` |
| 阶段顺序与晋级宽度 | `SearchAlgorithm` | `gepa/algorithm.py` | `random_search/algorithm.py` |
| 结束条件 | `StopRule` | `gepa/stopping.py` | `random_search/stopping.py` |

表中路径相对于 [`python/gear/algorithms`](../python/gear/algorithms)。合同在 [`contracts.py`](../python/gear/algorithms/contracts.py)，可复用流程在 [`workflow.py`](../python/gear/algorithms/workflow.py)。新增算法可以组合这些合同，也可以直接实现 `step`，不需要修改 TS 的操作类型或状态机。

## 一个文件替换策略

保存为可以导入的 `my_policy.py`：

```python
from gear.algorithms import ParentInput, ParentPlan, RandomSource


def select_parent(view: ParentInput, rng: RandomSource) -> ParentPlan:
    if not view.eligible:
        return ParentPlan.abstain("no eligible parent")
    return ParentPlan.single(
        rng.choice(view.eligible, key="parent"),
        count=view.candidate_limit,
    )
```

```sh
python -m pip install rsi-gear
python -m gear algorithm test my_policy:select_parent
python -m gear algorithm test gepa
python -m gear algorithm test random-search
```

CPU toy 检查不需要 Node、模型凭据、Docker、Hitch 或 GPU。真实项目通过同一套策略运行：

```python
from gear import Project
from gear.algorithms import GEPA
from my_policy import select_parent

project = Project.open(".")
run = project.refine(algorithm=GEPA(parent_policy=select_parent), rounds=1)
print(run.report.summary)
```

Notebook 使用 `await project.arefine(...)`。同步方法在已有事件循环中明确报错。`check/evaluate/refine/resume/cancel/report/export` 都有对应的 `a` 前缀异步方法。

真实运行需要安装 npm runtime 并完成 `gear setup` 与 provider profile 配置；SDK 会自动调用同一 application 层。只有离线策略测试可以单独使用基础 wheel。

## 策略输入和输出

`ParentInput.eligible` 中每个选项属于一个完整 seed scope，并携带任务分数、scope 权重和候选内容身份。`Selection` 保存完整概率分布、随机索引和输入摘要。允许多批分配，也允许带理由弃权；不能把未选中的父代从概率记录中删去。

`SamplingPlan` 保存确切任务集合及权重。权重必须非负、覆盖整个 scope、总和为一；扩大评测时不能丢弃先前要求保留的任务。`RankingInput` 只比较相同任务和重复槽位。缺失、重复或评分/环境失败的槽位使候选不完整；有效零分参与比较。

`Budget.generation_requests_remaining` 和 `generation_tokens_remaining` 是扣除持久预约后的 Meta 余量，`None` 表示该维度没有总上限。`generation_batch_capacity` 是当前可完整预约的 Meta 操作数，`None` 表示不受总额度限制。默认流程在额度耗尽时停止新的诊断/生成，但仍可提名已有完整评测的候选；提案数受批次容量约束。core 独立校验，不信任自定义算法自行限制调用。

默认 GEPA 按任务前沿成员分配父代概率，去除可由其他成员覆盖的冗余前沿，支持 `ScopedFrontier` 的多批采样及 champion 混合。local 使用 8% local、4% shared、3% cross 的向上取整数量及 0.6/0.25/0.15 分桶权重；bridge 保留既有 scope 后分层补到 40%，global 使用完整 seed。容量不足会给出原因，不偷偷扩大预算。配置这些规则可直接替换 callable dataclass：

```python
from gear.algorithms import GEPA
from gear.algorithms.gepa.parents import ScopedFrontier
from gear.algorithms.gepa.sampling import GEPASampler

algorithm = GEPA(
    parent_policy=ScopedFrontier(batch_count=2, champion_probability=0.25),
    sampler=GEPASampler(bridge_ratio=0.5),
    promotion_widths=(2, 1),
)
```

`promotion_widths` 为每次阶段转换指定一个正整数；GEPA 默认 `(2, 1)` 分别限制每个父代批次进入 bridge 和 global 的候选数。每批候选在同一 local scope 排名，最多两个扩评，再在同一 bridge scope 取最多一个。扩评不要求分数严格高于父代，但会排除 `RankingPlan.disqualified`；任一参与者不完整时整批不晋级。最终接受规则由运行层独立执行。

晋级宽度、父代批数和整个 run 的 `budget.max_candidates` 生成上限相互独立；上例两个父代批次分别使用 `(2, 1)`，不能据此推导整个 run 只评测一个 global 候选。完整的单批 4 → 2 → 1 YAML 配置与 170/1,700 次候选执行量的适用条件见[算法示例](guide/zh-CN/example-algorithm.md)。CLI 使用 `algorithm: {name: gepa, options: {promotion_widths: [2, 1]}}`；SDK 使用 `GEPA(promotion_widths=(2, 1))`。两种入口都把宽度保存到算法配置并在 admission 时冻结，恢复不重新读取可变配置。

RandomSearch 使用均匀父代抽样及完整 seed 评测，复用通用证据计算和有限运行检查。它不会导入 GEPA 的策略模块。

## 改整套流程

```python
from gear.algorithms import AlgorithmState, Decision, Operation, SearchView


class StopAfterInspection:
    def step(self, view: SearchView, state: AlgorithmState) -> Decision:
        return Decision(
            state,
            (Operation("stop", rationale="inspection complete"),),
            "inspection complete",
        )
```

`step` 必须是同步纯决策。状态只能包含 JSON；操作只有 `diagnose_seed`、`generate_candidate`、`evaluate_seed`、`nominate`、`stop`。模型诊断通过显式操作返回，不能在策略内部调用网络。最终提名后，运行层按 admission 时冻结的规则执行 gate，不把 held-out 结果反馈给策略重新挑选。

`Decision.research` 可选附带 `ResearchRecord(kind, scope, task_ids, candidate_ids, data)`，kind 为 `scope`、`ranking` 或 `parents`。它用于独立研究档案，不产生操作权限。runtime 检查任务和候选属于当前 seed view，每次 decision 最多 64 条、JSON 总计最多 2 MiB。两套内置算法通过共享流程自动记录范围、排名和父代抽样；自定义算法不提供记录时，事实档案仍保存候选、证据和操作。

scope 的 `data.weights` 必须明确覆盖任务集合，才能在档案中生成同范围比较；可同时保存 stage、round 与 sampling 信息。其他 data 保持算法自述，不能据此替代真实 receipt。公共纯投影 `algorithms/research.py` 计算档案的描述性比较，不调用算法或重新抽样；每套算法仍只需维护同样的六个模块。读取命令与字段见[报告指南](guide/zh-CN/results.md)。

## 身份与恢复

SDK 冻结命名函数/类所在文件、声明的 `source_dependencies` 和 JSON 策略配置。局部函数、lambda、不可序列化对象会被拒绝。依赖其他本地模块时，在算法或策略上声明 `(module_name, file_path)` 列表；每个文件的真实字节进入身份。

依赖安装包时，用 `package_dependencies = ("distribution-name", ...)` 声明完整依赖闭包。SDK 记录安装版本及文件内容摘要，worker 在握手和每次决策前核对；执行环境缺包或字节不同会拒绝运行。editable 依赖改用 `source_dependencies`。这是身份声明，不会自动安装或升级运行环境里的软件包。

新 wire schema 的单一来源是 [`contracts/algorithm-v1.schema.json`](../contracts/algorithm-v1.schema.json)。通过 `npm run generate:contracts` 生成两种语言的传输类型。作者继续使用公开 dataclass，不手写协议消息。

stdio 协议每条请求/响应固定上限为 64 MiB，按完整 UTF-8 JSON envelope 加末尾换行计数；握手要求 TS 和冻结 Python worker 的上限完全一致。传输保留完整 evidence、raw metrics、completed 与 state，单条 verifier 的 16 KiB 上限不代表累计消息一定可容纳。任意算法 JSON 状态仍可超限，大消息也受内存和原有决策超时约束。

协议源码属于冻结实现身份。升级 runtime 不会升级已有 run 的冻结 worker；新版 64 MiB runtime 对旧 4 MiB worker 会报告 `algorithm-handshake-mismatch`，本次改动本身不恢复已有 run。保留旧证据并使用兼容 runtime、新建 run，或单独审查身份迁移方案，不能重新冻结已有源码或改 journal 身份来绕过校验。

生产 worker 只读取冻结源码、批准的 Python 运行依赖和独立 scratch，禁用网络。决策、状态和 operation IDs 在副作用前一次保存。已保存决策不重新抽样；外部结果未知时先 inspect，再决定是否重试。改源码会改变实现身份；新 run 冻结当时的配置选项，已有 run 恢复沿用原选项，不修改历史结果来通过恢复校验。

## 当前策略与固定投影的边界

GEPA 和 RandomSearch 分别保留 parents、sampling、proposal、ranking、stopping、algorithm 六个模块。`algorithm.py` 实例化公共流程和同样的五个可替换策略；共享流程在 `algorithms/workflow.py`，每个阶段由命名方法表达。正式配方目录只包含当前实现。

加权指标算术在 `algorithms/objective.py`，固定任务/重复范围与保护投影在 `algorithms/projection.py`，独立 assertion 判定在 `algorithms/assertions.py`。各算法的 `ranking.py` 使用同一公共 `RankingInput`（含冻结 objective 与 anchor_id）；`RankingPlan` 区分不完整和违反约束的候选。GEPA 父代的逐题前沿也使用 objective 投影。最终验收由 core 调用受信任的 Python 投影独立执行，替换 ranker 不能绕过冻结的规则。

公共采样器使用 `algorithms/sampling.py` 的十进制向上取整；`100 × 0.07` 固定为 7 个任务。确定性随机源在 `algorithms/random.py`。训练的配对统计、dev/held-out 决策和离线记录顺序在 `algorithms/model_training.py`，由 `gear.training` 和 TS 执行适配层共用。

`algorithms/operators.py` 仅分发当前执行适配层所需的纯投影与训练策略。它不是算法作者的扩展入口，也不承担 GEPA 阶段规划；自定义算法仍使用上面的公共合同。

verifier 过程组件验证、失败代码诊断与范围汇总在 `algorithms/verifier.py`；历史编辑经验分类/查询在 `algorithms/experience.py`，修改资源使用匹配在 `algorithms/modification_use.py`。这些共享纯投影不增加每套算法的可替换模块。TypeScript 只负责 provider I/O、来源固定、合同校验和持久化；诊断不会隐式改变 objective 或晋级规则。

## 历史行为对照

旧 staged-search、RefineService、组件执行装配及配套 Python 策略夹具已删除。原实现由 Git 历史保留；当前回归直接测试 `gear.algorithms`、Project runtime 与生产 adapter，不再编译或运行一套旧执行器。

迁移会改变实现身份。旧 TS 决策不能在新 Python 实现下静默恢复，历史记录保持原样。当前算法的确定性随机、排名、完整范围分母、保护规则及冻结恢复由生产路径测试验证。

当前 Python 的 `(2, 1)` 恢复了单批四候选场景的 4 → 2 → 1 扩评宽度，但不是历史算法的完整等价迁移。历史实现按失败类别建立独立 local scope、每组提名后轮转分配 bridge 名额；当前流程让一个父代批次共用 local scope 并排名筛选，阶段比较、最终提名与接受规则也有差异。仓库保留的 Marketing 实验结果属于其固定历史版本，不能当作当前 Python 实现的效果或成本实测。

公开 Project 路径和独立安装包的验证范围见[重构记录](refactor-progress.zh-CN.md)。

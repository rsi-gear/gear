# Gear 算法工程师 API 简化规范

状态：能力入口已实施；本修订将完整算法示例统一迁入 algorithms，并移除其中的旧兼容模块。验证结果以对应分支和 PR 为准。

本稿替换上一版按 editing、candidates、inference、artifacts 等分别设立顶层包的方案，修订 [原算子规范](composable-algorithm-operators-spec.zh-CN.md) 的公共入口、能力归属和迁移要求。原有执行、预算、权限、证据和恢复合同继续有效。

## 1. 设计目标

面向算法工程师提供少量稳定入口。作者能找到基础操作、评估、记忆、训练和搜索组件，选择已有实现或组合自己的算法。公共结构反映使用方式，内部执行与存储分层不要求作者学习。

能力入口为 `core`、`evaluation`、`memory`、`curriculum`、`training`、`search`；完整算法实现放在 `algorithms`。算法工程师既可以直接调用完整算法，也可以选择能力模块中的算子组合自己的算法。

| 入口 | 作者要做的事 | 边界 |
| --- | --- | --- |
| `gear.core` | 定义组件、操作候选和材料、调用模型 | 提供基础对象与基础操作，不决定搜索、评分或知识更新策略 |
| `gear.evaluation` | 执行、采样评估、读取证据、比较结果 | 产生和比较评估结果，不决定候选是否被采纳或晋级 |
| `gear.memory` | 查询历史、更新档案、维护知识和版本 | 管理明确的内容与记录，不自动决定从结果中学什么 |
| `gear.curriculum` | 从失败案例规划、生成和筛选练习数据 | 只提供算子和输入输出；转换、执行、准入和持久化由调用方负责 |
| `gear.training` | 构造训练数据、更新模型、运行训练流程 | 保留现有训练能力和接口，训练后端按需加载 |
| `gear.search` | 组合父代、采样、提案、排名、停止和流程 | 提供可复用搜索算子及编排合同 |
| `gear.algorithms` | 直接使用 GEPA、RandomSearch 等完整算法 | 用公共能力实现可运行算法，同时作为组合方式的参考示例 |

`core` 中的基础操作可以独立用于多个算法和工作流；它不收纳评估归约、记忆管理或搜索策略。权限、恢复等执行实现仍在内部，无须另建一组作者必须使用的顶层包。

## 2. 目标结构

```text
gear/
  core/                 Module、基础对象、编辑、候选、Meta、材料读取
  evaluation/           Evaluate、Rollout、证据、指标与比较
  memory/               历史、档案、Playbook、知识库
  curriculum/           failure→data 算子与输入输出；无执行或适配层
  training/             现有训练接口、流程及配方
  search/
    parents.py          父代选择算子
    sampling.py         搜索任务采样算子
    proposal.py         提案规划算子
    ranking.py          排名、采纳与晋级策略
    stopping.py         停止条件及组合
    workflow.py         搜索编排、筛查与子流程
  algorithms/
    gepa.py             可直接调用的 GEPA 完整实现
    random_search.py    可直接调用的 RandomSearch 完整实现
    opro.py             显式评分历史与提示词搜索
    ace.py              Playbook 增量更新与候选评估
    rrsi.py             提案筛查与评估
    darwinx.py          暂准入后的 fresh 样本确认
    harness2.py         blind 有限任务流学习
```

上图表示主要作者入口，不是仓库的全部目录。现有 Project SDK、benchmark、refine worker、observations 等保留所需实现位置。模块按实际规模使用文件或包，不预建空目录、注册中心或插件系统。

常用符号从所属包根导出；需要选择具体策略时再进入 `search.parents` 等子模块。包根使用有选择的轻量或惰性导出，不能因导入一个基础操作加载整个库。实现只有一份，根导出是同一个对象。

## 3. 当前算子的归属

| 入口 | 当前算子 |
| --- | --- |
| `core` | `ApplyEdits`、`CheckEdits`、`GenerateCandidate`、`MaterializeCandidate`、`Meta`、`ReadArtifact`、`Sequential` |
| `evaluation` | `Evaluate`、`Rollout`、`Score`、`SelectEvidence`、`ReadEvidence`、`CompareCandidates` |
| `memory` | `QueryHistory`、`UpdateArchive`、`MergePlaybook`、`CommitLibrary`、`PublishLibrary` |
| `search.workflow`，同时从 `search` 导出 | `InterpretScreen`、`ScreenedEvaluate` |
| `core` 的运行声明，常规搜索不要求使用 | `CompleteTask` |

具体语义：

- `ApplyEdits` 和 `CheckEdits` 对内存文件执行变换和静态检查；`MaterializeCandidate` 才申请构造并封存实际候选。编辑不依赖搜索类型，也不自行读取文件或 blob。
- `GenerateCandidate` 按明确指令生成；`search.proposal` 决定要探索什么假设、使用哪些反馈、给出什么指令。`Meta` 是显式模型调用，其提示词由调用者配置。
- `CompareCandidates` 在明确证据范围、objective 和 reducer 下返回分数、顺序及不完整状态；`search.ranking` 决定保留谁、如何晋级或是否接受。比较模块不包含特定搜索算法的偏好。
- `search.sampling` 决定任务和权重；`evaluation.SamplePlan` 表达执行槽位及 ensure/fresh/reuse，不混用两者的计划类型。
- `UpdateArchive` 是对显式记录集合的纯更新，不表示持久写入；`QueryHistory` 读取运行历史。二者均归记忆能力，算法决定添加什么记录。
- `MergePlaybook` 合并显式 delta，`CommitLibrary/PublishLibrary` 管理快照和版本。学习规则留在算法组合中。
- `CompleteTask` 是提交有限任务流进度的运行声明，由宿主校验；它不选择任务顺序、不充当搜索停止规则。其实现仍由现有 refine runtime 承担。

`Meta` 当前仍绑定候选与任务范围；`Score` 仍仅有声明、未开放执行；`Rollout` 仍只支持显式 scored_private。公共入口简化不增加这些后端能力。

## 4. search 与 algorithms 的分工

将原 algorithms 中的公共能力移出，保留具体完整算法：

1. 纯指标归约、证据解码与比较进入 `evaluation`，保留一份公式实现。
2. 通用记录归档与历史能力进入 `memory`。
3. 文件、候选、模型和材料操作进入 `core`。
4. 可复用的搜索策略进入 `search` 六模块。
5. GEPA、RandomSearch 等完整算法实现在 `algorithms`，从 `gear.algorithms` 直接导出；不另设 `search.recipes` 或在 search 中重复导出完整算法。

六模块都允许多个算子，按已有真实实现接入：

| 模块 | 本次接入的行为 |
| --- | --- |
| `parents` | frontier/冠军混合选择、均匀父代选择 |
| `sampling` | 分层与阶段采样、全量任务采样 |
| `proposal` | 失败反馈提案、独立探索提案 |
| `ranking` | 调用公共比较能力，保留既有排名与晋级规则 |
| `stopping` | 保留现有有界停止行为，按需要组合结束谓词 |
| `workflow` | staged search、显式 step、ScreenedEvaluate 等组合 |

完整算法负责连接组件、配置参数与表达算法专有流程。可复用实现下沉到六模块，专有策略可留在具体算法目录；公共能力不得反向导入 algorithms。不强制每个新算法都包含六个文件或经历固定六阶段。

algorithms 中的实现必须具备完整运行入口、默认组件和可替换参数，通过 Project 的正常运行路径调用，并随库发布、验证。它们既是可用实现，也是算法工程师阅读、复制和修改组合方式的参考。只有机制片段或尚未完成验证的论文示例仍放 examples，不能因目录迁移就声称成为完整算法。

参数化算子可使用 `Module`，命名函数与 callable dataclass 也继续支持。统一参数、子组件、克隆、描述和冻结机制，不要求每个函数套一层类。替换任一策略只需 Python 配置或实现。

`training` 的四阶段接口与训练配方保留：TaskSource、RolloutExecutor、DatasetBuilder、ModelUpdater。此次不强制训练流程改成搜索的 Call/Decision 协议，也不要求迁移既有训练 recipe。algorithms 中的完整方法可以按需组合 training，公共能力不依赖具体算法。

## 5. 作者看到的使用方式

以下为公共接口示例：

```python
from gear.core import ApplyEdits, CheckEdits, Meta
from gear.evaluation import Evaluate, CompareCandidates
from gear.memory import MergePlaybook
from gear.search import ScreenedEvaluate
from gear.algorithms import GEPA

screen = ScreenedEvaluate(
    edit_check=CheckEdits(allowed_paths=("instructions.txt",)),
    evaluator=Evaluate(),
)
screen.set_params(edit_check__max_files=1)
```

直接调用完整算法仍使用现有 Project 入口：

```python
from gear import Project
from gear.algorithms import GEPA

run = Project.open(".").refine(algorithm=GEPA())
```

常规使用可以直接选择 `GEPA` 等完整实现；定制时替换策略组件；完全自定义时使用 `gear.search.Algorithm` 和显式 step。纯算子直接返回结果；执行声明仍交给运行时执行。`ScreenedEvaluate` 保留显式子状态，父流程负责保存。

## 6. 组件和数据合同

下面覆盖规范能力入口的公开符号。常用算子和类型从六个能力入口导出，完整算法从 algorithms 导出；合同生成、重建及 wire 校验保持内部实现，不作为额外业务领域暴露。

| 归属 | 类型与辅助函数 |
| --- | --- |
| `core` 的组件机制 | `Module`、`PureOperator`、`EffectOperator`、`ModuleSpec`、`FunctionSpec`、`clone`、`describe_module`、`freeze_module`、`resource_bytes`、`StateTree`、`Call`、`CallRef`、`CallResult`、`Results`、`ModuleStep`、`StepModule`；`core.testing.check_operator` |
| `core` 的文件与资源 | `FileContent`、`FileEdit`、`EditPlan`、`ApplyInput`、`EditCheckInput`、`EditCheck`、`content_digest`、`ArtifactRef`、`ArtifactInput`、`decode_artifact_pages`、`CandidateRef`、`GenerateInput`、`MaterializeInput`、`TargetFiles`、`MetaInput` |
| `core` 的运行声明 | `AccessPolicy`、`ImportSource`、`ScreeningPolicy`、`CompleteTaskInput` |
| `evaluation` | v2 `Task`、`TaskSamples`、`SamplePlan`、`ExecutionInput`、`ScoreInput`、`EvidenceSetSpec`、`EvidenceRecord`、`EvidenceSet`、`ReadEvidenceInput`、`ComparisonPlan`、`ComparisonInput`、`ComparisonResult` |
| `memory` | `HistoryInput`、`ArchiveInput`、`PlaybookEntry`、`PlaybookDelta`、`PlaybookInput`、`CounterDelta`、`CommitLibraryInput`、`PublishLibraryInput` |
| `curriculum` | `OutcomeRecord`、`OutcomeCase`、`FailureMode`、`LearningTarget`、`PracticePlan`、`PracticeDraft`、`ValidationPlan`、`ValidationReport`、`TaskPoolPlan`；[完整 API](curriculum.zh-CN.md) |
| `search` | `Algorithm`、v2 `SearchAlgorithm`、`SearchView`、`Decision`、`Terminal`、`ScreenInput`、`ScreenResult`、`ScreenCheckInput`、`ScreenVerdict` |

基础对象不得导入搜索策略。通用随机源负责显式索引取值和命名空间；加权选择及选择记录留在 `search`，由 `search.parents` 中的父代策略使用。`Sequential` 不依赖 ParentOption 等搜索类型。

依赖方向为：`algorithms` 按需组合六个能力包；`search` 使用 core/evaluation/memory；evaluation 和 memory 使用 core。curriculum 仅使用 core、公共 JSON 合同和标准库，不导入 search/training/evaluation/memory；转换与执行由调用方处理。core 不导入其余能力包或具体算法。training 保留现有独立执行结构，复用能力时不能造成循环。任何公共能力不得反向依赖 algorithms；旧路径兼容转发不属于能力实现。共享引用与 Call 放在轻量合同模块，包级导出也纳入依赖检查。

## 7. 实施与兼容

实施分三步：

1. 抽取 core，迁移评估与记忆能力；拆除基础组件对原 algorithms 的依赖，并实现根包惰性 SDK 导出。
2. 将可复用搜索策略迁入 search 六模块；algorithms 中的 GEPA、RandomSearch 改为组合公共能力并保留专有流程，接入组件机制；更新示例和作者指南。
3. 同步更新冻结源码清单、独立筛查 worker、合同生成、类型检查和 wheel/npm 发布验证。

兼容要求：

- 删除 `gear.ops` 的全部兼容转发文件。`gear.algorithms` 只保留并导出 GEPA、RandomSearch、OPRO、ACE、RRSI、DarwinX、Harness2 七个完整算法；移除迁出能力的旧兼容文件与包根导出。内部实现、作者指南与测试改用规范能力入口。
- 新 v2 作者合同以 `gear.search` 为规范入口，v1 合同从 `gear.search.contracts_v1` 导入。GEPA/RandomSearch 不因移包自动升级协议；v1/v2 Decision、View、State 仍不能混用。
- 移除 `algorithms.contracts` 和 GEPA/RandomSearch 包内的五类策略兼容文件。search 直接依赖自身合同，公共能力不得反向依赖 algorithms。examples 下不再保留重复算法实现；纯用法放进作者指南，兼容行为检查放进测试。
- 保持既有随机取值、排序、停止阈值和流程行为。迁移产生新的真实源码与组件身份，不伪装为原摘要。
- 旧冻结运行使用原源码、原协议及匹配运行时恢复/取消；版本不匹配时执行前拒绝，不改写旧 journal。新运行须更新已移除的导入路径。
- 内置投影摘要变化会影响 objective、报告、研究、经验和证据导入。旧产物使用匹配投影，不以新实现重算后冒充旧结果。
- 作者 worker 与内置纯投影分别维护源码清单；前者继续排除 Project、训练执行和 verifier。内置投影按真实依赖移除不再需要的 SDK 源码，不复制整个 gear 包解决缺依赖。
- TS 的授权、硬预算、样本身份、独立筛查、库 CAS、任务推进及 blind 隔离保持原有合同。无 Hitch 核心修改要求。

实际接入位置包括 `project.py`、`refine/worker.py`、`screening.py`、`resources.py`、`protocol.py`，以及 TS 的 `source.ts`、`builtin-policy.ts` 和历史投影访问路径。训练 stage 和 bridge 身份同步捕获共享训练投影的新源码位置。schema 仍由单一来源生成；边界检查解析绝对、相对及包级导入。训练后端和现有 SDK 功能不因本次 API 整理而全量重构。

## 8. 验收

1. 作者指南区分六个能力入口和 algorithms 完整算法入口；全部现有算子和类型有明确归属，同一对象只有一份实现；search 不承载或重复导出完整算法。
2. 干净进程从 core 导入并调用 ApplyEdits/CheckEdits，不加载 search、训练后端、Project 或执行适配器，不需要 Node/Hitch；基础操作没有隐式 I/O。
3. 六类策略能单独使用、替换、描述和重建；参数化组件支持嵌套参数与 clone，clone 不复制运行状态。
4. GEPA/RandomSearch 可从 gear.algorithms 导入并通过 Project 运行，默认组件和可替换参数完整；固定输入、配置、随机种子与回执时，其选择、任务范围、提案、排名、停止理由和阶段轨迹符合原行为。公共能力导入不加载具体算法。
5. 评估只输出评估与比较结果；筛查拒绝不预约 benchmark；记忆纯更新不冒充持久写入；CompleteTask 仍需权威校验。
6. 七个算法可描述、重建和运行，已移除路径在独立 wheel 中不可导入；v1/v2 区别、新冻结身份、旧运行匹配恢复及不匹配拒绝均有覆盖。
7. 相关调用键、CAS、blind、跨 run 导入、有限任务流与发布包回归通过。独立 wheel/npm 安装验证新入口和实际冻结 worker；training 公共接口及惰性后端加载保持有效。

本次交付为 API 组织和组件化改造，不扩充算法效果承诺或后端执行能力。运行验证使用固定的 10 个 AutomationBench MKT 任务、Codex + Luna low Meta 和 DSH + Luna low Target，各执行两轮；Harness2 为每题两轮。检查真实调用与完成记录，不以 smoke 结果作算法效果排名。

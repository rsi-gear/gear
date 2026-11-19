# Failure → Data 算子

`gear.curriculum` 是独立的轻量能力包。它包含十个算子及其输入输出定义，只依赖标准库、`gear.core` 和公共 JSON 合同。它不导入 search、training、evaluation、memory，也不提供 adapters、执行器或新的流程状态机。

本分支基于 `dev` 的 Gear 0.2.4 基线；以下是新增 API，不是已发布的 0.2.4 API。完整研究和后续范围见[设计文档](failure-driven-data-operators-spec.zh-CN.md)。

## 运行最小闭环

在仓库根目录运行，无须 Node、Hitch、GPU 或模型服务：

```bash
PYTHONPATH=python python3 examples/training-loop/failure_curriculum_cpu.py \
  --workspace /tmp/gear-curriculum-failure --strategy failure
PYTHONPATH=python python3 examples/training-loop/failure_curriculum_cpu.py \
  --workspace /tmp/gear-curriculum-random --strategy random
PYTHONPATH=python python3 examples/training-loop/failure_curriculum_cpu.py \
  --workspace /tmp/gear-curriculum-fixed --strategy fixed
```

三个策略使用相同的四轮、每轮四个训练任务预算。第一轮使用固定种子任务，随后分别使用失败条件生成、无失败反馈的随机生成和固定数据。随机基线直接从已知训练域定义 `LearningTarget`，不从失败记忆选择目标；`SelectLearningTargets(strategy="uniform")` 只是失败模式间均匀分配，不能替代无条件随机基线。

[示例](../examples/training-loop/failure_curriculum_cpu.py)运行真实的 CPU 标量回归更新：收集错误 → 生成未见输入 → 封存草案 → 运行参考解、错误答案和验证器校准 → 转成原 `{x, target}` 任务 → 更新参数 → 在固定、未提供给生成器的输入上评测。算术 teacher 是本地确定性代码，经过与外部模型相同的 `prepare/parse` 边界；它不是 LLM，也不是论文复现或实际 agent 效果实验。

再次执行相同命令会校验并复用完成的阶段。`TaskSource` 的记录在 stage 工作目录，调用方在恢复前后核对 operation、配置、任务和证据摘要。诊断、生成和验证中途失败可重算，因为这个示例没有收费外部调用。接入真实服务后，调用方必须使用现有 runner 的子调用记录和 reconcile 能力处理未知结果；示例不承诺收费调用 exactly-once。

## 不更新权重的 harness 闭环

`curriculum` 不要求训练模型权重。调用方也可以把新练习用于评估和修改 prompt、工具规则或经验库，再用固定留出集选择 harness。数据生成与 harness 搜索是两个可组合的环节。

[真实 LLM 示例](../examples/curriculum-harness/README.zh-CN.md)固定模型权重，使用官方 IFEval strict 验证器执行 failure → 新任务 → 回答与反馈 → developer prompt 候选 → 开发集采纳 → 固定测试集评测。fixed、random、failure 三组有相同的有效学习样本、候选和开发评测预算；生成和诊断成本另计。模型调用、收费请求恢复、验证执行和格式转换均由示例调用方处理，没有增加 adapters 或 curriculum 执行层。它是两轮反思式提示词搜索，不是完整 GEPA 复现。

[实测结果与证据](../research/curriculum-harness-2026-11-19/README.zh-CN.md)：baseline 与 failure 都通过 46/48，fixed 与 random 都通过 45/48。局部练习从 6/8 到 8/8，但没有观察到相对初始 harness 的留出集提升；不能据此证明 failure 数据优于两种对照。

## 算子与合同

| 算子 | 输入 → 输出 | 当前策略 |
| --- | --- | --- |
| `ExtractOutcomeCases()` | `OutcomeRecord[]` → `OutcomeCase[]` | 每个逻辑 sample 取最新 attempt；只保留 train；完整且有明确 verdict 才标成功/任务失败 |
| `ContrastiveDiagnoser()` | `prepare(cases, memory=...)` → `ModelInput`；`parse(response, cases=...)` → `FailureMode[]` | 检查引用；反例必须与失败的 family、policy、environment 可比 |
| `MergeFailureMemory()` | `memory, delta, measurements=...` → 新 `FailureMode[]` | 支持案例去重；显式测量决定掌握；新失败重新激活 |
| `SelectLearningTargets()` | `memory, budget=..., rng=..., progress=..., policy_id=...` → `LearningTarget[]` | frequency/uniform/frontier/forgetting/rare_action/signal_mix；精确预算，测量缺失保持未知 |
| `ExtractLearningSignals()` | 有序 `BehavioralObservation[]`, `policy_id=...` → `LearningSignals[]` | 可比历史的遗忘、同策略组的结果边界、已观测低频动作，三个标签分别保留 |
| `PlanPractice(generator_id, validation_policy_id)` | `targets` → `PracticePlan[]` | failure 或 random；kind 可为 task/environment/trajectory/example |
| `GeneratePractice()` | `prepare(plan, cases=...)` → `ModelInput`；`parse(response, plan=...)` → `PracticeDraft[]` | 严格响应 schema、数量和 family；输出仍是未准入草案 |
| `ValidatePractice(validator_id)` | `plan(drafts)` → `ValidationPlan`；`assess(plan, evidence)` → `ValidationReport` | 结构检查 + 外部环境/参考解/验证器校准/目标忠实度/去重证据 |
| `SelectPractice()` | `drafts, report, budget=..., base_pool_version=...` → `TaskPoolPlan` | 精确／语义去重、当前策略难度测量、显式探索与来源配额；不暗中补齐缺额 |
| `BuildSupervision()` | SFT/repair/preference/procedural 请求及调用方材料授权 → `SupervisionProposal` | 语义片段与配对关系；保留证据和 synthetic 标签，不生成 token/logprob |

所有算子继承现有 `Module`，支持 `describe/clone/set_params` 和配置冻结。模型与验证算子使用普通方法，不创建 `Call` 或新请求协议。合同为 frozen dataclass，`dataclasses.asdict` 后用标准 JSON 编码即可；嵌套 JSON 仍由调用方保管，不应在验证后修改。`schema_version=1` 不是搜索 wire 版本。`OutcomeRecord.evidence_refs` 和 `ValidationEvidence.evidence_refs` 保持调用方已有引用格式，不会被自动读取或授权。

调用方先归一化 `OutcomeRecord`：`sample_id` 必须跨其输入命名空间唯一，同一样本重试使用递增 `attempt`；策略或环境改变时是新 sample。冲突的重复证据会报错。`passed=None` 表示缺失或不可见的 verdict，不得从私有评分推断标签。提取时过滤 partition 只是本地数据约束，调用方仍须验证实际授权以及 train/dev/test 的 family 隔离。

生成结果格式：

```json
{"practices":[{
  "instruction":"Compute the function at x=4.",
  "family":"piecewise-linear-train",
  "data":{"x":4},
  "reference":{"answer":12},
  "verifier":{"kind":"absolute-error","tolerance":1e-9}
}]}
```

`data/reference/verifier` 的领域内容由调用方解释。生成器给出的参考解或 verifier 不构成证明。验证策略要求参考解与 verifier；缺失时返回结构失败，不调度执行。环境、参考解和验证器校准必须有 execution 类证据；目标和新颖性允许语义或领域结构检查。缺失、未知、无引用、重复或身份不符的证据不会被当作通过。证据真实性仍由调用方的可信运行记录保证，布尔值和字符串本身不是密码学证明。

`SelectPractice` 的内容摘要包含产物种类，只负责精确去重。开启语义筛选时，调用方提供 `SemanticNeighborhood`：绑定草案字节、检索方法和比较池摘要，说明相似度阈值以上的近邻是否完整。比较池摘要是 `digest(sorted(set(existing_content_digests) | {d.content_digest for d in drafts}))`。缺失或不完整结果不能当成新颖；判断近重复时只排除与原池及本次真正保留条目重复的草案。选择计划携带基池版本，调用方应用前核对；它不授予 student rollout 或梯度训练资格。

## 测量、探索和混合池

`ProgressObservation` 绑定目标、策略、相同评价条件、唯一 sample IDs、成功数量与证据。遗忘比较必须指定前后策略且 `comparison_id` 相同；同一不可变样本不能换策略使用。稀有动作调度要求每个可用动作都有显式计数，缺失不是零次。`signal_mix` 的三个权重可以独立设为零，停用项不要求其额外输入。

目标调度默认采用可替换的软评分：frontier 在成功率 0.5 附近较高，forgetting 使用成功率下降，rare_action 使用动作次数的倒数。它们不是 CoEvolve 的原论文判定公式。`ExtractLearningSignals` 单独实现论文第 3.1 节的布尔条件：可比近期窗口中曾得分至少 0.5、当前低于 0.5；同策略同组同时出现大于与小于 0.5 的结果；达到最小观测量后，已出现的动作模式频率低于阈值。未知／不完整结果不提供失败信号，未出现的动作不会伪装成论文中的 rare signal。[原论文](https://arxiv.org/html/2604.15840v1#S3.SS1)

练习难度使用 `PracticeMeasurement`，必须绑定当前策略与草案摘要；成功率范围和最小样本量是显式参数。`exploration_count` 预留独立探索槽，要求显式随机源；测量未知只能使用这些槽。`mix_counts=(("fixed", 2), ("random", 2), ("failure", 2))` 配合调用方的草案来源标签约束混合池。配额总和必须等于预算，某类不足时返回较小池和拒绝原因，不拿其他来源偷偷填满。

## 不同产物的验证

`kind="environment"` 的 `data.environment` 保存调用方的可执行环境定义，仍需实际启动、参考执行与 verifier 负例校准。`kind="trajectory"` 的 `data.trajectory_plan` 是待执行／回放方案；没有实际 replay、reference 和 verifier calibration 证据便不能入选。`kind="example"` 使用 `data.question/answer`，以 semantic correctness 而非虚构环境执行验证内容；它仍是 synthetic 材料。不同 kind 分批验证，调用方再组合选择计划。

## 监督构建

`BuildSupervision` 接受四类明确请求：`SFTSupervision`、`RepairSupervision`、`PreferenceSupervision` 和 `ProceduralSupervision`。SFT success 必须是完整成功执行；prefix 必须有绑定准确截断位置的独立证据，不能根据最终失败倒推错误边界。

repair 要求独立的新捕获与成功证明，并将 replay、checkpoint reset 或终态 continuation 证据绑定原失败、实际起始状态和修复执行。输出只给新捕获上的语义 loss 范围：旧失败部分不训练、修复后缀训练。可信 builder 仍需从新的原生回执构建 token/mask；算子不拼接旧 logprob。

trajectory preference 要求相同任务、环境和起始条件，允许后续分叉；step preference 额外要求同一决策前缀／状态。多数票标签明确保留为 `majority_vote`，不升格为 oracle。过程问答始终标为 `synthetic_procedural`，没有原生轨迹成功证明。

材料范围 `feedback_only / verified_reference / gold_answer_allowed` 由调用方通过 `allowed_protocols` 提供已获得的授权；请求字段不能自行扩权。这个参数只是可信调用方传入的约束，不是能力令牌；实际 artifact、权限、状态和 mask 由训练 builder 再验证。

## 调用方组合

下面展示当前签名；`model_call` 和 `run_checks` 是调用方自己的函数：

```python
from gear.curriculum import (
    ExtractOutcomeCases, ContrastiveDiagnoser, MergeFailureMemory,
    SelectLearningTargets, PlanPractice, GeneratePractice,
    ValidatePractice, SelectPractice,
)

cases = ExtractOutcomeCases()(records)
diagnoser = ContrastiveDiagnoser()
delta = diagnoser.parse(model_call(diagnoser.prepare(cases)), cases=cases)
memory = MergeFailureMemory()(memory, delta)
targets = SelectLearningTargets()(memory, budget=4)
generator = GeneratePractice()
validator = ValidatePractice("my-validation-runner-v1")
plans = PlanPractice(generator.identity, validator.identity)(targets)
drafts = tuple(draft for plan in plans for draft in generator.parse(
    model_call(generator.prepare(plan, cases=cases)), plan=plan,
))
checks = validator.plan(drafts)
report = validator.assess(checks, run_checks(checks))
selection = SelectPractice()(drafts, report, budget=4, base_pool_version="pool-v1")
```

训练调用方把选中草案转成既有 `TaskSource.generate(ctx)` 返回格式。实际算子参数、提示词、生成策略和资源摘要进入 `TrainingConfig.parameters`；源码依赖显式声明，不能依赖 stage_identity 自动读取 Module 参数。

搜索调用方把 `ModelInput` 转成现有 `MetaInput/Meta`，在已有 `step/Call/state` 路径执行与恢复。新任务需经调用方准入进入下一个 run，不能直接扩大当前 `view.tasks`。

监督提案、生成和验证算子不等于训练后端或完整论文配方。`ReflectiveSearch` 已在 `gear.algorithms` 提供正式 harness 搜索；可选 `training_gate=True` 在开发集选型前，用相同训练批次核对候选相对父代的严格提升，无提升便结束该轮。默认仍为直接开发集选型。这项门槛是 Forge-inspired 配方的组成部分，本身不代表完整 Forge。

新增可信训练 builder 的输入与限制见[训练阶段说明](training/stages.zh-CN.md)：修复提案在调用处映射到新捕获 receipt 的 loss 边界，偏好关系核对两侧真实输入与状态，过程问答通过真实 tokenizer 进入既有 offline SFT 数据合同。完整环境探索配方与 GPU／DPO／LoRA 等运行能力按[实施台账](curriculum-implementation-status.zh-CN.md)分别验收。

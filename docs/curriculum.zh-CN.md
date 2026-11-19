# Failure → Data 算子

`gear.curriculum` 是独立的轻量能力包。它包含八个算子及其输入输出定义，只依赖标准库、`gear.core` 和公共 JSON 合同。它不导入 search、training、evaluation、memory，也不提供 adapters、执行器或新的流程状态机。

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

## 算子与合同

| 算子 | 输入 → 输出 | 当前策略 |
| --- | --- | --- |
| `ExtractOutcomeCases()` | `OutcomeRecord[]` → `OutcomeCase[]` | 每个逻辑 sample 取最新 attempt；只保留 train；完整且有明确 verdict 才标成功/任务失败 |
| `ContrastiveDiagnoser()` | `prepare(cases, memory=...)` → `ModelInput`；`parse(response, cases=...)` → `FailureMode[]` | 检查引用；反例必须与失败的 family、policy、environment 可比 |
| `MergeFailureMemory()` | `memory, delta, measurements=...` → 新 `FailureMode[]` | 支持案例去重；显式测量决定掌握；新失败重新激活 |
| `SelectLearningTargets()` | `memory, budget=..., rng=...` → `LearningTarget[]` | frequency 或 uniform；整数预算分配；uniform 要求显式随机源 |
| `PlanPractice(generator_id, validation_policy_id)` | `targets` → `PracticePlan[]` | failure 或 random；本期仅 task |
| `GeneratePractice()` | `prepare(plan, cases=...)` → `ModelInput`；`parse(response, plan=...)` → `PracticeDraft[]` | 严格响应 schema、数量和 family；输出仍是未准入草案 |
| `ValidatePractice(validator_id)` | `plan(drafts)` → `ValidationPlan`；`assess(plan, evidence)` → `ValidationReport` | 结构检查 + 外部环境/参考解/验证器校准/目标忠实度/去重证据 |
| `SelectPractice()` | `drafts, report, budget=..., base_pool_version=...` → `TaskPoolPlan` | 仅选通过验证的任务；精确内容去重；稳定顺序截断预算 |

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

`data/reference/verifier` 的领域内容由调用方解释。生成器给出的参考解或 verifier 不构成证明。MVP 的验证策略要求参考解与 verifier；缺失时返回结构失败，不调度执行。环境、参考解和验证器校准必须有 execution 类证据；目标和新颖性允许语义或领域结构检查。缺失、未知、无引用、重复或身份不符的证据不会被当作通过。证据真实性仍由调用方的可信运行记录保证，布尔值和字符串本身不是密码学证明。

`SelectPractice` 的内容摘要只负责精确去重。语义去重由调用方生成 `novelty` 证据，不能把不同文字的同一道题当作自动通过。选择计划携带基池版本，调用方应用前核对；它不授予 student rollout 或梯度训练资格。

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

本期未实现 `BuildSupervision`、轨迹修复、环境生成、GPU 训练或完整论文算法，未增加 `gear.algorithms` 导出。需要这些能力时再实现对应输入输出和配方，不预先创建空模块。

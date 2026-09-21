# Gear Benchmark Adapter 与 Harbor Evaluation Result 规范

状态：V1 实现待评审

目标扩展：第 7.4 节定义 V1 已实现的完整 `raw_metrics` 保留与独立 `objective_score` 证据。Refine 启动时直接传入目标权重及可选固定 scale，不要求 benchmark 预定义评分 profile；SoL-Pi 式成本、token 与时延优化使用同一合同。原有 V1 verifier、`total_score`、`process_score` 与 assertion component 保持原义。

适用仓库：Gear、agent-hitch、各 benchmark adapter

目标读者：benchmark adapter、Harbor/Hitch evaluator、Gear refinement 维护者

## 1. 摘要

2026-09-12 兼容说明：`failure-cluster-gepa-v1` 的任务子集、逐 cell 缓存和 4→2→1 调度由 Gear 内部完成，继续使用 Hitch 已有的普通 dataset 评测与 inspect 命令，无需 Hitch 新增协议或能力声明，见[接入说明](candidate-promotion-implementation.zh-CN.md)。本文旧 observation 的整条 invalid 语义保留，Gear 不抢救其中未经独立认证的 outcome；原生无 process 的标准 benchmark 使用 outcome 路径。

所有 Hitch 当前支持且可供 Gear 运行的 benchmark 必须先由各自的 adapter/compiler 转换为**自包含的
Harbor task dataset**。转换完成后，Gear 统一通过 Hitch 的普通 `--dataset` 路径
运行，不为某个 benchmark 配置专用 verifier，也不依赖 `--benchmark-lock`、参数
wrapper、benchmark 名称判断或特殊 task-slot 规则。

每个 Harbor task 自带 prompt、环境、工具、生命周期和 verifier。Verifier 与
Hitch/Gear 之间定义三个语义独立的标准通道：

1. `total_score`：任务的最终总分；
2. `process_score`：任务中可评分子目标的完成程度；
3. `feedback`：结构化诊断与改进信息。

`total_score` 是所有 benchmark 必须提供的唯一通道；`process_score` 和 `feedback`
是可选能力。通道缺失必须被表示为 unavailable，Gear 不得用总分、零值或空字符串
伪造缺失的过程分或 feedback。例如 Terminal-Bench 只提供总分是合法情况。

AutomationBench 映射为：

- `task_completed_correctly` → `total_score`；
- `partial_credit` → `process_score`；
- `assertions.json` → `process_score.components`；
- 当前没有原生 feedback，feedback channel 为 unavailable。

当前 Hitch 已支持的其余 benchmark 均为 total-only：Terminal-Bench、
Terminal-Bench-Science、GDPval public rubric、HLE、OSWorld V2。它们必须经过同一个
Package v1 compiler 生成标准 dataset，不能因为原始 verifier 还包含其他字段或最终分数
是小数，就把这些字段推断成过程分。CursorBench 当前缺少已授权 task/grader package，
不属于本规范所称的“当前支持”。

## 2. 当前问题

Harbor task 格式本身支持每个任务配置独立 verifier，例如 `[verifier]`、
`tests/test.sh`、独立 verifier environment 和 reward 输出。因此 Gear 不需要也
不应该选择 verifier 可执行文件。

当前 AutomationBench 编译产物的问题不是“Harbor 不支持 verifier”，而是产物仍
依赖 Hitch benchmark-native lifecycle：

```text
agent 执行
  -> Hitch native phase 固化 /evidence/snapshot.json
  -> /tests/test.sh 读取 snapshot
  -> AutomationBench rubric 计算 reward
```

当 Gear 通过普通 `--dataset` 运行这些 task 时，Harbor 能找到 verifier，但
benchmark-native phase 没有完整执行，最终产生缺失或无效 snapshot。另一方面，
直接让 Gear 理解每种 benchmark package 会把 benchmark 细节泄漏到 orchestration
层，并引入 source kind、CLI mode 和 slot 策略之间不必要的耦合。

本规范选择在 adapter/compiler 层解决问题：把 benchmark 的所有运行语义完整降级
为标准 Harbor task。

## 3. 目标

- 所有支持的 benchmark 使用相同的 Gear → Hitch → Harbor 执行路径；
- 每个 benchmark 可以拥有不同 verifier，但 verifier 完全随 task 分发；
- 编译后的 dataset 不依赖 benchmark-specific controller lifecycle；
- baseline 与 Candidate 使用 byte-identical task/verifier；
- 总分以及 benchmark 实际提供的过程得分/feedback 被独立保存、传输和消费；
- benchmark 提供过程得分时，它是独立的一等信号，不被定义成 tie-breaker 或 feedback；
- 当前 trial 的 verifier 结果不得反馈给同一 trial 中的被评测 agent；
- seed 可以向 meta-agent 提供受控诊断，heldout 默认不暴露细节；
- benchmark 及 scoring schema 变化时，旧证据不得复用。

## 4. 非目标

- Gear 不创建、修改或执行 benchmark verifier；
- Gear 不解释 benchmark 私有 assertion 类型；
- Gear 不要求所有 benchmark 使用相同的任务环境或工具协议；
- 本规范不定义在线 reinforcement learning 或逐 tool-call reward；
- `process_score.components` 不默认表示 agent trajectory 的动作步骤；
- V1 不要求 Hitch daemon 支持 benchmark package。

## 5. 职责边界

| 层 | 职责 |
| --- | --- |
| Benchmark adapter | 将源 benchmark 编译成自包含 Harbor dataset；规范化评分产物 |
| Harbor task | prompt、环境、工具服务、生命周期、verifier |
| Harbor | task/container/verifier 的标准执行 |
| Hitch | harness 注入、attempt、并发、轨迹、评分产物收集与校验 |
| Gear | baseline/Candidate 编排、指标消费、meta feedback policy、promotion |

核心约束：

```text
benchmark-specific behavior stops at the compiled Harbor dataset boundary
```

Gear 和 Hitch 的普通 dataset evaluator 中不得出现
`if benchmark === "automationbench"` 一类分支。

## 6. Benchmark Adapter 输出

### 6.1 Dataset 目录

Adapter 输出一个普通 Harbor dataset：

```text
compiled-dataset/
├── benchmark.adapter.json
├── task-a/
│   ├── task.toml
│   ├── instruction.md
│   ├── environment/
│   └── tests/
│       ├── test.sh
│       └── ...
└── task-b/
    └── ...
```

`benchmark.adapter.json` 不是运行时控制文件。它只提供 provenance、评分 schema
和审计信息。删除它之外，task 仍应能由普通 Harbor task runner 独立执行；Hitch
可以要求该文件存在以识别 Gear 支持的标准化结果。

### 6.2 Adapter manifest

```ts
interface BenchmarkAdapterManifestV1 {
  schema_version: '1'
  kind: 'gear-harbor-benchmark'
  benchmark: {
    id: string
    revision: string
  }
  adapter: {
    id: string
    revision: string
    output_protocol: 'gear-harbor-eval-result-v1'
  }
  scoring: {
    total_score: ScoreDefinitionV1
    process_score?: ScoreDefinitionV1
  }
  tasks: Array<{
    task_id: string
    task_digest: `sha256:${string}`
  }>
  dataset_digest: `sha256:${string}`
}

interface ScoreDefinitionV1 {
  source_metric: string
  direction: 'maximize' | 'minimize'
  range: [number, number]
  reducer: 'task-macro-mean'
}
```

约束：

- benchmark revision、adapter revision 和每个 task digest 必须不可变；
- `dataset_digest` 覆盖 manifest 语义字段及全部 task tree；
- task ID 唯一并按字典序排列；
- baseline/Candidate 的 manifest 和 dataset digest 必须完全一致；
- adapter version 或评分映射变化会产生新的 dataset digest；
- 本地绝对路径不进入语义 digest。

### 6.3 自包含要求

每个 task 必须满足：

1. `hitch eval run --dataset <compiled-dataset>` 可以直接运行；
2. 不要求调用 `--benchmark` 或 `--benchmark-lock`；
3. 不要求 wrapper 改写 CLI 参数；
4. verifier 入口由 Harbor task 自己声明；
5. sidecar/tool server 由标准 task environment/Compose 生命周期启动；
6. verifier 所需最终状态由标准 task artifact 或 task-owned service 提供；
7. verifier 不读取 Gear workspace 或另一个 trial 的可变状态；
8. 相同 task 可在独立容器中确定性重放；
9. 任何额外 metadata 都不得要求 benchmark-specific controller branch。

如果某个 benchmark 无法满足这些条件，其 adapter 必须明确报告 unsupported，不能
悄悄退回 Hitch 私有 lifecycle。

### 6.4 Package v1 标准编译

Terminal-Bench、Terminal-Bench-Science、GDPval、HLE 与 OSWorld 的 producer 先生成
Package v1，再由通用 compiler 导出标准 dataset：

```sh
hitch benchmark validate --package /absolute/package
hitch benchmark compile --package /absolute/package --out /absolute/compiled-dataset
hitch eval run --dataset /absolute/compiled-dataset --harness <immutable-ref> --model <model>
```

Compiler 必须从 package manifest 的 `primary_metric` 生成 `total_score` 映射，并将
`benchmark.adapter.json`、task tree digest、source package digest 和 compiler revision
绑定为不可变身份。它不得根据 benchmark ID 分支，也不得把其他原始 metric 自动声明为
`process_score`。`--benchmark`/`--benchmark-lock` 只作为本地兼容入口保留；其内部也必须
先产生相同标准 dataset。Gear 只调用显式 compile 后的 `--dataset` 路径。

## 7. 标准 Verifier 输出

每个 verifier 必须写 `reward.json`。只有 benchmark 支持对应能力时才写
`process.json` 或 `feedback.json`：

```text
/logs/verifier/
├── reward.json
├── process.json    # optional
└── feedback.json   # optional
```

### 7.1 总分与过程得分

只有总分的 benchmark，例如 Terminal-Bench：

```json
{
  "reward": 1,
  "total_score": 1
}
```

同时具有过程得分的 benchmark，例如 AutomationBench：

```json
{
  "reward": 0,
  "total_score": 0,
  "process_score": 0.7435897435897436
}
```

约束：

- `reward` 和 `total_score` 必须存在且为有限数值；
- `process_score` 可选；存在时必须是有限数值；
- `reward` 是 Harbor 兼容别名，V1 必须等于 `total_score`；
- 每个存在的分数都必须位于 manifest 声明的 range；
- `process_score` 存在时，manifest 必须声明对应定义；反之亦然；
- `total_score` 和已提供的 `process_score` 是独立的一等指标；
- Gear 不得把 `process_score` 重命名为 tie-break score 或 feedback；
- Gear 不得把 `total_score` 复制为缺失的 `process_score`；
- reducer 在 dataset 级别分别计算存在的指标，不能先混合两个指标。

后续 [Refine 优化目标规范](refine-objective-spec.zh-CN.md) 允许在 Refine 启动时直接传入 `objective.terms`，例如 `0.5 × pass_rate + 0.5 × process_score`。benchmark/adapter 负责声明原始指标的身份、单位、来源、聚合和有效性，不必预先定义评分组合。目标分另存为 `objective_score`，不得覆盖或重命名本节的 `total_score`、`process_score` 与通过状态。

第 7.4 节定义完整原始指标与派生结果的证据合同。所有实际产生的原始分数、usage 及其原始产物必须保留，不因未被选中或权重为零而裁剪；原始指标按各自合同分别聚合，Refine 依据启动时传入并封存的权重、固定线性 scale 和显式约束计算目标分。

### 7.2 过程得分组件

`process.json` 只在 `reward.json.process_score` 存在时出现：

```ts
interface ProcessScoreEvidenceV1 {
  schema_version: '1'
  metric: string
  score: number
  detail_status: 'components' | 'aggregate-only'
  passed?: number
  total?: number
  excluded?: number
  components?: ProcessComponentV1[]
}

interface ProcessComponentV1 {
  id: string
  category: string
  status: 'passed' | 'failed' | 'excluded'
  weight: number
  code?: string
  public_details?: Record<string, unknown>
  private_details_ref?: string
  trajectory_refs?: Array<{
    run_id: string
    seq_start?: number
    seq_end?: number
  }>
}
```

约束：

- `detail_status=components` 时，计数和 `components` 必须存在；
- component ID 在单个 task/verifier revision 内稳定且唯一；
- `excluded` component 不进入分母；
- `score` 必须与 `reward.json.process_score` 一致；
- 对加权 benchmark，`passed/total` 可表示 component 数量，实际 score 按 weight
  计算，并在 manifest/adapter 文档中说明；
- `trajectory_refs` 可选；缺少它时 component 只表示子目标结果，不表示某个 agent
  动作步骤；
- `private_details_ref` 只用于审计，不进入 meta-agent 默认视图；
- `public_details` 不得包含凭据、隐藏测试答案或不必要的精确期望值。

如果 benchmark 只有聚合过程分、没有 component 明细，必须使用
`detail_status: 'aggregate-only'` 并省略计数与 components。完全没有过程指标的 benchmark 不写
`process_score`，也不写 `process.json`。

### 7.3 Feedback

`feedback.json`：

```ts
interface VerifierFeedbackV1 {
  schema_version: '1'
  items: Array<{
    code: string
    severity: 'info' | 'warning' | 'error'
    message: string
    component_ids?: string[]
    trajectory_refs?: Array<{
      run_id: string
      seq_start?: number
      seq_end?: number
    }>
  }>
}
```

Feedback 是解释和诊断，不是分数。语义上必须区分：

- 没有 `feedback.json`：该 benchmark 不提供 feedback 通道；
- 存在 `feedback.json` 且 `items=[]`：该 benchmark 支持 feedback，但本次没有反馈。

空 feedback 的格式为：

```json
{
  "schema_version": "1",
  "items": []
}
```

禁止用 LLM 在 verifier 内临时生成不可复现 feedback。V1 feedback 必须由确定性规则
或 verifier 已有结构化结果产生。

### 7.4 完整原始指标与 Refine 目标分（V1）

benchmark/adapter 声明原始指标的 identity、单位、来源、聚合方式、适用范围与有效性，Refine 启动时直接接收优化目标。benchmark 不需要预定义评分 profile，公式也不隐藏在 benchmark 名称后。具体请求与生命周期见 [Refine 优化目标规范](refine-objective-spec.zh-CN.md)。

所有实际产生的原始分数、usage 及原始产物完整保留在独立 `raw_metrics` 证据中；未选中指标和零权重指标也不得丢弃。派生目标分写入单独的 `objective_score.json` artifact，不覆盖 `reward.json.total_score`、`reward.json.process_score`、原 partial、通过状态或原始 usage。现有 `ProcessScoreEvidenceV1` 与 `ProcessComponentV1` 保持原义，不要求改造为连续评分组件。

`control.start` 参数示例：

```json
{
  "objective": {
    "terms": [
      { "metric": "pass_rate", "weight": 0.5 },
      { "metric": "process_score", "weight": 0.5 }
    ]
  }
}
```

每项还可声明固定 `scale`。省略整个 objective 时，新建 evolution 使用 `terms: [{ metric: 'pass_rate', weight: 1 }]`；省略某项 scale 时使用 1，单位与该原始指标相同。目标方向统一为 maximize：

```text
S = Σ weight_i × (m_i / scale_i)
scale_i 为有限正数；weight_i 为有限实数，允许负数
```

terms 必须非空、metric 不重复、权重不能全零。权重不要求和为 1，不自动归一化；负权重直接表达对费用、token 或时延的惩罚，不根据指标名称另行翻转符号。目标分不必落在 `[0,1]`，也不做 clipping。V1 只支持上述线性定标，不接收非线性转换、动态 scale、任意表达式或脚本。`pass_rate` 必须有明确通过判定，不能根据 `[0,1]` 范围或 `reward > 0` 推断。

SoL-Pi 式优化使用普通 raw metric，例如：

```json
{
  "objective": {
    "terms": [
      { "metric": "pass_rate", "weight": 0.5 },
      { "metric": "process_score", "weight": 0.5 },
      { "metric": "api_cost_usd", "weight": -0.1, "scale": 1 },
      { "metric": "total_tokens", "weight": -0.1, "scale": 100000 }
    ]
  }
}
```

该例的指标 ID、权重和 scale 仅用于说明，必须解析到真实 metric contract；不要求所有 benchmark 提供这些指标。latency 可用相同方式纳入。SoL-Pi 不再对应固定乘法、效率变换或伪装的 `process_score`。加权分允许质量与消耗交换；用户需要质量守门时，在 objective 的 `constraints` 中显式声明原 `pass_rate` 或 `process_score` 的要求与比较基准。不自动添加质量约束，也不能声称该公式保证质量不回退或零进展不得高分。

指标聚合规则由各自的 metric contract 固定，不随 objective 改变。支持 staged 搜索的目标必须提供兼容共同任务/重复槽位范围的逐 trial、逐任务均值宏平均证据；先按合同聚合同任务重复，再按冻结任务权重形成当前 scope 的指标值 `m_i`，最后线性求和。相同 scope 内可以生成等价的逐任务目标投影，但不同 scope 的局部均值不能直接排名。原始 token/费用/耗时 totals 仍完整保存，不能把总量改名冒充每任务均值；只有 dataset 总量或不兼容 reducer 的指标应拒绝该 staged 用法，不伪造逐任务证据。

证据分为两个独立 artifact。以下结构仅示意边界；`ObjectiveDefinitionV1` 使用目标规范中的完整定义，包含 terms 和可选 constraints：

```ts
interface RawMetricsEvidenceV1 {
  schema_version: '1'
  kind: 'raw-metrics'
  scope_digest: string
  original_artifact_refs: string[] // 完整原始评分、usage、明细及来源
  metrics: Array<{
    id: string
    contract_digest?: string // 未声明的原始字段仍保留，但不能直接用于评分
    status: 'available' | 'missing' | 'invalid' | 'unsupported'
    unit?: string
    observations: Array<{
      task_id: string
      repetition: number
      run_id: string
      attempt: number
      value: number
      evidence_refs: string[]
    }>
    aggregate_value?: number
    aggregate_evidence_refs: string[]
  }>
}

interface ObjectiveScoreEvidenceV1 {
  schema_version: '1'
  kind: 'refine-objective-score'
  objective: ObjectiveDefinitionV1
  objective_digest: string
  projector_digest: string
  status: 'available' | 'missing' | 'invalid'
  score?: number // 所需输入完整有效时存在；约束失败不改写分数
  scope: {
    task_manifest_digest: string
    repetition_manifest_digest: string
    condition_digest: string
    harness_commit: string
  }
  raw_metrics_refs: string[]
  inputs: Array<{
    metric: string
    contract_digest: string
    raw_input_refs: string[]
    value?: number
  }>
  contributions: Array<{
    metric: string
    weight: number
    scale: number
    scaled_value?: number
    contribution?: number
  }>
  constraint_results: Array<{
    constraint_digest: string
    reference_digest?: string
    status: 'passed' | 'failed' | 'unavailable'
    evidence_refs: string[]
  }>
}
```

合同要求：

- `raw_metrics` 与原始 artifact 的保留不依赖 objective。实际产生的原始 total/process、其他评分、通过判定、全部 usage 桶、费用与耗时数据均须保留；不是只抽取本次参与公式的列。缺失、无效或不支持的状态也保留，不写假数值。未知原始字段保留来源但不可未经声明直接评分，原始敏感证据的访问与脱敏边界不因保留要求扩大。
- 每条已声明 metric 的身份包含单位、来源提取器、计量范围、聚合与有效性合同。每条 observation 绑定任务、逻辑 repetition、run/attempt 和不可变原始 artifact digest；原始 totals 与其均值投影有各自明确来源及聚合说明。scale 仅定标，不修改原始值、单位或聚合语义。
- 新建 evolution 时封存传入或默认解析的 objective，包括正负权重、scale、约束、比较精度和投影实现身份。scale 不能从当前候选 min/max、champion 或后续结果动态计算。目标变化需新 evolution；旧 sealed evolution 缺少新字段时维持原评分行为，不解释为新默认值。
- scope 内任何非零权重项或约束所需指标 missing/invalid 时，目标证据不完整，不填零、不删任务、不忽略该项或重分权。未选中或权重为零且未用于约束的指标缺失，只保留其状态，不阻止目标计算；零权重不代表可伪造其 scaled value。已有 V1 envelope 将整条 observation 判为 invalid 时，不能从中抢救未经独立认证的指标。
- `inputs`、`contributions` 和 `score` 必须能由冻结 objective、metric contracts 与原始证据重算。约束完整且判为 failed 时，目标分仍可有效，候选不能绕过显式约束晋升；约束证据缺失与约束未通过必须区分。
- 费用、token 与时延都作为有合同的普通 raw metric 保存。若参与目标或约束，证据须覆盖声明范围内的主模型、辅助模型、摘要/压缩与内部重试；计费模型、价格快照、token 桶、wall-clock 边界及基础设施修复费用归属均须可核验。真实费用与 API 等价估算明确区分；缺失 usage 不当零消耗，也不能挑选最便宜的运行替代既有有效槽位。
- 独立目标 artifact 在所需原始证据完整后由版本化投影器生成。若 usage 在 Target 结束后才收齐，可在原 verifier 之后评分；不要求任务 verifier 读取 Gear 控制状态，不按 benchmark 名称增加隐藏分支。
- 接入通过显式 schema 与能力核验。无法理解 objective 定义、metric contract 或目标分 artifact 的消费者必须拒绝该评分路径，不得静默忽略权重、退回 `total_score` 或覆盖 `process_score`；不启用扩展的旧 V1 路径保持原行为。
- 更换 objective 时，兼容、完整、可验证的原始 baseline/candidate 指标与 usage 可在新 evolution 中重算目标分，不要求改写 V1 verifier 证据或重跑未变的任务。缺少所需原始指标则不能复用为有效新目标；旧 objective_score、排名、archive 派生视图与晋级决定不得改写或跨目标身份复用。仅改变 objective 不改变 task/verifier 字节；原始 metric contract 改变时须按其版本身份重新核验。

验收至少覆盖：默认通过率、直接传入 `0.5 × pass_rate + 0.5 × process_score`、负费用/token 权重、固定 scale、拒绝全零权重和重复 metric、不自动归一化、未选原始指标完整保留、未选项缺失不阻止目标、选中项或约束缺失拒绝评分、原始 totals 与宏平均区分、显式质量约束、未知定义/artifact 拒绝、原 V1 证据重新评分及旧结果不变。

## 8. Benchmark 映射

| Benchmark | Adapter 输出 | `total_score` 来源 | `process_score` | `feedback` |
| --- | --- | --- | --- | --- |
| AutomationBench | 直接标准 dataset | `task_completed_correctly` | `partial_credit` | unavailable |
| Terminal-Bench 4.0 | Package v1 → 通用 compiler | `reward` | unavailable | unavailable |
| Terminal-Bench-Science 0.1 | Package v1 → 通用 compiler | `reward` | unavailable | unavailable |
| GDPval public rubric | Package v1 → 通用 compiler | `rubric_score` | unavailable | unavailable |
| HLE | Package v1 → 通用 compiler | `correct` | unavailable | unavailable |
| OSWorld V2 | Package v1 → 通用 compiler | `native_score` | unavailable | unavailable |

### 8.1 Terminal-Bench

Terminal-Bench 当前只提供最终 reward，因此 adapter 输出：

```text
reward             -> reward.json.total_score
无过程指标          -> 不输出 process_score/process.json
无原生 feedback     -> 不输出 feedback.json
```

Gear 必须把 process 和 feedback 标记为 unavailable，不能复制 total score 补齐。

### 8.2 Terminal-Bench-Science

Terminal-Bench-Science 与 Terminal-Bench 使用同一个 Harbor source producer 和通用
compiler。原始 `reward` 映射为 `total_score`；不输出 process/feedback。

### 8.3 GDPval public rubric

GDPval public adapter 的正式最终指标是 `rubric_score`，映射为 `total_score`。
`strict_success` 可以作为 raw auxiliary metric 留在私有审计证据中，但它不是过程分；
adapter 不输出 process/feedback。该映射不代表 GDPval-AA v2 私有 judge panel 或 Elo。

### 8.4 HLE

HLE 的二值 `correct` 映射为 `total_score`。Judge reasoning 属于 grader 审计信息，不能
自动升级为标准 feedback；adapter 不输出 process/feedback。

### 8.5 OSWorld V2

OSWorld 的 `native_score` 映射为 `total_score`。该值允许是 `[0,1]` 内小数，但它仍是
official final scalar，不是过程分。`strict_success: null` 等 native receipt 字段不产生
额外标准通道；adapter 不输出 process/feedback。

### 8.6 AutomationBench

AutomationBench adapter 必须做以下转换：

```text
task_completed_correctly -> reward.json.total_score
partial_credit          -> reward.json.process_score
assertions.json         -> process.json.components
无原生 feedback          -> 不输出 feedback.json
```

AutomationBench assertion 当前包含：

```json
{
  "type": "gmail_message_sent_to_with_body_contains",
  "passed": false,
  "excluded": false,
  "params": {
    "to": "social@company.example.com",
    "body_contains": "Follower Growth"
  }
}
```

转换规则：

- `type` 映射为稳定 category/code；
- `passed=true` → `status=passed`；
- `passed=false` → `status=failed`；
- `excluded=true` → `status=excluded`，不进入过程得分分母；
- 原始 `params` 默认写入 private evidence；
- public component 只保留解决问题所需、不会泄漏答案的字段；
- adapter 必须验证过程分等于所有计分 assertion 的实际聚合结果。

注意：这些 assertion 是对最终 world state/output 的谓词，不是在线逐动作奖励。除非
adapter 能提供可信的 `trajectory_refs`，否则不得把 assertion 描述成“第 N 步正确”。

## 9. 运行与信息流

### 9.1 单个 trial

```text
Gear
  -> hitch eval run --dataset <compiled-dataset>
  -> Hitch/Harbor 创建 task 环境
  -> harness/agent 完成任务
  -> agent 结束
  -> verifier 读取最终状态
  -> verifier 写 total + 实际支持的 optional process/feedback
  -> Hitch 收集并封存证据
  -> Gear 消费结果
```

Verifier 必须在 agent 结束后执行。总分、过程得分和 feedback 不得在当前 trial 中回传
给被评测 agent，因此不会改变该 trial 的输出。

### 9.2 Gear refinement

```text
seed baseline
  -> total + available process/feedback
  -> meta-agent 读取允许公开的 seed evidence
  -> 生成 Candidate
  -> seed Candidate
  -> selection
  -> heldout baseline/Candidate
  -> promotion
```

benchmark 实际提供的过程得分和 feedback 可以影响下一版 Candidate，这是 refinement
的预期行为；它们不应影响产生这些分数的原始 trial。

## 10. 可见性与防泄漏

Gear 必须区分 private verifier evidence 和 meta-agent public view。

| 阶段 | total score | process score | components | feedback |
| --- | --- | --- | --- | --- |
| seed | 可见 | 如有则可见 | 如有则默认脱敏后可见 | 如有则默认可见 |
| heldout Candidate 生成前 | 不可见 | 不可见 | 不可见 | 不可见 |
| heldout 最终决策 | 可用于决策 | 如有则可记录 | 默认不提供给 meta | 默认不提供给 meta |
| 审计/operator | 可见 | 如有则可见 | 按权限查看 private evidence | 按权限查看 |

额外要求：

- heldout evidence 不得进入 Candidate workspace、prompt 或 meta tools；
- seed 的精确 expected literals 默认不公开；
- 所有公开字段经过凭据和路径脱敏；
- feedback 和 process 原始 artifact 有独立的大小限制，超限或结构不合法时 fail closed；
- 面向 meta-agent 的脱敏 public view 可独立压缩，并必须携带明确的截断标记；
- Gear 记录 meta-agent 实际访问过的 evidence refs；
- promotion 后是否公开 heldout 细节由显式 operator policy 决定。

## 11. Gear 数据模型

Gear 的 trial evidence 从单一 reward 扩展为：

```ts
interface EvaluationTrialScoresV1 {
  totalScore: number
  processScore?: number
}

interface EvaluationTrialEvidenceV1 {
  taskName: string
  runId: string
  attempt: number
  scores: EvaluationTrialScoresV1
  process?: ProcessScoreEvidenceV1
  feedback?: VerifierFeedbackV1
}

interface ScoreSummaryV1 {
  total: {
    score: number
    passed: number
    failed: number
  }
  process?: {
    score: number
  }
}
```

语义要求：

- `totalScore` 始终持久化，`processScore` 只在 verifier 实际提供时持久化；
- 不得用 `totalScore` 或 `0` 补齐缺失的 `processScore`；
- Candidate assessor 可以读取存在的 process，但不得在数据模型中把它降级为 tie-break；
- promotion policy 默认以 total score 为官方通过标准；
- 具体 selection/promotion 如何组合两个分数属于 policy，不能改变指标本身语义；
- baseline/Candidate 比较始终报告 total delta；双方都有 process 时才报告 process delta，
  否则明确显示 `process: unavailable`；
- evidence reuse identity 包含 scoring schema digest。

## 12. Hitch 收集与验证

Hitch 必须：

1. 继续使用普通 Harbor dataset 与稳定 `task × attempt` identity；
2. 验证 `reward.json` 的必选总分和可选过程分及其范围；
3. process 存在时验证 `process.json.score === reward.json.process_score`；
4. process detail 存在时验证 component ID 唯一、状态合法、计数一致；
5. feedback 存在时验证其引用的 component 存在；
6. 对所有实际存在的标准文件计算 digest 并写入 run bundle；
7. 通过 `hitch verifier inspect` 返回结构化总分及实际存在的 process/feedback；
8. 对 public 输出执行已有 credential redaction；
9. 未配置的额外 verifier 文件不得自动暴露；
10. 文件缺失或不一致时把 observation 标记为 invalid，而不是默认为零分。

Hitch verifier evidence 通过 schema-aware collector 显式收集
`process.json`、`feedback.json`；它不会开放任意 verifier 文件读取。Gear 的默认
meta failure card 只投影脱敏后的 public process components 与 feedback，省略
`private_details_ref` 和未声明的原始 artifact。

## 13. 评分策略

本规范只定义指标通道，不强制唯一的选择算法。V1 默认 policy：

- official benchmark score：dataset 级 `total_score` macro mean；
- process signal：仅在 benchmark 提供时计算 dataset 级 `process_score` macro mean；
- promotion gate：以 total score 为主，并继续应用现有 regression/gain policy；
- meta optimization：可以使用实际存在的 seed process score 和允许公开的 feedback；
- 所有报告始终展示 total；process 缺失时显示 unavailable，不用合成数字替代。

如果未来需要组合指标，必须在 Gear policy 中显式声明，例如：

```yaml
evaluation:
  reporting:
    totalScore: true
    processScore: true
  metaFeedback:
    seed: sanitized
    heldout: none
```

不得通过修改 task verifier 来改变 Gear promotion policy。

## 14. 兼容与迁移

### 14.1 旧 Harbor task

旧 task 只输出 `reward` 时：

- `total_score = reward`；
- `process_score` 不存在；
- process channel 标记为 unavailable；
- feedback channel 标记为 unavailable；
- Gear 在报告中标注 legacy normalization。

该兼容路径只用于迁移。新的 benchmark adapter 必须输出标准 `total_score`，但只有
benchmark 原生具有过程指标或 feedback 时才输出相应可选通道。Terminal-Bench 不得
为了满足格式而伪造 process score。

### 14.2 AutomationBench

落地顺序：

1. 修改 AutomationBench adapter，使工具服务、snapshot 固化和 verifier 输入全部由
   标准 Harbor task lifecycle 完成；
2. 输出标准 `reward.json/process.json`，feedback 保持 unavailable；
3. 使用普通 `hitch eval run --dataset` 做单任务 canary；
4. 验证 aggregate process score 与原始 `partial_credit` 完全相同；
5. 验证 component pass/fail 与原始 `assertions.json` 完全相同；
6. 用未修改 Gear dev 跑 seed/heldout E2E；
7. 删除参数 wrapper 和 direct task-slot 临时补丁。

## 15. 实现范围

### 15.1 Benchmark adapter

- 生成自包含 Harbor task；
- 输出 `benchmark.adapter.json`；
- 将 benchmark 原生评分转换为标准总分及其实际支持的可选通道；
- 将生命周期降级为标准 environment/artifact/verifier 流程；
- 生成 public/private 两级 process evidence；
- 提供固定输入的 golden result 测试。

### 15.2 agent-hitch

- verifier result parser 保留必选 total 和可选 process 分数；
- 增加 schema-aware process/feedback collector；
- 在 run bundle 中保存 digest、redaction 与 completeness；
- `verifier inspect` 返回统一 envelope，并保留通道 availability；
- 普通 dataset 路径支持这些能力，不增加 benchmark 分支。

### 15.3 Gear

- 扩展 evaluation/trial/summary types；
- baseline/Candidate 始终比较 total，仅在双方都有 process 时比较 process；
- meta failure bundle 支持脱敏 process components 与 feedback；
- heldout evidence 保持不可访问；
- scoring schema digest 进入 condition/reuse identity；
- UI/API 始终展示总分，过程得分/feedback 按 availability 展示。

## 16. 测试

### 16.1 通用 contract

- total-only verifier 正常解析，process/feedback 显示 unavailable；
- 完整三通道 verifier 正常解析；
- 实际存在的 total/process 非有限数、越界或不一致时拒绝；
- component 重复、计数错误、feedback 悬空引用时拒绝；
- private details 不进入 public API；
- 凭据和本地路径被脱敏；
- legacy reward-only task 只归一化 total，不合成 process；
- Terminal-Bench total-only 结果不被判为缺失或 invalid；
- baseline/Candidate scoring schema 不一致时拒绝比较。

### 16.2 AutomationBench

- 现有 assertion 到 process component 的一一映射；
- `excluded=true` 不进入过程分分母；
- social benchmark 的 `29/39` 映射为 `0.7435897435897436`；
- lead enrichment 的 `10/11` 映射为 `0.9090909090909091`；
- customer story intake 的 `2/3` 映射为 `0.6666666666666666`；
- agent 结束前无法读取 verifier scores；
- seed public view 不包含受保护 expected literals；
- heldout components/feedback 不可被 meta-agent 查询；
- 普通 `--dataset` canary 不依赖 benchmark native phase。

### 16.3 E2E

每个当前支持的 adapter 都必须通过 compile/admission contract 测试；运行级 E2E 至少
选择两个不同 adapter，并验证：

```text
adapter A -> Harbor dataset -> Hitch --dataset -> Gear
adapter B -> Harbor dataset -> Hitch --dataset -> Gear
```

两者可以有完全不同 verifier 和不同通道 availability，但 Gear/Hitch 走同一代码路径
并返回同一种结果 envelope。E2E 必须至少包含一个 total-only benchmark 和一个带
process score 的 benchmark。

当前适配集合为 AutomationBench、Terminal-Bench、Terminal-Bench-Science、GDPval
public rubric、HLE 与 OSWorld V2。CursorBench 在授权 package 可用并完成 producer 后
再进入该集合。

## 17. 验收标准

1. 所有支持的 benchmark 均先编译为自包含 Harbor dataset；
2. Gear/Hitch 普通 dataset evaluator 中没有 benchmark-specific 分支；
3. verifier 完全由 task 声明和执行；
4. 每个新 adapter 都输出 total，并只输出 benchmark 实际支持的 process/feedback；
5. AutomationBench 不使用 `--benchmark-lock`、wrapper 或 native phase；
6. AutomationBench 的总分、过程分和 assertion 状态与当前官方实现一致；
7. 当前 trial 中 agent 看不到 verifier 输出；
8. seed meta-agent 能读取受控过程信息；
9. heldout 细节不泄漏；
10. baseline/Candidate 始终展示 total delta；可用时展示 process delta；
11. 普通 Terminal-Bench/Harbor task 不发生行为回归；
12. Terminal-Bench-Science、GDPval、HLE、OSWorld 均由同一个 Package v1 compiler
    输出标准 total-only dataset；
13. GDPval `strict_success` 和 OSWorld fractional `native_score` 不被误标为 process；
14. 删除当前 direct task-slot benchmark ID 启发式补丁。

## 18. 推荐落地顺序

1. 固定必选 total、可选 process/feedback 的 JSON schema 与 adapter manifest；
2. 在 Hitch 增加 schema-aware collector 和 inspect 输出；
3. 在 Gear 增加 availability-aware 的 total/process/feedback 数据模型与展示；
4. 重构 AutomationBench adapter 为自包含 Harbor dataset；
5. 增加 Package v1 → 标准 dataset 通用 compiler，并覆盖 Terminal-Bench、
   Terminal-Bench-Science、GDPval、HLE、OSWorld；
6. 跑 total-only 与 process-capable 两类 golden/canary；
7. 跑 Gear seed/heldout E2E；
8. 删除实验 wrapper、native benchmark 特例和临时兼容补丁。

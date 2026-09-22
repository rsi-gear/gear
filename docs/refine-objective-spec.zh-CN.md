# Refine 原始指标与加权优化目标规范

- 状态：V1 已实现；当前支持 `failure-cluster-gepa-v1`，其他新建执行路径明确拒绝。使用方式见[加权目标指南](refine-objectives.zh-CN.md)。
- 日期：2026-09-20。
- 范围：原始指标保留、Refine 自定义加权目标、SoL-Pi 效率指标、证据、诊断、选择、晋级与恢复。
- 需求：保留 benchmark 的各种原始得分，用户再定义要优化的加权指标；默认通过率，也支持 `0.5 × pass_rate + 0.5 × process_score`。
- 本文的 MUST / MUST NOT 为实现与验收要求。

## 1. 决策

**评测保留完整原始指标，Refine 用用户指定的权重计算最终优化目标。** 原始指标与优化偏好分开保存、分别版本化。

```text
benchmark / runtime → 原始得分、通过状态、usage 与来源证据
                                   ↓
用户配置 objective：选取指标、指定权重 → objective_score → 搜索与晋级
```

benchmark / adapter 定义“有哪些指标、数值是什么意思、如何取得和聚合”；用户在 Refine 启动时定义“本次要优化什么、各项占多少”。改变权重无需修改 benchmark，也无需预先注册命名评分方案。

`objective_score` 是可重算的派生值，不能代替原始结果。即使只优化通过率，已有的 total、process、其他子项分数、费用、token、耗时也必须保留。未被选中或权重为零的指标不能因此被裁剪。

partial score 可能已经按 benchmark rubric 加权，这属于该原始指标的内部定义；Refine 的权重作用于选取的指标，不重写其内部算法。SoL-Pi 的接入方式是扩展可记录和选取的原始指标，把效率与质量按同一公式组合，不增加一个固定的 SoL 分数或覆盖 process score。

## 2. 原始指标层

### 2.1 完整保存，与目标无关

每次评测保留原始 verifier 输出、rubric 组件、通过状态和 runtime usage artifact，并提供可扩展的 `raw_metrics` 视图。它不是只包含 total/process 的固定双通道，也不是当前 objective 的输入子集。

- 保存 benchmark / runtime 实际产生的所有原始得分与计量值，包括未参与本轮优化的项；不只保存最终加权和。
- 原始 artifact 中暂未适配的字段仍原样保留；要将其作为 objective 输入，必须先声明并验证相应指标合同。
- 保留可用、缺失、无效的状态与原因。完整保存不意味着凭空计算 benchmark 未提供的分数或补出 runtime 未计量的费用。
- 保存每个 trial/task 的原值和来源，以及按既定口径计算的汇总。一个字段被映射成可选择的 metric 时，不删除原字段或改变其单位。

指标合同至少包括稳定 ID、版本、来源字段/提取器、单位、数值范围（若已知）、原始方向、适用任务、重复与任务聚合规则、比较精度及证据身份。benchmark 可以定义任意已验证的指标 ID；`partial_credit → process_score` 等映射必须明确，不能只凭字段名猜测。

例如：

| 可选择的指标 | 原始来源与含义 |
| --- | --- |
| `pass_rate` | 明确的逐 trial 通过状态；单次为 0/1，范围内聚合为通过率 |
| `total_score` | benchmark 原本输出的总分，保留原范围和算法 |
| `process_score` | benchmark 原本输出的过程/子目标分，保留原 rubric 权重 |
| benchmark 自定义 ID | 如某个子任务分、准确率或完成度；按该 benchmark 的指标合同解释 |
| `api_cost_usd` | 声明计量范围内的实际美元费用或明确标记的 API 等价估算 |
| `total_tokens`、`latency_ms` | 声明口径下的 token 消耗、耗时；保留原单位 |

`pass_rate` 必须来自明确通过判定。`total_score=0.6`、范围 `[0,1]` 或 `reward > 0` 都不能证明通过；当前部分 Hitch 路径以正 reward 计 passed，新目标不得未经核验复用该口径。

### 2.2 原始证据身份

指标记录绑定 task、逻辑 repetition、run/attempt、harness、运行条件、合同版本与来源 artifact digest。费用的价格快照与计量方法属于指标语义；不能将不同口径的数据视为同一指标。

原始结果的身份不包含用户的 objective 权重。改变权重只产生新的派生评分身份；指标映射、verifier 或计量口径发生变化时，才需要相应的原始指标/benchmark/adapter 身份变化。

## 3. Refine 直接定义目标

以下请求通过 `control.start` 提交，gateway 会解析并验证 objective。

新建 evolution 省略 `objective`，等价于只对 `pass_rate` 赋权重 1：

```json
{"seedTaskRef": "benchmarks/example/seed", "rounds": 3}
```

用户要求的等权目标直接写在请求中：

```json
{
  "seedTaskRef": "benchmarks/example/seed",
  "rounds": 3,
  "objective": {
    "terms": [
      {"metric": "pass_rate", "weight": 0.5},
      {"metric": "process_score", "weight": 0.5}
    ]
  }
}
```

也可以只优化某个其他原始指标，例如 `terms: [{metric: 'process_score', weight: 1}]`。Skill 将自然语言偏好解析为这份结构化配置，并回显公式、单位与解析结果；不能只把偏好写进 Meta prompt。

启动前解析可用指标、范围、权重、定标、约束及执行路径能力，返回完整 `resolvedObjective`。未知指标、歧义映射或不支持的评分路径明确拒绝，不能忽略字段或回退默认值。默认目标缺少真实通过合同也应报错；用户显式选择其他完整指标时可运行，并将通过率标记为不可用。

本版用声明式加权和覆盖单项与组合目标，不执行任意代码或表达式字符串。

## 4. 加权计算合同

### 4.1 公式、方向与单位

```text
objective_score = Σ weight_i × (metric_i / scale_i)
```

- `metric_i` 是指定评测范围内按指标合同聚合的原始指标值。
- `weight` 为有限实数，可以为负；至少一项非零。指标 ID 不重复。
- `scale` 可选，默认 1，必须是有限正数，按该指标的单位解释；它只做固定线性定标。
- 所有目标统一最大化。费用、token、耗时等越低越好的项可用负权重；原始指标方向用于解释和校验，不自动翻转权重。
- 权重不要求和为 1，不自动归一化；目标分也不要求位于 `[0,1]`，不能截断负数或大于 1 的值。

定标和权重属于本次 objective，不改写原始指标。省略 scale 时，权重明确作用于原始单位；例如美元与 token 的系数应按各自单位解释，不能悄悄将它们都视为 0–1 分数。若 process 原范围为 0–100，要与 0–1 的通过率等权比较，可以声明 `scale: 100`，原 process 数值仍保留为 0–100。

V1 只支持线性加权与固定正数定标。标尺在 admission 冻结；如依据已有基线选择标尺，须事先完成并保留引用。不能按当前候选集合、当前 champion 或 held-out 结果动态定标，不引入隐藏的非线性“效率分”。

### 4.2 共同范围与聚合

每个原始指标按其合同聚合，随后计算最终加权和。默认 staged 目标要求所有非零项在同一任务及重复槽位范围内可用，并支持以下一致口径：

```text
trial 原始指标 → task 内按冻结重复槽位求均值 → 按冻结任务权重汇总
                                                            ↓
                                         对各指标汇总值做加权和
```

固定线性定标、加权和与该均值聚合可交换，因此逐 task 的目标前沿与阶段目标一致。`0.5 × pass_rate + 0.5 × process_score` 必须就是界面中同范围两项原始汇总的组合，不能使用另一个分母。

global/held-out 使用任务宏平均；local 使用冻结的 scope 权重。重复次数不改变任务权重，不同 scope 的局部分数不能直接全局排名。某原始指标只有 dataset 总值、缺少逐任务证据，或聚合方法不支持这条 staged 路径时，仍完整保存，但将其选为该路径的目标须在 admission 拒绝。

usage 的总账与目标统计分别保留。例如 `api_cost_usd` 在上述目标范围表示每任务平均消耗，报告中的整个评测总费用另存并明确命名；不能把 total 当 mean，或仅因为多跑了几个重复就声称同一目标变差。

### 4.3 缺失与显式约束

非零权重项或约束所需指标缺失/无效时，目标证据不完整；不能填零、删项、删任务、重分权重或换目标。未选中、零权重且不用于约束的指标缺失，不阻止其他指标的合法计算，仍保留其状态；这不绕过原 evidence envelope 的认证边界。

加权和本身允许指标间取舍。用户可在 `objective.constraints` 中显式声明最低值、不可回退或回退容差；没有声明的原始指标不形成隐藏的质量门。约束独立报告，失败时保留真实目标分但阻止晋级，不能偷偷改分。

例如需要质量保持时，可在启动请求的 objective 中加入：

```json
{
  "constraints": [
    {"metric": "pass_rate", "rule": "no_regression", "reference": "initial_baseline", "tolerance": 0},
    {"metric": "process_score", "rule": "no_regression", "reference": "initial_baseline", "tolerance": 0}
  ]
}
```

约束绑定原指标的方向、单位、聚合及比较范围；容差必须有限且非负。`initial_baseline` 是本 evolution 初始 harness 在对应 partition 的冻结基线，由原有 baseline 流程评测后封存，在候选 gate 前就绪，不随 champion 更新。规则在 admission 确定，held-out 值不暴露给 Meta。`must-pass` 仍绑定 benchmark 通过谓词，不能改成“综合分满分”。无法明确迁移的旧约束须在新 admission 报错。

## 5. SoL-Pi 接入方式

SoL-Pi 式优化使用同一组原始指标与加权合同。例如保留质量分的同时，为费用和 token 设置负权重：

```json
{
  "objective": {
    "terms": [
      {"metric": "pass_rate", "weight": 0.5},
      {"metric": "process_score", "weight": 0.5},
      {"metric": "api_cost_usd", "weight": -0.1, "scale": 1},
      {"metric": "total_tokens", "weight": -0.1, "scale": 100000}
    ]
  }
}
```

对应 `S = 0.5P + 0.5Q − 0.1 × cost_usd / 1 − 0.1 × tokens / 100000`。假设 P、Q 的原范围都是 0–1，`P=0.8`、`Q=0.9`、平均费用为 1 美元、平均 token 为 100000，则 `S=0.65`；保持质量且消耗均减半，`S=0.75`。这是用户可配置的 Gear 示例，不是 SoL-Pi 官方评分公式或默认权重。

费用和 token 是不同但相关的指标，用户可以只选其中一项，也可以加入耗时、请求数。选择哪些项与如何权衡由 objective 决定；benchmark 无 process score 时可直接组合通过率和实际可用的效率指标，不虚构 partial。

若用户要求质量不回退，再显式加入上一节的约束。加权和不天然保证质量，也不默认强制所有 SoL 场景使用同一质量门。Action Fusion、ObservationPack、EPR、OCC 是改进这些原始指标的候选手段，安装或触发它们本身不加分。

效率指标须满足：

- 覆盖声明范围内的主模型、辅助模型、reducer、compaction、子 Agent 与内部重试；reasoning 已包含在输出时不重复相加。
- 真实费用与 API 等价估算分别标识；provider/model、价格快照、缓存读写桶、时间边界和提取器版本可追溯。
- runtime/evaluator 将原始计量写入不可变 trial artifact，绑定 run/attempt；已产生的 usage 即使未参与 objective 也保留。
- 缺失 usage 不能当零消耗；基础设施重试与评测重跑的费用归属须预先声明，不能挑最便宜的一次。
- Target 结束后才齐备的 usage 由独立派生评分阶段读取；原 task verifier 不需要读取 Gear 控制状态。

## 6. 结果表示与封存

原始指标记录与独立 `objective_score` 证据分开，结构见[结果规范第 7.4 节](hitch-evaluation-source-and-evidence-contract-spec.zh-CN.md)。目标解析结构为：

```ts
interface ResolvedObjective {
  schemaVersion: 1
  direction: 'maximize'
  terms: Array<{
    metric: string
    weight: number
    scale: number // explicit after resolution; default 1
    metricContractDigest: string
  }>
  constraints: ResolvedMetricConstraint[]
  scorerVersion: string
  comparisonPrecision: number
  digest: string
}
```

`ResolvedMetricConstraint` 表示第 4.3 节规则解析后的指标合同、方向、范围与冻结引用。目标摘要覆盖规范化的配置、指标合同、比较精度和 scorer 版本；任务/重复/运行条件摘要另在评分证据中绑定。零权重项可以保留在解析结果中，但不增加输入依赖，也不能导致原始记录丢失。

每条派生评分保留目标定义/摘要、原始结果引用、task/trial/scope 身份、每项原始汇总值、scale、weight、贡献、最终分与约束结果。保留所有原始指标的职责由 raw 结果层承担，不限制为派生证据引用到的这些项。

`reward`、`total_score`、`process_score` 和 `ProcessComponentV1` 的 passed/failed/excluded 与原权重保持原义。连续 usage 不塞进 assertion component；本功能不要求 total-only benchmark 增加 process 通道，也不要求将原 process schema 升级成连续评分 V2。

新 evolution 将解析后的 objective 封存，包括省略参数时的默认目标。改变权重或 scale 可以用兼容、完整的原始证据生成新目标的派生评分，无需修改 benchmark 或仅为重算而重新 rollout；不能沿用旧目标的排名、前沿或晋级决定。要按新目标继续搜索，创建新 evolution。

`continue`、恢复、补评保持原目标与已封存决定。旧 spec 没有 objective 时维持其历史算法，不按新默认值重新解释。未实现本扩展的消费者必须拒绝新 objective 请求，不能悄悄丢掉某项或退回旧目标。

## 7. 搜索全链路与实现落点

| 环节 | 新目标合同下的行为 |
| --- | --- |
| baseline 与评测 | 完整保留原始指标及 usage；按冻结 objective 派生目标分 |
| 诊断与 Meta | 传递公式、单位、seed 原始指标、每项贡献与显式约束；分析已成功但昂贵的任务 |
| local/frontier/parent selection | 以相同公式的逐任务目标分维护前沿及父代选择；不暗用另一个原始通道决定偏好 |
| bridge/global-seed | 在共同评测范围按相同目标比较；保持预算、完整性和提名规则 |
| 晋级与 held-out | 检查目标分增益/回退限额及显式约束；原始 outcome/process 不形成未声明的 OR 接受分支 |
| 状态与历史 | 同时展示目标公式、全部原始指标、贡献及约束结果，保持 seed/held-out 访问隔离 |

global-seed 默认要求目标改善超过封存的最小增益，中性接受需显式配置；held-out 按封存的目标回退限额验收。所有 gate 采用同一方向与目标分精度，并列时使用确定性身份排序，不暗加 process tie-break。既有父代范围、证据核验、自动 champion 更新与显式 publish 的边界保持不变。

| 修改面 | 当前入口 |
| --- | --- |
| 原始指标合同、完整导入与持久化 | benchmark adapter、`src/evaluator/hitch-cli.ts`、`src/search/dataset-projection.ts`、runtime usage artifact |
| inline objective 参数与解析 | `src/skill/gateway.ts`、`src/refine/service.ts`、相关协议类型 |
| spec、目标身份与恢复 | `src/types.ts`、`src/state/`、`src/skill/control-plane.ts` |
| 通用加权投影与证据 | `src/search/types.ts`、`schema.json`、`contracts.ts`、`evidence.ts`、`evaluation-adapter.ts` |
| 目标感知诊断 | `src/search/diagnosis.ts`、`evaluation-adapter.ts`、`src/meta/skill.ts` |
| 排序、前沿与 gate | `src/search/archive.ts`、`promotion.ts`、`engine.ts` 及非 staged 决策路径 |
| 用户协议与展示 | 实现后的 Refine Skill、协议文档、状态与用户指南 |

当前 staged GEPA 不使用全部旧 Judge/PromotionPolicy 插件，只改 `primaryMetric` 或一个旧组件不构成交付。gateway 必须显式解析并回显 objective，不能接受请求后静默忽略。未支持目标依赖或聚合方式的执行路径在 admission 拒绝。

## 8. 验收用例

| 场景 | 预期 |
| --- | --- |
| 默认只优化通过率 | 封存 pass_rate 权重 1；已有 process、其他分数与 usage 全部保留 |
| 0.5 pass_rate + 0.5 process_score | P=0.8、Q=0.6 时目标为 0.7，原两项不变 |
| A: P=0.8/Q=0.4；B: P=0.7/Q=0.8 | 通过率排 A；等权目标为 0.6/0.75，排 B |
| 对同一原始结果换成 0.8P+0.2Q | 不修改 benchmark 或丢失任何原指标；独立重算目标，不复用旧排名 |
| benchmark 已有加权 partial 及组件 | 完整保留其值、内部权重和组件证据；Refine 只组合已选指标 |
| 新增已声明的 benchmark 自定义指标 | 无需注册命名评分方案，直接在 objective terms 中选择 |
| 只有 total_score=0.6，无通过合同 | 不猜通过率；依赖通过率的目标拒绝，其他完整目标可用 |
| Q 原范围 0–100，Q=60 且 scale=100 | .5P+.5(Q/100) 在 P=.8 时为 .7；raw Q 仍为 60 |
| SoL 示例质量不变、费用与 token 减半 | 目标从 0.65 升至 0.75，原计量及单位分别保留 |
| 负权重、权重和不为 1 或目标为负 | 依声明原样计算，不归一化或截断 |
| 非有限权重、全零、重复项、scale 非正/非有限 | admission 拒绝 |
| 非零权重项或约束指标缺失 | 证据不完整，不填零、删项或重分权重 |
| 未用指标缺失且 envelope 允许独立认证 | 保存缺失状态，不阻止当前目标；未用但可用的指标也完整保存 |
| 目标上升但显式质量约束失败 | 分数及约束结果均保留，不晋级 |
| 原始指标只提供总值或不兼容 staged 聚合 | 保留原始值；拒绝将其用于不支持的路径，不伪造逐任务数据 |
| 换目标后原始证据完整且兼容 | 可重新评分而不重新 rollout；新搜索创建新 evolution |
| continue/resume 或旧 sealed evolution | 目标与历史决定不变；无 objective 的旧实验不被新默认重解释 |
| 仅启用 SoL-Pi 机制，实测指标未变 | 不额外加分或晋级 |

实现与回归测试覆盖原始证据、加权评分、分阶段选择、显式约束、恢复与 Skill 协议。效率指标依赖 benchmark/runtime 实际提供的计量合同与原始 artifact；本次验证使用确定性测试数据，不代表真实 benchmark 优化收益。

# 原始指标与 Refine 加权目标

Refine 保存 benchmark 原始结果，按用户权重计算独立的 `objective_score`。
当前支持 `failure-cluster-gepa-v1` 执行路径。新建请求若使用旧执行路径会明确拒绝；
已有 evolution 的继续与恢复维持封存的历史行为。

通过 `control.start`（也可使用 `gear-refine request`）传入：

```json
{"objective":{"terms":[{"metric":"pass_rate","weight":0.5},{"metric":"process_score","weight":0.5}]}}
```

公式为 `Σ weight × (原始指标 / scale)`。scale 默认 1，必须为正；权重允许负数，
不要求和为 1，目标分不截断。原 process 范围为 0–100 时，可设置 `scale:100` 与
0–1 的通过率组合。对已声明的 token 指标，可加入
`{"metric":"total_tokens","weight":-0.1,"scale":100000}`。原始数值和单位继续保留。
这是可配置的质量/效率目标，不是 SoL-Pi 官方评分公式。

省略 objective 默认严格通过率。dataset 必须显式声明通过谓词，正 reward 和数值范围
均不表示成功。未声明约束时，权重允许质量与效率交换。需要保留初始质量时，在
`objective.constraints` 中加入：

```json
{"metric":"pass_rate","rule":"no_regression","reference":"initial_baseline","tolerance":0}
```

引用是同一 partition 下的初始 harness，不随 champion 更新。约束失败会保留真实目标分，
同时阻止晋级。搜索设置中的 `promotion.objective` 可配置 `minimumGain`、
`maxSeedRegression`、`maxHeldOutRegression`，均默认 0。global-seed 改善必须超过
最小增益；只有显式 `allowNeutral` 才允许中性接受。

## Dataset 指标合同

在 `benchmark.adapter.json` 中添加版本化 registry。若 benchmark 的真实通过谓词是
`total_score == 1`，声明示例如下；不能对其他 benchmark 无条件照搬。

```json
{
  "raw_metrics": {
    "schema_version": "1",
    "metrics": [{
      "id": "pass_rate", "revision": "1", "unit": "ratio", "direction": "maximize",
      "source": {"path": "scores.totalScore", "extractor": "equals-v1", "equals": 1},
      "range": {"min": 0, "max": 1}, "granularity": "trial",
      "repetitionReducer": "mean", "taskReducer": "weighted-mean", "comparisonPrecision": 1e-9
    }]
  }
}
```

`boolean-v1` 读取明确布尔值，`number-v1` 保存有限数值。source path 可以指向
`scores`、`rewards`、完整导入的 `originalResult` trial 行或导入的 `verifier`
原件（如 `verifier.result.rewards.quality`）。adapter 保存成功和失败 run 的 verifier
原件，并核对 run、trial/attempt 绑定。选择此来源需要 verifier evidence 能力；
缺失或损坏的原件不能提供可用指标。标准 total/process
通道从原 manifest 的 scoring 声明注册；total-only dataset 不会凭空增加 process。
自定义指标使用同一 registry，用户可直接选择其 ID，不需要命名 scoring profile。

usage 指标还需要 `measurement` 合同，说明计量类型（`actual`、`api-equivalent`、
`counter` 或 `wall-clock`）、范围、provider/model、费用价格快照、token 口径、时间
边界与重试费用归属。runtime 必须实际提供声明的来源；Gear 不按指标名称猜费用，
不把缺失 usage 当零。未参与目标的原始字段也在完整来源中保留。

所有非零项和约束必须支持共同的逐 trial 范围。先在 task 内对冻结重复槽位取均值，
再按冻结任务权重聚合；global/held-out 使用任务宏平均，重复次数不改变任务权重。
`observationTotal` 单独表示实际观测总账，目标使用宏平均 `value`。只有 dataset 总量
而没有逐任务证据的指标不能用于 staged 前沿。

## 证据与重新评分

启动返回封存的 `resolvedObjective`。seed 状态和 Meta assignment 中可查看
`rawMetrics`、各项贡献与独立 `objectiveScore`。逐 trial 的 `passStatus` 按声明的谓词
标记为 `passed`、`failed` 或 `unavailable`。私有原始 artifact 保持原访问边界，
held-out 证据不进入研究 archive 或 Meta baseline。选中项缺失/无效会阻止评分，
原 envelope 无效时，不能从其内嵌数字中抢救结果。

`experiments.tsv` 提供 `seed_raw_metrics` 与 `seed_objective` JSON 列。目标列标明
local 或 seed-evaluation 范围，并保留公式、分数、贡献和约束结果。局部候选只能在
相同范围内比较；held-out 决定保存在私有 round 记录中。

公开 API `resolveObjective`、`aggregateRawMetrics`、`scoreObjective` 可直接从兼容
原始证据重算目标，不执行任务。改变权重不会改变原执行槽位身份，会产生新的目标与
评分证据身份。按新目标继续搜索需要新 evolution；continue/resume 不接收目标替换，
也不能复用旧目标的排名和晋级决定。

例如，使用已保存的 seed profile 及其 universe：

```ts
import { resolveObjective, scoreObjective } from 'rsi-gear'

const objective = resolveObjective({ terms: [
  { metric: 'pass_rate', weight: 0.8 },
  { metric: 'process_score', weight: 0.2 },
] }, universe.rawMetricContracts)
const rescored = scoreObjective(objective, profile.rawMetrics, profile.objectiveScore.scopeDigest)
```

这会创建新的派生证据，不修改原 profile，也不执行 rollout。若目标包含
`no_regression`，第四个参数还须传入已封存、范围匹配的初始基线。

另见[完整规范](refine-objective-spec.zh-CN.md)与
[Skill 协议](../skills/refine/references/protocol.md)。

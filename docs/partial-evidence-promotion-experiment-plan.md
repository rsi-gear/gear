# 部分评测证据继续进化与 Promotion 实验方案

- 状态：Implemented and verified
- 日期：2026-08-27
- 目标：少量 rollout 基础设施异常不得阻断 candidate generation、selection 或 promotion

## 1. 实验假设

2026-09-12 兼容说明：本文的有效交集晋升仅适用于原策略。新建 evolution 显式采用 `failure-cluster-gepa-v1` 时，按[专长 archive 规范](candidate-promotion-and-specialist-archive-spec.zh-CN.md)要求局部 scope 完整才获得该范围资格、全局计划完整才发布；较大阶段缺证据不撤销已取得的局部资格。旧 verdict 不回溯改写。

当前实现把“评测命令成功结束但包含 invalid observations”当成整个 evaluation 失败。这样可以避免把基础设施异常错误地计为零分，但也会让已经完成的有效 rollout 无法进入 candidate generation。

本实验验证以下替代策略：

> invalid observation 是缺失证据，不是零分，也不是整轮失败。只要 baseline 和 candidate 仍有至少一个共同有效的 rollout cell，就在有效配对交集上继续 selection 和 promotion；未配对 cell 只进入审计记录。

## 2. 非目标

本轮不引入：

- `minPairedSeedFraction`；
- `minPairedHeldOutFraction`；
- 根据覆盖率自动调节 promotion threshold；
- 把 invalid observation 静默转换成 reward 0；
- 在 Gear 内实现 Hitch 的 task-level retry scheduler。

Hitch 或 Harbor 已执行的 attempts/retries 会按最终 observation 进入 Gear。未来可以加入定向 retry，但 retry 最终仍失败时，不改变本文的“有效交集继续”规则。

## 3. 证据模型

一次 evaluation 同时保存：

```text
planned trials
├── valid trials   → 有 reward，可参与比较
└── invalid trials → 有 run identity 和失败原因，不参与分数
```

`EvaluationEvidence` 增加：

```ts
completeness: 'complete' | 'partial'
plannedTrialCount: number
invalidTrials: InvalidEvaluationTrialSummary[]
```

约束：

```text
plannedTrialCount == valid trials + invalid trials
complete  <=> invalid trials == 0
partial   <=> invalid trials > 0
summary 和 primaryReward 只聚合 valid trials
```

如果没有任何 valid trial，`summary.total=0`；证据仍可保存和展示，但不能产生 paired comparison。

## 4. Rollout cell 身份与配对

当前 Hitch adapter 支持的 cell key 为：

```text
taskName + attempt
```

当 typed seed/repetition identity 进入 Hitch public result 后，cell key 再扩展为：

```text
taskName + seed + repetition
```

Baseline 和 candidate 必须满足：

- condition id 相同；
- provider 和 effective config digest 相同；
- dataset 相同；
- planned cell key 集合相同。

身份不一致属于实验协议错误，仍然 fail closed。

有效配对定义为：

```text
paired = baseline.valid ∩ candidate.valid
```

以下情况不进入 paired：

- baseline invalid、candidate valid；
- baseline valid、candidate invalid；
- 双方都 invalid。

## 5. Candidate generation

Baseline evaluation 即使是 `partial`，也立即固化到 round，并交给 Meta Agent：

- valid trials 提供 reward 和 trajectory；
- invalid trials 提供 run id、status 和 invalid reason；
- Meta 可以在 trajectory 可读时诊断 invalid rollout，但诊断是 best-effort；`trajectory_missing_or_corrupt` 等不可读异常不能成为 finalization 的前置条件；
- invalid 不进入 baseline score。

Candidate generation 不再以“所有 baseline cells 有效”为前置条件。即使 baseline 没有 valid trial，也可以生成 candidate；但之后若没有任何有效配对，该 candidate 不能被 promotion。

## 6. Selection

每个 candidate 的 seed comparison 只基于它与 parent baseline 的有效交集：

```text
candidate paired score = mean(candidate reward over paired cells)
baseline paired score  = mean(baseline reward over paired cells)
score delta            = candidate paired score - baseline paired score
```

Candidate metrics 和默认质量排序使用 paired candidate projection，而不是 candidate 自己全部 valid trials 的非配对 aggregate，避免不同 candidate 因有效子集不同而不可比。

Selection component 收到的 `seedEvaluation` 也是 paired projection，不会看到仅 candidate 单侧有效的 cell。需要跨 candidate 比较的 LLM verifier 进一步只使用所有候选共同可用的 paired support；共同 support 为空时不能声称完成了公平比较。

如果某 candidate 的 paired set 为空，它不进入 selection。其他 candidate 仍可继续。

## 7. Held-out 与 Promotion

Held-out evaluation 遵循相同规则：

```text
held-out paired = held-out baseline.valid ∩ held-out candidate.valid
```

Promotion policy 的所有输入改为 paired aggregates：

- `minimumCandidateScore`：candidate 在 seed paired cells 上的均值；
- `minimumAbsoluteGain`：seed paired delta；
- `maxHeldOutRegression`：held-out paired delta；
- `requireNoRegression`：paired cells 上的 passed count；
- `requiredTaskIds`：仍要求对应 task 有有效配对，否则不能证明约束成立。

`requiredTaskIds` 必须直接从 `PairedTrial[]` 按 task 聚合。不能分别从 baseline/candidate 的全部 valid repetitions 聚合，否则双方在不同 repetition 上各自 valid、但实际没有共同 cell 时会产生虚假证据。

只要 seed 和 held-out 都至少有一个有效配对，未配对 cell 不阻塞 promotion。系统同时记录：

```text
planned cells
paired cells
excluded cells
baseline invalid count
candidate invalid count
```

这些是审计数据，不是可配置门槛。

如果 held-out paired set 为空，系统直接形成 rejected decision，不把空 evidence 交给 Judge，避免 Judge 对空集合报错后把预期拒绝升级成整轮失败。

空 paired set 的拒绝优先于 `requiredTaskIds` 检查：即使配置了 protected tasks，seed/held-out 全空也应产生可审计的正常 rejection，而不是因为“required task 缺失”把 round 升级成运行失败。

## 8. 仍然必须终止的情况

以下问题不能通过排除 cell 绕过：

- baseline/candidate condition 或 invocation identity 不一致；
- exact commit、transport 或 dataset identity 不一致；
- Hitch result schema/JSON 损坏，无法证明 run membership；
- planned cell key 集合不一致；
- seed 或 held-out 的有效 paired set 为空；
- 显式 required task 没有有效配对；
- candidate artifact/commit 无法验证。

## 9. 实验观测字段

Round 和 candidate comparison 持久化：

```ts
interface PairingAudit {
  planned: number
  paired: number
  excluded: number
  baselineInvalid: number
  candidateInvalid: number
}
```

Promotion record 必须能够回答：

1. 原计划运行多少 cells；
2. 哪些 cells 真正参与比较；
3. 哪些 cells 被排除以及原因；
4. 决策使用的 paired reward 和 delta；
5. baseline/candidate 的 exact commit 和 condition identity。

状态重载时不能只相信上述计数。Store 必须从原始 baseline/candidate evidence 重建 expected pairs，并核对 condition/provider/config/invocation/dataset parity、cell key、run id、reward、delta、planned identity、required-task regression 和 pairing audit；手工篡改或不完整写入的 pair 不能通过 continue 校验。

## 10. 验证矩阵

| 场景 | 预期行为 |
| --- | --- |
| baseline complete，candidate complete | 与现有行为一致 |
| baseline partial，仍有 valid trials | 继续生成和评测 candidate |
| candidate partial，仍有 paired trials | 进入 selection |
| held-out 任一侧 partial，仍有 paired trials | 继续 promotion decision |
| seed paired set 为空 | candidate 不可选择；其他 candidate 可继续 |
| held-out paired set 为空 | 不 promotion，round rejected/no-change |
| invalid trial 只有单侧出现 | 排除该 cell，不计零分 |
| candidate 正常 reward 0 | 保留为有效配对和有效失败 |
| planned identity 集合不同 | round failed |
| required task 缺失有效配对 | promotion 不通过 |

## 11. 成功标准

实现完成后必须证明：

1. Hitch 的 invalid observation 返回 partial evidence，而不是抛弃整个 eval；
2. baseline partial 不阻断 Meta/candidate generation；
3. seed 与 held-out 决策全部使用 paired valid intersection；
4. invalid observations 不被计为零分；
5. retry 最终仍失败的 cell 可以被排除，且 promotion 仍可发生；
6. 零 paired evidence 或 identity mismatch 仍然 fail closed；
7. state reload、continue 和审计投影保留完整 partial/paired 信息。

## 12. 实现验证

截至 2026-08-27：

- 类型检查通过；
- 全套测试：21 个测试文件，127 项通过，2 项按原设定跳过；
- composition 端到端测试通过；
- production build 与 npm package dry-run 通过；
- 独立 sub-agent 两轮 review 的问题均已修复并回归验证。

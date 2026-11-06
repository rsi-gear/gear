# 搜索评测不完整时的恢复边界

`failure-cluster-gepa-v1` 的 bootstrap、scope preparation、parent baseline、local、bridge、global seed、held-out 和 objective initial reference 都在结果进入冻结决策前检查完整性。所有原计划中的 outcome slots 必须有效，参与目标函数与约束的原始指标必须完整。0 是有效观测，不能重跑或从分母移除。未选用的过程通道不因此成为发布要求。

## 自动补齐设置

`search.evaluationStages.repair` 可省略；运行时使用如下默认值，旧配置无需增加字段：

```json
{
  "maxAttempts": 3,
  "backoffMs": [15000, 60000, 180000],
  "jitterMs": 1000
}
```

`maxAttempts` 是每个原始 stage participant 在首次评测之外的补齐尝试上限；0 保留纯人工修复模式。每次尝试前使用对应 delay，超过数组长度时沿用最后一项；附加 jitter 在 0 到配置上限之间，由原证据引用和次数稳定派生。配置中的数值必须是非负安全整数，delay 数组不能为空。测试 fixture 使用 0 delay，不改变正式运行默认值。

只补跑已经结算的 missing/invalid outcome slots，保留每个有效 outcome，包括数值 0。当前没有可靠的 transient 错误分类，因此自动尝试也可能遇到确定性的无效输出；不会根据供应商错误文字猜测。配置、有效评分规则、候选、任务及统计分母都不变。

自动补齐记录保存原 `StageResult` ref、每次 `repairId`、次数、scheduledAt、notBefore 和结果引用。重启不重置上限、等待时间、round/evolution 时间与用量预算。额外执行同时受 `maxNewRolloutCells` 和 `maxRepairCells` 限制。取消中断等待与新执行；已发出的任务按原操作恢复。

## 外部操作和投影

已有评测保留原幂等键。支持 inspection 的 provider 在重启后先只读查询；running/unknown 不创建第二个任务，也不消耗新的自动尝试。只有确认 not-started 或所有余下批次未启动时才继续同一操作。无 inspection 的自定义 provider 继续承担原同键幂等恢复合同。截止后只读结算原操作；已完成的完整证据仍可用于原决策。

有效 outcome 缺少原始指标、过程分或保护断言时，只能从同一原执行产物补投影。可复用已有缓存；provider 可显式实现 `completeEvidence` / `inspectEvidence`，旧的 `completeProcess` / `inspectProcess` 只补过程通道。补投影不能覆盖任何已有有效 outcome、原始指标、process 或已有断言。缺少 provider 能力或声明为 unsupported 的永久投影缺口直接进入待补状态，不反复执行 Target。当前内置 evaluator adapter 未实现该投影能力；冻结原始产物不足时需要修复产物/provider 或开启新的实验，不能靠重跑有效 outcome 填补。

这里增加的是 Gear 阶段补齐，不修改 Hitch 内部 `max_retries`、重试策略或 Codex 请求重试层。Hitch 的 `attempts` 是原评测 repetition 计划，并非这里的修复次数；Gear 不增加新的 Hitch `max_retries` 配置字段。Hitch 内部重试若存在，会在同一个 Gear 操作内执行；Gear 仅在该操作已结算为不足证据后应用自己的有界补齐。

## 操作员状态与限制

自动补齐耗尽、永久投影缺口或评测预算耗尽后，本轮保存 `searchPendingEvidence.state = infrastructure-incomplete`、原始 `resultRefs`、当前结果、缺少的 task/repetition/channel 和尝试记录。服务因待补证据退出 active drive 时仍使用已有 `failed` 状态，但不写 search terminal、拒绝/晋升决定或 champion 变更。不完整结果不会进入 local decision、nomination、research archive 或 commit；已完整的早期冻结产物继续保留。held-out 明细只在已有的私有操作员字段中暴露，不进入 seed/Meta 状态。

调用 `control.search-repair` 时，把 `evidenceDigest` 指向 `searchPendingEvidence.resultRefs` 中的原始结果，使用新的人工 `repairId`；尚未完成的人工操作必须继续原 ID。已由自动操作占有的未决修复先用 `control.search-resume` 恢复原轮。成功修复后服务继续原 round。仅恢复原完整评测但没有剩余生成预算时，原搜索仍可完成为没有候选的正常结果。

预算身份不可更改。自动上限耗尽而预算尚有余额时可以人工补齐；round/evolution 用量或时间已耗尽时，resume 不会恢复额度，也不能启动新的 repair 执行。需要额外预算时建立新的 evolution，并保留旧轮作为基础设施不完整证据。旧轮未解决时不能在同一 evolution 开另一轮。

实现代码与 schema 参与算法 integrity。升级前尚在运行的旧 evolution 不能在改变算法身份后继续；需要使用原版本恢复或建立新 evolution。已有 terminal 结果保持不可变，不解封、不重算历史得分，也不修改已有实验数据。

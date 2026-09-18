# 候选生成预算与诊断重试：核查及修复记录

日期：2026-09-07。基线：fetch 后的 `origin/dev`，提交 `6755f17fcfeb15c278f952646475f32c1e4ed68a`。

创建 PR 时已对齐最新 `origin/dev`（`212bf85`，包含 PR #11 的 baseline 复用修复）；保留双方导入后复测共同涉及的控制面和状态逻辑。

对齐后，refine service、诊断恢复、state store、evolution state、dataset identity 五组共 126 项测试通过；类型检查和生产编译再次通过。

分支：`codex/candidate-budget-diagnosis`。
Worktree：`/private/tmp/gear-candidate-budget-diagnosis-20260907`。

## 核查结论

跨尝试重试丢失诊断进度的问题存在。原实现重新创建工作区、从原父会话分叉，并清空 session 内的诊断回执。即使候选和 baseline 相同、客户端 ID 不变，40/56 的完成度也会重置为 0/56。

同一次尝试内的 Skill lease 重连和原生 DSH context handoff 与此不同：它们可保留诊断进度，但不会重置 attempt deadline。该时间约束应继续保留。

候选工作区准备、等待领取、诊断、编辑、校验和封存共用 attempt 时限。前面的 baseline 评测和 root checkpoint 不计入。若 56 个失败共用 30 分钟，尚未扣除其他工作时每例仅约 32 秒；若预留 10 分钟处理其他工作，则仅约 21 秒。这是预算算术，不是实验实测吞吐率。

本机没有用户引用的 `/Users/tangyehui/gear/.evolve-lab/marketing-all-20260905/codex-reuse-baseline` 目录。因此确认了代码机制，但没有对那次实验的 30 分钟 / 2 次 / 60 分钟配置和日志作独立归因。

## 已实现的修复

### 1. 候选诊断持久化

`src/state/candidate-diagnosis.ts` 保存不可变诊断记录，归属由以下字段共同决定：

```text
evolutionId + specDigest + roundId + candidateId
+ parentHarnessDigest + baselineDigest
```

baselineDigest 覆盖完整 baseline，包括 provider、evalId、实际 run/attempt 和评测内容。每条记录保存有效读取产生的回执、轨迹/验证器内容摘要、清洗后的诊断卡及必读 verifier 详情、来源 session 和 attempt。

记录按内容寻址，临时文件写入并同步后原子重命名；目录同步后完成。重复提交同一记录不会增加记录数。写入前后核对当前执行权，取消时等待在途写入结束后再启动下一次尝试。旧会话不能借迟到调用增加新尝试进度。

正常诊断卡逐条持久化；必须读取的 verifier 详情只有完整翻页后才产生完成记录。批量查询中已准备好的证据即使没有成功送达客户端，也可在后续恢复时连同摘要重新提供；当前会话仅在成功返回整个查询时获得相应访问回执。

### 2. 重试恢复与证据校验

新 attempt 的 assignment 明确提示工作区为 fresh，并要求先查询当前 baseline。

`trajectory.query` 无参数时加载当前候选账本，重新核验轨迹和 verifier 内容，再返回有界的 `diagnosisRecovery.restored` 摘要和当前 session 的新 detailRef。已发送摘要对应的有效回执恢复到 Meta audit；之后只需读取 `diagnosisProgress.remainingRunIds` 中的失败。

这条路径由 capability 层实现，Skill Meta 和原生 DSH 共用。DSH notebook 的文本渲染同时保留恢复摘要与预算，避免结构化响应有信息而模型看到的文本丢失信息。

恢复摘要包含任务、结果、prompt 摘要、verifier 摘要、轨迹末尾、来源 attempt 和完整归档证据引用。旧 session 的临时 detailRef 不会被直接复制。超过响应容量时，`diagnosisRecovery.remaining` 提示继续无参数查询。

以下情况不复用：baseline 或 parent 改变；不同 sibling、round、evolution；轨迹或 verifier 内容改变；清洗策略改变；必读详情尚未读完；回执无效；记录完整性校验失败。仅有 run ID 或分析文字不会变成有效诊断回执。

### 3. 时间预算可见性与预留

所有 adapter 都持久化 round deadline、attempt deadline、准备完成和 proposal 完成时间。Skill claim、DSH wake、候选状态和诊断返回值提供当前预算信息；重连刷新剩余时间但不改变截止时间。

新增可选配置 `candidateGeneration.finalizationReserveMs`，用于为编辑、校验和封存预留建议时间。它必须是 0 到 attemptTimeoutMs 之间的整数，并写入不可变 evolution spec。省略时采用 attempt 时限的 20%，最多五分钟；该预留仅用于规划，不额外增加时限，也不阻止合法诊断读取。

诊断回复根据当前 attempt 已完成读取的耗时估算剩余诊断时间；没有观测时返回 null。剩余时间已触及预留，或估算诊断时间超过可用额度时，返回 `DIAGNOSIS_BUDGET_AT_RISK`。

实际 deadline 仍是 attempt 与 round 上限中更早的一个。恢复后的超时归因也依据绝对 deadline，避免把先耗尽的 attempt 误报为 round 超时。新的 attempt 可以获得新 attempt 额度，但不能重置 round deadline。

旧 evolution 继续使用封存预算。实际增加时间上限需要使用新配置创建新 evolution，不能仅修改启动配置再 continue 旧 evolution。

## 验证

完整模拟超时路径已验证：

| 步骤 | 已诊断 | 剩余 |
| --- | ---: | ---: |
| attempt 1 读取前 40 个失败 | 40 | 16 |
| 同一 lease 重新 claim | 40 | 16 |
| 触发实际超时回调，进入 attempt 2，再查询 baseline | 40 | 16 |
| 只补读其余 16 个 | 56 | 0 |

测试使用真实 RefineService、Skill Meta、工作区管理和 capability 逻辑，以及合成 evaluator/trajectory reader。恢复时重新创建 capability 实例，验证数据来自磁盘。40 个恢复项执行了内容核验，但没有要求模型重新读取 40 份完整诊断卡；随后提交通过原有诊断门槛。

主要测试：

- `tests/unit/refine-service.spec.ts`：完整 56 个失败场景；已有超时重试、同 attempt 会话交接、冷恢复和 sibling 隔离。
- `tests/unit/candidate-diagnosis.spec.ts`：证据/归属/策略失效、分页完成门槛、脱敏、新旧 detailRef、响应丢失、取消期间写入、去重、完整性校验、预算警告。
- `tests/unit/evolution-state.spec.ts`：预留配置合法性、封存身份及旧配置兼容。
- `tests/e2e/refine-skill.e2e.spec.ts`：Codex、Claude Code、DSH Skill harness 的领取、修改、诊断、提交、评测和晋升流程。

验证结果：413 项单元测试通过，9 项既有条件测试跳过；另有 4 项组合/端到端测试通过。类型检查、完整构建及 diff 空白检查通过。

全量单元测试首次执行时，406 项通过，两个套件因新 worktree 缺少生成的 ToolFs 文件未加载，一个本地 socket 测试受沙箱监听限制失败。完成构建后，受影响套件及最新变更相关套件复测共 106 项通过；socket 测试在允许监听的环境通过。上面的 413 为去重后的单元测试数量，不是把重复运行相加。

环境：Node 26.5.1，Vitest 4.1.11，临时复用主工作区 node_modules；固定版本 ToolFs 通过仓库构建脚本下载并校验。没有运行真实付费模型或原实验的 30 分钟耗时复现。

## 使用及范围

先领取 assignment，调用无参数 `trajectory.query` 接收恢复摘要，再处理 remainingRunIds。诊断工作量较大时，按准备时间、每例实际诊断耗时、编辑/校验时间和余量设置新 evolution 的 attempt/round 上限；多 candidate 的预算需合并规划。

本次恢复的是诊断证据与完成度。跨 attempt 的候选编辑仍从干净工作区开始；已保留的旧目录不自动作为新候选使用。任意时刻的控制器崩溃自动续跑、未完成 verifier 的跨尝试分页续读，以及经过验证的草稿 patch 恢复，属于后续独立能力；本次保持原有恢复边界。

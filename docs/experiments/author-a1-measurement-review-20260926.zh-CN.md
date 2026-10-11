# A1 可信评估汇总切片审计

结论：本切片可以单独提交；实际宿主接线和真实 Hitch 验收尚未完成。

`author.measurement` 只接受 subject、签名任务选择和生产操作 ID。宿主提供冻结评分合同，以及同一已验证 Campaign 快照中的已提交操作和物理 Hitch journal。实现核对操作身份、绑定、任务及重复槽位、保存的完整 EvaluationRequest、请求摘要、conditionId、实际提交身份、receipt 与 evidence；每个 evalId 和 runId 均不得复用。只有完整且有效的覆盖才产生可比较的 MeasurementRecord；缺失、业务失败或无效试验不补零。

主审要求并确认了两处补充：不同 attempt 不得复用同一 runId；不能只核对 requestDigest，必须读取保存的请求并验证其数据集和冻结条件。命名但未提交的 producer 被拒绝，以免同一纯操作 key 的结果随以后完成而变化。指标复用现有 RawMetricContract 提取与聚合语义，metric-schema 绑定具体合同摘要。

验证：实施者全仓类型检查与 7 项聚焦测试通过；主审独立运行 algorithm-author-measurement.spec.ts 和 algorithm-data-providers.spec.ts，2 文件 12 项通过。测试使用本地 CAS 与受控物理凭据，不声称执行了真实 Hitch 或模型请求。

剩余接线：实际宿主须提供只读的、校验 journal 链的 committed-operation resolver；新 Hitch v2 journal 须保存完整请求；ctx.evaluate 须从宿主生成的 replay history 获取 producer 操作 ID。当前仅支持精确 Harness 单槽绑定，Skill overlay 另行验收。

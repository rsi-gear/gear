# Retail V5：正式搜索中的无评分合同中止

**本次三组对照未完成，没有效果结论。** V5 冻结在 `c032ab44a`，使用固定 LLM 权重和 CPU retail 工具，不做 GPU 训练。221 次真实模型调用全部完成并保存回执，合计 **6,085,278 tokens**。fixed 组的候选训练轨迹均用尽 24 步、没有最终回复，源结果为 unknown；旧 provider 将它们转换成 `task_failed, score=null`，违反 Gear 对 `task_failed` 必须有数值评分的合同，进程以 1 退出。正式 journal 保留为 `needs_recovery`，没有重新提交模型调用。

这次沿用 [V4](../sentinel-retail-2026-11-20-v4/README.zh-CN.md) 的合成任务、模型、预算和三次固定生成尝试，修正基础指令与嵌套动作 schema；协议及完整运行身份保存在 [evidence.json](evidence.json)。solver／用户模拟使用 `gpt-6-luna low`，Meta 使用 `gpt-6-astra low`。fixed 先执行，随后中止，因此 random/failure 尚未生成数据，未完成任何组的选型，也未封存或执行最终模型测试。参考校准执行不属于模型测试。

| 阶段 | 原生调用 | tokens | 实际结果 |
| --- | ---: | ---: | --- |
| 两条源训练探针 | 62 | 1,538,487 | 1 条完整失败，1 条未知 |
| 原 harness 的 validation | 27 | 625,561 | 1 条完整失败 |
| 原 harness 的训练评估 | 40 | 1,022,766 | 2 条完整失败 |
| Meta 候选生成 | 1 | 19,078 | 1,617 字符，通过 1,800 字符约束 |
| 候选训练评估 | 91 | 2,879,386 | 2 条未知，评分投影被拒绝 |
| 合计 | 221 | 6,085,278 | 4 条完整失败、3 条未知；无最终测试 |

上述用量包括被正式 runtime 拒绝的候选执行，不把它们从成本中剔除。调用数是 SDK turn 数，HTTP 重试次数与美元费用未知。V4、服务连通检查、动作接口检查及后续结束协议检查分别核算，不计入此表。没有依据给出候选通过率、训练门槛结论或 failure 相对 controls 的收益。

## 离线复核

[verification.json](verification.json) 记录了五条人工参考及负例校准、七条源／正式任务记录的 CPU 重放、全部 221 份原生响应绑定、候选 manifest、Meta 训练范围、已接纳评分的 runtime metric 投影及成本复算。SDK 未导入，新模型调用数为 0。候选文本、Meta 输入和给未知轨迹补零分三种篡改均被拒绝。语义审核仍复用当时的模型判断，不能称为新的独立语义裁判。

`export.py` 在原进程终止后核对全部 pending/request/receipt 摘要和调用库存，再移除 SDK thread／turn 标识。[manifest.json](manifest.json) 绑定导出字节；摘要不是外部签名。`verify.py` 使用冻结源码重放实际 CPU 工具，核对正式记录，并识别旧状态转换违反评分合同的位置；它不重新启动原 Gear run。

```bash
/path/to/tau2-python research/sentinel-retail-2026-11-20-v5/verify.py \
  --repository /path/to/frozen-c032ab44a --tau2-source /path/to/pinned-tau2 \
  --negative-checks
```

## 单条记录工具

`records.py` 也可导出已写入 `result.json` 的采集或生成记录，包括正式 provider 共享存储中的 sample。步数耗尽的结果保持 `incomplete / passed=null`，尚无封存结果的运行前缀不能导出为完整记录。

```bash
/path/to/tau2-python records.py --repository /path/to/frozen-c032ab44a \
  capture --workspace /path/to/sealed-sample --output /path/to/archive

/path/to/tau2-python records.py --repository /path/to/frozen-c032ab44a \
  verify --archive /path/to/archive --tau2-source /path/to/pinned-tau2
```

采集记录可增加 `--negative-checks`，检查篡改原生回答、请求指令、工具返回、评分和 usage 后能否被拒绝。此选项需要样本实际执行过工具，且至少一次调用具有原生 usage。文件摘要用于检出归档变化，不提供外部签名认证。

复核源码必须与记录绑定的实现一致。主开发分支 `922b11277` 已将无评分轨迹转换为 `scoring_failed`，并保留未完成搜索的原 harness；`f5947efb5` 增加可选的真实最终回复阶段和独立生成模型设置，35 项 CPU／正式集成检查通过。它们不回写 V5，也不改变这次的未知结果。有效三组对照仍须独立完成。

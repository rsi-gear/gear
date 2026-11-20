# Retail 工具对照 V6：预注册配置

**正式实验已因 240 秒调用超时停止，尚无比较结论。本版固定模型权重，不做 GPU 训练。** V6 使用冻结源码 `f5947efb5`，是新的独立实现验证；已中止的 V4、V5 和单次生成检查保持原有结果，不重启或替换其请求。

V6 的原始进程退出码为 1。随后只读检查唯一未返回的原生 turn，确认其状态为 `interrupted`，没有完成回执、错误原因或 usage；本地日志为 `TimeoutError`，不能据此断言服务端 429。该请求未重提，原 formal journal 保留 `needs_recovery`。

中止时有 141 次逻辑提交、140 份完成回执、3,575,238 已知 native tokens；未完成请求的用量未知，全部尝试的总用量保持未知。两条初始训练采集、基线 validation 及两条原 harness 训练评估均完整结束并评分失败。Meta 提交的一条 1,640 字符候选通过长度约束，但候选训练仅保存 10 份回执和五步对话前缀，没有完整任务评分或训练门槛结果。尚未开始 random/failure 生成，也没有任何 arm 选型或最终测试。

| 阶段 | 完成调用 | 已知 native tokens |
| --- | ---: | ---: |
| 两条训练来源采集 | 62 | 1,680,082 |
| 基线 validation | 31 | 721,883 |
| 原 harness 训练评估 | 36 | 865,946 |
| Meta 提案 | 1 | 17,411 |
| 候选训练前缀 | 10 | 289,916 |

最后一次候选请求的用量另列未知；启动前 10,617 tokens 的可用性检查也单独核算，不计入上表。

五条完整任务记录、候选的五步未完成前缀、五道原始任务的参考／负例校准、固定池准入、三份正式操作回执、实际 Meta 输入与候选封存、运行时评分转换及完整调用账目均已离线核验。[核验结果](verification.json)通过，修改候选提示、Meta 输入、中断请求或补造任务得分的四项检查全部被拒绝。核验没有导入模型 SDK 或提交新请求。

[evidence.json](evidence.json) 保存上述证据，[manifest.json](manifest.json) 固定其 SHA-256 为 `360d27946a7bfb4b1889c7aa4d44f8eab399f97459f1e6bfd4f91ee33a65947d`。原始原生回执摘要、请求和 ID 对应关系在导出前核对，随后移除 SDK thread/turn ID；中断请求仍单独保留，不能生成完整任务分数或补填其 usage。

```sh
/path/to/sentinel-env/bin/python research/sentinel-retail-2026-11-20-v6/verify.py \
  --repository /path/to/gear-at-f5947efb5 \
  --tau2-source /path/to/pinned-tau2 --negative-checks
```

该归档证明中止前的实际行为与账目一致，不把不完整尝试当作有效对照。240 秒超时、原生 `interrupted` 与先前另一尝试的服务端 429 分开记录；延长等待也不保证后续运行完成。

[config.json](config.json) 和 [protocol.json](protocol.json) 在正式模型调用前冻结。配置摘要为 `sha256:8038bd39b27ac7d2bf13307b52a5c8b2bdc4f157c8c00f962e59364d636b2d99`。原任务、模型侧提示及分组来自 V5：2 条训练、1 条 validation、2 条不同 family 的最终测试；没有观察过这批最终测试的模型结果。预检已通过全部原生参考／负例校准及真实 Gear 准入，预检无模型请求。

| 设置 | 预先固定的规则 |
| --- | --- |
| solver / Meta | `gpt-6-luna low` / `gpt-6-astra low` |
| 生成模型 | random 与 failure 均为 `gpt-6-astra low` |
| 动作与结束 | 最多 16 个动作步骤，预算耗尽后允许一次真实结束回复；不补造完成或得分 |
| 调度 | seed 23，一轮；seed 仅控制调度，模型推理本身不保证固定随机种子 |
| 学习池 | fixed 为 2 条原始数据；random、failure 各为 1 条原始加 1 条已验证生成数据 |
| 生成机会 | random、failure 各恰好 3 次，拒绝材料全部保留；不因成功或失败增减次数 |
| 搜索 | 正式 `ReflectiveSearch`，训练门槛、独立 validation 选型、相同候选约束和有限修订 |
| 最终测试 | 所有组完成选型并封存后才打开；存在缺额、无效搜索或未知结果则标为不可比 |
| 预算 | 正式实验逻辑 turn 上限 1,452；不是 HTTP、token 或美元硬上限 |
| API 异常 | 终态失败或未知结果即停止，只读核对原 turn，不自动重提或开启另一项实验 |

启动前另行执行一次可用性请求：[实际回执](availability.json)为 `gpt-6-astra` 返回 `OK`，1 次完成、10,617 native tokens。这次检查单独核算，不代表之后每个请求都会成功，也不计为任务成功。

V6 的结束协议、生成模型与预算调整参考了先前失败尝试，因此属于独立实现验证，不宣称确认性复现。最终按全部组和全部尝试报告结果；两道合成留出任务只能提供描述性结果，不能证明广泛泛化、统计显著性或 failure 必然优于对照。旧失败修复与回归只在实际重复测量覆盖范围内报告。

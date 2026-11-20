# Retail V4：完整回执下的动作合同中止

**本次工具域对照未完成，没有效果结论。** 与前次 API 中断不同，这次 43 次真实模型调用均完成并保存原生用量，合计 **990,092 tokens**。最后一条响应是 `{"kind":"finish","name":"","arguments_json":"{}","text":""}`：它通过了当时的输出 schema，但违反执行器要求最终回复非空的合同。执行器抛出 `ValueError`，首个训练任务尚未完成，未进行生成、正式搜索或最终测试。

源码冻结在 `52d720227`；无 GPU 作业或权重更新。输入沿用 [V3 的自编任务](../sentinel-retail-2026-11-20-v3/README.zh-CN.md)，全部为合成客户和订单。**开始收费任务调用前**，random/failure 的生成次数从每组 1 次调整为无条件执行 3 次，保留全部尝试，每组仍只选 1 条生成题；fixed 的两条原始题和其他条件不变。协议、配置和实际运行身份保存在 [evidence.json](evidence.json)。没有看到结果后追加生成，也没有恢复或替换此次调用。

| 项目 | 预先固定的设置 |
| --- | --- |
| 组别与规模 | fixed/random/failure，调度 seed 23，1 轮；2 train、1 validation、2 test |
| 模型 | solver／用户模拟／生成 `gpt-6-luna low`；Meta `gpt-6-astra low`，实际未调用 |
| 数据配额 | fixed 2 条原题；random/failure 各 1 条原题 + 1 条生成题 |
| 逻辑调用上限 | 每任务 56、每次生成 64、每组搜索 280；全实验理论上限 2,008 SDK turns，非 token/美元硬限制 |
| 最终测试 | 所有组选型封存后才开启；此次没有打开 |

单独的服务连通性检查使用 `gpt-6-astra`，1 次调用、9,224 tokens，只证明该次文本请求完成，不是 solver 能力或研究效果。它与上面的任务消耗分开核算。最初预检误用全局 CLI，参数检查阶段即失败，没有模型提交；实际运行显式使用冻结源码编译的 `GEAR_COMMAND`。

## 原始执行与复核

保留的轨迹前缀有 22 步：20 次对话、2 次真实身份查询，未执行数据库修改。最后空 `finish` 的原响应被保存，未加入已执行轨迹，也没有补造失败分数或调用 policy grader。全部 43 份原生回执均已完成，没有等待中的请求；不需要通过再次提交来协调未知状态。

[verification.json](verification.json) 验证了 5 条人工参考及其负例、22 步前缀和 43 份响应绑定，并在相同位置复现相同异常。SDK 未导入、新模型提交数为 0。[五项篡改检查](negative-checks.json)分别修改原响应、待提交输入、任务结果、原生用量和真实工具结果，均被拒绝。原始 thread/turn ID 已脱敏，原生 receipt 摘要不冒充脱敏后摘要；[manifest.json](manifest.json) 绑定整份导出。

```sh
/path/to/sentinel-env/bin/python research/sentinel-retail-2026-11-20-v4/verify.py \
  --repository /path/to/gear-at-52d720227 --tau2-source /path/to/pinned-tau2

# 同样无模型调用，重新执行五项反证检查
/path/to/sentinel-env/bin/python research/sentinel-retail-2026-11-20-v4/verify.py \
  --repository /path/to/gear-at-52d720227 --tau2-source /path/to/pinned-tau2 \
  --negative-checks
```

## 后续实现修复与证据边界

检查还发现 `TextCalls` 沿用了 IFEval 的 “Do not use tools” 基础指令，而 retail 的开发者指令要求返回工具动作。模型实际在一次成功查询后多次声称无法访问订单。两者存在歧义，但本次记录不能证明它是唯一原因。

后续调用层改为明确允许输出供调用方执行的结构化动作，原生 SDK 工具仍关闭；动作 schema 区分工具调用和非空消息／结束回复。执行验证仍保留，未知和无效响应不折算成 native 失败。该修改不改变本次冻结记录，也不是经过测试集选出的 harness。修复后的真实对照需要独立协议和新的执行证据；此归档不声称修复已经带来提升。

修复后的 107 项 retail 调用方检查及 6 项模型桥接检查通过；另 1 项可选真实 MiniLM 检查跳过。检查使用实际 CPU 工具和正式 CLI／worker，LLM 是明确替身。这些检查与本次真实模型回执分开计量。

# Retail 工具对照 V7：生成阶段终态 429

**实验已因生成阶段的服务端终态 429 停止，尚无有效三组比较；模型权重固定，不做 GPU 训练。** 冻结源码为 `ff7724495`。[config.json](config.json) 的摘要为 `sha256:a61fd94a1d665f829fcad6b86f1922639fd661ca3fd16b548c1f8221ed5d1c38`，完整规则见 [protocol.json](protocol.json)。协议在首个模型请求前提交，已停止的 V6 和此前尝试继续保留，不恢复或替换其原请求。

两条来源任务都完整结束并评分失败。第一条 random 生成在实际执行三次只读工具调用后，`explore/3` 收到 `exceeded retry limit, last status: 429 Too Many Requests`，原始进程退出码为 1。只读核对原 native turn 确认为 `failed`，HTTP 状态为 429，usage 缺失；未重新提交。生成没有完整参考、候选或准入数据，尚未进入正式搜索、failure 生成或最终测试。

| 阶段 | 完成调用 | 已知 native tokens |
| --- | ---: | ---: |
| 地址与商品修改来源 | 11 | 195,142 |
| 支付与商品修改来源 | 24 | 602,042 |
| 第一条随机生成前缀 | 5 | 71,146 |

合计 41 次逻辑提交、40 次完成、1 次服务端失败，已知用量 868,330 tokens。失败请求用量、总尝试 token、HTTP 重试数及美元成本未知；没有单独的可用性请求。三步生成探索实际调用 `find_user_id_by_email`、`get_order_details` 和 `get_product_details`，不能以这段未完成前缀声称生成有效或政策审核通过。

[evidence.json](evidence.json) 保存两条完整来源、失败生成前缀、全部原始请求／完成回执、终态检查与账目；[manifest.json](manifest.json) 固定其 SHA-256 为 `262fd01350072cd16ee81a4bd4ab7bfbbd09dea8a8b637728fe24c6585abe864`。导出前核对回执摘要与 ID 对应关系，随后移除 SDK thread/turn ID；没有补造生成结果或失败请求用量。

[离线核验](verification.json)通过全部五道原始任务的参考／负例校准、两条来源重放、三步生成前缀重放、600 秒配置绑定及完整调用账目。修改失败请求、工具结果、生成结果、来源评分或等待配置的五项检查全部被拒绝。核验未导入模型 SDK、未提交请求。

```sh
/path/to/sentinel-env/bin/python research/sentinel-retail-2026-11-20-v7/verify.py \
  --repository /path/to/gear-at-ff7724495 \
  --tau2-source /path/to/pinned-tau2 --negative-checks
```

这份归档证明中止前行为可核验，不提供数据生成收益结论。后续完整效果实验需要可用推理服务与独立冻结的新协议；本次不自动重启或再开实验。

相对 V6 只改变两项配置：单次等待从默认 240 秒改为 600 秒；调度 seed 改为 1，预先确定 random → fixed → failure，先执行生成环节。选择顺序时未观察新模型结果。provider 单个操作仍限时 30 分钟，延长单次等待不保证服务可用，也不代表取消或自动重试能力。

使用原有两条训练、一条 validation 和两条不同 family 的最终测试；最终测试尚无模型结果。solver 为 `gpt-6-luna low`，Meta 及 random/failure 生成均为 `gpt-6-astra low`。每条轨迹最多 16 步，预算结束后允许一次真实结束回复。fixed 学习池为两条原始数据，另两组各为一条原始数据加一条通过验证的生成数据；random/failure 各恰好三个预定生成机会，所有拒绝和缺额均计入报告。

正式搜索使用训练门槛、独立 validation 选型、相同长度约束和有限修订。只有所有组选型封存后才打开最终测试；任一池缺额、搜索无效或评分未知，都不能宣称有效比较。预算上限仍为 1,452 个逻辑 turn，不是 token、HTTP 或美元硬上限；不另发可用性探针。

终态失败或未知请求即停止，仅只读核对原 turn，不自动重提、重启或再开独立实验。报告全部实际完成调用及未知用量，保留生成接受率、原失败修复／回归的实际测量范围、留出变化和阶段成本。两道合成留出题只能给出描述性结果，不支持广泛能力或统计显著性结论。负结果同样可以完成有效实验验收。

本次配置参考了先前实现问题，不属于确认性复现。V6 的本地超时和原生 `interrupted` 不能归因为 429；历史生成检查的 429 也不能证明后续服务不可用。

[CPU 预检](preflight.json)已通过原始五道任务的参考／负例校准和实际 Gear 准入，模型提交数为零；配置及源码身份已核对。

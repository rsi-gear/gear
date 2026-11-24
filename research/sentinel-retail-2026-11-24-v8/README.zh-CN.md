# Retail 工具对照 V8：限速后生成阶段终态 429

**本轮已停止，尚无有效三组效果比较。** 按用户要求独立重试，源码冻结为 `70895c019`；[协议](protocol.json)、[配置](config.json)与[零模型 CPU 预检](preflight.json)在首个正式请求前提交为 `f5c520ac7`。每次新请求前等待 10 秒，单次等待上限 600 秒，正式操作上限 30 分钟。用户随后决定不再重试 429，按当前可运行实现提交 PR；未完成效果验证继续保留为待办。

两条来源任务均完整结束并评分失败，分别执行三次实际只读工具调用后仍未完成目标修改；完整轨迹、模型回复和 native 评分已保留。随机生成的首个预定尝试完成九次调用、五步探索后，`explore/5` 收到 `exceeded retry limit, last status: 429 Too Many Requests`，原进程退出码为 1。只读检查原 native turn 确认为 `failed`、HTTP 429、usage 缺失；没有重新提交原请求。

| 阶段 | 完成调用 | 已知 native tokens |
| --- | ---: | ---: |
| 地址与商品修改来源 | 31 | 952,175 |
| 支付与商品修改来源 | 31 | 986,844 |
| 第一条随机生成前缀 | 9 | 125,693 |

合计 72 次逻辑提交、71 次完成、1 次服务端失败，已知用量 **2,064,712 tokens**。失败请求用量、全部尝试 token、HTTP 重试数和美元成本未知；[单次服务检查](../retail-service-check-2026-11-24/README.zh-CN.md)的 9,137 tokens 另计。没有 GPU 训练或权重更新。

五步生成前缀包含两次消息和三次只读工具调用：`find_user_id_by_email`、`get_order_details`、`get_product_details`。没有完整参考、生成结果或准入数据；剩余生成机会未执行，也没有进入 failure 生成、正式搜索或最终测试。生成接受率及策略效果保持未知，不把中断归为任务零分。

[evidence.json](evidence.json)保存两条来源、全部原始请求／完成回执、生成前缀、原终态检查和账目。[manifest.json](manifest.json)固定 SHA-256 为 `5434010a03794c52d6904f10cffc42b8f753f0cf45bd6de27173215b3eb28fce`。导出前核对回执摘要及原 native ID 对应关系，再移除 SDK thread/turn ID；归档未包含这些原始标识。

[离线核验](verification.json)通过五道原始任务的参考／负例校准、两条来源重放、五步生成前缀重放、10 秒限速／600 秒等待配置绑定和完整调用账目。修改失败请求、工具结果、生成结果、来源评分、等待设置或限速设置的六项检查全部被拒绝。核验没有导入模型 SDK，新增模型提交数为零。

```sh
/path/to/sentinel-env/bin/python research/sentinel-retail-2026-11-24-v8/verify.py \
  --repository /path/to/gear-at-70895c019 \
  --tau2-source /path/to/pinned-tau2 --negative-checks
```

三组、seed 1、单轮、模型、任务、配额及选型规则沿用 V7；random／failure 各预定三个生成机会，学习池每组两条，全部选型封存后才打开相同最终测试。逻辑 turn 上限为 1,452，原预计 1,000 万至 2,500 万 token、预留 3,000 万均是估算而非硬上限。此前 V2–V7 与组件探针继续披露，本轮不是确认性复现。

10 秒限速未避免本次 429，具体原因未确认；这份归档仅证明中断前行为与用量可核验，不提供 failure 数据收益结论。没有自动重启或再开收费实验。

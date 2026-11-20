# SENTINEL retail：真实模型生成接入检查

固定源码 `03c8f4d66736b27b3a9a87d8e39cabd156c22a1c`，使用 `gpt-6-astra`、effort `low`，在显式提供的训练数据库中完成一次生成触发。**诊断、内部目标、用户模拟、参考探索、任务重写和语义审查均为真实模型调用；源失败是明确标注的测试夹具，不是真实 student 失败采集。** 没有权重更新或 GPU 训练，也没有 fixed/random 效果对照。

结果为 `ready`：生成了一条要求区分两笔相似商品订单、取消其中 pending 订单并保持 delivered 订单不变的练习。实际参考执行调用了身份查询、订单查询和取消工具；中间进行了用户确认。Tau2 工具将 `#G100` 从 pending 改为 cancelled，并增加一笔原卡退款；`#G101` 保持原状。该数据仍为待准入状态，`training_eligible=false`。

| 检查 | 结果 |
| --- | --- |
| 参考工具序列与中间状态独立重放 | 通过 |
| Tau2 native DB：参考路径 | 1 |
| Tau2 native DB：无操作负例 | 0 |
| Tau2 native DB：删除写操作负例 | 0 |
| 请求与轨迹一致、目标忠实、政策与确认、隐藏解法 | 四项语义判断通过；同一模型的独立审查调用，不是正确性 oracle |
| 原目录离线重放 | 结果及全部调用文件不变；未启动 SDK client、未新增调用 |
| 导出后独立重放 | 重新执行工具、校验器和生成决策，结果一致；新增模型请求 0 |

本次证明生成入口能接真实模型与工具环境。它不证明真实学生能力提升、完整 SENTINEL 复现、Tau2 基准成绩或相对固定／随机数据的优势。

## 实际用量

预设上限为 12 个探索步骤、30 个逻辑 SDK turn。实际探索为 5 步，模型调用如下：

| 用途 | 调用数 | 原生 input + output tokens |
| --- | ---: | ---: |
| 失败诊断 | 1 | 9,761 |
| 内部目标 | 1 | 12,873 |
| 用户模拟 | 2 | 22,688 |
| 参考探索 | 5 | 78,160 |
| 任务重写 | 1 | 14,619 |
| 语义审查 | 1 | 16,066 |
| 合计 | **11** | **154,167** |

全部 11 次调用有原生 usage：input 153,204，output 963，cached input 0。没有把回放计为新调用。逻辑 turn 配额不是底层 HTTP、token 或美元硬限制；本次没有报告美元费用或单位成本收益。

## 证据与复核

- [evidence.json](evidence.json)：冻结输入和实现摘要、实际模型输入／输出及 usage、完整参考状态、native 校准结果和生成决定。源观测的 fixture 标记保留；native thread/turn ID 已移除。
- [manifest.json](manifest.json)：来源、结果与导出字节摘要。
- [runtime.json](runtime.json)：实际 Python 和依赖版本。
- [verification.json](verification.json)：导出后的零模型调用复核结果。
- [verify.py](verify.py)：核对原调用输入和固定实现，以已保存响应重跑生成流程；重新执行真实 Tau2 工具与校验器，拒绝缺失或未消费的模型记录。
- [第三方材料说明](NOTICE.md)、[调用方指南](../../examples/curriculum-harness/SENTINEL.zh-CN.md)。

安装指南中的固定依赖和 Tau2 checkout 后，在仓库根目录运行：

```sh
/tmp/gear-sentinel-env/bin/python research/sentinel-retail-2026-11-20/verify.py \
  --tau2-source /tmp/gear-sentinel-tau2
```

复核要求运行时与记录中的实现、策略和相关依赖一致；后续实现变化不会自动升级本记录。导出摘要与重放证明内容及执行一致性，不是模型服务的第三方签名。跨轮记忆、混合池、正式搜索交接及真实失败来源仍按[验收台账](../../docs/curriculum-implementation-status.zh-CN.md)继续实现。

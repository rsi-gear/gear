# 无 GPU 验收补充：文本对照的成本、修复与回归

这里补充[设计第 11 节](../../docs/failure-driven-data-operators-spec.zh-CN.md#11-实施顺序与验收)要求的描述性单位成本结果，不改写[原 V5 实验](../curriculum-harness-2026-11-20-v5/README.zh-CN.md)的评分、采纳、协议或结论。**没有新增模型调用，没有权重训练，也没有证明 failure 数据带来收益。** 完整无 GPU 验收的证据与缺口见[逐项审计](../../docs/curriculum-acceptance.zh-CN.md)。

## 计算口径

原实验包含四组、三个优化种子、两轮，合计 1,478 次真实模型调用和 13,315,856 个原生 input+output tokens。cached input 已包含在 input 中，不再次求和。每组成本包含诊断／生成、搜索、训练探针、回归探针与最终评价；共同基线 283,498 tokens 等分给四组，因此表中的分摊用量可能有半个 token。这是核算分摊，不是服务端发生了小数 token 调用。

三次测试均使用相同的 24 道题；共同基线只测了一次，为 22/24。定义：

```text
重复测试净通过数 = 三个 seed 的测试通过数之和 − 3 × 22
每百万 token 的重复测试净通过数 = 重复测试净通过数 × 1,000,000 / 分摊后总 tokens
```

此分子是相对于同一基线得分的重复测试差，不是新增独立题数、能力增长量或因果收益。每个 trial 的百分点变化和相应单位 token 比值另见 [unit-cost.json](unit-cost.json)。其区间仅缩放原有逐题 paired bootstrap 区间，不覆盖优化随机性或模型解码波动，也不把 72 次测试当成 72 道独立题。

## 结果

| 数据策略 | 留出通过率均值 | 分摊后 tokens | 重复测试净通过数 | 每百万 token 的净通过数 |
| --- | ---: | ---: | ---: | ---: |
| fixed | 95.83% | 3,233,501.5 | +3 | 0.927787 |
| random | 97.22% | 3,303,715.5 | +4 | 1.210758 |
| failure | 94.44% | 3,368,275.5 | +2 | 0.593776 |
| memory | 94.44% | 3,410,363.5 | +2 | 0.586448 |

failure 相对 fixed 多使用 134,774 tokens，三次测试通过数合计少 1；相对 random 多使用 64,560 tokens，通过数少 2。不能因此推出它在其他任务上更差，但这份观测不支持其成本优势。

12 个最终 harness 中，只有 4 个相对初始 prompt 发生了改变，每组各 1 个；另外 8 个相同 prompt 的分数本来就在波动。failure 唯一采纳的候选来自预设的随机回退轮次，而非 failure 条件生成。因此，上表相对共同基线的正数不能归因为 failure 数据，不能解释为经济 ROI 或“每百万 token 确定带来的能力提升”。

| 策略 | 旧失败修复 | 旧成功回归 |
| --- | ---: | ---: |
| fixed | 3/3 | 0/21 |
| random | 2/3 | 0/21 |
| failure | 3/3 | 1/21 |
| memory | 2/3 | 1/21 |

这里仍是重复观测：旧失败实际只有 1 道题，旧成功实际只有 7 道题，各测三个 seed。它衡量受限训练探针的回归，不代表全面的历史能力保留。逐 seed 的三点训练曲线、24 题留出结果、相对 fixed/random 的差值和成本都保存在派生文件中。

语义／参考验证中的 CPU 用时没有原始计量；只保留 676 次验证器执行计数。GPU 权重训练步数为 0，美元费用、HTTP 重试数均未知，前期中止实验和单独连通性探测不混入 V5 成本。该补充没有把缺失量估成零。

## 复算与证据

[derive.py](derive.py)绑定原 evidence 与 summary 的固定摘要，逐条核对 1,478 份调用的 key、原生 usage 和归属；重新核对外层任务、原响应、harness、切分、两轮六条样本配额及修复／回归计数。总 tokens、分组成本及所有 seed 均须与原证据相符。它不执行模型，不重选候选。

```sh
python research/curriculum-acceptance-2026-11-20/derive.py --verify
```

本次还使用原冻结源码 `139bfc533` 的 exporter 和固定官方 IFEval，再次重评分 1,424 份 LLM 评测，以及参考解和负例校准，全部一致。该步骤与成本计算分开：

```sh
PYTHONPATH=/path/to/gear-at-139bfc533/python /path/to/python \
  /path/to/gear-at-139bfc533/examples/curriculum-harness/export_formal_results.py \
  --verify-export /path/to/current-gear/research/curriculum-harness-2026-11-20-v5 \
  --ifeval-root /path/to/pinned-ifeval
```

原证据摘要仍为 `sha256:4a53937dcaf9aca2aceaef61366f8c6fb7eb379930f73f595da498b73a4673d1`。派生文件同时记录脚本字节摘要、计量定义与限制；复算无需 SDK 登录或原始服务端会话。

# 第二轮正式对照：测试集开启前中止

本轮没有完成四组、三种子的对照，不能据此判断 failure 生成是否优于固定数据或随机生成。模型权重固定，更新对象仍是 developer prompt。

冻结代码为 `daa617746`，student/teacher 为 `gpt-5.6-luna` / `gpt-6-astra`，effort `low`；8 train、16 dev、24 test，切分 seed `20261121`，允许至少一个约束，排除之前 112 个来源。优化种子 101/202/303，各计划两轮。官方语言检测 seed 已固定为 0。训练基线为 6/8，满足预先声明的 readiness 门槛。

已完成 seed 101 两轮和 seed 202 第一轮，共 12 个正式搜索 run。seed 202 第二轮出现两个问题：failure 组 6 条草案全部被校准步骤拒绝；随后 memory 组的一次生成返回了语法错误的 JSON，流程停止。未开启最终测试集，也未执行最终训练题复测。

failure 组的参考解全部通过官方检查。被拒绝的原因是校准负例不足：来源 `ifeval-201` 要求字母 `i` 少于 3 次，原来的四个非空固定负例都满足该约束，只有空字符串失败。因此，原协议要求的非空负例检查没有通过。原拒绝决定与原始响应均保留，没有补写通过记录或将部分结果算作完整实验。

下一版实现按冻结的约束参数构造候选反例，并用官方 verifier 实际确认失败；在切分前排除无法校准的来源。生成和 Meta 请求同时使用 SDK 原生 `output_schema`，将 schema 绑定到调用身份。新协议必须使用新工作区并继续排除本轮的全部来源。针对已见来源进行的两次结构化输出预检独立记账，不计入本轮实验。

| 已有记录 | 数量 |
| --- | ---: |
| 已完成逻辑 SDK turns | 532 |
| 实际回执 tokens（含 cached input） | 4,789,114 |
| 用量未知的调用 | 0 |
| 完成的正式搜索 run | 12 |
| 重新评分的外层评测 | 72 |
| 重新评分的搜索评测 | 420 |
| 草案验证记录 | 63 |
| 最终测试模型调用 | 0 |

归档器核对了意图／回执一一对应、内容摘要、封存候选、实际回答以及原始参考解和校准负例的评分。这里没有完成全部候选选择审计，`full_selection_audit=not_performed`；它也不是完整实验的通过报告。HTTP 重试次数仍不可见，逻辑 turn 上限不是 HTTP 或美元硬上限。

可分享记录见 [evidence.json](evidence.json) 和 [manifest.json](manifest.json)，已省略原生 thread/turn 身份。第三方任务来源与许可证见 [NOTICE.md](NOTICE.md)。在保留原工作区及冻结源码快照的环境中可复核：

```bash
PYTHONPATH=python /tmp/gear-curriculum-llm-env/bin/python \
  examples/curriculum-harness/export_aborted_results.py \
  --workspace /tmp/gear-curriculum-formal-20261120-v2 \
  --ifeval-root /tmp/gear-curriculum-ifeval \
  --output /tmp/gear-formal-v2-audit
```

# 冻结预训练 solver 的生成与恢复检查

本次检查跑通了真实本地 HF 推理、原始 token／logprob 捕获、数学答案分类及不加载模型的重放。四份完整回答均未输出 `\boxed{...}`，分类结果全部为 `missing_box`；没有得到可用的数学课程，也没有训练或效果提升结论。

## 模型、输入与实现

模型为 [HuggingFaceTB/SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct)，固定 revision `12fd25f77366fa6b3b4b768ec3050bf629380bac`。下载后的文件经 `seal_hf` 封存，推理只读取已验证的本地 safetensors，使用 CPU float32；没有修改模型参数。

两道固定问题分别为 `6 × 7` 和“公平骰子结果为偶数时，大于 3 的条件概率”，每题计划采样两次。system 指令要求简洁解答并给出 boxed 答案。temperature=1、topP=1、上下文上限 2048、基础种子 20261120，各问题／槽位派生独立种子，单次生成软期限 60 秒。计时仅覆盖生成，不含下载与加载；美元成本未知，不记为零。

执行入口为 [diagevo_solver_smoke.py](../../python/probes/diagevo_solver_smoke.py)，后端为 [FrozenHFSolver](../../python/gear/training/recipes/diagevo_inference.py)。探针保存完整源码摘要和实际配置，使用真实 `DiagEvoMathClassifier`，没有以预设答案替代模型响应。

## 两次运行的全部结果

| 运行 | 最大输出 tokens | 逻辑生成次数 | 输入 tokens | 输出 tokens | 生成秒数 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | 256 | 1 | 54 | 256 | 5.794 | 第一份回答未到 EOS，保存后拒绝，运行中止 |
| V2 | 1024 | 4 | 190 | 1264 | 29.710 | 四份到 EOS，全部缺少 boxed 答案，重放一致 |
| 合计 | — | 5 | 244 | 1520 | 35.504 | 外部模型 API 调用 0，参数更新 0 |

V1 的原始记录保留。V2 在独立目录仅扩大输出上限，问题、指令、基础种子及槽位键不变。两次第一槽位的前 256 个 token **和全部对应 logprob 完全一致**；没有通过换种子挑选回答。V2 四份响应长度分别为 473、217、428、146 tokens。

解析失败的四份回答获得四个独立 `unparsed` 标识，不能因格式错误相同而形成多数票。完成反馈只表示生成到达 EOS，`correctnessAssessed=false`，其零奖励不表示数学判错。这些本地捕获用于投票／诊断，不是具有 native train lease 的 GRPO 梯度批次。

## 证据和复核

[evidence.json](evidence.json) 保存两次运行的冻结输入、五份请求／结果记录、实际文本、token 与 logprob、四份完整轨迹、分类依据和两版精确源码快照。[manifest.json](manifest.json) 保存文件摘要、用量和复核清单。证据基于提交 `da8a219a3` 后的本批实现；实际执行代码以快照为准。

导出时已校验所有后端结果封套、最终制品与 47 个 CAS 对象的摘要；对 V2 执行了真实的无模型加载重放，并重新运行 Math-Verify，捕获和分类引用均与原记录相同。模型快照的 12 个文件仅保留清单和摘要，权重、tokenizer 等文件字节仍在原本地 CAS，未提交到仓库。因此本归档可检查保存结果及引用关系，单独用于重新推理仍需恢复固定版本模型文件。

原始本地工作区：

- V1：`/private/tmp/gear-diagevo-pretrained-solver-20261120-v1`
- V2：`/private/tmp/gear-diagevo-pretrained-solver-20261120-v2`

此检查不替代完整 DiagEvo 双模型循环、GPU 训练或固定／随机／failure 的效果比较。当前完整范围与未完成项见[验收台账](../../docs/curriculum-implementation-status.zh-CN.md)。

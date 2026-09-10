# 原生 logprob 的数值对照

第 37 轮只在 CPU 上排查已有日志中的数值差异；第 41 轮新增实际训练 forward 的逐 token 对照；第 43～44 轮增加残差/RMSNorm 舍入的 CPU 和 GPU 对照；第 45 轮在真实 Slime 回放中只将 attention 后端由 `unfused` 改为 `flash`，两条样本的平均差降至约 0.03131。没有放宽阈值或改写既有冻结配置；全部记录仍为 `validated=false`。第 45 轮结束后，保留实例 `50316639` 经 Vast CLI 确认为停止状态。

## 已确认的差异及比较口径

固定 Slime `41014d1f29e201137fdffce737bb8bac65bc5219` 的 `loss.py` 在 `use_rollout_logprobs=true` 时，比较训练当前 forward 重算的 logprob 与原生 rollout logprob，再按每个样本的 response loss mask 求平均并汇总。不是两份历史 rollout 汇总值的比较。

| 实际运行 | step | train/train_rollout_logprob_abs_diff |
| --- | --- | --- |
| 早期原生 actor 诊断，合成 0/1 奖励 | 0 | 0.1758769303560257 |
| 第 32 轮完整 driver | 0 | 0.143332377076149 |
| 第 32 轮完整 driver | 1 | 0.06503365933895111 |

这些运行均记录 `ci_test=false`；`model.py` 中默认 0.1 的阈值断言只在 `ci_test=true` 时执行。因此既有“诊断通过”不代表这个数值检查通过。第 32 轮两次更新的完整流程和资源交接证据保留，但不能据此认证数值一致性。

原生 actor 诊断的源码 manifest 含 149 个 Slime 文件。本轮逐文件比对本地固定 checkout，SHA-256 全部相符；指标和 capture 路径的说明依据这些已核对的代码。

## CPU 对照方法及结果

新增 `python/probes/qwen2_logprob_reference.py`。使用原生 actor 诊断保存的 `rollout-0.json`，两条样本的前缀均为 42 个 token，响应分别为 5、8 个 token。权重固定为 `Qwen/Qwen2.5-1.5B-Instruct` revision `989aa7980e4cf806f80c7fef2b1adb7bc71aa306`，没有重新分词或重新生成样本。

探针在 CPU 上逐层载入实际 Transformers Qwen2 decoder，使用 eager attention、关闭 KV cache；响应 token 的分数取自前一位置 hidden state。最终词表投影按 4096 行分块，logsumexp 归一化使用 float64。分别将同一份 BF16 权重转换为 FP32 或保留 BF16 执行；这两种 CPU 实现都不是 Megatron 或 SGLang GPU 内核的替代证明。

| CPU 对照 | 两个样本的平均绝对差再平均 | 单 token 最大绝对差 | peak RSS |
| --- | --- | --- | --- |
| FP32 | 0.03104156534530116 | 0.10019822257423172 | 532.40625 MiB |
| BF16 | 0.23602008992236687 | 1.2065672976975108 | 433.875 MiB |

两个数值均与保存的 SGLang logprob 比较。样本无 response mask 缺口；上表按样本等权，而非把 13 个 token 合并求平均。FP32 更接近该次 SGLang 结果，支持继续排查精度和内核差异，**尚未定位训练侧差异的原因**。这些只是两条短诊断样本，不能外推到真实工具轨迹或通用阈值。

逐层实现另在完整 tiny HF 模型上做了 4 项实际 CPU 对照：tied/untied embeddings × FP32/BF16，包含不同响应长度和非整除的词表分块。统一阈值为 `1e-5`，最大误差约 `3.91e-7`，全部通过。最终记录为 `streaming-reference-check-v2.json`；较早的宽阈值自检保留为历史，不用来替代最终检查。运行版本为 Torch 2.11.0、Transformers 5.12.1、safetensors 0.8.0，2 个 CPU 线程，没有载入完整 1.5B FP32 模型。

## 后续最小 GPU 检查

原生 actor 诊断没有保存逐 token 的训练重算值，无法从一个平均差恢复其分布。固定 Slime 已支持 `--save-debug-train-data`：当使用 rollout logprob 且没有独立重算结果时，`actor.py` 会启用 `loss.py` 的 capture，在实际训练 forward 保存每条样本的 logprob，不增加一次 forward；`train_dump_utils.py` 按 rollout position 还原样本顺序。

第 37 轮结束时，下一项检查是保存这些实际训练值，核对同一权重、token、响应长度、mask 与生成概率后逐 token 比较，再决定是否需要针对某个精度选项做对照。没有因为 CPU FP32 结果较小就改用生产 FP32，也没有直接打开整个 Slime CI 模式或提高阈值。后续第 41 轮已经执行该 capture，结果如下。

## 原始证据

本轮记录目录为 `/Users/tangyehui/.codex/artifacts/gear-logprob-reference-20260909-37`。`reference-audit.json` 核对输入、模型和源码摘要、逐 token 差值、汇总口径、自检阈值及原始训练指标；`evidence-files.json` 列出本轮文件的 SHA-256。FP32/BF16 结果分别为 `actor-rollout-fp32-reference.json`、`actor-rollout-bf16-reference.json`。

输入来自 `/Users/tangyehui/.codex/artifacts/gear-slime-actor-temp-20260908-final/rollout-0.json`，SHA-256 为 `841d067c0f552c60acaea58bdf454e7efcdde1889f01ebfc94245d530d08d752`。完整 driver 指标来自 `gear-full-training-temp-20260909-32/node-diagnostics/jobs/job_bf3068d3b2ad00250100aeae9c93f3e3/slime-a921c2140ec3430a148c5f44cf81ba4e.log`。本轮不覆盖远程 Harbor、双卡或故障恢复验收。

## 第 41 轮：实际训练 forward capture

使用同一 Vast 实例内的固定 Slime/Megatron 源码、补丁与父模型，直接回放上述两条原生诊断轨迹，通过上游 `--save-debug-train-data` 保存真实训练 forward 的逐 token 值。保留 BF16、unfused attention、原学习率及 0/1 合成奖励；未启动 SGLang 重新生成，也未写 checkpoint 或导出模型。

本次恢复分配了不同的物理设备：`GPU-277d55fc-c39d-0cb5-55f8-46236640fc7b`，仍为 32607 MiB 的 RTX 5090。它是独立诊断的实际设备，不能冒充原冻结节点的 `GPU-e66fb162-3a47-b352-3dcb-3e06644a5ad3`。原 node identity、设备账本、node/job 配置四个文件在本次前后 SHA-256 不变；既有作业没有重新提交或改写。

真实 backward 的 grad norm 为 `44.7974935647911`。上游记录的 logprob 平均绝对差仍为 **`0.1758769303560257`**，与早期原生 actor 日志逐值相同；从取回的 13 个训练 token 自行重新汇总为 `0.17587693357490936`，差异小于 `1e-7`。这说明原数值差异可以稳定复现，且现在已有逐 token 证据；它没有被修复。

| 对照两侧 | 每样本平均绝对差再平均 |
| --- | --- |
| GPU actor / 已存原生 SGLang | 0.17587693357490936 |
| GPU actor / CPU HF FP32 | 0.17695566348401917 |
| GPU actor / CPU HF BF16 | 0.16512359127279383 |
| 已存原生 SGLang / CPU HF FP32 | 0.03104156534530116 |
| 已存原生 SGLang / CPU HF BF16 | 0.23602008992236687 |

最大 actor/native 单 token 差为约 0.459811，位于第二个响应的第 7 个 token。样本前缀相同，token、响应长度、完整 response mask 与原生 logprob 在回收后重新核对；上游 dump 的样本顺序与原始 rollout 一致。仍需依据实际训练实现定位差异来源，再以有针对性的精度或内核对照验证，不能单凭本表选择生产精度设置。

捕获程序记录的 Ray 初始化至退出耗时约 72.07 秒；外层命令还包括启动前的 Python/import/参数准备。UTC 06:59:52 请求恢复实例，07:03:12 完成 17 个文件的远端 SHA 对照回收，07:03:30 确认停止保留。回收前 GPU 无计算进程。上述时长不是模型节点设备账本记账或精确 GPU 账单。

本轮独立自停进程已在真实 Linux 容器内完成专用凭据认证和 PID/start ticks/boot ID 核验。正常退出由控制端先停止实例，**没有触发自停期限**，因此不能据此宣称实际断网后的定时停止已经验证。此前连接中断及保护修复见 [Vast 回放恢复记录](vast-replay-recovery-2026-09-09.zh-CN.md)。专用实例密钥未出现在取回的 17 个文件中。

证据目录：`/Users/tangyehui/.codex/artifacts/gear-logprob-replay-20260909-41`。`capture-audit.json` 与 `audit_capture.py` 复核实际 Torch dump、原始日志、原生输入、SHA 和资源状态；`token-comparison.json` 给出逐 token 四方对照，`evidence-files.json` 封存文件摘要。后验比较仍超过 Slime 默认 0.1 门槛，且运行中 `ci_test=false`；本轮证明 capture 和复现成功，不是数值一致性或完整方案验收。

## 第 43～44 轮：残差与 RMSNorm 舍入对照

固定 Slime 的 [数值对齐说明](https://github.com/THUDM/slime/blob/41014d1f29e201137fdffce737bb8bac65bc5219/docs/en/advanced/reproducibility.md) 将现成对齐路径限定为 GLM-5。停止状态下通过 Vast copy 取回三个 Megatron 文件，确认 `transformer_layer.py` 包含 `MEGATRON_USE_SGLANG_FUSED_RESIDUAL_RMS` 补丁。当前 Qwen2.5 使用 dense TE spec，归一化融合在 QKV/MLP 线性层中；该补丁还依赖独立归一化权重与 DeepGEMM 的跳过归一化处理。不能直接给当前配置打开整个 GLM-5 开关。

扩展 `python/probes/qwen2_logprob_reference.py`，保持原 HF 路径为默认，另做两个变量的四组对照：归一化后的数值是否先转 BF16 再乘权重；残差相加的 FP32 结果是否在归一化前先转 BF16。所有组的权重与其他计算仍为 BF16，残差流仍保存 BF16；“不先舍入残差”只保留当前相加结果供下一次归一化使用，不等于整个模型改用 FP32。

CPU 算术参照来自固定版本 SGLang 的原始 `RMSNorm.forward_native`，按原函数 AST 执行，未导入 CUDA 依赖。24 项检查覆盖 FP32/BF16、二维/三维输入、非恒定归一化权重，以及连续三层 decoder 的残差传递，输出与参照逐位相同。原有 4 项 tiny HF 参考检查通过；新增 GPU 探针在 CPU 上的 4 项完整/分层对照也通过。共 32 项检查只证明探针的对应计算，不认证远程训练。

新增 `python/probes/qwen2_logprob_gpu.py`，在同一保留实例、同一固定父模型和两条已存 token 轨迹上执行实际 GPU HF teacher forcing。没有生成、optimizer 或 checkpoint。GPU 结果用相同的按样本等权口径与已存原生 SGLang logprob 比较：

| RMSNorm 权重相乘 | 残差归一化输入 | CPU / 原生平均差 | GPU / 原生平均差 | GPU / actor 平均差 |
| --- | --- | --- | --- | --- |
| HF：先转 BF16 再乘 | 先转 BF16 | 0.236020090 | 0.227004381 | 0.155546224 |
| FP32 乘完再转 BF16 | 先转 BF16 | 0.146870932 | 0.156102192 | 0.154463255 |
| HF：先转 BF16 再乘 | 保留当前 FP32 和 | 0.265604086 | 0.227458652 | 0.148540804 |
| FP32 乘完再转 BF16 | 保留当前 FP32 和 | 0.138129118 | 0.178171708 | 0.176866338 |

CPU 默认组逐 token 精确复现第 37 轮。GPU 默认组与完整 HF 模型的分数最大差为 `5.55e-8`，验证分层执行与词表分块没有引入表中的大幅偏差。CPU 最接近原生的一组并非 GPU 最接近的一组；四组 GPU 对照均未消除差异。因此不能根据 CPU 最小值修改训练设置；截至第 44 轮，原 actor/native 的 `0.1758769303560257` 仍未改善。

另外，本轮在相同的 42-token 前缀位置，对两个样本都计算同一组 token ID `[53, 52519]` 的分数。四组 GPU 结果在不同完整序列长度下的最大差分别为约 `0.00655`、`0.08736`、`0.13229`、`0.08815`。这是输出对完整计算形状敏感的实际观察；原因还需要固定形状、精度与内核继续定位。此前只比较两个不同首 token 的分数，不能替代这项检查。

实际 GPU 为 `GPU-277d55fc-c39d-0cb5-55f8-46236640fc7b`。原冻结节点的四个身份/账本/配置文件前后摘要不变，GPU 退出后无计算进程。模型加载及四组计算记录为约 `1.703` 秒，峰值已分配显存 `3,132,895,744` 字节；整个 Python 主命令含 import 和源码准备约 18.35 秒。UTC 07:38:59 请求恢复，07:40:12 完成 15 个输出文件的远端 SHA 对照回收，07:40:44 确认停止保留。本地 watchdog 已退出，容器内保护完成就绪核验，正常结束由控制端停止，未触发自停期限。

CPU 使用 Torch 2.11.0；GPU 为 Torch 2.11.0+cu129，双方 Transformers 均为 5.12.1。GPU 侧实际安装的 `layernorm.py` 与 `qwen2.py` 已取回，SHA 分别为 `83b61f2ddb0886272236cdc10220e25772260d73442096a322ef28021da6f7cc`、`c7e83f69b72c329cf66491213408f4dcf5779c6994fdd29e0c97d62641b025d3`，与 CPU 使用的固定 SGLang 源码完全一致。停止时的 Vast copy 未能取到这两个路径，未将其零退出码算作复制成功；本轮启动后的 SSH 回收补齐了这项证据。

证据目录为 `/Users/tangyehui/.codex/artifacts/gear-logprob-rounding-20260909-43` 和 `/Users/tangyehui/.codex/artifacts/gear-logprob-gpu-reference-20260909-44`。后者 `audit_reference.py` / `reference-audit.json` 核对 15 文件 SHA、固定 token、四组分数、已安装源码、凭据未泄露及资源状态。当日账单查询累计 GPU 约 `$0.049`、磁盘约 `$0.427`；这是查询时的日累计快照，不是本次精确账单或最终账单。

## 第 45 轮：真实 Slime 的 FlashAttention 单变量对照

固定 Slime 的 Qwen2.5 测试和 GB10 示例均显式使用 `--attention-backend flash`。本分支两个诊断入口原先附加 `unfused`。在第 41 轮的原始 argv 中只将这个值改为 `flash`，保持父模型、两条 token 轨迹、BF16、RoPE、dropout、学习率、合成 0/1 奖励、batch、TP/PP/CP 与 offload 设置不变，再执行同一个真实训练 forward capture 和 backward。额外的 TE debug 日志只用于观察实际内核选择。

| 实际 Slime 指标 | 第 41 轮 unfused | 第 45 轮 flash |
| --- | --- | --- |
| train/train_rollout_logprob_abs_diff | 0.1758769303560257 | 0.031308453530073166 |
| 逐 token 重新汇总 | 0.17587693357490936 | 0.03130845433915965 |
| pg_clipfrac | 0.20000000298023224 | 0.0 |
| grad_norm | 44.7974935647911 | 51.13589383859321 |

真实训练日志四次记录使用 **FlashAttention 2.8.3**，参数解析为 `AttnBackend.flash`，没有静默回退。实际 backward 完成，保存的 13 个训练 logprob 与原生 token、loss mask、样本顺序均已重新核验。这个单变量对照支持将 `unfused` 视为当前短样本偏差的主要来源；仍有约 0.03131 的非零差异，不能宣称逐位对齐。

本次结果低于默认 0.1 门槛，但运行仍保持 `ci_test=false`，这是对两条样本的后验检查，不是完整 CI 或 runtime 认证。真实工具轨迹、多轮更新、checkpoint/export 后生成及独立评估仍须在新冻结 recipe 下验证；旧第 32～33 轮的 unfused 证据不自动迁移。

`scripts/prepare-training-diagnostic.mjs` 和 `python/probes/slime_actor_smoke.py` 的新诊断默认改为 `flash`，分别支持末尾参数 `flash|unfused` 和 `--attention-backend flash|unfused`。backend 进入冻结 hyperparameters；GPU 不支持时执行失败，不自动换内核。CPU 请求构造检查使用归档的第 32 轮观察：显式选择 `unfused` 逐字段复现原完整请求；默认 `flash` 只改变该 hyperparameter 值，并产生不同的 hyperparameters/recipe 摘要；未知 backend 在读取输入前被拒绝。它不启动节点，也不能把这些归档 GPU UUID 的请求用于当前重新分配的设备。

本轮 Ray 初始化到退出约 70.80 秒；包含 Python import 和参数解析的主命令约 95.89 秒。UTC 07:50:31 请求恢复，07:53:13 完成 14 个文件的远端 SHA 对照回收，07:53:54 确认停止保留。实际设备仍为 `GPU-277d55fc-c39d-0cb5-55f8-46236640fc7b`，原冻结节点四个文件不变，停止前 GPU 无计算进程，专用实例凭据未出现在回收文件中。控制端正常停机，没有触发容器内保护期限。

证据目录为 `/Users/tangyehui/.codex/artifacts/gear-attention-backend-20260909-45`。`contrast.json` 固定单变量变化，`audit_capture.py` / `capture-audit.json` 核对真实 Torch dump、日志、阈值口径、源码与资源，`request-construction/check.json` 记录 CPU 请求冻结检查。当日账单查询累计 GPU 约 `$0.068`、磁盘约 `$0.442`；仍是查询时的日累计快照。

第 46 轮已补齐新 FlashAttention recipe 的完整两次更新、真实工具轨迹与 checkpoint/export 后恢复，实际 logprob 差分别为 `0.01712593249976635`、`0.017333928495645523`，两轮均低于 0.1。九份原生 receipt 与 125 个依赖对象经过校验。第 49 轮随后在相同冻结节点、GPU 和账本上完成 Hitch 独立评估，原训练 lease 保留且双方占用区间不重叠。四个训练奖励和独立评估奖励均为 0，未证明模型提升；`ci_test=false` 和未认证状态不变。资源、连接失败、停机复制及证据边界见 [完整记录](full-driver-diagnostic-2026-09-09.zh-CN.md)。

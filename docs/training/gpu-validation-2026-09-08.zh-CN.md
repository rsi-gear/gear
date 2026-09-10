# Vast 单卡环境与显存切换诊断（2026-09-08）

状态：硬件诊断及一次原生 Slime 更新诊断通过，**完整 Gear 训练与 Hitch 联调尚未通过**。这些诊断不产生 `gear-training-compatibility-probe`，也不把 runtime lock 改成 `validated`。

## 环境与资源控制

- 使用用户已有 Vast 实例 `50249234`，1×RTX 5090，显存 32607MiB；Vast 当时报价约 $0.493/小时，报价不是结算账单。
- 初次连接确认 GPU 无计算进程。GPU 探针逐个执行，每次有 180 秒硬超时，不并行启动训练和推理作业。
- 模型为 `Qwen/Qwen2.5-1.5B-Instruct`，固定 revision `989aa7980e4cf806f80c7fef2b1adb7bc71aa306`，下载耗时约 39 秒。
- 预装镜像为 `slimerl/slime:nightly-dev-20260810a-cu129`。Python 3.12.3、torch 2.11.0+cu129、SGLang 0.5.15.post1、Ray 2.56.1、Transformers 5.12.1。
- 镜像自带 Slime 为 `06ffdbe22be068b52f9ed0fc318c473f7030197e`。在独立目录检出规范指定的 `41014d1f29e201137fdffce737bb8bac65bc5219` 并应用 Gear export patch；保留镜像原 Slime 和已有 Megatron 补丁。
- 实例内目录为 `/workspace/gear-validation-01a07c7a`。日志取回后确认 GPU 无计算进程、显存回到 1MiB，再通过 Vast CLI 停止实例。最终查询为 `actual_status=exited`、`cur_state=stopped`、`intended_status=stopped`，保留模型缓存与磁盘数据。

## 已执行与证据范围

| 检查 | 结果 | 能证明什么 |
| --- | --- | --- |
| CUDA BF16 128×128 矩阵前向／反向 | 约 2.6 秒，loss 和 gradient 有限 | 当前 CUDA／torch 能在 SM 12.0 上执行这项运算；不是 Qwen 或 Megatron 反向传播 |
| SGLang 加载 1.5B 并生成原生 token/logprob | 通过 | 本环境可执行短输入、8 个输出 token 的原生生成 |
| 两轮卸载 → CUDA 矩阵反向 → 权重显存恢复 → tensor/IPC 权重注入 → KV 恢复 | 最终探针约 18.8 秒；两轮恢复后的 greedy token IDs 完全一致，最大 logprob 差为 0 | 该模型和配置下的 SGLang tensor/IPC 恢复及重载数值一致性 |
| Gear 生成 argv → 指定 Slime 的真实参数解析器 | 通过 | actor/rollout 均为 1 GPU，colocate、训练 offload、rollout offload 均开启；未启动 Ray、训练或 checkpoint |
| 测试进程退出后的 GPU 观察 | 无计算进程、1MiB 显存 | 本轮诊断没有留下 GPU 计算进程；不是受管理模型节点账本的端到端释放验收 |

显存检查采用 `nvidia-smi` 阶段快照：SGLang 初始生成约 3836MiB，卸载后约 734MiB；增加诊断主进程的 CUDA context 后，生成约 4476MiB、卸载约 1358MiB。它不是持续采样的峰值，也不能证明完整 1.5B actor/optimizer/reference 或更长上下文适配 32GB。

最终硬件诊断使用 greedy 采样检验重载确定性，尚未验证训练 recipe 的 temperature=1 行为分布、actor 重算 logprob、原生工具调用连续性或更新后的策略权重。

## 发现与修正

1. Transformers 5 的 `apply_chat_template` 默认返回值不再保证是 token 列表。诊断脚本显式使用 `return_dict=False`，并在创建 SGLang 前检查 token 类型。Gear 生产路径复用的固定 Slime `_render_token_ids` 已包含 `input_ids` 提取，因此未据此修改生产 gateway。
2. SGLang 的 `resume_memory_occupation` 只恢复显存分配，不恢复权重内容。早期诊断只检查有限 logprob，错误地把恢复后全零 token 标为成功；该结果作废，不能作验收证据。最终脚本按 bridge 的顺序恢复 weights、通过 tensor/IPC 重新注入不可变 HF 权重、恢复 KV，再检查原 token 和 logprob。生产 `TrainingMemoryCycle.prepare_rollout` 已执行对应的 actor 权重同步顺序。
3. 上游 `qwen2.5-1.5B.sh` 的 RoPE base 为 10000，而所选 Instruct 模型配置为 1000000。参数诊断从固定模型的 `config.json` 读取并以整数 argv 封存，通过真实 Slime 的模型一致性检查。

## 原始记录与复现

本机记录目录：`/Users/tangyehui/.codex/artifacts/gear-gpu-validation-20260908`。有效结果为 `sglang-smoke-v3.json/.log`、`slime-args-v3.json/.log`，环境和源码/补丁摘要见 `environment.json`，模型 revision 见 `model.json`。早期失败及作废结果保留用于诊断，不能替代 v3 结果。源码见 `python/probes/sglang_colocated_smoke.py` 和 `python/probes/slime_argument_smoke.py`。

恢复实例前，先在本地准备下一项检查的代码、输入与退出条件。通过 `vastai start instance 50249234` 启动后重新调用 `vastai ssh-url 50249234`，不要假定 SSH 端口不变。确认无其他 GPU 作业后，一次仅启动一项必要探针；阶段结束归档证据并检查进程释放，无远端工作时停止实例。

```sh
timeout --kill-after=10s 180s python sglang_colocated_smoke.py \
  --model /path/to/pinned-model-snapshot --output sglang-smoke.json

PYTHONPATH=/path/to/gear/python:/path/to/pinned-slime:/root/Megatron-LM \
timeout --kill-after=5s 60s python slime_argument_smoke.py \
  --model /path/to/pinned-model-snapshot --slime /path/to/pinned-slime \
  --output slime-args.json
```

## 原生 Slime actor 更新诊断

新增 `python/probes/slime_actor_smoke.py`，通过 Gear `build_argv`、真实 Slime parser、Ray rollout manager、Megatron actor/reference 和生产 `TrainingMemoryCycle` 执行一次更新。诊断 callback 使用两个不同的原生样本和明确标记的 0/1 合成奖励；它没有接入任务 verifier，不能作为完整训练验收或 on-policy 数值探针。

原实例约 30.47GiB 主机内存的尝试已执行原生反向传播，但在训练后的内存卸载阶段失联。最后一次观察为 GPU 已用 29.91GiB、主机可用 10.56GiB；未取得 checkpoint/export。没有内核 OOM 证据，不能把失联定性为已确认的 OOM。取回日志时实例保持停止。

经用户授权，临时租用同为 RTX 5090、主机内存约 94.22GiB 的实例，报价 $0.51593/小时。首次镜像冷启动及第二次源码传输超过各自限时，均未开始 GPU 计算，随后销毁。把源码包缩至约 414KB 并核验固定 Slime 文件摘要后，第三个临时实例 `50272558` 成功执行：

| 阶段 | 从探针启动经过的时间 | 证据 |
| --- | --- | --- |
| actor/reference 初始化、首次原生生成 | 84.23 秒 | B=1、G=2、global batch=2、单 GPU colocate/offload；weight version=1 |
| 原生 backward、同步 checkpoint | 134.86 秒 | grad norm=44.79749、学习率=1e-6；checkpoint tracker 为 Slime 的零起始 rollout ID `0` |
| HF export | 143.02 秒 | `model.layers.0.mlp.down_proj.weight` 有 204366 个元素改变，最大绝对变化约 1.90735e-6 |
| 更新后重新生成 | 143.56 秒 | SGLang weight version 从 1 变为 2，并取得原生 token/logprob |
| 探针完成 | 144.97 秒 | status=passed，仍为 validated=false；退出后无 GPU 计算进程 |

训练后卸载的主机已用内存约 44.79GiB、可用约 49.43GiB，支持继续调查原实例的主机内存压力。显存阶段快照最大已用约 29.92GiB，不能据此保证长上下文、3B 或不同 batch 的容量。训练重算与 rollout logprob 的平均绝对差约 0.17588；本轮没有设定或通过兼容性数值阈值，后续正式数值探针仍需解释和验证该差异。

源码还修正了诊断的 rendered prompt、Ray Unix socket 路径过长、零起始 checkpoint 标号，并显式选择 constant LR。诊断入口在启动 actor 前要求总主机内存至少 64GiB、可用至少 48GiB；这是本诊断的保护条件，不是经普遍验证的生产最低配置。

有效记录：`/Users/tangyehui/.codex/artifacts/gear-slime-actor-temp-20260908-final`，包含源码包/Slime 摘要、实际 argv、原生日志、rollout token/logprob、checkpoint 文件清单及生命周期。执行脚本 SHA256 为 `b4a7e937b02afdcaadc5205e6f774116fb4992064ba096ed3fd06ab15894e07d`。checkpoint/HF 大文件用于节点内验证后随临时实例销毁，未声称已完成控制端 CAS collect 或可恢复保存。

三次临时尝试从准备至销毁保守累计约 853 秒；按当时报价估算约 $0.122，不含存储/传输，也不是账单。用户随后允许增加时间，本任务采用累计 30 分钟、单价不超过 $0.60/小时的上限。`50271443`、`50272105`、`50272558` 均已销毁；原实例 `50249234` 保持停止。

后续已完成本地 Harbor → 远程原生 SGLang 的两次实际工具调用及精确历史修复，任务反馈为有效 0 分，详见 [原生轨迹联调记录](native-history-validation-2026-09-08.zh-CN.md)。临时实例最终采用累计 35 分钟上限，实际保守累计约 33 分钟，均已销毁。仍需实际任务奖励与 exact receipts 的 Gear 完整训练、checkpoint 恢复和 CAS collect、Hitch 受管理 SGLang 交接、实际跨主机故障及双卡回归；这些检查保持原方案范围。

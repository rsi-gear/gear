# Qwen3.5-2B 单张 RTX 5090 调试记录

在 `codex/training-stages@973f3339d9a8d635036c2c59dedeee8fdb548bf0` 加上本次适配修改后，单张 RTX 5090 已完成真实 Terminal-Bench 四阶段、checkpoint 提交和独立 HF 导出重载。模型固定为 `Qwen/Qwen3.5-2B@15852e8c16360a2fea060d615a32b45270f8a8fc`。

本次 TB 使用原任务 verifier 反馈。早期人工 0/1 奖励的原生 GPU 诊断单独记录在后文；两者均未使用 Oracle 轨迹训练，也未标为正式 runtime 认证。

## 带教学提示的成功轨迹与四阶段调试

按用户要求，在原始 `openssl-selfsigned-cert` 任务指令后追加可执行的[教学步骤](teacher-ssl-method.sh)，让 Qwen3.5-2B 自己调用终端执行。原始任务说明和初始镜像保留，所有 verifier 文件逐字节保持原值；仅指令追加了指导，所以 benchmark revision 与无提示原任务不同。另追加[测试依赖启动](teacher-verifier-bootstrap.sh)：发布站点 TLS 失败时，经 PyPI 安装原 verifier 使用的同一固定版本 uv/pytest，未更改 tests 文件或奖励逻辑。此项明确为 assisted smoke test，不作为独立 Terminal-Bench 解题成绩。奖励来自原始 verifier，未编造奖励或把教学预检算成模型成功。

本轮两条原始 verifier 奖励为 [1, 1]，均有效。模型成功轨迹 eval `eval_c9b7c32501374ecf8ceabeaa82c56d86`、run `run_cf87ee08c046494aa2e0c2267dabf61b` 的 verifier reward=1，原始测试有效完成、invalid=0；该轨迹包含 9 次真实 bash 调用。成功采集时仍使用固定父 Qwen3.5-2B 的 update-0/weight-1。见[带提示成功审计](tb-taught-positive-audit.json)，其中记录修改后的完整 prompt 哈希、原 verifier 文件哈希、原始 verifier 输出和真实轨迹的证据哈希。

本轮 `tb21:build_loop` 四阶段真实完成，提交 update=1 的模型/optimizer/RNG checkpoint；[四阶段提交](tb-taught-four-stage-audit.json)、[实际训练 capture](tb-taught-training-capture-audit.json)和[独立导出重载](tb-taught-export-reload.json)绑定同一 checkpoint。capture 与 native receipt 的策略 token、工具 mask、rollout logprob 精确对应，actor/native 加权 logprob 平均绝对差为 0.0055391。导出 632 个有限权重张量，独立 SGLang 进程从该已提交导出生成 8 个 token，输出概率有限。

[运行参数](tb-taught-settings.json)固定未经筛选的 t=1/topP=1/topK=-1 采样，以及节点模板选项 `{'enable_thinking': True}`。流程调试设置 `zeroVarianceGroup=keep`，避免全成功组被不断跳过；如果两个 verifier reward 都为 1，GRPO 的组内优势为 0，不能据此声称模型学习提升。[原生日志数值](tb-taught-training-metrics.json)为 loss=0.0、grad norm=0.0；本轮奖励为 1/1，优势和梯度为 0，不能作为学习增益证据。checkpoint 提交证明训练步骤执行。GPU 实例按用户要求继续运行。

按用户要求，后续训练失败后直接修复并重试训练阶段，复用[封存批次和原始 pre-update HF 身份](tb-taught-replay-retention.json)，不重新采样。该批次、两条原始 verifier 输出、23 份 native receipt、完整 token/mask/logprob 已保留于节点和本地私有 CAS。重放必须使用原始采集策略对应的 pre-update 权重，不能把旧批次伪装成新策略数据。

后续通用 Hitch harness 改进包含实际工作目录提示、4096 字符输出上限、120 秒命令时限、未知工具/非法参数的可恢复错误反馈，以及前台退出后处理后台服务持有管道。本次改动已整理到 [Hitch 的 `codex/training-terminal-reliability` 分支](https://github.com/rsi-gear/agent-hitch/tree/codex/training-terminal-reliability)，基于核对时最新的 `origin/dev@cadf2d7`，最终提交为 `78f7953`。重放后与 GPU 实测版本的两份修改文件逐字节一致，类型、构建、架构、语法检查及 7 项专项测试通过。GPU 实测使用此前隔离提交，见[复现 patch](hitch-terminal-autonomy.patch)；此次重放未重新采样或训练。[35 秒命令检查](tool-duration-contract.json)与[未知工具历史检查](unknown-tool-history-contract.json)均为合约诊断，reward=null。[独立 Transformers CPU 前向核对](transformers-native-parity-summary.json)只覆盖第 29 轮 thinking prompt 的前 32 个真实 token；[1513 token 的原 HF/SGLang 核对](hf-native-parity-wide-summary.json)来自更早的第 23 轮非 thinking 诊断。两项有界检查均不替代 verifier，也不构成 runtime 正式认证。

提交前在 Python 3.11 环境重新验证：Gear Python 284 项通过、4 项跳过；TypeScript 训练回归 165 项通过；Gear 类型检查和构建通过。Hitch 基于最新 dev 的类型检查、构建、架构检查、语法检查和 7 项训练工具测试通过。

## 此前无提示 TB 完整四阶段实测

`codex/training-stages` 的真实 `tb21:build_loop` 已完成一轮：`FrozenTaskSource → HitchRolloutExecutor → PolicyDatasetBuilder → SlimeModelUpdater`，提交 update=1 的完整模型/optimizer/RNG checkpoint 并导出 HF。控制器用时 738.08 秒，GPU 作业计时 640.21 秒；未使用 Oracle 轨迹或人工奖励。这是 train-only 的 `fix-git` 单任务小批量诊断，不是完整 TB 成绩或正式 runtime 认证。

- 两条物理轨迹分别有 12/4 次模型调用、11/3 次 bash 操作，verifier 正常返回 reward=0/0；无 group resample。
- 实际训练 capture 与 native receipts 的 token、工具 mask 和 rollout logprob 完全一致。模型生成 token 为 838/261，屏蔽的工具/协议 token 为 695/660。actor/native 的加权 logprob 平均绝对差为 0.0143544，低于 0.1 的诊断阈值。
- 两个奖励相同，所以 advantage、loss、grad norm 均为 0。流程完成不代表任务解题能力提升。导出与父 HF 有 18 个语言张量的数值差异，这一差异不作为任务学习有效的证据。
- HF 导出共 632 个张量，全部形状匹配且有限；297 个视觉张量和 15 个未训练的 MTP 张量保持原值。独立 SGLang 进程确认服务路径是该已提交导出，生成 8 个 token，输出 logprob 有限。
- 本轮单卡运行价约 $0.534/小时；单轮上限为 3000 GPU 秒、163840 rollout tokens、80 步。GPU 实例继续运行，checkpoint 和 HF 导出保留在模型节点。
- 回归：Python 280 通过、4 跳过；TypeScript 165 通过；Hitch 专项 5 通过。

证据见 [四阶段提交审计](tb-four-stage-audit.json)、[实际训练 capture 审计](tb-training-capture-audit.json)、[独立 HF 重载](tb-export-reload.json) 和 [固定运行参数](tb-run-settings.json)。它们绑定同一个 request/checkpoint；本目录不包含权重或凭据。

调试修复了新版 Slime 缺少 `rollout_global_dataset` 字段的问题，以及 HF 下载缓存误计入 tokenizer 身份的问题。serving 模型快照排除 `.cache/huggingface`，实际 tokenizer 内容变化仍会被检测；trainer 和 dataset 快照继续保留这些路径。

Hitch 的固定终端 harness 补上通用执行系统指令，实测版本为本地隔离提交 `09eec43813d71c10d35f127cbeb24ac09db1e85c`（基于 `7165a89af937fec2549d5a3b962282e8098a8855`）。该提交记录此前实测版本，可用 [Hitch patch](hitch-terminal-prompt.patch) 重现；目前完整改动已基于上述最新 dev 整理到独立分支。原任务指令和 verifier 未改写。

## 早期原生更新诊断

- SGLang 加载完整 Qwen3.5-2B，权重约 4.27 GB。
- 一组两个样本，global batch=2，真实完成一次反向传播及 optimizer 更新。loss=0.01086977，grad norm=184.39009，训练与 rollout logprob 平均绝对差=0.0366931。
- 同步保存了模型、optimizer 和 RNG checkpoint；Slime 的 rollout checkpoint 编号为 0。
- HF 导出中的 `model.language_model.layers.0.input_layernorm.weight` 有 37 个元素变化，最大绝对变化为 0.0000152587890625。
- 共卡卸载、权重同步后，SGLang 权重版本从 1 变成 2，更新后的策略再次生成成功。
- 原生更新诊断用时 401 秒。随后独立补全导出，验证全部 632 个张量均为有限数值；新启动的 SGLang 从导出文件生成 8 个 token，输出 logprob 均为有限数值，重载诊断用时约 46 秒。
- Python 回归：276 项，272 通过、4 跳过。

原始有界证据见 [native-update.json](native-update.json)、[export-reload.json](export-reload.json) 和 [runtime-observation.json](runtime-observation.json)。第一份证据对应日志导入修复后的诊断；冻结模块补全在随后独立重载诊断中执行。本目录不包含权重或凭据。

## 本次适配

Qwen3.5 的 dtype/context 在 `text_config` 内，模型描述应读取语言配置并保留外层架构。新的 Slime 将日志模块移至 `slime.observability.logging_utils`，Gear 支持两个模块位置，仍会报告真实依赖缺失。

Slime 的语言训练导出没有包含 297 个视觉编码器张量和 15 个未启用训练的 MTP 张量。Gear 从固定父模型按原始字节保留这些冻结权重，并更新 safetensors index。任何缺失的已训练语言权重，以及启用 MTP 训练时缺失的 MTP 权重，都会拒绝导出。正常更新和 pending checkpoint 恢复导出都使用这一检查。该诊断不验证视觉任务或 MTP 训练能力。

本次 TB 超参数还开启 `offloadLogprobBackward: true`，配合原生 `--log-probs-chunk-size 256` 和 full recompute，将 softmax 反向保存的张量放到主机内存。小张量 [CPU 原生 Slime 等价性检查](offload-native-equivalence.json) 确认 logprob、entropy、梯度逐元素一致；实际 GPU capture 审计也已通过。该选项由 Gear 固定 hook 管理，原始 `--custom-*` 参数继续禁止。

CPU optimizer offload 必须同时开启 `--use-precision-aware-optimizer`。完整参数在 [argument-input.example.json](argument-input.example.json)，包含 2B 模型尺寸；不要套用 4B 参数或取消该模型的 embedding tying。

## 复现原生诊断

在 GPU 容器内安装当前分支 Python 包，准备实际 Slime/Megatron 路径并应用 Gear 对应导出和 checkpoint 补丁。观察到的版本记录在 runtime observation；它与旧的 Qwen2.5 runtime lock 不同，旧认证不能直接复用。

先下载上面固定 revision 的模型到 `/models/Qwen3.5-2B`。复制参数例子到 `argument-input.json`，把 `trainingDevices` 改成当前 `nvidia-smi --query-gpu=uuid --format=csv,noheader` 返回的真实单卡 UUID。以下路径均需按容器替换；输出目录每次使用新名称。

```sh
export PYTHONPATH="$PWD/python:$PWD/python/probes:/root/slime:/root/Megatron-LM"
timeout --signal=TERM --kill-after=45s 1800s python -u python/probes/slime_actor_smoke.py \
  --model /models/Qwen3.5-2B \
  --input argument-input.json \
  --output /runs/qwen35-native-01 \
  --minimum-host-memory-gib 60
```

本次节点可供 CPU offload 的内存充足；诊断另外要求至少 48 GiB 当前可用内存。该命令有意使用短上下文、8 个生成 token 和人工奖励，目的是验证 GPU 链路。真实 TB 运行仍按 [Terminal-Bench 示例](../../../../examples/training-loop/terminal-bench-2.1/README.md) 准备任务身份、controller、完整 spec 和当前 runtime 验证证据。

# Harbor 与原生 SGLang 轨迹联调（2026-09-08）

范围：本地 Harbor/Docker、Hitch daemon 与独立 worker 进程，经 SSH 转发访问 Vast 上的原生 SGLang 和 Gear exact gateway。worker 与控制端使用同一台 Mac 的 Docker Engine；这不代表远程 Harbor 主机验收。SGLang 由诊断脚本监督，尚未覆盖 Hitch 的受管理独立评估服务或完整 Gear 训练作业。

## 发现与修复

初始真实任务完成两次 bash 调用、三次模型生成，canonical run `run_b95df656c027441683a29636bf61fc61` 的 verifier 奖励为 1。但原生首轮输出包含解析器未投影到 wire reply 的残缺工具片段，下一次 chat template 重编码丢失了 38 个 token。样本连续性检查正确拒绝该轨迹，不能把这个任务成功当成训练样本通过。

`python/gear_training/history.py` 新增原生历史续接：先核对客户端完整重放了原 wire 消息、工具定义及按序对应的工具结果，再从模板的明确 EOS 边界提取分隔符和新观察，追加到原生 input/output token 后。原生生成的内容不会被解析器的结构化输出替换。没有 EOS、模板边界不稳定、旧历史被改写、工具结果缺失或错序均拒绝。实际 input 长度用于预算检查，工具观察继续由现有 sample assembler 标记为非训练 token。

已有请求的幂等重试读取原 receipt 中的 prompt；后续请求完成或仍未完成，都不会导致重试重新编码或再次生成。新请求不能跨过未完成或无效的原生证据。原 `Ledger.receipts` 对封存时非空、完整证据的检查保留。生成协议摘要增加 `native-token-prefix-tool-results-v1`，旧 runtime lock 不能静默沿用。

继续检查完整原生输出后，确认另一个适配问题：指定 Slime 的 `_build_reply_parts` 使用 `tool_calls[:1]`，会为了兼容其他客户端而只投影第一项。实际原生输出含两个完整工具块时，Hitch 仍只收到一个。Gear 新增 `wire.py`，复用 Slime 对单个调用的编码，完整返回每个已解析调用及独立 ID。固定 Hitch harness 已按序执行整个调用列表；历史续接同时要求每项工具结果完整、顺序正确。协议摘要增加 `all-sequential-v1`。不能把先前的过早结束仅归因于模型能力。

## 分层验证

- Python 95 项测试通过，覆盖 gateway、episode、controller、旧路径及新增历史/重试/全部工具投影拒绝条件。
- 使用固定模型 tokenizer、指定 Slime 中的纯模板翻译函数，在 CPU 上重放真实失败记录：原先 305/369 token 的后续 prompt 改为 343/407 token，完整保留原生前缀。CAS 会规范化 JSON key 顺序；重放从已捕获的 native prompt 恢复工具 JSON 顺序，并先断言三轮原始 prompt 的全部 token 与现场一致。这是模板重放，没有伪装成新的模型生成。
- 修复后第一次 GPU 复测的第二轮 input 为 343 token，完整保留首轮 319 token 前缀。模型只执行一次工具调用就结束，任务未完成；这轮不能算两次工具调用验收通过。
- 诊断任务随后改为先读取镜像内指令文件，再按指令执行第二次工具调用。verifier 在未完成时写 0、完成时写 1，避免把任务失败误报为基础设施失败；两个分支均在本地容器实测。
- 完整工具投影的 CPU 重放使用真实输出中的两个完整 JSON 工具块和指定 Slime 的实际 `_build_reply_parts` 源码：旧逻辑返回 1 项，修复后返回 2 项，参数、顺序和独立调用 ID 均保留；没有执行其中的命令或伪造新的生成。

传输诊断分别记录链路完整性和任务得分。有效 0 分是正常训练反馈；`status=passed` 只表示工具/receipt/身份检查通过，`task_reward` 和 `task_succeeded` 独立报告任务结果。至少两次顺序工具调用和后续模型回复仍为硬条件，允许同一模型回复发出多个顺序工具调用。

最终 GPU 复测通过传输完整性检查：Vast 实例 `50277447`，RTX 5090、固定 Qwen2.5-1.5B-Instruct，原生诊断耗时 120.116 秒；2 次模型生成、2 次实际顺序工具调用、199 个原生输出 token。canonical run 为 `run_19cbaa524e734473807aee85dccbd023`，eval 为 `eval_c2f0747f33e445018b6c0be9547fb0b0`。Hitch 的有序 receipt ID 与节点 ledger 完全一致，实际下一轮 input 保留此前完整原生 token 前缀，worker lease 已释放，公开文件未发现模型凭据。

**该任务奖励为有效 0 分，任务本身未完成。** 模型发出的第二项工具命令包含循环等待，由固定 harness 的工具超时终止；调用没有被适配器静默丢掉。该结果证明真实失败反馈及完整工具轨迹可以经过链路，不能声称任务得分通过或模型能力达标。此诊断没有执行 optimizer，仍需把真实任务奖励、sealed batch、backward、checkpoint collect 和独立评估接到同一 Gear 作业；runtime compatibility 与全局远程模型 capability 保持未开放。

8 次临时尝试从准备到销毁保守累计约 33 分钟（含停止后的日志回收），均为当时报价 $0.51593/小时，按此估算约 $0.284 算力费用；不含存储/传输，不是账单。用户要求增加时间并优先跑通后，本轮最终采用累计 35 分钟上限。临时实例全部销毁；原实例 `50249234` 保持停止。

## 原始记录

- 原生任务成功、精确历史失败：`/Users/tangyehui/.codex/artifacts/gear-hitch-native-temp-20260908-retry`。
- CPU 重放、源码摘要与回归日志：`/Users/tangyehui/.codex/artifacts/gear-native-history-fix-20260908`。
- 修复后单次工具调用的复测：`/Users/tangyehui/.codex/artifacts/gear-hitch-native-temp-20260908-history`。
- 完整工具投影后的有效结果：`/Users/tangyehui/.codex/artifacts/gear-hitch-native-temp-20260908-all-tools`，含原生 CAS/ledger、完整请求/响应、canonical trajectory、verifier、源码包及实例生命周期。执行探针 SHA256 为 `5219b8cfa4eb424d066664baaf7babacac611b95cf43356106d0eef4bddc179d`。
- 诊断入口：Gear `python/probes/hitch_native_gateway_smoke.py`、Hitch `scripts/canary-native-training.ts`。所有结果仍为 `validated=false`，这些记录不包含 native-to-optimizer 的完整闭环、checkpoint collect 或独立评估交接。

本地首次联调还暴露了环境准备问题：误用 pnpm 后，原平铺依赖被替换成符号链接，Hitch 打包拒绝。恢复原依赖、删除该操作新建的锁文件后，真实 CPU Harbor canary 重新通过；后续租机前增加运行时 payload 校验。该次没有 native 生成请求，实例取回日志后销毁。

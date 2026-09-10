# 原生概率回放及 Vast 停机保护

本记录补充数值诊断与资源回收的实际边界，不能替代完整执行位置验收。

## 第 38 轮：连接中断与停机回收

使用保留实例 `50316639`，不创建新实例。`python/probes/slime_logprob_replay.py` 从原生 actor 诊断的两个样本回放固定 token，保留原精度、采样和训练参数，使用固定 Slime 的 `--save-debug-train-data` 记录实际训练 forward；不重新生成、写 checkpoint 或导出权重。4 项 CPU 检查覆盖参数保留、上游 dump 的样本顺序、不同响应长度的汇总及原生 logprob 被修改后的拒绝。

本轮远端源码与模型摘要校验、真实参数解析通过。UTC 01:10:51 发出训练回放命令，01:11:04 SSH 返回 255。原始停机请求遇到 TLS EOF，随后本地 watchdog 的三次重试均超时并退出。连接恢复后，经 Vast CLI 重新请求并查询，确认实例为 `exited/stopped/stopped`；没有删除实例。

停机后通过 Vast copy 回收 8 个普通文件，三个输入文件与上传 manifest 摘要一致。`prepare/prepared.json` 保存实际解析配置；`native.log` 为零字节，`result/` 为空。**没有取得 actor 训练或逐 token capture 证据**，不能因 SSH 命令发出而计作训练完成。断连前没有取得远端输出的 SHA manifest，因此这里只证明输入一致与停机目录回收，不声称全部输出经过远端 SHA 对照。

原定 10 分钟停机上限没有实际停机回执支持，不能将本地计时器作为上限得到执行的证据。恢复后读取的当日账目快照显示：该实例 GPU 项为 0.023 小时、$0.011，磁盘项为 6.653 小时、$0.370，总计 $0.381。这是当时返回的当日累计数据，不是一次探针的精确账单，也不是未来最终费用。

证据位于 `/Users/tangyehui/.codex/artifacts/gear-logprob-replay-20260909-38`：`lifecycle.json` 保留原失败记录；`recovery-audit.json`、`vast-final-state.json`、`billing-observation.json` 记录后续回收和查询，不覆盖原事件。原始 API 响应保存在私有目录；不在公开制品中收录凭据。

## 停机保护改动

原本地 watchdog 在三次失败后退出的行为已识别为缺口。`vast_harbor_worker.py` 的同类逻辑改为持续重试，只有实际停止状态才结束；缺失实例或 API 超时仍视为未知，不作为释放证明。VM 的付费路径尚未执行，未因该修复开放第二台 VM。

新增 `python/probes/vast_instance_guard.py`，在实际 Linux 实例内启动独立进程。它只向固定 Vast 实例接口发送 `running` 的认证检查或 `stopped` 请求，不含删除操作。到期后持续重试；成功的请求回执仍记录 `stopConfirmed=false`，实际停止必须由控制端查询。时间预算同时使用墙上时间和单调时钟，回拨时钟不会延长已设定的期限。

凭据优先读取 Vast 的实例环境字段；SSH 未传递时，可读取容器 init 环境中的三个相关字段。也支持通过私有 SSH 标准输入提供原租用回执中的 `instance_api_key`，严格核对 `new_contract` 与目标实例相同，再由控制端核对实际 GPU 和冻结节点身份。账户级 API key 不传给模型节点；专用凭据仅由停机进程使用，不进入参数、状态文件或模型训练环境。Vast 官方说明该创建回执密钥只能控制对应实例，且支持从实例内部停止自身：[API 说明](https://docs.vast.ai/api-reference/hello-world)、[实例 FAQ](https://docs.vast.ai/guides/reference/faq/instances)。

16 项 CPU 检查通过：除既有 8 项 VM 边界检查外，新增检查覆盖实例身份、专用凭据来源及冲突、固定请求接口、超过三次失败后继续重试、请求接受不等于停止、时钟回拨与容器 init 环境字段限制。HTTP 响应和时钟为 fixture；这些检查不是实际断网后云端自动停止的证明。

第 39 轮的实际自停进程在身份字段校验处拒绝就绪，未开始 actor 训练；5 个远端文件在停机前完成 SHA 对照回收，UTC 06:48:13 确认停止并保留。该结果保留于 `gear-logprob-replay-20260909-39`，不将身份校验失败改记为保护成功。后续使用经创建回执绑定的专用凭据继续验证独立停机进程和实际训练 capture。

第 40 轮在旧 GPU UUID 检查处拒绝继续，UTC 06:56:15 确认停止。第 41 轮先记录实际设备，确认 Vast 已改分配另一张 RTX 5090；原 GPU 节点身份、账本及配置没有改写。本次实际 SSH 会话没有暴露 `CONTAINER_ID`、`VAST_CONTAINERLABEL` 或 `CONTAINER_API_KEY`，因此采用保存的原创建回执专用凭据，并严格核对 `new_contract=50316639`。凭据只经 SSH 标准输入交给保护进程；其 Linux PID、start ticks、boot ID 和认证均通过现场检查。

第 41 轮完成原生训练回放与逐 token capture，17 个文件通过远端 SHA 校验回收，UTC 07:03:30 确认停止。正常结束由控制端先停止，独立保护的期限没有到达；实际断网自停仍未验证。具体数值和审计见 [logprob 对照记录](logprob-reference-diagnostic-2026-09-09.zh-CN.md)。没有新增或删除云实例，也没有租用尚待授权的第二台 VM。

第 41 轮之后的账目快照为：当天该实例 GPU 累计 0.096 小时、$0.045，磁盘累计 7.180 小时、$0.399，总计 $0.444。快照保存在 `gear-logprob-replay-20260909-41/billing-observation.json`，不按一次回放精确拆账。`final-resource-observation.json` 同时记录新查询仍为停止状态，且本地 watchdog 已退出；本次无需继续付费运行 GPU 来整理证据。

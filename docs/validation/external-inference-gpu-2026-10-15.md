# 外部推理端点双卡短验收（2026-10-15）

Vast 单机 **2×RTX 3090 24 GiB** 上，SGLang TP=2 单副本和 SMG 1.12.0 + 两个 TP=1 副本均通过所测文本、串行 function 工具、SSE、并发与取消隔离检查；两个真实 Codex 工具任务通过。旧 bundled `sglang-router==0.3.2` 的 Responses 指定函数名请求被网关返回 400，不能用它的普通对话成功宣称该工具协议兼容。

[结构化结果、实际工具记录、原始证据 SHA-256](external-inference-gpu-2026-10-15.json)。这是用户要求的一次低预算短验证，不是性能、模型质量或完整训练验收。

## 固定组合与执行方式

| 项目 | 实际使用 |
| --- | --- |
| 代码 | Gear `04a7dd8adb783fdcfe514b6b663baa18701bbd6c`；Hitch `8736cea2c2992172e121b726bc4bc23aedc7fe66` |
| HTTP 探针 | `accept.mjs` SHA-256 `0c09994cc20bc0983d135b961066b7ebdaacea490861524e5cf5d974125a35a2`，包含待提交的 usage 字段别名校验改进 |
| 官方引擎镜像 | `lmsysorg/sglang@sha256:b1259f3ea3275f66237c498ea388919729018bc9f01c3d638391e06e2cf3f469`（v0.5.21） |
| 实测包 | SGLang 0.5.21、torch 2.13.0+cu130、transformers 5.12.1；driver 580.173.02 |
| 模型 | Qwen/Qwen2.5-7B-Instruct，revision `a09a35458c702b33eeacc393d103063234e8bc28`，BF16 |
| 权重准备 | 固定 revision 的 11 个文件、约 15.24 GB；核验 LFS SHA-256，文件只读，HF/Transformers offline |
| 工具解析器 | 请求 `qwen25`，引擎归一为 `qwen` |
| 生成 | wire model `qwen25-7b-a09a35458c70`，输出预算 1024 原样传递，temperature 0，串行工具 |
| 容量 | context 16384，mem fraction 0.82；每 worker running/queue 4/8；Gateway running/queue 8/16、queue timeout 30s；关闭透明重试 |
| 运行方式 | 在 Vast 启动的官方 SGLang 镜像内启动上游原生进程；本次没有执行 Docker Compose 容器 |
| 双副本网关 | 在独立 venv 安装官方发布 `smg==1.12.0` wheel，保留原有 SGLang workers；`smg launch`，round_robin、history none、disable-tokenizer-autoload、无可见 CUDA 设备 |
| SMG wheel | `smg-1.12.0-cp38-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`，SHA-256 `51a0da56293a9f0aab20788e665304c9e84a62a6bab2bb096c5b4014b6e5a1e2` |
| 真实 Harness | 官方 npm `@openai/codex@0.145.0`，Hitch prepare 固定完整性；在本地 darwin-arm64 执行工具，通过 SSH loopback tunnel 调用远端 Responses |

两个 GPU 无 NVLink。TP0/TP1 都完成 NCCL 初始化并各加载约 7.22 GB 权重；custom allreduce 因设备间 peer access 不可用而回退，生成仍通过。两个 rank 的日志、独立 GPU 计算进程和负载采样共同支持实际双卡执行，不能据此推断此拓扑性能理想。

## 结果

| 路径 | Responses HTTP | Chat HTTP | 实际工具任务 |
| --- | --- | --- | --- |
| SGLang 0.5.21，TP=2 单副本 | 9/9 PASS | 9/9 PASS | Codex 计算 README.md SHA-256，PASS |
| bundled sglang-router 0.3.2 + 两个 TP=1 | FAIL：named `tool_choice` 返回 400 | 9/9 PASS | `inspect --verify` 先失败，未执行候选任务 |
| SMG 1.12.0 + 同两个 TP=1 | 9/9 PASS | 9/9 PASS | Codex 读取 numbers.json、执行 Python 求和为 334，PASS |

每组 9 项包含：错误凭据拒绝；正常预算生成及真实 usage；完整多轮历史；文本 SSE 结束及 usage；JSON function 调用、真实本地工具执行、结果回传与继续回答；流式工具完整往返；两个独立并发请求；两个活跃流已有文本且未完成时只取消其中一个，另一个完成后新请求仍成功；每个预期 worker 的请求计数正增量。请求不做 token 补偿，也没有极小预算专项测试。

SMG Responses 的两个 worker 请求增量为 **6/5**，Chat 为 **3/4**；这些是对应测量窗口内的服务端计数，第二个实际任务与部分 HTTP 检查时间重叠，不是按 trial 归因计量。TP=2 双卡峰值利用率均为 100%；SMG 双副本两卡分别为 95%/100%。

实际任务通过 Hitch CLI 的 `models connect`、`models inspect --verify` 与 `run --harness codex@version:0.145.0 --max-output-tokens 1024 --temperature 0` 执行，使用独立任务目录。工具事件保存了真实终端命令和结果：

- SHA-256：`d9d6d3936408c612f3b13ccc7b3725603774c8cc44c541bd258eccc554ba7d0c`，2 个模型请求，input/output tokens **21262/161**。
- 求和：`[13,29,47,61,83,101] → 334`，4 个模型请求，input/output tokens **43830/461**。

这些 usage 是整个多轮任务累计值，1024 是每次模型请求的输出预算。工具执行发生在本地客户端；这次没有验证 Harbor/远程工具容器。

## 上游缺口与复用决定

旧网关失败请求为标准 Responses `tool_choice: {"type":"function","name":"lookup_delivery_code"}`，返回 `json_parse_error`：无法反序列化 `ToolChoice`。错误发生在网关，未到达 worker；原始失败及未执行的 Codex 尝试保留，未覆盖成成功。

官方独立后继 [SMG 1.12.0 发布](https://github.com/smg-project/smg/releases/tag/v1.12.0) 的 [Responses 协议类型](https://github.com/smg-project/smg/blob/v1.12.0/crates/protocols/src/responses.rs) 已支持该平铺函数选择格式；相关旧类型问题见 [SGLang #30781](https://github.com/sgl-project/sglang/issues/30781)。在本次硬件上使用正式 wheel 后，同一个严格探针和实际 Codex 任务通过。因此多副本示例独立固定 SMG 版本，不新增协议转换服务或维护 Rust/Python 补丁。示例官方 SMG 容器镜像只做配置解析，不冒充本次实际 wheel 的容器验收。

## 费用、清理与未覆盖项

只创建一个实例 `56025748`，小时总价 **$0.57556**（含 120 GB 磁盘），创建至确认销毁 **33.60 分钟**。本次上限 $1.10，设置独立销毁 watchdog 和远端停止期限；未触发追加租机或充值。

全部消费者结束后，部署所有者停止自有模型/网关进程，确认 GPU compute process 列表为空；随后销毁实例，Vast 列表再次确认实例不存在。销毁确认时间 **2026-10-15 02:45:05 UTC**。当前观测余额差额 **$0.26485**，结算可能延迟；按完整时长与镜像/模型下载流量保守预估 **约 $0.45**，不是最终发票金额。

未覆盖：单个 TP=1 直连的独立验收、Compose 实际容器启动、静态训练/推理分卡并行、训练 rollout 与 HF export 实机回归、Gear 严格候选 ready-binding/可信 CAS 部署流水线、完整 Harbor benchmark、daemon 跨进程并发实机测试、全部 Harness、性能压测、并行/自定义工具的一般兼容性、多模态及完整 Responses API。固定 HF 文件哈希的操作员记录不能代替 Gear 的可信候选部署回执。

原始脱敏 HTTP 报告、服务器/rank 日志、GPU 采样、清理记录和任务轨迹保存在本次本地私有验收目录；公开 JSON 仅包含摘要、所测工具事件及原始文件/归档哈希，不含凭据或远端连接地址。

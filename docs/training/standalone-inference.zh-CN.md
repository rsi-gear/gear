# 通过模型端点进行独立评测

Gear 评测调用已部署的模型 API。Hitch 管理任务和请求；部署所有者与上游 SGLang/Model Gateway 管理模型加载、副本、GPU 分配和服务恢复。训练 rollout 的精确 policy token、lease/fencing、Slime 同步、checkpoint 与不可变 HF 导出继续使用现有训练链路。

[Hitch 固定版本上游部署示例](https://github.com/rsi-gear/agent-hitch/tree/main/examples/external-inference)提供 SGLang 单副本、TP=2 变体、官方 Gateway 两个 TP=1 副本和一次性标准 HTTP 验收工具。普通 Hitch 客户端无需安装自研推理 wheel、Python、CUDA 或引擎；训练与任务工具保留自身实际依赖。

## 注册并验证端点

端点 JSON 显式选择 `responses` 或 `chat-completions`，声明版本化 `wire_model`、文本/SSE/工具能力及环境变量凭据引用。API 根地址保留路径前缀。完整 JSON 与 ready binding 示例见[英文说明](standalone-inference.md)。

```sh
hitch models connect --name baseline-001 --file endpoint.json
hitch models inspect endpoint/baseline-001 --verify --json
```

`connect` 只保存连接，不部署或下载模型。`inspect` 返回公开绑定及不可变 `endpoint_ref`、`endpoint_revision`；注册时 `generation` 为空，实际生成参数在本次 ready binding 中冻结。verify 验证协议行为，不能证明实际加载了某组权重。首版只验证串行 function 工具往返，`parallel_tool_calls` 必须为 `false`。只使用已通过所选 Harness 验证的协议，不自动探测或转换。Worker/Harbor 必须能实际访问端点，凭据必须在真正向上游发请求的进程中可用；容器的 `127.0.0.1` 不代表 GPU 宿主机。

## 按不可变模型版本准备绑定

external-file 模式的 v1/v2 controller 配置私有 `evaluationBindings`；v2 新实验也可显式冻结[managedNative 原生部署](managed-native.zh-CN.md)，自动多轮入口见[迭代指南](unattended-iteration.zh-CN.md)。以下为 external-file 配置：

```json
{
  "evaluationBindings": {
    "bindingsFile": "/srv/gear/deployments/by-hf-digest.json",
    "trustedReceiptSources": ["ci-gpu-deploy"]
  }
}
```

映射文件结构为 `{"schemaVersion":1,"bindings":{"sha256:<实际 HF snapshot 摘要>":"/绝对路径/model.ready.json"}}`。baseline 和每个 candidate 分别按 `model.hfSnapshotRef.digest` 查找；不能让所有版本共用一个会原地换权重的“当前模型”别名。

机器可读合同见[ready binding JSON schema](../schemas/ready-evaluation-endpoint-binding-v1.schema.json)。可复制[ready binding 模板](../../examples/training-loop/terminal-bench-2.1/endpoint-binding.example.json)和[digest 映射模板](../../examples/training-loop/terminal-bench-2.1/evaluation-bindings.example.json)，先替换全部占位符。ready 文件包含 `schema_version="1"`、`kind="external-endpoint"`、`endpoint_ref`、`endpoint_revision`、`api`、`wire_model`、`capabilities`、明确的 `generation`、`deployment_receipt` 和私有 `connection`。从 `models inspect` 复制必需公开字段，去掉诊断字段 `identity_verified` / `verification`；connection 与注册 revision 必须一致。生成参数例如 `{"max_output_tokens":1024,"temperature":0}`。

回执必须含 `schema_version="1"`、`model_digest`、`wire_model`、`deployment_ref`、`source`、`service_config`。其中 model digest 等于待评 HF snapshot，wire model 等于绑定，source 属于 controller 的可信来源。部署流程需要实际核对不可变挂载及回执来源；自填 source、digest 或 `/models` 回显不能代替加载证明。公开 `service_config` 记录 engine/version/digest、量化、工具/推理解析器、tokenizer/template digest、缓存与隔离条件，不能包含连接 URL、认证或 secret。

external-file preparer 读取外部文件，不自动部署。缺少映射或 ready 文件时持久化 `endpointPreparations.status="waiting"` 并报告 `waiting-for-deployment`；补齐该模型版本的绑定后继续同一运行。提交 eval 前保存准备意图和冻结绑定，崩溃后复用；重试不重新解析可变别名、不提前发布 candidate。不同版本可用独立端点或固定模型名，不要求全部同时常驻显存。managedNative 可自动准备自属服务，重建实例时通过有界显式 attempt 保留原绑定与有效槽位；外部长驻端点仍没有 Gear 启停权。

## 公共比较条件与并发

实验配置使用 `evaluation.provider="hitch-endpoint"`、`evaluation.topology="harbor-dataset"`：

| 公共字段 | 计算值 |
| --- | --- |
| `evaluation.common.runtimeDigest` | `digestJson(binding.deployment_receipt.service_config)` |
| `evaluation.common.protocolDigest` | `digestJson({api: binding.api})` |
| `evaluation.common.samplingDigest` | `digestJson(binding.generation)` |
| `evaluation.common.budgetsDigest` | `digestJson(controller.hitch.budgets)` |

使用现有 canonical `digestJson`，不能对排版后的 JSON 文本随意取哈希。权重与固定 Harness 属于 subject；端点 revision、模型名、回执及连接属于 binding。candidate 专属身份不进入公共 condition，但引擎、量化、解析器、tokenizer/template、缓存与隔离策略等仍影响可比性。条件改变时重新建立 baseline。

`hitch.budgets.maxConcurrent` 是 trial 并发，不是 GPU 或副本数量。引擎和 Gateway 上限由部署者配置。预算直接透传，使用 1024、4096 等正常业务值，不加 `+2`，不以极小预算作为验收门槛。严格评测关闭 Gateway/SDK/Harness 的透明重试和跨模型 fallback，已开始的流不能透明重放。

## 资源、取消与计量

新 `resources` 仅含 `trainingDevices`：v1 为 UUID 列表，v2 为 `{nodeId,gpuUuid}` 列表。v2 使用 `deployment.gpuScheduling.trainEvaluation="isolated"`。部署所有者静态保留推理卡，并限制 trainer 只访问训练卡。`actorRollout="colocated"` 仍是训练内部布局，不能用于普通评测共卡。仅设置设备可见性不构成跨作业互斥。

评测完成、取消、超时只结束自身任务和请求，不 stop/drain 服务、不 flush cache、不释放推理 GPU、不影响其他消费者。`evaluationTasksCompleted` 与训练 `resourcesReleased` 分开；推理资源释放仅由部署/资源所有者证明。

评测记录实际返回的 token、请求次数和时间。没有可靠部署侧计量时，推理 `gpuSeconds` / `gpuSecondsSource` 为 `null`，不能写 0，也不能把整池费用重复计入每个 eval。新实验预算必须显式设 `gpuSecondsScope="training"`，此时 `totalGpuSeconds` 只覆盖训练；当前拒绝 `gpuSecondsScope="total"`，避免未知推理费用被遗漏。训练累计计量继续去重并保持单调。

显式发布通过保留的 CAS/模型导入流程保存获批制品指针 `hitchModel=local/<digest>`；该指针不创建可调用服务。后续推理需要另行为获批 snapshot 准备端点绑定。

## 验收与历史证据

2026-10-15 的有界 GPU 验证已覆盖真实 SGLang TP=2、官方 SMG 的两个 TP=1 worker、两种 API、分布/取消隔离和实际 Codex 工具任务，见[推理拓扑记录](../validation/external-inference-gpu-2026-10-15.md)。另一次[训练与端点评测诊断](../validation/training-gpu-loop-2026-10-15.md)在 GPU 0 执行真实 Slime rollout、一次更新及 native/HF 导出，GPU 1 运行普通 SGLang TP=1 服务；实际本机 Harbor/Docker 的 baseline 和 candidate 通过严格端点验证及证据配对，均为有效 reward=0、meanDelta=0。该轮明确 `validated:false`、runtime lock 为 `pending-gpu`；零 loss/梯度不证明学习提升或正式认证。完整本机制品全闭包与离线 finite 复核已通过（108 个对象、35,467,670,234 字节），精确租机销毁已确认；Compose 容器、完整 Harbor benchmark、远程 Harbor worker 与 held-out 质量尚未验收。CPU/受控 HTTP 检查只证明软件合同。

两仓库构建后，在 Gear 根目录运行实际 CLI/daemon 软件合同检查：

```sh
GEAR_TEST_HITCH=/absolute/path/to/agent-hitch/dist/bin/hitch.js node scripts/check-training-endpoint-contract.mjs
```

它使用受控标准 HTTP 端点与真实 Hitch CLI/daemon，验证注册、协议、绑定接受/拒绝和公开信息脱敏，不执行 Harbor 或 GPU 引擎。

历史 lock、证据和认证保持原摘要与含义，不证明新上游部署通过；旧任务不能静默改绑。旧服务仍运行时，先用旧版本部署工具停止并确认释放，再移除环境；删除账本不是进程或 GPU 释放证明。完整边界见[端点规范](../model-api-inference-service-spec.zh-CN.md)。

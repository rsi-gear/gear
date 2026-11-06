# v2 controller 与模型节点配置

v2 的配方与离线 SFT 使用方法见 [版本化配方指南](recipes.zh-CN.md)。SFT 训练采用 actor-only GPU 分配，独立评估仍沿用本文部署。

新建实验还可显式选择[受管原生候选部署](managed-native.zh-CN.md)和[无人值守多轮迭代](unattended-iteration.zh-CN.md)。下方 `evaluationBindings` 示例说明 external-file 模式；已有实验不会因 controller 配置变化自动获得部署授权。

v2 将任务执行留在控制端，把训练交给固定身份的模型节点；独立评估连接部署所有者准备的外部模型端点。本文说明配置与恢复合同；正式实机认证范围见 [单卡认证记录](https://github.com/rsi-gear/gear/tree/b1baa88799771cafde5ec9704291e5dc2f25a601/docs/training/certifications/2026-09-10-rtx5090-single-gpu)。另有 [2026-10-15 双卡推理记录](../validation/external-inference-gpu-2026-10-15.md)及[静态分卡训练/端点评测诊断](../validation/training-gpu-loop-2026-10-15.md)，覆盖本机 Harbor / Docker、远程训练节点的一次真实更新与 native/HF 导出、普通端点基线/candidate 配对；后者仍为 `validated:false` / `pending-gpu`，reward/loss/grad norm 为 0，不构成学习提升或正式认证。完整本机制品全闭包与离线 finite 复核已通过（108 个对象、35,467,670,234 字节），精确租机销毁已确认，远程 Harbor worker 与完整 benchmark 未验收。

## 控制端

Gear、Hitch、任务快照与 canonical/verifier 证据保留在控制端。控制端 Python 用于 CAS materialize，不要求装 CUDA。示例路径需要替换；`training-node` 是用户 SSH 配置中的 Host 别名。

```json
{
  "schemaVersion": 2,
  "storeRoot": "/srv/gear-controller/content",
  "artifactStorage": "model-node",
  "deployment": {
    "schemaVersion": 2,
    "taskExecution": { "placement": "local", "provider": "local-docker" },
    "modelRuntime": { "nodeRef": "gpu", "launcher": "process" },
    "gpuScheduling": { "actorRollout": "colocated", "trainEvaluation": "isolated" },
    "nodes": {
      "gpu": {
        "transport": { "type": "ssh", "host": "training-node" },
        "workspace": "/workspace/gear",
        "python": ["/opt/training/bin/python"],
        "configPath": "/workspace/gear/node.json",
        "gateway": { "localPort": 31000, "nodePort": 31000 }
      }
    }
  },
  "evaluationBindings": {
    "bindingsFile": "/srv/gear-controller/deployments/by-hf-digest.json",
    "trustedReceiptSources": ["ci-gpu-deploy"]
  },
  "episodeTimeoutSeconds": 900,
  "hitch": {
    "command": ["node", "/srv/agent-hitch/dist/bin/hitch.js"],
    "root": "/srv/hitch",
    "workspace": "/srv/gear-controller/execution",
    "harnessSourceDirectory": "/srv/agent-hitch",
    "python": ["/opt/controller/bin/python"],
    "budgets": { "timeoutSeconds": 900, "setupTimeoutSeconds": 1800, "maxConcurrent": 1, "maxEpisodeSteps": 16, "infrastructureRetries": 0, "maxRepairRounds": 1 }
  },
  "activationPath": "/srv/gear-controller/releases/active.json"
}
```

`deployment.nodes.gpu.gateway` 只承载训练生成，本机 transport 的 localPort/nodePort 必须相同。external-file 模式的独立评估连接来自 evaluationBindings 的冻结 ready 文件，controller 不启动或回收外部长驻服务，其网络与凭据由部署环境准备。显式授权的 managedNative 模式使用私有 profile 固定评测 GPU、Supervisor 和独立普通模型隧道；具体配置及准备/观察/消费/释放合同见[受管原生部署](managed-native.zh-CN.md)。

SSH 配置默认使用 `artifactStorage="model-node"`，训练权重和 optimizer/checkpoint 留在远端 CAS。控制端收集有界元数据和持久化回执，并独立核验自己保管的任务/verifier 依赖。候选评估取得匹配 HF snapshot 的可信部署回执和端点绑定；显式发布使用保留的 Gear CAS 制品传输与 Hitch 本地模型导入，见文末。

初始 HF 模型已在节点上时，使用 `gear training seal-hf-node /workspace/models/parent --config CONTROLLER.json`，在节点完成 safetensors/有限数值检查并回传描述。模型节点缺文件、代际漂移或回执不完整均会拒绝完成收集。迁移需复制并核验原制品；节点身份变化后必须重新冻结部署。

## 模型节点

节点安装与控制端对应版本的 Gear Python 包以及锁定的 Slime / Megatron / SGLang / torch 运行时。纯模型节点无需 Hitch CLI 或 Docker。`node.json` 示例：

```json
{
  "schemaVersion": 2,
  "nodeId": "training-model",
  "nodeRoot": "/workspace/gear/node-state",
  "storeRoot": "/workspace/gear/content",
  "jobConfigPath": "/workspace/gear/job.json"
}
```

`job.json` 示例：

```json
{
  "schemaVersion": 2,
  "storeRoot": "/workspace/gear/content",
  "jobsRoot": "/workspace/gear/jobs",
  "slimePath": "/workspace/slime",
  "megatronPath": "/workspace/Megatron-LM",
  "gatewayBindHost": "127.0.0.1",
  "gatewayPort": 31000,
  "controllerTimeoutSeconds": 60,
  "episodeTimeoutSeconds": 900,
  "toolParser": "qwen25",
  "reasoningParser": null
}
```

node RPC 注入实际 node identity/generation 与 nodeRoot；不要自行填写进程 incarnation。v2 job 明确拒绝 `hitchRoot`、`hitchPath`、`hitchCommand`。`toolParser` 和模型参数仍须按具体模型选择并通过探针；这里没有宣称任意 Qwen 模型已兼容。

## 冻结前的分节点检查

准备好上述配置并启动 Hitch daemon 后，先执行不需要实验 ID 的检查：

```sh
gear training preflight-deployment --config /srv/gear-controller/controller.json
```

返回 `training-deployment-preflight`，每项包含 `scope`、`target`、`code` 与 `passed` / `blocked` / `unverified`。控制端检查 Hitch 源码与 binding/harness 能力、Python bridge；Harbor worker 检查自身 Harbor/Linux Docker 环境与版本、常驻进程身份和模型路由能力；模型节点通过实际 probe 固定 node/generation 后，检查 job 配置、Slime/Megatron checkout 与修改摘要、export 扩展、torch/SGLang/Ray/psutil、CUDA、GPU 清单/计算进程、主机可用内存，以及训练 gateway 端口。节点故障不会取消其他可独立执行的检查，错误正文、凭据和源码路径不进入报告。

模型节点不调用 Hitch、Harbor 或 Docker，不创建训练 job、启动模型服务或申请 GPU lease。训练内部 `colocated` 最少需要一张可观察且空闲的 GPU；`disaggregated` 最少两张。这里检查训练设备池下限，正式请求仍按实际 DP 和冻结的 GPU UUID 校验。外部推理卡由部署所有者在同机或另一主机静态保留，并限制两侧设备访问，不计入训练 resources。显卡进程读取失败不会被视为空闲。RAM 和显存只报告当前容量，尚不证明所选模型、batch 和卸载峰值能容纳。

`readyForRuntimeProbes=true` 表示这些静态与现场依赖检查没有 blocker，`runtimeValidation` 仍是 `not-certified`。真实 sandbox→模型路由保持 `unverified`；返回的 `remainingValidation` 列出设备分配、原生 token/logprob、反向传播、checkpoint/export/reload、训练内部共卡内存/权重切换及外部评估端点就绪等剩余验证。检查不会写入 probe evidence 或把运行时改为 `validated`。

## 冻结与执行

先启动控制端 Hitch daemon，确保目标 provider 已注册。然后调用：

```sh
gear training freeze-deployment --config /srv/gear-controller/controller.json
```

返回 `deployment` 与 `observation`。将前者放入完整 schemaVersion=2 spec；GPU 资源写成 `{ "nodeId": "实际节点 ID", "gpuUuid": "实际 UUID" }`。后者包含注册能力、daemon/worker 的现场版本观察与模型节点环境观察，不能代替 sandbox 路由或 GPU 数值验收。一个 provider 首版只允许一个注册 worker；heartbeat、当前负载、daemon instance 与本次 nonce 不进入身份摘要，worker generation/碰撞域/平台/backend 和实际环境会进入。远程 worker 的现场观察已接入，但完整远程训练/managed-model capability 尚未公开，远程任务部署仍会在相应能力检查处拒绝冻结。

v2 spec 使用 `evaluation.provider="hitch-endpoint"`、`evaluation.topology="harbor-dataset"`，resources 仅含 trainingDevices。不能保留 v1 trainer.placement，训练内部布局由冻结 deployment 表达；trainEvaluation 必须为 isolated。评估公共 runtime/protocol/sampling 条件分别从可信回执 service_config、显式 API 和 generation 取 canonical digest，详见[端点比较条件](standalone-inference.zh-CN.md#公共比较条件与并发)。

新建纯 Python 进程实验时，`trainer.runtimeLock` 使用 `schemaVersion=2`，以以下字段替换 v1 的顶层 `imageDigest`（这是合同片段，其余源码 commit、Python/CUDA/包版本、bridge/protocol/patch 摘要与 probe 字段仍须填写）：

```json
{
  "schemaVersion": 2,
  "runtime": {
    "kind": "python-env",
    "nodeRuntimeDigest": "sha256:<freeze-deployment 返回的 modelRuntime.runtimeDigest>",
    "outerImageDigest": null
  }
}
```

`nodeRuntimeDigest` 必须等于冻结的模型节点环境摘要；正式 preflight 再与实际 Python 环境核对。纯进程安装不要求声明镜像；若云环境使用外层镜像并通过 `GEAR_TRAINING_IMAGE_DIGEST` 证明其摘要，`outerImageDigest` 必须填写相同真实摘要，不能填可变 tag。`null` 与有值也不能互换，变化后需重新冻结和验证。

v1 实验只接受原 schema 1 lock；已有 v2 实验仍能沿用 schema 1 lock，其镜像证明规则和原摘要保留。不会自动把旧 lock 升级为 Python 环境 lock。新 lock 的 probe 身份与 checkpoint 兼容摘要独立计算，旧运行时的 probe 不能证明新环境已通过 GPU 验收。

`validate` / `init` / `admit` / `preflight` / `advance` / `status` / `pause` / `resume` / `close` / `publish` / `rollback` 使用原命令形式。v1 实验继续使用 v1 controller；不会自动升级已有 CAS/spec。`advance` 仍是一次协调调用，需要持续调用并保持在 controller contact 期限内。

v2 preflight 与每次 episode 协调会核对 provider 和模型节点观察；改变部署需新建实验。停止/取消仍按原身份协调，失联不会改投其他 provider。训练 runtime 的 validated probe 条件继续生效，尚未验证的 GPU lock 不能成为正式训练请求。

缺失的基线先按其不可变 HF 版本准备外部绑定并评估，任务结束后再运行完整训练 preflight；外部共享模型服务继续运行。基线尚在运行时，下一次 advance 继续协调原评估，不重新部署。训练提交意图已经落盘但回复丢失时，直接用原 key 协调提交；不会要求这个可能已启动的作业先让出显卡。新作业的节点 preflight 仍生效，基线结束后的环境变化也会阻止提交。

`trainEvaluation=isolated` 允许独立端点评估与训练进程清理重叠；每次 advance 继续读取未释放训练 owner 的累计用量。最终决定等待训练资源已释放且评估任务/请求已结束，不等待共享服务释放 GPU。pause 分别协调训练和所有未完成评估，一侧失联不阻止另一侧取消；训练 resourcesReleased 与 evaluationTasksCompleted 均满足才进入 paused。迟到的基线检查、合法导出或评估结果不能自行恢复运行、启动下一分区或晋级，已验证结果保留到显式 `resume`。

v2 训练使用独立于 request/job/checkpoint 摘要的 `trainingControl={schemaVersion:2,sequence,action}`。控制端先持久化 start/pause 意图，节点以同一作业锁保存指令顺序；暂停可先于首次提交建档，不上传模型、不创建 worker、不申请设备。后到的旧启动或旧暂停被拒绝，相同序号不能改换含义。`submit` 的初始序号重试只协调原 incarnation，失败或中断后必须显式 `resume` 产生较新的 start；恢复仍要求旧物理资源和旧 episode 都已结束。

节点声明 `orderedTrainingControl=true` 后才能通过 v2 训练 preflight；旧节点不会退回无序 submit/cancel。已进入有序控制的 job 也拒绝旧修改接口。控制端把节点指令/状态读取和相关 episode 协调放入同一个作业锁，避免旧暂停回复在恢复后取消新 episode。此锁不跨主机共享，模型节点的指令序号和设备账本仍是实际启动/释放的依据。v1 作业接口保持原形式；已有 v2 job 不改写原身份，带取消标记的旧作业需要明确的新恢复意图。

独立评估使用单独的 `evaluationControl={schemaVersion:2,sequence,action}`，要求 Hitch 声明 `ordered_eval_control="2"`。Gear 为每条指令保存不可变文件，通过公开 `eval control`、`eval submit --control-file` 和 `eval rerun --control-file` 传递。首次提交前的暂停也会在 daemon 中保留原 key 与 eval ID；迟到启动、旧取消及已取消 repair ID 不能重新启动任务。显式恢复沿用原评估身份，新修复轮次使用新 rerun ID；跨训练 run 复用基线 key 时延续更高序号。v1 保留原接口。若 daemon 已提交评估而本地原 journal 丢失，取消会报告身份/清理信息缺失，不假定资源已释放。

每次 advance 继续收集训练后端累计 GPU 用量及 evaluator 的实际任务 usage。新预算显式选择 gpuSecondsScope=training，totalGpuSeconds 只覆盖训练；缺少可靠推理计量时 total 覆盖范围在配置阶段被拒绝。共享推理 gpuSeconds/gpuSecondsSource 保持 null，不能补 0。达到训练预算时有序暂停并继续收尾，训练资源释放与评估任务结束后进入 paused；预算耗尽不能再次 resume。首次 intent 尚无 evaluator journal 时保持用量未知，只协调同一身份，不当作零成本或物理释放证据。

已有累计计量继续按原身份去重并保持单调，迟到结果不能降低较新的已知费用，未知计量不会覆盖已有观察。控制端观察依赖 advance；训练节点账本在控制端离线时继续累计。历史 evidence 保留原成本和摘要，不扩写为新共享推理的硬件证明。新的官方 SGLang / SMG 拓扑及静态分卡已有独立有界实机记录，见本文开头链接；诊断结果不自动将 runtime lock 变为 validated。

`freeze-deployment` 要求 Hitch 的 `controller_runtime_observation="2"` 与 `local_execution_observation="2"`。先调用 `hitch training runtime --json` 观察 CLI 包，再通过 `hitch worker observe local-docker --nonce HEX --json` 请求 daemon 的新观察。daemon 在启动、开放 HTTP 前保留 runtime 摘要，观察时再次读取磁盘；启动摘要、当前摘要和 CLI 摘要必须一致。daemon 启动后重新构建或切换 checkout，需要重启 daemon。该机制检查启动后是否漂移，并非对 Node 已缓存模块的逐字节证明；不要在 daemon 启动过程中替换运行包。

上述 runtime 摘要覆盖编译代码、training-tool 和 Harbor bridge，并包含 Node 版本、包自身的 Git commit 与代码修改状态；部署中不记录本机绝对路径。训练 preflight 另核对 `trainer.runtimeLock.hitchCommit`，不同 commit 会在 episode 提交前拒绝。无自身 checkout 的安装包不能借用父目录仓库的 commit；当前 v2 训练要求使用可观察的 Hitch 源码 checkout。

现场环境观察只运行固定的只读命令：Harbor `--version`、Docker `info` 与 `buildx version`。Hitch 使用 daemon 的实际环境和 Harbor/Docker 选择规则，记录可执行文件摘要、Harbor 版本、Docker engine ID/版本/系统/架构与 buildx 插件版本。Harbor 或 Linux Docker engine 不可用时，冻结拒绝；buildx 可用与否独立记录，不等于 BuildKit builder 已通过验收。Harbor 可执行文件摘要也不代表完整 Python 依赖环境摘要。响应不包含 executable 路径、环境变量或原始错误输出，sandbox 明确为 `unverified`。此观察本身不会拉取镜像、安装工具或执行任务；实际容器、Harbor→模型代理与 GPU 的有界诊断见本文开头记录，不由环境观察自动证明。

远程 provider 可单独通过 `hitch worker observe PROVIDER --json` 观察。worker 注册文件的 `features` 需要增加 `"execution_observation": "2"`，并运行支持它的 `hitch worker run`；这只是协议声明，不能代替实际回复。新字段省略时，旧 v1 worker 注册与任务执行行为保持原样。若调整已有注册，仍使用原注册命令取得新的 generation 和凭据，不能继续使用旧凭据。

daemon 经当前 worker bearer/generation 通道发出短期 challenge，包含独立 request ID、本次 nonce、daemon instance、worker/碰撞域身份和到期时间。worker 在后台运行固定探测，使用 `worker run --harbor/--docker` 或原环境选择；探测不占任务资源，不阻塞任务心跳。请求断开、超时、generation 变化或 daemon 重启后，不接受旧 challenge 的回执。此类只读观察不持久复用，失败后重新观察即可；它不更改 task lease 或资源所有权。

远程观察分别返回 daemon 和 worker 的启动/当前 runtime，控制端只检查自身 runtime，不要求安装本地 Docker。Gear 要求 worker 的实际 Hitch payload/package 与控制端一致；worker 的 Node 版本可以不同，但会进入冻结身份。worker 使用无 Git checkout 的同内容安装包时，source 可为 `unavailable`，不能伪造源码 commit；如能观察到自身 Git checkout，则 commit 也必须匹配。以上仍是版本和环境观察，不构成远程 sandbox 或模型路由验收。

## 外部评估端点绑定

v1/v2 controller 的 `evaluationBindings` 指向按不可变 HF snapshot digest 索引的外部 ready 文件。完整映射、binding、可信部署回执和公共比较 digest 见[独立评测端点](standalone-inference.zh-CN.md)。需要先为 baseline 准备自己的版本绑定；新 candidate 导出后等待自己的绑定，不使用旧模型顶替。

external-file 缺少绑定时状态保留为 running，并持久化 waiting-for-deployment / endpointPreparations 等待记录；补齐外部产物后继续同一运行。该模式提交前保存准备意图与冻结绑定，preparer 不自动启动引擎，不提前调用 publish。Hitch daemon 重启、任务取消或超时均不改变外部模型服务的生命周期。managedNative 的所有权、显式跨实例 attempt 与实验级暂停/恢复单独遵循[无人值守迭代指南](unattended-iteration.zh-CN.md)，不会静默改写已有 external-file 实验。

## 显式发布与回滚

```sh
gear training publish EXP_ID --config /srv/gear-controller/controller.json
gear training rollback EXP_ID RELEASE_ID --config /srv/gear-controller/controller.json
```

`artifactStorage="model-node"` 保留训练权重和 optimizer/checkpoint 的远端 CAS。显式发布或回滚通过现有 Gear 制品传输下载并校验批准的 HF snapshot 和文件，再在 Hitch 本地目录注册模型；文件、tokenizer/template 或冻结节点身份不匹配时拒绝更新 activation。

成功后 activationPath 原子记录获批版本及 `hitchModel=local/<digest>` 制品指针。该指针不部署服务，也不是可调用模型端点。业务推理要为对应不可变 snapshot 单独准备端点绑定，已经提交的任务继续使用自己的冻结绑定。候选评测的准备阶段不会执行发布或修改 activation。

## 训练节点与任务恢复边界

训练节点重启后，旧作业释放仍须结合归档启动身份和训练设备账本核验；不能用旧 PID 终止新启动周期的进程，也不能把旧 checkpoint/job 静默改绑。新的训练部署需要重新冻结和验证。普通评估只收敛自身任务和请求，训练资源是否释放由训练后端报告，推理服务资源由部署所有者报告。

远程 worker 再注册或撤销后，旧 generation 的在途状态提交和制品发布仍须按原 execution/资源身份核对；新 worker 的空闲报告不能替代旧任务的清理证明。任务执行环境的进程、主机启动和 Docker engine 归属由 Hitch 原有任务资源协议处理。这些 CPU/HTTP 合同检查本身不代表跨主机 Harbor/GPU 验收；新的上游拓扑与本机 Harbor 加远程 GPU 诊断已有本文开头的独立实机记录，仍不覆盖远程 Harbor worker。

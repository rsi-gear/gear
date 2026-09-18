# v2 controller 与模型节点配置

v2 将任务执行留在控制端，把训练与推理交给固定身份的模型节点。本文说明配置与恢复合同；实机通过范围见 [单卡认证记录](https://github.com/rsi-gear/gear/tree/b1baa88799771cafde5ec9704291e5dc2f25a601/docs/training/certifications/2026-09-10-rtx5090-single-gpu)。当前验收覆盖本地 Harbor / Docker 加远程单卡模型节点，远程 Harbor 和双卡尚未验收。

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
    "gpuScheduling": { "actorRollout": "colocated", "trainEvaluation": "sequential" },
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
  "evaluationGateway": { "localPort": 32000, "nodePort": 32000 },
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

`deployment.nodes.gpu.gateway` 只承载训练生成；`evaluationGateway` 只承载 Hitch 的独立评估服务。两个端口对必须不同，本机 transport 每一对的 localPort/nodePort 必须相同。Hitch 的模型连接由这个 controller 自动生成，不另设可漂移的服务 URL。

SSH 配置默认使用 `artifactStorage="model-node"`，训练权重和 optimizer/checkpoint 留在远端 CAS。控制端收集有界元数据和持久化回执，并独立核验自己保管的任务/verifier 依赖。Hitch 的 `models add-node SNAPSHOT_REF.json --model-node-file BINDING.json --name NAME` 从该节点校验并注册模型；`models inspect NAME --verify --model-node-file BINDING.json` 在同一节点核验实际文件。普通本机核验仍要求本机权重存在，不会自动下载远端模型。

初始 HF 模型已在节点上时，使用 `gear-refine training seal-hf-node /workspace/models/parent --config CONTROLLER.json`，在节点完成 safetensors/有限数值检查并回传描述。模型节点缺文件、代际漂移或回执不完整均会拒绝完成收集。迁移需复制并核验原制品；节点身份变化后必须重新冻结部署。

## 模型节点

节点安装与控制端对应版本的 Gear Python 包以及锁定的 Slime / Megatron / SGLang / torch 运行时。纯模型节点无需 Hitch CLI 或 Docker。`node.json` 示例：

```json
{
  "schemaVersion": 2,
  "nodeId": "training-model",
  "nodeRoot": "/workspace/gear/node-state",
  "storeRoot": "/workspace/gear/content",
  "jobConfigPath": "/workspace/gear/job.json",
  "inferencePort": 32000
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
gear-refine training preflight-deployment --config /srv/gear-controller/controller.json
```

返回 `training-deployment-preflight`，每项包含 `scope`、`target`、`code` 与 `passed` / `blocked` / `unverified`。控制端检查 Hitch 源码与 binding/harness 能力、Python bridge；Harbor worker 检查自身 Harbor/Linux Docker 环境与版本、常驻进程身份和模型路由能力；模型节点通过实际 probe 固定 node/generation 后，检查 job 配置、Slime/Megatron checkout 与修改摘要、export 扩展、torch/SGLang/Ray/psutil、CUDA、GPU 清单/计算进程、主机可用内存，以及训练和评估的独立 gateway 端口。节点故障不会取消其他可独立执行的检查，错误正文、凭据和源码路径不进入报告。

模型节点不调用 Hitch、Harbor 或 Docker，不创建训练 job、启动模型服务或申请 GPU lease。`colocated` 最少需要一张可观察且空闲的 GPU；`disaggregated` 最少两张；`trainEvaluation=isolated` 另需一张。这里检查的是设备池下限，正式请求仍按实际 DP 和冻结的 GPU UUID 校验。显卡进程读取失败不会被视为空闲。RAM 和显存只报告当前容量，尚不证明所选模型、batch 和卸载峰值能容纳。

`readyForRuntimeProbes=true` 表示这些静态与现场依赖检查没有 blocker，`runtimeValidation` 仍是 `not-certified`。真实 sandbox→模型路由保持 `unverified`；返回的 `remainingValidation` 列出设备分配、原生 token/logprob、反向传播、checkpoint/export/reload、共卡内存/权重切换及训练→评估设备交接等剩余验证。检查不会写入 probe evidence 或把运行时改为 `validated`。

## 冻结与执行

先启动控制端 Hitch daemon，确保目标 provider 已注册。然后调用：

```sh
gear-refine training freeze-deployment --config /srv/gear-controller/controller.json
```

返回 `deployment` 与 `observation`。将前者放入完整 schemaVersion=2 spec；GPU 资源写成 `{ "nodeId": "实际节点 ID", "gpuUuid": "实际 UUID" }`。后者包含注册能力、daemon/worker 的现场版本观察与模型节点环境观察，不能代替 sandbox 路由或 GPU 数值验收。一个 provider 首版只允许一个注册 worker；heartbeat、当前负载、daemon instance 与本次 nonce 不进入身份摘要，worker generation/碰撞域/平台/backend 和实际环境会进入。远程 worker 的现场观察已接入，但完整远程训练/managed-model capability 尚未公开，远程任务部署仍会在相应能力检查处拒绝冻结。

v2 spec 使用 `evaluation.provider="hitch-managed"`、`evaluation.topology="harbor-dataset"`。不能保留 v1 `trainer.placement` 或 `resources.mode`；对应关系由冻结的 deployment 表达。评估公共 runtime/protocol/sampling 条件需从同节点上的真实 immutable inference lock 提取，并重新建立 baseline。

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

缺失的基线先评估并释放设备，再运行一次完整训练 preflight。基线尚在运行时，下一次 `advance` 先协调原评估，避免其自身占用的共享 GPU 阻塞恢复。训练提交意图已经落盘但回复丢失时，直接用原 key 协调提交；不会要求这个可能已启动的作业先让出显卡。新作业的节点 preflight 仍生效，基线结束后的环境变化也会阻止提交。

`trainEvaluation=isolated` 允许独立设备上的候选评估与训练进程清理重叠；每次 `advance` 继续读取未释放训练 owner 的累计用量。最终决定必须等训练和评估均确认释放，再按最终成本检查预算，隔离设备不豁免释放检查。`pause` 分别协调训练和所有未完成评估，一侧失联不会阻止另一侧取消；两侧都释放才进入 `paused`。迟到的基线检查、合法导出或评估结果不能自行恢复运行、启动下一分区或晋级，已验证结果保留到显式 `resume`。

v2 训练使用独立于 request/job/checkpoint 摘要的 `trainingControl={schemaVersion:2,sequence,action}`。控制端先持久化 start/pause 意图，节点以同一作业锁保存指令顺序；暂停可先于首次提交建档，不上传模型、不创建 worker、不申请设备。后到的旧启动或旧暂停被拒绝，相同序号不能改换含义。`submit` 的初始序号重试只协调原 incarnation，失败或中断后必须显式 `resume` 产生较新的 start；恢复仍要求旧物理资源和旧 episode 都已结束。

节点声明 `orderedTrainingControl=true` 后才能通过 v2 训练 preflight；旧节点不会退回无序 submit/cancel。已进入有序控制的 job 也拒绝旧修改接口。控制端把节点指令/状态读取和相关 episode 协调放入同一个作业锁，避免旧暂停回复在恢复后取消新 episode。此锁不跨主机共享，模型节点的指令序号和设备账本仍是实际启动/释放的依据。v1 作业接口保持原形式；已有 v2 job 不改写原身份，带取消标记的旧作业需要明确的新恢复意图。

独立评估使用单独的 `evaluationControl={schemaVersion:2,sequence,action}`，要求 Hitch 声明 `ordered_eval_control="2"`。Gear 为每条指令保存不可变文件，通过公开 `eval control`、`eval submit --control-file` 和 `eval rerun --control-file` 传递。首次提交前的暂停也会在 daemon 中保留原 key 与 eval ID；迟到启动、旧取消及已取消 repair ID 不能重新启动任务。显式恢复沿用原评估身份，新修复轮次使用新 rerun ID；跨训练 run 复用基线 key 时延续更高序号。v1 保留原接口。若 daemon 已提交评估而本地原 journal 丢失，取消会报告身份/清理信息缺失，不假定资源已释放。

每次 `advance` 在协调未完成评估前、以及异常返回后，只读查询模型节点累计用量并入账；查询不提交、重跑、停止服务或证明释放。达到实验 GPU 预算时进入有序暂停，继续收尾计费，两侧确认释放后才进入 `paused`；预算耗尽不能再次 `resume`。断连或服务记录缺失保留已有成本和资源预占。首次 intent 尚无 evaluator journal 时返回“尚无用量观察”，只协调同一身份，不当作零成本或释放证据。

费用按实验内原评估 key 的累计最大值计增量，跨训练 run 恢复不会重复扣减已计入的时间。旧状态缺少 `chargedGpuSeconds` 时读取原 evidence 成本，迟到结果不能降低较新的费用；有效结果仍可保留。控制端观察依赖调用 `advance`，不是后台定时计费器；节点账本在控制端离线时继续累计。实际 GPU 验收范围以上述认证记录为准。

`freeze-deployment` 要求 Hitch 的 `controller_runtime_observation="2"` 与 `local_execution_observation="2"`。先调用 `hitch training runtime --json` 观察 CLI 包，再通过 `hitch worker observe local-docker --nonce HEX --json` 请求 daemon 的新观察。daemon 在启动、开放 HTTP 前保留 runtime 摘要，观察时再次读取磁盘；启动摘要、当前摘要和 CLI 摘要必须一致。daemon 启动后重新构建或切换 checkout，需要重启 daemon。该机制检查启动后是否漂移，并非对 Node 已缓存模块的逐字节证明；不要在 daemon 启动过程中替换运行包。

上述 runtime 摘要覆盖编译代码、training-tool 和 Harbor bridge，并包含 Node 版本、包自身的 Git commit 与代码修改状态；部署中不记录本机绝对路径。训练 preflight 另核对 `trainer.runtimeLock.hitchCommit`，不同 commit 会在 episode 提交前拒绝。无自身 checkout 的安装包不能借用父目录仓库的 commit；当前 v2 训练要求使用可观察的 Hitch 源码 checkout。

现场环境观察只运行固定的只读命令：Harbor `--version`、Docker `info` 与 `buildx version`。Hitch 使用 daemon 的实际环境和 Harbor/Docker 选择规则，记录可执行文件摘要、Harbor 版本、Docker engine ID/版本/系统/架构与 buildx 插件版本。Harbor 或 Linux Docker engine 不可用时，冻结拒绝；buildx 可用与否独立记录，不等于 BuildKit builder 已通过验收。Harbor 可执行文件摘要也不代表完整 Python 依赖环境摘要。响应不包含 executable 路径、环境变量或原始错误输出，sandbox 明确为 `unverified`。此观察不会拉取镜像、安装工具或执行任务；真实容器、Harbor→模型代理链路和 GPU 验收仍需后续执行。

远程 provider 可单独通过 `hitch worker observe PROVIDER --json` 观察。worker 注册文件的 `features` 需要增加 `"execution_observation": "2"`，并运行支持它的 `hitch worker run`；这只是协议声明，不能代替实际回复。新字段省略时，旧 v1 worker 注册与任务执行行为保持原样。若调整已有注册，仍使用原注册命令取得新的 generation 和凭据，不能继续使用旧凭据。

daemon 经当前 worker bearer/generation 通道发出短期 challenge，包含独立 request ID、本次 nonce、daemon instance、worker/碰撞域身份和到期时间。worker 在后台运行固定探测，使用 `worker run --harbor/--docker` 或原环境选择；探测不占任务资源，不阻塞任务心跳。请求断开、超时、generation 变化或 daemon 重启后，不接受旧 challenge 的回执。此类只读观察不持久复用，失败后重新观察即可；它不更改 task lease 或资源所有权。

远程观察分别返回 daemon 和 worker 的启动/当前 runtime，控制端只检查自身 runtime，不要求安装本地 Docker。Gear 要求 worker 的实际 Hitch payload/package 与控制端一致；worker 的 Node 版本可以不同，但会进入冻结身份。worker 使用无 Git checkout 的同内容安装包时，source 可为 `unavailable`，不能伪造源码 commit；如能观察到自身 Git checkout，则 commit 也必须匹配。以上仍是版本和环境观察，不构成远程 sandbox 或模型路由验收。

## Hitch 的公开模型节点接口

### 远程发布与回滚

SSH 部署默认使用 `artifactStorage="model-node"`。`publish` 和 `rollback` 通过 Hitch 的 `models add-node` 注册并核验冻结节点上的 HF 快照，权重、tokenizer 和 config 文件继续保留在节点 CAS；控制端不下载这些文件。

```sh
gear-refine training publish EXP_ID --config /srv/gear-controller/controller.json
gear-refine training rollback EXP_ID RELEASE_ID --config /srv/gear-controller/controller.json
```

成功后 `activationPath` 原子记录 `hitchModel` 和 `modelNode`。后者是公开的冻结节点绑定，不含 SSH/Python 连接配置或凭据。业务调用方在 episode 开始时读取这两个字段，将 `modelNode` 保存为 binding 文件，并向 Hitch 的 `local plan` / `eval submit` 传入 `--model-node-file BINDING.json`；Hitch 从其私有注册表解析连接。发布只切换后续 episode 使用的版本，已运行的推理服务保持原模型。

回滚同样核验旧快照的远端文件。节点代际、runtime 或快照发生变化、文件缺失或 Hitch 不支持节点存储时，当前 activation 和 release 保持原样；不要通过下载到控制端绕过冻结身份。

节点重启后，应重新冻结部署并创建新实验。历史作业的释放状态会结合 OS 启动证明和设备账本核验，确认释放后不再阻塞新提交；缺少证明或仍有 GPU 占用时继续阻塞。旧作业的身份和 checkpoint 不会自动改绑到新 generation。

### 注册、规划与恢复

`hitch model-node register --file CONNECTION.json` 接受 `schema_version="2"`、`binding` 和私有 `connection`。binding 含 `node_id`、`generation`、`runtime_digest`、`launcher="process"`；connection 含 transport、Python argv、configPath 和评估 gateway。注册时实测节点环境；连接信息保存在 Hitch 私有目录，不进入 inference lock。

`hitch local plan local/MODEL --harness REF --gpu GPU-UUID --model-node-file BINDING.json` 生成 v2 inference lock。随后 eval 使用 `--inference DIGEST --model-node-file BINDING.json`，无需再传 device/profile。Gear evaluator 自动执行相应注册、规划和提交。

`hitch local inspect-service SERVICE_ID --json` 读取模型节点的物理 GPU 累计占用与释放结果，输出不含 engine/admin token。Hitch 的 `failed` 状态不等于设备已释放；Gear 在节点确认释放后才允许串行交接。daemon 不在时，`local status` 仍显示持久化的服务记录，避免把残留服务误认成不存在。

模型节点只接受格式完整的 GPU UUID／正整数 PID 观察；驱动返回诊断文本、损坏行或混合有效/无效行均不能证明设备空闲。服务创建引擎子进程与其登记使用停止操作的同一启动锁，停止快照包括刚创建的子进程；子进程执行 SGLang 前仍自行核对原 supervisor 和停止标记。

节点重启导致 generation 变化时，先用新 binding 注册当前节点连接，再执行 `hitch model-node recover-service SERVICE_ID --file CURRENT_BINDING.json --json`。该命令可在 daemon 未启动时运行。节点核对原 service/owner/inference ID、旧 process handle、归档的 OS boot 身份和物理 GPU 占用；不会解释或杀死旧启动周期的 PID。缺失启动证据、缺失已启动服务的设备账本、仍有 GPU 占用或驱动查询失败时保持未释放。

确认后，节点和 Hitch 分别保存 v2 generation release 回执。回复或控制端落盘丢失时可以原命令重试；已确认回执可供 `local inspect-service` 和 daemon 恢复使用，无需再次连接已失效的旧 generation。原模型锁、服务 handle 和 node binding 不改写。此操作只结束旧服务占用；新 generation 的模型或训练必须重新规划、冻结，不能把旧任务自动改绑过去。

同 generation 的 `inference.attach` 精确匹配原启动请求与 handle，检查监督进程/引擎仍存活、设备账本仍有效及实时 runtime，没有启动、token 探针或缓存清理副作用。Hitch daemon 已接入活动远程 managed 网关恢复：根据 accepted work、未过期 lease、worker generation、原 eval/rerun 执行证据及服务私有网关回执选择原 owner，接管进程后恢复原端口和 run 凭据。启动期间的 managed 请求等待恢复，心跳保持可用。暂时离线的 worker 在原 lease 到期前保留占用；过期、撤销、取消或完成后撤销恢复的路由并释放 owner，正常续跑可接手原 lease。旧绑定和原 canonical run 不改写。该流程已具备真实 daemon/HTTP 的合同验证，真实跨主机 Harbor/GPU 和 worker generation 资源协调仍待验收，完整 remote capability 仍未公开。

分进程恢复测试进一步覆盖在第一次模型调用后 SIGKILL daemon、原 worker/候选进程续跑第二次调用、结果导入及原租约释放。使用默认 managed manager 与公开 worker CLI，故障后的持久状态不重写；模型节点、Harbor/Docker 和 CUDA 观察为 fixture。同一 service/epoch 的收尾 acquisition 会核验并保留原执行证据及准备时间，不能覆盖被篡改的原文件。真实云端训练、单卡交接和跨主机故障验收仍按上述边界执行。

远程 worker 重新注册或撤销后，旧 generation 的在途状态提交和制品发布会在控制端最终写入时被拒绝。HTTP 请求使用其 bearer 实际认证的 generation，不能靠稍后送达的正文改变身份；制品传输不会阻塞 worker 心跳。调度/恢复发现 generation 已变即隔离旧 execution lease，保留原 resource epoch 和未释放 offer 的预留。新 worker 的零 allocation 不能代替旧资源清理证明，跨 generation 释放需要独立清理回执。

远程 Harbor worker 的清理归属由 Hitch 管理。重启、凭据轮换或跨 generation 接管都需要原 offer、进程、主机启动与 Docker engine 的持久身份及独立释放回执；缺失证明时保留资源预占。主机重启后不能按旧 PID 终止进程，也不能重新执行已接受候选。相关 worker 恢复协议的 CPU/HTTP 合同测试不代表真实跨主机 Harbor/GPU 验收，新增拓扑仍需独立认证。

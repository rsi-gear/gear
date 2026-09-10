# 执行位置解耦：实施记录

最终验收（2026-09-10）：按需 `50406574` 的第 67 轮已完成 R1 单卡故障恢复、R2 信息隔离、R3 runtime 认证。16 项证据封存为 `sha256:18f55a8b22c8bf25c994d5571d89c3d6750b7fbe50e28072a0e8fab1bce9f1c9`；实际停止、重启并重新核验节点 / GPU / runtime 后，正式 preflight 阻塞项为空。认证后的 request 摘要为 `sha256:7ba9d92cc059496af491a6c4017a27aa60674e852781e9d35ba92fc15f0a6d10`。全部测试后再次确认 `actual_status=exited`、`intended_status=stopped`、`cur_state=stopped`，容器及远端数据保留。[公开认证与验收摘要](certifications/2026-09-10-rtx5090-single-gpu/README.zh-CN.md)。

按需总价约 $0.748/小时，1×RTX 5090，驱动 `580.178.04`；实测容器内存上限 `183056203776` 字节（约 170 GiB），220 GB 磁盘。Vast copy 后遇到文件句柄失效，使用保留 GPU 优先级的 reboot 刷新挂载后恢复；没有重新下载模型。切换时原 `50380854` 保持停止；最新 Vast 列表已不再显示该实例，不能继续宣称其中旧检查点仍可访问。本轮完整检查点在 `50406574` 独立重建并校验。

第 67 轮结果：两批各两个真实两调用轨迹，native token IDs、response length、loss mask 与实际 Slime capture 一致；两批 actor/native policy-token MAE 分别为 `0.01089240903604371`、`0.009297316330050074`（门限 0.1）。两份 native checkpoint 的 optimizer step 为 `[1,1]` → `[2,2]`、scheduler num_steps 为 `2` → `4`，两组各 `1543714304` 元素的 FP32 Adam moments 与 Python / NumPy / Torch / CUDA / tracker RNG 状态均保留。训练累计预占计费 `1393.304631471634` GPU 秒。原批次重放、pending checkpoint 只读导出、已提交更新恢复均未重复消费更新。

独立评估为 `eval_32e74ff89d874ee78a6c401aa2d9b489`，新 run `run_f2f961fb54b9470a9d3c4446cd50f0aa`，复用同卡的新推理 owner，占用 `89.10526180267334` GPU 秒；服务停止回包被实际丢弃后通过原身份协调到释放。单个 canary 的 reward 为 0、valid=true、inferenceError=false，此结果仅证明运行链路，不能证明模型质量提升或授权晋升。设备账本确认全部训练 owner 已释放后才由独立推理 owner 接管。4 个原始 verifier / canonical 对象未上传节点；覆盖全部 4 个训练凭据的最终扫描检查了 812 个公开制品文件，未发现凭据泄露。

另用 8 MiB CUDA 张量做有界 SSH 断连计费检查，不重复加载模型：切断独立 SSH 连接并重新连接后，原 GPU 进程及租约不变、计费增加 `6.715062618255615` 秒，随后确认物理释放。原始 GPU 恢复、isolated preflight CAS 正反例、真实 generation 授权正反例、完整反馈投影与公开制品扫描各有独立审计记录。

本轮首次封存边界探针因遍历 Ray 进程耗时错过窗口，失败日志已保留；提前定位 driver 身份后以原 request / job 显式继续，重用了原封存批次 `sha256:af103187c2f60e75aa2322af77ccd18164038751ddab06981860e72b0a1c399b`。封存、pending checkpoint、已提交更新三处均实际暂停至少 3 秒、确认计费继续、杀进程后确认资源释放；累计预占计费分别为 694.627、871.091、940.683 GPU 秒（包含首次失败与释放确认延迟）。最终第四阶段完成第二次更新，前述失败记录没有被改写为通过。

第 67 轮节点 `vast-50406574-recovery67`、generation `850e3a281e2f48f7bf8227d634f52903`、GPU `GPU-6535a338-f8ff-92dd-ab5d-605cdd4210c2`。request 为 `sha256:b2d2508a76826ec855892bfe079b94ebfc2ac0454a340f71cdc308a89f421c02`，job 为 `job_48684da9829998a5c06c8eea9fd30e5d`。真实远端 CAS 隔离探针已通过：dev / held-out / 私有 verifier / 管理凭据的四类测试标记未上传；含私有引用的合法模型配置按文件边界上传，manifest 的未声明引用拒绝。此探针只执行 preflight / CAS，不提交训练任务；完整训练、最终反馈隔离审计、独立评估和认证分别完成，证据不互相替代。以下为旧轮次历史，不自动继承到新节点。

第 66 轮历史进展（2026-09-10 北京时间）：只使用用户指定的 `50380854`。第 66 轮首个 sealed-batch 中断、物理释放和原作业恢复通过，累计约 349.90 GPU 秒；第二阶段遭遇实例级断连，Vast 显示停止意图，SSH 关闭。再次启动返回资源不可用、请求排队。尚无第二阶段训练异常栈，R1 / R2 / R3 未全部验收；不把实例断连推断为新训练故障。用户已将价格上限提高至 $1/小时；GPU 出价已调为 $0.94/小时，Vast 实际总价约 $0.99/小时。仍在申请原实例资源，当前测试全部完成前不主动按阶段或对话结束停机。

完整 Adam 恢复的独立 GPU 检查已通过：复用第 56 轮原始 native checkpoint，恢复 step=1、scheduler.num_steps=2；约 30.87 亿个 moment 元素均有限，scheduler 与原 `common.pt` 独立比对一致。加载后、sleep / wake / sleep 均实际观察显存变化；最终进程退出且设备空闲。初始探针因 Ray 退出延迟保守记录 `resourcesReleased=false`，后续独立回收回执才确认释放，计费保留至确认时刻（约 123.23 GPU 秒），不改写原报告。此诊断不等同于同一作业恢复后完成第二次更新。

第 64 轮明确复现 GPU OOM：TE FusedAdam 在 Megatron 读取 native checkpoint 后第二次分配完整 optimizer 状态。新增固定版本 adapter 仅在逐参数状态张量确实引用已有加载目标、无自定义 hook 时保留目标张量，通过原 loader 恢复参数组；不同映射、复制状态及其他 optimizer 保持原路径。真实 TE 的 state_dict 新建字典但复用 FP32 张量，该行为已覆盖。主 CPU 环境 170 项 Python 通过、3 项因无 Torch 跳过；带 Torch 环境另跑这 3 项通过，共 173 项不同检查通过；既有 TypeScript 回归 125 项通过。

诊断脚本新增显式 `--resume`：只复用已核验通过的阶段；运行时 / GPU 漂移、旧进程未释放、已注入但缺少完整回执的故障点均拒绝继续。SSH 不可用场景已实际验证拒绝，原 marker、summary 与 progress 的文件摘要保持不变。

第 66 轮冻结节点 `vast-50380854-recovery66`、generation `5b42e440a8a84191939953e7810c1570`、GPU `GPU-d1188f37-e950-12c0-81e4-f8d0e3017d70`、驱动 `595.71.05`，容器内存上限 `367227043840` 字节。request 为 `sha256:7a3a21a4e1a5c52490718b23b35eba3bb9b8a186b1fc833cb9a0679e552d5bdd`，job 为 `job_c49011d753b59195eb4fc41d097ef51b`；bridge 为 `4e655d…795f3`，Slime diff 为 `3427f2…105e3b`，Megatron diff 为 `8783c5…3d02`。活跃 run 授权与信息隔离检查通过（2 个凭据摘要、462 个公开文件），全量反馈审计与第二次更新仍缺证据。模型与完整检查点留在远端，本地只保留代码、元数据和有界日志。

实例历史：`50392374` 已按用户要求停止，随后从 Vast 列表消失；审计记录显示 2026-09-09 15:41:40 UTC 收到删除请求，使用的 key ID 与本次 CLI 不同，无法判断调用来源，不声称其磁盘仍保留。`50380854` 先前多次停止、排队和重新分配 GPU，新请求只绑定实测身份。第 61 轮前三处故障阶段与只读 HF 导出通过，第四阶段失败，`committedUpdate=1`、`resourcesReleased=true`；没有取回该阶段异常栈，后来的 OOM 是在当前机器上独立复现。以下为各轮过程记录。

第 57～61 轮实施进展：pending export 改为只读权重 worker，保留原完整 optimizer/RNG/checkpoint 引用；Megatron 固定版本补丁将 TE 加载前的临时 optimizer 占位张量放在 CPU。远端 collect 补齐控制端私有证据经 policy lease 返回远端 HF 快照的依赖验证，文件散列使用传输时限。新增逐 token 训练 capture 审计和活跃 run 凭据/管理路径拒绝检查。125 项 TypeScript、168 项 Python 回归通过；这些 CPU 结果不代表 GPU 恢复或认证完成。

第 61 轮历史冻结信息：在按需实例 `50392374`（$0.5467/小时）执行新的两次更新故障 canary。节点 `vast-50392374-recovery61`，GPU `GPU-11ba2e2f-cd71-74a9-c848-3e075ade23e6`，驱动 `580.159.04`，容器内存上限 `149823684608` 字节。Slime 原 export 补丁摘要仍为 `3427f2…105e3b`，Megatron 新补丁实际 working diff 为 `ed22f5…207abc`。首次启动前发现 bootstrap 进程与实际 Python 命令的包观察不同，已保留未提交尝试并使用实际命令重新冻结；当前 request 为 `sha256:b8edaebc3d3321c8dd37c46328e8d57b20cddd8533e1db6ca75bb7b87fba2869`，job 为 `job_e3f5f5f595b696965d902e4f17056cd3`。**当前尚无第 61 轮验收通过结论。**

Vast 复制曾中断，旧实例 `50380854` 的完整 CAS/checkpoint 仍保留；目标已取得并核验原模型、Megatron 和源码归档，但没有宣称完成整个旧 workspace 迁移。新报价创建未产生额外实例。旧实例短暂恢复后再次停止，其重复工作副本回收校验被连接中断，未取得完成回执。依用户最新要求，当前可用实例持续运行到全部测试完成；不复用短阶段自动停机守护，不在对话结束时关闭实例。大文件始终留在远端，本地只增加小型代码、元数据和日志。

第 56 轮新增实测：真实工具轨迹奖励 `[1, 0]`，backward 梯度范数约 7.19，actor/native logprob 平均差约 0.01095。sealed batch 与 pending update 两处实际进程中断后使用原 job 和 batch 恢复成功；四处控制回复丢失未重复提交任务。第三阶段恢复导出在加载 FusedAdam 状态时触发 32 GB 显存 OOM，完整约 21.6 GB checkpoint 保留在远端，实例已停止；只取回约 363 KB 日志和元数据。信息隔离检查通过，训练未完成，runtime 认证仍 pending。当前先修复只需导出却构造完整训练状态的路径，不能将前两阶段通过视为 R1 完成。

2026-09-09 按用户决定更新范围：**本地 Harbor / Docker + 远程训练与推理进程节点**。接下来依次完成单卡故障恢复、信息隔离验证、该范围的 runtime 认证。远程 Docker / Harbor 主机、四种拓扑和双卡回归延后，不再阻塞本轮完成；已有相关代码保留，未验收能力不开放。设计与验收以 `execution-placement-plan.zh-CN.md` 第 7、8 节为准。

第 46 轮已完成 FlashAttention 下连续两次真实训练更新和完整离线产物校验，第 49 轮已通过同一冻结节点和设备账本的独立评估交接。**故障恢复、信息隔离和 runtime 认证尚未全部完成；正常零奖励流程不表示学习提升。** 不可用的 Vast 50316639 已在备份核验后删除；替代实例 50380854 已停止，所需模型、Megatron 和当前源码已在远端保留并校验。第 55 轮在 SSH 公钥认证阶段失败，未启动训练；公钥重新附加后尚未复测。按用户要求已清理本地 Vast 测试副本，约释放 128 GB，后续迁移直接在实例间 copy。历史日志已加密归档到远端，旧 checkpoint 已丢弃，详见 [清理与保留记录](vast-local-cleanup-2026-09-09.zh-CN.md)。以下旧阶段记录保留为历史证据，不把旧 P4 / 双卡要求重新计入当前范围。

## 已落地的基础

Gear：

- `src/training/deployment.ts` 与 v2 类型/解析：任务 provider、模型节点、两种 GPU 调度关系分别冻结。GPU 使用 nodeId + gpuUuid。连接路径、SSH Host 别名、临时端口不进入实验身份。
- coordinator/store/evaluation 已投影并核对冻结的 deployment，比较条件包含部署摘要。v1 spec 不改写，仍按原对象和摘要读取。
- 纯进程训练新增 schema 2 runtime lock，绑定冻结的 Python 环境摘要与可选外层镜像；不再要求纯进程安装虚构容器镜像证明。旧 v1 spec 与已有 v2/schema 1 lock 保留原校验和摘要。新 lock 仍需独立 GPU probe，不能复用旧环境的验证身份。
- 公开 `preflight-deployment` 无需创建实验即可分别检查控制端 Hitch/Python bridge、Harbor worker 实际环境与能力、模型节点源码/依赖/CUDA/GPU/主机内存和独立 gateway 配置。模型节点通过已固定 generation 的空 payload RPC 返回诊断，不调用 Hitch/Harbor/Docker，不提交作业或模型服务。故障按节点报告，未知 GPU 占用不视为空闲；共卡、分卡与隔离评估分别检查设备池下限。诊断明确 `not-certified`，sandbox 路由和真实 GPU 数值/卸载/权重切换仍待实测。
- `src/training/transport.ts` 与 `python/gear_training/node.py`：本地/SSH 使用相同版本化 RPC 信封，响应核对 request ID、input digest、node ID 和 generation。重连保留 generation，节点重启使旧 generation 失效。
- 二进制 CAS import/export、流式校验、依赖图同步；大对象不走 JSON/base64。截断/损坏对象不发布。`NodeSlimeModelTrainer` 已接入 v2 job/episode 协议的 preflight、提交、检查、取消、恢复和回收适配；公开 controller v2 CLI 已选择 node trainer / episode coordinator，评估 adapter 已接入 managed-node CLI；本地 Harbor 与远端进程评估已获得第 30 轮实际诊断证据，其余拓扑和认证仍待验证。
- `gear-refine training freeze-deployment` 读取注册的 provider 能力、本地 daemon 的现场版本及模型节点实际环境，生成 v2 冻结配置。公开 v2 controller 接通 init/admit/preflight/advance/status/pause/resume/close 等原命令，拒绝混用 v1 controller、部署切换或训练/评估路由冲突。现场版本不替代 sandbox 验收；详细配置见 `controller-v2.zh-CN.md`。
- v2 部署观察新增 Hitch `training runtime --json`：实际 CLI 编译 payload、training-tool/Harbor bridge、Node/package 版本与自身 Git checkout 身份进入 provider 摘要。episode preflight 核对 runtime lock 的 `hitchCommit`；源码不可观察或 commit 不符时拒绝，v1 行为不变。`worker observe local-docker` 经 admin 认证获取本次 nonce 对应的现场观察，CLI 核对 daemon instance；Gear 校对 worker/碰撞域与 nonce，并要求 daemon 启动摘要、当前摘要和 CLI 摘要一致。重编译后旧 daemon 拒绝准入。此机制不是 Node 已缓存模块的逐字节证明，启动期间替换代码仍需避免。
- 本地环境观察运行固定只读版本命令，记录 Harbor 版本/可执行文件摘要、Docker engine ID/版本/系统/架构与 buildx 插件版本；不拉镜像、不安装工具、不输出路径、凭据或原始诊断。冻结要求实际可用的 Harbor 和 Linux Docker engine。sandbox 仍为 `unverified`，Harbor 可执行文件摘要不等于完整 Python 包依赖摘要，buildx 插件存在也不证明 builder 可用。旧 v1 provider listing 与其摘要保持原状，实际环境进入 v2 冻结身份；负载、nonce、daemon instance 不进入。
- 远程 worker 的同类认证观察已接入：独立 request ID/nonce、daemon instance、worker generation/碰撞域和期限绑定本次 challenge；使用现有 worker bearer 校验，回执严格核对原请求、版本化 runtime/environment 与摘要。controller 不执行远程 provider 的 Docker 检查。Gear 核对 worker 启动/当前 payload 与 controller 一致；worker Node 版本和可观察源码身份进入冻结，源码不可见时保留 `unavailable`。全局仅新增 `remote_execution_observation="2"`，没有开放完整远程训练/模型 capability。
- `gear-refine training node-probe DEPLOYMENT.json NODE_REF` 可调用选定节点的观察接口。Python 节点配置含 `schemaVersion: 2`、`nodeId`、绝对路径 `nodeRoot`、`storeRoot`、`jobConfigPath`；节点环境须安装当前 Gear Python 包。
- `python/gear_training/inference_process.py` 提供 `inference.prepare/start/inspect/stop/recover` 节点 RPC。固定 HF 文件按摘要 materialize，SGLang 使用回环地址和显式 `inferencePort`。SSH 请求退出后，独立监督进程继续运行。监督进程和 engine 在执行前登记 PID 创建时间；服务 ID 和 owner 重试幂等，停止先到时写入 tombstone，禁止迟到的启动。
- `device_lease.py` 的模型节点设备账本已接入上述评估进程和 node RPC 下的 Slime JobService。设备仅在禁止后续启动、已登记进程退出且物理 GPU 查询为空后释放；监督崩溃、查询失败或连接中断继续保留占用。GPU 用量按唯一物理设备和未释放时段累计。原 v1 直接 job 配置继续使用原适配路径；v2 JobService 按 nodeId/GPU UUID 解析分配，模型节点配置拒绝 Hitch CLI/仓库路径。
- Python runtime observation 记录已安装分发包版本、RECORD 摘要、可观察的 VCS commit、Python/系统/架构及 Gear bridge 摘要；`outerImageDigest` 独立记录。当前观察不是 GPU/数值/工具兼容性认证，完整分节点 preflight 仍待接入。
- `TrainingEpisodeCoordinator` 在控制端处理训练任务 materialize、Hitch binding/register/submit/cancel、canonical run/verifier/harness/environment/policy 核验，并持久化每个 slot 的提交意图、eval ID 与反馈。模型节点 `EpisodeJournal` 通过相同 v2 RPC 交换 intent、ack、receipt、admission、result；地址绑定 job/incarnation/batch/policy/fence，重试不能更换内容。
- v2 rollout 通过上述 journal 等待控制端反馈，保留原生 gateway、token/logprob receipt 与 Sample 组装。节点不 materialize 任务、不执行 Hitch。完整任务/verifier 证据留在控制端，只向节点上传最小反馈、episode、组装证明和 verifier 观察投影。
- controller contact 使用显式 10～300 秒期限；过期后隔离旧 lease，新连接不能将其复活。取消或恢复先协调原 Hitch slot；GPU 已退出但 Hitch 尚未终止时，控制端仍报告资源未完全释放。分页不会让未消费的历史完成结果遮蔽后续待处理 slot；已取消的未派发 slot 拒绝迟到 ack。
- v2 sealed batch 显式包含 `sourceEvidenceRefs` 并校验摘要；collect 也补收 update commit 中仅以 `consumedBatchDigest` 标识的 batch 及其完整依赖图。v1 batch 对象与摘要格式不变。v2 checkpoint compatibility digest 已通过 TypeScript/Python 对照；单卡探针身份额外绑定部署和物理 GPU 池。

Hitch：

- 远程原始 verifier 输入开始通过 `verifier_source="2"` 显式协商保留：选中 worker 后冻结进 work spec，结果与恢复按该版本核对，旧 worker 的 v1 包不变。单阶段、独立 verifier 任务封存原 `artifacts/`、生命周期与匹配的最终响应，保留空目录和文件权限，拒绝软/硬链接；快照受 48 MiB inventory 限制，不回传私有 agent 配置。缺失、不安全或过大的输入记录不可用，配置摘要只能证明来源，不能用于恢复私有配置。
- 控制端在补写 transport 完成标记前校验 worker 封存包，并将源 manifest、去除嵌入私有配置的 trial、快照及独立 import 回执持久化到原 trial 目录；回执同时绑定最终 canonical bundle、候选身份/结果和 execution evidence。导入后的候选或快照被替换、回执缺失时拒绝使用。此项是远程 `verifier-only` 的前置产物保留，尚未开放远程评分修复调度或完整远程训练 capability。
- 可恢复评分配置已接入源快照：`regrade-config.json` 保留 verifier 重试/超时、timeout multipliers、资源约束、固定镜像和 artifact 声明；原 agent 配置只保留摘要，执行时替换机器路径与 lease 标签。旧主机挂载、额外 Compose、私有 verifier/environment env 与未知设置拒绝。旧快照仍可读取，缺少新配置时不能执行该恢复路径。Harbor 的原始 TrialResult 本身也含完整 `config`；现在 v1/v2 回传均移除此嵌入字段，候选和评分字段不变。`source_result_digest` 绑定可回传 trial，新增 `original_result_digest` 单独记录原私有结果摘要。
- `runRemoteVerifierWork` 已实现执行端的独立评分路径：前后核对持久 running lease、epoch、资源、task/source 摘要和原 agent 结果，恢复后的资源设置必须匹配计划；运行原 runtime 或经现有窄范围规则修复的 verifier runtime。它调用 Harbor 0.21.0 的 `source_trial.action=regrade`，不执行候选。该函数尚未接入 worker HTTP 的 work spec、派发与 assessment 导入/恢复，不能据此开放完整 remote verifier capability。
- 真实 Harbor 验证发现 Python 环境此前只接受 `local-docker` ownership 标签，已改为与 TypeScript 一致的 provider 格式校验，并保留远程 provider 原值到每个受控 Compose 资源。旧 provider 行为和租约标签校验保持有效。

- `worker run` 在注册声明 `execution_observation="2"` 时捕获自己的启动 runtime，并在后台处理只读探测；使用同一 worker 的 Harbor/Docker 参数，任务心跳和资源 ledger 独立继续运行。未声明新特性的旧注册按原协议工作。观察请求断开、到期或 daemon 关闭后丢弃 pending challenge，旧 generation 或旧 daemon 的回执拒收；重新观察不会重放旧结果，也不调整 task lease。缺少声明的旧 worker 立即返回具体缺失能力，声明后没有实现回复的 worker 只能超时失败。

- Docker / process 类型化 service handle；process 身份含 node、generation、service ID、PID 与创建时间，不能混用本机 PID/container ID。
- supervisor 保存和校验句柄；Docker recovery 遇到 process handle 返回身份不明确，不会声称远端 GPU 已释放。
- v2 Python CUDA runtime manifest 与进程环境 observation 合同；保留 v1 OCI 摘要。进程观察记录 Python 环境、包摘要、外层镜像与节点身份，不伪造内层 OCI ID。
- `ProcessSGLangLauncher` 与 `PythonInferenceNodeClient` 已实现模型文件流式上传、节点准备/启停/恢复、句柄和 inference lock 核对、模型别名、流式/非流式协议探测及 warmup cache 清理。Docker 和 process launcher 共用协议探测逻辑。
- 客户端支持本地 RPC 和带参数引用的 SSH RPC，并提供固定本机/节点端口的 SSH forwarding 与重连检查；SSH socket 置于 owner 私有目录。本地 Harbor sandbox 经 SSH 到远程模型节点已在第 23、30、32、33 轮实测；跨主机 Harbor worker 仍待实测。
- v2 Python wheel 无法观察到源码 commit 时明确记录 `sglang_commit: null`，由环境/包摘要固定身份；v1 和 OCI 合同仍要求原 commit 字段。新增 `model-node register/inspect`、`local plan/prepare --model-node-file` 与 eval/run selection，daemon 默认 launcher 按冻结位置分派；v2 inference lock、service record、proxy、Harbor handoff 与 canonical model 身份均保留 model node/generation/runtime。

- 模型节点服务不占用控制端 ResourceLedger 的 GPU/容器配额，设备仍由模型节点账本管理。启动前已持久化 model node，启动回复丢失可按原节点恢复；无效服务所有权记录会拒绝恢复。
- `local inspect-service` 从模型节点读取累计 GPU 用量与真实释放状态，输出不含私有访问凭据。Gear v2 evaluator 按本 eval/rerun 的 isolation key 归集用量与停止服务，避免重复计入其他评估或停止它们的服务；记录丢失、用量倒退、节点/句柄漂移均拒绝。daemon 不在时 `local status` 仍列出持久服务。
- 远程 Harbor work spec v2 已投影 exact training / managed-node binding；旧 v1 输入继续使用原合同。控制端复用 worker 的 bearer、generation、lease、epoch 通道转发模型生成，worker 使用 lease-local relay 和现有 capture。首次生成前持久声明实际 canonical run ID，获得模型端绑定确认后才允许生成；重试不能更换 run。模型节点地址/凭据留在控制端 0600 文件，worker 只接收公开 binding，并清除自身继承的模型凭据后启动 Harbor。
- 代理保留训练 `Idempotency-Key`、receipt ID 响应头与流式响应；每秒重新检查执行租约，取消/过期后中断在途请求。模型代理不开放管理接口；受管理模型不能经其他 provider 路由绕到云端。结果导入先核对控制端的 run/binding 确认、训练 policy 或模型/节点摘要，再发布 canonical run。缺少 v2 worker 特性的任务在派发前拒绝。
- 修复 Harbor backend 丢弃 model node 与 Python handoff 拒绝远程 capture 拓扑的遗漏。`candidate-restart` 已接入同一 `RemoteWorkCoordinator`，保留原 provider；任务资源由实际 worker 预留，控制端不占用对应的 Docker 容量。managed-node 重跑按 `evalId:rerunId` 隔离服务，准备阶段失败后的重跑也继续传递远程 executor 与模型作用域。
- worker 的 `physical_work="2"` 显式支持重跑合同。work spec v2 的 `physical_execution` 将原 v1 plan 与新的实际 work ID 分开：原计划及其摘要不改写，按 rerun ID 或基础设施重试 trigger 推导身份，并在控制端派发和 worker 执行前核对 frozen task/slot/artifact/resource。普通 API 可使用没有 model binding 的 v2 work spec；训练 slot 仍由 Gear batch coordinator 修复。
- 重跑的执行 journal 与 lease 事件持久化到原 rerun 目录。完成结果可重放，状态不明的已发工作拒绝补发；更换 rerun ID 也不能绕过未确认释放的旧 lease，`lost`/`expired` 不代表资源已经释放。离线或不明的 rerun 独立记录错误，不阻止 daemon 启动。普通远程 eval 的恢复导入已补齐模型绑定确认与基础设施重试的 `replace-invalid` 发布语义。
- daemon 恢复期间先开放 worker 认证/心跳、结果上传与释放，普通新任务返回 `daemon_recovering`。远程 candidate 重跑已接入公共 lease recovery：核对 sealed work spec、冻结 plan/request 和 journal，收回原 run 后先记 `collected`，确认 worker 释放才记 `completed`。释放超时明确报错，禁止把 fenced lease 当成释放。原始任务/attempt 选择和开始时间从 rerun request 恢复；只派发未派发工作，已完成结果重放时不重新启动模型服务。未接受的 offer 撤销并确认释放后，持久标记 `not-started` 才允许补发；旧撤销记录不阻挡之后同一 physical work 的合法执行。
- 迟到的 worker 释放回执已接入 fenced lease 协调：核对原 offer、worker generation、资源与回执摘要，写入版本化 `release_confirmation`；保留控制端隔离 epoch 和真正执行过的 resource epochs。旧 epoch 不恢复续租/生成权限，canonical 结果仍按原执行 epoch 导入。新 candidate repair 准入会先协调已获得释放确认的旧执行；无确认仍不补发。旧 v1 lease 原样可读。
- 远程 candidate 完成时先持久保存 `completion-pending.json`，包含完整结果、结果摘要及 source result 摘要；scheduler 发布结果、同步 control 后确认交接。同一 eval 的重跑在 scheduler 中串行，重启可补齐已完成结果到调度状态的交接，保留原时间戳；旧记录不覆盖后来的 source result，重复恢复不递增 control generation。
- 远程重跑失败/取消后仍有未释放 lease 时，scheduler 保留 `execution_state_ambiguous`；取消和重复取消不会确认资源已停止。完整结果已经封存后的迟到取消只允许完成交接，不再执行 candidate。首次 lease callback 报错也进入统一 offer 撤销/隔离与碰撞锁释放路径。
- **远程 `verifier-only` 仍拒绝；活动 candidate 的完整恢复尚未验收。** 剩余边界包括 managed-node 在途模型服务恢复、worker generation 切换后的资源协调，以及实际 worker 断网/进程崩溃。`capabilities` 暂未公开 `remote_training_external_binding` / `remote_managed_model_node`，Gear 完整远程部署仍不开放准入；不能据此宣称 P4 完成。

已有单卡生成/训练交替与 CPU offload 实现保留，见 `README.zh-CN.md`。这些本地控制流测试不等同于 GPU 验收。

## 当前验证

- Gear 类型检查、构建通过；全量回归 537 项通过、8 项按环境条件跳过，包含 53 项训练专项。控制端 episode 与 node trainer 测试覆盖提交/反馈/准入回包丢失、canonical verifier 漂移、失联隔离、取消/恢复与依赖图回收；新增 Hitch commit 漂移和 controller payload 冻结检查。
- Python 54 项通过，包含节点 generation、CAS 截断/损坏/重传、真实进程启动/停止/崩溃恢复、训练/评估设备互斥、启动先被停止禁止，以及既有训练控制流和新增 episode journal。
- 真实本地 HTTP gateway 的 CPU fixture 完成 B=1、G=2 的 v2 rollout，包含两次模型调用、工具观察 mask、有效零奖励、完整 batch 封存；测试禁止节点调用 HitchClient 或 materialize 任务。原生 SGLang 与 tokenizer 在该测试中由 fixture 替代，未运行反向传播或模型推理。
- TypeScript → 多次独立 Python node RPC → SQLite journal/独立 CAS 的测试确认同一反馈可重放、错误 fence 拒绝、原生证据可回收；即使客户端传入“已停止”，pending generation 仍不能越过服务端的实际资源判断。
- 真实本地 Python 子进程、独立控制端/节点 CAS 目录完成 257 MiB 上传和下载、依赖图收集。SSH argv 引用经过单元测试；**尚未进行真实 SSH 主机或双节点 Docker 验证**。
- Hitch 类型检查、构建和最新全量回归 539 项通过、5 项跳过（4 项平台/实际 Docker 条件、1 项需显式开启的跨仓库 Python 进程测试）。覆盖 remote worker HTTP 模型路由、首次绑定回复丢失/持久恢复、过期流式中断、work spec 与 canonical 身份替换拒绝，以及远程重跑、冻结计划、离线 rerun 的 daemon 恢复边界和 controller runtime 观察。
- packaged worker 的 CPU 集成测试经过真实 worker HTTP、输入制品 materialize、lease-local proxy/relay、canonical import：API v1 与 managed-node v2 通过；training v2 使用固定 training-tool 执行两次实际 shell 工具调用，三次模型调用的 run ID、幂等键、receipt ID 和回传训练身份保持一致。Harbor/Docker、模型推理和 verifier 在此测试中为 fixture，不代表远程 Docker、native SGLang 或 GPU 验收。
- packaged worker 新增 API / managed-node candidate-restart 验证：原 provider 保持不变、实际 work/lease 更新、修复 canonical run 发布、控制端极小 Docker 配额不阻挡远程执行、模型作用域与资源释放分别记录。两项恢复 fixture 重建 bundle 已上传、控制端尚未发布/确认释放的状态；缺少绑定确认时拒收，恢复确认后收回同一 run，且不再调用模型。此类 fixture 验证持久状态分支，尚非实际进程崩溃或网络分区验收。
- 8 项 packaged worker 集成和 8 项额外专项通过，后者显式启用跨仓库真实 Python 进程测试；最终架构检查通过（345 source files、735 cross-module edges）。补查持久化 submission 保留 training binding、重跑 journal 幂等、旧 lease 隔离，以及离线 rerun 不阻止 daemon 恢复。
- 本轮 36 项远程恢复/重跑专项通过，包含 API 与 managed-node 的实际 daemon 关闭/重启，收回同一 canonical run、保持原选中 trial，且 lease 数量、模型调用次数和 managed-node 服务启动次数均不增加；故障边界仍由持久状态 fixture 重建。另覆盖启动期间 worker 重连、释放超时后再次恢复仍不授权补发、冻结选择篡改拒绝，以及未接受 offer 的撤销/补发。当前架构与语法检查通过（349 source files、746 cross-module edges）。
- 本轮 Gear 训练专项重新通过：53 项 TypeScript 与 54 项 Python。第一次调用未指定验证环境，系统 Python 缺少 `psutil`，进程 fixture 失败；指定已有 `gear-node-validation` Python 后全部通过，没有改动 Python 实现。验证日志：`/tmp/hitch-active-rerun-full.log`、`/tmp/hitch-active-rerun-targeted.log`、`/tmp/gear-active-rerun-training-venv.log`。
- 后续 45 项 lease / 远程重跑专项通过：释放超时后迟到确认、原 epoch canonical 导入、公开 repair 准入的旧 lease 协调、完成交接两种崩溃窗口、旧 source result 与损坏完成记录的拒绝覆盖。API 与 managed-node fixture 额外实际重启 daemon 验证完成交接，模型调用与服务启动次数不增加。架构/语法检查通过（351 source files、749 cross-module edges）。
- 28 项取消与结果交接相关回归通过，覆盖未确认清理时取消不能返回成功，以及结果已封存后的迟到取消。首轮全量暴露旧双 worker crash fixture 把 lease 改回运行态却保留新释放确认的矛盾；已修正现场重建，生产校验保持拒绝。该测试单独通过后，全量 538 项通过、5 项跳过；追加取消边界后的最终全量 539 项通过、5 项跳过，类型、构建、架构和语法检查均通过。日志为 `/tmp/hitch-rerun-cancel-final-full.log`、`/tmp/hitch-rerun-cancel-targeted.log`。本轮再次通过 Gear 53 项 TypeScript 与 54 项 Python 训练专项，日志为 `/tmp/gear-rerun-handoff-training.log`。
- 实际执行 `hitch training runtime --json`，观察到当前 Hitch checkout commit 为 `9788b85199f3f087fa59fff85dd7ddfba8831ed4`、代码有未提交改动，并取得独立编译 payload 摘要。40 项 CLI/runtime 专项通过，含编译字节变化、忽略无关文档、拒绝借用父仓库 commit。并行全量验证暴露既有公平性测试使用 planning 状态代替实际排队的时序竞争；改为显式等待小任务入队后，最终全量通过，未改变生产调度逻辑。
- Hitch `ProcessSGLangLauncher` → 真实 Python node RPC → 独立节点 CAS → 独立监督进程/HTTP engine fixture → 流式调用 → 停止/资源释放的跨仓库 CPU 集成测试已通过。该 fixture 不执行模型推理，不证明真实 SGLang、CUDA 或 Harbor 通过。新拓扑没有 validated probe evidence。
- 本轮本地 provider 现场观察：Hitch 44 项 runtime/CLI/环境专项通过，全量 543 项通过、5 项跳过，类型、构建、架构与语法检查通过（356 source files、763 cross-module edges）；Gear 类型与构建通过，训练专项 58 项 TypeScript、54 项 Python 通过。覆盖旧 daemon 启动摘要不能刷新、错误 nonce/worker/碰撞域拒绝、Harbor 版本命令失败、Docker 观察损坏、环境摘要漂移和未验证 sandbox 不能伪装为认证。日志为 `/tmp/hitch-provider-observation-targeted.log`、`/tmp/hitch-provider-observation-full.log`、`/tmp/gear-provider-observation-training.log`。
- 另通过公开 `hitch daemon serve` 启动独立进程，再经公开 `worker observe` CLI 返回现场响应，由已构建的 Gear decoder 校验；跨仓库实际摘要一致，旧 nonce 与 CLI runtime 漂移拒绝。Harbor/Docker 在该检查中使用可执行 fixture，临时 daemon 和状态目录已清理。单独对本机 `/Users/tangyehui/.hitch` 进行真实只读环境探测，观察到 Harbor 0.21.0、Linux/aarch64 Docker engine 27.4.0、buildx 0.19.2-desktop.1；未执行容器、任务、模型推理或 GPU 测试。
- 远程现场观察新增 14 项专项通过，覆盖认证 HTTP、独立 worker CLI、探测期间心跳继续更新且任务 allocation 为零、旧 nonce/request ID/daemon instance 拒收、worker generation 轮换与撤销、请求取消/超时/daemon 重启、环境摘要损坏及额外私有字段拒绝。全量 Hitch 550 项通过、5 项跳过，类型、构建、架构和语法检查通过（360 source files、772 cross-module edges）。Gear 首轮类型检查发现测试 mock 返回类型过窄，修正测试签名后，类型/构建及 59 项 TypeScript、54 项 Python 训练专项通过；源码 admission 未放宽。
- 公开 CLI 的真实环境补查：在同一主机启动独立 daemon 与独立 worker 进程，worker 使用本机 Harbor 0.21.0、Docker 27.4.0 执行只读探测，经现有 worker bearer/generation HTTP 通道回传，已构建的 Gear 验证 runtime、环境摘要及 stale generation 拒绝；确认无活动 task lease、资源分配为零。临时进程/目录已清理。此证据覆盖真实版本命令与同机分进程协议，不证明跨主机/SSH、Docker 任务或模型 sandbox 路由。日志：`/tmp/hitch-remote-observation-targeted.log`、`/tmp/hitch-remote-observation-full.log`、`/tmp/gear-remote-observation-training.log`、`/tmp/gear-hitch-remote-observation-canary.log`。

- 远程 verifier 源产物回传：27 项基础专项及 8 项补充绑定/恢复专项通过，覆盖原始文件权限/空目录、软/硬链接拒绝、task/runtime/candidate 替换、未协商 v2、缺失 import 回执、重新封存的候选替换，以及 worker 释放后仍可核验输入。API、managed-node、training 三类 packaged worker 均通过；managed-node 的持久恢复重新收回同一来源，模型调用次数不增加。此恢复由持久状态 fixture 重建，Harbor/模型仍为 fixture，不是实际远程 Docker 或 GPU 验收。
- 本轮最终 Hitch 全量 559 项通过、5 项跳过；类型、构建、架构和语法检查通过（364 source files、783 cross-module edges）。新版结果、work spec、源快照、tree、worker registration/provider 的六份 schema 及其引用可编译，实际 v1/v2 结果包通过 schema 验证。Gear 类型/构建以及 59 项 TypeScript、54 项 Python 训练专项通过。日志：`/tmp/hitch-verifier-source-target-final.log`、`/tmp/hitch-verifier-source-binding.log`、`/tmp/hitch-verifier-source-final-full.log`、`/tmp/gear-verifier-source-training.log`。Hitch 仍在原目录、基于 dev 的 `codex/slime-training-binding`，既有用户文档与备份逐字相同。

- 本轮可恢复评分配置与执行函数的 15 项专项通过，另有 3 项 API/managed/training 回传绑定专项通过。覆盖私有嵌入 config 不进入 v1/v2 结果、原结果与可回传结果分别记摘要、配置白名单、source/task/candidate 替换、已释放租约拒绝，以及 provider 标签的原值保留和非法值拒绝。类型、构建、架构与语法检查通过（367 source files、789 cross-module edges）。Hitch 全量共 568 项：562 项通过、5 项跳过，1 项冷构建因 Docker Hub 拉取固定 Node 镜像 EOF 失败，未改代码或测试条件的单独重试通过。Gear 类型/构建和 59 项 TypeScript、54 项 Python 训练专项通过。日志：`/tmp/hitch-portable-regrade-targeted.log`、`/tmp/hitch-portable-regrade-binding.log`、`/tmp/hitch-portable-regrade-full.log`、`/tmp/hitch-portable-regrade-builder-retry.log`、`/tmp/gear-portable-regrade-training.log`。
- `scripts/canary-remote-verifier.ts` 在本机真实 Harbor 0.21.0 / Docker 上执行记录产物的 regrade，reward=1、原 agent result 不变、agent setup/execution 均为 null，私有配置标记未进入恢复配置，前后租约和资源计划校验通过，任务 Docker 资源与临时目录清理确认成功。canary 使用既有本地 bash 镜像解析出的不可变 ID，未执行候选模型或 GPU。最初的真实运行定位并修复了 Python provider 标签限制；另修正 canary 的 artifact manifest 路径和只读缓存清理。失败留下的三个目录已在确认 Docker 清理后移除。最终日志：`/tmp/hitch-real-verifier-canary-lease.log`。这是真实评分执行证据，**不是**远程 HTTP 派发、真实候选生成或 GPU 端到端验收。

- 远程 verifier-only 的 sealed work spec 合同已接入：`physical_execution` 新增 `verifier-only`，work ID 绑定原 work/rerun/assessment，原 v1 plan/provider/slot/artifact/reservation 不改写。描述符校验原 verifier-invalid candidate、可回传 trial/source manifest、canonical bundle/result 摘要与评分 runtime；输入传输增加 source snapshot/verifier runtime，共六类固定输入。模型绑定、凭据、同时 source capture、缺失或重复输入、私有 config 和链接均拒绝。`verifier_only="2"` 要求 Docker 和 physical work v2，不要求 model proxy。尚未公开 worker capability；worker 评分支路已接入，coordinator 与公开 rerun 仍保留门禁，待调度和恢复接通后启用。

- 本轮 sealed verifier 工作合同的 12 项专项、32 项 worker/source/执行回归和 7 项远程 eval/恢复/model relay 回归均通过（合计 51 项）；包括 schema 引用编译、原 candidate/slot/runtime 替换拒绝、六类输入约束、旧 worker 准入与未接通评分执行门禁。类型、构建、架构与语法检查通过（368 source files、791 cross-module edges）。日志：`/tmp/hitch-verifier-contract-targeted.log`、`/tmp/hitch-verifier-contract-regression.log`、`/tmp/hitch-verifier-contract-recovery.log`。本轮未执行 GPU 验证；真实远程评分派发和恢复仍待下一步接入。

- 评分结果与导入函数已实现：独立 `verifier-only-result` v2（64 MiB 上限）绑定描述符和原执行租约，只回传 portable trial、verifier 日志及资源/runtime 证据。控制端重新核对 canonical candidate、source import receipt、冻结 benchmark 与 runtime repair，原子封存 assessment；有效分数保留原 run/trial/task/attempt，无效评分保留原槽位并保存 assessment，重复导入复用封存结果且拒绝结果替换。source 根据 canonical execution 的实际 work/epoch 定位，覆盖 candidate-restart 后的原产物。
- worker 评分支路与六输入 runner 已接通；不初始化 model relay/capture 或 candidate executor。新增只读、鉴权、no-store 的当前 execution lease API，校验 offer/generation/epoch/reservation；worker 以控制端确认的到期时间维护本地执行租约，失联不会自行续期。后续评分派发阶段已接通 `RemoteWorkCoordinator` 的独立 assessment 导入分支和公开远程 verifier-only rerun；必须显式注册 `verifier_only="2"`、`physical_work="2"` 与 Docker 能力。完整远程训练/managed-model capability 仍未开放。

- 评分结果阶段验证：14 项输入/回传/assessment/租约/worker 专项、54 项原远程执行与评分回归、6 项通用 runner/观察回归全部通过（合计 74 项）。覆盖 HTTP 当前租约读取和旧 generation 拒绝、长评分跨原到期时间续租、失联到期中止、六输入接收与候选执行回退拒绝、原候选摘要不变、实际 candidate-restart source 定位、无效评分保留原槽位、原子发布重放、结果/lease/runtime/资源替换拒绝及源码配置不回传。类型、构建、架构、语法和 diff 检查通过（375 source files、817 cross-module edges）。日志：`/tmp/hitch-verifier-result-targeted.log`、`/tmp/hitch-verifier-result-regression.log`、`/tmp/hitch-verifier-runner-regression.log`。这是 HTTP 租约接口、worker 执行支路与本地评分导入的分段验证；公开远程 rerun 派发/恢复和真实 GPU 联调尚未完成。Hitch 原目录/分支保留，用户既有推理文档与备份逐字相同。

- 评分派发与恢复阶段：首次派发前封存全部原候选描述符、source/runtime 身份和稳定 assessment/work ID。每个评分 work 使用独立 v2 journal；控制端先保存 `collected` 结果，再发布 progress 和请求释放，确认原租约释放后才写 `completed`。terminal 回调不会覆盖已收取结果。恢复读取原选择、检查 assessment 与 canonical source，禁止根据已修复 progress 重新选择或重复执行；未接受的 offer 只在确认撤销后重新派发。daemon 完成结果交接已支持 verifier-only。
- 本阶段新增 4 项 HTTP 派发/恢复/选择测试、41 项调度与评分回归、24 项 worker/原候选执行回归全部通过（合计 69 项）。成功场景串联真实 HTTP 输入下载、当前租约、实际 packaged worker 执行函数、结果上传、控制端 assessment 导入与清理回执；Harbor 评分进程和 Docker 命令使用测试替身，不代表真实容器/GPU 通过。覆盖无效评分保留槽位、释放回执丢失后结果不被覆盖、恢复不重复派发、不增加 progress generation、候选 bundle 摘要保持不变、原候选选择独立于当前 progress、缺失/篡改冻结选择拒绝，以及 verifier-only daemon 完成交接的重启/迟到取消/损坏结果边界。类型、构建、架构、语法和 diff 检查通过（379 source files、825 cross-module edges）。日志：`/tmp/hitch-verifier-dispatch-test.log`、`/tmp/hitch-verifier-dispatch-regression.log`、`/tmp/hitch-verifier-dispatch-worker-regression.log`。Hitch 原目录/分支保留，用户既有推理文档与备份逐字相同。

- 模型节点 generation 恢复：NodeService 在轮换前后归档不可改写的 OS boot 身份，旧设备账本的释放必须证明启动周期不同；仅修改 generation 字符串不足以释放。`inference.recover` 新增原 service/owner/inference/handle 绑定的前代回收，物理 GPU 仍有占用、驱动不可用、启动证据缺失或已启动服务丢失账本时拒绝确认。跨启动周期不解释或信号操作旧 PID。原服务身份不改写，回执与 stop fence 阻止旧服务复活，并允许新 generation 的独立服务准入；损坏回执不能放行新服务。
- Hitch 新增 `model-node recover-service SERVICE_ID --file CURRENT_BINDING.json --json`：新连接须先注册并观察当前节点；命令不依赖 daemon 已启动。控制端封存独立 v2 generation release 回执，再更新原服务终态；source/model lock/node binding 保持原样，启动流程迟到补写的同一 handle 仍能核对。回复或落盘丢失时幂等重试；`local inspect-service` 与 daemon 残留回收可读取已确认回执，无需重新联系不可达的旧 generation。该路径只结束旧占用，尚未实现同一 generation 在途模型服务的重新接管。
- 本阶段验证：Gear 59 项 TypeScript 训练测试、60 项 Python 测试通过；Hitch 16 项模型节点/监督/管理/跨仓库 RPC 测试通过，无跳过。跨仓库检查执行真实 Hitch CLI → Gear Python RPC，模拟 OS boot 归档及控制端丢失回执后重试；另复测真实 CPU 监督进程、独立 CAS 和 HTTP 引擎 fixture 的启停。启动周期、ML 包与 GPU 查询仍为测试数据，没有执行真实重启、CUDA 或 Docker 任务验收。Gear 类型检查、Hitch 构建/架构/语法与 diff 检查通过（380 source files、827 cross-module edges）。日志：`/tmp/gear-inference-generation-training.log`、`/tmp/gear-inference-generation-final.log`、`/tmp/hitch-inference-generation-final.log`。用户既有 Hitch 推理文档与备份逐字相同。

- 同 generation 活动进程接管底层已实现：`inference.attach` 按原 service/owner/inference ID、完整启动请求摘要和 process handle 核验；监督进程及引擎的 PID 创建时间必须仍存活并登记在未释放、未关闭的设备账本中，CUDA 设备还要求实际 compute PID 属于同一活跃 owner。实时 Python 环境与启动时 runtime 不同、设备/进程证据丢失或 HTTP 观察后引擎退出时拒绝接管。接管不启动、停止、fence 或释放进程，不生成探针 token、不清缓存，原身份与用量账本不改写。
- Hitch 的 Process launcher 复核当前节点、原启动摘要、实时 engine 配置与模型目录，沿用原已验证协议观察及时间；异步 RPC 前快照输入，接管模式不会因探针证据缺失退化成启动预热。新 managed-node 服务在发布 ready 前封存带摘要的 `attachment.json`，绑定 service/epoch/handle、模型/runtime/lock 和原探针。监督器 `recover(claims)` 可恢复明确选定的原 owner，保留服务身份并返回可释放的 lease；未声明的服务仍走既有回收，缺失或损坏的启动证据不采纳。恢复期间禁止新 acquisition，关闭监督器会等待在途接管协调。
- 该阶段只完成进程与监督器层的接管；当时 daemon/manager 尚未根据活动 worker lease 恢复网关、run 凭据及 owner 对应关系。后续接入情况见下方“活动 managed 网关恢复”；完整 remote capability 仍未开放。
- 本阶段验证：Gear 全量 Python 66 项、Hitch 36 项进程/接管/监督器/manager/节点 CLI/generation RPC/网关/运行时校验测试通过，无跳过。Hitch → Gear 的真实 CPU RPC 测试使用新客户端连续接管同一监督进程与引擎，HTTP 日志只新增 `/server_info` 和 `/v1/models` 查询；原 handle 与探针时间不变。CUDA/Python 包与模型输出的专项 fixture 只验证合同，不代表 GPU 或真实模型验收。Hitch 构建、架构（381 source files、829 cross-module edges）、语法及两仓库 diff 检查通过；用户原有 Hitch 推理文档与备份逐字一致。日志：`/tmp/gear-inference-attach-regression.log`、`/tmp/hitch-inference-attach-final.log`、`/tmp/hitch-inference-attach-build.log`、`/tmp/hitch-inference-attach-architecture.log`。

- 活动 managed 网关恢复：daemon/manager 已根据未过期的远程 execution lease、原 accepted offer、冻结 work spec、私有 model route、gateway receipt 与原 inference execution evidence，选出同 generation 的原服务与 owner 并接管。网关使用原回环端口、run-scoped 凭据和 binding；service ID、epoch、canonical run 及原执行证据不改写。新建 managed-node 网关封存只含身份与摘要的私有 receipt；缺失或篡改证明时拒绝推断接管，公开事件不输出地址或凭据。
- daemon 在恢复完成前等待 managed 模型请求，worker 心跳和完成回报仍可处理；恢复后重新校验租约再放行。worker 暂时离线且 execution lease 未过期时保留 owner，租约到期、撤销、generation 变化、eval/rerun 取消或 work 终结后撤销网关注册并释放 owner。正常 eval/rerun 恢复可接收原 lease，避免重复注册和提前释放；补齐监控释放与恢复 acquisition 并发时的交接。该路径已接入真实 daemon 启动入口，完整候选执行与资源回收仍需进程中断验收。
- 联调合同测试同时发现并修复了 immutable Chat 网关的标准 `/v1/chat/completions` 路由和请求字段校验：锁定采样参数、单 completion、工具能力与 token 上限，拒绝冲突设置；Chat 不再使用 Responses 的额外 token 预算或截断字段。Responses 原路径与预算规则保留。
- 本阶段验证：40 项模型恢复、网关、manager、daemon/worker、进程与跨仓库 RPC 测试，加上 55 项调度与远程 worker 回归，共 95 项通过，无跳过。包含真实 daemon HTTP 启动期间等待接管、原凭据/canonical 身份保持、离线重连、取消/到期释放、错误 receipt 拒绝及交接竞争；模型节点 RPC peer、CUDA 观察与模型输出使用 fixture，未执行完整 Harbor 候选任务。另复测真实 Gear CPU 监督进程的接管与回收。既有监督器测试改为等待实际 stopped 事件，消除固定 30 ms 等待在并行负载下的竞争。Hitch 构建、架构（384 source files、839 cross-module edges）、语法检查通过；本阶段没有 Python 源码改动，前阶段 66 项 Python 结果仍为原记录。日志：`/tmp/hitch-managed-recovery-final.log`、`/tmp/hitch-managed-recovery-regression.log`、`/tmp/hitch-managed-recovery-build.log`、`/tmp/hitch-managed-recovery-architecture.log`。这些证据不代表真实跨主机、CUDA 或训练端到端验收，完整 remote capability 继续关闭。

- 在途候选的真实 daemon 进程中断：新增独立 daemon、公开 `worker run` 与候选执行进程。第一次模型调用完成后 SIGKILL daemon，确认原 OS 进程终止，再在同一端口恢复；不重写 eval、offer、lease、服务及私有路由状态。原 worker 与候选进程继续第二次模型调用，生产恢复路径收取结果并导入同一 canonical run；任务 lease 只有一条，释放回执仍绑定原 execution epoch，interaction capture 包含两次完整调用。模型只有一次 start 和一次 attach，启动探针未重复，服务退出后原 service ID/epoch 保持不变。
- 该检查暴露并修复实际收尾缺口：worker 完成后，恢复监控可能先释放旧 owner，调度器随后取得同一 ready 服务，原先会刷新 inference execution 的 `prepared_at`。现在同一 managed service/epoch 的重复取得在文件锁内验证原 execution、lock/model/runtime 文件，内容一致时保留原字节与时间；源文件被替换时拒绝覆盖并释放本次取得的 owner。相关篡改拒绝与正常再次取得均已覆盖。
- 本阶段 53 项候选/网关/模型服务/跨仓库 RPC/packaged worker 测试及 55 项调度与远程 worker 回归全部通过，共 108 项，无跳过；构建、架构（384 source files、839 cross-module edges）、语法、diff 与用户既有 Hitch 推理文档备份比较通过。日志：`/tmp/hitch-live-candidate-final.log`、`/tmp/hitch-live-candidate-regression.log`、`/tmp/hitch-live-candidate-build.log`、`/tmp/hitch-live-candidate-architecture.log`。新 canary 的 daemon 中断、worker CLI、HTTP/RPC、结果导入和清理回执是真实执行；Harbor/Docker 命令、候选 bundle、模型输出与 CUDA/模型进程观察仍为 fixture。不能据此宣称跨主机、真实容器、模型推理或训练 GPU 验收完成，完整远程 capability 继续关闭。

- worker generation 提交竞态：原先 generation 校验和最终写入分离，旧凭据已轮换时，等待 offer/event 锁的接受、完成、释放和事件请求仍可提交；长制品流也可在轮换/撤销后发布。新增控制端 generation publication 保护，与注册、撤销及 heartbeat 的 worker 记录锁协调；接受 offer 的 lease index 与 offer 状态均在这次保护中写入。大文件接收/摘要校验仍在锁外，最终发布重新校验 generation 与 offer 状态，拒绝时移除临时文件。抽出协议解析模块以保持源文件行数限制，v1 wire 字段与持久回执格式不变。
- HTTP 身份边界：入口保存该 bearer 实际认证的 generation，再与 query/body/观察回执中的 generation 对照；旧 bearer 的慢请求不能在轮换后声称自己属于新 generation。调度与恢复发现 generation 已替换时立即返回 `worker_generation_mismatch` 并隔离旧 lease，而不等待可重连 worker 的宽限期。旧 resource epoch、未释放 offer 和容量预留保留；本阶段没有把新 generation 的心跳当成旧物理资源释放证明，也尚未实现跨 generation 清理回执。
- 本阶段验证：先用 6 项故障注入复现旧 generation 迟到提交，修复前全部未能拒绝；最终新增 10 项检查覆盖 offer/event 等待写入、流式上传中轮换/撤销、准备输入后轮换、即时隔离及原资源预留、真实 daemon HTTP 上传中轮换和慢请求伪称新 generation。最终 35 项协议回归、64 项调度/评分回归、29 项 packaged worker/模型恢复/现场观察回归全部通过，共 128 项，无跳过；原 daemon SIGKILL 候选续跑 canary 保持通过。构建、架构（385 source files、843 cross-module edges）、语法、diff 与用户既有 Hitch 推理文档备份比较通过。日志：`/tmp/hitch-generation-commit-before.log`、`/tmp/hitch-generation-commit-protocol.log`、`/tmp/hitch-generation-commit-scheduler.log`、`/tmp/hitch-generation-commit-integration.log`、`/tmp/hitch-generation-commit-build.log`、`/tmp/hitch-generation-commit-architecture.log`。验证仍未涉及真实跨主机、GPU 或 Docker 任务执行；完整远程 capability 继续关闭。

- 后续推进（同 generation worker 崩溃清理）：packaged runner 在 HTTP 接受前持久化本地执行所有权，绑定 offer/nonce、work、lease/resource epoch、generation、worker 进程、主机启动、root/Docker engine 身份。candidate 和 verifier 共用带 IPC 启动屏障的 Harbor supervisor；身份落盘前父进程死亡或写入失败时不启动 Harbor。进程探测失败不再当作“已退出”。
- 重启语义：原 worker 已退出且身份可核验时，先终止原 Harbor 进程组、确认停止，再按原 epoch 清理 Docker 容器/网络/卷并重新列举确认无残留，最后回报原 offer 失败及原 epoch 释放。已接受候选不会重新运行。记录缺失、worker 仍活着、root/主机启动/引擎变化、进程拒绝退出、资源观察失败时拒绝释放确认；新 generation 仍不能通过旧 v1 回执清理旧资源。接受前取消已有控制端的未执行证明，可结束预占；接受请求的重试现在跟随该 job 的取消信号结束。
- 本阶段验证：新增 19 项，覆盖真实 worker SIGKILL/原 Harbor 存活/同凭据 CLI 重启清理，身份写入完成前的启动屏障与父进程 SIGKILL，原 owner/nonce/generation/root/boot/Docker 引擎不一致，进程拒绝退出，资源复查与清理重试，以及接受前取消和未知已接受任务的清理要求。最终 52 项 worker/Harbor/评分回归、62 项调度/代际/协议回归、2 项真实 daemon/worker 中断 canary 全部通过，共 116 项，无跳过。候选启动次数保持 1；daemon 中断情形继续完成原 run，worker 中断情形停止原进程并释放原失败任务的 lease。构建、架构（386 source files、847 cross-module edges）、语法、diff 与用户既有 Hitch 推理文档备份比较通过。日志：`/tmp/hitch-worker-recovery-build.log`、`/tmp/hitch-worker-recovery-targeted.log`、`/tmp/hitch-worker-recovery-regression.log`、`/tmp/hitch-worker-recovery-canary.log`、`/tmp/hitch-worker-recovery-architecture.log`、`/tmp/hitch-worker-recovery-syntax.log`。模型节点/Harbor/Docker/GPU 观察仍为 fixture；这轮没有 Python 改动，也没有运行真实 Docker 任务或 GPU 训练。完整 remote capability 保持关闭。

- 继续推进（旧 worker 凭据失效后的停止）：原实现只重试 401 请求，旧进程一直存活，阻止后继 worker 的归属检查。客户端现在把控制端明确的认证/代际拒绝转为不可恢复的 `remote_worker_fenced`，中断本 generation 的请求；runner 的任务取消信号同步失效，执行器结束后调用本地清理，再以退出码 11 退出。不会等待 401 错误正文，也不会继续重试已经失效的凭据。模型上游的认证错误与 worker 身份拒绝分开处理，上游伪造的认证标记不会经 daemon 转发；连接重置、503 和任务范围错误保留原重试语义。
- 后续交接仍缺独立证据链：旧 worker 的本地清理不伪造旧 v1 完成/释放回执，控制端继续保留原 offer、resource epoch 和未确认的预占。下一步需要把原 generation 已认证的启动/资源归属凭据保存到控制端，再验证新 generation 针对它提交的独立清理回执；不能凭新 worker 的心跳或缺失旧文件放行资源。
- 本阶段验证：新增 13 项，覆盖 401 错误正文阻塞时即时停止、并发请求取消、结构化 generation/revocation 拒绝、凭据脱敏、瞬时/任务范围错误、runner 本地清理，以及公开 CLI 在候选运行中被轮换/撤销凭据后自行退出。真实进程测试确认 Harbor 候选停止、启动次数仍为 1、本地清理完成，控制端旧 offer 保留 accepted、lease 隔离到 lost、resource epoch 保留且没有释放确认。真实 HTTP 模型代理还验证上游 401/403/409 与伪造认证标记不会撤销有效 worker，真正的 worker 认证拒绝会停止它。最终 27 项客户端/runner/合同回归、37 项 worker/Harbor 回归、63 项调度/协议/模型代理回归、4 项真实 daemon/worker 中断 canary 全部通过，共 131 项，无跳过。构建、架构（386 source files、847 cross-module edges）、语法、diff 与用户既有 Hitch 推理文档备份比较通过。日志：`/tmp/hitch-worker-fencing-build.log`、`/tmp/hitch-worker-fencing-targeted.log`、`/tmp/hitch-worker-fencing-worker.log`、`/tmp/hitch-worker-fencing-regression.log`、`/tmp/hitch-worker-fencing-canary.log`、`/tmp/hitch-worker-fencing-architecture.log`、`/tmp/hitch-worker-fencing-syntax.log`。这轮没有 Python 改动；Harbor/Docker、模型与 GPU 观察仍为 fixture，未执行真实 GPU 训练或跨主机清理。

- 原 generation 的认证归属凭据已接入公开 Harbor worker：独立 v2 接受接口在控制端保存原 offer/work/输入、lease/resource epoch、root ID/路径摘要、主机启动摘要、Docker engine 与原 worker 进程身份；v2 进程接口在 Harbor 启动屏障内记录原 supervisor。归属先于 offer 接受发布，未完成接受不能授权进程；中间写入失败后重试保留首次接受时间。已接受的旧 v1 offer 不能事后补录归属，已有归属不能替换或降级。原 v1 offer、回执与私有 worker journal 格式保持不变。
- 接受与进程写入共用 offer 文件锁和最终 generation 保护；入口绑定 bearer 实际认证的 generation，慢请求不能轮换后改称新身份。客户端要求独立回执身份/摘要一致且不可缓存。修复 runner 响应丢失重试：接受、事件、完成与释放沿用原时间和事件序号，进程授权沿用原启动身份；释放已落盘后即使 offer 不再出现在列表中，也重放原释放请求完成本地记账，清理成功后不重复执行。这些归属记录仍不是跨 generation 物理释放证明，独立清理回执与旧预占核销仍待接入。
- 本阶段新增 12 项检查，覆盖独立归属与唯一进程、v1 兼容/拒绝事后补录、部分写入恢复、代际写入竞态、慢请求 bearer 身份、合同/响应篡改，以及有无归属扩展时各操作已提交但响应丢失后的幂等。强化真实 CLI 轮换/撤销测试，确认 candidate 启动前控制端已保存实际 worker/supervisor 身份，失效后原凭据仍保持不变。最终 22 项客户端/runner/归属测试、37 项 worker/Harbor/评分回归、34 项协议/代际/模型代理回归和 4 项实际进程中断 canary 全部通过，共 97 项，无跳过；构建、架构（389 source files、855 cross-module edges）、语法、diff 与用户既有 Hitch 推理文档备份比较通过。日志：`/tmp/hitch-worker-admission-build.log`、`/tmp/hitch-worker-admission-targeted.log`、`/tmp/hitch-worker-admission-worker.log`、`/tmp/hitch-worker-admission-protocol.log`、`/tmp/hitch-worker-admission-canary.log`、`/tmp/hitch-worker-admission-architecture.log`、`/tmp/hitch-worker-admission-syntax.log`。这轮没有 Python 改动；Harbor/Docker 命令、模型与 GPU 观察仍为 fixture，未进行真实 GPU 训练或跨主机清理。完整 remote capability 保持关闭，目标继续进行。

- 同一主机启动周期的跨 generation 清理已接入公开 worker。新 worker 在后台获取绑定原 admission 的 nonce/期限，严格核对原 worker、root、boot、Docker engine 和 supervisor；原 worker 必须已退出，只有原授权进程允许被终止，未获授权的本地 PID 不能被推测清理。清理后重新观察进程组与原 lease 的容器、网络、卷，已经标记 released 的本地 journal 也要重新检查，不能直接当作跨 generation 释放证明。
- 独立 receipt 由当前 generation 认证，最终写入与注册/撤销使用同一保护。原 v1 offer、nonce、terminal、回执摘要与 admission 保留原样；控制端在 lease 内写入 schema 3 的释放确认，保留隔离 epoch 和真正执行过的 resource epoch，核销原预占但不恢复执行权限。回执先落盘、lease 后更新的中断可重试修复；已确认事实可跨后续凭据轮换保留，待发布的旧 generation 请求则拒绝。后台清理保持心跳可用，清理成功后的回包丢失重放原观察，不重新执行候选，也不重复物理清理。缺少原认证归属、主机启动变化、进程仍存活、资源不空或 lease 曾在额外 epoch 执行时仍拒绝核销。
- 收尾协调同时处理已具有 schema 3 释放确认的 lease，避免物理资源先释放后遗留 collected 评分 journal。原成功评分可继续导入/完成交接，原中断任务只补失败/取消收尾，不伪造旧 v1 终态。新增评分恢复用例验证原 candidate bundle、assessment、结果摘要和派发次数不变。该回执只证明 Harbor 执行资源已释放，不能替代模型节点的 GPU 释放证据。
- 本阶段新增 14 项检查，覆盖独立清理与旧 epoch 核销、身份/资源/时间篡改、发布中再次轮换、回执落盘后 lease 发布失败、重发资源 epoch 拒绝、旧 v1 缺失归属拒绝、后台心跳与已发布但回包丢失、schema 2/3 边界、原 worker 存活/退出/进程变化/残留资源，以及成功评分的跨 generation 收尾。公开 CLI 的轮换/撤销 canary 已扩展为旧 worker 自行停止、新 generation 清理并确认原预占释放，候选启动和任务模型调用均仍为一次。最终 46 项归属/清理/runner 测试、63 项 lease/调度/协议/评分回归、4 项实际进程中断 canary 全部通过，共 113 项，无跳过；构建、架构（393 source files、865 cross-module edges）、语法、diff 与用户既有 Hitch 推理文档备份比较通过。日志：`/tmp/hitch-generation-cleanup-build.log`、`/tmp/hitch-generation-cleanup-targeted.log`、`/tmp/hitch-generation-cleanup-regression.log`、`/tmp/hitch-generation-cleanup-canary.log`、`/tmp/hitch-generation-cleanup-architecture.log`、`/tmp/hitch-generation-cleanup-syntax.log`。这轮没有 Python 改动，Harbor/Docker/模型与 GPU 观察仍为 fixture，未执行真实跨主机清理或 GPU 训练；完整 remote capability 保持关闭。

## 分节点 preflight 的本地验证

新增 25 项检查：11 项 Python 检查覆盖纯进程与旧镜像合同、训练前配置、独立失败汇总、源码归属、GPU 占用/不可观察和只读 RPC；14 项 TypeScript 检查覆盖冻结前 CLI、各节点故障与身份漂移、共卡/分卡设备下限、报告字段边界、旧 spec/lock 摘要、训练投影和跨语言 checkpoint 身份。公开 CLI 实际调用本地 Python 节点报告缺失源码，未生成 job 或资源申请；其他正向 GPU、Harbor 环境值为 fixture。

Gear 完整训练回归 73 项 TypeScript、77 项 Python 全部通过；Hitch 的跨仓库 process launcher/训练 binding 回归 7 项通过，无跳过。Hitch 检查实际执行节点 RPC、独立 CAS 和 CPU 服务进程，CUDA/SGLang 响应仍为 fixture。Gear 类型检查、构建与编译 CLI help 通过。日志：`/tmp/gear-placement-preflight-regression.log`、`/tmp/gear-placement-preflight-typecheck.log`、`/tmp/gear-placement-preflight-build.log`、`/tmp/hitch-placement-preflight-crossrepo.log`。本阶段未修改 Hitch 源码，未执行真实 SSH、Docker 任务或 GPU 训练；完整远程 capability 继续关闭。

## 主机重启清理的本地实现

新 Harbor worker 在接受任务前保存 schema 3 ownership，分别绑定可观察的主机身份与启动身份；本地执行 journal 使用 schema 2。原 generation 的控制端 admission 保存该身份，不能在接受后补录或替换。旧 ownership/journal 格式保持可读，同启动周期的恢复行为不升级其字节；缺少原主机身份的旧记录仍不能证明重启后的资源已释放。

清理通过原 root、Docker engine 和主机身份核对后，启动身份不同则跳过旧 PID/进程组的检查与终止，避免误伤新启动周期复用 PID 的进程。原 lease/epoch 的 Docker 容器、网络和卷经两次归属核验后删除，并重新列举确认全部消失；另一 lease 的资源保留。清理前后主机/启动/引擎必须一致。普通执行的状态变更也核对启动身份，旧 journal 不能在新 boot 下继续开始候选。

同 generation 沿用原失败/释放收尾；跨 generation 提交独立 schema 3 receipt，明确 `worker_status=previous-boot` 和当前主机/启动观察，不声称观察过旧进程组。原 admission、offer、执行 epoch 与候选身份保留，控制端仍在原 lease 写入 schema 3 释放确认并核销预占。原已授权 supervisor 不匹配、另一主机、旧格式缺少主机身份、引擎漂移、Docker 残留及后续 resource epoch 均不能借重启放行。已发布回执的丢包重试复用同一观察，不重复候选或物理清理。

本阶段新增 16 项检查，覆盖原始 host/boot 捕获、同/跨 generation 的 PID 复用保护、原授权身份与主机/引擎漂移、三类 Docker 资源清理及另一 lease 保留、残留资源重试、旧 journal 不升级、真实 HTTP 准入/回执/预占核销、旧 admission 拒绝事后补录、丢包幂等、后续 resource epoch 拒绝及 JSON schema 边界。公开 CLI 的轮换/撤销 canary 额外核对候选启动前控制端已经保存 schema 3 主机身份。

最终 50 项归属/重启/代际清理测试、69 项 worker/lease/Harbor/评分回归、10 项 daemon/worker 中断及认证边界检查、2 项公开 CLI 轮换/撤销 canary 全部通过，共 131 项，无跳过。类型检查、构建、架构（394 source files、867 cross-module edges）、语法、diff 与用户既有 Hitch 推理文档备份比较通过。日志：`/tmp/hitch-host-reboot-targeted.log`、`/tmp/hitch-host-reboot-regression.log`、`/tmp/hitch-host-reboot-canary.log`、`/tmp/hitch-host-reboot-generation-canary.log`、`/tmp/hitch-host-reboot-build.log`、`/tmp/hitch-host-reboot-architecture.log`。主机身份读取、存活进程、HTTP/RPC 和 CLI 中断为实际执行；前一 boot 身份与 Docker/Harbor/模型/GPU 观察为 fixture，没有重启本机或执行真实云端任务。本阶段无 Gear/Python 代码改动，真实跨主机、OS 重启与 GPU 验收仍待对应环境，完整 remote capability 保持关闭。

## 训练与评估交接、暂停和累计用量的本地修复

协调器先恢复尚未完成的原基线评估，确认释放后再运行完整训练 preflight；已持久化提交意图但丢失回复时直接协调原 job，避免其自身占用的 GPU 阻塞恢复。基线完成后的 runtime 漂移仍阻止新作业，已完成基线不重复计算。

隔离评估期间继续观察未释放训练 owner 的状态和累计成本。训练与评估可以在各自设备上重叠，但最终决定须等两侧都确认释放，并用最终总成本执行预算检查。暂停分别取消训练与所有未完成评估，一侧未结束或失联不会跳过另一侧清理；保留各自资源归属和已消耗用量，两侧确认后才进入 paused。迟到的 post-baseline preflight、有效 HF 导出或 dev 结果不能将暂停改回运行、触发下一分区或晋级；合法结果可在显式 resume 后复用。

GPU 进程观察改为整份严格解析：驱动诊断文本、非正 PID、损坏/额外字段以及混合有效和无效行均不能被过滤成“空闲”。设备账本在释放无法确认时保持原 owner 并持续累计单张物理 GPU 的费用；确认后才允许评估接管，旧 owner 费用冻结。完整回归还复现了服务刚启动就停止的真实 CPU 进程竞态：子进程可能在停止快照之后才登记，第一次 stop 因它仍存活而返回未释放。引擎创建与父进程登记现在使用同一 launch lock，停止快照包含刚创建的子进程，子进程执行前的自登记/原 supervisor 核验仍保留。

本阶段新增 12 项协调器测试、2 项严格 GPU 观察/账本测试、2 项进程启动时序测试。初始协调器故障注入 7 项中 6 项失败；迟到导出另行复现暂停后自行完成并晋级。修复后完整训练回归 85 项 TypeScript、81 项 Python 全部通过，Hitch 的 process launcher/训练 binding 跨仓库回归 7 项通过，共 173 项，无跳过。Gear 类型检查、构建、两仓 diff 检查与 Hitch 用户既有推理文档备份比较通过。日志：`/tmp/gear-handoff-before.log`、`/tmp/gear-handoff-late-export-before.log`、`/tmp/gear-handoff-inference-recheck.log`、`/tmp/gear-handoff-regression.log`、`/tmp/gear-handoff-typecheck.log`、`/tmp/gear-handoff-build.log`、`/tmp/hitch-handoff-crossrepo.log`。

CPU 子进程、跨仓库 RPC 与独立 CAS 为真实执行；GPU 清单/时钟、训练和评估结果为 fixture，未运行真实 SSH、Docker、SGLang 或 GPU 训练。本阶段未修改 Hitch 源码。provider 内部首次提交与取消的持久顺序协议、待完成评估的控制端实时用量入账仍未完成，不能据此宣称完整暂停/断网语义已验收。

## v2 训练启动与暂停的持久顺序

v2 训练现使用独立的 `training.control` RPC。控制意图由 `schemaVersion=2`、单调 sequence 和 start/pause 组成，原 request、job handle、checkpoint 和消费批次身份不变；没有扩展字段的旧控制端记录按初始 start/0 解释，切换意图时单独保存 `trainingControl`。节点在提交锁内持久化命令，拒绝较旧序号及同序号换意。已应用的初始 start 重试只协调原 incarnation，不会将 interrupted/failed/paused 作业自行重启；明确 resume 才生成新 start 意图，并继续要求原 GPU 与旧 Hitch slots 已结束。

暂停可以先于首次提交和 CAS 上传建立仅有准入身份的 tombstone。该记录从未启动 worker 或申请设备，因此不需要通过观察空闲 GPU 来证明自己的释放；迟到 start/0 不能清掉暂停标记。已经有进程的作业仍依赖原设备账本和实际进程释放。一次新的 start 不能覆盖尚未释放的 pause，失败时保留原暂停序号。已进入有序控制的 job 拒绝旧 submit/cancel 修改接口；v1 保留原 RPC。新 v2 preflight 明确要求节点 `orderedTrainingControl=true`，旧节点不能静默退回旧路径。

控制端的同作业锁覆盖节点状态读取/控制回复与相关 episode 协调，避免旧暂停的慢回复在新 incarnation 启动后取消新 episode。物理节点仍用本机提交锁和持久序号决定可否启动，不依赖跨主机共享文件锁。状态落盘和最终决定也核对控制意图，旧训练观察/清理回复不能覆盖新的暂停或恢复。独立评估 provider 的首次提交/取消仍未加入该协议。

新增 7 项 Python 检查和 4 项 TypeScript 检查：暂停先到、节点重建、迟到 start/cancel、同序号冲突、冻结请求/节点漂移、旧 RPC 拒绝、启动回复丢失、原 incarnation 保留、物理释放未确认、真实控制端→Python 子进程 RPC、旧暂停 episode 清理与新 start 串行，以及旧节点 capability 拒绝。最终完整回归 89 项 TypeScript、88 项 Python、7 项 Hitch process launcher/训练 binding 跨仓库测试全部通过，共 184 项，无跳过。Gear 类型检查、构建、编译 CLI help、两仓 diff 检查和 Hitch 用户既有推理文档备份比较通过。

日志：`/tmp/gear-ordered-control-python.log`、`/tmp/gear-ordered-control-targeted.log`、`/tmp/gear-ordered-control-integration.log`、`/tmp/gear-ordered-control-regression.log`、`/tmp/gear-ordered-control-typecheck.log`、`/tmp/gear-ordered-control-build.log`、`/tmp/hitch-ordered-control-crossrepo.log`。真实子进程 RPC 和内核文件锁已执行；启动/训练/GPU 观察仍为 fixture，未运行真实 SSH、SGLang、Docker 或反向传播，本阶段无 Hitch 源码改动。不能据此宣称完整单卡或断网验收已完成。

## 独立评估有序控制与持续计费的本地实现

Hitch 新增 `ordered_eval_control="2"` 与公开 `eval control --file`、`eval submit --control-file`、`eval rerun --control-file`。daemon 在原 idempotency key 锁内保存 start/pause 序号、冻结请求摘要、原 eval ID 和修复身份。首次提交前暂停只保留身份，迟到旧启动不能创建评估；同序号冲突和旧无序修改接口被拒绝。取消过的 rerun ID 不能复活，未取消修复可在更新 start 下协调原身份。重启、提交回包丢失和原 v1 submission/index 保留均有测试。

Gear 使用独立 `evaluationControl` 序号和不可变指令文件，先远端暂停再协调本地 journal，覆盖素材准备期间取消先到达的窗口。已有 daemon 提交但本地原 journal 丢失时不推定清理完成。修复结果在回包丢失后可以重新读取 canonical 结果，保留有效 slot 且不多花一轮修复预算。`pending_reruns` 不等于设备释放，实际交接仍核验原模型节点服务。

每次 `advance` 在继续待完成评估前及异常返回后，只读获取节点累计用量。实验预算耗尽会发出有序暂停，直到训练与评估都确认释放；等待期间继续入账，不能凭预算暂停直接认为 GPU 空闲。节点断连或服务记录缺失保留已知费用与预占；首次 controller intent 尚无 evaluator journal 时返回未知用量并协调同一身份。控制端没有新增后台计费定时器，离线用量由节点账本保存后在下一次协调时读取。

实验内同一评估 key 按累计最大值计增量，关闭旧 run 后修复原基线不会重复扣费。旧状态通过 evidence 成本兼容缺少 `chargedGpuSeconds` 的记录；迟到的较低费用快照不会覆盖较新的取消/观察费用。测试覆盖原基线 7 秒在新 run 恢复到 10 秒时只增加 3 秒、控制端重建、预算中止与释放等待、断连保留成本、非法用量，以及迟到合法结果。

最终回归：Gear 99 项 TypeScript、88 项 Python；Hitch 6 项有序评估控制、46 项调度/重跑/远程执行回归、7 项 process launcher/训练 binding 跨仓库测试，合计 246 项全部通过。两仓构建/类型检查、Hitch 架构/语法检查、编译后的 Gear CLI help、diff 检查通过，Hitch 用户既有推理文档与备份一致。测试中发现的 CLI 文件系统导入越界已移至 control-plane façade；新只读查询的 evidence key 投影错误也已修复并复测。

日志：`/tmp/gear-evaluation-usage-regression.log`、`/tmp/gear-evaluation-usage-typecheck.log`、`/tmp/gear-evaluation-usage-build.log`、`/tmp/hitch-ordered-eval-targeted.log`、`/tmp/hitch-ordered-eval-regression.log`、`/tmp/hitch-ordered-eval-crossrepo.log`、`/tmp/hitch-ordered-eval-architecture.log`、`/tmp/hitch-ordered-eval-syntax.log`。公开 CLI、认证 daemon HTTP、真实子进程和文件锁已执行；评估执行器、Harbor/Docker、模型和 GPU 观察仍为 fixture。本阶段未运行真实 SSH、SGLang、CUDA 或反向传播，不代表完整单卡或跨主机故障验收。

## Vast RTX 5090 的首轮硬件诊断

按用户要求使用 Vast CLI 在已有实例 `50249234` 执行限时检查；结束后确认无 GPU 计算进程、显存回到 1MiB，并停止实例保留缓存与磁盘。1.5B SGLang 原生生成、两轮 weights/tensor-IPC/KV 恢复后的 token/logprob 一致性，以及 Gear argv 在指定 Slime 版本中的真实解析已验证。CUDA 反向只使用 128×128 矩阵；未执行完整 Megatron 训练或 Hitch 受管理服务。最终显存恢复探针约 18.8 秒，结果仍标记 `validated=false`。

详细版本、失败定位、有效原始日志、资源状态及后续检查见 [2026-09-08 GPU 诊断记录](gpu-validation-2026-09-08.zh-CN.md)。早期只检查有限 logprob 的恢复结果已明确作废；不能把这些硬件诊断加入正式 runtime 的兼容探针证据。

## 真实 Harbor 与独立 worker 的训练传输

Vast 保持停止期间，已使用真实 Harbor 0.21.0、默认 Docker 制品构建、独立 worker 和公开 HTTP/CLI 跑通训练 binding。模型 fixture 驱动两次真实 bash 调用，reward=1，canonical run 导入、lease 释放、worker 退出及凭证不泄露检查通过。修复了大 Base64 制品的调用栈溢出，以及容器制品被错误按主机平台检查的问题。11 项传输、18 项制品/worker 回归和构建/架构/语法检查通过。

证据和复现见 [真实 Harbor 训练传输记录](harbor-validation-2026-09-08.zh-CN.md)。本轮模型仍为 fixture，不代表 Slime、原生 receipts、实际跨主机或 GPU 验收；全局远程模型 capability 保持未开放。

## 原生单卡 actor 更新诊断（2026-09-08）

96GB 级主机内存的临时 RTX 5090 已完成 1.5B 原生 Slime/Megatron 单次 backward、同步 checkpoint、HF export，以及 SGLang weight version 1→2 后再次生成，诊断耗时约 145 秒。导出层权重确有变化；临时实例已取回日志并销毁，原实例保持停止。诊断仍使用合成奖励，未走 Gear 完整任务/receipt/collect 或 Hitch 独立评估，因此 capability 与 runtime 的 validated 门禁保持不变。低内存实例此前在训练后卸载时失联，没有确认的 OOM 证据。详细范围、数值差异及资源记录见 [GPU 诊断记录](gpu-validation-2026-09-08.zh-CN.md)。

## 真实原生工具轨迹与适配修复（2026-09-08）

本地 Harbor/Docker 经真实 SSH 通道调用远程 1.5B SGLang，完整执行两次顺序工具调用并返回有效 0 分反馈。原生 token/logprob、canonical run、两个 receipt 的身份及原生前缀连续性核验通过，GPU 诊断耗时约 120 秒。修复了 wire/template 重编码改写原生历史，以及指定 Slime 适配器只返回第一个工具调用的问题；旧 runtime lock 通过 bridge/生成协议摘要变化拒绝静默沿用。Python 95 项回归及 Hitch 构建、架构、语法检查通过。临时实例全部销毁，原实例保持停止。

任务本身未完成；该结果验证完整失败轨迹的传输，不代表模型能力、optimizer 或独立评估验收。具体失败与修复过程、最终身份、费用及证据范围见 [原生轨迹联调记录](native-history-validation-2026-09-08.zh-CN.md)。

## 完整作业连接处修复（2026-09-08）

本地串联检查修复了 driver lease 与 controller/native 采样摘要不一致，以及 Harbor 将 harness 引用规范化为 `@commit:` 后被 Gear 错误拒绝的问题。训练与评估仍核对原提交 source、完整 commit、revision 和 artifact 身份。checkpoint 的重复封存改为核验并复用已有 CAS 内容，避免重复写入完整临时副本。102 项 TypeScript、98 项 Python 测试和类型检查、构建通过；实际 canonical 记录的离线回放不等于训练样本验收。下一次诊断的任务和模型输入在 CPU 上准备，原 GPU 实例保持停止。见 [控制端连接验证记录](controller-boundary-validation-2026-09-08.zh-CN.md)。

## 完整训练作业与独立评估进展（2026-09-09）

第 23 轮在无 Docker 命令和 socket 的远程 RTX 5090 节点完成真实本地 Harbor 轨迹、两条反馈接纳、backward、checkpoint 提交和 HF 导出，`committedUpdate=1`。停止实例后，控制端完整回收并校验 74 个依赖对象及 HF 有限权重。累计 GPU 用量约 361 秒；两个有效零奖励样本没有带来可报告的参数提升。该结果仍是未认证的单任务诊断。

第 30 轮 Hitch 独立评估已通过 Gear 的完整规范记录校验：新 run `run_7e5f9c3b68014f44a3442800e2fddf2e` 的任务、verifier、harness、模型摘要、推理锁与模型节点身份均匹配，观察有效、reward=0，用量约 69.7 GPU 秒，实际释放已确认。真实联调修复了模型别名长度、接纳前查询、SGLang 启动参数、普通/管理认证与 wire alias 覆盖完整 model ID 的问题。这是同一单任务的新物理评估，不是 heldout 测试或能力提升证明；训练与各次诊断分别保留自己的冻结请求和实际环境，未追认旧失败记录。该实例在第 31 轮恢复时被 Vast 明确报告资源不可用，现已完成停机备份和逐对象校验后删除；备份与删除凭据位于 `gear-vast-migration-20260909-04`。第 32 轮已在替换实例 `50316639` 完成两次实际更新与循环卸载/恢复，791.5126 GPU 秒；全部 117 个远端对象及 125 个完整依赖对象已校验回收。第 33 轮在相同冻结部署、node generation、runtime 和设备账本上完成独立评估，使用 97.0420 GPU 秒；原训练记录保持不变，两份租约时间区间不重叠且均已释放。评估进程实际占用 GPU 时，生产设备账本拒绝第二个 owner 的申请。实例已再次停止保留，证据位于 `gear-independent-eval-20260909-33/handoff-audit.json`。详细作业、CAS、资源与失败记录见 [完整 driver 诊断记录](full-driver-diagnostic-2026-09-09.zh-CN.md)。

第 34 轮先完成远程 Harbor worker 的 CPU 安装准备：固定 Node 26.7.0、Python 3.12.13、Harbor 0.21.0，89 个 Linux wheel、真实 Hitch Git/payload 和原任务镜像已封存。相同 CPU 安装脚本在本地 Linux 容器执行成功，Hitch runtime 与控制端完全一致。安装包共 100 个文件、约 1.65 GB，模型实例保持停止。没有创建第二台 VM；第 35 轮已将 SSH worker 接入训练 canary，8 项真实 Linux CPU 进程检查、3 项配置/参数/SSH fixture 检查及原本地 Harbor 真实 Docker canary 回归通过。第 36 轮补齐有界 Vast VM 执行脚本与停机前 SHA-256 回收，8 项 CPU 边界检查和实际只读准备路径通过；付费执行路径未运行。远程主机与原生 GPU 链路仍待实测。详见 [远程 Harbor 安装准备](remote-harbor-diagnostic-preparation.zh-CN.md)。

第 37 轮对已有原生 logprob 做了逐层 CPU 数值对照。FP32/BF16 与保存的 SGLang logprob 的样本平均绝对差分别约 0.0310/0.2360；4 项 tiny HF 模型对照在统一 1e-5 阈值内通过。已有 actor 诊断及第 32 轮训练均未启用 Slime 的 0.1 阈值断言，数值一致性尚未验收。当时已确认固定上游支持从训练 forward 保存逐 token logprob，实际 GPU capture 尚待执行，实例保持停止。详见 [logprob CPU 对照记录](logprob-reference-diagnostic-2026-09-09.zh-CN.md)。

第 41 轮已完成真实 GPU backward 与逐 token capture，重新汇总差异为 0.1758769336，上游指标与早期 0.1758769304 完全一致；差异稳定复现，原因尚未解决，仍未通过数值门槛。恢复时 Vast 分配了另一张 RTX 5090，本次按独立诊断记录实际 GPU UUID，没有改写旧冻结节点状态。17 个输出文件完成远端 SHA 对照，GPU 无残留计算进程，实例确认停止。第 38 轮网络中断还暴露了本地停机保护重试耗尽的缺口，现已加入持续重试与容器内独立自停进程；16 项 CPU 检查及实际远端保护就绪检查通过，实际断网后的到期自停尚未执行。详见 [数值对照记录](logprob-reference-diagnostic-2026-09-09.zh-CN.md) 和 [停机保护记录](vast-replay-recovery-2026-09-09.zh-CN.md)。

## 第 43～44 轮数值排查

新增残差/RMSNorm 舍入的四组 CPU 对照及实际 GPU HF teacher forcing，固定原两条 token 轨迹。32 项 CPU 检查通过；GPU 主命令约 18.35 秒，模型载入及四组计算约 1.703 秒。CPU/GPU 最接近原生的设置不同，四组 GPU 对照均未消除差异，原 actor/native 的约 0.17588 仍未修复；生产精度配置未修改。已确认现成 GLM-5 对齐开关不能直接用于当前 dense Qwen2 TE 结构。

15 个输出文件完成远端 SHA 对照，实际安装的两份 SGLang 源码与 CPU 参照相同，冻结节点状态不变。实例 `50316639` 已停止保留。详情、逐组数据和资源口径见 [数值对照记录](logprob-reference-diagnostic-2026-09-09.zh-CN.md)。这项诊断不替代远程 Harbor、双卡或断网恢复验收，完整目标仍未完成。

## 第 45 轮：attention 后端偏差定位

在固定模型、token 和其余训练参数下，仅把 Slime attention 后端从 `unfused` 改为 `flash`。真实日志确认 FlashAttention 2.8.3，backward 完成；原生/训练 logprob 平均差由 0.17588 降至 0.03131，pg clip fraction 降至 0。该短样本结果低于默认 0.1 门槛，仍为 `validated=false`，不代表完整工具轨迹和新 recipe 已验收。

两个诊断入口默认改用 `flash`，可显式选择 `unfused` 复现历史。CPU 检查确认原完整请求可精确复现，backend 变化产生不同冻结参数和 recipe 摘要，未知 backend 被拒绝；没有静默 fallback。14 个远端文件通过 SHA 对照，实例 `50316639` 停止保留。下一步在新冻结配置和当前真实 GPU 身份下验证连续更新、真实工具轨迹与独立评估；第 32～33 轮证据继续对应原 unfused 配置。详见 [数值对照记录](logprob-reference-diagnostic-2026-09-09.zh-CN.md)。

## 第 46～49 轮：FlashAttention 完整训练与独立评估

在保留实例 `50316639` 上，以新的冻结配置完成两次实际更新、九份原生 receipt 校验和完整 collect。两轮 logprob 平均差分别为 0.01713、0.01733，实际使用 FlashAttention 2.8.3；两次训练后显存恢复至 1.54 GB。训练使用 715.17 GPU 秒，125 个依赖对象和有限 HF 权重已在停机后校验。四个奖励均为 0，HF 权重未改变。

经两次连接失败后的有界停机，改用现场 Vast SSH 代理，在同一冻结节点与设备账本上完成 Hitch 独立评估，使用 103.68 GPU 秒，reward=0。原训练 lease 不变、两侧占用不重叠、均已释放；实际推理占用时第二个 owner 被拒绝。实例确认停止保留。连接探针补齐当前地址读取与双栈相同端口处理，六项 CPU 检查通过；没有据 SSH 失败删除可用实例。

清理仍遵循先复制校验再删除不可用实例：此前不可用实例已经删除，本轮没有新增实例删除。为复用原磁盘，核对本地和远端 CAS 后清理了约 43 GB 的重复 checkpoint 工作副本，备份和环境保留。日志打包和本地文件名检查的问题均在停机后完成副本/摘要核对，未为取日志重启 GPU。详见 [完整 driver 与评估记录](full-driver-diagnostic-2026-09-09.zh-CN.md)。这仍是单任务诊断，运行未启用 Slime CI 断言，完整目标及认证门禁保持未完成。

## 未完成与下一步

| 顺序 | 剩余工作 | 验收证据 |
| --- | --- | --- |
| R1 单卡故障恢复 | 单卡实际中断与恢复、checkpoint / export 边界、响应丢失、服务所有权和断联期间用量；停止守护到期实测 | 原 job / slot / batch / commit 身份及执行次数；物理释放和 GPU 用量；Vast 停止确认 |
| R2 信息隔离 | 请求、实际 CAS 上传闭包、反馈投影、sandbox 生成权限和凭据边界的验证 | 敏感哨兵不可达、合法训练仍可进行；公开证据扫描、越权拒绝 |
| R3 runtime 认证 | 将上述证据绑定到实际代码、模型 / recipe、provider、节点环境与单卡范围，接通正式准入 | 缺项 / 摘要损坏 / 身份漂移拒绝；全部必需项通过后的认证及 preflight |
| 延后 | 远程 Harbor / Docker、四种部署组合、双卡回归 | 本轮不租用相应资源，不开放未验收 capability |


## 本地复现进程验证

Gear Python >=3.10 验证环境需安装 `python/pyproject.toml` 中的 `psutil`。可通过 `GEAR_TRAINING_TEST_PYTHON` 指定独立虚拟环境，运行 `npm run test:training`；无需安装 CUDA 或 SGLang 即可运行 CPU 合同测试。

在 Hitch 仓库构建后，用以下环境变量启用跨仓库进程测试（普通 Hitch 测试不要求安装 Gear）：

```sh
GEAR_TRAINING_TEST_PYTHON=/path/to/venv/bin/python \
GEAR_TRAINING_NODE_PYTHONPATH=/path/to/gear/python \
node --test dist/test/inference-process.test.js
```

模型节点配置中的 `inferencePort` 是节点回环端口；Hitch `InferenceNodeConnection.gateway` 分别指定控制端 `localPort` 和节点 `nodePort`，后者必须等于该端口。本地 transport 两个端口必须相同。它与训练 rollout gateway 是不同服务，部署接线时必须分别配置。

## 2026-09-09：按收窄范围补单卡恢复、隔离与认证门禁

先更新设计第 7、8 节和本记录当前范围，远程 Harbor / Docker 与双卡验收延后。实现新增以下行为：

- driver 恢复先核对连续 update commit、原 job / batch、checkpoint 的 actor / optimizer / RNG、cursor 和 compatibility；commit 已发布后残留的 pending receipt 只有与原 commit 一致才可清除，冲突拒绝。pending export 恢复显式发布最新进度，supervisor 收尾从 SQLite 读取已提交更新，避免显示旧计数。
- 所有更新已提交但最终制品记录未完成时，只补齐不可变结果和进度，不再初始化 CUDA / Ray / SGLang。新增导出失败、commit 回复丢失、重复恢复及 pending 冲突测试；CPU driver / snapshot / ownership / ordered control 的 23 项通过。
- 模型输入仅上传快照列出的文件，JSON 文件按不透明字节传输，不再递归取出其中的控制端引用。快照额外引用会拒绝。controller → 真实 Python 子进程 RPC → 独立 CAS 的哨兵检查通过：dev、held-out、verifier、管理凭据内容均不出现在节点对象中，合法模型配置仍可上传，无作业或设备租约创建。另有 22 项 node trainer / episode 投影检查通过。
- 新增限定本地 Harbor + process 模型节点 + 单卡串行调度的认证格式与离线封存入口；证据绑定 runtime / bridge、模型形状与 recipe、实际 GPU / node / provider、固定 Harness。逐项要求 GPU、真实进程或远程进程证据，原始审计文件须先核验 SHA-256 和长度；给 Trainer 的证书仅含检查及制品摘要，原始任务/日志不随证书上传。证书属于有原始制品支撑的操作方验收声明，不是 GPU 厂商签名。缺恢复/隔离项、旧 boolean checklist、CPU 代替 GPU、漂移或延后拓扑均不能通过。
- 认证 / preflight / placement 的 29 项 CPU 合同通过；Python 训练回归 155 项通过。TypeScript 训练回归首轮 111 项通过、1 项旧快照 fixture 被新校验拒绝；补齐该 fixture 的文件清单后独立复测通过。新增实际信号注入测试验证三个边界仅停止/杀死原拥有的 CPU 进程，不影响旁路进程。以上均不冒充实际 GPU 证据。

第 50 轮尝试恢复保留实例 50316639，Vast 在执行前返回资源不可用，已确认停止；未启动新 bridge 或 GPU 测试。更换实例前，通过 Vast copy 取回 Megatron，核验 commit 和既有补丁；本地 184 个训练对象共 38,607,876,564 字节重新通过 SHA-256。原实例确认数据可保留后删除，证据位于 `gear-vast-replacement-20260909-52/destruction-confirmed.json`。两次替代报价在创建时返回 `no_such_ask`，账户未新增实例；正在处理可用报价。**R1 的实机故障、R3 的正式认证仍未通过，runtime 保持 pending。**

替代实例 50380854（第 54 轮）已创建，1×RTX 5090、报价约 128GB 主机内存，采用可中断计费，设置的最高总价约 $0.50/小时。镜像初始化约 300 秒后立即确认停止，模型和 Megatron 通过 Vast copy 在停止状态上传；本轮测试使用全新第 55 轮节点与身份，不重建或修改已删除实例的冻结记录。Gear 最终 113 项 TypeScript 回归、Hitch 17 项权限/代理/跨进程恢复检查通过，无跳过。

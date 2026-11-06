# GPU 训练与外部端点评测诊断（2026-10-15）

[公开验证摘要](training-gpu-loop-2026-10-15.json)包含最终全闭包、离线核查及精确实例销毁记录。

本次在一台 2×RTX 3090 主机上，使用真实 Hitch / Harbor 任务反馈和 Slime / Megatron，完成了一组两条 rollout、一次训练更新提交、原生 checkpoint 保存及不可变 HF 导出，再将导出的 candidate 部署为普通外部端点，完成严格独立评测及基线配对。训练使用 GPU 0；普通外部 SGLang 服务使用 GPU 1。基线与 candidate 均为有效评测、reward=0，配对 meanDelta=0。

**这是有界流程诊断，`validated:false`，冻结的 runtime lock 仍为 `validation:"pending-gpu"`，不是正式运行时认证。** 两条训练 rollout 的 reward 均为 0，原生训练日志观测 loss=0、grad norm=0。它证明训练步骤与制品链路执行，不能证明非零策略梯度、质量提升或晋升。完整制品本机保全、离线 finite 核查与精确租机销毁现已完成；费用按实际创建至 absent 确认时长估算，不冒充最终账单，也不改变上述诊断边界。

此前的 [外部推理双卡短验收](external-inference-gpu-2026-10-15.md) 是另一轮推理拓扑验证。本报告增加训练与普通评测静态分卡的诊断证据，不改变此前记录的范围。

## 完成证据与未验证边界

| 环节 | 当前证据与边界 |
| --- | --- |
| CPU 环境与任务身份门禁 | 真实 Harbor / local-docker 加受控普通 Chat 端点完成两次工具执行、三次模型调用，reward=1；六项 canonical identity 与冻结的 remote-docker CPU canary 一致。它验证任务链路，不是 GPU 模型结果 |
| 普通基线服务就绪 | SGLang 0.5.15.post1，原始 HF 模板，`qwen3_coder` 工具解析器，省略可选 reasoning parser；实际 Hitch `models connect` / `inspect --verify` 通过 |
| 基线独立评测 | 真实 `HitchModelEvaluator` 完成，`valid:true`、`inferenceError:false`、reward=0；不是 fixture reward，也不把任务失败写成基础设施失败 |
| 精确训练 rollout | 一个任务、一个 group、两条真实 episode，reward=0/0；sealed batch 的模型 token mask 合计 401，与训练账本一致 |
| 训练与提交 | 第三轮完成一次真实 backward / optimizer 步骤；`committedUpdate=1`、`execution="completed"`、`phase="checkpointed"`、`resourcesReleased=true` |
| checkpoint 与 HF 导出 | 节点返回完整 trainer-files 快照、HF snapshot、export validation 和同一 update commit；导出 validation 为 `valid:true`。这不等于已在另一进程恢复 optimizer |
| 训练清理与普通服务隔离 | 实际归档记录确认训练终态、GPU 0 无计算进程、GPU 1 服务 PID 未变化且仍存活，fresh Chat 请求 HTTP 200；精确 actor_train 窗口内有 12 次可见共享推理成功 |
| candidate 独立端点评测与配对 | 新 HF snapshot 实际部署并通过严格 Hitch 检查；真实评测 `valid:true`、`inferenceError:false`、reward=0。`pairModelEvidence` 通过，dev meanDelta=0、inferenceErrorRate=0 |
| 完整本机制品保全与离线复核 | **PASS**：全闭包 108 个对象、35,467,670,234 原始字节的 SHA-256 / size 核验通过，inventory `sha256:e4ddcbf9aa52e354e0e24c4b0d35121e7056e53e4871ae6175a179c311aff19a`；独立复核当前缺失对象为 0；离线 collector 实际复核 106 个对象、35,467,666,730 字节，HF finite 检查通过、reward=0/0；历史 metadata/batch 预检与最终二进制闭包结果分别保留 |
| 模型服务与任务 daemon 收尾 | 配对完成后由部署所有者停止 candidate 服务及本轮 Hitch daemon；操作者观察 `nvidia-smi` 计算进程为空。它不代替租机销毁证明 |
| 费用估算与租机销毁 | **PASS**：实例 56035925 于 `2026-10-15T07:32:29.801710Z` 确认 absent；从 `2026-10-15T03:34:31.884667Z` 到该确认共 3.966088 小时；Vast 计算与磁盘估算 $2.282704，含 $1 传输预留的保守 Vast 估算 $3.300331（< $5）。既有跳板网络未计入，充值不算支出 |

## 冻结环境与布局

| 项目 | 本次实际配置 |
| --- | --- |
| Gear 训练 Python payload | `536ed7f`；训练中不替换冻结的 Python runtime。后续 TS gateway 清理修复为 `a8def4e` |
| Hitch | `686928d2e7b0e1ea583d6d7c9e302affb72a2c44`；训练、基线与 candidate 配对全程保持此版本 |
| 固定模型 | `Qwen/Qwen3.5-2B@15852e8c16360a2fea060d615a32b45270f8a8fc`，BF16，`Qwen3_5ForConditionalGeneration` |
| 固定训练镜像 | `slimerl/slime@sha256:626fbff9c062bc3723ee617a6930ff96913750f6847a8df9e2319d84f8169c45` |
| 上游训练源码 | Slime `41014d1f29e201137fdffce737bb8bac65bc5219`；Megatron `1dcf0dafa884ad52ffb243625717a3471643e087`，使用 runtime lock 记录的 Gear export / optimizer restore 补丁 |
| 运行时 | Python 3.12.3、PyTorch 2.11.0+cu129、CUDA 12.9、SGLang 0.5.15.post1 |
| 任务执行 | 本机 Gear / Hitch / Harbor 0.21.0 / Docker，`taskExecution.provider="local-docker"`；GPU 模型节点在远端。不是远程 Harbor worker 验收 |
| GPU 布局 | 两张 RTX 3090；GPU 0 内部 actor/rollout colocated，DP=1 / TP=1 / PP=1；GPU 1 专用于部署所有者管理的普通端点。训练 resources 不包含推理卡 |
| 训练容量参数 | group=2、global batch=2、micro batch=1、一个 update；context=2048、每次最大生成 256、max episode steps=16、总 rollout token 上限 4096 |
| 训练采样与内存 | t=1、topP=1、topK=-1、`enable_thinking:false`、`zeroVarianceGroup="keep"`；unfused attention、full recompute、CPU optimizer offload、logprob chunk=256、logprob backward offload |
| 训练预算（第三次请求） | `gpuSecondsScope="training"`、`totalGpuSeconds=1800`；普通推理 GPU 用量未知，不填 0 |
| 普通独立评测 | Chat Completions；context=16384、SGLang static memory fraction=0.65；`max_output_tokens=1024`、temperature=0、串行工具、并发=1、max episode steps=16、infra / repair retries=0 |

任务 `one` 是冻结的两步终端 canary：要求两次命令形成指定文件内容，并由实际 verifier 检查。Harness 为 `training-tool@ec22802b538aa50a1c7d8aa1930360d095ae3133`。它用于测试 rollout、工具执行、反馈和制品流程；基线与 candidate 均复用这个任务，因此不是 held-out benchmark。

Mac Docker engine 的 architecture 为 aarch64，任务镜像为 amd64。CPU 门禁实际运行成功，canonical harness artifact、revision、task、verifier、environment 及 harness ID 全部与冻结输入一致，任务 lease 已 released，相关容器、网络、卷已确认不存在。

## 三次训练尝试

| 尝试 | 结果 | 保留的事实 |
| --- | --- | --- |
| 01 | 未完成，安全暂停 | context=1024 / max episode steps=4；产生真实模型反馈后遇到步骤上限及后续无效 episode。控制端发出取消，最后 `paused`、`resourcesReleased=true`、`committedUpdate=0`，保留 failed summary；487 rollout tokens、一次 group resample、805.968 training GPU seconds |
| 02 | 未完成，安全暂停 | 改用更大的 context / step 上限后，第一轮遗留的本机 SSH MUX 仍持有训练 gateway 端口，产生 `node-route-unavailable`。此轮没有 rollout tokens、没有 update；原 job 身份被保留，操作者协调到暂停和资源释放后清理原有自属 MUX |
| 03 | 一次更新完成 | 为该次尝试重新冻结节点代际、request 和 job 身份；`admitted → collecting → training → exporting → checkpointed`，最终 completed / committedUpdate=1 / resourcesReleased=true；无 group resample，401 rollout tokens，1221.733 training GPU seconds |

第三轮 controller summary 的总 elapsed 为 1501.745 秒，包含控制端轮询、制品元数据收集等，不能当作单次 GPU kernel 时间或吞吐量。各失败尝试的用量仍属于本轮真实消耗；第三轮训练账本不是整个租机生命周期成本。

`a8def4e` 为 `ModelNodeTransport` 增加显式 `closeGateway(controllerDirectory,nodePort)`，只关闭本实例 node / connection / workspace 身份匹配且 record / socket 权限正确的自属 SSH master；本地 transport 无操作。不杀其他 SSH，不停止模型服务，不改变核心训练调度，也不由生产路径自动调用。诊断 canary 仅在 fresh `training.inspect` 确认终态与资源已释放后调用，失败保留 cleanup error。类型检查、build 及 35 项相关测试通过；测试覆盖实际 argv / Unix socket、身份漂移拒绝、幂等、失败后重试、端口释放和无关连接 / 模型服务存活。

第三轮启动时已加载修复前的 TS 模块，收尾由操作者 fresh-load 新 transport 执行。第一次 close 的回执被后续幂等重试覆盖，现存 `gateway-cleanup-03.json` 只证明 fresh completed / released 状态和 `closed:false, reason:"missing-record"`；不将它表述为保留了首次成功关闭回执。独立的端口检查在 `2026-10-15T04:52:13.648Z` 实际重新 bind 32011 成功。

## 真实 batch、训练数值与导出

第三轮 sealed batch 包含一个 group、两条 episode，对应实际 Hitch run：

| 槽 | Hitch run | reward | 生成 token mask 合计 |
| --- | --- | --- | --- |
| 0 | `run_53ac975129fe4e7299a633b09b11a0f7` | 0 | 110 |
| 1 | `run_73a9cd1310c54d7f8ecf09cbbc53c74e` | 0 | 291 |

两个线性 Sample 各自保存 152 / 387 项 response mask 与 rollout logprob；其中工具等非模型部分 mask 为 0，不能将数组长度全部计作训练生成 token。模型 mask 合计 401，和原生 rollout usage 一致。实际离线 `verify_updates` 预检已核对这两条真实 run、有限 logprob、mask/长度及同一 commit/cursor/batch 引用链，`metadataAndExactBatchVerified:true`；当时二进制未全部保全，预检如实记录 `fullBinaryClosureVerified:false`。最终保全已完成，另记录 `fullBinaryClosureVerified:true`；完整本机 collector 复核同一两条 run、commit/cursor/batch，并通过 HF `finiteWeightsVerified:true`。

本轮 reward=0/0，设置 `zeroVarianceGroup="keep"` 后仍执行训练步骤。已保存原生训练日志记录 loss=0、grad norm=0、`train_rollout_logprob_abs_diff=0.010318692773580551`；没有声明 actor 与 rollout logprob 逐位相同或补齐数值认证。这不证明有效学习，也不为流程证明注入虚构的 0/1 reward。导出前后 weights digest 不同不能单独证明学习；张量级差异、转换表示及可能的 optimizer 行为必须另行检查，不能以文件哈希代替策略梯度证据。

节点的 trainer-files manifest 包含 7 个文件，共 26,347,982,329 字节，包括两份约 13.17 GB 的 `.distcp` shard、`.metadata`、`common.pt`、dataset state 与 iteration marker。checkpoint 的 actor、optimizer、scheduler/RNG 引用共同指向这一完整快照。HF manifest 包含 17 个文件，共 4,571,180,915 字节，其中七份模型 shard 和冻结 auxiliary safetensors 同时保留。数字来自封存 manifest；这两份完整快照均已本机保全，并通过全量 hash / size 审计。全闭包 108 个对象、35,467,670,234 原始字节的 SHA-256 / size 核验通过，inventory `sha256:e4ddcbf9aa52e354e0e24c4b0d35121e7056e53e4871ae6175a179c311aff19a`；独立复核当前缺失对象为 0；离线 collector 实际复核 106 个对象、35,467,666,730 字节，HF finite 检查通过、reward=0/0。finite 结果针对导出 HF 权重，不构成 optimizer 另进程恢复证明。

| 制品 | 实际摘要 |
| --- | --- |
| 第三轮 request | `sha256:d024999ceb0987db0be5c47425f132a9bca9e1e9168549bd7d9b5afedd25486b` |
| sealed consumed batch | `sha256:607be953af50346211a419bb2111db5a28299be32b2e723230e01f5550ae2c33` |
| update commit | `sha256:e1e4fd2b5279eab4e9bbe0c4859145f3868f40f1ffc35ccf0fdcb2013c0d0a1c` |
| checkpoint | `sha256:84d099410edcb339a3f3caa657b22c29a80d2167fb7884b35ef685b07a7ca77f` |
| native trainer snapshot | `sha256:ca19961c780611a0fefeac427c33fa8aaa512343fab4fb7fc101825d8f386caf` |
| parent HF snapshot | `sha256:1306768fb6e2bc1e7aef0e51af35a5e89650052e3188a1178b9ff846f0c5efe7` |
| candidate HF snapshot | `sha256:eafa31f96c6f16094e064b64b48af94b5690401d530d86a1b605ee1af81b5b7e` |
| candidate weights | `sha256:9a309d4116f032aa72e75fcd29c1fde9fca042d76b2817f13cab4d29bf2a7dc2` |
| export validation | `sha256:3cf6ddfcc55a32cce8b01d5477d095f4129de47beba53e9aac062bd70431dfd5` |

`exportValidation.source="slime-megatron-synchronous-save-and-hf-export"`，`valid:true`，`runtimeProbeRefs=[]`。它证明该次保存与导出绑定，不会自动补齐正式 certification 所需的 probe evidence。

## 普通外部端点评测

评测使用现有 `ExternalFileEndpointPreparer`、`modelEvaluationRequest`、`modelEvidenceKey` 和 `HitchModelEvaluator`，按 HF snapshot digest 查找 ready binding。临时操作者 helper 只准备诊断绑定和调用现有 evaluator；没有管理模型服务、选择 GPU 或跳过 admission。部署所有者先实际核对封存 HF snapshot、只读部署文件和启动参数，再产生 `source="vast-training-smoke-operator"` 回执；`deployment_ref` 绑定实际部署证据的摘要。此信任源明确属于本次操作者诊断，不冒充正式 CI 部署认证。普通 external endpoint CLI 如实返回 `identity_verified:false`；严格 `inspect --verify` 证明协议可用性，HF 权重身份由独立操作者部署证据绑定，不能将 API 检查描述为引擎挂载权重认证。

普通 SGLang 初始配置显式使用 `qwen3` / `deepseek-r1` reasoning parser，严格 SSE 检查因没有普通 content 而失败，失败记录保留。最终使用官方可选参数的默认关闭方式：省略 `--reasoning-parser`，保留模型原始 HF 模板和 `--tool-call-parser qwen3_coder`。公开 service config 将关闭状态记为 `reasoning_parser:"none"`；不是向 CLI 传入字符串 `none`。未改模板、未加 token budget 补偿、未削弱文本或 named-tool 检查。

训练 ExactGateway 的解析条件单独冻结，不能将普通服务配置冒充训练配置。固定 Slime 的官方 XML tool-call fallback 可以解析该模型模板的 `<function=...><parameter=...>` 命令参数；本次封存的真实训练 batch 才是是否产生有效轨迹的依据。

基线结果：

| 项目 | 记录 |
| --- | --- |
| eval / run | `eval_67feb8cec96844c686e5f162bac52213` / `run_4bc0eed0ca6d4de198c44bb23222878d` |
| 任务 | `one`，attempt=1，`valid:true`、`inferenceError:false`、reward=0 |
| usage | 4 requests，2038 input tokens，157 output tokens，30.837 秒；来源 `model-interactions-v1` |
| 推理 GPU 用量 | `gpuSeconds:null`、`gpuSecondsSource:null`，没有将未知用量补零 |
| evidence key | `sha256:067bd2977b343ed4221f75b86ee997e2964e64387e1ee589310c999d56f20c18` |
| binding digest | `sha256:e68ba51495daa65fd94dbd40cd24902dd91363abd965db2a952f868077ac3532` |

candidate 使用实际 `eafa31f...` snapshot、独立 wire model `smoke-eafa31f96c6f`、revision `sha256:21716b1b9db7eb9964b61c34e8bd2a251fb2a2cad8af277a50b67932fa15c256` 和新的部署回执，实际 `models connect` / `inspect --verify` 通过后才提交评测。

| candidate 项目 | 记录 |
| --- | --- |
| eval / run | `eval_cfb4d4051956496b81aaf748d7d4e2b7` / `run_5b5dca8f2093493fbd686e5ae218c1f4` |
| 任务 | `one`，attempt=1，`valid:true`、`inferenceError:false`、reward=0 |
| usage | 4 requests，2038 input tokens，157 output tokens，33.010 秒；来源 `model-interactions-v1` |
| 推理 GPU 用量 | `gpuSeconds:null`、`gpuSecondsSource:null` |
| evidence key | `sha256:32f37775d8e25901046cfa5684dec8dfa85e1a68a9fc0de61f506585e2f41008` |
| binding digest | `sha256:2be79778649536ae46c14ecd30777cbec4d3209cd5d1372fd9b735350d8f855e` |

基线与 candidate 的公共 condition 全等，包含同一 runtime / protocol / sampling / budget、数据、任务环境和 verifier；subject 的模型版本与权重不同。实际 run 与训练及基线不同，`pairModelEvidence` 通过。结果为 partition=dev、单任务 baseline=0 / candidate=0 / delta=0、meanDelta=0、inferenceErrorRate=0；只有一个任务，standardError=null。这里的 dev 标签不使训练 canary 自动成为独立 held-out 数据，也不证明质量提升。

## 资源隔离与制品保全收尾

训练节点只分配训练 GPU，普通服务由部署所有者独立启动和管理。训练完成后，操作者检查到训练 GPU 0 无计算进程，GPU 1 上原基线 SGLang PID 10739 未改变且存活，新的 Chat 请求在正常 1024 token 上限下返回 HTTP 200。训练 `resourcesReleased=true` 与共享服务继续占用其推理卡同时成立；任务完成不代表推理 GPU 已释放。该检查不等于动态共卡调度或跨任意作业的统一互斥证明。

资源记录包含 3068 行 GPU 采样，跨越全部三次尝试；观测到训练卡峰值 20513 MiB、推理卡峰值 16835 MiB，不能将它们改写为仅第三轮的峰值或所有配置的容量保证。共享请求日志跨全部服务配置共 190 次请求，其中 160 次可见 HTTP 200。原生 actor_train 从 `04:37:53Z` 到 `04:39:34Z`（约 100.4 秒），有 12 次成功的共享请求在此窗口启动；不将更宽的 reference/logprob 前向窗口也算成 backward 重叠。

远端证据归档已保存到本机，大小 104179 字节，SHA-256 为 `7419e364e4f3eb0aaf48ed0e201dbc4bde4eab8016e13bfd74d7b6c450103613`。其中 `isolation-after-training.json` 保留实际 completed/released 状态、原 PID 和 fresh 请求；`candidate-inference-stopped.json` 保留部署所有者停止后 GPU 计算进程为空的观察。这是日志/元数据归档，不含完整 native/HF 权重。

完整保全最初使用下载专用临时 helper：先复制并校验 controller CAS 锚点，再展开实际 artifacts 依赖，补充 update commit 的隐式 `consumedBatchDigest` 边，并将 snapshot 内 JSON 作为文件数据。小文件使用实际节点传输；大文件复用系统 rsync 的 stable partial / append 下载，只有收到完整传输 ACK 并经过原始 SHA-256、精确 size 校验后才发布到本机 CAS。失败保留 partial，不能把部分文件当作完整对象。最终已完成全闭包审计、完整 checkpoint / HF 数据核对及离线 collector：全闭包 108 个对象、35,467,670,234 原始字节的 SHA-256 / size 核验通过，inventory `sha256:e4ddcbf9aa52e354e0e24c4b0d35121e7056e53e4871ae6175a179c311aff19a`；独立复核当前缺失对象为 0；离线 collector 实际复核 106 个对象、35,467,666,730 字节，HF finite 检查通过、reward=0/0。字节数为去重 CAS 原始对象大小，不是压缩后的网络流量。

第一轮保全为改进大文件排程，由操作者只停止本 helper 自属 rsync 进程组，等待其记录失败并保留 partial 后，使用相同 artifacts、request、node identity 及输出目录重跑。二进制根按已封存的文件大小降序排序，仍复用四路生产 walker、原始 ContentRef 和全量 hash/size 校验；没有删减 checkpoint 或放宽发布条件。

后续下载遇到 SSH 255 中断，传输失败保留未验证 prefix；约 06:29 UTC，操作者观察到临时 helper 目录丢失。原始 controller 输入的字节副本已丢失，不能声称原 bytes 仍在；持久化副本保留了相同 request 语义摘要、node generation、job handle，原 artifacts 文件字节摘要和 146 个 controller CAS 锚点仍可验证。恢复使用持久化下载 helper 和保留的 prefixes，按剩余字节排序。本机 direct 路线下系统 openrsync 和 SFTP 吞吐均过低；操作者只停止精确回执/进程身份匹配的自属传输，等待失败记录并保存回执后，最终通过既有跳板与 API 映射 SSH 端口，使用系统 OpenSSH SFTP 的 reget 续传，并为最后 native shard 启用系统 SSH 压缩；最终并非全程 rsync 或本机 direct。跳板仅转发，没有存储训练产物，其未计量网络费用未计入 Vast 估算。SFTP 仍须完整传输 ACK、原始全量 SHA-256 与精确 size 核验后才发布 CAS，满长度 prefix 也不视为已验证。恢复涉及传输与本机保全，没有重新执行训练或生成新的质量结果。最终全闭包和离线 finite 核查通过后才记录本次收尾完成。

candidate 评测与配对完成后，部署所有者已停止本轮模型服务和 Hitch daemon，操作者观察 GPU 计算进程为空。完整保全、离线复核及精确租机销毁证明现已通过。Vast 计算与磁盘估算 $2.282704，含 $1 传输预留的保守 Vast 估算 $3.300331（< $5），按实际创建至 absent 确认的 3.966088 小时计算；这是 Vast 范围估算而非已结算账单，既有跳板网络费用未计入，账户充值不计作支出。仍存的原始记录、恢复回执和重新序列化的 controller 输入副本保存在持久化任务私有目录；临时目录丢失及原输入 bytes 不可得的限制如上保留。公开报告不包含凭据、SSH 连接信息或账户余额。正式 runtime 认证、完整 Harbor benchmark、held-out 质量、非零梯度学习、optimizer 恢复、故障恢复矩阵、Compose 容器部署和动态共卡能力不由这次诊断证明。

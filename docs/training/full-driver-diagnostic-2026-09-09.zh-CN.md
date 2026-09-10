# 完整 driver 诊断准备与实例启动记录

本次使用已封存的 Qwen2.5-1.5B-Instruct、真实单任务 snapshot 和固定 training-tool harness，计划串联生产 `TrainingEpisodeCoordinator`、节点 episode journal、原生 SGLang receipts、Slime/Megatron 一次更新及完整 checkpoint/HF CAS 回收。B=1、G=2，零方差组保留；有效 reward=0 不等于任务成功，也不证明模型有提升。

新增的 `scripts/prepare-training-diagnostic.mjs` 只根据现场模型节点和 provider 观察构造请求。`python/probes/controller_training_smoke.py` 是独立、明确未认证的兼容性诊断入口，限一张共卡 GPU、冷启动和一次更新；公共训练准入仍要求已验证 runtime，未解除其限制。`scripts/canary-training-controller.mjs` 使用真实控制端协调器和 RPC，完成后先回收产物元数据并释放 GPU。大对象随后在 Vast 实例停止时传输，由 `python/probes/collect_controller_training_smoke.py` 核对 CAS 依赖图、真实双 run、消费批次/更新/checkpoint 一致性及 HF 有限权重。收集脚本已通过语法检查，尚未执行完整 GPU 产物回收。

临时实例 `50283402` 的初始化没有完成。平台日志返回 `No such container`，始终没有可用 SSH，因此没有上传源码或启动训练。它曾经过两次限时启动尝试；恢复前明确将同一实例的总窗口延长到 20 分钟。初次 destroy 命令因 CLI 交互确认默认拒绝而没有删除，随后使用已授权的 `--yes` 销毁，并重新查询确认实例已不存在。原实例 `50249234` 始终保持 `exited/stopped`。记录位于 `/Users/tangyehui/.codex/artifacts/gear-full-training-temp-20260908-03/destruction-confirmed.json`。

固定镜像的 registry manifest 显示压缩层合计约 21.1 GB；先前 180 秒启动窗口不能保证覆盖冷拉取及解压。新一轮采用每台最多 30 分钟及独立停止 watchdog，实际返回的总时价仍须不超过 $0.60。实例 `50285769` 是 1×RTX 5090、96538 MiB 主机内存、报价 $0.4205185185/小时；镜像启动约 12 分钟后提供 SSH，完成实际 GPU/内存观察及模型下载。运行记录位于 `/Users/tangyehui/.codex/artifacts/gear-full-training-temp-20260909-05/lifecycle.json`。

真实节点随后在请求冻结时触发 `missing-model-launcher`：镜像包含两份 `psutil 7.2.2` 的 distribution metadata，RECORD 摘要不同，旧 `package_version` 要求记录条数恰好为 1，误判依赖版本不可用。已改为要求唯一版本值；全部记录仍进入原始 runtime 与摘要，不删减环境证据，不同版本继续拒绝。新增重复同版本/不同 RECORD 保留、版本冲突和缺失包检查后，101 项 Python 测试通过。该实例没有开始训练，已按当时的清理策略停止、取回日志并销毁。准备延长启动窗口的第二个监控器在原监控器已继续运行后被终止，未生成第二份请求或作业。

用户随后明确更新资源策略：**测试未完成时只停止实例，不删除容器、磁盘、镜像或模型缓存；修复后复用同一实例。** 后续 runner 的失败清理和限时 watchdog 只停止实例。不得继续沿用此前“取回日志后自动销毁”的策略。用户确认已手动清理旧实例；本轮没有向原实例 `50249234` 发出删除命令。

后续创建的保留实例为 `50288096`：1×RTX 5090、257802 MiB 主机内存、150 GB 磁盘，报价 $0.5227777778/小时。实际 GPU/内存及进程 launcher 检查通过，模型下载完成。准备请求时通过了先前的 launcher 检查，但运行诊断入口时检测到环境摘要不一致，尚未启动训练或生成 checkpoint。日志已取回到 `/Users/tangyehui/.codex/artifacts/gear-full-training-temp-20260909-10`，实例已停止且缓存保留。

本地进一步核对请求中 runtime、bridge 与 generation 都与最初现场观察一致。已为诊断入口补充逐项差异及完整观察落盘，并将后续调用统一为 `python -m controller_training_smoke`，与正式节点 RPC 的模块启动方式保持一致；入口路径是否导致摘要差异仍待实际对比，不能将这个推断当作已验证的修复。两次短时恢复均未获得可用资源，第二次保存的 Vast 原始返回是 `Required resources are currently unavailable, state change queued.`。重新查询确认实例为 `exited/stopped`、GPU 时费为 0；本地诊断 daemon 和停止定时器已收尾，实例没有删除。

用户随后明确授权：不可用时更换实例，并在需要的数据通过 Vast copy 取回后删除已停止的不可用实例。这更新了此前只恢复 `50288096` 的约束；仍可恢复的未完成测试实例继续停止保留。

`50288096` 的完整工作目录已在停止状态通过 Vast copy 取回，核验 675 个文件、约 17.3 MB，源码摘要与上传版本及当前 bridge 一致，诊断日志归档也与此前副本逐字节一致；没有训练作业或新增权重。固定父模型的完整副本已经在本地封存。备份与核验记录位于 `/Users/tangyehui/.codex/artifacts/gear-vast-migration-20260909-01`。确认备份后于 2026-09-08 17:12:30 UTC 删除旧实例，并重新查询确认不存在。

新实例 `50292445` 为 L40S 48 GB、128971 MiB 主机内存、150 GB 磁盘，报价 $0.5611111111/小时。固定 Slime 镜像约 10 分钟后提供 SSH，实际 GPU、内存和进程 launcher 检查通过，固定模型下载完成。runner 使用独立的 30 分钟停止 watchdog，失败收尾继续只停止；新节点重新观察 runtime 与 generation，没有复用已删除节点的身份或验证证据。

这一轮的逐项日志确认只有 `runtimeDigest` 不同：初始观察比诊断准备多出 `colorama 0.4.6` 与 `psutil 7.2.2` 各一条 RECORD 记录，其余包、节点身份、generation、bridge 均一致。统一模块启动并未解决差异。初始观察先导入 Torch，准备阶段没有导入，指纹取决于当前进程的元数据搜索环境；实际记录保存在 `gear-full-training-temp-20260909-15/runtime-check.json`。该轮没有创建训练作业，实例于 17:25:15 UTC 确认停止，缓存保留。

`observe_runtime()` 改为在相同解释器的新进程中观察启动环境，继承配置的 `PYTHONPATH`，每次重新读取包及 RECORD，不缓存摘要、不删除不同 RECORD 的记录。实际安装变化继续使指纹失效，调用方导入后临时添加的路径不再改变环境身份。增加真实子进程测试并调整 CPU 服务测试的环境配置后，103 项 Python 测试通过。远程复验会先比较 Torch 导入前后的摘要，再执行生产 driver；这些测试仍不构成 GPU 验证通过。

第 16 轮复用同一实例，Torch 导入前后的指纹比较及节点 CPU 准备均通过。17:34:33 UTC 启动实际作业 `job_4258b47e746e848fc6575be0be4e15d8`，本地 Ray 初始化成功；固定 Slime 在 placement group 排序时执行 `int(gpu_id)`，收到 Gear 的 UUID 可见设备配置后报 `ValueError`。尚无 rollout 或反向传播，GPU 使用记录约 33 秒。日志回收到 `gear-full-training-temp-20260909-16`，17:36:01 UTC 确认停止并保留缓存。

新增 `gpu_visibility.py`，用 CUDA driver 的实际枚举把请求 UUID 映射到 Slime 所需的数字 ordinal；查询与 driver 统一 `CUDA_DEVICE_ORDER=PCI_BUS_ID`，不假设 nvidia-smi/NVML 的 index 等于 CUDA ordinal。driver 在训练前再次枚举可见 UUID，顺序或集合不符即拒绝。只在枚举子进程中清除父进程的 CUDA mask，保留容器设备限制；不创建 CUDA context。缺失、重复、歧义和可见性漂移的 CPU 检查通过后，Python 测试共 106 项通过。第 17 轮使用同一实例的新诊断目录，保留旧失败作业；仍须以实际执行结果验证这次兼容修复。

第 17 轮实际 UUID 映射、driver 可见设备校验、Ray placement、SGLang 加载、Megatron 初始化与权重同步均通过，进入真实轨迹收集。Hitch 完成 `run_7fc35bd14f2d4bc188724103af9f122a`，两次模型调用，原生轨迹有效，奖励为 0。控制端随后拒绝 canonical task/verifier identity：数据集原名 `dataset` 变成了内容摘要目录名，旧 snapshot 又没有保留权限，使 Hitch 的 benchmark revision 改变。其余环境、harness、策略及节点身份均匹配。没有反向传播；17:49:09 UTC 确认停止，日志位于 `gear-full-training-temp-20260909-17`。

数据集快照升级为 `schemaVersion: 2, format: harbor-dataset`，封存逻辑名称、文件/目录权限及空目录；物化时校验并恢复这些信息。模型和 trainer 文件快照保持原格式，旧数据集也保留原解释。训练和独立评估的控制端使用内容缓存下的逻辑名称，Python v1 rollout 同步处理。目录逃逸、权限漂移、缺失空目录和元数据缺失均拒绝。

原始四个任务文件字节未变。新快照 `sha256:3b980c390af25f4cc44df1cb38b098b2b9e6428db1a18bd25d829f9a76650373` 往返物化摘要一致，Hitch benchmark 身份恢复为 `local:dataset` / `sha256:bc7266499dcc2270b3ae6fdce72198ca2e92da245b94ac22c9f3ebdd2d5d05d0`。还用原始不可变任务镜像在本地确认初始 `/app` 为空，并按实际 Harbor 原生 task digest 输入核验原冻结 task/verifier identity；没有重写旧运行或追认其样本。证据位于 `gear-integrated-training-inputs-20260908/dataset-v2-verification.json`。110 项 Python、104 项 TypeScript 测试及类型检查、构建通过后，第 18 轮复用原实例重新提交测试。

第 18 轮在恢复实例时再次收到 Vast 的资源不可用响应，没有进入 SSH 或训练。按用户已授权的更换策略，在停止状态用 Vast copy 备份第 17 轮完整 CAS，并保留第 15–17 轮日志、源码归档与请求。已在本地存在且核验过的父模型权重先填充到接收目录，Vast copy 使用内容校验跳过相同字节，避免重复传输约 3 GB 权重。最终 25 个 CAS 对象、3,098,988,387 字节全部通过 SHA-256 检查。备份位于 `gear-vast-migration-20260909-02`；18:13:58 UTC 删除 `50292445` 并重新查询确认不存在。后续第 19 轮选择预算内可用报价，优先已有镜像缓存的宿主机。

第 19 轮新实例 `50298046` 复用宿主机镜像缓存，约 55 秒提供 SSH，价格仍为 $0.5611111111/小时。真实作业 `job_91a04c411c3c7192f575b86790eeaee1` 的两条轨迹 `run_5fdc463a7332455db0844e190e2d1a65`、`run_7153994a7b7442629c3344253b6be145` 均通过原生身份检查和反馈接纳，奖励都为 0。生产 driver 完成完整批次、实际 backward、同步 backend 保存及 HF 导出；但 600 秒作业预算在导出收尾时耗尽，最终 paused/exporting、committedUpdate=0。`pending-update.json` 保存了完整 trainer snapshot，不等于 checkpoint 已提交。18:29:40 UTC 确认停止，保留实例与全部磁盘；日志位于 `gear-full-training-temp-20260909-19`。

driver 已在同步保存后封存 trainer snapshot，再次提交时原代码还扫描同一 backend 目录。提交现在显式复用 pending journal 中的不可变 snapshot，actor/optimizer/RNG 必须引用同一份状态；HF 仍逐张量验证有限值。新增检查覆盖 backend 目录后续变化、错误 snapshot 类型及 RNG 不一致，113 项 Python 测试通过。新诊断请求预算提高到 1,200 秒，controller 上限 1,260 秒；冻结的第 19 轮请求及历史账本保持原值。第 20 轮尝试恢复同一实例，继续使用独立 30 分钟停止 watchdog。

第 20 轮成功恢复原实例，新的 1,200 秒请求通过现场 runtime/UUID 和 CPU 准备，真实作业为 `job_2bd47582587e9a7f438f521ac29dc086`。第一条真实轨迹 `run_775a9bc69e4e4a52a153f6a094c7dd06` 有效、奖励为 0，并通过反馈接纳；第二条尚未提交时，控制端子命令返回空 stdout，旧 JSON 解析错误丢失了退出码与 stderr。该轮未进入 backward。取消后 18:50:05 UTC 确认停止，全部磁盘保留；日志位于 `gear-full-training-temp-20260909-20`。

本地用原第二条 binding 在隔离 Hitch root 注册成功，已有数据集连续三次物化成功；尚不能确定空输出来自 SSH 还是本地子命令。`jsonProcess` 现在报告退出码、signal、输出长度，节点和 Hitch 调用附带操作阶段；显式启用的私有目录保存最多 64 KiB stderr，不记录 argv、stdin 或模型 stdout，也不把原始 stderr 放入公开错误。新增真实子进程检查验证错误类型、限长和 0600 权限，105 项 TypeScript、113 项 Python 测试及类型检查、构建通过。第 21 轮继续恢复原实例并启用私有诊断，没有将新日志能力当作根因修复。

第 20 轮同时完成独立评估的父模型导入、model-node 注册与实际 SGLang baseline 推理计划，尚未启动评估服务。`scripts/canary-model-evaluation.mjs` 将通过真实 `HitchModelEvaluator` 检查冻结条件、独立 run、合法反馈和显卡释放；这类单任务诊断不等于正式 dev/held-out 比较或模型晋级。

第 21 轮在恢复时收到 Vast 资源不可用响应，没有启动新作业；18:55:51 UTC 确认停止。按用户的先备份再删除要求，通过 Vast copy 在停止状态回收第 19、20 轮 CAS、未提交的 HF 导出和诊断日志。第 19 轮 trainer manifest 摘要已确认，七个文件合计 21,613,673,112 字节，包含两份分布式 checkpoint 数据文件。备份位于 `gear-vast-migration-20260909-03`；在完整摘要校验通过前保留实例。

第 19 轮 HF 的六个分片已完整回收，338 个张量通过 CPU 有限值、结构与父模型语义检查。逐元素比较显示最大绝对差为 0、变化张量数为 0。实际训练日志显示 backward 约 8.2 秒、loss=0、grad norm=0，符合两个零奖励样本的零方差组；不能把不同的分片文件摘要当作参数发生变化。HF 仍是未提交 checkpoint 的诊断产物，不能当作已完成的 collect 或模型晋级。证据见备份目录的 `hf-verification.json`。

停机备份期间补充了 SSH 只读 RPC 的有限重试：仅 `probe`、`training.inspect`、`cas.stat`、`training.episodes.receipts` 的非 JSON SSH 255 失败可以重试，最多三次，共用原 request ID、输入摘要、节点身份和总超时。训练状态变更、本地命令失败、成功退出后的非法 JSON 及身份漂移不自动重试。新增测试核验这些边界；108 项 TypeScript、113 项 Python 测试及类型检查通过。第 20 轮空输出根因仍未确认，不能将此作为实机故障已经恢复的证据。

最终备份共 74 个 CAS 对象、27,800,228,276 字节全部通过 SHA-256 检查，完整 trainer snapshot 的七个文件、HF 导出、原请求与源码归档都已核验。Vast copy 复用已有父模型，第二轮 CAS 增量只传输了约 23 KB 对象数据；整个大文件备份期间实例保持停止。19:27 UTC 发出删除 `50298046` 的命令，CLI 成功退出但返回空输出；随后两次查询均确认实例列表为空，没有重复删除。校验与删除凭据分别保存在 `gear-vast-migration-20260909-03/backup-verification.json` 和 `destruction-confirmed.json`。当前没有 GPU 实例运行，第 22 轮换机脚本已准备，尚未启动。全量 TypeScript/Python 回归、类型检查、构建与 diff 检查通过；Hitch 用户既有推理文档与备份一致。

后续连接与恢复记录位于 `/Users/tangyehui/.codex/artifacts/gear-integrated-training-inputs-20260908/latest-vast-instance.json`。完整 checkpoint 提交、产物回收与独立评估仍未完成。

第 22 轮创建 `50305292`，1×RTX 5090、127910 MiB 主机内存，价格 $0.495/小时。镜像冷启动约九分钟，19:41:26 UTC 获得 SSH；Torch 导入前后 runtime 摘要一致、CUDA UUID 映射通过。随后固定父模型下载触发 runner 遗留的 90 秒超时，尚未冻结请求或启动 driver。19:43:31 UTC 确认停止，日志已取回 `gear-full-training-temp-20260909-22`。这是模型准备超时，尚无证据表明实例本身不可用，因此保留其镜像和磁盘。

后续准备改为在实例停止时，用 Vast copy 将本地已封存的父模型上传到独立目录。上传前按原 HF manifest 校验七个文件共 3,098,955,668 字节；恢复后再次逐文件校验 SHA-256，随后仍执行原节点准备和模型身份检查。第 23 轮脚本已移除在线下载步骤，保留 1,200 秒作业预算与只停止的 watchdog；脚本准备不构成训练验证通过。SSH 连接复用仅配置于诊断私有目录，gateway 自有 control socket 与停止协议保持原实现。

Vast copy 于 19:58:27 UTC 完成，传输期间实例保持停止。第 23 轮成功恢复原实例，19:59:02 UTC 远端七个模型文件全部匹配原 SHA-256；现场还确认没有 Docker 可执行文件或 `/var/run/docker.sock`。19:59:26 UTC 启动完整 driver，作业 `job_c008b6b9760133f5065c348e10e04a21`。独立评估的父模型导入、节点注册及实际推理计划也已准备成功，尚未启动评估服务。上传与远端校验凭据位于 `gear-parent-stage-20260909-50305292/transfer.json`，运行证据位于 `gear-full-training-temp-20260909-23`。

第 23 轮两条真实轨迹 `run_2dd953bb4e8546909e818bea7377f07d` 和 `run_c0621a33976848919bffe20894d5bef3` 的原生身份与反馈均被接纳，奖励均为 0。完成真实 backward、同步 backend checkpoint、HF 导出和更新提交后，controller 于 20:05:29 UTC 成功退出：`execution=completed`、`committedUpdate=1`、`resourcesReleased=true`，累计 GPU 用量 361.1868 秒，rollout tokens=228。训练后卸载使 GPU 占用从约 29.89 GiB 降至 1.51 GiB，主机可用内存仍为 83.61 GiB。20:06:09 UTC 确认容器停止。

停止后的 CAS 回收首次遇到远端 rsync 3.2.7 与本机 2.6.9 的 `deflate on token` 压缩错误；旧版客户端又不接受 `--no-compress`。最终在私有 wrapper 中将 Vast CLI 的 `-arz` 改为 `-ar`，保留差量同步、内容校验及实际 rsync 退出码检查。那份 10,806,616,180 字节的差异 checkpoint 实际新增内容仅 103,952 字节；其余 11 个大对象复用相同摘要副本。最终远端 68 个对象、27,800,204,541 字节全部通过 SHA-256 校验后才发布到本地备份目录，未将首次失败的接收目录当作有效 CAS。

离线 collector 随后成功核验并导入完整依赖图：控制端 74 个对象、27,800,258,256 字节，包含完整训练状态、消费 batch 和任务/轨迹证据；`committedUpdate=1`，HF 权重有限值检查通过。checkpoint 为 `sha256:cf7128b3dd925fea068e9dfa0f6d352d07424a003dc42e2141a519b025615080`，batch 为 `sha256:9fca0162c21b9bff3384bb514a5284e71e4aca88f6caad5ec19715d09678e04c`。结果保存在 `gear-full-training-temp-20260909-23/collection/collection.json`。该 HF 摘要与第 19 轮已逐张量比较过的导出完全相同，参数没有可报告的提升；完整流程成功不等于模型能力提升或 runtime 已认证。

本轮还发现最终状态保留了此前“GPU 尚未释放”的旧 message。已在本地修复：只有实际释放检查成功且 message 恰为该临时提示时才清除，其他诊断保留；查询失败时仍报告未释放。11 项 job 专项及 114 项 Python 回归通过。此显示修复未写入第 23 轮远端冻结源码，也不改变本轮真实释放证据。第 24 轮将继续使用同一已观察节点进行 Hitch 独立评估。

第 24 轮成功恢复并核验同一节点，但评估准备脚本将父模型和导出模型都命名为 `gear-independent-diagnostic`，真实 Hitch CLI 拒绝覆盖已有别名，退出码为 2；尚未启动评估服务。20:24:27 UTC 确认停止，诊断位于 `gear-independent-eval-20260909-24`。停机后的进一步真实 CLI 检查发现，正式 evaluator 与 publisher 原先使用的 `gear-` 加 64 位摘要共有 69 字符，也超过 Hitch 的 64 字符限制。两条正式路径及诊断脚本改用完整的 64 位十六进制模型摘要，不截断身份、不强制覆盖已有名称。

修复后真实 Hitch 导入返回与已校验候选相同的 model ID。新增测试覆盖评估和发布的名称边界；109 项 TypeScript、114 项 Python 回归、类型检查与构建通过。第 25 轮复用原实例继续独立评估；Hitch 源码和第 23 轮远端训练源码未改写。

第 25 轮的真实候选导入、推理计划和评估提交通过，eval 为 `eval_41f0f6684e804940a1922be2fa5c6376`。服务 `inference_99b8145283f14bb9923338c9a298407f` 启动期间，Gear 的用量查询得到 `inference-owner-drift` 并取消评估；20:30:16 UTC 确认容器停止。取回的节点记录没有该 inference 的身份文件或设备 lease，只有此前已释放的训练 lease。Hitch 已持久保存本地启动意图，而节点仍在准备模型文件，尚未接纳服务；旧 `inspect` 将“未接纳”与“已有 owner 不匹配”合并为同一个错误。随后发生的 `cas.stat transport-failed` 对应本轮停止期间的准备调用，不能单独当作首个故障原因。

本地 `ProcessService.inspect` 现于 admission 锁内处理首次未接纳查询：仅在服务目录和设备记录都不存在、调用提供完整 inference ID 时，返回 `admitting`、`resourcesReleased=false`、`gpuSeconds=0`。不写入身份、不创建服务、不返回句柄或凭据，也不把不存在当成已释放。只要存在服务目录或历史设备记录，仍须通过原所有权检查；真正的 owner 漂移继续拒绝。测试覆盖真实子进程 RPC 的查询先到、stop tombstone 拒绝迟到 start，以及已有状态/设备账本丢失身份时拒绝降级。推理专项 20 项通过；这项修复尚未上传远端验证，下一轮应使用新的节点源码目录和现场 runtime 观察，保留第 23 轮冻结环境及历史评估记录。

这些诊断不构成 validated runtime，也不开放完整远程训练或远程模型 capability。独立评估、数值对齐、循环卸载、故障恢复及全部执行拓扑仍须分别实测。

第 26 轮使用新的源码目录 `/workspace/gear-eval-node-26` 与现场观察的节点身份，成功越过第 25 轮的未接纳查询问题。评估 `eval_84fbcbfbee4c497f9a9e865cf934f3e3` 接纳了真实服务 `inference_7e18ae4756744762846af5e97376ad86`，但 SGLang 在参数解析阶段退出：`--pp` 同时匹配多个参数。用量为 6.8291 GPU 秒，服务确认释放；20:44:53 UTC 确认实例停止并保留。没有评估 trial 完成，不能计为独立评估通过。

已取回的引擎帮助文本还显示 `--disable-request-logging` 不受支持。Gear process 与 Hitch Docker 两个启动入口均改为完整的 `--tp-size`、`--dp-size`、`--pp-size`，移除无效日志开关；[SGLang 对应版本参数定义](https://raw.githubusercontent.com/sgl-project/sglang/v0.5.15.post1/python/sglang/srt/server_args.py) 中 `log_requests` 默认为 false。CPU HTTP fixture 现严格解析参数，能重现原歧义与未知开关错误。生成的 25 个选项已全部匹配本轮实际引擎帮助文本；这只核验选项存在，下一次恢复后仍须由已安装解析器检查类型、选项值及默认值，再加载模型。

同轮还暴露出评估器读取空 `plan` 时抛出通用结构错误，掩盖真正的准备失败。现在只在冻结请求检查与实际资源释放确认后，针对 `status=failed`、`failure_stage=preparing` 且无计划的结果抛出包含有界错误码的准备失败；不复制可能含敏感内容的引擎 message，不生成完成证据，不额外提交或重试。新增测试覆盖等待释放、重启后保持失败身份和累计用量。Python 全量 116 项及 Hitch 启动专项 5 项通过，Hitch 构建、架构、语法检查通过。第 27 轮脚本已加入实际 SGLang 解析器预检，保留原训练环境和历史评估记录。

第 27 轮实际解析器已接受全部选项，并确认日志默认关闭；诊断脚本随后错误地断言“导入/构造 SGLang 参数解析器不会初始化 CUDA”，因此在加载模型前中止，20:58:46 UTC 停止。已将此值改为如实记录，不再把它当作无模型进程的判据。第 28 轮解析器报告 `sglangVersion=0.5.15.post1`，源文件 SHA-256 为 `e11e18f2c5dda5c2497729e7ec11878276c44b4ffa5e20485b8c092dfb28f017`；该字符串的权威值以 `gear-independent-eval-20260909-28/sglang-argument-preflight.json` 为准。

第 28 轮 eval `eval_6fe641dbf39d4951b6d796352bc7bf5a` 的 SGLang 服务完成权重加载并响应 HTTP，但节点就绪检查用管理 token 请求 `/server_info`，持续收到 401。对同一已启动进程的有界只读核对确认普通 token 返回 200、管理 token 返回 401；未显示任何 token 或原始 server_info 值。发现后主动结束诊断，21:03:11 UTC 确认实例停止，日志已取回 `gear-independent-eval-20260909-28/node-diagnostics`。本轮未完成评估；停止容器不能替代原模型节点账本的资源释放确认，下一次恢复会先协调该服务。

已按 [SGLang 认证实现](https://raw.githubusercontent.com/sgl-project/sglang/v0.5.15.post1/python/sglang/srt/utils/auth.py) 修复 Gear 启动/重连及 Hitch Docker 的 `/server_info` token 选择；清缓存仍使用管理 token。节点启动遇到 401/403 立即终止并回收，不等待完整启动期限。CPU fixture 现在分别校验普通/管理接口的 token，真实子进程测试覆盖启动、重连和拒绝认证后的有界释放。Python 全量 117 项、Hitch 8 项跨仓库启动与重连检查全部通过，无跳过；Hitch 构建、架构、语法检查及用户既有文档备份比较通过。第 29 轮使用新节点目录继续验证。

第 29 轮 SGLang 参数、普通/管理 token、节点就绪、协议探测和 Harbor 任务全部成功。Hitch eval `eval_4a06857ffccf4713a05ac2a20a3e1dc4` 返回 `succeeded`，新 run `run_7e4e74587b8c45a8ac852f3fde426b47` 的 verifier 观察有效、reward=0；服务用量 68.8500 GPU 秒，节点账本确认释放，21:09:47 UTC 确认容器停止。原始结果及节点状态位于 `gear-independent-eval-20260909-29`。

Gear 最后核对规范记录时仍正确拒绝该结果：Hitch 的 managed Harbor proxy 已绑定完整 model ID，但 `applyEffectiveModelIdentity` 只保护直接 inference lease，在最终写入时被 provider 返回的短 wire alias 覆盖。离线逐项比较确认，仅 `effective_id` 不同，任务、验证器、环境、harness revision/artifact 和推理锁均一致。现将已验证的 managed proxy 身份显式传入原结果生成路径，完整 model ID、inference ID 与 model-node binding 优先于 wire alias；不接受调用者自行声明的 manifest 作为新信任来源，不修改第 29 轮已封存记录，也不放宽 Gear 的摘要核对。

新增真实子进程回归分别覆盖本地与模型节点 proxy，验证上游返回 wire alias 时结果与 manifest 仍保留已绑定的完整身份。22 项运行引擎测试、15 项规范记录/环境/打包远程 worker 回归通过，无跳过；构建、架构、语法与用户既有文档备份比较通过。第 30 轮以新的实际 provider 观察和评估身份验证最终结果生成修复。

第 30 轮最终通过独立评估：`eval_42f16be71c3c4f1fad2df9b16d37d9b0`、新 run `run_7e5f9c3b68014f44a3442800e2fddf2e`，规范模型 ID 为完整的 `sha256:29c1617891e2bceaefea9740e7d132101cf30a6bfcac75c5a3165575556d3ddd`，推理锁 `sha256:03f8a8b028efe37c5445d160c76c9e6689afd89301f554654409193f86bbbd9a`。Gear 逐项核对任务、verifier、环境、harness、模型/节点身份后得到 `complete=true`；唯一 trial 有效、reward=0，run ID 与两条训练轨迹不同。实际 GPU 用量 69.6745 秒，服务 `inference_f8f753c18750423f9a95c975b6233163` 已停止并确认资源释放，21:17:44 UTC 确认 Vast 容器停止。

最终证据保存在 `/Users/tangyehui/.codex/artifacts/gear-independent-eval-20260909-30`，包括 `evaluation/evidence.json`、`evaluation/summary.json`、原生 eval/run/verifier、节点日志、`service-release.json` 和 `vast-final-state.json`。`evidence-files.json` 记录八个最终证据文件的字节数与 SHA-256。模型、镜像和缓存仍留在停止实例 `50305292`；本轮没有删除可用实例。

第 23 轮训练与第 30 轮评估共同证明固定 1.5B 模型的一次单卡训练、完整产物回收和导出后独立推理评估可以串联。调试期间 Hitch payload 与 Gear bridge 有真实变化，各次部署分别现场冻结，未改写原训练请求或失败记录；这不是同一冻结环境下的正式成对能力比较。该评估仍使用同一单任务，reward=0，不能推断 heldout 泛化、参数提升、全部 P1～P5 验收或 validated runtime。跨主机 Harbor、循环卸载/恢复、故障注入与双卡回归仍待完成。

第 31 轮将私有诊断扩展为连续两次更新：prepare 参数只允许 `1` 或 `2`，controller 按冻结请求核对最终提交数，生产 runtime 认证门禁不变。真实 driver 的五项 CPU actor 测试通过，包含两轮生成/训练和待发布导出的恢复；这些测试不算 GPU 循环验收。

2026-09-08 21:32:58 UTC 恢复实例 `50305292` 时，Vast 明确返回 `Required resources are currently unavailable, state change queued.`。脚本立即撤销排队启动并于 21:33:02 UTC 确认停止；未启动第 31 轮训练，也没有删除旧模型目录。按用户授权，先用 Vast copy 在停止状态下备份原训练和第 26～30 轮评估工作目录，再逐对象核验 SHA-256：69 个 CAS 对象共 27,800,209,206 字节、2,734 个工作区文件；完整 checkpoint/HF 依赖和各轮原源码归档均已检查。备份目录为 `/Users/tangyehui/.codex/artifacts/gear-vast-migration-20260909-04`。

备份校验完成后才删除 `50305292`；21:46:11 UTC 的重新查询确认实例列表为空。`backup-verification.json` 与 `destruction-confirmed.json` 分别保留复制校验和删除凭据。第 32 轮改用新实例与新节点身份，源码包和两更新 runner 已在本地准备；创建、停机上传、恢复训练分别计时，不将模型传输占作 GPU 测试时间。

第 32 轮已选择报价 `49863309`（machine `40271`），21:49:09 UTC 创建实例 `50316639`：1×RTX 5090、145085 MiB 主机内存、200 GB 磁盘，实际报价 $0.522222/小时。先完成镜像初始化再停止，使用已核验父模型进行停机上传；新作业仍设 1,800 秒外部停机 watchdog。离线 collector 另增加连续两次提交链、四个独立 run 及有限且对齐的 behavior logprob 检查；四项证据拒绝测试与五项真实 driver/CPU actor 测试全部通过。原第 23 轮真实产物也通过新验证函数的一更新兼容检查。

新实例镜像完成启动后，首次预检错误地将 `test -d /workspace` 与 SSH 可用性合并判断，21:56:29 UTC 停止。短时恢复重新观察确认 SSH 正常、Megatron 与 nvidia-smi 均存在，唯独新容器还没有 `/workspace`；镜像默认工作目录为 `/root`。已创建工作目录并修正准备脚本，不将该脚本错误归类为实例不可用。重新观察的独立证据保存在 `gear-vast-provision-20260909-32/health-recheck.json`，原失败事件保留。

停机上传使用一次实际故障注入：rsync 已报告传送 14,516,224 字节模型数据时，仅终止本次创建的进程组。随后继续使用 Vast copy 续传，实际匹配已有 14,231,336 字节，新增传送 3,083,051,591 字节；正常 rsync 退出码为 0。该测试期间实例保持停止，尚不以 rsync 校验替代远端逐文件 SHA-256。传输及中断记录位于 `gear-vast-provision-20260909-32/parent-stage`。22:09:01 UTC 开始恢复同一实例执行第 32 轮两更新训练。

第 32 轮最终通过连续两次完整更新：作业 `job_bf3068d3b2ad00250100aeae9c93f3e3` 于 22:10:52 UTC 启动，22:24:05 UTC controller 成功退出，`committedUpdate=2`、`resourcesReleased=true`，作业计量 791.5126 GPU 秒、577 rollout tokens。两轮 policy 分别为 `runtime_6c8cca5364f7285d7c05910b93b4fbb8/update-0/weight-1` 和 `…/update-1/weight-2`；第二轮采样租约使用第一轮提交的 HF 引用，两份租约均已关闭。四条独立 run 为 `run_c2c47fc359834878835cc3672cc53d0d`、`run_e443ba0488974b14bc0bd9408385914b`、`run_170242bc4e254fe69b1590ceac5f720c`、`run_062097ac20654d9abe74f672a6758d28`，九个原生请求的 ID、实际 token、behavior logprob 与权重版本逐项匹配。

训练日志记录两轮反向后 GPU used 约 29.92 GiB，卸载后约 1.54 GiB；checkpoint 保存及导出阶段也完成重复唤醒/卸载。报价的分配内存为 145085 MiB，但容器观察到共享宿主机内存约 1133 GiB，cgroup v1 限制为 413,084,418,048 字节；不能把宿主机 available 数值等同于容器可用内存，也不能据此认定 145 GB 是经约束测试的最低需求。此处如实保存了两种观察，尚未新增通用 cgroup 容量推断。22:24:28 UTC 确认 Vast 容器停止，保留实例 `50316639`、镜像和缓存。

停止后的回收与校验全部通过：117 个节点 CAS 对象、38,607,355,422 字节均通过 SHA-256；大文件差量同步只新增传输了 103,952 字节对象内容，复用约 10.8 GB 的本地已有字节。接收阶段仅改写未验证的 APFS 克隆，验证前不发布到有效 CAS。完整 collector 核验 125 个依赖对象、38,607,462,188 字节，包含两次提交、两个 batch 与四条轨迹，HF 权重有限值检查通过。最终 checkpoint 为 `sha256:22da15cc25e05488aa19c6ed5a8cc2f5271d9fed6850e196976d01a9e190716e`，候选模型引用为 `sha256:1cba3b1e849c33ca75c0a3c57d7ce111eaf7442e459e9dbe9099dca708a808e5`。证据位于 `/Users/tangyehui/.codex/artifacts/gear-full-training-temp-20260909-32`，`evidence-files.json` 列出关键记录和离线校验工具的 SHA-256。

四个实际奖励均为 0，导出的 HF/权重摘要与第 23 轮相同。因此本轮证明了两次生成→训练→完整提交以及中间恢复生成的实际流程，不证明非零参数更新、模型能力提升或全部 P1～P5 验收。第 30 轮独立评估的原证据继续保留；同一第 32 轮节点/设备账本上的独立评估交接、跨主机 Harbor、双卡回归与其余故障注入仍需继续，完整 remote capability 与 runtime 认证门禁保持关闭。


第 33 轮最终通过同一冻结环境的训练→独立评估交接。继续使用实例 `50316639`、节点 `vast-full-50316639-diagnostic-32`、generation `c910370b18b441eeaf35a9bde345f48b`、runtime `sha256:c685e1679c97d90d95dbdad7f6eb3016eef59a6959507c3e6ca6ba44c8e53cc0` 和 `/workspace/gear-full-job-32/node-state`，没有创建新的 generation 或设备账本。评估 `eval_a8f574fbf7d5450e8022be77a3a41872` 产生新的 run `run_ba2dffe8abc74ab08d822415e47c7c8b`；Gear 完整核对任务、verifier、harness、模型、推理锁与节点身份后得到 `complete=true`，唯一 trial 有效、reward=0、无 inference error。

服务 `inference_f8b8d4db7bce4676b8aa6b4a51ab5bdd` 使用 97.0420 GPU 秒；推理锁为 `sha256:76621bc0032b9bdbe90b23cf91f57172821bab8e173f2e2c2d21bc12e45629b3`。GPU 进程实际存在时，直接调用生产 `NodeDeviceLedger.acquire` 为同一设备申请第二个诊断 owner，得到 `node-devices-reserved`，没有新增 owner；这是一项真实设备账本冲突探针，不是提交了第二个完整训练作业。离线核验确认前后原训练 lease 完全相同，最终账本只新增该 inference lease，两个 owner 的占用区间不重叠且都已确认释放，训练 checkpoint 引用不变。另一次读取旧训练状态时 GPU 进程已退出，未将该读取误计为活动评估期间的观察。

22:40:10 UTC 恢复实例，22:41:04 UTC 开始评估，22:44:10 UTC 评估完成，22:44:51 UTC 确认容器停止。模型、镜像和缓存继续保留。证据目录为 `/Users/tangyehui/.codex/artifacts/gear-independent-eval-20260909-33`，包含评估前后节点观察、完整设备账本、活动进程冲突证据、原生 run/verifier、SGLang 参数解析器预检和最终停止记录；`handoff-audit.json` 为 `passed=true`，`evidence-files.json` 保存 14 个证据及离线校验工具的 SHA-256。

第 32～33 轮证明了同一冻结环境下的两次单卡生成/训练更新、完整 collect、独立评估以及设备所有权交接。评估仍使用原单任务，奖励为 0，HF 权重与此前相同；不证明非零参数更新、heldout 泛化或 runtime 认证。跨主机 Harbor、双卡回归和剩余故障边界尚未完成，完整 remote capability 继续关闭。本轮未修改 Gear/Hitch 生产代码。

## 第 46 轮：FlashAttention 完整两更新与停机回收

复用实例 `50316639`，单价为 `$0.5222222222222221/小时`，没有新增或删除实例。清理检查确认此前不可用实例 `50305292` 已完成 Vast copy、备份校验和删除，凭据仍在 `gear-vast-migration-20260909-04`。本轮保留可用容器、模型缓存和安装环境。

原第 32 轮工作目录中的四个大型 checkpoint 副本共 `43,226,968,218` 字节。GPU 停止期间重新校验了本地三个去重对象；恢复后再次核对远端 CAS 与全部四个工作副本，确认原作业完成、设备租约已释放，才删除这些工作副本。原 CAS、checkpoint 元数据、日志及节点身份保留。新增 `python/probes/reclaim_checkpoint_copies.py`；六项 CPU 检查覆盖同尺寸损坏、符号链接、作业忙碌和核验后重新忙碌，确认失败时不开始删除。16 项现有停机保护检查通过。

新的冻结目录为 `/workspace/gear-full-job-46`，node ID 为 `vast-full-50316639-diagnostic-46`，generation 为 `4ec20b91ecbe4cbc80ffd585d0295169`，实际 GPU 为 `GPU-277d55fc-c39d-0cb5-55f8-46236640fc7b`。共享已校验的第 32 轮 CAS，另建本轮设备账本；原四个节点身份/账本/配置文件前后 SHA 相同。源码包内 31 个 bridge Python 文件与当前源码一致，模型七个文件重新核验，实际节点仍无 Docker 命令或 socket。

真实作业 `job_6083718c3ea8a60fc808e6b0cec83c9e` 完成两轮生成、backward、checkpoint、HF export 和卸载/恢复，累计 `715.169905424118` GPU 秒、577 个 rollout token。实际日志确认 FlashAttention 2.8.3，两轮 `train/train_rollout_logprob_abs_diff` 分别为 `0.01712593249976635`、`0.017333928495645523`，均低于 0.1。运行仍为 `ci_test=false`，此处为实际观测后的数值检查。训练后显存两次从约 29.93/29.94 GB 降至 1.54 GB。

四个不同物理 run、九份原生 receipt 的 request ID、weight version、token ID 和 logprob 全部匹配。两轮 lease 均关闭，第二轮使用第一轮导出，weight version 为 1→2。四个有效奖励均为 0，梯度范数均为 0，最终 HF snapshot 仍为 `sha256:33bcd79958d827af52ca746eaca509c91cd585cc8634f0a819324b483dd3da3f`；这证明执行链成功，不证明任务能力或参数提升。最终 checkpoint 为 `sha256:190474f1aa44a0115f4a161a0a7b0b2b8a105a14ef69bbb01243ea0d27a2f06b`。

UTC 08:16:50 请求恢复，08:19:24 启动作业，08:31:22 控制端完成，08:31:50 确认容器停止。容器内保护已核验就绪，本地保护持续重试至观察到停止；实际期限未触发。停机后使用 Vast copy 回收：共享仓库的 184 个对象、`38,607,876,564` 字节全部通过 SHA 校验；本轮完整依赖闭包为 125 个对象、`38,607,462,196` 字节，HF 权重有限性检查通过。复用本地 APFS 副本作为传输基础，完整文件传输阶段的 literal data 为 0；仓库总数包含此前已保留的对象，不全是本轮新产物。

日志打包将输出写在被归档目录中，tar 返回 1，唯一错误为根目录读取期间发生变化，导致 runner 的日志证明步骤未执行。没有为此恢复 GPU：停机后独立复制节点元数据，将 1,328 个普通文件与归档逐一比较，全部相同，并确认其中没有本实例专用凭据。`diagnostic-logs-proof.json` 明确记录这是独立停机副本比对，`remoteSha256Observed=false`，不冒称取得了远端 SHA。后续评估脚本将归档输出放在被归档目录之外。

证据目录为 `/Users/tangyehui/.codex/artifacts/gear-full-training-temp-20260909-46`，包含 `training-result-audit.json`、`cycle-audit.json`、`collection/collection.json`、清理与复制证明、日志恢复脚本和停止状态。独立评估另有证据；完整远程 capability 与 runtime 认证仍未开放。

## 第 47～49 轮：连接修复与同节点独立评估

第 47 轮恢复后直连 SSH 在 banner 交换阶段超时，未启动评估服务，UTC 08:40:40 确认停止。检查 CLI 源码发现 `ssh-url` 可以一直复用缓存的直连地址；这是潜在的地址刷新缺陷，不能据此认定本次端口已变化。第 49 轮现场返回的直连端口仍为原来的 61127。第 48 轮的新路由检查在接入 SSH 前触发断言，08:45:00 确认停止；后续实际响应包含 IPv4/IPv6 的两条相同端口映射，CPU 用该响应复现了原先“只能有一条映射”的检查错误。

新增 `python/probes/vast_connection.py`，从新的实例观察选择地址，支持明确使用 Vast SSH 代理；相同端口的双栈映射合并，冲突端口继续拒绝。六项 CPU 检查在修复前有一项失败，修复后全部通过。第 49 轮明确使用现场 `ssh3.vast.ai:36638` 代理连通原实例，没有换机或删除容器。实际执行的 helper 源码单独保存；之后对直连双栈解析的修正没有改写本轮已执行的连接观察。

第 49 轮核验第 46 轮的相同冻结部署、node generation、runtime digest、GPU UUID 和原训练完成状态后，Hitch 管理的 SGLang 独立评估成功。eval 为 `eval_a4081948497b4a4fb23f66ca6d6fd7da`，新 run 为 `run_fc706735e0f047039f20292caffa4541`，服务为 `inference_e49e0fadacf14efeba8b3143c7bdea0e`。任务、模型、推理锁、节点与 verifier 的规范记录通过 Gear 校验，唯一 trial 有效、reward=0，与四个训练 run 不同。

评估使用 `103.67721700668335` GPU 秒。实际 GPU 进程存在时，生产设备账本拒绝第二个 owner，未创建竞争 lease。最终原训练 lease 完全不变，账本只新增本次 inference lease，训练和评估占用区间不重叠且都已释放。UTC 08:46:56 请求恢复，08:48:01 开始评估，08:51:44 完成，08:52:19 确认实例停止保留。模型节点始终无需 Docker；真实 Harbor 仍在本地。

远端日志包已取得 SHA，停机后的 Vast copy 字节与之相同。归档移到工作目录之外后 basename 也发生变化，runner 最后的本地文件名检查因此返回失败；评估本身已成功。停机后定位实际已复制的文件、核对远端 SHA 并恢复审计入口名称，无需启动 GPU。`log-path-recovery.json` 保留该区别，原 lifecycle 没有改写。1,387 个节点文件未包含本实例专用凭据，三个评估尝试的本地停机保护进程均已退出。

证据目录为 `/Users/tangyehui/.codex/artifacts/gear-independent-eval-20260909-49`，`handoff-audit.json` 为 `passed=true`，另保存规范 run/verifier、前后设备账本、实际占用冲突、日志 SHA、连接观察及失败前后的 CPU 检查。第 47～48 轮失败目录也保留。FlashAttention 的完整两更新、collect 和同节点独立评估现已有实际证据；奖励仍为 0，不能证明任务提升、heldout 泛化、双卡、远程 Harbor 或完整断网验收，runtime 与完整远程 capability 继续保持未认证。

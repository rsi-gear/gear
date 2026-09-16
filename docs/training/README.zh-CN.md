# Slime 模型训练接入

Gear 的模型训练独立于 harness 进化状态，通过固定 harness 和数据集执行 Slime GRPO 更新，再用不可变 HF 导出进行独立评估。新部署从 [v2 controller 配置](controller-v2.zh-CN.md) 开始；下文同时说明 v1 配置和通用训练合同。

目前实机验收覆盖本地 Gear / Hitch / Harbor Docker 与远程 RTX 5090 单卡上的 Qwen2.5-1.5B 训练、恢复及推理。远程 Docker / Harbor 和双卡尚未验收。独立评估 reward=0，不代表质量提升或晋升。认证范围及证据见文末；`pending-gpu` lock 不能提交正式训练。

## 代码入口

- `rsi-gear/training`：版本化合同、CAS、`ModelTrainingCoordinator`、`SlimeModelTrainer`、`HitchModelEvaluator` 和显式发布适配器。
- `gear-refine training`：v2 冻结前用 `preflight-deployment` 分别检查控制端、Harbor worker 和模型节点，再用 `freeze-deployment` 固定部署；实验执行使用 `put-json`、`seal-hf`、`seal-dataset`、`validate`、`init`、`admit`、`preflight`、`advance`、`status`、`pause`、`resume`、`close`、`publish`、`rollback`。
- `python/gear_training`：Slime job RPC、私有作业监督进程、精确 token gateway、rollout hook、完整 checkpoint/HF export、恢复账本。
- Hitch 新增 `training register` / `training evidence`；`local plan` / `local inspect` 用于在提交前读取并固定真实 inference lock。

状态事务通过 Python `fcntl.flock` 内核锁串行化；默认调用 `python3`，需要时用 `GEAR_TRAINING_LOCK_PYTHON` 指定同环境的 Python 可执行文件。进程中断会释放锁，不依赖过期 PID 文件恢复。

`advance` 执行一轮可重复的协调，不是后台定时器。调用方应间隔数秒重复调用，直到 `execution=completed` 或需要处理 `blocked/failed`。Slime 作业和 Hitch eval 自己在后台运行；退出 Gear CLI 不会重新提交或隐式取消任务。使用 `pause` 请求取消，并继续调用直到 `paused`；`resume` 使用原 job 和 idempotency key。

## 边界与身份

训练使用固定的 `training-tool` harness：单条线性 Chat Completions 工具轨迹，只允许容器内 bash 工具；无 compaction、分支、subagent、辅助模型或隐藏重试。训练和 dev/held-out 使用同一已提交的 runner 和 artifact。Hitch 的 Codex / Responses 路径继续独立使用。

Slime 管理训练 SGLang；Hitch 管理不可变 HF 模型的评估 SGLang。v1 使用单个私有 Ray 节点，支持 actor/rollout 独立 GPU，以及共享 GPU、交替生成和训练的 CPU offload 模式。评估使用一个明确的 GPU UUID。可以使用隔离资源池，或先确认旧进程和 GPU 已释放再串行复用。不会停止用户的其他 Ray 集群。

每次生成都保存原始 native 输入/输出 token IDs、生成时 weight_version、behavior logprobs、采样参数及请求/响应。工具观察的 loss mask 和 logprob 为 0；模型 token 才参与 loss。prefix 不连续、length/abort、缺少 terminal、verifier 无效或版本漂移会拒绝整个 episode/group。有效 reward=0 保留。凑不满完整 B×G batch 时明确 no-update，不将空/不足 batch 交给 Slime。

训练任务按冻结列表循环选择，每个 update 从 `rollout_id × B` 开始，组重采样继续向后选择任务。恢复使用已提交的 update cursor，封存 batch 重放直接保留原样本；不会在每次 update 都退回训练集开头。

精确数据只供已授权的 train split。dev/held-out 不进入 TrainingRequest；held-out 逐任务证据仅保存在控制端 CAS。跨 split 同 task、同内容或同 family 会被拒绝。reference 模型、tokenizer、template、verifier、recipe 和 optimizer compatibility 均固定。

## 配置和不可变输入

先在选定云运行时安装 Gear Python 包（Python >=3.10）和打包后的 TypeScript CLI：

```sh
python -m pip install /path/to/gear/python
npm run build
```

训练环境提供 Ray、Slime、Megatron、SGLang、torch、safetensors、transformers、aiohttp、psutil；这些必须来自锁定的镜像/源码版本。不要用可漂移的 latest tag。Slime 固定到 `41014d1f29e201137fdffce737bb8bac65bc5219`，应用 `python/patches/slime-41014d1-gear-export.patch`。这项小扩展把同一 actor 的 HF export 暴露为同步方法，支持 checkpoint 后单独重导出。

Megatron 固定到 `1dcf0dafa884ad52ffb243625717a3471643e087`。单卡恢复另需 `python/patches/megatron-1dcf0da-gear-load-state.patch`，把 TE optimizer loader 的临时占位状态放在 CPU，并调用 Gear 的 `optimizer_restore` 适配器：第二次加载若逐参数引用已有张量，则仅恢复参数组元数据，避免再复制一份 Adam 状态。不同张量映射、其他优化器和自定义加载 hook 仍使用原 loader；实际 optimizer 数值、精度与 checkpoint 格式不变。完整 pending checkpoint 的 HF 导出由专用只读 actor 完成，不构造 optimizer/reference/SGLang。两份源码的实际 `git diff HEAD --binary` 摘要都必须进入新冻结的 runtime lock；安装补丁不会自动获得认证，仍需本轮 GPU 故障恢复证据。

controller JSON（示例值中的路径替换成云主机实际路径）：

```json
{
  "schemaVersion": 1,
  "storeRoot": "/srv/gear/content",
  "slime": { "python": ["/opt/training/bin/python"], "configPath": "/srv/gear/slime-job.json" },
  "hitch": {
    "command": ["/opt/node/bin/node", "/srv/agent-hitch/dist/bin/hitch.js"],
    "root": "/srv/hitch",
    "workspace": "/srv/gear/evaluation",
    "harnessSourceDirectory": "/srv/agent-hitch",
    "python": ["/opt/training/bin/python"],
    "budgets": { "timeoutSeconds": 900, "setupTimeoutSeconds": 1800, "maxConcurrent": 1, "maxEpisodeSteps": 16, "infrastructureRetries": 0, "maxRepairRounds": 1 }
  },
  "activationPath": "/srv/gear/releases/active.json"
}
```

job JSON：

```json
{
  "schemaVersion": 1,
  "storeRoot": "/srv/gear/content",
  "jobsRoot": "/srv/gear/jobs",
  "hitchRoot": "/srv/hitch",
  "hitchPath": "/srv/agent-hitch",
  "hitchCommand": ["/opt/node/bin/node", "/srv/agent-hitch/dist/bin/hitch.js"],
  "slimePath": "/srv/slime",
  "megatronPath": "/srv/Megatron-LM",
  "gatewayBindHost": "127.0.0.1",
  "gatewayAdvertisedHost": "127.0.0.1",
  "episodeTimeoutSeconds": 900,
  "toolParser": "qwen25",
  "reasoningParser": null
}
```

`toolParser` 是部署时根据模型选择并验证的值，示例不表示任意 Qwen/其他模型已兼容。job 配置、controller 配置和镜像都应归档；训练 gateway 只给同主机 Hitch 控制端访问，Harbor 容器使用 Hitch 的 run-scoped 代理地址。启动配置好的 Hitch daemon 后再提交。`GEAR_TRAINING_IMAGE_DIGEST` 必须为实际镜像的 sha256 digest。

用 `seal-hf` 导入初始 safetensors 模型，返回 `model` 和 `modelRef`。模型初始权重必须有限；多分片 index、tensor shape、dtype、tokenizer 和 template 会被校验。`seal-dataset` 将一个或多个 Harbor task 目录按文件摘要封存；每个 train `taskRef` 必须指向只含一个 task 的 snapshot，partition `snapshotRef` 指向完整 split。`put-json` 导入其余 JSON 描述符。所有命令形式为：

```sh
gear-refine training seal-hf /models/initial --config /srv/gear/controller.json
gear-refine training seal-dataset /datasets/train --config /srv/gear/controller.json
gear-refine training put-json /srv/gear/verifier.json --config /srv/gear/controller.json
```

每个 `environmentRef` 的 JSON 包含从可信 Hitch 基线/任务规划提取的 `hitchEnvironmentIdentity`、`taskDigest` 和 `verifierIdentity`，均为真实 sha256。固定 harness 的 `manifestRef` 包含 `{"schemaVersion":1,"hitch":{"harnessId":"training-tool","revisionIdentity":"sha256:…","artifactId":"sha256:…"}}`。verifier ref 封存共享 verifier 版本描述，不列出 held-out 任务。控制端与训练 bridge 会将这些值与实际 canonical run 对照，不能以自己填写的声明代替运行证据。

Hitch 支持显式本地 Git source；训练/评估从 `hitchPath` / `harnessSourceDirectory` 中解析 `training-tool@git+file:///srv/agent-hitch#完整commit`。需要先将这次 runner 改动提交，再使用那个 commit；工作树修改不会被冒充为已提交版本。无需为了本地联调先推送到远端。

`hyperparametersRef` 的 JSON 为 `{"schemaVersion":1,"slimeArgs":[...]}`。必须显式提供模型结构/并行/优化器参数，以及 `--lr`、`--kl-coef`、`--eps-clip`、`--num-steps-per-rollout`。B×G、global batch、DP 和 steps 必须匹配。生命周期、reference、rollout hook、checkpoint、安全恢复等参数由 bridge 负责，禁止覆盖。这里不提供未经 GPU 验证的模型容量或学习率默认值。

### 单卡与独立显卡配置

`trainer.placement` 控制训练 actor 与生成 SGLang 的关系，省略时为 `separate`。它与 `resources.mode`（训练与评估的 GPU 资源关系）是两个独立设置。

单卡调试时，合并以下字段到完整 spec，两个设备列表填同一个实际 GPU UUID：

```json
{
  "trainer": {
    "placement": "colocated",
    "dataParallelSize": 1,
    "rolloutBatchSize": 1,
    "globalBatchSize": 2
  },
  "rollout": { "groupSize": 2 },
  "resources": {
    "trainingDevices": ["GPU-实际UUID"],
    "evaluationDevices": ["GPU-实际UUID"],
    "mode": "sequential"
  }
}
```

这只是资源与小 batch 的配置片段；其余模型、优化器和 token 上限仍须显式封存。此处 B=1、G=2、global batch=2，对应 `--num-steps-per-rollout 1`；单卡的 TP/PP/CP 均为 1。1.5B～3B、H100 80GB 可作为待验证的调试目标，代码和 CPU 测试不保证容量；还需测量 CPU offload 占用的主机内存，以及训练、权重同步和导出阶段的显存峰值。

`colocated` 会将 actor 与 rollout 各自的 GPU 数设为 `trainingDevices.length`，共享整个池；单卡时均为 1。bridge 同时固定单节点和 `num-gpus-per-node`，开启 `--colocate --offload-train --offload-rollout`。独立模式要求 sealed argv 显式包含 `--actor-num-gpus-per-node` 和 `--rollout-num-gpus`，两者之和不能超过设备池。双卡各占一张时，两项均设为 1。资源参数可显式填写与自动值相同的值，冲突、重复或越界会被拒绝；`--rollout-num-gpus-per-engine` 默认 1，并须整除 rollout GPU 数。

显存周期遵循固定版本 Slime 的同步流程：

1. 创建 SGLang 后等待其卸载完成，再初始化 actor；actor 初始化后由 Slime 自动 offload。
2. 恢复 SGLang 权重，用 Slime full tensor/IPC 路径同步 actor 权重，再恢复 KV cache/CUDA graphs。
3. 生成完整训练轨迹，等待 Hitch/native 请求结束、receipt 落盘、lease 关闭、batch 封存。
4. 等待 SGLang 卸载确认后调用 Slime backward、同步保存 optimizer/RNG、导出 HF。训练、保存和导出各自唤醒 actor，结束后再次 offload。
5. 原子登记 update commit，下一轮重新恢复 SGLang。训练完全释放后，由 Hitch 加载不可变 HF 模型执行评估；缺失的基线评估同样与训练串行。

HF 导出失败后的恢复在 SGLang 卸载状态下只重导出 pending checkpoint。任一显存切换失败会结束当前 driver incarnation，交给原有进程清理和恢复流程，不继续训练。共享模式不支持 `release-train`、delta/disk 权重传输、角色 YAML 覆盖、多模型或 prefill/decode 分离服务；不能用 argv 覆盖 offload 设置。实现依据：[固定 Slime train.py](https://github.com/THUDM/slime/blob/41014d1f29e201137fdffce737bb8bac65bc5219/train.py)、[placement_group.py](https://github.com/THUDM/slime/blob/41014d1f29e201137fdffce737bb8bac65bc5219/slime/ray/placement_group.py)。

placement 与设备数量进入 checkpoint compatibility digest。切换共享/独立模式或设备数量，不能直接续训旧 optimizer checkpoint；旧 bridge/export patch 的 runtime lock 也须重新生成和验证。

运行时 lock 除 Slime/Hitch/Megatron commit 外还固定镜像、Python/CUDA/torch/SGLang、bridgeDigest、protocolDigest 和 patchDigests。bridgeDigest 用 `gear_training.preflight.bridge_digest()` 计算；源码补丁摘要取对应 checkout 的 `git diff HEAD --binary` 原始字节。`protocolDigest` 用 `gear_training.preflight.generation_protocol_digest(jobConfig)` 计算，封存所选 gateway/tool parser 协议。实际进程、源码、已应用的 export 扩展与 GPU UUID 都在 preflight 核对。

评估 `common.runtimeDigest` 为公开函数 `inferenceCommonDigest(lock)` 的值，包含 engine、runtime_id、profile、execution 和 resources；`protocolDigest` / `samplingDigest` 分别为 `digestJson(lock.protocol)` / `digestJson(lock.generation)`；`budgetsDigest` 是上面完整 `hitch.budgets` 对象的 digest。当前固定 runner 评估使用 16 步、2048 output tokens，实际锁不匹配会拒绝。可以先运行 `hitch local plan MODEL --harness REF --gpu GPU-UUID --offline --json` 得到真实锁。模型参数不同引起的 execution 漂移也不能作为“仅权重变化”通过。

## 执行、恢复与发布

完整 ModelTrainingSpec 字段定义见 `src/training/types.ts`，语义约束见 `schema.ts`。init 会读取所有冻结输入验证 CAS 摘要，不接受伪造摘要或 mutable URL。

```sh
gear-refine training validate spec.json --config controller.json
gear-refine training init spec.json --config controller.json
gear-refine training admit EXP_ID --config controller.json
gear-refine training preflight EXP_ID RUN_ID --config controller.json
gear-refine training advance EXP_ID RUN_ID --config controller.json
gear-refine training status EXP_ID RUN_ID --config controller.json
gear-refine training pause EXP_ID RUN_ID --config controller.json
gear-refine training resume EXP_ID RUN_ID --config controller.json
```

每步训练保存 actor、optimizer、scheduler/RNG 和数据 cursor，再导出 HF，再用 UpdateCommitManifest 原子登记 batch 消费。崩溃在完整 checkpoint 之前时丢弃未提交内存更新；有 sealed batch 时只在恢复到相同 pre-update 权重后重放。完整 checkpoint 后导出失败保留 pending-update，恢复后只重导出，不执行额外 optimizer step。旧进程身份（PID 与创建时间）、旧 Hitch submit key、run 终态、receipt 和租约都需要协调完成，新 incarnation 才能开始。

v2 训练与独立评估分别使用持久序号控制启动和暂停，初始提交重试不会自行恢复已中断或暂停的 incarnation；显式 `resume` 才发出较新的 start。暂停先于首次提交到达时保留未启动身份，迟到旧请求不能启动 worker 或评估服务。训练节点和 Hitch 均需支持各自的有序控制协议；v1 继续使用原接口。详细顺序与验证边界见 [v2 controller](controller-v2.zh-CN.md)。

基线证据按完整 subject/common condition 复用。只有缺失或无效 slot 可以在预算内修复；有效零分不能替换。dev 不达标时不查询 candidate held-out；held-out 次数单独封顶。比较先对 task 内 attempts 求平均，再给出 task-level standard error。champion 更新使用 parent revision 和 modelRef CAS；失败/无结论保留旧 champion。

v1 作业 GPU cost 按唯一分配设备数×存活墙钟计费，评估按第一次 intent 到资源释放的墙钟保守计费，包含排队/协调延迟。v2 训练与评估使用模型节点的持久设备账本，按唯一物理 GPU 的占用时间累计；共卡 actor/rollout 只算一张卡，断连不清零。每次 `advance` 刷新未释放训练和待完成评估的用量；评估达到总预算即有序暂停，物理释放前继续保留预占和计费。复用同一评估 key 只入账累计增量，跨训练 run 不重复收费。控制端离线期间由节点账本继续累计，详细语义见 [v2 controller](controller-v2.zh-CN.md)。token 先预留上限，再按实际完成数入账；无法确认的原生输出按预留上限计费。评估超总预算会拒绝晋级，不会抹去已消耗成本。

`publish EXP_ID` 和 `rollback EXP_ID RELEASE_ID` 是显式命令，不会随 champion 自动执行。它们导入已批准的不可变模型，并原子更新 Gear 管理的 `activationPath`。业务 episode 在开始时读取一次其中 `hitchModel=local/sha256:…`，此后固定该 ID。这个发布接口不热替换正在执行的 SGLang 权重，也不部署外部业务流量入口。

v2 的 `artifactStorage="model-node"` 直接在冻结节点上注册、核验模型，发布和回滚都不需要将权重复制到控制端。activation 另带公开的 `modelNode` 绑定，后续推理须连同模型 ID 一起使用；配置与调用约定见 [远程发布与回滚](controller-v2.zh-CN.md#远程发布与回滚)。

## GPU 验证与认证

先在隔离设备上运行真实兼容探针，再把带原始证据的报告作为 CAS probeEvidenceRef：报告 `kind=gear-training-compatibility-probe`、`schemaVersion=1`，`runtimeLockIdentityDigest` 等于去掉 validation/probeEvidenceRefs 的 lock digest；checks 必须实际通过 `exactTokenIds`、`behaviorLogProbs`、`toolContinuity`、`exportReload`、`hitchHarbor`、`actorRolloutAlignment`。报告是验证结果，不是跳过验证的开关；CPU mock 不能提供这些结果。

`colocated` 还要求每份有效报告的 `placementIdentityDigest` 等于 `gear_training.placement.placement_probe_digest(trainingRequest)`，绑定设备数量、模型结构/dtype/token 语义、hyperparameters、batch、DP 和 rollout 配置。旧独立模式报告不会计入共享模式验收。另需完成三个 checks，并归档各阶段 GPU/主机内存、实际 GPU UUID、原始日志及数值结果：

- `colocatedMemoryCycle`：同一显卡至少两轮 generate → offload → train/save/export → onload，同步确认显存切换，故障/取消后释放资源；不发生未结束请求下的卸载。
- `colocatedCheckpointRecovery`：训练 checkpoint 前后中断、sealed batch 重放、HF 导出失败后只重导出、optimizer/RNG 连续恢复，随后 Hitch 评估串行复用显卡。
- `colocatedWeightAlignment`：初次和更新后 SGLang 权重/token logprob 与 actor 数值对齐，验证 offload/onload 与 tensor/IPC 同步不造成权重损坏或旧策略泄漏。

云端需逐项验证：native token IDs/terminal 与 actor logprob 数值一致性；两次工具调用 prefix 精确连续；一批完整 B×G 的 backward 和 ratio/KL；所有 rollout replica 同步；训练取消与旧请求 fencing；checkpoint 前后中断和 HF 导出故障恢复；HF reload 有限权重；Hitch immutable local SGLang 的非流式/流式工具协议；真实 Harbor verifier；两套 SGLang 隔离及串行释放；多轮 optimizer/reference 不漂移；最终 dev/held-out 比较和显式发布回滚。

完成相应范围的检查后才将 lock 设为 `validated` 并初始化正式实验。实际通过的模型、拓扑与数值门限以下方认证记录为准。

### 认证范围与入口

[RTX 5090 单卡认证记录](https://github.com/rsi-gear/gear/tree/b1baa88799771cafde5ec9704291e5dc2f25a601/docs/training/certifications/2026-09-10-rtx5090-single-gpu)保留 2026-09-10 的 runtime lock、认证对象和验收摘要，覆盖两次更新、故障恢复、信息隔离及独立 Hitch / Harbor 评估。认证绑定实际代码、节点、模型与 recipe；代码或运行时身份变化后需要重新冻结和核验，历史证书不证明新身份已通过。

`python -m gear_training.certification --request REQUEST.json --audit AUDIT.json --store CONTROLLER_CAS --output LOCK.json` 在控制端核验全部审计文件的摘要、长度、身份、检查项与证据类型，完整通过才输出新 lock；原 request / lock 不改写。审计使用 `gear-runtime-certification-audit` schema 1，scope 由 `certification.scope(request)` 生成，必需检查与证据类型由 `certification.REQUIRED` 定义。每项 observations 包含 check / method / passed 和相对审计目录的 artifacts（path / sha256 / size）。原始审计制品留在控制端；Trainer 只接收公开证书，缺少实机恢复或隔离证据时入口拒绝封存。

故障 canary 因 SSH 或控制端中断结束后，可用 `node scripts/canary-training-recovery.mjs INPUT_ROOT --resume` 继续尚未完成的阶段。续跑先核对原 request / node / runtime / GPU、已通过阶段的原始回执及旧进程释放，再将失败尝试另存；已通过阶段不重复执行。节点不可用或身份变化时保留原记录并拒绝启动。若远端已注入故障而控制端未取回完整回执，先协调证据，不自动覆盖该故障点。该入口仍为 pending-gpu 诊断，不能代替正式认证。

可复用探针位于源码仓库的 `python/probes/`，控制端编排入口位于 `scripts/`：

- `hitch_native_gateway_smoke.py`：原生 token、工具轨迹与网关协议。
- `slime_actor_smoke.py`、`sglang_colocated_smoke.py`：actor 更新和共卡切换。
- `checkpoint_resume_smoke.py`、`single_gpu_recovery_smoke.py`：checkpoint 与单卡故障恢复。
- `audit_training_capture.py`、`audit_recovery_resources.py`：训练数据及恢复资源的证据审计。

探针不随 npm 包发布；请使用与待验证 runtime 对应的源码 checkout，并按各入口参数指定本次输入和输出目录。

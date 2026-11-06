# 无人值守多轮训练与原生候选部署

该功能为新实验提供一次启动、自动推进的多轮控制器。主要拓扑是本机 Gear/Hitch/Harbor Docker 执行 Agent 任务，固定远端 GPU 节点运行训练与原生 SGLang；模型节点无需 Docker。软件契约测试与真实 GPU 验收分开：本轮交付代码、受控测试、配置工具和下述验收流程，真实 GPU、真实任务集及三种拓扑由后续部署验收。已有 `pending-gpu` 诊断保持原状态。

完整要求见[原方案](../unattended-model-iteration-design.zh-CN.md)。已有单轮 external-file 实验保留其 spec、摘要和恢复方式；修改 controller 文件不能给它们增加部署权或自动 admission。

## 新建实验的冻结输入

在完整 v2 `model-training` spec 中增加 `endpointPreparation={mode:"managed-native",profileDigest}` 与 `iteration.schemaVersion=1`。profile 的完整私有内容放在 controller 的 `managedNative` 和评测节点 `node.json.nativeDeploymentProfiles[profile.name]`，两侧必须逐字段一致。controller 的 `evaluationBindings` 与 `managedNative` 互斥。

迭代策略冻结 `maxRounds`、`maxWallClockSeconds`、`maxConsecutiveRejected`、`recovery.maxRunRecoveries`、`recovery.maxEvaluationAttempts` 和 proposal 数组。`onRejected` 固定为 `next-declared-proposal-or-stop`，`onInconclusive` 为 `bounded-repair-or-stop`，`autoPublish=false`。每个 proposal 有唯一 `id`、可核验的不可变 `sourceRef`，可选择冻结训练任务 ID、每候选更新数或 rollout sampling。不能把 dev/held-out 任务加入训练选择。

接受后，同一 proposal 从新 champion 的完整 native checkpoint 继续，包含 actor、optimizer、scheduler/RNG 和数据 cursor；HF snapshot 只用于普通评测。拒绝后保留原 champion，消费下一个输入确实不同的声明 proposal；只有不同 provenance 标签、实际输入相同不算新探索。没有新输入时以 `no-new-proposal` 结束。新的 proposal 不兼容 champion checkpoint 时显式失败，不能重置 optimizer 再运行。

`maxRunRecoveries` 授权机器故障后的自动恢复，用户主动暂停独立持久化；重启 `iterate EXP` 不撤销暂停。`maxEvaluationAttempts` 包括初始实例，跨实例修复必须有剩余额度。示例采用两次评测 attempt 和两次部署 attempt，允许一次实例恢复；用尽后停止该轮并保留原因。

## 全实验训练 schedule

自动模式要求封存的 Slime argv 有显式正学习率，以及 `--lr-decay-style constant` 或覆盖全部声明轮次的 `--lr-decay-iters`。不会自动修改用户的 LR、min LR、warmup 或 checkpoint scheduler。

固定批量下，令 `U` 为初始 checkpoint 的 committedUpdate，`R` 为 maxRounds，`C` 为所有声明 proposal 的最大 updatesPerCandidate，`B` 为 rolloutBatchSize，`G` 为 groupSize（SFT 为 1），`GB` 为 globalBatchSize。非 constant schedule 至少满足：

```text
num-steps-per-rollout = B × G / GB
lr-decay-iters >= (U + R × C) × B × G / GB
```

这里 `lr-decay-iters` 的单位是 optimizer iterations；Slime 将它乘以 GB 转为 scheduler 的样本步数，真实更新按消费样本推进。不是再乘一次 `num-steps-per-rollout`。重复相关 flag、非有限/非正 LR 和与固定 batch 不符的步数均在实验创建前拒绝，支持 `--flag=value` 和分开的参数形式。

原因来自固定 [Slime scheduler 初始化](https://github.com/THUDM/slime/blob/41014d1f29e201137fdffce737bb8bac65bc5219/slime/backends/megatron_utils/model.py)：默认 horizon 来自本次候选的 `num_rollout`，不能据此给后续轮次保证有效 LR。native resume 显式使用已保存的 scheduler 参数，并禁止 optimizer/RNG reset、finetune、scheduler override 或 HF fallback。恒定 LR 或全实验 schedule 必须在首次训练前确定。

另用实际 [Megatron `1dcf0da` scheduler 类](https://github.com/NVIDIA/Megatron-LM/blob/1dcf0dafa884ad52ffb243625717a3471643e087/megatron/core/optimizer_param_scheduler.py)执行了一次 CPU 参数组检查：constant 的两轮更新前 LR 为 `1e-6/1e-6`；全实验 linear 为 `1e-6/5e-7`；一轮 linear checkpoint 恢复后第二轮 LR 为 0，复现了需要防止的语义缺口。源码 hash、消费样本数和结果见[受控记录](../validation/unattended-scheduler-controlled-2026-10-15.json)。该检查未执行 optimizer 更新、CUDA 或模型训练。

## 配置与观察

先准备已有 v2 controller/spec、固定训练 runtime lock、不可变初始 HF/CAS 和三个数据划分。训练 runtime 必须完成现有认证；`validated` 与 probe evidence 的门禁继续生效。普通评测环境与训练 Python 分开，固定 SGLang、Supervisor 和 GNU timeout 版本，不在每轮升级依赖。

复用[受管原生部署指南](managed-native.zh-CN.md)和[完整 profile 模板](../../examples/training-loop/managed-native/profile.template.json)。`nodeRef` 指向 controller 已配置节点；`nodeId/generation` 使用现场 probe。`gpuUuids` 是预留评测组；`trainingGpuUuids` 必须准确等于该节点上的冻结训练设备，且两组互不重叠。另一评测节点没有训练设备时此数组为空。TP 大小等于评测卡数，首版每组一个模型；观察到外来进程时等待或失败，不杀外来进程。

在评测节点运行只读环境观察，使用与节点相同版本的 Gear Python：

```sh
/opt/training/bin/python -m gear.training.cli.native_deployment runtime-lock \
  --python /opt/sglang-eval/bin/python \
  --supervisor-python /opt/gear-control/bin/python \
  --timeout /usr/bin/timeout
```

将输出环境锁放入 profile，或使用原生指南的 `prepare-profile.py` 直接生成完整对象。`endpoint.serviceConfig.engine_version` 与实际 SGLang 一致，tokenizer/template 摘要来自不可变模型；工具解析器、上下文和内存参数需要对具体模型验证。模板不是 GPU 兼容性保证。迭代准备工具只允许计算派生的 `engine_digest="derive"`，其余环境、设备和版本身份须真实观察。

构建 Gear 后，在控制端生成完整可提交配置：

```sh
node examples/training-loop/unattended/prepare.mjs \
  --controller /srv/gear/base-controller.json \
  --spec /srv/gear/base-spec.json \
  --profile /srv/gear/evaluation-profile.json \
  --output /srv/gear/experiment-inputs \
  --max-rounds 5 --wall-seconds 28800 --max-rejected 2 \
  --run-recoveries 1 --evaluation-attempts 2
```

输出 `controller.json`、`spec.json`、`native-profile.json` 与 `node-profile.patch.json`。助手会检查 profile、GPU/路由冲突、schedule 和冻结输入，更新新实验的公共 engine/protocol/sampling digest；不启动模型、不运行训练、不改变认证状态，已有输出不覆盖。默认一个 proposal，拒绝即结束；额外计划通过 `--proposals PROPOSALS.json` 一次声明。

把 `node-profile.patch.json` 合并到评测节点原 `node.json` 的 `nativeDeploymentProfiles`；保留原节点身份、CAS、job 配置。节点仅接受该 allowlist 中 profile 名称及完全匹配的 digest。controller 再调用 `gear training freeze-evaluation-profile --config CONTROLLER.json` 可核对冻结授权，不会探测 GPU 或创建服务。

| 位置 | taskExecution | 训练/评测连接 |
| --- | --- | --- |
| 本机控制 + 远端 GPU | 本机 `local-docker` | `transport.type="ssh"`，独立普通评测端口 |
| 常开服务器控制 + 另一 GPU 服务器 | 控制服务器 `local-docker` | 相同 SSH profile 和实验循环 |
| Linux GPU 服务器一体部署 | 同机 `local-docker` | `transport.type="local"`，评测 localPort=nodePort，静态分卡 |

三种情况只改部署位置、连接和私有 profile。`deployment.nodes.*.gateway` 仍为训练通道；普通评测使用 profile 中独立端口/认证与 Hitch 宿主代理。Agent 工具和 verifier 在控制端任务容器执行。远端 Harbor worker 的能力门禁没有放宽。

## 一次启动与控制

启动符合冻结环境的 Hitch daemon、Docker 和 provider 后运行：

```sh
gear training iterate /srv/gear/experiment-inputs/spec.json --config /srv/gear/experiment-inputs/controller.json
```

`run SPEC` 在 spec 包含 iteration 时也进入相同循环。输出的实验 ID 用于后续命令：

```sh
gear training status EXP_ID --config CONTROLLER.json
gear training iterate EXP_ID --config CONTROLLER.json
gear training advance EXP_ID --config CONTROLLER.json
gear training pause EXP_ID --config CONTROLLER.json
gear training resume EXP_ID --config CONTROLLER.json
gear training close EXP_ID --config CONTROLLER.json
```

`iterate EXP` 只协调原持久意图；已暂停实验立即返回，只有显式 `resume EXP` 才产生较新 start。`advance EXP` 只走一次外层协调。SIGINT/SIGTERM 保存暂停意图并协调取消。单轮的 `EXP RUN` 诊断命令仍可用；自动实验的 round admission 由外层事务管理，不逐轮手工 admit。

外层状态为 `running / pausing / paused / completed / failed`。`rounds[roundIndex].runId` 与 run 创建在同一事务提交；决策后的下一计划或停止意图也在同一事务落盘。训练已经提交但客户端丢失回复、评测已经提交、决策已提交等情况下，重启协调原身份，不生成重复 run。

完整有效 baseline 先按 subject 和公共 condition 复用，命中时不准备模型或申请评测卡。确需调用时 observe 当前实例、登记 durable consumer 后才提交 Hitch；确认任务/请求结束后释放 consumer。最后一个消费者退出后可以退休自属服务。接受的 candidate evidence 成为下一轮 baseline，checkpoint/HF/CAS 持久保留，模型无需一直常驻显存。

## 恢复、期限与清理

已保存 ready 是历史观察，调用前重新核对实例。确认实例死亡后先取消并确认旧任务结束、释放旧 consumer/实例，再建立新的显式 endpoint attempt。每个 attempt 绑定自己的不可变连接和回执，保留旧 attempt、有效槽位（包括 reward=0）与累计费用，只修复缺失/无效槽位。新实例不能覆盖原 journal 绑定。

暂停发生在活动评测期间时，恢复可能消耗新的部署/评测 attempt。额度不足即明确结束，不能透明重放请求。external-file 的已取消活动评测若无法在相同冻结绑定上显式修复，会报告不支持或额度耗尽；不宣称所有外部活动取消都能无缝恢复，也不由 Gear 启动外部长驻服务。

实验的 `startedAt/deadlineAt` 固定且跨重启不刷新。native training supervisor 在控制端离线时仍检查 request 的绝对 deadline，沿用已有有序取消、30 秒 TERM/45 秒 KILL 自属进程组收尾；真正的资源释放仍须观察确认。普通推理通过固定 GNU timeout 和 Supervisor process-group 配置约束最大运行期。到期强制退出会产生失败/取消证据，不能声称未知消费者已优雅完成。

三种完成事实分别为 run 的 `resourcesReleased`（训练）、`evaluationTasksCompleted`（任务/请求）和 `inferenceResourcesReleased`（受管普通推理）。停止超时、网络不可观察或身份不符时保留 `pausing` 和诊断，不能提前标 completed。启动中尚无 ready binding 的部署也必须协调清理。只有实验终态确认全部退出后才显式归还部署组 ownership；轮次间释放和用户暂停保留 ownership，防止迟到启动跨实验串用。

控制端保持运行、Docker 可用、网络可达。本机合盖/离线不会变成服务器自动执行；训练和推理节点的自身期限仍生效。服务器运行时应由现成进程管理工具托管 Gear/Hitch；该工具重启不能撤销持久化用户暂停。

训练 GPU seconds、rollout tokens、held-out 查询数、最大轮次/连续拒绝、数据 cursor 和总墙钟共同限制 admission。失败/修复继续消耗真实费用；shared inference GPU seconds 保持 `null`，不能补零，不能将训练 GPU 硬预算解释为全链路 GPU 硬预算。尚无可靠分摊的加载/驻留成本保留部署记录与时间，不宣称已有完整 GPU 成本硬预算。

## 后续真实 GPU 验收

以下由部署验收者执行，并分别保留三种拓扑的证据，不修改评分或运行时认证来制造晋升：

1. 固定 Gear/Hitch/Slime/Megatron/SGLang/Supervisor、Harbor、任务镜像及 Python 环境，验证真实 CUDA/runtime probes 与学习信号；pending lock 先完成认证。
2. 用真实 Agent 容器完成文本、SSE、生成工具调用、工具执行、结果回传和 verifier，证明容器到远端普通模型路径；模型节点不得调用 Docker/Harbor。
3. 从一次 `iterate SPEC` 产生两个不同 round/run，自动导出、部署、评测及清理，无人编辑绑定或 admit。候选未达到门槛时照实记录拒绝，接受分支只能使用真实达标结果。
4. 接受分支另起训练进程，核对 native optimizer moments/step、scheduler 参数及非零有效 LR、RNG、数据 cursor 与 candidate checkpoint/actor/HF 一致；不能只比较 HF 权重或进程存活。
5. 中断启动请求、ready 落盘、评测提交和决策提交，并重启 Gear/Hitch；验证消费者、物理 attempt、有效失败槽位、费用和 deadline 不丢失、不重复执行。
6. 并发两个登记消费者，取消其中一个后另一任务仍可完成；最后一个结束后 TP 子进程与自属 GPU 计算进程全部退出。外部长驻服务与外来 GPU 进程保持可观察且不受自动清理影响。
7. 核对旧 binding 无法调用新 incarnation；加载失败、磁盘不足、断网、期限、停止失败和预算耗尽都有保留证据。归还 ownership 后新实验可使用同组，旧命令永久被隔离。
8. 保全初始模型、champion 完整 checkpoint/HF 闭包、活动候选和恢复制品；临时节点销毁前完成 hash/size 校验的持久副本。完整 held-out benchmark、服务器个人电脑断开后继续执行等分别报告。

受控软件测试覆盖状态机与 CLI 函数入口、两轮 deterministic trainer/evaluator、文件/CAS 跨进程恢复、HTTP/任务和进程故障边界。它们不证明真实模型 optimizer 恢复、GPU 非零学习信号或上述任意真实拓扑已验收。

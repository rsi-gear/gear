# 历史输入与物理执行宿主

`HistoricalSeedExperienceSource` 是历史数据读取器，不是算法。它要求已注册的 evolution、已保存的 round 和真实编译 seed 目录；任务 ID、`instruction.md` 与内容摘要必须一致。只有宿主选定该 round 中已保存的精确 seed `evaluationId` 并提供 Hitch trajectory reader，才会导入有界、脱敏的真实 event pages；否则只封存任务 prompt/report。旧 `LegacyEvolutionExperienceSource` 只封存 seed summary，不能据此生成可运行任务。新实验走 `FreshSeedExperienceSource`，不需要旧 round，也不冒充历史轨迹。

物理 rollout 使用 `rsi-gear/algorithm/harness` 公开的 `HitchRolloutPort`/`createHitchRolloutAdapter`。RHO/AHE 要求精确 `harness.directory.v1` Git 绑定；Evo 要求 `{harness,skills}`，并由受管理的 Skill overlay 把选中库成员写入操作自己的 Git 工作区，检查、封存并执行该 commit。两种情况都核验任务内容来源、编译数据集摘要、采样、完整 Hitch 子进程环境、实际运行 commit 与 receipt。并发任务投影只在另一调用已原子发布相同数据集时重新核验一次；投影损坏仍拒绝。

受限 DSH 角色使用 `DshRoleSessionRegistry`、`createEvidenceDshRoleHost` 与 `createDshStructuredAdapter`；后者必须接入 Campaign budget、真实模型身份和实际用量来源。role 读取新 rollout 轨迹时，必须在输入中有同 Campaign 已完成操作的精确 `{evidenceRef,receiptRef}`，工具再验证 producer journal 并按授权 projection 计量。RHO self-preference 是模型的无标签成对判断；AHE/Evo 受信 feedback 从完整物理 trial 派生 score。`createWorkspaceEditAdapter` 与 `createWorkspaceEditDshHost` 提供操作级隔离 Git 工作区、受限文件工具、实际 compiler 检查、终态 receipt 和未知结果恢复，不使用旧 candidate lease。

自行直接组装这些低层 provider 的宿主需要持有真实 `HarnessBuilder`、`CandidateWorkspaceManager`、`HitchCliEvaluator`、数据/任务权限和受限 DSH `Context`。只挂接证据工具不会隔离已存在的 shell/文件工具。普通作者应使用[一次性宿主配置](../host-setup/README.md)中的公开 `createConfiguredFreshHostProfile`，而不是复制旧的零散变量示例。宿主设置需要声明全部传递的本地运行时文件，且为模型调用显式批准目的地。

相关单测以真实 Git 工作区、离线 DSH 模型和录制 Hitch CLI 覆盖准入、计量、取消及恢复；没有证明真实模型权重、在线 Hitch daemon、GPU 或论文指标。旧 pending 搜索仍须保留原封存运行时完成，不能由新 Campaign 假冒恢复。

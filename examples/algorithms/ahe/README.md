# AHE：先测量已执行版本，再决定下一步

`algorithm.py` 直接引用唯一的 `gear_algorithm.recipes.ahe` 实现。普通作者只配置 `taskCount`、`rounds`、`rolloutsPerTask` 等科学参数。recipe 在每轮先测**实际执行的 Git Harness**，核对上轮预测与当前测量，必要时选择性恢复文件，然后才提出下一版本；`bestMeasured` 与尚未测量的 proposal 分开保存。fresh seed 任务含真实 prompt，但没有历史 trace；新 rollout 的受限报告和事件由角色凭 producer receipt 下钻。

宿主经 `createConfiguredFreshHostProfile` 配置封存 TaskView、Hitch daemon、受信反馈计分、归因角色、受限 workspace edit、模型目的地和按操作种类的预算预留。`ahe.task-measurement` 的 score/passed 从已验证的完整物理 rollout 派生，不接受模型自由填写的分数；editor 只处理批准的工作区文件并封存新的 Git commit。见[宿主配置](../host-setup/README.md)。

`tests/unit/algorithm-default-ahe.spec.ts` 以真实 Python recipe、离线模型、Git 和录制 Hitch CLI 检查多轮测量、选择性恢复与恢复重放。它不声称真实模型、GPU、Hitch 服务或论文结果已验收。

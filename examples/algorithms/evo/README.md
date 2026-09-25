# Evo：按批次冻结并执行 Skill 库

`algorithm.py` 引用唯一的 `gear_algorithm.recipes.evo` 实现。普通作者设置 `batchSize` 和 `injectionBudget`；每批使用一个冻结的 `{harness,skills}` BindingSet，retriever 只可读绑定库内成员，curator 的 ADD/MERGE/REVISE/SKIP 由宿主验证并封存。任务游标与下一批 Skill 绑定在同一次决策提交；SKIP 不伪造新库。

当前物理 Hitch adapter **支持**受管理 Skill 注入：选中 `skills.body.v1` 成员从精确绑定的 `skills.library.v1` 物化到操作自己的 Git 工作区 `skills/<name>/SKILL.md`，经真实 compiler 的发现/读取检查后封存 Git commit。Hitch 执行该 commit，receipt 记录注入成员、overlay 和执行版本；失败任务分数由受信 rollout evidence 派生。Skill 向模型披露需要宿主管理员显式批准目的地，recipe 输入不能授权任意库读取。见[宿主配置](../host-setup/README.md)。

`tests/unit/algorithm-default-evo.spec.ts` 用真实 Python recipe、离线 DSH 工具、Git/Skill overlay 和录制 Hitch CLI 验证两批、ADD/SKIP 及恢复；proposer 实际读取失败的工具结果后才提出 Skill。它不证明真实模型质量、在线 Hitch 运行或论文复现。

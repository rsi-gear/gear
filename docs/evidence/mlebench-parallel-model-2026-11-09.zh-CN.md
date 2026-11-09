# Titanic 三并发真实模型验收（2026-11-09）

同一固定 harness 的三次独立实验全部成功，平均准确率为 **76.3158%**，样本标准差为 **1.6746 个百分点**。三次均计入平均值，没有挑选最佳结果，也没有加入此前采用其他资源配置的运行。此分数衡量当前 harness、模型和本任务配置的组合，是用户提供标签上的准确率，不是 Kaggle 官方排行榜分数。

| 实验 | 正确 / 总数 | 准确率 | Agent 执行时间（UTC） |
| --- | ---: | ---: | --- |
| 1 | 311 / 418 | 74.4019% | 10:37:07.735–10:39:09.247 |
| 2 | 324 / 418 | 77.5120% | 10:37:07.306–10:38:50.480 |
| 3 | 322 / 418 | 77.0335% | 10:37:07.961–10:38:32.867 |

实测 Agent 并发峰值为 **3**，三者共同执行窗口为 **84.906 秒**。使用当前配置的 `openai-codex/gpt-6-luna`，固定 harness commit 为 `f6a068ec0728f2fa70a95e085a76262de9c5a31d`；模型名称由 provider 返回，未解析到额外的不可变模型版本。共执行授权的 3 次完整任务，全部有效，失败数 0，基础设施重试数 0，没有额外启动模型任务。

每次 Agent 环境为 **1 CPU / 1024 MiB / 最长 1 小时**，独立 verifier 为 **1 CPU / 256 MiB / 最长 120 秒**。调度器每次预留 2 CPU、1280 MiB、2 个容器槽；排队、构建和 setup 不计入 Agent 执行时限。本轮均提前完成，不以填满一小时时限为目标。

三次都使用全部 891 行原始训练数据，并为原始 418 行 test 生成 submission。验收器没有再次切分训练集；评分仅使用用户指定的私有标签文件，SHA-256 为 `a2a22b5d240612a4eb4b1508110522250f193677748c32454c0f6914f3cc280e`。这不限制 Agent 在训练数据内部自行做交叉验证。每份 submission 均经过独立导出、418 个唯一 PassengerId 核验、产物摘要核验及本地准确率重算，结果与 verifier 一致。

三次执行各有独立的 run、参数状态、产物清单、workspace 和候选／verifier 容器；6 个容器 ID 与名称全部不同，3 个 workspace 均已回收。封存证据中的 `workspace_mode: shared` 指各次 Agent 在自身容器工作目录内执行，不表示跨实验共享目录。checkpoint 不自动传入下一次实验；需保留的文件必须写入任务声明的产物路径。

Docker 采样捕获了每次两个容器的实际 CPU、内存限制，未发现 OOM。清理期间存在 `context canceled` 或 `No such container` 采样竞态，因此资源观察状态如实保留为 `partial`；它不影响已经完成并核验的三份评分。这里没有把采样峰值当作完整的资源使用峰值。

本轮直接通过 Hitch 的同一 eval 启动三次 attempt；Gear 的 repetition 并行与跨候选执行由[独立的 Linux 确定性验收](mlebench-concurrency-2026-11-09.zh-CN.md)覆盖。相关[自动化检查记录](mlebench-concurrency-validation-2026-11-09.json)与[本轮机器证据](mlebench-parallel-model-2026-11-09.json)分别保存。

身份与本地产物：

- eval：`eval_02cb88b705534f399cab3fbe017ffd31`
- Hitch runtime：`sha256:360e4b2884e6ca010223ac6f594f3f973232cabc268fec7db6a81730684b0d31`
- task：`titanic-user-holdout-1h-v4`，内容摘要 `sha256:7ad47e14c8eb45fa3cc507b94cd7574b3855a6f7cd2d539560874ac560da3fd6`
- dataset：`sha256:a0f1ca9e612962f7a683f460b7892af95c92ba4629cc62c3c83d59104c9e6280`
- 三份 submission 与训练代码：仓库本地 `.evolve-lab/mlebench-parallel-20261109/deliverables/attempt-{1,2,3}/output/`
- 完整本地记录：`.evolve-lab/mlebench-parallel-20261109/model-summary.json` 与 `.evolve-lab/mlebench-task-contract/hitch-state/`

私有标签、凭据和原始模型轨迹不随仓库提交；公开证据保留身份、分数、资源及产物摘要。运行采用冻结的本地构建快照，仓库原有无关未提交内容仍保留，故 runtime 身份以内容摘要为准。

# RHO：修改一份 Python 科学策略

`algorithm.py` 只替换历史 coreset 的选择函数；RHO 状态机仍由 `gear_algorithm.recipes.rho` 实现。普通作者配置 `coresetSize`、`historyPageSize`（≤100）、`baselineRepeats`（≥2）和 `proposalCount`，不填写证据 ref、权限、采样/环境摘要或预算来源。已有历史视图可让 recipe 查询 `overview`、`task-report` 和授权的 `trace-chunk`；fresh seed 视图只有真实 prompt/report，宿主冻结 `historyTraceAvailable=false`，recipe 不会编造旧轨迹。

宿主使用公开 `rsi-gear/algorithm/harness` 的 `createConfiguredFreshHostProfile` 或受信 `createDefaultFreshHostProfile` 建立 TaskView、Hitch rollout、DSH role、受限 Git workspace editor 和成对无标签 self-preference。每个已完成的新 rollout 的报告/轨迹读取都要核对 producer journal 与 `evidenceRef`/`receiptRef`。候选仅在平均偏好为正时进入新 `harness.directory.v1` 绑定；模型偏好不是 grader 标签。

本目录是**作者覆盖示例**，不是自行注册模型或运行 Hitch 的完整工程。一次性 `host.mjs`、`host.settings.json`、真实模型注册和 Campaign budget 由管理员按[宿主配置](../host-setup/README.md)提供。`tests/unit/algorithm-default-rho.spec.ts` 用真实 Python recipe、受限 Git/DSH 和录制 Hitch CLI 验证流程；未验证付费模型效果、真实 daemon 或论文复现。

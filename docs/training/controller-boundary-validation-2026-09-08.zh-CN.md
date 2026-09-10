# 训练控制端连接修复与本地准备

这轮没有启动 GPU。此前的 Slime actor 诊断与真实 Harbor 轨迹诊断各自通过，但尚未覆盖完整 Gear 作业的连接处。本地检查发现并修复了以下问题：

- driver 原来对 spec 中的驼峰采样配置计算 lease 摘要，控制端却对 gateway 实际使用的原生参数核验。现在 driver 与 rollout 共用 `sampling_params`，rollout 在打开 gateway 前核对摘要；Python 创建的真实 driver lease 经 SQLite episode journal 发出后，由 TypeScript `validateRolloutIntent` 验证。
- 真实 Harbor canonical record 的 `harness.requested_ref` 是 `training-tool@commit:完整提交`，而 eval 的 accepted request 保留原始 `git+file:` 引用。Gear 的训练及评估比较现在接受这两种确切表示，同时继续核对完整 commit、revision identity 和 artifact ID。控制端另核验 accepted request 的原始 source，不能凭相同短提交或另一个 artifact 通过。
- 同一完整 checkpoint 在 pending-update 与最终 commit 阶段会再次封存。CAS 现在先核验已存在对象的 SHA-256，再直接复用，省去另一份 checkpoint 大小的临时写入。缺失内容仍按原流程复制和验摘要，损坏对象仍拒绝；没有移除恢复所需的任一 manifest。

验证：102 项 TypeScript 测试、98 项 Python 测试、类型检查及构建通过。新增的真实记录回放取自 `run_19cbaa524e734473807aee85dccbd023`，只证明 canonical 身份比较兼容；测试中补充的期望 descriptor 不会把过去的诊断追溯认定为已冻结的训练样本。另覆盖错误 commit、artifact、revision、verifier、policy 的拒绝，以及磁盘不足时复用原 CAS 对象、损坏对象拒绝。

下一次运行的单任务 snapshot、verifier descriptor 和已提交的 harness manifest 已在控制端 CAS 封存，并从 CAS 重新 materialize 核对。记录的原 harness source 仍保持干净，现有脚本内容与本次 Hitch 分支一致；改变 source URL 会改变 revision identity，不能直接搬迁路径后复用旧 manifest。模型从停止中的原实例取回，按固定模型版本的文件 SHA-256 验证并在 CPU 上执行完整 HF 封存，以减少 GPU 开机后的准备工作。

准备制品位于 `/Users/tangyehui/.codex/artifacts/gear-integrated-training-inputs-20260908`。完整训练作业、GPU 数值对齐、故障恢复、产物 collect 和独立评估仍待实测。未生成 validated runtime probe，也未开放尚未验收的远程 capability。

另外用真实 Hitch daemon 执行了 `observeExecutionProvider`：两个仓库的 shell 默认分别使用 Node 23.11.0 和 26.7.0，触发预期的 CLI/daemon runtime 漂移拒绝。为 daemon 和 controller 的 Hitch command 固定同一个 Node 26.7.0 可执行文件后，实际 Harbor、Linux Docker、训练绑定和 managed model route 的 provider 检查通过。结果保存在 `provider-observation.json`，连接模板仍待填入下一台 GPU 的实际 node/generation/runtime 身份；没有提前冻结虚构 GPU。准备结束后该临时 CPU daemon 已停止。

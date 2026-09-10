# Slime 模型训练实现与验收

依据：`docs/slime-model-training-spec.zh-CN.md`。2026-09-10 当前范围已完成：本地控制端 / Harbor 与远程单卡训练、推理节点的故障恢复、信息隔离和 runtime 认证。最终证据见 [公开认证与验收摘要](certifications/2026-09-10-rtx5090-single-gpu/README.zh-CN.md)，后续实施与历史失败见 [执行位置实施记录](execution-placement-status.zh-CN.md)。下文保留最初实现阶段的检查清单与测试记录，不作为最终验收状态。

实现位置：Gear `codex/slime-model-training`；Hitch 在既有 checkout 的 `codex/slime-training-binding` 分支实现，最初基于 `dev` 的 `9788b85199f3f087fa59fff85dd7ddfba8831ed4`，两者均向 `dev` 提交。既有 Hitch 推理文档草稿保留，未并入这次实现内容。

## 工作清单

- [x] 版本化模型合同、严格配置校验、内容寻址对象与原子状态。
- [x] 精确生成 receipts、策略租约、线性 token Sample、工具观察 mask 和完整 GRPO group admission。
- [x] Python job / Slime hook / checkpoint / HF export，以及结构化 Gear provider。
- [x] Hitch training-external 请求、计划、运行、能力与证据绑定。
- [x] 模型轴配对评估、基线复用、受限 invalid-slot 修复、门禁、champion CAS、显式 release / rollback。
- [x] 幂等提交、取消、进程身份、预算预留、sealed batch replay 和 checkpoint 后独立重导出。
- [x] 公开 package/CLI、运行说明、runtime lock 和拒绝 pending-gpu 的 preflight。
- [x] CPU 单元/合同测试、类型检查、构建和打包检查。
- [x] 显式 colocated placement、Slime CPU offload 周期、checkpoint/导出恢复与具体配置绑定的 GPU 探针门禁；保留 separate 模式。
- [ ] 云 GPU：真实 token / logprob 数值、工具协议、backward、恢复、导出、Harbor、双 SGLang 联调（等待用户创建云服务）。

## 本地验证

- Gear 初始实现完整 Vitest：501 项通过、8 项环境相关跳过；本次单卡支持后训练专项 19 项，覆盖 coordinator、placement 合同、并发状态、Slime Python RPC 和 Hitch CLI 评估边界。
- Python stdlib unittest：30 项通过，包括精确多轮 mask、旧策略/历史拒绝、token 预留、失效请求计费、租约 barrier、CAS/分片校验及导出失败重试；新增真实 driver 的连续更新、batch 重放、pending export 恢复、未封存 batch 拒绝，以及显存切换各阶段的失败注入和探针配置漂移。
- Hitch `npm run check`：类型检查、构建、架构检查、语法检查通过；502 项测试中 498 通过、4 项环境相关跳过。
- Gear / Hitch npm dry-run 打包均核对包含新增入口、Python bridge / Slime patch（Gear）和 training-tool runner（Hitch）。

CPU 测试只证明合同与控制流。没有把 fake provider、HTTP 仿真、故障注入或静态检查标成 GPU 兼容通过。真实 probe evidence 完成前，正式训练被 preflight 阻止。

## 云端开始前

1. 将当前实现提交为精确 Git revision，再用该 commit 固定 harness / Hitch runtime。运行时不会用工作树状态冒充 immutable commit。
2. 选择实际模型、训练超参数和 GPU 拓扑，锁定镜像、Slime/Megatron/SGLang/torch 等版本并应用 HF export 扩展。
3. 依 `README.zh-CN.md` 固定数据、环境、verifier、harness artifact 和评估 inference lock。
4. 先执行隔离兼容探针，再进行一批完整训练、故障恢复、HF reload 和 Hitch SGLang / Harbor 联调；完成后创建 validated lock 下的正式实验。

当前限制：单节点、Megatron；支持 separate 或整个设备池共享的 colocated/offload，不支持 release-train、角色配置覆盖和多模型/分离式 rollout；共享模式使用 full tensor/IPC 同步。固定 `training-tool` 线性 Chat Completions harness；一个评估 GPU；评估墙钟成本采用保守计费；发布更新 Gear 的模型指针，业务 episode 需在开始时读取并固定 immutable model ID。单卡真实容量、主机内存峰值和数值正确性仍待云 GPU 联调。

# MLE-bench：Gear 与 Hitch 的执行边界

本版由 [通用任务与参数权限规范](mle-bench-task-contract-and-parameter-policy-spec.zh-CN.md) 取代旧研究执行协议；这是破坏性替换，旧项目、checkpoint 与 receipt 不提供恢复、重放或自动转换。

| 组件 | 职责 |
| --- | --- |
| Hitch benchmark 包 | 导入上游公开输入、原始说明、环境、私有评分资源和 grader；声明提交文件及参数合同 |
| Hitch 通用运行器 | 准入、配置权限、资源约束、sandbox、产物收集、独立 verifier、取消和恢复 |
| Target | 使用普通终端/文件工具分析、训练、选择方法、生成并交付预测 |
| Gear | 优化 harness、登记 repetitions 和总预算、比较可信正式指标、晋升候选 |

一次 Target 调用是一轮完整任务。正常退出后运行独立 verifier；必需交付物缺失即交付失败。最终训练和预测在该任务内完成，用户无需追加 refit。正式评分与内部 CV 分开；仅有无标签测试数据时，交付有效性不能解释为测试准确率。

内部方法参数由任务声明可编辑范围、主体和时机。正式评估协议、私有资源和权限策略进入评估身份；更改这些内容必须重新评估 baseline。候选 harness 与获准 Meta 参数进入方法身份；完整有效配置、运行环境、repetition 和资源进入执行身份。恢复不更换输入、不增加模型采样。

Gear 使用既有 Harbor benchmark 与 Hitch provider，无 MLE-bench 专用控制器。初始分析 harness 提供可组合的指导和 skill，运行时工具来自所选通用 adapter。Hitch 不依赖 Gear 的优化算法。

缺少可信能力时，强制 fit 计数、可信 CV 或冻结选择要求在模型启动前以 `unsupported_constraint` 拒绝。普通脚本运行不受旧 pipeline factory、对象序列化或研究状态机约束。支持范围及未验证项见验收报告；历史实验产物仅保留作静态审计材料。

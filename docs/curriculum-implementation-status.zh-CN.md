# curriculum 完整设计实施与验收台账

目标：按 [完整设计](failure-driven-data-operators-spec.zh-CN.md) 实现剩余部分，优先完成正式 harness 搜索接入、候选约束处理与有效对照实验。此台账记录尚未完成的范围，不把基础算子或示例完成等同于整个设计完成。

架构不变：`gear.curriculum` 只保存纯算子及输入输出定义；转换、外部执行、准入、持久化和恢复由现有搜索／训练调用方负责。不增加 curriculum adapters 层。

| 要求 | 当前状态 | 完成所需的直接证据 |
| --- | --- | --- |
| 八个基础算子与轻量输入输出 | 已实现 | 当前 API、Module 重建、边界和算子测试 |
| harness 正式搜索接入（优先） | 已实现并通过离线 provider 集成 | `ReflectiveSearch` 经真实 `Project.refine`、隔离 worker、持久执行器运行；训练与选型范围分离，候选封存与恢复已验证；真实模型接入见下一项实验 |
| 候选约束与有限修订（优先） | 已实现并通过集成 | `PromptConstraints` 与独立 Meta 修订，稳定调用键、有限次数、收费回执恢复；超长文本不截断、不封存；真实实验中仍需核验各组有效候选比例 |
| 有效真实 LLM 对照（优先） | 待完成 | fixed/random/failure/完整记忆调度组，足够的有效候选，多个独立优化种子；预先固定留出评价与预算；修复、泛化、回归、曲线及成本报告。无需结果必然为正 |
| 学习目标策略 | 测量策略与信号已实现；skill-tree 待接入 | frontier/forgetting/rare_action/signal_mix 有跨策略条件与消融测试；`ExtractLearningSignals` 按 CoEvolve 三类布尔条件独立提取，不把软评分冒充论文公式 |
| 任务、环境、轨迹／修复、过程问答生成 | 四类合同、生成解析与分类型验证已实现；完整配方待验收 | 环境调用方测试实际执行参考与负例；trajectory 必须有 replay 执行证据，example 走 semantic correctness；真实环境配方另行验收 |
| 练习池筛选 | 纯算子与边界测试已完成 | 语义近邻绑定比较池和完整性；当前策略难度测量；预留探索槽；混合来源配额不足不暗中补齐 |
| `BuildSupervision` | 纯提案已实现并验证，训练接入见下一项 | 成功／前缀证据、修复新捕获 loss 片段、起始条件及 step 前缀配对、synthetic 过程问答；材料授权与标签来源明确 |
| 可信训练构建接入 | 三类新增 builder 已实现；更新器接入按能力分别验收 | 修复提案在调用处映射到新捕获的 receipt 边界；success proof、原始失败/回退状态与不复用旧请求检查；preference 核对实际 token 前缀、状态和伪标签来源；synthetic QA 用真实 tokenizer 进入既有 offline SFT 合同。修复/偏好输出仍为中间数据，DPO 及捕获型 SFT 自动 updater 接入尚未实现 |
| Forge-inspired 外层配方 | 待实现 | 停滞触发、失败记忆、四类变异、验证与混合池，新任务在后续 run 准入，固定外部评测 |
| SENTINEL / CoEvolve / DiagEvo / DataEnvGym 配方 | 待实现 | 各自实际执行入口、可替换组件、专有采样／验证信号与测试；能力不足明确拒绝，不能用空导出冒充支持 |
| TRACE / Agent-R / Self-Direction 配方 | 待实现 | 实际环境生成、修复／回退、过程问答和相应训练／加载／路由接入；逐项记录与上游的差异 |
| 动态任务池、MCTS/reset、DPO/LoRA/MoE 等后端能力 | 设计第三阶段，尚未验收 | 按具体配方实现合同及后端；涉及 wire/runtime 时同步更新；用实际执行证明相应能力 |
| 设计第 11 节九项验收 | 部分完成 | 每项都绑定具体测试／运行记录，不能以窄范围示例代替整体完成 |

已有探索实验在 [2026-11-19 报告](../research/curriculum-harness-2026-11-19/README.zh-CN.md)。它证明调用方闭环能运行，但五个候选超长、开发集饱和，不能充当有效数据策略对照的最终验收。

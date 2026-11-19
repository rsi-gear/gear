# curriculum 完整设计实施与验收台账

目标：按 [完整设计](failure-driven-data-operators-spec.zh-CN.md) 实现剩余部分，优先完成正式 harness 搜索接入、候选约束处理与有效对照实验。此台账记录尚未完成的范围，不把基础算子或示例完成等同于整个设计完成。

架构不变：`gear.curriculum` 只保存纯算子及输入输出定义；转换、外部执行、准入、持久化和恢复由现有搜索／训练调用方负责。不增加 curriculum adapters 层。

| 要求 | 当前状态 | 完成所需的直接证据 |
| --- | --- | --- |
| 八个基础算子与轻量输入输出 | 已实现 | 当前 API、Module 重建、边界和算子测试 |
| harness 正式搜索接入（优先） | 已实现并通过离线 provider 集成 | `ReflectiveSearch` 经真实 `Project.refine`、隔离 worker、持久执行器运行；训练与选型范围分离，候选封存与恢复已验证；真实模型接入见下一项实验 |
| 候选约束与有限修订（优先） | 已实现并通过集成 | `PromptConstraints` 与独立 Meta 修订，稳定调用键、有限次数、收费回执恢复；超长文本不截断、不封存；真实实验中仍需核验各组有效候选比例 |
| 有效真实 LLM 对照（优先） | 第一轮已审计；第二、四版中止；第三次切分基线饱和；第五版通过 readiness，完整验收未完成 | 第一轮 1,475 次调用、24/24 有效候选，但随机语言检测影响一次采纳，见[审计](../research/curriculum-harness-2026-11-20/README.zh-CN.md)。[第二轮](../research/curriculum-harness-2026-11-20-v2/README.zh-CN.md)因负例校准不足及错误 JSON 中止；[第三次切分](../research/curriculum-harness-2026-11-20-v3/README.zh-CN.md)训练 8/8 饱和。[第四版](../research/curriculum-harness-2026-11-20-v4/README.zh-CN.md)训练 6/8，通过八个搜索后因 failure 组仅准入一条练习中止；359 次调用已归档，328 条评价重放一致，最终测试未开启。第五版冻结 `139bfc533`，切分 seed 20261124、排除 256 个来源，训练 7/8，四组对照继续中；尚未证明稳定泛化收益 |
| 学习目标策略 | 测量策略、信号与 skill-tree 算子已实现 | frontier/forgetting/rare_action/signal_mix 有跨策略条件与消融测试；`ExtractLearningSignals` 按 CoEvolve 三类布尔条件独立提取；`ProposeSubskills/PlanSkillPractice` 验证树版本、family、失败引用、配额与不可变更新，Module 重建通过 |
| 任务、环境、轨迹／修复、过程问答生成 | 四类合同、生成解析与分类型验证已实现；完整配方待验收 | 环境调用方测试实际执行参考与负例；trajectory 必须有 replay 执行证据，example 走 semantic correctness；真实环境配方另行验收 |
| 练习池筛选 | 纯算子与边界测试已完成 | 语义近邻绑定比较池和完整性；当前策略难度测量；预留探索槽；混合来源配额不足不暗中补齐 |
| `BuildSupervision` | 纯提案已实现并验证，训练接入见下一项 | 成功／前缀证据、修复新捕获 loss 片段、起始条件及 step 前缀配对、synthetic 过程问答；材料授权与标签来源明确 |
| 可信训练构建接入 | 三类新增 builder 已实现；成功／前缀／修复已接现有 SFT 合同；GPU 未验收 | 修复提案映射到新捕获 receipt 边界；`build_offline` 重新验证捕获与 proof，不重编码，保留后缀 mask、模型和 train 来源身份，直接生成既有 SFT updater 数据合同。已验证批次封存、恢复一致性与 CPU 修复后缀梯度；synthetic QA 使用真实 tokenizer。preference 仍为中间数据，DPO updater 未实现 |
| Forge-inspired 外层配方 | IFEval 文本配方已实现并通过离线正式运行集成；真实效果未验收 | [配方与差异](../examples/curriculum-harness/FORGE.zh-CN.md)：同批训练门槛、逐题 front 选择、停滞触发、按 epoch 记忆、四类变异及独立语义验证、扩池后未见优先；三轮真实 CLI/worker 集成验证新 run 准入与恢复。非单 run 动态池或工具环境论文复现 |
| DataEnvGym-inspired 配方 | skill-tree CPU 配方已实现；LLM/GPU 效果未验收 | [运行与适配差异](../examples/training-loop/DATAENVGYM.zh-CN.md)：实际六轮 TrainingLoop、expand/refocus 策略、校准、参数更新、固定训练探针反馈；未见输入 MSE 35156.25 → 0。树／任务／验证记录绑定训练阶段并覆盖三个中断点恢复。该算术结果不证明论文基准上的收益 |
| SENTINEL / CoEvolve 配方 | 待实现 | 各自实际执行入口、可替换组件、专有采样／验证信号与测试；能力不足明确拒绝，不能用空导出冒充支持 |
| DiagEvo 配方 | 专用规则及可恢复记忆流程已实现；完整训练入口仍缺 | [规则与边界](training/diagevo.zh-CN.md)：双置信度、构造／优化分离、调度、晋级及重新激活；轮末提取／检索／语义确认／节点归并已串联，测试覆盖同轮新原因、重叠节点对、未知结果、子调用及提交后恢复、重复 capture 和并发拒绝。尚缺两模型更新、实际诊断与 embedding 后端、原生费用记录、完整外层恢复及真实效果实验 |
| TRACE / Agent-R / Self-Direction 配方 | 待实现 | 实际环境生成、修复／回退、过程问答和相应训练／加载／路由接入；逐项记录与上游的差异 |
| 动态任务池、MCTS/reset、DPO/LoRA/MoE 等后端能力 | 设计第三阶段，尚未验收 | 按具体配方实现合同及后端；涉及 wire/runtime 时同步更新；用实际执行证明相应能力 |
| 设计第 11 节九项验收 | 部分完成 | 每项都绑定具体测试／运行记录，不能以窄范围示例代替整体完成 |

已有探索实验在 [2026-11-19 报告](../research/curriculum-harness-2026-11-19/README.zh-CN.md)。它证明调用方闭环能运行，但五个候选超长、开发集饱和，不能充当有效数据策略对照的最终验收。

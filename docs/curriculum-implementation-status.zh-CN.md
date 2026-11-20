# curriculum 完整设计实施与验收台账

目标：按 [完整设计](failure-driven-data-operators-spec.zh-CN.md) 实现剩余部分，优先完成正式 harness 搜索接入、候选约束处理与有效对照实验。**按 2026-11-20 的范围调整，本版本不做 GPU 训练。** 此台账分别保留本版待办和后续训练路线，不把基础算子或示例完成等同于整个设计完成。

当前结论：**完整设计尚未实现；不做 GPU 训练也不等于所有无 GPU 配方已经完成。** 优先的 harness 搜索、候选约束和固定权重的真实 LLM 对照已完成，但对照未观察到 failure 数据收益。下表中的参考执行、环境探索／校准和轨迹修复配方仍需补齐。

本版继续验收纯算子及输入输出、调用方转换、数据生成与执行验证、恢复与预算、固定权重的 harness 改进。现有 CPU 测试和训练合同保留，不将替身执行算作真实权重训练。

GPU 权重更新、训练节点部署、跨节点训练制品准备、论文规模训练证据保留及 GPU 效果对照移至后续范围，不阻塞本版；无需提供 GPU controller 配置。现有 DiagEvo 训练入口保留，当前不启动 GPU 作业或扩展相应节点基础设施。

架构不变：`gear.curriculum` 只保存纯算子及输入输出定义；转换、外部执行、准入、持久化和恢复由现有搜索／训练调用方负责。不增加 curriculum adapters 层。

| 要求 | 当前状态 | 完成所需的直接证据 |
| --- | --- | --- |
| 八个基础算子与轻量输入输出 | 已实现 | 当前 API、Module 重建、边界和算子测试 |
| harness 正式搜索接入（优先） | 已实现并通过离线 provider 集成 | `ReflectiveSearch` 经真实 `Project.refine`、隔离 worker、持久执行器运行；训练与选型范围分离，候选封存与恢复已验证；真实模型接入见下一项实验 |
| 候选约束与有限修订（优先） | 已实现并通过集成 | `PromptConstraints` 与独立 Meta 修订，稳定调用键、有限次数、收费回执恢复；超长文本不截断、不封存；真实实验中仍需核验各组有效候选比例 |
| 有效真实 LLM 对照（优先） | 第五版完整运行与离线审计通过；未观察到 failure 优势 | [第五版报告](../research/curriculum-harness-2026-11-20-v5/README.zh-CN.md)：冻结 `139bfc533`，四组×三种子×两轮，1,478 次调用，24/24 有效候选，1,424 份评测重评分及采纳决定一致。留出均值 fixed 95.83%、random 97.22%、failure/memory 94.44%；failure 唯一采纳来自无失败时的随机回退，不能归因为定向数据收益。该受限文本实验完成对照验证，未证明稳定泛化提升，也不替代完整设计验收。[第一版](../research/curriculum-harness-2026-11-20/README.zh-CN.md)随机语言检测影响一次采纳；[第二版](../research/curriculum-harness-2026-11-20-v2/README.zh-CN.md)及[第四版](../research/curriculum-harness-2026-11-20-v4/README.zh-CN.md)中止，[第三版](../research/curriculum-harness-2026-11-20-v3/README.zh-CN.md)训练饱和，各版证据分别保留 |
| 学习目标策略 | 测量策略、信号与 skill-tree 算子已实现 | frontier/forgetting/rare_action/signal_mix 有跨策略条件与消融测试；`ExtractLearningSignals` 按 CoEvolve 三类布尔条件独立提取；`ProposeSubskills/PlanSkillPractice` 验证树版本、family、失败引用、配额与不可变更新，Module 重建通过 |
| 任务、环境、轨迹／修复、过程问答生成 | 四类合同、生成解析与分类型验证已实现；完整配方待验收 | 环境调用方测试实际执行参考与负例；trajectory 必须有 replay 执行证据，example 走 semantic correctness；真实环境配方另行验收 |
| 练习池筛选 | 纯算子与边界测试已完成 | 语义近邻绑定比较池和完整性；当前策略难度测量；预留探索槽；混合来源配额不足不暗中补齐 |
| `BuildSupervision` | 纯提案已实现并验证，训练接入见下一项 | 成功／前缀证据、修复新捕获 loss 片段、起始条件及 step 前缀配对、synthetic 过程问答；材料授权与标签来源明确 |
| 可信训练构建接入 | 三类新增 builder 已实现；成功／前缀／修复已接现有 SFT 合同；GPU 验收不在本版范围 | 修复提案映射到新捕获 receipt 边界；`build_offline` 重新验证捕获与 proof，不重编码，保留后缀 mask、模型和 train 来源身份，直接生成既有 SFT updater 数据合同。已验证批次封存、恢复一致性与 CPU 修复后缀梯度；synthetic QA 使用真实 tokenizer。preference 仍为中间数据，DPO updater 未实现 |
| Forge-inspired 外层配方 | IFEval 文本配方已实现并通过离线正式运行集成；真实效果未验收 | [配方与差异](../examples/curriculum-harness/FORGE.zh-CN.md)：同批训练门槛、逐题 front 选择、停滞触发、按 epoch 记忆、四类变异及独立语义验证、扩池后未见优先；三轮真实 CLI/worker 集成验证新 run 准入与恢复。非单 run 动态池或工具环境论文复现 |
| DataEnvGym-inspired 配方 | skill-tree CPU 配方已实现；LLM 效果未验收，GPU 效果列后续 | [运行与适配差异](../examples/training-loop/DATAENVGYM.zh-CN.md)：实际六轮 TrainingLoop、expand/refocus 策略、校准、参数更新、固定训练探针反馈；未见输入 MSE 35156.25 → 0。树／任务／验证记录绑定训练阶段并覆盖三个中断点恢复。该算术结果不证明论文基准上的收益 |
| SENTINEL 配方 | 实际采集、记忆、混合池、正式搜索和三组对照入口已实现；真实搜索效果待验收 | [运行与验证](../examples/curriculum-harness/SENTINEL.zh-CN.md)：既有 47 项定向检查加新增 5 项对照检查，覆盖真实 CLI／worker 的候选修订、训练门槛、恢复、跨 run 扩池、随机输入隔离、统一封存最终测试及缺额时不计算组间提升；实际工具和 native 评分，测试模型为明确替身。[真实采集探针](../research/sentinel-retail-2026-11-20-v2/README.zh-CN.md)：正常样本成功、明确提前结束的诊断对照失败；生成 1 条候选但语义审查拒绝，记忆正常传递、混合池缺额。23 次完成调用、332,115 tokens，另有一次容量失败；导出零新调用重放一致。该控制失败不代表自然失败率或收益，尚无本配方真实搜索效果对照或 mastery 探针，完整 GRPO 训练列后续 |
| CoEvolve 配方 | 三类纯信号已实现；无 GPU 的环境探索与构造配方待实现 | 仍需实际执行入口、可替换组件、专有采样／验证信号与测试；能力不足明确拒绝，不能用空导出冒充支持；GRPO 训练列后续 |
| DiagEvo 配方 | 多轮双模型编排、跨轮预算、暂停／恢复与 CLI 已实现；CPU 两轮链路通过，GPU 效果不在本版范围 | [规则与边界](training/diagevo.zh-CN.md#多轮调用方与命令入口)：两条模型链保留已采纳模型与 optimizer checkpoint，更新后独立构造新题，solver 记忆反馈下一轮且保留首轮频次。实际 compiler／controller／native driver 跑通四个作业，158 项 DiagEvo 回归全部通过；训练 actor、optimizer 状态、评测服务和 SDK 消息仍为替身。[预训练 solver 检查](../research/diagevo-solver-2026-11-20/README.zh-CN.md)未得到有效 boxed 答案；[真实记忆后端](../research/diagevo-memory-2026-11-20/README.zh-CN.md)已有 Codex／BGE 与提交、回执和用量绑定。可靠美元费用尚未计量；真实双模型 GPU 训练与效果对照、跨节点制品准备和论文规模证据保留列后续 |
| DiagEvo 保留题任务交接 | 已实现并接入多轮入口；未运行 Harbor 容器，GPU 列后续 | [封存与准入](training/diagevo.zh-CN.md#保留题任务封存与准入)：复算课程、保持原模型输入、继承 train 来源、排除私有内容；实际 Hitch 编译并封存任务，Gear controller 创建／准入原生 solver 请求。准备、创建及准入返回丢失时复用原制品与作业；评测和已分配本作业预算固定。4 项 Python 集成／verifier 检查及此前 50 项 controller 回归通过 |
| DiagEvo 原生文本 harness | 真实 runner／代理／网关合同已补齐；依赖独立 Hitch 修复 | [依赖与验证](training/diagevo.zh-CN.md#原生文本-harness-合同)：复用 `model-call`，训练／评测按实际 harness 协商能力；工厂提前拒绝工具 harness。真实文本请求经过 Hitch proxy 与 Gear `ExactGateway` 后通过严格 DiagEvo 捕获检查。Hitch 本地提交 `3c03d98` 及可应用补丁已保存；未修改的 0.2.19 包不具备此能力。Gear 46 项 controller 回归、Hitch 20 项 runner／工作图回归通过，仍非真实 Harbor 执行或后续 GPU 训练验收 |
| TRACE / Agent-R / Self-Direction 配方 | 无 GPU 的生成、校准、修复与过程问答组合待实现；GPU 权重训练及相应加载／路由列后续 | 逐项提供实际执行入口与上游差异；已有通用算子不等于完整论文配方支持 |
| 动态任务池、MCTS/reset、DPO/LoRA/MoE 等后端能力 | 设计第三阶段，尚未验收；GPU 训练后端不在本版范围 | 动态池及环境状态恢复按无 GPU 配方的实际需要实现；训练后端保持后续范围，不为本版先扩展节点基础设施 |
| 设计第 11 节九项验收 | 按本版范围部分完成 | 每项都绑定具体测试／运行记录，训练相关条目另行验收；有效对照允许负结果，不能以窄范围示例代替整体完成 |

已有探索实验在 [2026-11-19 报告](../research/curriculum-harness-2026-11-19/README.zh-CN.md)。它证明调用方闭环能运行，但五个候选超长、开发集饱和，不能充当有效数据策略对照的最终验收。

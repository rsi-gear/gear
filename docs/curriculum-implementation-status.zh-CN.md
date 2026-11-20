# curriculum 完整设计实施与验收台账

目标：按 [完整设计](failure-driven-data-operators-spec.zh-CN.md) 实现剩余部分，优先完成正式 harness 搜索接入、候选约束处理与有效对照实验。**按 2026-11-20 的范围调整，本版本不做 GPU 训练。** 此台账分别保留本版待办和后续训练路线，不把基础算子或示例完成等同于整个设计完成。

当前结论：**完整设计尚未完成验收。** 优先的 harness 搜索、候选约束和固定权重的真实 LLM 文本对照已完成，但对照未观察到 failure 数据收益。Agent-R 执行修复与 Self-Direction 无 GPU 过程问答调用方也已补齐；[第 11 节逐项审计](curriculum-acceptance.zh-CN.md)已绑定证据，余下重点是工具环境的真实模型效果对照，不把模型替身通过算作能力提升。

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
| SENTINEL 配方 | 实际采集、记忆、混合池、正式搜索、三组对照及 mastery 探针已实现；真实模型效果待验收 | [运行与验证](../examples/curriculum-harness/SENTINEL.zh-CN.md)：既有 52 项检查加新增 10 项 mastery 和 1 项完整轨迹去重检查，覆盖实际 CLI／worker 搜索、候选约束、三组对照隔离与恢复，以及支持任务全覆盖、当前策略重复测量、未知保留、掌握后停止生成、退化后重新激活与复用记忆；相同失败轨迹的新样本能撤销 mastery 而不抬高频次；实际工具和 native 评分，测试模型为明确替身。[真实采集探针](../research/sentinel-retail-2026-11-20-v2/README.zh-CN.md)：正常样本成功、明确提前结束的诊断对照失败；生成 1 条候选但语义审查拒绝，记忆正常传递、混合池缺额。23 次完成调用、332,115 tokens，另有一次容量失败；导出零新调用重放一致。该控制失败不代表自然失败率或收益。[V3 三组对照尝试](../research/sentinel-retail-2026-11-20-v3/README.zh-CN.md)因 429 及唯一恢复的超时中止：9 次提交、7 份完成回执、127,163 已知 tokens，尚无完整任务评分；离线前缀重放通过。真实模型搜索效果与 mastery 效果仍待验收，完整 GRPO 训练列后续 |
| CoEvolve 配方 | retail 无 GPU 探索与构造调用方已实现；真实模型效果待验收 | [运行与差异](../examples/curriculum-harness/COEVOLVE.zh-CN.md)：从 collector 回执重放完整训练历史；按当前策略、可比任务和 rollout group 提取三类信号，分别消融；成功的 rare/boundary 来源保留原 outcome。多次独立工具探索、轨迹聚合、参考执行、native 正负例校准、语义审查、精确配额混合池及新 run 的正式搜索均有入口与替身检查。恢复复用收费回执、只在新内存库重放工具，未知不变成失败。没有 AppWorld/BFCL 或真实 LLM 收益证据；GRPO 训练列后续 |
| DiagEvo 配方 | 多轮双模型编排、跨轮预算、暂停／恢复与 CLI 已实现；CPU 两轮链路通过，GPU 效果不在本版范围 | [规则与边界](training/diagevo.zh-CN.md#多轮调用方与命令入口)：两条模型链保留已采纳模型与 optimizer checkpoint，更新后独立构造新题，solver 记忆反馈下一轮且保留首轮频次。实际 compiler／controller／native driver 跑通四个作业，158 项 DiagEvo 回归全部通过；训练 actor、optimizer 状态、评测服务和 SDK 消息仍为替身。[预训练 solver 检查](../research/diagevo-solver-2026-11-20/README.zh-CN.md)未得到有效 boxed 答案；[真实记忆后端](../research/diagevo-memory-2026-11-20/README.zh-CN.md)已有 Codex／BGE 与提交、回执和用量绑定。可靠美元费用尚未计量；真实双模型 GPU 训练与效果对照、跨节点制品准备和论文规模证据保留列后续 |
| DiagEvo 保留题任务交接 | 已实现并接入多轮入口；未运行 Harbor 容器，GPU 列后续 | [封存与准入](training/diagevo.zh-CN.md#保留题任务封存与准入)：复算课程、保持原模型输入、继承 train 来源、排除私有内容；实际 Hitch 编译并封存任务，Gear controller 创建／准入原生 solver 请求。准备、创建及准入返回丢失时复用原制品与作业；评测和已分配本作业预算固定。4 项 Python 集成／verifier 检查及此前 50 项 controller 回归通过 |
| DiagEvo 原生文本 harness | 真实 runner／代理／网关合同已补齐；依赖独立 Hitch 修复 | [依赖与验证](training/diagevo.zh-CN.md#原生文本-harness-合同)：复用 `model-call`，训练／评测按实际 harness 协商能力；工厂提前拒绝工具 harness。真实文本请求经过 Hitch proxy 与 Gear `ExactGateway` 后通过严格 DiagEvo 捕获检查。Hitch 本地提交 `3c03d98` 及可应用补丁已保存；未修改的 0.2.19 包不具备此能力。Gear 46 项 controller 回归、Hitch 20 项 runner／工作图回归通过，仍非真实 Harbor 执行或后续 GPU 训练验收 |
| TRACE 配方 | 能力对比、环境生成、固定权重校准及正式搜索调用方已实现；真实模型效果待验收 | [运行与边界](../examples/curriculum-harness/TRACE.zh-CN.md)：规范字典、完整重复标签、覆盖／差异筛选；CPU Docker 实际参考与负例、完整 rollout 分组、有限修订及离线重放。新 seed 的已验证练习经混合池准入新的正式搜索 run，代码和上下文冻结，validation/test 仍用原始 retail；模型替身测试不作为迁移或收益证明。LoRA／GRPO／MoE 列后续 |
| Agent-R 配方 | 无 GPU 的 MCTS、实际修复及正式 harness 消费入口已实现；真实模型效果待验收 | [运行与差异](../examples/curriculum-harness/AGENTR.zh-CN.md)：完整失败来源重放、UCT、公开前缀 critic、共同检查点重建、新后缀执行与原任务评分、`BuildSupervision` 语义范围、恢复和离线重放。修复证据绑定原 train 任务和基线设置，仅投影到已授权 Meta；正式搜索沿用候选约束、训练门槛及原始验证／测试，生成与源采集成本另计。CPU retail 工具为真实执行，模型为替身；`training_eligible=false`，迭代 SFT 列后续 |
| Self-Direction 配方 | 无 GPU 的过程问答、CPU lesson 检索、跨轮复用与原任务重试已实现；真实 LLM 效果待验收 | [运行与上游差异](../examples/curriculum-harness/SELFDIRECTION.zh-CN.md)：基线来源完整重放，类别化 `feedback_only` 生成，分项语义审查和精确去重，synthetic 监督提案；同策略／family 的 MiniLM 余弦检索，命中跳过生成，实际 retry 与 clean-base 回退分别归因，未知不计失败。15 项调用方／检索检查及 1 项真实 CPU MiniLM 检查通过；工具为真实 Tau2 执行，LLM 为明确替身。上下文建议不等同于 LoRA 学习，权重训练及相应加载列后续 |
| 动态任务池、MCTS/reset、DPO/LoRA/MoE 等后端能力 | Agent-R 已实现具体 retail MCTS 与内存状态重建；其余按需要验收，GPU 后端不在本版范围 | 回退只适用于可丢弃的模拟器，不是外部服务 undo 或通用 checkpoint 后端；同 run 动态池及训练后端仍为后续范围 |
| 设计第 11 节九项验收 | [逐项审计](curriculum-acceptance.zh-CN.md)已完成，整体验收仍未完成 | 九项分别绑定具体合同、测试和运行记录；[文本成本／修复／回归补充](../research/curriculum-acceptance-2026-11-20/README.zh-CN.md)从原 V5 证据零调用复算，工具域有效对照与指标仍缺。GPU 训练另行验收；负结果可以完成实验，窄范围示例不能代替整体完成 |

已有探索实验在 [2026-11-19 报告](../research/curriculum-harness-2026-11-19/README.zh-CN.md)。它证明调用方闭环能运行，但五个候选超长、开发集饱和，不能充当有效数据策略对照的最终验收。

最新[工具对照 V4](../research/sentinel-retail-2026-11-20-v4/README.zh-CN.md)在 43 次完整调用、990,092 tokens 后因模型返回空结束动作中止，尚无完整任务评分；没有生成、搜索或最终测试。22 步真实工具／对话前缀、全部模型回执和相同异常已离线重放，五项证据篡改被拒绝。调用层的工具措辞与动作 schema 随后修复，效果仍需新的独立运行验证。

[嵌套动作接口](../research/retail-action-interface-2026-11-20/README.zh-CN.md)已通过真实模型及实际 CPU 只读工具检查，并完成零 SDK 的离线重放；模型侧 1 次完成请求为 27,587 tokens，另 1 次根级 schema 的 400 请求用量未知。修复后 114 项调用方／正式运行检查通过，1 项可选 MiniLM 检查跳过。接口兼容性不替代完整工具效果对照。

不完整轨迹的正式转换已修正为 `scoring_failed, score=null`；训练证据不完整时保留原 harness，并将对照标记不可比。17 项针对性检查通过，覆盖两种训练阶段、恢复无重复提交、正常三组搜索和 TRACE CPU 执行。[工具对照 V5](../research/sentinel-retail-2026-11-20-v5/README.zh-CN.md)使用旧冻结源码，在 221 次完整调用、6,085,278 tokens 后因该合同错误中止；七条任务记录与完整用量已离线复核，未生成数据或打开最终测试。后续显式结束协议与独立生成模型配置已实现，35 项检查通过。[真实结束／生成检查](../research/retail-final-reply-teacher-2026-11-20/README.zh-CN.md)中结束回复通过，生成在两次实际 CPU 只读工具调用后遇到终态 429：7 次提交、6 次完成、82,432 已知 tokens，失败请求用量未知。全部前缀已离线重放；尚无有效生成练习或工具域效果对照。

[工具对照 V6](../research/sentinel-retail-2026-11-20-v6/README.zh-CN.md)已冻结配置并启动独立运行：固定权重、三组等额学习池、相同动作预算、显式结束回复、random/failure 共用生成模型；先前失败尝试全部保留。CPU 预检通过，单独服务检查完成（1 次调用、10,617 tokens）。正式实验仍在运行，尚未形成新的效果结论；终态 API 失败或未知结果停止，不自动重启。

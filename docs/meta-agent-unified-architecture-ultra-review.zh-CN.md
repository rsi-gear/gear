# Gear 统一 Meta Agent / RSI 架构独立审查

审查者：用户指定的 GPT-6 Sol / ultra。主 agent 复核了文件引用与训练职责相关表述；以下评分和结论保留独立审查者判断。

审查日：2026-09-24。对象是工作树 `f715748dad576d3055e4a9eaab21b36015348aee` 上的两份**未实施**提案：[V2 实现方案](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:1)（SHA-256 `bb80cdf421d90fc7a726bd26f76505f795f0f73f42dad146497b122811bfff6d`）与[训练/RSI 补充](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/gear-rsi-model-training-architecture-assessment.zh-CN.md:1)（SHA-256 `9be420c3d059a1f5394e1a1c49adc93b8b5bd95a3e406cd20ae62d48f7b24034`）。训练交付范围按后者覆盖前者：现有 Slime agent-GRPO 兼容接入及独立可编排训练操作进入首版。Campaign 是有身份、可恢复的一次实验运行；recipe 是科学算法，operation 是一次具体操作，角色和 Trainer 是执行组件。

## 判断

| 维度 | 设计分（1–5） | 判断与证据边界 |
| --- | ---: | --- |
| 论文共同范式 | **4/5** | “有来源的观察 → 算法决策 → 版本化对象变化 → 反馈”适合归纳 Harness 搜索、技能积累、权重学习与评价器变化；算法规则留在 recipe，内核没有强塞 GEPA 晋升门槛。它是工程归纳，不是所有论文共享一种优化算法。RHO 无标签偏好、AHE 延迟归因、Evo 批次技能、R1 训练 editor、RQGM 换 evaluator 所需的不同控制流基本被识别。 |
| 可扩展性 | **3/5** | typed refs、命名 BindingSet、固定角色定义与动态模型绑定、journal/outbox、managed-steps/opaque-job 是合适底座；但历史输入、在线任务流、公开 provider 作者接口和评价 epoch 尚缺可冻结的端到端合同。任意 JSON 与 `kind: string` 只能承载数据，不能自动带来科学方法的易实现性。 |
| 易用性 | **2/5** | 模板、`check/run/resume`、step helper 和单 hook API 的方向对；目前均是提案，没有外部开发者从空环境走通。跨语言 hook、Python provider 打包/依赖与真实库 checkpoint 工作量未被样例证明。该分评价**设计的可用性证据**，不是指已有 Gear 产品的使用体验。 |

**可以进入 P0/P1**，条件是明确标为实验性协议并把第一条可运行切片做窄。**不能在现写 P2 退出条件下冻结 SDK v1**：P3 才接真实 Slime 独立训练、P4 才接真实非 GEPA 流程、P5 才完成 GEPA 公共操作迁移。**现在不能对用户承诺“容易扩展”**；可以承诺将以仓库外作者路径验收。新 Campaign、toy、Optuna adapter、四 recipe 和新训练 adapter 均未运行。仓库已有的[单卡训练认证](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/training/certifications/2026-09-10-rtx5090-single-gpu/README.zh-CN.md:1)是 scoped operator attestation，证明旧固定配置运行/恢复链路；其中单样例 `reward=0` 不证明质量提升，也不认证新 Campaign。

## 主要发现（按严重程度）

### 1. SDK 冻结点早于最危险的真实消费者（高；阻塞 API 冻结，不阻塞 P0/P1）

位置：[V2 §11](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:364) 第 366–378 行，尤其第 372 行；[训练补充 §8](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/gear-rsi-model-training-architecture-assessment.zh-CN.md:192) 第 198–203 行。P2 用 Python RHO toy、技能 toy、Optuna adapter 和训练合同反例来“定稿 SDK v1”，而现有 GRPO 的独立 train operation 在 P3、真实 RHO/AHE/Evo 在 P4、GEPA 真解耦在 P5。开发者反例是“Python 算法先训练 editor，再比较临时 Harness overlay”；它需要的样本、模型候选、完成状态和独立选择边界，Optuna ask/tell 不会覆盖。[Harness-R1](https://arxiv.org/abs/2608.02276) 正是目标模型固定、editor 更新且 patch 不被永久晋升的实例。

**不足**：toy 能验证编码/重放，却难以发现真实 provider 的资源释放、产物完整性、角色 credit 和旧 champion 双 writer 的协议差异。**最小修订**：P2 只冻结 wire/操作身份中已经被验证的最小子集；完整 SDK v1 保持 experimental，直到一条实际 Slime 独立 train→候选→外部评价→recipe 选择的路径和至少一条仓库外 Harness recipe 路径通过。无须把所有未来论文方法纳入冻结门槛。**验收**：同一版本公开 API 在仓库外完成上述两条有故障注入的路径，且不修改内核中的算法分支；核对冻结清单中哪些能力确实经真实 provider 使用。

### 2. 独立 GRPO 操作缺少从 Campaign 到现有训练请求的身份映射（高；阻塞首版训练线）

位置：[训练补充 §4.1/§4.3](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/gear-rsi-model-training-architecture-assessment.zh-CN.md:87) 第 87–111、130–136 行与[§5](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/gear-rsi-model-training-architecture-assessment.zh-CN.md:144) 第 146–154 行，**已经明确**外层/内部所有权、增量计量、candidate/no-candidate 分支、legacy champion 的单一 writer，以及新 adapter 须保留产物校验；这些原则本身不是缺口。具体缺口在现有[协调器 `createExperiment/admit`](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/training/coordinator.ts:28) 第 28–79 行：前者创建旧 `experimentId` 与 champion，后者从 `state.champion` 取得 parent，创建 `trainingRunId` 与幂等 key，并由旧 spec 构造 `fixedHarness`、`referenceModelRef`、`recipeDigest`、`datasetSplitDigest`、预算和 checkpoint 兼容性校验；[`validateArtifacts`](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/training/coordinator.ts:327) 第 327–364 行又按这些身份核对模型及 batch ledger。论文反例是 [Harness-R1](https://arxiv.org/abs/2608.02276)：训练应从 `editor.model` 的冻结绑定出发，临时 overlay 的结果只更新 editor，不能靠旧 champion 选 parent 或隐式晋升 patch；[SkillMaster](https://arxiv.org/abs/2605.08693) 则进一步需要新的双阶段 credit provider，不属于当前 GRPO adapter 可直接承担的范围。

**不足**：`TrainInput` 是通用示意，还没有一张公开映射说明新 operation 如何在不借用旧 champion 的前提下生成现有 Slime `TrainingRequest`：哪些 campaign/op ID 稳定对应旧 experiment/run 与幂等 key，`learnerBinding` 的哪一份快照决定 parent 和完整 checkpoint，Harness/reference model/数据切分从哪些冻结引用解析，`recipeDigest`、`datasetSplitDigest` 与 `trainingCompatibilityDigest` 如何保持旧验证语义。也未界定从 coordinator 提取 `validateArtifacts`、预检与资源释放验证的最小可复用组件。**最小修订**：在 P0/P2 给固定 Harness GRPO 纵切列一张字段映射和提交时序；新 adapter 从操作身份及冻结绑定/plan 构造同一个可重放请求，提取并复用现有验证器；独立 evaluation operation 和 recipe 选择在其外，legacy_cycle 保持旧 champion 独占。结果 union 与结算规则沿用补充已规定的 candidate/no-candidate、增量用量、停止阈值语义。**验收**：让 Campaign 的 `target.model=W0` 与某旧实验 champion `Wold` 不同，新 train operation 必须从 W0/匹配 checkpoint 训练，并在重启后复用同一 run/handle/请求摘要；人为改动 recipe/data split/compatibility digest 必须拒绝续训或接纳；旧路径与新路径对模型/检查点/update ledger 的完整性判定一致；no-candidate 保留已有证据与用量、不会改绑定或双计费。既有认证不能直接移作新 adapter 认证。

### 3. “算法自己读历史”没有像角色取证那样的公开合同（高；阻塞首版 RHO 的外部数据路径）

位置：[V2 §3](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:101) 第 138 行的 DecisionContext、[§6.1](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:235) 第 237–256 行的 `job.call('evidence.query')`、[§9](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:333) 第 338 行。角色可分页查证据，但 recipe/纯决策步骤的输入只写“当前投影”和配置；未定义历史 corpus 如何在 admission 时封存，跨旧 evolution/其他 campaign 的 `asOf` 又属于哪个 journal。反例是 [RHO](https://arxiv.org/abs/2606.05922)：算法先从部署留下的旧轨迹挑 diverse coreset，再对同一 baseline 重跑；不能要求一个 LLM 角色代行本应由确定性算法控制的历史选择。

**不足**：可把全部历史预先塞进 JSON 配置并不等于有身份、权限、分页和恢复的研究输入。**最小修订**：定义封存的 `ExperienceViewRef`/历史输入 selector（来源命名空间、快照 cursor、允许投影/标签边界、索引版本），并给 recipe 一个受管理的查询 operation 或只读快照 helper；与角色取证共用授权/receipt。**验收**：从旧实验或部署产生的 100 条带来源轨迹启动独立 RHO campaign，研究侧看不到 grader 标签；选择 10 条后中断恢复，coreset 和成本不变；追加新的外部轨迹不会改变已封存运行的历史视图。

### 4. Evo-Harness 的任务来源边界未说清（中；若首版承诺外部实时流则阻塞）

位置：[V2 §4.3](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:185) 第 187–189 行定义 `tasks.publish`，而[§9](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:333) 第 340 行和[§12.2](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:407) 第 413 行要求技能与 cursor 同步、不重消费。论文 [Evo-Harness](https://arxiv.org/abs/2608.15071) 的一批任务共用旧技能快照，每个顺序到来的新任务通常只有一次执行机会。`tasks.publish` 处理自生成任务，不说明外部任务流在 fetch、seal、ack、失败重连时谁拥有 cursor。

**不足**：如果任务全集在 admission 时已封存，内部 cursor 与 BindingSet 同一提交就足够；当前文档未明确首版 Evo 实例是否只接受这种输入。若是外部实时 queue，内部提交无法阻止上游先前进后崩溃导致丢题或重取。**最小修订**：首版可明确限定为已封存、可重放的 TaskView 顺序；若要承诺实时源，另加 stable task ID、peek/lease/replay/ack 或等效 inspect 能力的 provider，并在批次完成后才确认上游位置。**验收**：对已封存输入，在部分 rollout 和技能/游标提交后杀进程，不重消费任务；若宣传实时源，再增加“取题后、封存前”中断和上游确认位置测试。无可重放能力的源不宣称精确一次消费。

### 5. “改一个现有 recipe 的 Python hook”仍缺跨语言装配规格（中；阻塞易用性承诺与该入口冻结）

位置：[V2 §2.1](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:31) 第 43–55 行、[§7](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:272) 第 276–299 行、[§12.1](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:395) 第 399–405 行。`rho.configure(selection=choose)` 证明 Python recipe 的拟议语法；它没有展示“现有 TS recipe 调 Python hook”时如何在 `gear.json` 引用 Python 函数、传类型化输入/异常、把纯策略决定转成 `policy.decide` operation、封存 wheel/依赖身份并恢复。开发者反例：不改 GEPA TS 实现，只让 Python 包替换其 parent selection；或 Python 作者的策略依赖 `numpy`，本地可跑而干净项目 `check` 漏掉依赖。

**不足**：声称 SDK 自动注册版本化 component，但 Python worker 的公开方法只列 `describe/initialize/reduce/shutdown`，没有可审查的 hook 导出/绑定规范。**最小修订**：recipe manifest 声明 hook 名、输入/输出 schema、同步或受管理操作语义与失败策略；配置以 `module:export` 和锁定环境引用组件；SDK 生成适配与版本摘要，不让用户手写 RPC。**验收**：干净仓库外项目中，安装 TS GEPA recipe 与 Python SDK，只改一个 Python 选择函数即可完成 `init/check/run/resume`；类型错、缺依赖、未注册 hook 都在 check 或明确运行错误中暴露，恢复不重复调用已提交的选择。

### 6. 新 Python provider 的公开扩展面仍只有义务，没有作者工具链（中；阻塞“容易新增训练/跨语言组件”的泛化主张）

位置：[V2 §5.1](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:193) 第 208 行、[§7](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:272) 第 274、291–299 行、[§11.1](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:380) 第 384–392 行；[训练补充 §6](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/gear-rsi-model-training-architecture-assessment.zh-CN.md:156) 第 175 行称新 loss 作者写 Python trainer adapter。反例是 [Self-Rewarding LM](https://arxiv.org/abs/2401.10020) 的 DPO 偏好对，或 [OPSD 本地笔记](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/训练/Self-Distilled Reasoner On-Policy Self-Distillation for Large Language Models.md:35>) 的 teacher/student dense target：科学作者需要新样本 schema、新 loss 和 checkpoint，理应写 provider，却不应重写 Gear 的幂等、artifact CAS、RPC 和计费。

**不足**：公开 Python SDK 只描述算法 worker；`submit/inspect/cancel` 是 provider 义务，未定义仓库外 Python provider 的注册、能力握手、schema/codec 发布、打包与依赖隔离、跨语言调用和 testkit。把这些都放进一个“adapter 基础设施”模板会使表面上的用户算法文件数失真。**最小修订**：公开 provider SPI 与 SDK helper/testkit，至少包含 typed manifest、输入/结果 union、artifact/checkpoint codec、幂等及用量回执、进程/环境身份、重启 inspect；训练具体 mask/reward 由 provider schema 验证，内核只通用准入与对账。**验收**：仓库外 Python 包实现一个 fake DPO/SFT provider，不 import Gear 私有 registry；安装后可由 TS 或 Python recipe 调用，提交回包丢失和 no-candidate 中断均可恢复；报告用户业务代码、adapter 基础设施和依赖安装步骤。

### 7. 评价器共演化的测量可比性尚是建议文字（中；不阻塞首版，阻塞“通用 RSI 已支持”）

位置：[V2 §4.1](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v2.zh-CN.md:144) 第 149–167 行有任意版本 slot；[训练补充 §7](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/gear-rsi-model-training-architecture-assessment.zh-CN.md:177) 第 179–190 行**建议** `EvaluatorRef`、`EvaluationRecord` 与 `evaluationEpoch`，但现有 `AlgorithmEvent`/operation/报告合同及 P0–P6 验收没有完整指定比较键和不兼容分数的处理。反例是 [RQGM](https://arxiv.org/abs/2606.26294)：epoch 内冻结 evaluator，在 anchor 上挑 challenger，换代后仅失效依赖旧 evaluator slot 的 utility record；[Self-Rewarding LM](https://arxiv.org/abs/2401.10020) 则使同一模型每轮兼任 policy 和 judge。只让 `judge.model` 改 digest，旧分数仍可能错误进入同一全局排名。

**不足**：版本身份是必要条件，不是可比性规则；哪个历史记录可重评、哪个只能作为当时选择依据，需要机器可查的条件。**最小修订**：在通用测量记录中加 evaluator/rubric/task view/subject bindings/采样条件的完整身份与 `comparisonEpoch`；公共比较 helper 对不兼容记录拒绝直接聚合，重评产生新记录且保留旧选择依据。anchor 选拔、selective erasure、统计规则仍属 recipe。**验收**：toy RQGM 切换 judge 后，旧 utility 不参与新 epoch 排名，客观 anchor 不被删除；同一 artifact 的旧/新 judge 配对重评可审计，缺桥接证据时报“不可比较”而非显示净增分。此能力可在首版后实现，不应反向迫使 P1 建通用评价器演化引擎。

## 三条作者路径的实际摩擦

1. **现有 recipe 只改一个策略 hook。** 理想路径是安装 Gear CLI、相应语言 SDK、现成 recipe，模板生成配置与 toy profile，然后只写 `choose`，运行 `check/run/resume`。简单 RHO 配置可遮住 Campaign/journal/BindingSet；用户仍要选数据视图、执行 profile 和依赖环境。若 recipe 原实现为 TS、hook 为 Python，缺第 5 项的 manifest/组件装配，仍需理解 RPC 细节。当前 `rho.configure` 只是拟议示例；不能计为已验证“只改一文件”。
2. **Python 作者写新循环或接真实库。** `@task/@decision` 加稳定 key 的 parallel 能承载 RHO/AHE 类动态循环；作者需维护业务 state schema、正确区分小结果和 artifact ref，并把所有有副作用的工作表达为 operation。Optuna ask/tell 的持久 checkpoint、sampler 状态、环境锁、trial→operation 对照、`inspect` 都是 adapter 工作，不能隐入“算法只写两步”的文件数。封闭 `.optimize(...)` 只可 opaque-job；这是诚实的首版取舍，不是 bug。简单单次测量算法应有模板/SDK helper 隐藏 Campaign 细节，但后台仍必须创建 Campaign 身份。
3. **开发新训练或跨语言组件。** 训练作者除算法本身，还需样本/训练计划与 reward/mask schema、模型与续训 checkpoint 的不同身份、真实 token 条件（如 GRPO）、依赖锁和 GPU 能力、幂等/取消/用量回执。新 loss/new role credit 是新 provider 工作，非改配置即可支持。现有 Slime 的内部 checkpoint 恢复可继续使用，不依赖首版不提供的 managed-children；但公开 Python provider SPI 与测试 helper 尚未定，不能承诺第三方接入轻松。

## 覆盖边界

下表按**提案落实后**的首版公共能力判断；当前新 SDK/Campaign 均未实现。“可表达”不等于复现论文结果。

| 方法/场景 | 分类 | 精确含义 |
| --- | --- | --- |
| GEPA、RHO、AHE、Evo-Harness | 原生公共操作可表达 | 各自保留 recipe 控制流；需要完成历史输入、Evo 可重放任务序列和真实 provider 验收。GEPA wrapper 只能作迁移中间态。 |
| DGM 开放 archive、RRSI 非单调选择、Meta-Harness 多候选搜索 | 原生公共操作可表达 | archive 与 selection 属 recipe；通用内核不设严格增分/唯一冠军。尚无具体 recipe/真实测试。 |
| 现有固定 Harness Slime agent-GRPO | 需要训练 adapter，但不改通用内核 | 旧闭环已有 scoped 认证；首版需 legacy_cycle 和可独立编排的真实 train operation 两条分别验收。 |
| Harness-R1、SkillMaster、Socratic-SWE、TTRL、Self-Rewarding LM、OPSD、Absolute Zero、EnvHarness | 需要新 provider/样本合同，但原则上不改内核 | 前三者涉及 editor/双 phase credit/梯度对齐；TTRL 共识 reward；DPO、dense distill、任务生成与环境 wrapper 各有物理/数值能力。toy binding 只能证明状态可表达。 |
| 外部封闭 `.optimize(...)` 与 `training.legacy_cycle` | 只能 opaque-wrapper | 可作业级 inspect/cancel/checkpoint（若库或旧 trainer 自带），不能推断内部 token credit 或任意 callback 恢复。 |
| 运行中任意子调度、未受控自修改、完整 RQGM 评价器共演化 | 当前边界不支持 | managed-children 与自动 continuation 明确延期；RQGM 只有拟议评价身份/epoch 规则，尚无可执行比较合同。 |

## 复杂度与落层建议

第一条纵切建议明确为**仓库外 Python RHO 最小实验**：输入封存旧轨迹视图；选 coreset；固定 baseline 产生平行 rollout；作成对软偏好；条件选择 Harness；中断后复用相同历史、操作及证据。它可用 toy provider 先证实高层作者路径与 journal，但 P2 的冻结判断还要补固定 Harness GRPO 的真实独立训练操作。不要为了第一条切片先建设任意 DAG、managed-children、动态图数据库或普适 evaluator 演化引擎。

公共 core 只保留身份/版本引用、授权与数据暴露、持久操作及预算对账、测量条件的不可变记录；RHO coreset/DPP、AHE verdict、Evo 批次整理、GRPO 是否采用候选、RQGM 的 epoch/anchor 策略归 recipe；rollout、role、task stream、训练与评测的实际执行及专门数值校验归 provider；step decorators、hook 装配、样本/schema helper、checkpoint/inspect 测试夹具归 SDK。这样的分层让一个简单算法使用模板即可运行，同时保留研究者进入低层 reducer 的通道。

## 最高优先级修订

1. 把 P2 的“SDK v1 定稿”改为“最小 wire 合同暂定”；明示真实 GRPO 独立操作与仓库外 Harness recipe 是冻结条件。
2. 画出并验收固定 Harness GRPO 的具体 operation 链，抽出旧协调器中的产物/账本/释放校验，明确 legacy_cycle 与 Campaign 的单一写者边界。
3. 给 RHO 历史视图一个最小来源合同；明确首版 Evo 使用已封存可重放序列，或补外部实时流的确认协议。
4. 补齐 Python hook 与 Python provider 的 manifest、schema、包/环境引用和测试 helper；请独立开发者按教程分别走通策略覆盖与新 provider 样例，并报告实际摩擦。
5. 把评价条件/epoch 的机器可读合同列为后续通用 RSI 里程碑；在实现前只声称“能保存版本化 evaluator 产物”，不声称支持完整共演化比较。

## 阅读与执行范围

完整阅读两份主文档（441/242 行）；核对两篇 RSI 总引的分类、控制对象与验证信号，选择性阅读 RHO、AHE、Evo-Harness、Harness-R1、SkillMaster、Socratic-SWE、TTRL、Self-Rewarding LM、Absolute Zero、RQGM 的本地**单篇笔记方法段**，不是重新通读所有原论文。在线仅核对上述关键 arXiv **摘要页**的论文身份/核心机制，不把本地笔记或摘要核对称为论文复现。只读检查了 `src/training/types.ts`、`schema.ts`、`coordinator.ts` 与公开单卡认证，未读取私有 GPU 审计。未改仓库/用户笔记、未装依赖、未运行 toy、评测、训练或测试；审查者仅将本报告写入 `/private/tmp`；主 agent 随后将报告归档到 worktree 的 `docs`，已有方案和源码保持原样。

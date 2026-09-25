# Gear Meta Agent 重构方案：独立严格审查

- 审查日期：2026-09-24。
- 独立审查者：GPT-6 Sol，推理强度 ultra。
- 主任务已复核主要发现及引用。评级是设计审查判断，不是运行实验分数。
- 本次仅新增审查报告；被审方案保持原样，尚未按本报告修改，未实现功能。


审查基线：f715748dad576d3055e4a9eaab21b36015348aee。实施方案为 459 行、SHA-256 2be644581a9348c5d34ebf7b07572072b228db6a196a92b1d0e14e88ad1498e4；架构文档 SHA-256 ce0ebe433389f3d9fda0c5bdb4097207c274f81b798011ddfd187831ea482ce4。下文“已有”仅指该 commit 的代码；方案中的 SDK、Campaign V1、通用 AgentJob 和四个新 recipe 均尚未落地。本次只审查文档和必要源码，没有实现功能或运行实验。

## 总评

| 维度 | 评级 | 判断 |
| --- | --- | --- |
| 统一范式与论文差异 | 良好，附条件通过（4/5） | “有来源的观察 → 决策 → 持久状态变化 → 后续反馈”符合[总引第 17–61 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Harness Evolution Papers Comparative Review.md:17>)的比较框架。方案明确把 GEPA 放入 recipe，分开 artifact、测量、archive、active binding、final selection 和部署；RHO 无标签、AHE 延迟归因、Evo 批次技能更新没有被硬塞进四阶段晋升。这个方向正确。尚不能说已经统一：公开 bundle 和角色绑定仍偏向固定 harness/model 搜索，完整算法接口也还未验证。 |
| 可扩展性 | 中等偏好，但 V1 合同需修改（3/5） | 显式 reducer、命令/事件、provider registry、不可变引用和恢复语义能表示多种流程；训练、环境和算法自修改不应要求首版实现。但固定的 bundle 字段、冻结角色模型、嵌套作业的子操作合同和角色内历史查询未明确，若按当前草案直接冻结 V1，会把未来方法推回专用适配器或改协议。 |
| 易用性，尤其 Python | 尚未证明，当前纸面体验中等偏弱（2.5/5） | Python 可以拥有完整循环，worker 恢复边界也诚实；已有 Python 子进程桥和训练代码只是专项实现，并非通用 SDK。研究者从一篇算法到首次运行仍需选择数据/角色/provider、把每个异步步骤拆成持久事件、写可序列化状态、处理外部库检查点和能力声明。Python wheel 在 PR 2P、完整 RHO 在 PR 6、发布模板在 PR 8；真实库适配尚未成为 PR 1/2P 的退出条件，缺少前置样例验证这条路径。 |

我不同意把“有 Python SDK”和“Python 研究算法容易接入”划等号；也不同意把所有十九篇论文的训练、环境、自修改能力提前做完。首版最合理的成功标准是四个明确承诺的流程真实跑通，并以几个未来方法的反例证明协议不封死它们。

## 按严重程度排序的 findings

### F1｜高｜必须在 V1 合同定稿前修改：冻结角色实现与变化中的模型版本没有分开

证据：[方案第 18 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:18)、[第 146–152 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:146)、[第 224 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:224)、[第 257 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:257)同时写“角色模型冻结”和单一 model 的 ExecutionBundle；[架构第 54–56 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-architecture.zh-CN.md:54)却把模型 checkpoint 列为可变化的状态。具体反例：[SkillMaster 第 44–82 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/SkillMaster Toward Autonomous Skill Mastery in LLM Agents.md:44>)一套 policy 和技能库共同更新；[Socratic-SWE 第 42–76 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Socratic-SWE Self-Evolving Coding Agents via Trace-Derived Agent Skills.md:42>)的 generator/solver 共用且逐轮更新模型；[Harness-R1 第 125–139 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Harness-R1 Learning to Edit Executable Runtime Harnesses from Agent Failure Trajectories.md:125>)则只更新 engineer，target 固定。把 role.model 一律视为 campaign 启动时固定，无法在同一训练 lineage 的下一次调用中使用新 checkpoint；把所有模型塞进一个 model 字段又混淆 target、engineer、distiller 和 verifier。

最小修改：冻结 role 定义、权限、provider 实现和允许的模型来源；把每次 operation 实际使用的模型/技能/环境版本作为有名称的动态 binding 引用，连同角色、采样与运行身份写入命令和结果。训练更新只改变获准的 binding，不改变被冻结的角色实现或实验协议。V1 不必实现 GPU 训练，但要给这个状态转换留出可验证的合同。

### F2｜高｜必须在 V1 合同定稿前修改：ExecutionBundle 的固定槽位仍带 GEPA/Harness 中心假设

证据：[方案第 134–159 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:134)把 harness 和 model 设为必需、skills/memory/environment 为固定可选字段；[架构第 121–136 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-architecture.zh-CN.md:121)同时承诺任意类型 artifact、组合版本和“一个方法只用实际更新的部分”。反例：SkillSmith 的 skill+tool 原子修改包和 EnvHarness 的环境 wrapper 需要独立且可同时绑定的版本；Socratic 的生成课程与训练 checkpoint 也不是一个 harness revision。仅对既有轨迹排序的 verifier 不需要产生新的 target bundle，R1 的临时 overlay 不应自动变成持久 harness 候选。如果该接口是公共组合类型，这些方法需制造无意义的固定字段；如果它只是编码代理 rollout 的便捷视图，文档还缺少真正的公共组合类型。

最小修改：明确 ExecutionBundle 是否只是编码代理 rollout 的便捷视图；公共组合版本则采用有 schema 的命名 slot 映射，例如 target.harness、target.model、editor.model、skillLibrary、toolSet、trainingEnvironment、curriculum。哪些 slot 必需由具体 provider 声明。每次测量封存实际 materialized slot 集合及适配器身份。多来源 lineage 和 bundle 原子提交的方案可沿用，无需新增论文专属公共字段。

### F3｜高｜必须在 V1 能力承诺前划清边界：长时或嵌套 Python 作业的子操作身份与预算未定义

证据：[方案第 107–120 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:107)只给顶层 OperationIntent；[第 202–216 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:202)按顶层操作预留/结算；[第 435、445–451 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:435)允许外部 Python 库自行驱动多个模型请求，却把稳定子 ID、父预算和断点映射留给独立 adapter。R1 每组 8 个 overlay 需分别调用冻结 target 并回传组内奖励，[论文笔记第 121–139 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Harness-R1 Learning to Edit Executable Runtime Harnesses from Agent Failure Trajectories.md:121>)；SkillMaster 要把两类 token 奖励归到同一次参数更新。若把整个 optimizer 作为单一黑箱 operation，它可有作业级恢复，却不能自动获得每个内部模型调用的预算、可见性和训练 credit；若研究者自行开子请求，公共 outbox 看不见它们。

最小修改：V1 能力表先区分作业级不透明模式与细粒度可观测模式；前者不承诺内部请求预算和断点恢复。若继续承诺 callback 库的内部请求由 Gear 逐一记录，协议就需定义可选的 parent operation、稳定 child key、子事件/检查点 cursor、预算向父级汇总和结果归属，并用 toy Python provider 做丢回复/重启验收。实际 R1/SkillMaster trainer 后续实现；也可以先把细粒度 callback 支持明确延后，避免为首版强做嵌套内核。

### F4｜中高｜必须在首版角色任务落地前补足：Meta/AgentJob 缺少按历史时点、按权限按需取证的合同

证据：[方案第 116 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:116)只给 reducer 一个 evidence-query operation；[第 224–235 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:224)的 AgentJob 有 input refs 和笼统 job.call，但没有在执行中的查询方式、查询时点或回执。[架构第 153–159 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-architecture.zh-CN.md:153)要求 as-of 历史。[Meta-Harness 第 76–101 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Meta-Harness End-to-End Optimization of Model Harnesses.md:76>)的 proposer 可主动下钻全部候选源码和原始轨迹；[AHE 第 76–85 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Agentic Harness Engineering Observability-Driven Automatic Evolution of Coding-Agent Harnesses.md:76>)先看 overview，再按需看逐题报告和 raw trace。只预先塞一包 refs 给 Agent 会让论文关键的交互式调查退化成预压缩材料，也会使大轨迹上下文与成本失控。

最小修改：为 job.call 或角色工具明确定义只读 evidence.query，参数含 as-of journal cursor、对象/任务范围、页大小和投影级别；每次返回封存引用与查询回执，按 role readScope 和数据协议授权。V1 可仅做文件/轨迹分页，不必建图数据库或通用 SQL。AHE 范例须实际让角色从 overview 下钻到一条原始轨迹。

### F5｜中｜必须修改文案和验收威胁模型：数据可见性保证超出本地受信任 Python 进程的隔离能力

证据：[方案第 167–169 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:167)称插件拿不到未经授权的物理路径；[第 352、359 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:352)要求角色看不到禁用标签、RHO 完全无真实标签；但[第 439 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:439)正确承认同用户本地 Python 代码没有文件/网络沙箱。RHO 的科学设定是优化阶段没有标签，[笔记第 43–55 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Evolving Agents in the Dark Retrospective Harness Optimization via Self-Preference.md:43>)；如果标签文件恰好在同一 OS 身份可读目录，投影测试不能证明恶意或意外直接读取不可行。

最小修改：把保证写为“受管理 API 和由 Gear 托管的角色工具不泄漏标签”，并要求 label 文件不挂载进 RHO 工作区；对可信本地插件明确是合作式协议边界。若未来要防不受信任算法读取物理标签，另需进程/文件系统隔离。验收分别测试 API 投影和物理工作区隔离，不把前者冒充后者。无需把论文的独立 final test 强制成每个算法的门槛。

### F6｜中｜必须在冻结协议前明确，实际功能可后续：算法自身版本切换与“新代码建新 campaign”相冲突

证据：[方案第 18、257、339、354 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:18)一边要求新代码新 campaign、漂移不得继续，一边将 Gödel 类算法版本切换放入后续批次；[架构第 181–185 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-architecture.zh-CN.md:181)要求显式分支或切换事件。[Gödel Agent 第 54–63 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Gödel Agent A Self-Referential Agent Framework for Recursively Self-Improvement.md:54>)会修改 improvement routine 后递归调用新代码；DGM 则故意冻结外层算法，[笔记第 45–61 行](</Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Darwin Gödel Machine Open-Ended Evolution of Self-Improving Agents.md:45>)。若只用 campaign 启动时的一份算法 digest，无法区分允许的自修改与危险的磁盘漂移。

最小修改：明确后续自修改是“从已提交状态创建带父指针的新 campaign”和状态迁移，还是同一 campaign 内的显式 implementation-switch 事件；两者均应记录新旧实现和迁移函数身份。首版仍拒绝静默替换，不需要实现运行时 monkey patch 恢复。

### F7｜中｜必须调整验收顺序：Python 研究代码复用的关键试验安排得太晚

证据：[方案第 319–330 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:319)先建协议、内核、artifact、job、GEPA；完整 Python RHO 在 PR 6、发布打包在 PR 8。[第 369、445–451 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:369)虽承诺至少接一个已有 Python 库，却未选具体库、callback 或 ask/tell API，也未将真实库 spike 列为 PR 1/2P 的退出条件。由此实施顺序推断，发现接入问题可能偏晚。当前 [Python gear-training 的包配置](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/python/pyproject.toml:5)是专项训练桥；[ModelTrainingSpecV1](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/training/types.ts:183)固定 harness、Slime、agent-grpo；[llm-verifier 桥](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/selection/llm-verifier.ts:177)是单次子进程调用。这些不能证明普通研究库可直接接入。

最小修改：PR 1/2P 期间就选定一个真实、可安装的 Python ask/tell 或 checkpoint 库，做仓库外小型适配 spike：一次库迭代触发 Gear operation、保存库状态、重启后继续，并报告库原生 API 的限制。先用 toy provider 即可；PR 6 再做完整 RHO。将这个 spike 作为冻结 V1 协议前的退出条件。若某库只有封闭的 optimize() 栈，应明确只支持作业级恢复，不要求为演示而改写其内部。

### F8｜低到中｜Python 发布前处理：stdout 协议容易被研究库日志污染

证据：[方案第 429–431 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan.zh-CN.md:429)采用 stdio JSON，普通 print 转 stderr，原生依赖可能在 Python 层重定向之外直接写 fd 1；这会让“import 现有研究代码”在运行时因日志失效，而不涉及算法本身。

最小修改：若 PR 2P 的真实库试验遇到该情形，把协议放到专用管道/文件描述符或本机 socket，stdout/stderr 用于日志；若维持 stdio，模板、check 和错误提示应明确不支持哪些库输出。此项是 Python 发布体验问题，不需现在建设远程 worker 集群。

## 方法覆盖矩阵

“可表达”指按方案及上述最小合同修正可表示，不是当前已实现或已复现论文结果。论文事实以[架构阅读地图第 20–44 行](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-architecture.zh-CN.md:20)和所列单篇笔记为边界。

| 方法 | 必须保留的差异 | 方案状态与审查结论 |
| --- | --- | --- |
| 现有 GEPA（基线算法） | 父代、scope、阶段、archive、promotion 的旧语义和恢复 | 现有 search 可运行；新 GEPA recipe 仅计划于 PR 5。以行为/预算/身份对照迁移，旧运行时不可默默换新实现。 |
| Meta-Harness | 任意历史候选与原始轨迹可按需查；Pareto 与最终选择分开 | 状态和 archive 可表达；角色内交互式历史查询缺合同（F4），后续 A。 |
| Self-Harness | 同模型不同角色、并行小 edit、双切分门控、兼容合并另测 | role 概念和 merge 谱系可表达；merge provider/具体 gate 后续 A，不能继承单 patch 分数。 |
| AHE | 下一轮评价上轮版本、manifest 预测、文件回滚、best measured | 首版 PR 6 计划覆盖；需 F4 的分层证据下钻。 |
| HarnessFix | HTIR、implementation anchor、allowed/forbidden 修复面 | 可作为 evidence/analysis 与 workspace-edit 插件；非首版必做。 |
| RHO | 完全无标签、固定 baseline 的成对软偏好、单轮严格正值选择 | 首版 PR 6 Python 范例方向正确；须守住 F5 威胁模型。 |
| LLM-as-a-Verifier | 只评价/排序现有轨迹，不产生 Harness lineage | 现有专项 Python bridge 不等于通用 feedback provider；可单独接入，logprobs 缺失需明确拒绝或改名。 |
| Harness-R1 | 临时 overlay 组、同批全题奖励、只更新 engineer | 后续 C；需要 F1/F3，不能把每个 patch 作为冠军候选。现有 agent-grpo backend 不能直接称为 R1。 |
| Evo-Harness | 在线任务流、批内技能快照、批末整理与新版本挂载 | 首版 PR 7 计划覆盖；必须核验真实 Target 注入和 cursor 原子提交。 |
| DGM | 低分有效节点仍可繁殖，外层演化器固定 | 通用 reducer/archive 可表达，后续 A；不要套唯一 champion gate。 |
| Gödel Agent | 改 improvement routine 后用新代码递归继续 | 后续 D；F6 尚需定义实现切换或 campaign fork 边界。 |
| RRSI | 历史账本、成本/新颖性分支准入、噪声带内降分 | 通用状态/反馈可表达，后续 A；不应有全局严格增分规则。 |
| HarnessDev | Creator 自主编排，控制器固定评测和预算 | 后续 D；受限 planner 命令可接同一内核，不需首版实现。 |
| RSIAgent | 并行练习同快照、顺序合并记忆、目标暴露 | helper 与 journal 原理可表达，环境 reset/人机角色后续 B。 |
| EnvHarness | 环境 wrapper 而非 Agent harness；原始测试环境分离 | F2 的具名环境 slot 必要，环境生成 provider 后续 D。 |
| SkillMaster | 技能库和共享 policy 联合更新、分阶段 token credit | F1/F3 必要；训练/reward 实现后续 C。 |
| SkillSmith | skill+tool 原子包、组件交互效用、Pareto 分支 | F2 的 toolSet/skillLibrary 组合必要；效用算法后续 A。 |
| Socratic-SWE | 生成课程、验证与梯度对齐、generator/solver 同参更新 | F1/F2/F3 必要；梯度算子和 trainer 后续 C。 |
| Learning from Failure | 人工选择可持久等待，不能隐式自动化 | waiting 状态有方向；Human operation/权限后续 B。 |
| Experience Graphs | 保留事件/来源，按当时视图查询研究经历 | 对象日志可作底座；F4 的 as-of 查询和投影必须有合同，不要求首版图数据库。 |

## 对 Python 作者的实际路径与验收建议

以 RHO 研究者为例，纸面到运行至少要：在仓库外建 venv、安装 wheel；生成或编写 Python 算法；给 coreset、三次 baseline rollout、诊断、并行目录编辑、候选 rollout、pairwise preference 和正值选择分别定义状态/operation/event；配置数据投影、角色、provider、初始 bundle、预算与实验协议；为自带库接 callback 或 ask/tell 并保存其检查点；再跑 check、toy 测试、serve、campaign.start、重启恢复及报告核对。方案减少了 TS glue 和数据库工作，但这条路径仍复杂。预设 recipe 的价值应以“只替换一个 Python 策略即可跑同一流程”来证明，完整算法则应以“可以改步骤顺序且恢复正确”来证明。

建议的可执行验收：

1. **外部 Python 新手路径**：干净 venv、只安装公开 wheel、用 init 生成 RHO 模板，只在一个 Python 文件改 coreset 或选择策略；check 显示生效 hooks/能力，toy 全程运行、状态/证据可读，不导入仓库内部模块，也不写 TS glue。
2. **完整非 GEPA 路径**：独立 Python 包实现小型流式技能算法，批内 snapshot 与批末 cursor 同时提交；故障注入后结果一致。这样可测到非候选、非冠军流程。
3. **真实库复用路径**：选定并写明一个现成 Python ask/tell 或 checkpoint 库及其版本；薄适配触发 Gear 的至少两个异步外部操作，重启后继续；另用封闭 optimize() 库展示仅作业级恢复，报告实际边界。
4. **跨语言与计费**：同一 toy 算法的 TS/Python 语义决策一致；一个 Python 子作业在迟到响应、结果丢失、进程崩溃后不重复计费；硬预算仅在 provider 确实可强制时显示为硬限制。
5. **研究证据**：RHO 的 ranking 不见标签，AHE 的 verdict 绑定已执行 commit，Evo 的 Target 实际读到该批 skill snapshot；报告分开“研究者看到的软信号”“真实 grader”“未测量”“无独立 final test”。

## 交付判断

PR 0 保留旧实现身份和恢复样本有必要；现有 [searchImplementationIntegrity](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/search/identity.ts:4)按实现字节闭包哈希，不能轻率挪动旧代码。PR 1/2 设计独立协议与内核也合理。风险在于 PR 5 先接 GEPA，完整 Python RHO 在 PR 6、非候选 Evo 在 PR 7，发布打包在 PR 8；真实 Python 库 spike 未列为 PR 1/2P 退出条件。由这个顺序推断，接入问题可能到公共抽象已较昂贵时才被发现。建议在 PR 2/2P 增加两个薄垂直样例——无标签 RHO 的 toy 流程、非候选的 skill 流程——并提前完成真实 Python 库 spike；它们可以使用 toy provider，不需启动模型或 GPU。保留四个 recipe 作为首个产品里程碑，但不要让九个批次成为一次不可验收的大发布。

本轮必须修改的是 F1–F2、F4–F5、F7 对应的合同或验收顺序；F3 至少须明确 V1 的可观测/恢复承诺，细粒度子操作可选择后续实现；F6 只需现在作出身份边界决定，功能以后做；F8 由 Python spike 的实测决定。DGM/R1/SkillMaster/Socratic/Env/Gödel 的完整科学算子和真实实验均可后续实现，不能以它们尚未运行否定首版，也不能把“协议将来容得下”表述成“现有 Gear 已支持”。

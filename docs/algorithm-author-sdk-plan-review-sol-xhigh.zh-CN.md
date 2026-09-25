# Gear 算法作者 SDK 方案独立评审

审阅模型：GPT-6 Sol，reasoning effort：xhigh。日期：2026-09-25。

评审时源码 HEAD：`a5011e879e11586c9b62da2ba894944d61fb7541`；方案文件 SHA-256：`78b4649acc242efefc5416c4a93b8777953ea36efd0b77784b74de184da178c1`。方案和源码未因本次评审而修改。

**结论：需要修改后实施。** 用普通 `async` Python/TypeScript 写科学流程、由受管理步骤承接副作用，并复用现有 Campaign，是正确方向。它保留了现有的持久操作身份、预算和恢复机制，也没有把不同论文强压成一种贪心搜索。当前草案仍缺少三个在实施前必须写清的合同：**可恢复的预算/时间观察如何与决定原子提交；新算法如何在不修改 Gear 核心的前提下装配真实宿主；多版本种群、archive 和跨 epoch 产物如何作为一等作者输出持久化。** 这不是要求第一版实现所有论文，而是避免第一版接口把后续算法锁成单一 `best Agent → propose → evaluate → select`。

评审对象是 [作者 SDK 草案](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan.zh-CN.md)。下文以“确定缺口”标记由现有代码直接证明的尚未落地合同，以“PoC 风险”标记必须实验验证、目前不能断言不可行的实现问题。草案在第 3 行明确是设计而非现有接口；因此我不把未来能力尚未实现本身算作缺陷。

## 按严重度排序的可行动问题

### 高：持久观察缺少合法的提交边界（确定缺口）

**位置：**草案 §4.2–4.3，第 142–155 行，尤其“预算观察与控制记录由同一 Campaign 决定封存”。现有 [contracts.ts:129](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/contracts.ts:129) 只把 `BudgetSnapshot` 交给当前 `initialize/reduce`；[engine.ts:243](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:243) 每个决定都会重置操作批次，而 [engine.ts:259](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:259) 拒绝既无 operation 又无 projection 的非终态决定。[engine.ts:605](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:605) 仅在上一批全终态后给下一次 `reduce` 新预算快照。现有内核没有“只观察预算/时钟并提交其值”的入口。

**失败场景：**一个算法在第 3 轮根据 `await ctx.budget()` 决定再评一个候选；崩溃后从入口重放时，Campaign 的花费/时钟已向前推进。若重读当前值，旧分支会改变，误报非确定性，或更糟的是到达不同新前沿。`ctx.now()` 同理；在 `unknown` 外部操作等待期间，时钟更不能被当作普通纯变量。现有 `budgetSnapshot` 是当前边界的只读视图，不等于可重放的历史观察。

**最小修正：**在 A0 前定义一种受管理 `observe` 控制步骤：稳定地址、观察种类、冻结的值、所依据 Campaign 账本/时钟版本、结果 schema 与提交事务。它可以实现为内核控制记录或有明确无副作用语义的内部 operation，但必须说明如何通过第 259 行的非终态准入、何时开始预算时钟、怎样避免观察改变原账本、崩溃前后如何复用同一值。用“观察之后立刻崩溃、费用回执先到/后到、时钟跨 deadline”做恢复负例。A0 可暂不暴露 `ctx.now/budget`，但不能在展示的 API 中把它们描述成已有能力。

### 高：真实 Python 作者仍被 recipe 专属 host 卡住（确定缺口）

**位置：**草案 §1、§5 与 A2，第 7、13、171–196、241、249 行。现有 [configured-host.ts:18](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/configured-host.ts:18) 把 `recipe` 限为 `rho|ahe|evo`；[configured-host.ts:89](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/configured-host.ts:89) 固定每个 recipe 的 role ID，且 [configured-host.ts:132](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/configured-host.ts:132) 要求角色集合完全相等。[fresh-profile.ts:47](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/fresh-profile.ts:47) 按三种 recipe 生成绑定 schema；[fresh-profile.ts:62](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/fresh-profile.ts:62) 按 recipe 决定重复次数、Skill 注入、操作集合与任务接线。`host.settings.json` 仍要求管理员配置真实模型注册、编译器、Hitch 和完整资源闭包，现状在 [host-setup/README.md:21](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/examples/algorithms/host-setup/README.md:21) 已清楚说明。

**失败场景：**第三方 Python 作者写一个新的 GEPA archive 或新诊断角色，沿用 `team-tb21-luna`，只把角色 prompt 加入算法包。配置准入会因未知 recipe/多一个 role 被拒绝；为了跑通仍得请求管理员改 TS 工厂与接线。此时 `gear.algorithm.json` 虽只有十行，真正复杂度转移到了隐蔽的 host 代码，未达“作者无需改核心”的目标。

**最小修正：**在 RunSpec 实施前先把现有三 recipe 工厂拆成管理员批准的**能力 profile**：可声明的角色集合及 schema、可用 provider kinds、绑定槽及可替换规则、Task/Evidence 数据授权、预算来源/预留映射和物理目的地；recipe 的特殊约束以单独 preset 保留。算法 manifest 只请求能力子集，不能自行扩大授权。A2 验收必须从仓库外新建一个非 RHO/AHE/Evo 的纯 Python 算法，复用同一物理 profile，加入自己的一种角色/提示并跑真实小任务；不得改 `configured-host.ts`、`fresh-profile.ts` 或写 `host.mjs`。若管理员仍需首次配置模型与 Hitch，应在体验统计中明确区分“一次配置”和“每篇算法接线”。

### 高：单一 `ctx.result(agent)` 还不是 archive/共演化的持久结果合同（合同缺口）

**位置：**草案 §3.1–3.2、§6，第 35–59、91–104、200–209 行。示例可做单 best 搜索，正文也承认 archive 属 recipe；但是唯一明确的完成 API 是 `ctx.result(agent)`，说明只保存选中版本和本 Campaign 绑定。现有底层 `AlgorithmDecision.nextState` 与 ArtifactStore 可以保存任意经验证的 JSON/引用（[contracts.ts:100](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/contracts.ts:100)、[artifacts.ts:25](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/artifacts.ts:25)），作者层尚未说明如何产生、发布和重新导入**未选中的候选谱系、逐实例优势、训练数据、任务集或 evaluator 版本**。

**失败场景：**GEPA 需要逐样例局部优胜者组成 Pareto 候选池；DGM 需要低分 stepping stone 继续繁殖，不能因一次 `select(require_improvement=True)` 而丢弃；Evo-Harness 需要保留批内固定旧 Skill、批末更新后的 Skill 库。只返回“最佳 Agent”会把科学状态藏在内部历史里，下一 campaign 无稳定、授权的输入引用。DGM 公开摘要也直接强调开放 archive 和多分支探索，[原始论文摘要](https://arxiv.org/abs/2505.22954)；GEPA 摘要强调 Pareto frontier 的互补经验，[原始论文摘要](https://arxiv.org/abs/2507.19457)。

**最小修正：**保留简写 `ctx.result(best)`，同时定义通用 `ctx.checkpoint(name, typedRef)` 或 `ctx.result({selectedAgent?, outputs})`：输出是不可变 artifact/ref，具有 schema、谱系、用途、可见权限和 Campaign 来源；它与决策/终态在同一提交链上可发现、可恢复。v1 只需实现通用小型 checkpoint 与选中 Agent，不必做 DGM 搜索器或 evaluator 共演化引擎。`ctx.select` 也应被明确定位为可选 helper，不是引擎的晋升规则；保留基线、拒绝平分是 helper 默认值，不覆盖论文自定义选择。

### 中高：`Agent` 的槽位与评估对象需在 API 冻结前精确定义（确定的类型落差）

**位置：**草案 §3.2–3.3，第 91–102、112–128 行。草案把 `Agent` 定为 Harness + 模型 + 可选 Skill 的不可变组合，并让 `train` 返回 `trained.agent`；但现有 binding schema 是每个算法固定的槽位表（[contracts.ts:5](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/contracts.ts:5)），新鲜 RHO/AHE 只有 `harness` 槽，Evo 多一个 `skills` 槽（[fresh-profile.ts:47](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/fresh-profile.ts:47)）。现有固定 Harness GRPO 则显式要求可替换 learner 与不可变 Harness（[grpo.ts:30](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/recipes/grpo.ts:30)）。草案第 126 行已意识到需适配，但没有规定作者可观察的槽位/能力合同。

**失败场景：**一个 `Agent` 表面有可训练 model，实际 profile 的绑定 schema 没有 learner 槽；`ctx.train` 到提交时才失败，或 `ctx.evaluate(trained.agent)` 被映射到仍使用旧权重的 Hitch 路由。另一边，研究者想同时演化 agent-side Harness 与 environment-side wrapper，却没有可表达的独立版本位置。Harness-Zero 还要求训练期专用 harness 与部署期最小 harness 动作空间不同，[原始论文摘要](https://arxiv.org/abs/2609.24974)；不能仅把两个目录都塞进一个泛称 `Agent`。

**最小修正：**A0/A1 固定 `AgentRef` 的版本化字段：binding schema ID、各 slot 的 artifact/schema 与来源、允许的替换、物理模型目的地/评估路由、兼容性检查和 `derive` 的返回类型。任务、环境、judge 与训练产物宜独立于 Agent，以 typed ref 表示；`train` 在准入阶段检查 model slot/后端/固定 harness 兼容，而不是等到 GPU submit。v1 可只支持已验证的 Harness Agent；A4 再启用 model slot，不能提前声称所有 Agent 可训练。

### 中：历史分页与大结果协议还不足以支撑长实验（确定的现状缺口，设计可收敛）

**位置：**草案 §4.2、§4.4、A1，第 146–148、161–167、240、247 行。`historyHeadRef` + 追加不可变页的方向正确，也正确要求 Campaign 提交 nextState 后 head 才可见。当前 Python worker 帧上限 4 MiB（[worker.py:23](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/worker.py:23)），`artifact.get` 会把整个对象 base64 放进单个响应（[python.ts:192](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/hosts/python.ts:192)）；ArtifactStore 本身允许 64 MiB 对象（[artifacts.ts:21](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/artifacts.ts:21)）。现有协议不能直接承载一个较大的历史页、计算结果或完整 trace。

**失败场景：**RHO 对大批任务收集结构化诊断，长 GEPA 历史含大量 Evaluation；Python 重放到某一结果时，即使 state 只有一个 ref，取回该 ref 也可能超过帧上限。若每次重放线性解码所有旧结果，1,000 次串行 await 的累计控制成本也会接近二次增长；方案只提出 benchmark，尚缺拒绝/降级边界。

**最小修正：**A1 写明页格式、每页字节上限、cursor/随机寻址规则、单条结果过大时的 chunk/stream 或“只返回 ref+分块读取”语义；不把大内容默默内联。重放时逐项验证规范化输入与结果 schema，页读取量计入性能指标。A1 中已有 1,000 边界、10,000 操作、1,000 repeat 的测试建议很好，应同时测冷恢复的读取量与 p95 CPU，并在 A0 后先冻结阈值。`ctx.repeat` 应在这个协议成立后引入，避免形成第二套持久执行器。

### 中：受管理 async 前沿的语言语义只能由 PoC 决定（PoC 风险）

**位置：**草案 §4.1、§4.3、A0，第 132–159、239、247 行。现有 Python worker 仅同步分派 `algorithm.initialize/reduce`（[worker.py:141](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/worker.py:141)）；TS/Python loader 也只包装这两种方法（[loader.ts:131](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/loader.ts:131)）。新 `@algorithm` 必须真正增加 coroutine driver/worker 协议，而不能只是装饰器。草案明确不承诺任意 async、禁止裸 `Promise.all/gather` 及不依赖“暂停异常”，这些边界合理。

**失败场景：**作者在 `try/finally` 内 await；Python coroutine 停在 yielded token 后，worker 退出/`close()` 对 finally 与 `GeneratorExit` 的行为不同；TS thenable 经 microtask 同化或裸 `Promise.resolve` 可能启动未登记步骤。`ctx.parallel` 的列表声明顺序必须与完成顺序无关；异常、取消、未知操作不能落入作者 `except` 后再发新的物理副作用。现有 Campaign 已逐条封存操作结果，并在组内全终态后才 reduce（[engine.ts:582](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:582)、[engine.ts:605](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:605)），所以“部分完成后恢复原操作”有可信底座；不等于 async driver 已被证明。

**最小修正：**把 A0 设为继续投资的硬门：两语言分别验证顺序/分支/并行声明、`try/except/finally`、worker 强停、微任务、取消和回包不明；每个测试检查“先封存意图，再有物理调用”“旧 key 不重交”“新前沿前检测分支漂移”。若 Python 或 TS 某一边无法可靠实现，先缩窄该语言的公开语法，不维护一套貌似普通 async、实际靠隐藏状态机的第二框架。此项目前是技术不确定性，不能写成已证实不可行。

### 中：上线门禁太晚才验证作者体验（流程风险）

**位置：**草案 §8–9，第 237–253 行。A6 才安排两名外部开发者；此前 A1 已投入 repeat/subworkflow、A3 已迁 RHO、A4 已接训练。若问题是“是否对真实作者容易用”，等到全部能力完工才验证会让 API 与 host profile 的错误代价变高。方案第 249 行的 30 分钟搜索变体、半天多阶段算法骨架是有价值的目标，但目前只保证“已安装 SDK 和运行配置”，没有测 profile 创设/复用的真实摩擦。

**最小修正：**A0 证明语义后，先做极窄 A1：Python 顺序/并行、不可变结果 ref、分页历史和一次真实 host。立即在 A2 让未参与实现的 Python 作者用现有 profile 写**一项新算法**，并计时、记录向管理员请求的次数、需改文件与首次错误信息。再决定 repeat/subworkflow 的 API；训练和 FCS 放在真实易用性证据之后。TS 同样走黑盒合同，但不要求一篇科学算法双写。

## 已有优势和不应误判的边界

1. **底层可复用。** Campaign 已把操作意图、稳定物理 key、预算回执和 `unknown` 对账做成持久合同。`applyDecision` 中 operation ID 由 campaign/decision/key 派生（[engine.ts:273](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:273)）；旧操作在同一身份下 inspect/reconcile。草案第 148–150 行保留这一点，不承诺外部 exactly-once，是对的。局部重放地址与物理 key 分开也合理。
2. **论文差异未被模板抹平。** 草案第 62、85、104、200–209 行说明示例不是 FCS，RHO 用无标签软偏好，GEPA 保存 archive，AHE 做下一轮预测/回滚，Evo 批内固定 Skill。这些应变成验收用的反例，而不要求 SDK 内置每篇论文的专属类。
3. **测量和数据用途有现成底座。** 现有 [measurement.ts:6](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/measurement.ts:6) 已记录任务视图、provider/evaluator/rubric、环境、采样、预算与 metric schema；[measurement.ts:43](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/measurement.ts:43) 给比较 key，更换 evaluator 不会直接混分。TaskView 已携带 `train/development/final-test` 及暴露标记，并拒绝把已暴露任务重命名为未见 final-test（[tasks.ts:47](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/tasks.ts:47)）。新 `Evaluation` 应包装并保留这些引用，而不是重新发明弱化版比较规则。
4. **训练范围表述审慎。** 固定 Harness GRPO 可在 A4 映射；SFT/DPO、新 loss、Harness-R1 编辑器训练、Harness-Zero 式动作空间蒸馏以及真正的 agent/evaluator 共进化均需新 provider/数据与兼容合同。草案第 124–128、207–209 行明确延后，不能把未实现都列成 v1 的违约。

## 非阻塞建议

- 让文档分别报告“算法作者代码量”“管理员一次性 profile 工作量”“每个新算法新增 host 工作量”，并展示 `inspect/explain` 实际解析出的角色、数据用途、模型目的地和预算映射。否则 30 行示例可能掩盖部署摩擦。
- `ctx.compute` 只适合纯计算或明确 checkpoint 的科学库；Optuna ask/tell、随机种子与 sampler 状态可封存，带副作用的第三方库应是声明恢复粒度的 opaque provider。不要通过笼统的 `ctx.step(fn)` 鼓励隐形 I/O。
- `ctx.parallel/map` 的失败政策需让作者选“fail fast/collect typed outcomes”，但真实操作仍按 Campaign 的取消与对账语义终结。`ctx.select` 需拒绝把失败 trial 当 0 分，却允许论文自定义处理 `inconclusive`。
- 训练方法的 escape hatch 保持公开 provider SPI 与版本化数据/schema/optimizer checkpoint，不要求科学算法在 TS 与 Python 两份实现。扩展物理能力可以增加 adapter；是否真可“只用 Python”需另测其 provider 注册、运行依赖和宿主准入。

## 论文覆盖矩阵：共同闭环与不可抹平的差异

| 论文/方法 | 真正改变且持久的对象 | 反馈与选择的关键差异 | SDK 应容纳；v1 是否必须实现 |
| --- | --- | --- | --- |
| RHO | 一次离线更新的完整 Harness 目录 | 历史 coreset、同一基线多次 rollout、候选对固定 baseline 的自偏好，标签不进入优化 | evidence/query、重复测量、成对 judge 步骤、无更新结果；**A3 真实路径** |
| Meta-Harness | 可执行 Harness 程序的完整候选群 | 全历史代码/原始轨迹可查询、种群/Pareto，不强制逐轮晋升 | 多候选与原始证据 ref、archive 输出；**合同须预留** |
| GEPA | 模块 prompt 的多条谱系 | 按逐样例优胜者保存 Pareto、分阶段小批量验证与可选 merge；不是单 best | recipe 自定义 archive/选择与 staged eval；**合同须预留** |
| AHE | 多组件 Harness 和 manifest/checkpoint | 先评上轮版本，再用任务级变化核验预测、回滚；best-so-far 绑定到已测 snapshot | edit manifest、已测/待测身份、rollback；**非 v1 必做算法** |
| Evo-Harness | 在线 Skill library | 批内版本冻结、失败提案、批末 add/merge/revise，下一批才生效 | batch cursor 与 Skill ref 原子推进；**在线作者样例可后置** |
| DGM | coding agent 仓库 archive | 低分可运行分支保留作 stepping stone，parent 按表现与新颖性抽样 | 非 winner 的谱系与来源必须能导出；**不需 v1 搜索器** |
| Harness-R1 | 独立 harness editor 的模型权重 | failure packet→多个 executable hook→冻结 target 同批重跑→GRPO，patch 不必永久晋升 | `train` 与目标 Agent 分离、训练数据/奖励可追溯；**新训练法后置** |
| Harness-Zero | 学生模型权重；专用 Harness 可在训练后移除 | 审阅者把专用 Harness 的指导转成目标 Harness 原生动作；动作/信息空间必须相容 | 训练期/部署期 Harness 与监督轨迹的独立 refs；**蒸馏后置** |
| EnvHarness | 环境侧 Stage/Contract/Chain 及可提取 Skill | 当前 policy 的弱点改变 reset/step 包装，但原环境最终 verifier 保留 | 环境/任务版本独立于 Agent；**环境 provider 后置** |
| LLM-as-a-Verifier | 测试时评分/排序；无持久 Harness 演化 | 冻结 judge 的连续评分、重复与标准分解；它不是评价器共演化 | judge 是受管理评估步骤；**不必核心内置** |
| RQGM | task agent 与 evaluator workspace，epoch 间评价标准可换 | epoch 内 evaluator 固定；边界由外部 anchor 选 challenger，旧依赖分数选择性失效/重评 | evaluator epoch、anchor 与重评谱系；**后置，但测量合同不可堵死** |

统一范式是“**有版本的对象在受约束环境中产生轨迹；证据经诊断、候选生成与独立/软评价，更新可持久状态；下一次任务或训练再使用它**”。四个必须分开问的问题是：改了什么、保留多久、谁给学习信号、信号以何物锚定真实目标。共同的 Campaign 可处理身份、操作与记录；科学算法不能被统一成一个选择准则。尤其 RHO 的无标签偏好不等于可执行 grader，Harness-R1/Harness-Zero 更新权重而非把某个 patch 永久放进 archive，EnvHarness 改环境侧，RQGM 改评价 epoch。LLM-as-a-Verifier 只是冻结评分部件，不能单独代表 evaluator evolution。这里对具体论文机制的判断主要来自下列本地精读笔记；我未把笔记作者已核对 TeX 的声明伪装成此次亲读原文。

## 实际阅读与证据范围

**本次完整或定向阅读的本地笔记：**

1. 总引：`papers/harness/Harness Evolution Papers Comparative Review.md`；`papers/agent/RSI 递归自进化：从输出修正到评价标准共演化.md`；`papers/agent/Recursive Self-Improvement in AI From Bounded Self-Refinement to Autonomous Research Loops.md`。均位于 `/Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/`，按要求先于方案阅读。
2. 代表性方法：`papers/harness/Evolving Agents in the Dark Retrospective Harness Optimization via Self-Preference.md`、`Meta-Harness End-to-End Optimization of Model Harnesses.md`、`Agentic Harness Engineering Observability-Driven Automatic Evolution of Coding-Agent Harnesses.md`、`Evo-Harness Context-to-Harness Skill Compilation for Self-Evolving Agents.md`、`Darwin Gödel Machine Open-Ended Evolution of Self-Improving Agents.md`、`Harness-R1 Learning to Edit Executable Runtime Harnesses from Agent Failure Trajectories.md`、`Harness-Zero Harness Distillation via Agent-as-Harness.md`、`EnvHarness Awakening Static Worlds for Agent Learning.md`、`LLM-as-a-Verifier A General-Purpose Verification Framework.md`；另读 `papers/prompt工程/GEPA Reflective Prompt Evolution Can Outperform Reinforcement Learning.md` 以及 `papers/agent/Red Queen Gödel Machine：Agent 与评估器共同进化（2606.26294）.md`。RHO、Meta-Harness、GEPA 全文笔记；其他笔记读了方法/限制及直接相关部分。上述都是**笔记阅读**，不是本次直接核对原始 TeX/官方代码。
3. **本次直接核验的原始来源范围：**仅浏览了 [DGM arXiv 摘要](https://arxiv.org/abs/2505.22954)、[GEPA arXiv 摘要](https://arxiv.org/abs/2507.19457) 和 [Harness-Zero arXiv 摘要](https://arxiv.org/abs/2609.24974)，用于确认开放 archive/Pareto/动作空间不匹配这些关键高层主张。其余细节采用本地笔记，并在建议中保持为机制层结论；没有声称本次通读这些论文原文或复现官方代码。
4. **本次直接核验的 Gear 源码：**草案、[现有作者文档](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-authoring.zh-CN.md)、[V3 实施方案](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/meta-agent-algorithm-implementation-plan-v3.zh-CN.md)、[FCS 等价基线](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/failure-cluster-search-equivalence.zh-CN.md)，以及 `contracts.ts`、`steps.ts`、`runtime/engine.ts`、`loader.ts`、Python `steps.py/worker.py/rho.py`、`configured-host.ts`、`fresh-profile.ts`、`artifacts.ts`、`data/measurement.ts`、`data/tasks.ts`、`recipes/grpo.ts/gepa-search.ts`、`search/campaign-engine.ts` 和宿主 README。对 GEPA/FCS 的复杂度判断基于相关状态/阶段与接线代码；本次没有重新执行其测试或真实模型/GPU。

## 建议的最小 v1 与上线门禁

**最小 v1：**一个纯 Python 和一个纯 TS 的 `async` 算法入口，共用同一持久步骤/结果协议；顺序、分支、稳定并行 join、typed Agent/Task/Evaluation refs、可分页历史、`ctx.evaluate`、受管理角色调用、可选确定性 `select`、通用 checkpoint/output、简化但真实可复用的能力 profile。受管理 budget/time 观察只有在原子控制记录通过后才开放。A0 不必含 `repeat`、训练、Skill 在线流或 evaluator evolution；A2 用真实小任务和独立作者决定是否需要这些抽象。固定 Harness GRPO、RHO 和 FCS 按依赖随后接入，科学逻辑仍各只有一种语言的一份实现。

**上线门禁：**

1. **语义门：**A0 两语言故障注入通过；每个新物理调用前有已提交意图；已完成操作在 worker/Campaign 重启后不重做；`unknown` 保留原 key，输入/分支漂移在新副作用前拒绝；控制观察复用原值。
2. **协议门：**Python 大对象取回与历史分页不超过 4 MiB 帧；1,000 串行边界、10,000 操作和 1,000 具名 repeat 的冷恢复 CPU/内存/读取量对预先冻结阈值通过。若 repeat 后置，其性能门只控制 repeat 发布，不阻塞短流程 v1。
3. **真实装配门：**仓库外纯 Python 新算法复用已有管理员 profile，确实运行模型与 Hitch 小任务，增加自有角色/提示而不改 Gear 核心或 TS 宿主；角色、数据用途、预算和模型目的地能 `inspect/explain`。没有真实运行条件时保持 experimental，不用录制夹具冒充端到端。
4. **科学门：**RHO 的固定输入、操作序列、自偏好接受与恢复与当前 Python recipe 对照；后续 FCS 维持既有冻结差分/Search 回归与同一预算/时钟边界，并清楚报告 replay 新增成本。A4 的 GRPO 必须核验真实 checkpoint/训练资源释放；CPU 故障合同不代替 GPU 认证。
5. **作者门：**两名未参与实现的开发者按文档完成搜索变体与新多阶段骨架；记录实际耗时、管理员交互、需要理解的低层概念和首次失败定位。此门应在扩充训练/FCS 接口前完成，而非等全部功能完工。

在这些门通过前，继续标为 experimental 是准确的。方案可以开始 A0，但应先补齐前三项合同并重排作者验收；否则最容易得到一套能运行、能恢复，却仍须为每篇新论文请熟悉内部接线的人代写宿主的 SDK。

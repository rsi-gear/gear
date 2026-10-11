# Gear 算法作者 SDK v3 独立评审

评审对象：[v3 方案](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:1)，源码 HEAD `a5011e879e11586c9b62da2ba894944d61fb7541`。本报告只审查方案和当前源码；v3 的 author runner、RuntimeProfile、history reader 均尚未实现。我没有运行模型、GPU、服务器或旧 `lib/` 构建，也没有修改仓库。

**结论：有条件可实施，先补合同再把 A0 当作继续投资的硬门。** v3 已正确取消旧运行 API/旧 journal 原地恢复义务，同时保留新运行的单一 Campaign 账本、原操作 key 对账和历史数据读取。Hitch 是正式依赖；使用其标准只读接口和版本检查是合理分工，不应再要求 Gear 自行解析 Hitch 私有格式或完全离线。主要剩余风险不是一个新内核是否能写出，而是两语言普通 `async` 的重放语义能否承载**复合**角色、编辑、评估流程，并让新作者无需写 TS 宿主接线。

## 按严重程度排序的问题

### 1. 高，PoC 风险：`parallel` 中的复合 API 前沿没有执行合同

**方案位置：**[v3:136](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:136)、[v3:140](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:140)、[v3:174](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:174)、[v3:302](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:302)。**源码证据：**当前 [Python worker.py:141](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/worker.py:141) 只同步调 `initialize/reduce`，[loader.ts:131](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/loader.ts:131) 只桥接这两个调用；[engine.ts:605](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:605) 要一组物理操作全部终态才 `reduce`。现有结构化角色、workspace 编辑和 Hitch rollout 是各自的物理端口，并无一个已存在的 `propose` 或整套任务 `evaluate` 原子 provider（[roles.ts:554](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/roles.ts:554)、[workspace-edit.ts:612](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/workspace-edit.ts:612)、[hitch.ts:80](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/hitch.ts:80)、[measurement.ts:11](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/measurement.ts:11)）。

示例的 `ctx.parallel([ctx.evaluate(agent, tasks=tasks) ...])` 可能让每个子调用先发多条 rollout，再聚合逐任务状态、记录测量。v3 没规定驱动器如何把多个子 coroutine 的**第一批及后续批**前沿合并、分配稳定地址，如何隔离某个子调用失败/取消/unknown，或 Python/TS 是否允许高层操作在 `parallel` 内再次 await。若 A0 只用单操作 toy 验证，示例仍可能在第一个实际任务集合上无法安全执行。这是**方案未定义、A0 必须证明**，并非现有内核无法实现：可在同一 Campaign 内用稳定分支路径/分支内步骤地址逐波推进，每波按已有整组 join 汇合。`engine.ts:583` 的 8 是一次 `dispatchBatch` 的批大小，后续批仍会派发，不能解释为全局最多 8 个作业。

**最小修正：**A0 固定两语言同一内部执行规则：高层 `evaluate/propose` 是可展开的 SDK 子流程还是单个 opaque provider；若是子流程，使用稳定子路径/分支内步骤地址、已有整组 join 与逐波推进，定义返回值、错误汇合、重复 await 和新副作用前的历史验证。用一个角色→编辑→10 任务 rollout→测量封存的真实形状假端口流程，置于 `ctx.parallel` 的两个候选分支内，做逆序完成、部分失败、强停、恢复和原 key 对账。无需在 A0 做真实付费模型，也无需另建调度引擎。

### 2. 高，确定的方案缺口：作者可执行的纯计算/非确定性边界在 v3 中过窄

**方案位置：**[v3:24](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:24)、[v3:140](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:140)。v3 只说明受管理 await、未受管理并发和任意 IO 不能自动恢复。被取代的[第一版:152–159](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan.zh-CN.md:152) 曾明确 random/时间/UUID/可变文件、第三方 Optuna、`try/finally` 和 unknown；v3 没有保留足以指导作者的替代合同。**源码证据：**[engine.ts:273](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:273) 的物理 ID 由 campaign/decision/local key 派生；[engine.ts:607](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:607) 只传已封存结果，普通本地计算、随机调用或文件读取不会进入历史。当前低层 [Optuna adapter](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/adapters/optuna.py:1) 存在，但不能证明未来高层函数重放时 sampler 状态被自动冻结。

同一函数第一次运行 `random.choice()`、`Date.now()`、`uuid4()`、读取可变 prompt 文件或直接调用 LLM SDK，恢复时可能换分支或在提交前发生未记账副作用；静态检查无法证明任意 Python/JS 的纯度。`ctx.now/budget` 已有明确观察操作，但泛用随机和纯计算没有同等说明。`finally` 若清理了外部会话，也可能在 worker 关闭而非业务完成时执行。

**最小修正：**在 v3 或随 A0 冻结的一页作者合同中写清：普通本地计算须对同一冻结输入确定；随机数/UUID/时间用受管理观察或显式持久 seed；可变文件/环境先封存输入；直接外部 IO 不属于可恢复语义；有副作用第三方库走已有 provider SPI 或可恢复 opaque job；`finally` 不承担外部资源释放；unknown 只能对账，不能在 `except` 中换 key 重发。A0 加两语言负例，并给文件/行号诊断。无需引入一套通用 `ctx.compute` 状态机才能修文档。

### 3. 中高，确定的方案缺口：200 个前沿与高层示例的工作量口径未对应

**方案位置：**[v3:148](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:148)、[v3:166–190](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:166)、[v3:327](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:327)。**源码证据：**[engine.ts:582–609](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:582) 每个决定可含多操作，但必须整组汇合才到下一决定；`tasks.consume`、`execution.rollout`、`measurement.record` 是不同操作（[tasks.ts:45](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/tasks.ts:45)、[hitch.ts:123](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/hitch.ts:123)、[measurement.ts:14](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/measurement.ts:14)）。

若 `evaluate` 逐任务串行展开，三轮 × 每轮 1 个 baseline 加 4 个候选 × 10 任务，单 rollout 就可达 150 个受管理边界，再加采样、提案、绑定、测量和 checkpoint，可能触及 200；若任务在一个声明批次中展开，前沿数量少得多但操作/journal 成本仍高。RHO 一轮也涉及 30 个基线重跑、30 个候选重跑及成对评判；本地[RHO 笔记](/Users/zgq/Library/CloudStorage/OneDrive-个人/笔记/papers/harness/Evolving%20Agents%20in%20the%20Dark%20Retrospective%20Harness%20Optimization%20via%20Self-Preference.md:78)说明这些是不同阶段，不能用一个 30 行 for 循环估算成本。此处只是计数情景，不是运行测量。

**最小修正：**明确前沿计数是一次 Campaign `initialize/reduce` 决定、每个 Gear await，还是复合 API 的内部阶段；同时独立计物理操作与 journal commit。A0 的代表性复合轨迹应记录两语言前沿/操作/commit 数和冷恢复成本，**再**冻结 200 阈值。超限错误应指出已提交的步骤及可复用 checkpoint，而非在正常短实验中途才意外暴露“需开新运行”。8 操作 dispatch 批大小不限制最终物理操作数。

### 4. 中高，PoC/体验风险：`propose`、角色模板与 schema 的交界还不是可照做的作者路径

**方案位置：**[v3:89–95](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:89)、[v3:111](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:111)、[v3:175](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:175)、[v3:192](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:192)。**源码证据：**当前 [configured-host.ts:89–134](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/configured-host.ts:89) 精确锁定内置角色，[default-host.ts:84–95](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/default-host.ts:84) 又按 recipe 装配。结构化角色分别要求 input/result schema（[roles.ts:25](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/roles.ts:25)），编辑者有独立 base binding、可写范围和封存过程（[workspace-edit.ts:188](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/workspace-edit.ts:188)）。

v3 说普通作者能在批准的模板内创建新角色，这解决了“每加角色改核心”的方向，但示例仅写 `role="optimizer"`。它没说明一个新角色如何选择 read-only/可编辑模板、提供 prompt/schema、让 `ctx.propose` 从模型结构化文本变成四个**已封存可运行候选**，也没说明 `ctx.checkpoint(..., schema="example.population.v1")` 的 schema 在何处声明、由谁批准。角色命名、物理编辑权限、算法输出 schema 三者若都由手写 manifest/profile 协调，30 分钟目标可能失真。

**最小修正：**A0/A2 给一份完整可安装的仓库外例子：算法文件、最小 RunSpec、一个角色声明/prompt/schema、现成 profile 的 resolved explain 输出；展示 `propose` 返回“角色建议”还是“已验证并绑定的候选”，以及失败候选的 typed outcome。作者新增角色的默认模板和 schema 校验由 SDK/CLI 推导，只有越出数据、工具、写入或模型目的地边界才要求管理员批准。记录作者新增文件数和管理员交互，别只计 Python 函数行数。

### 5. 中，扩展性合同缺口：新任务/评价器/训练方法的低层出口没有写成稳定规则

**方案位置：**[v3:80–93](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:80)、[v3:125–134](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:125)、[v3:203](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:203)、[v3:358](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:358)。**源码证据：**现有 [OperationProvider SPI](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/contracts.ts:53) 及 [CLI Python/TS provider 加载](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/cli.ts:326) 是真正低层扩展出口；当前 `HitchRolloutPort` 仍只认既定 task/view/采样合同（[hitch.ts:60](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/hitch.ts:60)），训练映射要求固定计划和资源（[training-mapping.ts:111](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/providers/training-mapping.ts:111)）。

v3 正确把新训练法、任务和评价器共演化后置，但“后续扩展”不能等于只能改核心注册表或把任何对象塞进 `ctx.evaluate`。一个新科学算法可在同一语言完成其决策逻辑；新增**物理能力**有时仍需 provider 和管理员授权，这是合理边界。当前方案没有明确新 RuntimeProfile 是否继续支持外部 Python/TS provider 包的注册、版本封存、预算/权限映射与 typed step 调用；若重构宿主时丢了这一出口，后续实验又回到“请核心开发者加 recipe”。

**最小修正：**A0 固定一条窄的扩展合同：作者级科学函数只依赖 typed refs 和受管理 step；宿主可安装版本化外部 OperationProvider（已有 Python/TS SPI），profile 授予其 kind、数据用途、预算和目的地；新 evaluator/TaskSet 用独立版本 ref，旧 MeasurementRecord comparisonKey 不跨条件自动比较（[measurement.ts:43](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/measurement.ts:43)）。A2 用一个不改核心的小型自定义 provider smoke test；SFT/DPO、Harness-R1 和评价器共演化策略本身不列为首期缺陷。

### 6. 中，数据兼容 PoC 风险：历史 reader 的覆盖范围对，但真实格式及制品闭包尚未证实

**方案位置：**[v3:239–263](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:239)、[v3:333–351](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:333)。**源码证据：**目前 [legacy.ts:15](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/legacy.ts:15) 只桥接 sealed seed-summary；[history-source.ts:26](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/history-source.ts:26) 只枚举 round 的部分 evaluation，[history-source.ts:140](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/history-source.ts:140) 要原 spec、round 和编译数据集；当前 FCS 的 `ResearchArchive` 另在 [search/archive.ts:101](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/search/archive.ts:101)，结果写入 [refine/service.ts:2537](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/refine/service.ts:2537)。Hitch 标准轨迹接口已被现有 history source 调用并验证能力、run ID 和 canonical SHA（[history-source.ts:153](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/history-source.ts:153)、[history-source.ts:175](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/data/history-source.ts:175)），但这不等于旧 Gear 所有格式可导入。

v3 对“能看分数／能读轨迹／可执行 TaskSet／可运行 Agent”分别标能力是正确的。风险在于 A1 同时承诺旧 Evolution/Refine、Search/Campaign、模型 manifest 的查看、导出和输入导入，而真实样本及 Hitch、Git、权重闭包尚待 A0 盘点；不能用近期成功 FCS 一条记录代替旧失败记录或训练样本。尤其被拒绝候选若只剩 commit ID、没有对应 Git 对象和执行配置，可以如实查看，却不能声称可运行。

**最小修正：**保留 v3 的 A0 格式清单与真实样本门，按三条独立 acceptance 切片提交：只读报告计数、授权轨迹/任务投影、精确候选/模型起点。第一条可在依赖缺失时通过并报告缺项；后两条只有相应 Hitch/Git/权重闭包真实存在时通过。测试 Hitch 只用正式读取接口与版本检查；缺接口优先补 Hitch 标准导出。此项是尚未验证的发布范围，**不是**要求离线读取 Hitch，也不是要求旧 journal 原地 resume。

### 7. 中，阶段风险：作者验收仍被大范围历史/宿主重构挡在后面

**方案位置：**[v3:300–310](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v3.zh-CN.md:300)。A0 双语言前沿探针先行很好，A3 也把外部开发者试用提前了；不过 A1 是整个历史 reader/import，A2 同时含两语言 runner、通用宿主、旧工厂与内置调用者迁移。即使 A0 通过，尚需投入较大迁移后才发现 profile/角色对新作者仍难用。当前 [configured-host.ts:18](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/configured-host.ts:18) 和 [fresh-profile.ts:47](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/fresh-profile.ts:47) 显示装配是 recipe 专属，不能靠更换 YAML 模板验收体验。

**最小修正：**A0 后先做极窄竖切：同一冻结 profile、新 Python 自定义角色、角色→编辑→Hitch 小评估、一次故障恢复，外加一个真实历史非 winner 的只读解析/起点。此切片由外部作者立即试用；随后完成 A1 所有格式、迁移内置工厂，再在 A6 做 FCS 完整等价切换。每个阶段提交都要有可运行/可读取的验收件；不必恢复旧 Gear API 或长期双写。

## v2 问题处理情况与三项评价

| 维度 | v3 状态 | 评语 |
| --- | --- | --- |
| 上轮预算/时间观察 | **方案上解决，PoC 未完成** | `author.observe` 冻结输入、零计量、不启动预算时钟与崩溃前后语义清楚；[engine.ts:259](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:259) 接受带 operation 的非终态决定。v2 有限探针只证实内核路径，不证实 async worker。 |
| recipe 专属宿主 | **目标解决，装配待证** | v3 决定收敛为通用 RuntimeProfile、新角色复用模板；当前源码仍锁定 rho/ahe/evo。 |
| archive/跨运行输出 | **方案上解决，引用图待实现** | checkpoint、可选 selected、OutputManifest、非 winner 输入与来源/用途边界足够容纳 GEPA/DGM；不要求首期实现其搜索算法。 |
| Agent/训练槽位 | **主要解决** | HarnessAgent 与 TrainableAgent 分开，固定 schema、实际新权重评估与 GRPO gate 明确；混合优化后置合理。 |
| 分页/长运行 | **短流程边界清楚，计数未落地** | 256 KiB 页/块、1 MiB RPC 与整块旧 CAS 读取限制已写明；总体 store 完整链成本仍须测。[store.ts:103](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/store.ts:103) 每次 load 遍历全链。 |
| async 语言语义 | **未解决** | 尚无两语言 driver；复合子流程、随机/本地 IO、`finally` 和并行前沿须先固定。 |
| 作者试用时机 | **改善但可再前移** | A3 在训练/FCS 前，但排在大范围 A1/A2 之后。 |
| 旧兼容与 Hitch | **正确收敛** | 取消旧 API、旧 journal resume 与双写；保留可读历史、制品输入、新运行身份与对账。Hitch 标准接口/版本检查应继续用。 |

**可实现性：有条件，核心风险集中在 async 复合流程与真实宿主接线。** 现有 Campaign 的意图先提交、稳定 ID、预算/unknown 和一组全终态汇合提供可信底座；当前 worker 还不执行 author coroutine。短流程可先做，长 repeat 不必首期兑现。

**扩展性：方向良好，须保住低层 provider SPI。** 通用 checkpoint、独立 TaskSet/Environment/Evaluator 与测量条件能够保留 RHO 无标签偏好、GEPA 逐样例 Pareto、DGM 低分分支以及日后 evaluator epoch；Harness-R1 更新独立 editor 权重，Harness-Zero 区分训练期/部署期 Harness，不能被统一 `best Agent` helper 强制改写。未来训练方法和共演化策略后置合理。

**易用性：目前尚未证明。** 目标示例表达简洁，但 role/prompt/schema、编辑权限、候选封存、RunSpec/profile 安装和历史输入的真实文件工作量没有完整展示。A2/A3 必须由非实现者在已安装 SDK 与已有 profile 上计时，并分别报告“算法作者新增文件/步骤”“管理员一次性设置”“每个算法需新增宿主代码”三个数字。

开始实施前建议完成五项必要修改：

1. 冻结两语言复合 `evaluate/propose` 与 `ctx.parallel` 的前沿、稳定地址、失败和取消合同，用代表性多阶段轨迹作 A0 门。
2. 恢复简短明确的作者重放规则：随机、时间、UUID、可变文件、第三方库、直接 LLM IO、`finally` 与 unknown。
3. 定义 200 前沿和操作预算的计数口径，按复合流程测成本后确定发布阈值。
4. 给出完整仓库外最小例子及 resolved profile：角色模板、prompt/schema、`propose` 产物、checkpoint schema、RunSpec 和诊断。
5. 明确保留外部 provider 扩展出口，并把首个作者竖切/真实历史非 winner 输入放到大规模内置迁移之前。

**非阻塞建议：**（a）`inspect/explain` 直接列出每个高层调用将展开的 provider kind、模型目的地、任务用途、预算预留与角色模板，便于作者定位权限错误；（b）提供通用小 archive 的内置 schema，让简单 checkpoint 不必手写引用图，只有自定义类型才声明 schema；（c）报告中的历史“仅可查看/可投影/可运行”状态用稳定机器可读原因码，方便后续工具消费。这些不要求首期增添新科学算法或新的持久执行器。

## 科学范式与实际阅读范围

我定向阅读了本地 `papers/harness/Harness Evolution Papers Comparative Review.md` 的统一闭环、方法差异和工程原则；`papers/agent/RSI 递归自进化：从输出修正到评价标准共演化.md` 的对象/持久性/信号/锚点、harness/weights/verifier 演化和最小架构；`papers/agent/Recursive Self-Improvement in AI From Bounded Self-Refinement to Autonomous Research Loops.md` 的定义、部署/训练 persistence 与评价器部分。代表性笔记定向阅读了 RHO 的六阶段与无标签自偏好、GEPA 的逐样例 Pareto 与数据分工、DGM 的开放 archive、Harness-R1 的独立 editor GRPO、Harness-Zero 的训练/部署 Harness 与动作空间。上述是**本地笔记阅读**，未在本次通读原论文 TeX 或运行论文代码；不把先前评审所说的原文核验冒充自己的工作。由此采用的评审尺度是：更改对象、保留周期、反馈来源和外部锚点必须能在 SDK 的版本化 ref、测量条件与输出中分清，且科学选择策略仍由算法作者掌握。

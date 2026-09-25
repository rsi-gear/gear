# Gear 算法作者 SDK v4 复审（R1）

审阅：[v4 方案](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:1)及其规范性附件[作者合同](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:1)，对照上一轮 v3 独立评审逐项核验。源码仍为 `a5011e879e11586c9b62da2ba894944d61fb7541`，新增 SDK 尚未实现；本轮没有改文档/源码、运行模型/GPU或操作服务器。科学范式沿用上一轮已读的本地 harness/RSI 总引及 RHO、GEPA、DGM、Harness-R1/Harness-Zero 笔记；本轮只复核两份 v4 文档和必要源码合同，没有重读论文原文。

**结论：v4 已解决上一轮的主要设计缺口，未发现必须重构方案的架构问题；有两处很小的规范/验收修正应在 A0 开始前写进文档。** 第一处是历史输入的 RunSpec 示例仍用旧字段形状，与同为规范的完整作者项目冲突；第二处是 A0 尚未明确要求两语言实际执行作者自定义的 `@workflow`/`workflow(fn)`，而这是新增公开语义的风险点。修正后可明确标记“方案层面无阻塞意见，可进入 A0”。这不等于 async runner、成本、Hitch 真实接线或易用性已经通过。

## 需修改的两处

### 1. 规范性 RunSpec 示例不一致（确定的文档缺陷，改一处示例即可）

**位置：**[v4 §6.4:286–307](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:286) 给出 `algorithm: ./algorithm.py`、`profile: local-harness`、`inputs.initial_agent` 与 `inputs.experience`；[作者合同 §3:97–112](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:97) 的完整 RunSpec 则是 `schemaVersion: 2`、`algorithm: {language,module,export}`、`profile: lab`、`inputs.initialAgent/searchTasks`、`roles`、`config`。[作者合同 §5:269](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:269) 又明确让历史起点替换该 `initialAgent`。v4 开头说两文档**共同作为实施依据**（[v4:3](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:3)），因此旧形状即便注明“目标形态”也会使 A0 冻结两种 schema，或让用户照方案命令得不到附件中的作者 API。

**最小修正：**将 §6.4 的 YAML 改为作者合同 §3 的 RunSpec v2，只替换 `inputs.initialAgent` 为历史 selector；若也示范经验输入，沿用同一 camelCase/wire 规则，并补一句“A0 以作者合同中的 RunSpec v2 为唯一规范”。可以直接删掉重复 YAML、指向作者合同 §5 的历史起点写法。无需设计第二个导入 schema。源码当前 CLI 仍只接受低层 v1 配置（[cli.ts:259](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/cli.ts:259)），这恰好说明两个 v4 新例子都是待实现合同，不能靠旧 CLI 容错解决文档冲突。

### 2. A0 应明确覆盖作者自定义轻量 workflow（PoC 门槛缺一项）

**位置：**[v4 §3.5.1:155–165](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:155) 和[作者合同 §1:12、24–26](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:12) 把 Python `@workflow`/TS `workflow(fn)` 声明为用户自定义复合并行分支的入口；[A0 验收:325](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:325) 虽要求两个多阶段分支和嵌套 parallel，但没说必须有**作者定义**的 workflow。只测内置 `ctx.evaluate/propose` 的惰性子流程，可绕开装饰器/包装函数的真正边界：TS async 函数何时开始运行，Python coroutine 何时首次驱动，参数/捕获是否冻结，以及自定义分支的路径如何入历史。当前 [Python worker.py:141–150](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/packages/python-sdk/src/gear_algorithm/worker.py:141) 仍只同步分派旧方法，[loader.ts:131–135](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/loader.ts:131) 没有新 driver；这是应在 PoC 验证的风险，**不是断言现有内核不可能实现**。现有 [engine.ts:605–609](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/runtime/engine.ts:605) 的全组终态后推进可支撑设计所述逐波 join。

**最小修正：**在 A0 行末加一句：**“Python `@workflow` 与 TS `workflow(fn)` 各以一个作者定义的、包含至少两个受管理 await 的分支参加嵌套 parallel；验证构造阶段零副作用、冻结参数/只读捕获、分支独立状态、强停重放及地址/原 key 不漂移。”** 无需添加新引擎；沿既定 ManagedCall/同一 Campaign 合同测试即可。`ctx.parallel([])` 与重复 await 的负例也宜在同一夹具中覆盖，作为实现测试细节即可。

## 上一轮七项问题的关闭矩阵

| v3 问题 | v4 方案状态 | 尚待实施证据 |
| --- | --- | --- |
| 1. 复合 `parallel` 前沿 | **方案已关闭**。[v4:153–163](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:153) 规定惰性 ManagedCall、稳定分支路径、逐波原子前沿、全组 join、collect、unknown/取消。上文第 2 项只是补上自定义包装器的 A0 验收。 | A0 两语言复合/不等长/嵌套分支、业务失败、unknown、强停与原 key。 |
| 2. 随机、时间、文件及 IO 重放规则 | **方案已关闭**。[作者合同 §1:9–26](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:9) 写明 `now/budget/random_seed/new_id`、固定 seed、本地状态、可变文件、第三方库、直接外部 IO、`finally` 和 unknown。 | A0 两语言已声明可检测负例；检测不了的第三方深处 IO 按作者合同边界处理。 |
| 3. 200 前沿与复合成本 | **方案已关闭**。[v4:175–183](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:175) 分 F/O/J，200 仅为试验值，正常示例需通过测后冻结的默认限额；正确区分 `dispatchBatch` 的 8 与全局并发。 | A0 冻结机器/阈值后量代表性搜索、RHO 轨迹；冷恢复、store 完整链开销按门槛判断。 |
| 4. 最小作者路径与 `propose` | **主体已关闭，示例须对齐**。[作者合同 §2–4](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:28) 列一次性管理员配置、五个作者文件、角色模板、真实候选封存、Evaluation/ProposalBatch、Python/TS、命令与 explain；但本报告第 1 项的历史 RunSpec 示例仍冲突。 | A1 安装后真实项目、新角色→编辑→Hitch 评估，计时与管理员交互；不能以文档示例代替可运行性。 |
| 5. 外部 provider 出口 | **方案已关闭**。[v4:195–205](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:195) 明确保留 Python/TS provider 装载、版本/预算/权限与 typed `ctx.operation`。现有低层 SPI/CLI 可作为迁移起点（[contracts.ts:87](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/contracts.ts:87)、[cli.ts:326](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/src/algorithm/cli.ts:326)）。 | A1 双向跨语言 provider smoke，不改 Gear 核心注册表。 |
| 6. 历史格式与制品闭包 | **方案已关闭，真实数据风险保留**。[v4:260–284](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:260) 分查看/经验/可运行资产；[A2:327](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:327) 对三项分别用真实样本验收，Hitch 只走标准读接口。 | A0 盘点，A1 一个真实非 winner，A2 近期/旧 round/失败/训练 manifest 分项验收；缺资产只报告不能复用。 |
| 7. 试用被大迁移阻挡 | **方案已关闭**。[v4:325–335](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:325) 将最小作者竖切与非实现者试用置于 A1，历史全覆盖和内置工厂收敛后移。 | 试用者缺席时易用性门保持未通过；A3 完整路径复验。 |

上一轮三条非阻塞建议也已处理：`inspect/explain` 展示模型目的地、数据用途、编辑范围、调用展开与预算/F/O/J（[作者合同:245–260](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:245)）；简单 archive 默认 `author.archive.v1` 自动枚举 typed-ref 边，自定义类型显式 serializer/schema（[作者合同:184](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:184)）；历史项有机器可读 reason code（[v4:309](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:309)）。

**一个非阻塞的 A0 细节：**作者例子每轮重复 `await ctx.checkpoint("population", archive)`（[作者合同:168–177](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-authoring-v4.zh-CN.md:168)），而 OutputEntry 同时有名称和逻辑步骤（[v4:124–126](/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear/docs/algorithm-author-sdk-plan-v4.zh-CN.md:124)）。实现时应明确同名 checkpoint 为不同逻辑步骤的不可变版本，`inspect` 可列全部版本，终态 `outputs.population` 指向指定最终版本；不可因同名覆盖旧记录或拒绝第二轮。可直接在 A0 schema/测试中冻结，不需改变方案架构。

## 最终判断与 A0 后仍必过的门

**可实现性：有条件可实施。** 现有 Campaign 保证提交意图、原 key、预算和组内全部终态才 reduce；v4 的逐波分支可映射到这套机制，最难的 Python/TS coroutine/thenable 驱动仍须 A0 PoC。不要把方案清晰误写为已实现。

**扩展性：方案层面良好。** Proposal、Evaluation、archive 与独立 TaskSet/Environment/Evaluator refs 保留了 RHO 的软偏好、GEPA 的逐样例 Pareto、DGM 的非 winner 分支、Harness-R1 的独立 editor 权重和 Harness-Zero 的训练/部署动作空间差异。新增任务/评价器/训练方法有 provider 与 typed-ref 出口；首期不承诺实现全部科学策略是合理的。

**易用性：设计路径比 v3 明显具体，仍未获实证。** 五个作者文件与一次性管理员 profile 分账，roles/schema 来自模板、digest/manifest 自动生成；A1 非实现者在现成环境的实际安装、诊断和计时决定能否兑现目标。

两处小修后，**方案层面无阻塞意见，可进入 A0**。进入 A0 不代表可发布：必须完成双语言自定义与内置复合前沿的故障矩阵、F/O/J/冷恢复性能门、真实 profile/Hitch 小任务与外部作者试用、外部 provider 跨语言验收、真实旧 Gear + Hitch 历史及候选制品验收；训练还需实际新权重路由/GPU/释放门，FCS 最终切换仍需冻结差分 oracle 与原预算/物理操作语义对照。旧 journal 不要求新 runtime 原地 resume。

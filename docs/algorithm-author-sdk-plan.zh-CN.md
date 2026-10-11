# Gear 算法作者 SDK 方案

状态：设计草案，2026-09-25。本文的 `algorithm`、`ctx.evaluate` 等高级 API 和简化配置均为拟新增接口，尚未实现。这次只写方案，不修改算法或运行时。

## 1. 目标与现状

目标是让理解论文的开发者主要编写采样、生成、评估、选择和停止逻辑。算法可用 Python 或 TypeScript 单独实现；使用已有执行能力时，不需要修改 Gear 核心、不需要编写 RPC、操作日志、恢复状态机或物理 provider。

现有 Campaign 内核已经有持久化决定、操作身份、预算、绑定、provider 与恢复合同，但现有 `task/defineWorkflow` 仍主要是操作声明和固定步骤助手。真实作者仍要处理 `initialize/reduce`、状态搬运、wire refs 与宿主接线。不能把接口统一、toy 简短或确定性测试通过等同于作者体验已经达标。

本方案增加作者层，不另建作业调度器或第二套预算账本。保留底层 reducer 作为高级接口。`FailureClusterSearch` 为保持旧行为而存在的服务适配与 journal 投影继续隔离，普通新算法不需要实现这些兼容能力。

成功的作者项目默认只包含：`algorithm.py` 或 `algorithm.ts`、`gear.algorithm.json`、必要的算法 prompts/纯策略模块和测试。团队提供一次性的运行配置，复用模型、Hitch、Git Harness、数据授权和训练后端。

## 2. 三种扩展方式

| 场景 | 作者编写内容 | 框架职责 |
| --- | --- | --- |
| 改现成算法 | 已声明的策略函数、prompt、科学参数 | 校验可替换点、记录结果、维持原流程 |
| 写新算法 | 普通 async 函数、循环、分支和受管理步骤 | 转换为 Campaign 决定与操作、恢复、预算、结果存储 |
| 接新物理能力 | TS/Python provider 或已有库 adapter | 复用 provider 协议和合同测试；不要求科学算法双写 |

高级入口建议为 `rsi-gear/algorithm/author` 与 `gear_algorithm.author`；已有 `rsi-gear/algorithm`、`gear_algorithm` 的低层入口不移除。普通文档先教高级接口，OperationIntent、BindingSetRef 与 reducer 移到高级章节。

## 3. 作者看到的 API

### 3.1 Harness 搜索示例

下面是拟议的可执行形态，不是当前已有代码。`evaluate` 等方法创建惰性、可 await 的 Gear 步骤；在运行时保存意图前不开始物理调用。

```python
from gear_algorithm.author import algorithm, RunContext

@algorithm
async def search(ctx: RunContext):
    best = ctx.initial_agent
    tasks = await ctx.tasks.sample(ctx.data.search, count=10)

    for round_index in range(ctx.config.rounds):
        baseline = await ctx.evaluate(best, tasks=tasks)
        proposal = await ctx.propose(
            best,
            feedback=baseline,
            role="optimizer",
            count=ctx.config.candidates,
        )
        measured = await ctx.parallel([
            ctx.evaluate(candidate, tasks=tasks)
            for candidate in proposal.candidates
        ])
        choice = ctx.select(
            [baseline, *measured],
            metric="pass_rate",
            require_improvement=True,
        )
        if choice.accepted:
            best = choice.agent

    return ctx.result(best)
```

此例是简单候选搜索，不是等价的 FailureClusterSearch：没有省略后者的失败聚类、父代分配、bridge/global 等科学阶段再声称等价。无有效提案时 `proposal.candidates` 为空；基线仍参与选择。`select` 默认保留基线处理平分，比较不兼容或证据不足时返回明确判定，不静默丢掉无效 trial 再算高分。

TS 使用相同对象模型和语义，语言习惯保留，例如：

```ts
import { algorithm } from 'rsi-gear/algorithm/author';

export const search = algorithm(async ctx => {
  const tasks = await ctx.tasks.sample(ctx.data.search, { count: 10 });
  const baseline = await ctx.evaluate(ctx.initialAgent, { tasks });
  const proposal = await ctx.propose(ctx.initialAgent, {
    feedback: baseline, role: 'optimizer', count: 4,
  });
  const measured = await ctx.parallel(
    proposal.candidates.map(agent => ctx.evaluate(agent, { tasks })),
  );
  const choice = ctx.select([baseline, ...measured], {
    metric: 'pass_rate', requireImprovement: true,
  });
  return ctx.result(choice.agent);
});
```

这两段展示各自语言的用法，不要求同一个算法双写。已有 Python RHO 继续只有一份科学实现。

### 3.2 对象与能力

| 对象/API | 作者语义 | 底层映射/限制 |
| --- | --- | --- |
| `Agent` | 不可变的 Harness + 模型 + 可选 Skill 等版本组合 | 包装封存的 binding；不包含活的客户端、GPU tensor 或可变 endpoint 状态 |
| `ctx.tasks` / `ctx.evidence` | 选取任务、读取经验/轨迹、发布新研究任务 | 已授权 TaskView/EvidenceView 和操作；发布任务属于后续能力，未安装时准入报错 |
| `ctx.roles.run` | 调用作者定义的诊断、提案等角色 | 复用 execution.role；prompt/schema 属于算法包，权限与模型目的地属于运行配置 |
| `ctx.propose` / `ctx.edit` | 根据反馈提出并物化 Harness 候选，或使用自定义变换 | 高层可组合 workflow，展开为编辑、构建、校验和 binding 派生；不是新的整轮黑盒 provider |
| `ctx.evaluate` | 在明确任务、指标和测量条件下执行 agent | 根据能力映射 execution.rollout / model.evaluate；返回含原始证据引用的 Evaluation |
| `ctx.train` | 提交冻结训练计划，得到模型候选或 no-update | 复用 training.slime 等 provider；返回 TrainResult，不自动选择或发布模型 |
| `ctx.select` | 确定性比较或调用作者自定义选择策略 | 检查测量可比性；LLM judge 需要独立受管理角色步骤，不能藏在纯 helper 中 |
| `ctx.parallel` / `ctx.map` | 声明一批独立步骤并稳定汇合 | Campaign 操作批次；运行配置控制并发，结果按声明顺序或稳定 item ID 返回 |
| `ctx.compute` | 执行并封存重计算昂贵或带随机性的本地策略 | 持久本地 provider；只允许纯计算，不自动把任意副作用函数变成可恢复操作 |
| `ctx.result(agent)` | 声明本次运行选中的版本 | 在终态事务里保存结果并更新本 Campaign 绑定；不部署服务、不写旧 champion |

`Evaluation` 保留任务逐项状态、采样、环境、指标/judge 版本和证据。同一任务/采样条件下对不同 Agent 的测量可以比较；更换 judge、任务目的或采样条件需要新的比较合同。训练、搜索选择和最终独立评估的数据用途分别封存，同集评估必须显式配置，不能把暴露过的集合重新命名为 held-out。评分是 0、执行错误、证据不完整和未评估分别表示。`ctx.evaluate` 的默认策略可在基础设施错误时停止当前步骤；显式批量容错通过 typed outcome 开启，不能把错误隐式转换为 0 分。

论文专属逻辑仍留在 recipe/作者代码：RHO 的 coreset 与软偏好、GEPA 的 archive 和分阶段选择、AHE 的预测与回滚、Evo 的批内固定 Skill/批末更新，不强制压进同一个 generate-evaluate-select 模板。

### 3.3 模型权重训练

```python
@algorithm
async def train_and_select(ctx):
    parent = ctx.initial_agent
    trained = await ctx.train(parent, plan=ctx.training.grpo)
    if trained.kind == "no_update":
        return ctx.result(parent)

    paired = await ctx.parallel([
        ctx.evaluate(parent, tasks=ctx.data.validation),
        ctx.evaluate(trained.agent, tasks=ctx.data.validation),
    ])
    choice = ctx.select(paired, metric="pass_rate", require_improvement=True)
    return ctx.result(choice.agent)
```

`trained.agent` 的 Harness 与 parent 相同、模型指向验证通过的新 checkpoint。GRPO 的在线采样、reward、reference model、optimizer 恢复仍由冻结训练计划和 Slime 合同决定；不会把 GRPO 错写成必须先收集静态数据的 SFT。

作者层需要显式的类型适配：普通 Harness 目录引用、训练用 fixed-harness 绑定和 model-binding 必须通过已有封存/校验器转换，不能仅改 schema 名称。运行配置声明 model 是否可训练、可用 trainer 和评估路由，能力不匹配在提交前报错。

第一版映射当前固定 Harness GRPO 能力。SFT/DPO、新数据转换、新 loss 和同时修改 Harness 后继续训练，必须有相应能力与兼容性验证，不能只加一个 `ctx.train` 名称就宣称支持。大数据和权重只以制品引用经过控制通道；训练后端仍使用它自己的 Python/CUDA 环境。

## 4. 可恢复 async 的准确语义

### 4.1 选择受管理步骤重放，不保存解释器调用栈

`@algorithm` 返回可加载的 WorkflowDefinition，作者函数在隔离的解释执行 worker 中运行。SDK 把它适配成现有 Algorithm 接口：遇到已提交步骤时读取保存的结果；遇到第一个尚未提交的步骤或 parallel 批次时报告执行前沿，由 Campaign 持久化并执行。算法 worker 不直接提交模型、Hitch 或训练作业。

恢复时，从入口重新执行纯控制流，以历史结果恢复局部变量。它不序列化 coroutine、closure、线程或整个 Python/JS 堆。普通短循环不需要作者手工维护 state；高级 reducer 继续适用于完全自定义的状态机。

为了不让用户的 `except/finally` 误捕获暂停，不能用一个抛出的“暂停异常”作为公开协议。Python coroutine driver 识别 Gear await token；TS 使用受管理 thenable 和独立 worker 的前沿消息。报告前沿后，worker 停在未完成 await，由宿主关闭；不通过异常展开作者调用栈。必须用 PoC 验证 TS microtask、Python coroutine 清理和 worker 终止语义；失败时先修设计，不以可吞掉的控制异常凑实现。

### 4.2 身份、历史和提交边界

每个受管理调用具有稳定的逻辑地址：workflow/subworkflow 路径、声明顺序或显式稳定 key、重复激活序号。源码行号只用于诊断，不作为恢复身份。相同 key 在同一作用域重复必须报错；动态集合使用 task/candidate ID，不用完成先后次序。

重放逐项校验：操作类别、规范化输入、显式 agent 绑定、科学配置和结果 schema。历史未读完就提前 return、输入变化、调用顺序变化或批次成员变化，均报告 `NonDeterministicWorkflow` 并指出步骤/源码位置，在任何新物理调用前停止。改代码或依赖意味着新运行，可从已有 agent 制品开始，不默认作为旧运行 resume。

Workflow 的持久状态建议为 `historyHeadRef + pendingGroup + resultRef + runnerVersion`。历史使用追加的不可变条目/分页索引；正文和大输出走 ArtifactStore，不在每次 reduce 复制整个历史。replay adapter 只把历史 head 引用放进 `nextState`；必须由 Campaign 提交 nextState 时才能使新历史可见，不能自行修改第二个可变 head。

桥接一次 reduce 的流程：读取已提交 head → 将当前 completed 结果封装为候选历史条目 → 重放至下一执行前沿 → 返回含新 head 的 AlgorithmDecision 与下一批 operations → Campaign 原子提交。若前沿计算崩溃，旧 head 仍有效，已完成 operation 结果仍在原 journal，不新增模型请求。若制品已写入但未提交，视为不可达对象，由现有引用/清理协议处理。

框架内部派生当前决策 localKey 和操作身份。先沿用现有 kernel 的 decisionIndex/key 合同，不改变旧 provider 外部 key；workflow 逻辑地址另外用于重放验证。训练/rollout 回包不明仍保留 unknown，由原 provider inspect/reconcile，不因函数重放而换 key 重提。外部 exactly-once 不是本方案承诺。

### 4.3 作者需要知道的少数约束

- 普通计算、循环和分支可以直接写；外部请求、持久写入、训练和评估必须通过 Gear 步骤。
- `random`、系统时间、UUID、可变环境/文件不能直接影响决策。提供受管理 sampling/random、`await ctx.now()` 和 `await ctx.budget()`；这些观察结果必须保存，重放使用历史值。预算观察与控制记录由同一 Campaign 决定封存，不另记费用。
- 不使用裸 `Promise.all`、`asyncio.create_task/gather` 调度 Gear 步骤；使用 `ctx.parallel/map`。首版按批次所有成员终态汇合，不支持按最快完成结果投机竞赛。部分成员完成后崩溃，恢复只处理未完成原操作。
- 工具在运行前报告可发现的未受管理 IO/并发/随机源；静态检查不是对任意代码的确定性证明，也不是恶意代码沙箱。框架保证边界以作者遵守受管理步骤合同为前提。
- 随机优化库不直接在重放区修改活的 study。通过 `ctx.compute` 保存明确 seed、输入、输出或经 adapter 保存 sampler checkpoint；Optuna ask/tell 延用已有 adapter。带外部副作用的库可作为 opaque job，恢复粒度由其 provider 声明。
- `try/finally` 不用于释放实际外部资源；取消、资源释放和对账由 provider 管理。捕获已封存的业务错误可以重放，捕获基础设施 unknown 不得将其转成新的副作用尝试。

### 4.4 长循环与性能

每次都从入口重放可能产生 O(n²) 控制流成本。第一版必须记录此成本并设置显式历史/CPU 上限，不能以模型调用慢掩盖问题。历史结果按页、按需读取，禁止把所有结果一次塞进当前 4 MiB Python 帧。

提供具名子 workflow 和耐久循环 helper 处理长实验：`ctx.repeat(name, initial, step, count)`。每轮 `step(ctx, state, index)` 的输入和返回业务状态必须可序列化；已提交迭代保存游标与输出，恢复只重放当前迭代。它由同一 replay adapter/Campaign 维护，不启动嵌套的独立 Campaign，也不创建第二 writer/预算。普通短 `for` 仍可用；无法自动保存任意循环外的隐式局部变量。

同样，子 workflow 的输入显式、实现身份固定，完成后父流程复用其结果；一个子 workflow 内部展开的操作保持可观察。这一机制与组内部分完成、预算、取消和 active binding 的一致性必须独立验收后才用于真实长流程。

## 5. 让运行配置也变简单

不能把作者函数缩到 30 行，却要求每个作者手写数百行 host 配置。新增声明式 RunSpec（与现有 schema v1 并存），CLI 解析成完整现有 CampaignSpec/host profile，并生成可查看的冻结 lock。

作者配置目标形态：

```json
{
  "schemaVersion": 2,
  "kind": "algorithm-run",
  "algorithm": "./algorithm.py:search",
  "runtime": "team-tb21-luna",
  "agent": "baseline",
  "data": { "search": "tb21-small" },
  "config": { "rounds": 3, "candidates": 4 },
  "budget": { "taskRuns": 180 }
}
```

以上别名必须由运行配置解析成确切版本/来源/用途；不是字符串匹配即授权。runtime 的成本映射将 taskRuns 等用户维度展开到明确 source/unit/capability 的底层预算；不存在唯一映射时 check 报错，不能悄悄丢掉不认识的限制。真实 token/GPU 用量仍按 hard/stop 能力如实显示。宿主设置预算上限，作者只能在范围内设置本次配额。

团队维护 runtime profile：Hitch/编译器、模型注册与目的地、角色能力、数据别名、baseline agent、可选 Slime、运行资源闭包和凭据引用。算法包维护角色 prompt/输出 schema；不能让每次改 prompt 都变成管理员修改宿主源码，也不能通过改 prompt 扩大文件权限或数据可见范围。管理员配置一次后，纯 Python 作者不必编写 TS 宿主模块。

`algorithm init ... python|typescript --template search|training` 拟新增真实骨架，默认纯所选语言，不插入跨语言 toy hook。CLI 继续用 check/run/resume；新 run 自动分配 campaignId，resume 必须指向确切运行 ID 或独立目录，避免误恢复“最近一次”。新增 inspect/explain 输出解析后的模型、数据用途、能力、预算与实际调用流程。

check 分开列出静态项目检查、运行配置能力检查、可选真实连通性预检；只做静态检查不能声称模型可运行。生产 adapter 查询元数据的网络行为要清楚显示。训练模板不默认下载权重、安装 Torch 或申请 GPU；缺少能力指出具体缺项。

保持：Node 负责宿主，Python 作者包轻量。Python 和 TS 使用一个受版本约束的命令/结果协议与相同黑盒合同；语言 SDK 可各实现解释和类型包装，但每个科学算法只有一份实现。

## 6. 扩展范围与科学边界

| 算法范式 | 作者层组合 | 不隐藏的科学约束 |
| --- | --- | --- |
| Harness 搜索/GEPA | evidence → diagnose/propose → staged evaluate → select | archive、预算、修复、早停和晋升条件属于 recipe |
| RHO | 历史 coreset → 重复 rollout → 编辑 → 成对偏好 | 保留无标签研究输入与原软偏好准则，不能用 pass rate 替代 |
| AHE/Evo | 预测与验证/回滚；批任务与 Skill 更新 | 测量版本和最佳版本分离，批内绑定不变 |
| 模型训练 | train → 对齐条件下的 paired evaluate → select | 精确 parent/checkpoint/optimizer、训练与测试 partition |
| Harness 与权重交替优化 | Agent 保留两类版本，编辑/训练分别返回候选 | 需要实际 backend 支持变化后的 Harness 与训练合同 |
| 任务/课程、评价器共演化 | 不可变任务或 evaluator 制品、重新测量、作者自定义 epoch | 更换 judge/rubric 后旧分数不可直接比较；需要锚点评估/重评策略 |

后两行是扩展方向，不计为首版已实现能力。通用层提供版本、记录和操作组合，不提供一种能替代所有论文选择准则的通用分数。当前通用 Hitch adapter 的 schema v2 数据资源支持缺口需要单独解决；本 SDK 不把这个接线缺口藏在高级 API 下面。

## 7. FailureClusterSearch 怎么迁移

先保留已验收的公开 Campaign 路径与冻结 oracle，不边写作者 SDK 边大幅改等价基线。当前 `src/search/campaign-engine.ts` 继续负责旧服务接线，兼容文件不会因作者 API 出现而自然消失。

作者层通过真实 RHO 和固定 Harness GRPO 后，再以高级 workflow 重写一份 FailureClusterSearch 并做影子比较。期望按科学阶段组织：一个可读的 round 编排入口，父代/聚类/阶段选择的纯策略模块，以及可复用的受管理评估/生成能力。不是追求整套 GEPA 只有一个小文件，也不允许在 `ctx.step` 中调用旧整轮 `run` 来伪装简化。

每一步必须保持原逻辑任务与候选身份、阶段决策、测量条件、剩余预算、时钟边界、失败和恢复行为。新 Workflow 历史允许不同，但实际副作用顺序、原要求的外部 key 和公开 Search 投影必须按既有合同匹配。通用 grouping 不能无意增加一个 phase 就改变 generation deadline 或预算生效时间。

保持现有 35 项冻结旧实现差分、完整 Search 回归，新增 workflow 边界丢回包/重放检查。特别是单写者、archive/champion 发布、失联模型 turn 和未释放训练资源，不为缩短示例绕过。现有 Linux 千任务 90 秒门槛未通过，仍单独标注；新增 replay 开销不得掩盖既有性能问题。

## 8. 实现落点与阶段

拟新增代码路径，而非当前已存在文件：

| 位置 | 工作 |
| --- | --- |
| `src/algorithm/author/contracts.ts` | WorkflowDefinition、typed Agent/TaskSet/Evaluation、命令协议 |
| `src/algorithm/author/replay.ts`、`history.ts` | 重放适配、历史索引、前沿、分支与结果校验 |
| `src/algorithm/author/context.ts`、`operations.ts` | 作者 API、通用 helper 与现有 provider 映射 |
| `src/algorithm/author/workflows.ts` | 子 workflow、repeat/map、显式阶段输出 |
| `src/algorithm/hosts/` 与 `packages/python-sdk/src/gear_algorithm/author/` | TS/Python worker driver、类型包装、异常定位 |
| `src/algorithm/cli.ts` / `loader.ts` / `configured-host.ts` | 新定义加载、RunSpec 展开、运行配置与冻结身份 |
| `examples/algorithms/author-*`、作者文档 | 包外可运行搜索/训练模板和恢复教程 |

优先不改 OperationProvider/预算协议；确需新增持久控制记录时走版本化合同和原子提交测试，不在 SDK 另写可变日志。provider能力与schema映射集中管理，不能散落在每篇论文分支里。

| 阶段/提交 | 交付 | 完成条件 |
| --- | --- | --- |
| A0：接口与恢复 PoC | 两语言顺序/分支/小循环、worker 前沿、最小 fake provider | 暂停不被作者异常捕获；重启不新增已完成副作用；输入/控制流漂移拒绝 |
| A1：持久作者层 | typed refs、并行部分完成、分段历史、repeat/subworkflow、预算观察 | 同一 Campaign 原子提交；控制流和 Python 帧大小测试；长循环性能报告 |
| A2：真实搜索与配置 | profile 复用、propose/evaluate/evidence、纯语言模板 | 仓库外 Python 作者能跑真实非 toy 搜索；源码无私有 import、reducer 或 host TS 接线 |
| A3：Python RHO 作者路径 | 原科学策略复用、高级 workflow、公开策略替换 | 新旧固定输入结果与物理操作比较一致；checkpoint恢复一致；单份科学实现 |
| A4：训练作者路径 | Slime train/model.evaluate 包装、独立部署环境映射 | CPU故障合同通过；具备设备时另做真实GPU；未做GPU不得宣称端到端已验证 |
| A5：FCS 可选迁移 | 高级科学编排入口、旧 facade 保留、影子比较 | 所有既有等价门禁通过后才替换公开路径；阶段提交和独立审计 |
| A6：作者可用性验收 | 两名未参与实现的开发者按文档完成任务 | 不修改核心、不求助作者；记录卡点和耗时，不以 agent 自测冒充人工验收 |

A0 若暴露 async 无法可靠停在受管理前沿，先解决协议，不向后推进功能堆叠。A1 的 benchmark 用无模型 fake provider 单独衡量重放成本；包括 1,000 次串行边界、10,000 个声明操作、1,000 轮具名 repeat 的 cold resume，记录墙钟/CPU/内存/历史读取量，避免只报告模型总耗时。阈值在 A0 的固定 CI 机器基线上预先冻结，失败不能靠放宽阈值计通过。

人工验收目标：熟悉 Python/TS 的研究开发者在已安装 SDK 和运行配置的环境下，30 分钟内完成一个搜索变体，半天内完成一个新的多阶段算法骨架。前者不写 provider/reducer/RPC，不手填 digest；不把安装GPU环境耗时排除后宣称全链路开箱即用。行数可作观察指标，不能作为隐藏配置或科学步骤的理由。

## 9. 交付判断

第一优先级是 A0–A3：证明高级接口确实降低真实 Python 算法的作者负担，同时保留恢复语义。随后覆盖训练，再考虑把经过严格等价验收的 FCS 切到新作者层。

这个方案没有承诺任意 async 程序都能恢复，也没有承诺 provider 能给出外部 exactly-once。它承诺一套明确的受管理步骤模型：开发者写科学流程，Gear 把每个实际动作和已观察结果封存，并在同一预算和身份合同下继续执行。

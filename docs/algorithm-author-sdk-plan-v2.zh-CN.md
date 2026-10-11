# Gear 算法作者 SDK：修订方案与源码可行性评估 v2

状态：设计与实验验收方案，2026-09-25；未开始本方案实现。本文取代 [第一版草案](algorithm-author-sdk-plan.zh-CN.md) 作为后续实施依据；第一版与 [Sol xhigh 独立评审](algorithm-author-sdk-plan-review-sol-xhigh.zh-CN.md) 保留不变，便于对照。

核对源码 HEAD：`a5011e879e11586c9b62da2ba894944d61fb7541`。被评审第一版的 SHA-256：`78b4649acc242efefc5416c4a93b8777953ea36efd0b77784b74de184da178c1`。以下“已有”来自本次源码检查；“拟新增”是设计；可行性评级是工程判断，不等于 PoC 或测试已通过。本轮没有重新运行历史测试、真实模型或 GPU；只执行了文末记录的一项有限内核探针。

## 1. 修改后的结论与首期范围

总体可行，适合增量建设。现有 Campaign、不可变制品、绑定、任务/证据授权、真实 Harness 执行和 Slime 操作提供了可复用底座。主要工作是一个新的作者适配层、通用能力宿主和可用的运行入口，不是重写调度与训练系统，也不是增加几个函数别名就能完成。

首期交付面向真实短流程：纯 Python/TS 算法、顺序/分支/稳定并行、角色调用/编辑/评估、可持久研究输出、原子观察、配置复用，以及明确的继续运行行为。科学算法只维护一种语言的一份实现。

首期先不迁移公共 FailureClusterSearch、不改现有固定 GRPO 的科学判定、不自动迁移旧 journal。耐久 repeat、复杂子流程、在线事件流、新训练方法和评价器共演化分阶段建设。普通短 `for` 在重放合同成立后支持；不承诺任意 async/第三方 IO 都可恢复。

最先验证两个问题：新 async 执行前沿是否可靠；一个全新的 Python 算法能否复用运行配置而不改 Gear 核心。RHO、训练和 FCS 的迁移都在这两个问题之后。

## 2. 已有代码到底能复用什么

下列位置相对于仓库根目录；行号对应上述源码快照。

| 现有部分与代码证据 | 已经实现的能力 | 本次处理与可行性 |
| --- | --- | --- |
| `src/algorithm/contracts.ts:87,140` | Provider 生命周期；Algorithm 的 describe/initialize/reduce | 保留合同；新作者定义由 adapter 实现 Algorithm。高可行性 |
| `runtime/engine.ts:243,561` | 决定/操作原子推进、稳定 ID、预算、逐项结果、组内全部终态后 reduce、unknown 对账 | 首期不改核心状态机；复用同一个 writer/账本。高可行性 |
| `runtime/providers.ts:10,59` | BindingDeriveProvider 的确定性操作模式；LocalDurableProvider 的落盘与 inspect | 复用接口和模式；不能误用 started→unknown 的 helper 实现可安全重算的控制步骤 |
| `artifacts.ts:20`、`bindings.ts:6` | JSON/bytes 内容寻址、摘要校验；固定 schema 下创建/派生绑定 | 保存历史/输出与 Agent 绑定；不改现有 CAS 格式。高可行性 |
| `data/measurement.ts:43,85,93` | 冻结测量条件、比较 key、证据引用、重评关联 | Evaluation 包装这些记录，保持不可比性校验。高可行性 |
| `data/tasks.ts:16,66,101`、`research-profile.ts:79,125` | 任务用途/暴露约束、任务选择/消费、授权经验视图；已有任务发布纯函数 | 复用现有授权；纯函数存在不等于公共 tasks.publish operation 已接好。高可行性 |
| `providers/roles.ts:554`、`workspace-edit.ts:612` | 真实 DSH 角色与受限 Git 编辑、证据读取、结果封存 | 复用物理能力，新增通用装配。中等风险 |
| `providers/hitch.ts:81,520`、`data/fresh-rollout-context.ts:16` | 精确 Git revision、任务证据、Hitch rollout 和独立 fresh context | 可用于新算法；仍依赖冻结 EvolutionSpec、schema v1 编译数据集、有限采样合同，须在 profile 展开时处理 |
| `configured-host.ts:18,89,132`、`default-host.ts:45,51,85`、`fresh-profile.ts:47,62` | 可运行但只装配 rho/ahe/evo；角色、binding 和任务接线按 recipe 分支 | 新增通用能力宿主，不再给 recipe enum 加分支。旧入口保留。中等风险 |
| `loader.ts`、`hosts/python.ts`、Python `worker.py:141` | 闭包身份、两语言加载、Python RPC、低层 reducer/provider 调用 | 新增 author runner 模式与受限前沿协议；现有同步 dispatch 不直接执行 coroutine。最高技术不确定性 |
| `hosts/python.ts:192`、Python `worker.py:23` | artifact.get 整块 base64；4 MiB 帧 | 新增有界读取/分页协议；仅 state 存 ref 不能解决大响应问题 |
| `providers/training-mapping.ts:62,71,86,111` | 训练 CAS 绑定、固定 Harness 校验、精确 parent/checkpoint、原 key 映射 | 高度复用；训练作者 API 主要是 typed 适配和宿主装配 |
| `providers/training.ts:39`、`model-evaluation.ts:68`、`recipes/grpo.ts:30` | Slime 作业 lookup/恢复；模型评测；固定 Harness GRPO 的 dev/held-out 判定 | 后续包装，CPU 合同与真实 GPU 分开验收；不能把训练例子改成单一平均分门控后声称等价 |
| `cli.ts:259,361`、`engine.ts:617` | init/check/run/resume；runUntilBlocked 默认最多 100 ticks，waiting 时 CLI 返回并关闭 worker | 新增作者运行驱动、静态能力解析与简化配置。中等风险，不能仅换模板 |
| `runtime/store.ts:103,126` | 完整链校验的读取；commit 再读取旧 head；POSIX 单写者锁 | 先测现有成本；重放分页不会消除 store 的累计开销。长实验发布须另设性能门 |
| `runtime/identity.ts:6`、`data/identity.ts` | 内核源码闭包、provider/宿主及环境身份冻结 | 扩展入口尽量新增文件；升级仍可能改变 loader/provider/package 身份，旧运行继续用原封存包 |

可直接复用的是协议、数据与物理能力。新的 async runner、通用 profile、研究输出和新的 CLI 体验目前不存在，必须作为真实开发工作安排。

## 3. 对评审意见的具体修正

### 3.1 预算/时间观察：选定普通 operation 路径，暂不修改内核纯提交规则

不新增“无操作非终态决定”。新增一个内部纯本地 provider `author.observe`，符合已有 OperationProvider：

1. 作者 worker 遇到 `await ctx.budget()` 或 `await ctx.now()`，只报告观察请求，不先获得新值继续决策。
2. 主机侧 author adapter 在当前 initialize/reduce 边界取得 `context.budget` 或受控 host wall clock。封存 `{kind, value, campaignId, decisionIndex, snapshotDigest}`；这里的版本标识表示该决策边界的观察，不假装是未提供的 journal 序列号。
3. 将冻结值作为 `author.observe` 的输入，连同 pending logical address 返回 AlgorithmDecision。设置 `limits={}`、无计量维度、`startsBudgetClock=false`；provider preflight 不提升时钟启动权限。
4. 原 Campaign 先提交意图，然后该纯 provider 返回冻结值。下一次 reduce 才把结果送回重放中的 await。它不读取当前余额或当前时间，不需要网络，也不创建额外账本。
5. 提交前崩溃：该观察尚不存在，可以在下一次规划重新采样，且作者没据其提交任何下游效果。提交后崩溃：冻结值已在 envelope，重复 submit/inspect 只返回同一值。丢回复也可由冻结输入确定性恢复。

实现参考 BindingDeriveProvider 的确定性行为，或新增专用可安全重算的纯 provider；不能直接套 LocalDurableProvider 后把“started、未写结果”的纯观察永久卡成 unknown。真实模型/训练 unknown 仍遵循原合同，不扩大其重放权限。

该方案满足 engine.ts 对非终态必须有操作/投影的要求，首期不需修改 contracts.ts/engine.ts。代价是观察多一个受管理边界、journal/IPC 开销；会计用量为零不代表 CPU/I/O 免费。`budget()` 是边界上的已观察余额，不是并发后台资源的持续实时读数；预算限制仍由当前 kernel/provider 强制执行。wall clock 不是单调 deadline，时钟回拨和已有 deadline 行为另测。

准入和 typed runner 只允许内部 adapter 构造观察 envelope；作者不能把任意值冒充真实账本快照。继续保留“可信作者代码、非恶意代码沙箱”的边界。

### 3.2 宿主配置：新增能力装配，保留旧 recipe 工厂

新增 `createCapabilityHostProfile` 与可冻结的 RuntimeProfile。它不含 `recipe: rho|ahe|evo`，按能力装配已有底层端口：

- 数据源/用途/读取权限：FreshSeedExperienceSource、createResearchProfileFromSource、TaskViewAuthority。
- 角色与编辑：createDshStructuredAdapter、createWorkspaceEditAdapter。
- 执行与测量：HitchRolloutPort / VerifiedExecutionAdapter、受信 feedback 与 MeasurementRecord。
- 绑定、制品和可选训练：BindingStore、现有训练/模型评估 provider。

首次实现不把旧 configured/default/fresh host 直接改造成新接口，以减少已有 recipe 恢复身份和科学行为变化。通用入口重用下层实现，只新写装配；旧 recipe 固定角色/用途/回滚约束继续保留为旧 preset。之后若要抽取共享组装函数，单独评估闭包身份影响并做对照测试。

RuntimeProfile 管理：允许的 provider 和角色模板、模型目的地、文件/证据权限、数据/初始 Agent 别名、预算来源和预留、schema/capability、安装依赖闭包。算法包管理：角色名字、prompt、输入/输出 schema、科学策略和所需能力。

**普通作者新增角色的规则：**可在 profile 批准的角色模板内实例化新名称和 schema，例如 `my-diagnoser` 请求已有 read-only analyst 模板；不需管理员逐个给角色名称改白名单。新增工具、可读数据、写入范围或模型目的地则属于新能力，须由宿主配置提供。最终 resolved manifest 冻结实例化后的精确角色集合、schema、prompt 和授权，恢复期间不重新解释可变配置。

RuntimeProfile 对已有 EvolutionSpec 的映射仍有实际工作：冻结任务、模型、Hitch、采样和资源字段，生成兼容的 fresh context；这份展开结果由 inspect/explain 展示。schema v2 资源数据集、有 seed/temperature 的尚不受支持采样不得静默映射成别的执行方式；v1 的首期能力边界明确显示。

验收必须使用一个非 RHO/AHE/Evo 的新 Python 算法，增加自定义角色且复用同一 profile，不改 TS 宿主代码。录制假模型只证明装配合同，真实小任务另验收。

### 3.3 通用研究输出：首期就支持，不把 archive 藏在内部历史

保留 `ctx.result(best)` 简写，同时增加：

```python
archive_ref = await ctx.checkpoint(
    "population", archive, schema="my-search.population.v1"
)
return ctx.result(
    selected=best,                      # 可省略；有些算法没有单一 winner
    outputs={"population": archive_ref},
)
```

checkpoint 接受可序列化值或 typed ref。SDK 把 Agent/Evaluation 包装对象编码为绑定/证据引用，不要求作者手写 digest。schema 来自冻结算法包；内置有严格定义的证据 schema 不能被用户自定义同名对象伪装。大数据走分块 artifact，checkpoint 只保存根引用。

新增 `author.checkpoint` 纯持久操作：验证输入引用/用途、封存 OutputEntry，按稳定操作 key 返回 ref；与 observe 相同通过已有操作合同提交。运行中 checkpoint 可被 inspect 发现；终态 AlgorithmDecision.nextState 内的 `outputsRef` 发布最终 OutputManifest，并按显式 selected 值更新本 Campaign 绑定。返回结果和绑定在一个提交里可见，不更新生产服务或旧 champion。

OutputEntry/Manifest 明确：名称、schema/ref、产生的 campaign/逻辑步骤、父引用、subject binding、证据引用、用途/暴露标签。来源由 SDK/journal 填写；普通作者声称“verified”不能变成受信来源。archive 保存非 winner、谱系和逐任务统计；通用层不规定哪些成员值得保留，也不把 select 的非退步默认值变成引擎规则。

跨运行导入限定首期在同一受信宿主的明确 source campaign：新 profile 校验源 OutputManifest、可达引用和允许用途，将需要的对象复制/登记到新 ArtifactStore，再产生输入引用。持有 hash 不等于有权读任意历史实验；也不能只复制外层 ref 而漏掉对应 binding/模型 CAS。权重物理搬运仍由模型存储能力处理。通用 refs 图由 schema 声明边，不依赖扫描任意字符串猜依赖。首期 Campaign 全量保留制品，不引入会误删 archive 子引用的 GC；将来清理必须从 committed outputs/history roots 计算保留集。

### 3.4 Agent、模型与测量：明确两类能力，不制造不存在的统一槽位

一个运行仍只有一份冻结 BindingSchema，复用当前 BindingStore；不允许运行中因为训练一步就偷偷增加 learner 槽位。

| 作者对象/能力 | 底层真实表示 | 操作规则 |
| --- | --- | --- |
| HarnessAgent | `harness.directory.v1` binding，及冻结 execution profile 引用；可含受支持 Skill binding | 用现有 Hitch rollout；模型路由来自该 profile，不能伪造一个可训练模型槽 |
| TrainableAgent | `training.model-binding.v1` learner + `training.fixed-harness.v1` 等预声明 binding | 用 training.slime / model.evaluate；父模型与训练 CAS 精确对应 |
| TaskSet / Environment / Evaluator | 独立版本化 refs | 不强塞进 Agent；测量条件继续冻结这些版本 |
| Evaluation | MeasurementRecord + 逐任务状态/原始 evidence refs | 保持现有 comparisonKey；不同 evaluator/rubric 条件不直接混算 |

公共 Agent 包装包含 binding 引用、类型/能力描述和来自宿主的执行/训练配置引用；包装中的能力描述不作为权限凭据。具体实际能力由已封存 profile 和 schema 推导。`ctx.train` 在准入前校验 trainable capability，再通过 resolveFrozenTrainingBindings/mapFrozenTrainingRequest 校验 parent、fixed Harness、reference model、checkpoint、数据和预算。

训练结果派生的 learner binding 必须通过 model.evaluate 路由使用实际新权重；不能传回 Harness rollout 然后继续调用固定旧模型。固定 Harness GRPO 的 dev gate、held-out gate、资源释放和 no-update 都保留，不用演示性 `select(pass_rate)` 替换现有科学合同。

Harness 与权重交替优化需要初始 schema 同时预声明合法槽位、编辑后重新封存训练 Harness 的兼容转换及相应 backend；不计入首期。训练 editor 与训练 target 的角色绑定也需显式区分，后续提供，不能假定更新任意模型都会自动影响 optimizer。

### 3.5 async 前沿、分页和性能：定义 v1 可验证的边界

新增 WorkflowDefinition、author runner 与 replay adapter；现有 Algorithm 接口不变。Python 增加独立 author driver 模式，TS 用隔离 worker；两边共用版本化请求/结果 schema，而不是两份科学算法。

worker 到达新 Gear await 时报告 frontier 并停住，Campaign 决定提交前不执行外部动作。不能用可被用户捕获的暂停异常。前沿请求、历史匹配、重复 await、同一步骤被并行重复消费、早 return、输入漂移、try/finally 和进程关闭均纳入 PoC。检测到不受支持 await 或未受管理并发时给源码位置错误；静态分析不承诺证明任意 Python/JS 纯度。

state 保存 `runnerVersion/historyHeadRef/pendingGroup/outputsRef/resultRef`。结果页和引用先写入 CAS，只有 nextState/operation 提交后才成为可发现根。下一个 reduce 将 current completed 按冻结 pendingGroup 匹配并追加历史，再从已提交历史重放。不得利用 artifact.put 回调写第二个可变 workflow head。

分页协议首期建议：每个历史页的编码 JSON ≤256 KiB；大条目只存 ref；author RPC 的每个编码后消息 ≤1 MiB，低于旧 4 MiB 安全上限；制品分块每块原始 bytes ≤256 KiB。digest/cursor/offset/length 都校验，worker 只能读取 profile 授权且已进入当前输入、历史或输出闭包的引用。真实 trace 继续走已有受限 evidence provider，不因为新增通用 artifact reader 扩大可见性。

现有 `FileArtifactStore.getBytes` 为整块读取，不能假装新增 chunk RPC 就得到磁盘流式 CAS。首期历史从一开始拆成小对象；大模型/轨迹返回专用 refs。若分块读取旧大 artifact，主机可验证整块后在有界缓存中切片，但明确计入内存/IO成本，防止每取一块都重解码完整64MiB对象。真正流式大对象存储属于单独版本化扩展，不修改旧 CAS 编码蒙混过关。

**发现的额外性能风险：**CampaignStore.load 会遍历整个 journal 链，commit 再调用 load；kernel.tick 还会获取跨进程锁。只优化 replay tape，整体仍可能产生高累计成本。首期显式限制短流程（初始目标最多 200 个 workflow 前沿、另设操作预算；具体发布阈值由固定机器 PoC 预先冻结），到达上限时 controller 在提交下一个新意图前报告 `AuthorStepLimitExceeded`，保留已提交状态且不宣称完成；相同配置 resume 仍受同一上限约束。需要更大范围时从明确 checkpoint 创建新运行，不能借重启绕过上限。

先记录现有 store 成本与新增 runner/历史读取成本，再决定是否为新 author runtime 增加兼容的缓存/索引后端。未经验证的性能优化不修改旧 Search oracle或放宽原超时。1000边界/10000操作/1000轮 repeat 是后续长流程发布门，不是短流程 v1 的隐含承诺。repeat/subworkflow 的耐久状态合同在真实作者试用后确定，避免先造第二个引擎。

### 3.6 CLI：增加持续驱动，不把 waiting 当作结束

当前 algorithmCommand 一次调用 runUntilBlocked；waiting 时输出后关闭 worker。这是已有低层命令行为，新高层算法不能要求用户每个异步阶段手动 resume。

新增 author runner controller，调用现有 runtime.tick：advanced 则继续、waiting 则按 provider状态有界退避后继续、complete 则输出运行结果。设 CPU/决策工作量上限，未知外部状态明确为 needs-reconciliation，不通过重试次数换新 key。默认前台跟随；显式 detach/退出只结束观察进程，取消外部作业必须走原 cancel/释放合同。进程退出后使用精确 run ID resume。

controller 是同一 Campaign 的驱动循环，不另建作业状态或账本；进度来自已提交 journal/outputs。当前内核每批最多处理 8 个 pending 操作，v1 保持该实际语义，不先暴露一个未实现的任意并发配置。任务失败的 fail-fast/collect 策略、超时和 cancel 引用实际操作身份。

新增 RunSpec v2/运行目录 lock/静态 check/预检/inspect/explain；schema v1 低层配置保持支持。解析后的 snapshot 包含真实profile、角色prompt/schema、数据用途、版本和预算映射，恢复读取 lock 并复核原身份，不重新解析变化后的别名。观察循环节流避免大量相同 running 回执生成日志；如需内核合并无变化记录，作为单独测量后决定的优化，不能预设已实现。

## 4. 最终作者形态

仍保留普通 async 函数，并增加科学输出：

```python
@algorithm
async def search(ctx):
    best = ctx.initial_agent
    population = []
    tasks = await ctx.tasks.sample(ctx.data.search, count=10)

    for _ in range(ctx.config.rounds):
        baseline = await ctx.evaluate(best, tasks=tasks)
        proposal = await ctx.propose(best, feedback=baseline,
                                     role="optimizer", count=4)
        measured = await ctx.parallel([
            ctx.evaluate(agent, tasks=tasks)
            for agent in proposal.candidates
        ])
        population.extend(measured)
        best = ctx.select([baseline, *measured],
                          metric="pass_rate", require_improvement=True).agent

    archive = await ctx.checkpoint("population", population,
                                   schema="example.population.v1")
    return ctx.result(selected=best, outputs={"population": archive})
```

这只是可运行目标形态下的简单搜索，不是 GEPA/RHO 论文复现。复杂父代选择可以完全不用 ctx.select；population/checkpoint 不要求成员是 winner。RHO 仍保留无标签研究、成对 self-preference 与原接受规则；评价器训练或蒸馏也不会被强制压成固定 pass-rate gate。

作者项目使用 algorithm.py/algorithm.ts、RunSpec、必要的 prompts/schema。宿主管理员一次性安装 profile；作者在已有能力内增加角色和改科学逻辑无需写 host.mjs。v2 的新增 API 仍未实现，不能现在直接运行上述示例。

## 5. 需要修改哪些文件

“新增”为计划文件；同名旧源码首期原则上不动，除下表明确列出的入口适配。最后文件数量由 PoC 决定，不用未经实现的精确行数估计冒充工作量。

| 工作包 | 拟新增 | 现有修改/复用 | 主要风险 |
| --- | --- | --- | --- |
| 作者合同与重放 | `src/algorithm/author/{contracts,replay,history,context}.ts` | 实现已有 Algorithm；调用现有 kernel/store | 中高：跨语言前沿与身份正确性 |
| 纯控制与输出 | `author/{control-provider,outputs,import}.ts` | 使用 OperationProvider、ArtifactStore、BindingStore | 中：观察原子性、来源/跨运行 refs |
| 两语言 worker | `hosts/author-*.ts`、Python `gear_algorithm/author/` | loader.ts 新模式；hosts/python.ts 新协商/有界读；保留旧worker分派 | 高：async语义、退出、消息大小 |
| 通用能力宿主 | `author/{capability-profile,capability-host}.ts` | 复用 research/roles/workspace/Hitch 下层接口；旧三recipe工厂保留 | 中高：真实接线与角色授权，不是仅改enum |
| 用户对象/操作 | `author/{agent,evaluation,operations}.ts` 与 Python 对应wrapper | BindingStore/MeasurementRecord/物理provider | 中：合法schema与真实路由 |
| CLI/运行驱动 | `author/{run-spec,runner,inspect}.ts`、模板 | cli.ts、loader.ts、公开export/包验证脚本 | 中：waiting继续推进、配置冻结、停止语义 |
| 训练作者包 | `author/training.ts` 与 Python wrapper | training-mapping/training/model-evaluation/grpo | 中高：CAS/权重路由；GPU依赖独立验证 |
| 性能与长流程 | 后续 `author/workflows.ts`；必要时独立store backend | 优先基准当前 store；不先改变旧持久格式 | 高：累计journal验证与锁/重放成本 |
| FCS 作者迁移 | 后续科学编排入口 | 最后改 recipes/gepa*、campaign-engine；保留既有oracle | 高：等价、时钟与物理key边界 |

首期预计涉及约 6 个工作包及对应测试/文档；是中等规模 SDK 工程。无需重写 Slime 训练循环、Hitch执行器、模型协议或 Search科学策略。确切工期在 A0 两语言前沿和真实profile装配探针之后评估。

## 6. 兼容与发布策略

1. kernelImplementationDigest 明确包含 contracts/artifacts/bindings/steps/runtime 等字节；改这些文件会拒绝旧 Campaign resume。loader/Python bridge/provider身份也单独封存，新增 package export 同样可能改变某些闭包。新增文件只是减少影响，不等于零影响。
2. 固定当前 npm包、Python wheel、源闭包与运行环境作为旧运行制品；旧运行继续在该版本恢复。新 SDK 用新版本创建运行。从旧输出导入是带来源的新实验，不是假装原运行 resume。不放松身份检查。
3. 本项目现有 `docs/algorithm-baselines/f715748` 封存的是更早旧 Search 兼容基线；它不能替代本次 a5011e8/6fe2c4a 所部署实现的封存。发布前分别记录实际包和依赖，不能仅保存 Git SHA。
4. 旧 RHO/AHE/Evo与FCS公共入口先保持；作者层通过后逐个迁移，必要的纯策略抽取对旧实现影响单独对照。冻结oracle不能跟随新实现“修正”。
5. 已有 Linux 千任务超过90秒是独立既有问题。本方案可以改善作者体验，但不把这项性能失败计为已经解决。

## 7. 实验、验收与分阶段提交

这是后续执行计划，除第 9 节有限内核探针外均尚未执行。源码阅读只能确认接口与复用路径，无法替代下面的验收。

| 阶段/建议commit边界 | 做什么 | 可接受的证据与停止条件 |
| --- | --- | --- |
| A0 合同与双语言前沿探针 | 明确命令/schema；序列/分支/短循环/并行；observe和checkpoint纯操作；kernel不改 | 两语言在意图前不产生副作用，暂停不被作者捕获，观察冻结，丢回复原key；任何语言失败先缩窄语法并修方案 |
| A1 最小真实作者切片 | 有界历史、typed HarnessAgent、角色/编辑/评估、通用profile、run/resume跟随 | 仓库外新Python算法+新角色复用profile；一次小规模真实Hitch评估；另一个TS作者示例证明共同协议；不以fixture声称真实效果 |
| A2 提前人工验收 | 两名未参与实现者按文档做一个搜索变体和一个多阶段算法 | 记录耗时、管理员交互、改动文件、首次错误；已有环境目标30分钟/半天；若仍要改核心则暂停功能扩张 |
| A3 科学对照与长流程取舍 | RHO高层实现，通用archive导入；按实际需要加入repeat/子workflow | 对照原Pythonrecipe的固定输入、接受准则和物理操作；非winner可复用；另测历史/journal/锁开销后确定长流程能力 |
| A4 训练适配 | TrainableAgent、原固定GRPO科学workflow与checkpoint路由 | CPU故障测试+可用环境下的真实GPU小作业；权重确实变化并用于评测，资源释放/预算可核对；无GPU只声明CPU合同 |
| A5 FCS影子迁移 | 先影子对照，高层科学入口可读后才切换公共实现 | 保留35项冻结差分和受影响Search回归、预算/时钟/外部key；原始assertion不放宽；再做有界TB2.1接线 |

### 7.1 恢复与数据实验矩阵

- **顺序/分支：**每一个意图、结果和下一决定提交前后杀worker/controller；物理调用记录应与无故障执行匹配。
- **观察：**预算观察前后、费用回执跨边界、时钟前进/回拨；已提交值复用、未提交值不驱动下游副作用；观察不启动费用时钟、不重复计量。
- **并行：**部分完成、逆序回包、重复await、取消未释放、unknown；结果按声明地址汇合，已完成调用不重做。
- **输出：**checkpoint提交/终态提交中断；有selected与无selected；导入非winner、删除/篡改子ref、任务用途越权；公开输出与原journal来源一致。
- **对象/测量：**旧权重与新权重路由对照、假learner槽、固定Harness不匹配、不同judge/采样强行比较、invalid与零分区分。
- **协议：**超过1MiB消息/超大条目、分块断线、重复cursor、来源外artifact请求；不靠把4MiB限制直接调大掩盖问题。

### 7.2 性能与真实实验口径

固定测试机器和依赖版本，比较相同物理fake provider序列在现有低层Algorithm与新作者层的墙钟/CPU/峰值内存/读取字节/journal记录数。短流程基线在A0冻结；同时给出绝对成本与相对额外开销，不能只用总模型耗时稀释框架开销。

长流程探针包含1000串行边界、10000声明操作、1000轮耐久循环冷恢复，逐项记录是否实现/是否通过。将 replay tape 成本与现有 CampaignStore 完整链校验成本分开；若后者主导，再设计新store后端。原Search门槛继续原样保留。

真实Harness小实验用于验证角色/编辑/Hitch/证据/恢复接线，不用几道题的涨分作为SDK易用性证明。FCS后续若复用TB2.1十任务同集三轮，须单独标注同集口径与候选筛除，并与已完成实验分开归档，不混算。

## 8. 可行性判断与剩余不确定性

- **可以直接推进的部分：**作者对象包装、通用outputs、普通Operation形式的观察、测量条件与现有Slime适配，均有明确落点；不需改变底层科学准则。
- **需要真实接线验证的部分：**通用profile、新角色权限、Hitch数据/采样范围、从CLI持续驱动作业、模型权重评估路由。接口已经存在，但组合后的行为尚未验证。
- **最高不确定性：**两语言 async 暂停/重放的精确语义与长流程总体成本。必须用A0和性能探针作决策，不能以设计文本断言已经可靠。
- **应后置的部分：**开放在线事件流、复杂竞速并发、任务/评价器共演化完整策略、editor训练新方法、混合Harness/权重优化、自动代码版本迁移。首期保留typed能力和输出扩展面即可。

修订后的执行顺序是：先证明受管理步骤可靠，再证明新作者可以实际接入，再扩展科学流程、训练和旧算法迁移。这样投入优先落在用户真正关心的“开发者能不能自己写新算法”，同时保留已完成的等价与物理能力建设。

## 9. 本轮已执行的有限可行性探针

为验证第 3.1 节能否复用当前协议，使用当前 `src/algorithm` 的 11 个内核闭包文件，在临时目录用 TypeScript 6.0.3 单文件转译，再以 Node 26.5.1 运行真实 AlgorithmRuntime/CampaignStore。每个输入文件的 SHA-256 与 HEAD 对应内容核对一致。没有修改源文件、工作树 lib 或提供新 SDK 实现。

探针使用最小确定性本地 provider，不是拟实现的 async runner。流程：先提交含冻结时间/预算的意图 → 改变主机模拟时钟并重建 Runtime → 第一次纯操作提交故意丢回复，内核保留 unknown → 再重建 Runtime，provider 显式报告可安全重放 → 以原 key 返回原输入。

已通过的断言：意图中的观察先于执行封存；时钟改变后仍返回原值；两次纯 submit 使用同一 operation ID；budgetStartedAt 始终未设置；spent 始终为空且余额仍为 10。使用 3 个 Runtime 实例、2 次纯操作提交，没有模型/网络/GPU调用。这里的“重建”是同进程重新构造对象并读取落盘状态，不是进程强杀或完整故障矩阵。

这验证了“现有 kernel 接受不启动费用时钟的纯观察操作，以及其原身份恢复”这项设计选择；未验证 author RPC、async/finally、实际账单并发更新、真实时钟deadline和长流程性能。保留这些项目为 A0 后续门禁，不把五条断言表述成作者层已经完成。

第一次探针误用了工作树中陈旧的 `lib/`，该构建不识别当前源码已支持的 replay-safe，运行报错。发现后改为上述当前源码隔离转译，未降低断言。旧构建失败不作为当前源码缺陷，也不计为通过证据；这进一步说明后续验收必须绑定确切源码/构建身份。

结构化证据见 [观察操作可行性记录](experiments/author-observation-feasibility-20260925.json)。临时脚本 `/private/tmp/gear-author-observation-current-source.mjs` 仅用于本次探针；完整可维护测试应在 A0 实现时建立。

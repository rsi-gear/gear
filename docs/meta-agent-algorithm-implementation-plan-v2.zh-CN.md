# Gear 可扩展 Meta Agent：实现方案 V2

- 日期：2026-09-24；状态：根据独立审查修订的实施设计，尚未实现。
- 代码基线：创建 worktree 时同步的 `origin/dev`，`f715748dad576d3055e4a9eaab21b36015348aee`；本次没有重新同步分支。
- 分支：`codex/meta-agent-algorithm-plan`。
- Worktree：`/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear`。
- 依据：[论文阅读与架构分析](meta-agent-algorithm-architecture.zh-CN.md)、[独立审查报告](meta-agent-algorithm-plan-review.zh-CN.md)。论文事实仍以本地笔记为边界，不代表逐篇复现。
- 本文取代[上一版实施方案](meta-agent-algorithm-implementation-plan.zh-CN.md)作为后续实施依据。上一版及审查报告保持原样，保留审查引用与内容摘要的可追溯性。
- 文中类型、命令、目录和示例均为拟实现接口，不是现有 SDK；下文“首版”指待交付的软件版本，与本文的修订版本 V2 无关。
- 修订核对：原 GPT-6 Sol / ultra 审查者已针对 F1–F8 复核本版，未发现必须再修改的合同矛盾；此结论仅针对文本回应，不是新的评分或实现验收。

## 1. 本次决策与范围

保留共同范式：**有来源的观察 → 算法决策 → 版本化状态变化 → 后续反馈**。算法控制步骤、反馈、分支、接纳和停止；GEPA 是 recipe；Meta Agent 是可被算法调用的角色服务。内核负责事实记录、授权、预算、执行与恢复，不增加论文没有的晋升门槛。

本次作出以下具体调整：

| 审查项 | V2 的决定 | 实施与验证位置 |
| --- | --- | --- |
| F1：固定角色与可变模型混淆 | 固定角色定义与授权，模型/技能等通过可更新的版本绑定提供；每次运行封存实际绑定 | §4；P2 的 R1/Socratic toy 反例 |
| F2：公共 bundle 固定槽位 | 公共 `BindingSet` 使用有 schema 的命名 slot；编码代理的 Harness+model 只是 provider 视图 | §4；P2 的 tool/skill/env/curriculum 反例 |
| F3：嵌套作业承诺不清 | 首版支持受管理步骤与不透明作业；不承诺任意 callback 栈的细粒度恢复 | §5、§8；能力不满足时拒绝启动 |
| F4：角色不能按需调查历史 | `evidence.query/read` 成为首版角色工具，固定历史视图、分页、授权与查询回执 | §6；AHE overview → raw trace 验收 |
| F5：标签隔离保证过强 | 区分受管理 API 不泄漏、工作区不提供标签、OS 隔离三个层次 | §6；分别验证并报告 |
| F6：自修改与实现冻结冲突 | 算法实现变化通过带父指针的 continuation campaign；同一 campaign 不替换实现 | §10；首版只有协议反例，实际功能后续 |
| F7：Python 适配验证过晚 | 在 SDK 定稿前做 Python RHO toy、技能流 toy、Optuna 真实库适配 | §8、§11；P2 不通过就不冻结 API |
| F8：stdout 污染 | Python 控制协议使用专用本机连接；stdout/stderr 都是日志 | §7；打印与原生 stdout 写入不破坏协议 |

首个产品版本仍交付 GEPA、RHO、AHE、Evo-Harness 四个 recipe，以及 Python/TypeScript 作者入口。真实 GPU 训练、任意嵌套 callback 调度、环境生成、人工工作流和自修改运行留待后续。它们的关键状态变化先用 toy provider 检验，不能用“以后可扩展”代替具体反例。

## 2. 作者体验：常见用户不必编写事件循环

### 2.1 三档入口，共用一个协议

| 用户目标 | 用户编写什么 | SDK/平台负责什么 |
| --- | --- | --- |
| 修改现成算法 | recipe 配置与一个或几个 Python/TS 策略函数 | 步骤、事件汇合、操作身份、恢复、默认报告 |
| 编写新算法 | 有名称的任务步骤、纯决策步骤、业务状态；必要时自定义操作 | 将步骤转换为 reducer/命令，保存输出、组织循环与并行、恢复 |
| 编写特殊调度器或库适配器 | 低层 reducer，或带 checkpoint 的 operation provider | 通用日志、引用、schema、授权、计量和检查工具 |

默认文档先教前两档。低层 `initialize/reduce` 保留作为完整控制接口，不把它作为每个 Python 用户的入门要求。首版也不保存任意 Python/JS 调用栈；用户使用的步骤接口有明确恢复边界。

常见变体的拟议示例：

```python
from gear_algorithm.recipes import rho

def choose(preferences, baseline):
    best = max(preferences, key=lambda item: item.mean)
    return best.candidate if best.mean > 0 else baseline

algorithm = rho.configure(selection=choose)
```

这是拟议作者语法，recipe 负责类型化输入、候选集合非空校验和默认错误策略。合法 hook 在 recipe manifest 中列出；不支持的覆盖在 `check` 报错。已有 TS recipe 使用 Python hook 时，SDK 注册版本化 component，运行层执行并记录 `policy.decide`，用户无需写 TS 通信适配。

### 2.2 新算法的步骤接口

任务步骤返回 operation 描述；决策步骤只做业务计算，并选择下一个步骤或结束。拟议语法片段：

```python
@task("measure", then="choose", save_as="measurement")
def measure(state, context):
    return ops.rollout(
        bindings=state.proposal_bindings,
        tasks=context.views["development"],
    )

@decision("choose")
def choose(state, context):
    updated = apply_measurement(state, state.measurement)
    if updated.done:
        return finish(result=updated.selected)
    return goto("propose", state=updated)
```

这些只是完整模板中的两个步骤。`task/decision/goto/finish` 由 SDK 提供，`state` schema、`propose` 及科学选择函数由模板或作者定义。`save_as` 保存小型结果投影/不可变引用，不复制整条轨迹。具体输入输出字段以操作 schema 为准。

步骤运行有以下明确语义：

- 步骤名称在封存 manifest 中稳定。每次进入步骤有持久 activation ID；循环再次进入同一名称会获得新 activation。
- 一个任务步骤可返回单操作、`parallel(items, key=...)` 或一组声明顺序的操作。item key 必须唯一且来源稳定，SDK 不以响应到达顺序分配身份。
- 默认 join 等待所有已声明项得到终态结果；失败作为类型化结果交给失败分支，不转成零分。首版不提供“取最先到达的成功结果后遗忘其他任务”的隐式行为。
- 动态分支、循环、数据相关 fan-out 都在完成前一个步骤后决定。普通作者不处理原始完成事件、去重或 outbox。
- 任务步骤规划函数与决策步骤不得直接调用模型、读可变外部文件或修改 optimizer；这些工作使用 operation。SDK 调用语法不等于沙箱强制保证。
- 修改步骤名称、代码或 schema 会产生新实现身份；已开始的 campaign 使用原封存版本。

### 2.3 最小启动路径

```text
gear-refine algorithm init ./my-algorithm --language python --template rho
gear-refine algorithm check --config ./my-algorithm/gear.json --profile toy
gear-refine algorithm run --config ./my-algorithm/gear.json --profile toy
gear-refine algorithm resume <campaign-id>
```

模板提供 `algorithm.py`、`gear.json`、`pyproject.toml`、测试与 toy profile；TS 模板对应 ESM 构建。`run` 在前台使用 CampaignService，负责启动、状态输出和结果路径；研究者首次试验无需先理解 socket、`serve` 和 RPC。服务模式仍供长期运行和外部 Skill 使用。

用户需有 Gear 宿主/CLI 和对应语言环境。Python wheel 是作者 SDK，不谎称单独安装 wheel 就包含 Node 宿主。SDK 不强制 torch/CUDA/训练依赖；服务不自动安装依赖。真实执行 profile 单独绑定角色和 providers，可从模板继承，`check` 展示最终配置、合法 hooks、恢复粒度与预算能力。

## 3. 内核与操作合同

以下类型是语言无关协议的 TS 投影，wire schema 与跨语言 fixtures 是共同规范。

```ts
interface AlgorithmPlugin<C, S> {
  id: string
  apiVersion: 1
  configSchema: Schema<C>
  stateSchema: Schema<S>
  requirements: CapabilityRequirement[]
  initialize(input: AdmissionView<C>): Decision<S>
  reduce(state: Readonly<S>, event: AlgorithmEvent,
    context: Readonly<DecisionContext>): Decision<S>
}
interface Decision<S> {
  nextState: S
  bindingTransition?: {
    expected: BindingSetRef
    next: BindingSetRef
  }
  commands: OperationIntent[]
  outcome?: { status: 'completed' | 'failed'; resultRefs: VersionRef[] }
}
interface OperationIntent {
  localKey: string
  kind: string
  input: JsonValue
  limits?: ResourceLimits
  group?: { id: string; slot: string } // 归组，不代表嵌套执行或额外计费
}
```

相比上一版，首版不在一批命令中支持引用尚未产生的后续结果：依赖前一步输出的操作在下一次决策生成；并行的一批命令输入必须已就绪。步骤 SDK 负责编排这个过程，避免内核同时拥有隐式 DAG 和 reducer 两套依赖语义。

内核校验 schema、引用、实现/数据身份、权限、能力和预算，再原子提交状态、binding transition、命令及 reservation。transition 的目标必须是已封存且获准的组合版本。**同一决策新发出的操作使用 transition 后的 binding snapshot**；已有操作继续使用其旧 snapshot，恢复时绝不解析为“当前最新模型”。

`DecisionContext` 只含封存配置、当前投影、绑定快照、预算视图、逻辑 cursor 和明确的随机源。状态保存 JSON 和引用；模型、轨迹、库 checkpoint 使用 artifact。额外取证通过受管理查询完成。

事件至少区分 admission、operation-completed/failed、取消确认、预算不足和显式输入；operation 状态 unknown 保持等待，不转换为科学失败。重复结果按操作 ID 去重；响应到达顺序记录为事件，确定性 join 按稳定 slot 归并。算法结束前须处理未结算操作；用户取消进入 cancelling，外部执行未确认结束时不能伪作已释放额度。

内核不理解 failure cluster、四阶段评分、唯一 champion 或严格增分。archive membership、parent eligibility、active state、best measured、final selection 和 deployment 分别表达。

## 4. 动态版本：角色定义、绑定和产物分开

### 4.1 公开组合类型

```ts
interface VersionRef { kind: string; digest: string; schemaVersion: number }
interface BindingSet {
  schemaRef: VersionRef
  slots: Record<string, VersionRef>
}
interface RoleDefinition {
  id: string
  implementation: VersionRef
  bindingMap: Record<string, string> // role 局部名称 → campaign slot
  permissions: CapabilityPolicy
  outputSchema: SchemaRef
}
```

slot 名由实验/recipe schema 声明，例如 `target.harness`、`target.model`、`editor.model`、`shared.policy`、`skillLibrary`、`toolSet`、`train.environment`、`test.environment`、`curriculum`。它们不是公共内核枚举。schema 声明允许的 artifact kind、必需项、可修改项及允许的新版本来源；provider 声明本操作真正需要的 slot。

上一版 `ExecutionBundle {harness, model, ...}` 降为编码代理 rollout 的便捷视图，不能作为所有算法必须满足的组合类型。只排序已有轨迹的 feedback 操作不需新建 Harness；skill+tool 可以组成一个原子版本；课程与训练环境也可以独立成为产物。

每次操作将所需 slot 解析为不可变 `ResolvedBindings`，请求和结果记录 binding set digest、实际 materialized 内容、provider/adapter 身份与模型采样条件。声明的版本和实际加载版本不一致时证据无效。

### 4.2 什么固定，什么可变化

固定：算法实现、角色职责/实现、权限上限、数据协议、provider 实现和版本来源规则。可变化：协议允许的 artifact、绑定值、任务流 cursor 与算法业务状态。

角色的采样设置默认在配置固定；若算法需要改变采样参数，必须通过 manifest 中明确的可配置字段及范围声明，并逐操作封存，不能依赖会话全局变量。模型 endpoint 可以是部署句柄，但它必须证明所加载的 checkpoint 身份，单靠可变模型别名不能建立证据。

| 反例 | 应表达的版本变化 | 首版协议验收 |
| --- | --- | --- |
| Harness-R1 | `editor.model` 更新；`target.model` 与基础 Harness 不变；overlay 临时使用 | fake trainer 返回新版本，只推进 editor binding；下一次提案使用新 editor，target 仍旧版 |
| Socratic-SWE | generator/solver 的局部 model 都映射到 `shared.policy`；课程逐轮生成 | 一次共享 slot 更新影响两个角色；新任务视图进入下一轮，test 保持原快照 |
| SkillMaster | policy 与技能库共同推进 | 一个 binding transition 原子更新两个 slot；中断后不会出现新模型配旧技能的半提交 |
| EnvHarness | 训练 wrapper 更新，原始测试环境保持 | train/test slot 独立，评测回执指出实际环境 |
| SkillSmith | skill 与 tool 组合版本共同改变 | 原子组合、独立测量；不能继承单项修改分数 |

Git 产物沿用精确 commit/tree/manifest；文件树支持技能/记忆；结构化 JSON 支持诊断和评价；opaque checkpoint 由明确的 provider codec 管理。`code-base`、`merged-from`、`informed-by`、`trained-from`、`derived-from` 分别记录，多份参考材料不等于发生代码合并。

### 4.3 动态任务也属于版本化状态

启动时固定数据使用规则，不要求未来训练任务的内容在启动时已存在。获准的 `tasks.publish` 操作可以封存生成任务、测试/标签、生成来源和验证回执，返回新的 `TaskViewRef`；算法再将其选为 curriculum。

派生视图沿用获准的可见性与用途规则，不能把已暴露的训练任务重新标成未见 test，也不能通过“发布新视图”放宽父数据权限。验证后的训练题与固定 final-test 视图分开。首版用 toy 任务发布验证协议，完整任务生成/梯度算子留给后续 provider。

## 5. 持久执行与恢复能力分层

### 5.1 单一 journal 作为 campaign 事实来源

```text
stateRoot/
  evolutions/...                    # 历史格式
  campaigns/<id>/
    spec.json                      # 冻结实现和规则
    objects/<digest>               # 状态、绑定、决策、证据、事件
    journal/head.json               # 单写者锁 + CAS
    derived/                       # 可重建投影
    workspaces/...                  # 执行/编辑临时目录
```

先写不可变对象，再在 campaign 锁下提交 head。算法状态、binding transition、命令 outbox、reservation 同属一个提交；artifact 先封存后引用。落实 fsync、锁失效和损坏检测；不把 rename 宣称为任意多文件事务，不承诺任意网络盘可靠性。

provider 必须声明 submit/inspect/cancel、幂等 key 的范围、结果保留期限及恢复能力。操作 ID 由已提交决策和 localKey 派生，输入摘要漂移不能复用。恢复已有 reservation 时先 inspect：complete 复用、running/unknown 等待，只有确认 not-started 才能按原 key 提交。已过 deadline 仍可读取结果和确认取消。

结果身份验证后，完成事件和结算一次提交。结果不重复接纳/入账；不能据此宣称第三方网络副作用恰好一次。跨旧 registry 或发布系统时保存固定 expected/next revision 的提交意图与回执，CAS 冲突不自动重新选择并覆盖。

### 5.2 首版明确支持两种执行模式

| 模式 | 谁掌握循环 | 首版承诺 | 不承诺 |
| --- | --- | --- | --- |
| `managed-steps` | Gear recipe/步骤 SDK；库通过 ask/tell 或显式 checkpoint 步骤接入 | 每个受管理操作有身份、预算与结果；在步骤边界恢复 | 任意 Python 函数栈或外部直接调用的恢复 |
| `opaque-job` | 库/外部进程内部自行运行 | 作业级 submit/inspect/cancel、输出与实际可验证的资源用量；按 provider 能力使用 checkpoint | 自动看到内部请求、token credit，或逐内部调用取消与恢复 |

首版不支持 `managed-children`：不透明作业内再次调用 Gear 开任意子任务，不能绕过准入成为隐式嵌套模式。需要它的 manifest 会被 `check` 拒绝，不能悄悄降级。服务内的受限证据查询属于已有 AgentJob 的只读工具能力，见 §6，不开放任意子调度。

后续若实现 managed-children，须有单独能力版本：`parentOperationId + stable childKey`、checkpoint/event cursor、子权限不扩张、父预算预留的分配而非重复预留、父取消到子任务的传播、结果归属和一次结算。父容器资源与子请求资源按不同计量维度入账，不能把父报告的总量再与子量叠加。该协议未实现/验证前不宣传细粒度 callback 支持。

`group.id/slot` 仅用于 R1 patch 组、并行评测等业务归组，不能冒充上述 parent/child 生命周期；训练 token/phase credit 需要训练样本 schema 及 trainer 专门校验，不由 group 标签自动产生。

### 5.3 预算可测与可执行的边界

资源计数器有单位和来源，例如 rollout cells、请求、tokens、GPU 秒。硬上限只针对 provider 实际能拦截或终止的资源；估算、provider 自报和可验证用量分别显示。opaque-job 可强制进程时间并不意味着可强制内部 token 上限。

取消不明时保持 reservation，租约更新有 fencing；重启不能重置预算。受管理步骤的结果恢复不重新计费；不透明作业未被观测的第三方收费标成未知。最终报告写明能力范围。

## 6. 角色任务、证据调查与数据可见性

`AgentJob` 包含固定 role definition、输入 refs、已解析 bindings、context policy、输出 schema、权限、session policy、read cursor 和预算。structured-result 与 workspace-edit 是首版默认输出；会话 fresh/fork/resume 按 provider 能力声明，复用已有 Skill/DSH 生命周期。

### 6.1 角色执行期间的证据 API

```ts
interface EvidenceQuery {
  asOf: JournalCursor
  scope: { artifactRefs?: VersionRef[]; taskIds?: string[]; operationIds?: string[] }
  projection: 'overview' | 'task-report' | 'trace-chunk' | 'source'
  pageSize: number
  pageToken?: string
}
interface EvidencePage {
  items: EvidenceItemRef[]
  receiptRef: VersionRef
  nextPageToken?: string
}
```

`job.call('evidence.query', ...)` 和 `evidence.read(ref, range)` 为受管理角色提供接口。默认 asOf 固定为 job 开始时的读视图；算法明确开新 job 才观察之后新提交的全局证据。角色可以读自身获准工作区与刚产生的查询回执，但不能借此放宽全局历史视图。

每次调用按 lease、role readScope、数据协议、artifact 访问域校验，不能因为持有 digest 就获得读取权限。页 token 绑定查询、read cursor 和 scope；服务限制页大小、累计返回字节与调用量。查询结果与回执封存，包含实际视图、选择器与返回范围；角色重试同一工具调用 ID 复用回执，日志写入单 writer，不改变查询时点。

首版只做已封存文件、概览、逐题结果与轨迹分页，不做 SQL/图数据库。AHE 验收须真实执行 overview → 某 task report → 原始 trace chunk 的工具链；Meta-Harness 的跨历史候选查询使用同一权限和索引。

### 6.2 三种不同保证

1. **协议/API 保证**：受管理 API、工具返回、错误、状态投影与报告不把禁止的标签交给研究角色。
2. **工作区交付保证**：RHO 的工作区、输入 artifact 和进程配置不提供真实标签，不暴露标签文件路径或 grader 凭据；独立 grader 的资源由其 provider 保管。
3. **OS 隔离保证**：只有实际具备并验证文件/网络隔离的执行环境才能声明。用户同一系统身份下的可信本地插件属于合作式边界，普通子进程不自动防止其主动读取宿主上本已可读的文件。

验收分别检查 API 投影、工作区内容与实际隔离能力。首版可以在可信本地模式运行，但报告不能把它写成防恶意插件的隔离证明。新生成任务、视图与查询日志同样记录暴露来源；没有独立 final test 时明确说明。

### 6.3 新旧协议共存

保留 `meta.claim`、`candidate.*`、`meta.call` 的旧含义；新增 job.claim/call/complete/fail 及能力发现。新租约绑定 campaign/job/attempt/role/client/identity，不能与旧 candidate lease 混用。

workspace-edit 经授权 builder 的 check/seal 返回实际版本；structured-result 不制造假 candidate。底层生命周期可以复用，GEPA dossier、scope 和单父代 receipt 留在兼容路径或具体 recipe。

## 7. Python/TypeScript 加载与协议

公共入口：`rsi-gear/algorithm`、`rsi-gear/algorithm/testing`；Python 分发名暂定 `gear-algorithm`、导入名 `gear_algorithm`。Python SDK 与既有 `python/gear_training` 独立打包，按需加载科学计算/训练依赖。

```json
{
  "schemaVersion": 1,
  "kind": "algorithm-campaign",
  "algorithm": {
    "language": "python",
    "interpreter": "./.venv/bin/python",
    "module": "algorithm",
    "export": "algorithm",
    "config": {}
  },
  "profile": "toy"
}
```

这是模板入口片段，profile 补全所需角色、provider、初始绑定、数据规则与预算。相对路径基于配置目录；TS 加载构建后的 ESM，Python 导入封存模块。worker 提供 describe/initialize/reduce/shutdown；步骤 SDK 对宿主仍表现为相同算法协议。

**首版使用专用本机连接承载协议，stdout/stderr 只写日志。** 具体采用宿主监听 `127.0.0.1` 临时端口、启动的 worker 以单次随机凭据和 worker ID 握手，凭据通过启动通道传递且不进入公开日志；不监听公网。消息版本化并限长，带 request ID、campaign、实现身份和预期 cursor。已有连接不代表授权永不过期，重启后的旧 worker 响应会被拒绝。

这个决定消除原生库直接写 stdout 破坏 JSON 的问题；不引入远程 worker 集群或 Python 内嵌 Node。disconnect/timeout/迟到响应属于通信状态，不计作科学失败。

wire 只包含受 schema 约束的 JSON 与引用。共同数字范围、超大整数/精确十进制、缺失/NaN、规范化摘要、逻辑时钟和随机源都有 fixtures。Python/JS 对象、回调、pickle 不作为 wire 消息；大型内容经 artifact 传输。

封存代码、schema、声明资源、配置、SDK/协议、provider 及实际依赖身份；lockfile 不代替环境观测。普通算法用 venv 即可，editable 依赖先快照；本地可信代码不是安全沙箱。算法 worker 的进程缓存不作为持久状态，训练等长时操作由独立 provider 管理。

## 8. 真实 Python 库试验：提前选定 Optuna

### 8.1 验证对象与边界

选择 **Optuna 4.9.0 的 ask/tell 接口**作为首个真实库适配样例，实施时锁定该版本、Python 环境与依赖制品。它允许把参数提案与外部评测分开，并能用 trial number 回填结果，适合检验 Gear 对研究循环的接线。[Optuna 官方 ask/tell 文档](https://optuna.readthedocs.io/en/v4.9.0/tutorial/20_recipes/009_ask_and_tell.html)

这是 SDK 的实际库接入试验，不宣称 Optuna 等同 Harness 演化算法。RHO toy 与技能流 toy 分别检验论文控制流；Optuna 负责检验库状态、异步评测和中断恢复。该版本选择用于固定试验，不代表推荐所有使用者采用它。

### 8.2 首个 adapter 采用不可变 checkpoint

使用单 writer、固定 sampler 配置的 in-memory study。把完整 study/sampler 状态封存为 provider 管理的 checkpoint；`ask` 和 `tell` 都是对一个输入 checkpoint 副本执行的受管理 Python 操作，输出新 checkpoint 和小型结果。评测由 Gear 单独发起，不嵌在 `.optimize(...)` 的 Python 调用栈中。

Optuna 官方说明内存 study 可序列化保存，但跨 Optuna 版本恢复不受支持；只持久化 RDB 数据也不等于保存 sampler/pruner 状态。[保存与恢复 FAQ](https://optuna.readthedocs.io/en/v4.9.0/faq.html)、[RDB 与 sampler 恢复说明](https://optuna.readthedocs.io/en/v4.9.0/tutorial/20_recipes/001_rdb.html)

若 adapter 使用 Python 序列化格式，格式只作为受信任 provider 的 opaque artifact：宿主不反序列化；provider 只加载同环境、自己创建并核验来源的 checkpoint，不加载用户随意提供的 pickle。wire 仍只有引用。该限制写入 capability 和环境锁。

流程：`checkpoint₀ → ask 两个 trial → checkpoint₁ + trial 映射 → 两个 Gear eval → tell 结果 → checkpoint₂`。每次 ask/tell 在独立副本上计算，产出 result manifest 与 checkpoint 后再报告完成；结果丢失时 inspect 复用原 operation 输出。未产生任何封存结果且仅有私有临时计算的失败，可从相同 checkpoint 恢复计算；不能对共享可变 study 重复 ask/tell。

关闭或未使用的 checkpoint 副本可回收；当前 checkpoint 引用与 trial→operation 映射保存在同一个 campaign 提交中。这样不引入第二个掌握全局预算/任务状态的调度器。首个 adapter 不支持多个 writer 共享一个优化器实例，也不凭数据库存在就声称恢复完成。

### 8.3 SDK 定稿前必须跑通的试验

- 一个真实库 iteration 产生至少两个异步 Gear 操作，结果按稳定 trial identity 回填。
- 在 ask 完成但 Gear 未接收、评测部分完成、tell 结果已封存但未提交三个位置中断；恢复不丢 trial、不重复提交已完成评测、不重复接纳结果。
- 与不中断的相同事件顺序对照业务决策、已完成 trial 和下一次采样结果；不要求 wall-clock 字段相同。
- 独立 venv 安装公开 wheel 和锁定 Optuna，用户层没有 TS glue；adapter 只用公开 API，未导入 Gear 内部 registry。
- 刻意向 stdout/stderr 输出，包括原生 fd 写入，协议仍可完成。

adapter 是框架提供的库接线样例，其恢复代码量与用户策略代码量分别报告。若 library 状态无法按约定恢复，先修改该 adapter/作者合同，不把试验延至发布阶段。

对仅有封闭 `.optimize(...)`、没有可导出状态的库，首版只支持 opaque-job。它可能有部分运行日志，但没有任意步骤恢复保证。后续细粒度 callback 支持按 §5.2 单独开发；不承诺零修改接入任意 Python 仓库。

## 9. 首版四个 recipe 的具体验收

| Recipe | 算法流程与状态 | 必须通过的反例 |
| --- | --- | --- |
| GEPA | 父代/scope、failure cluster、workplan、local/bridge/global-seed/held-out、archive、promotion 在 recipe 内 | 相同 toy 输入下父代、任务计划、排名、晋升和预算语义保持；恢复不重抽样 |
| RHO（Python） | 历史 coreset → baseline 重复 rollout → 诊断/目录候选 → 对固定 baseline 的偏好 → 正值选择 | 最高平均偏好 `S≤0` 保留 baseline；研究输入无真实标签；不要求 executable grader |
| AHE | 评测当前已提交版本 → 核验前轮 manifest → 回滚/证据调查 → 提交下一版 | 分数绑定 executedRevision；未测版本不能成为 best measured；overview 下钻 raw trace；回滚创建新 revision |
| Evo-Harness | 固定批内 skills → 检索/实际注入 → rollout/反馈 → 批末 curator → skills/cursor 同时推进 | 实际 Target 读取该批技能；中断不重消费/重合并；无论文之外的强制 promotion gate |

RHO 的 10 个任务/3 次 baseline/3 个候选可作为论文笔记对应配置，toy 使用缩小规模并明确标注。缺失的原始提示词和复现细节标为 Gear 实现选择。四个 recipe 是第一版产品承诺，toy 通过不等于真实 provider 或论文结果已验证。

GEPA 先可用兼容 driver 验证入口，最终必须基于公共操作运行；wrapper 不计为已完成解耦。不同持久格式不强求对象 digest 相同，但各自身份和恢复都必须成立。

## 10. 旧实验与算法自身演化

### 10.1 旧 GEPA 路径保留

新 `CampaignService` 与 `campaigns` 存储独立于旧 EvolutionSpec/RefinementRound。旧 `control.*` 响应保持，新控制方法经能力发现暴露；聚合列表带 kind。发布仍是对精确 artifact 的显式独立操作。

`src/search/identity.ts` 对实现闭包逐文件字节哈希。P0 固定真正运行过的 source/构建制品、环境和恢复样本；只记 commit 不够。新目录先不改变闭包。后续若修改，旧未完成 evolution 只能由匹配原身份的制品/进程继续，单一 writer 持锁；缺原制品就报告无法恢复，不关闭校验。

从旧结果导入新 campaign 属于新实验，核验产物和证据并记录 lineage，不冒充 resume。兼容支持范围以本次基线和已有历史 fixtures 为准。

### 10.2 自修改选择 continuation campaign

**同一 campaign 的算法代码保持固定。** 后续 Gödel 类方法改变 improvement routine 时，从已提交状态创建新的 continuation campaign，记录父 campaign、父 checkpoint/cursor、新旧实现摘要、迁移函数身份、输入/输出 state schema。多段 campaign 组成可报告的一条研究 lineage；该方式支持版本化自修改研究，不等同复刻任意进程内 monkey patch。

continuation 不接管旧 pending operation，不重写旧事件；转移前必须满足声明的静止/完成边界。任务暴露记录与谱系累计成本继承，不能通过新 campaign 重置实验预算：若将来支持自动连续运行，必须共享一个已授权的 lineage budget scope。没有这项能力时不开放自动 continuation。

首版只验证迁移记录/预算边界的 toy 合同，拒绝运行中换算法字节；实际自修改执行、隔离与自动衔接后续实现。普通研究者主动修改算法再开独立实验，与自动 continuation 在配置和报告中区分。

## 11. 新实施顺序：先验证作者接口，再扩大迁移

P0–P6 为替代旧 PR 编号的新批次，每批可再拆小 PR；它们是依赖/验收边界，不是工期承诺。草案协议在 P2 之前明确为 experimental，P2 通过后才定稿 SDK v1。

| 批次 | 交付与主要目录 | 退出条件 |
| --- | --- | --- |
| P0：基线与验收材料 | 旧身份/恢复 fixtures、三条作者路径、锁定 Optuna 试验配置与协议反例 | 可重建被支持的旧运行制品；知道每个早期试验要证明什么 |
| P1：最小作者 SDK | `protocol/algorithm/v1/*`、TS API、`packages/python-sdk`、专用 IPC、步骤 helper、init/check/run 的 toy 路径、实验性内存 runner | 外部项目能只改一个策略运行 toy；两语言无需私有宿主依赖；此时不宣称持久恢复已通过 |
| P2：持久内核与适配试验 | `runtime/*`、`campaign/{spec,store}`、binding/artifact 最小 store、公开 testkit、Optuna adapter | Python RHO toy、非候选技能流 toy、Optuna 中断恢复；F1/F2/F6 的未来方法反例；全部通过后才能定稿协议 |
| P3：正式执行能力 | Git/file-tree materialization、rollout/feedback、tasks/evidence、Meta job、Skill/DSH adapters、CampaignService | job 与旧协议隔离；按需取证；真实版本回执；受管理权限/预算；能力不足准入拒绝 |
| P4：非 GEPA 产品流程 | 完整 Python RHO、AHE、Evo-Harness 示例、真实 provider 小规模集成 | 三种流程不改内核；真实技能注入、无标签软偏好、延迟归因成立 |
| P5：GEPA 新路径与兼容 | GEPA recipe、旧 runtime 路由、科学行为与恢复对照 | 旧实验可继续；新 campaign 使用公共操作；wrapper 不作为最终交付 |
| P6：发布验证 | tgz/wheel 打包、两语言真实 provider profiles、报告/教程、四 recipe 验收 | 仓库外运行及恢复；公开 API 完成全部作者路径；文档明确兼容/能力边界 |

P4 与 P5 可在 P3 稳定后并行，但不能在只有 GEPA 一个消费者时冻结协议。P1 的 init 和 run 是最小作者体验，P6 是完善发布，不再把所有易用性工作推迟到最后。

### 11.1 模块落点

| 模块 | 拟落点 | 边界 |
| --- | --- | --- |
| 语言无关协议 | `protocol/algorithm/v1/*` | schema、canonical encoding、版本/能力、golden fixtures |
| 作者与步骤 API | `src/algorithm/{api,contracts,steps,registry,loader,testing}.ts` | 编译步骤为 reducer；不能导入 DSH/Hitch 才能使用 toy |
| Python SDK/宿主 | `packages/python-sdk/src/gear_algorithm/*`、`src/algorithm/hosts/python.ts` | 轻量 wheel、步骤 API、testkit、IPC；与训练包独立 |
| 持久内核 | `src/algorithm/runtime/{runner,journal,operations,budget}.ts` | 单一事实来源，managed-steps/opaque-job |
| 产物与绑定 | `src/artifact/{types,store,git,files,bindings}.ts` | 命名 slot、schema、版本 materialization；无论文专属字段 |
| 数据与证据 | `src/algorithm/data/{views,evidence,exposure}.ts` | 派生任务视图、as-of 查询、权限/分页/回执 |
| Campaign/角色 | `src/algorithm/campaign/*`、`src/meta/jobs/*` | 状态投影、准入、生命周期、租约和工具 |
| 执行适配器 | `src/algorithm/providers/*`、Python SDK adapters/examples | 运行、评价、封存、角色和真实 Python 库 |
| Recipes/示例 | `src/algorithm/recipes/*`、`examples/algorithms/{rho,ahe,evo-harness,optuna}` | 不要求四个 recipe 全部用 TS，也不复制成两套实现 |
| 入口/发布 | CLI/config、skill gateway/control-plane、package exports、packaging scripts | 配置 kind 分流、前台 run、服务模式及公开分发 |

## 12. 可检验的“扩展性”和“易用性”

### 12.1 三条作者路径

| 路径 | 作者应该做的事 | 阻止发布的信号 |
| --- | --- | --- |
| A：改现成 recipe | 干净项目安装 SDK，init，修改一个选择函数，check/run/resume | 需要 TS glue、内部 import、手写 digest/lease/事件去重，或 hook 没生效却不报错 |
| B：写新算法 | 用任务/决策步骤写动态循环和并行，并保存必要业务状态 | 为每个完成事件写样板 switch、亲自实现 outbox/预算，或只能套固定 GEPA 顺序 |
| C：接真实 Python 库 | 使用公开 adapter，配置 checkpoint/环境，复用库本身的 ask/tell | 改 Gear 核心才能接入、默认重跑未知外部请求、恢复后丢 trial/采样状态 |

评审记录“模板生成部分、作者业务部分、adapter 基础设施部分”的文件/有效代码量和首次跑通步骤；不能把几百行基础设施藏入用户模板再说只需一个文件。至少由未参与该 SDK 实现的开发者按教程走通 A，并记录阻碍；这个人工可用性验收若未进行，报告明确未验证，不能用行数阈值冒充容易使用。

### 12.2 协议与方法反例

- 同一 commit 原子保存状态、绑定、意图与预算；每个提交窗口、结果丢失、重复响应、取消不明均有故障注入。
- 两语言的确定性 toy 在共同输入/随机源上产生相同语义；已提交动作不因 worker 重启重复发出。
- R1 toy 只改 editor；Socratic toy 两角色共享新模型且使用新 curriculum；SkillMaster toy 双状态原子更新；DGM toy 低分节点仍可繁殖。
- 无 Harness 的反馈操作、skill+tool 原子版本、训练/测试不同环境不需要伪造公共字段。
- AHE verdict 绑定实测旧版本；RHO 正值门槛成立；Evo 批次技能确实挂载且 cursor 同步推进。
- 角色查询遵守固定 asOf、scope 和页 token；artifact.read 不能绕过授权；API、工作区和 OS 边界分别报告。
- Optuna 三个中断窗口全部通过；库版本/环境漂移拒绝静默续跑；stdout 噪声不破坏协议。
- opaque-job 请求 managed-children、不可执行 token 硬预算、缺 logprobs 的评分方法，均在执行前明确拒绝相应能力。
- continuation 不能迁入 pending 任务、修改祖先事件或把预算和暴露记录清零。

### 12.3 真实运行的验收

toy 证明合同，真实 provider 证明接线，论文基准结果证明科学效果，三者分别报告。正式发布前四个 recipe 至少完成有明确预算的小规模真实接线验证；GPU trainer、环境生成和完整论文复现不算已支持。现有训练 preflight 仍不能代替这些运行证据。

## 13. 后续方法覆盖

| 后续能力 | 对应方法 | 已提前验证的接口边界 / 后续工作 |
| --- | --- | --- |
| 开放 archive、复杂选择与合并 | Meta-Harness、DGM、Self-Harness、RRSI、SkillSmith | 历史查询、非单调准入、命名组合可表达；实现具体父代/成本/新颖性/双切分策略及合并测量 |
| 结构化修复证据 | HarnessFix | 查询/作用域/引用可复用；新增 HTIR、实现锚点与 repair specification |
| 记忆探索和人工步骤 | RSIAgent、Learning from Failure | 并行/顺序步骤与稳定状态可复用；补环境 reset、持久 human operation 和会话能力 |
| 编辑器/联合模型训练与课程 | Harness-R1、SkillMaster、Socratic-SWE | 动态角色模型、联合 bindings、派生任务、临时 artifact 已做 toy 反例；真实 token credit、reward、梯度、GPU checkpoint/训练另做 |
| 环境演化和自主编排 | EnvHarness、HarnessDev | train/test 环境分开；实现 wrapper provider、creator/planner 的受限操作能力与审计 |
| 改进算法自身变化 | Gödel Agent | continuation 身份/预算边界确定；后续实现隔离执行和状态迁移，不声称透明 monkey-patch 恢复 |
| 排序和研究数据底座 | LLM-as-a-Verifier、Experience Graphs | 独立 feedback 与 evidence/as-of；不强制新 Harness，不预先建设图数据库 |

新增方法是否方便，以作者路径和反例衡量：无需新增论文专属核心分支，但可能需要新的 provider/codec/recipe。提供一种新物理能力需要写 adapter 是合理扩展；为了改变步骤顺序或选择逻辑就改核心，则属于设计未完成。

## 14. 本轮交付与实施起点

本轮只交付 V2 文档，没有修改源码、安装 Optuna、运行模型/评测/训练或迁移历史实验。Optuna 的接口与恢复限制已核对官方文档，适配方案和易用性目标尚待 P1/P2 实证。

进入实施后先执行 P0/P1，尽早交付可在仓库外运行的 Python toy 项目；P2 以三条跨中断路径和未来方法反例决定 SDK 能否定稿。真实执行适配和 GEPA 迁移在这之后推进，保留四 recipe 作为首个产品里程碑。

# Gear 可扩展 Meta Agent：具体实现方案

- 状态：待评审方案；本次不实现功能、不迁移实验、不启动真实评测。
- 日期：2026-09-23。
- 基线：最新 `origin/dev`，`f715748dad576d3055e4a9eaab21b36015348aee`。
- 分支：`codex/meta-agent-algorithm-plan`。
- Worktree：`/Users/zgq/.codex/worktrees/meta-agent-algorithm-plan/gear`。
- 研究依据：[十九篇论文笔记对照与架构结论](meta-agent-algorithm-architecture.zh-CN.md)。

## 1. 建议采用的设计决策

1. **算法插件拥有完整控制流。** GEPA 是首个内置 recipe；新算法可以改变步骤顺序、反馈信号、状态更新及停止规则。
2. **Meta 执行能力与算法分开。** 分析、编辑、批评、偏好比较、技能整理等是角色任务，可以使用 Agent，也可以使用确定性程序。
3. **公共内核采用持久决策与操作事件。** 状态更新和待执行命令一起提交；所有外部副作用走可检查、可恢复的操作适配器。
4. **新记录使用独立的 Campaign V1。** 不给 `RefinementRound` 增加越来越多的可选字段，不改变旧 `EvolutionSpec` 的含义。
5. **产物版本、测量、研究状态和部署指针分开。** 支持多种 artifact 和组合 bundle，允许低分分支、临时 patch、未评测草案及延迟归因。
6. **首版公开 API 使用显式状态决策函数和组合 helper。** 不承诺任意 `async`/闭包能自动持久恢复；普通用户通过 recipe 覆盖少量函数，高级作者可实现完整 reducer。
7. **默认算法、角色和实验协议在启动时冻结。** 新代码/新配置创建新 campaign；旧记录不能被当前默认配置悄悄改写。
8. **算法协议独立于语言，Python 是首版作者语言。** TypeScript 保留宿主与已有实现；Python 可以编写完整算法、策略和 provider。两套 SDK 共用协议、预算、证据和恢复语义，不能把 Python 限制成 TS 算法里的工具函数。

首个可交付版本需要真实覆盖 GEPA、RHO、AHE、Evo-Harness 四种不同流程。训练、环境演化和算法自修改分后续批次实现；首版保留扩展合同，不把未实现的后端能力标成已支持。

本文将研究草案中的“普通 TypeScript 控制流”收敛为首版可以兑现恢复保证的接口：Python/TypeScript recipe helper 和显式 reducer。研究草案描述能力目标，本实施方案规定首版边界与迁移顺序；跨语言接入详见第 13 节。

## 2. 开发者最终体验

### 2.1 两种扩展深度

**常见变体：** 安装一个 recipe，替换父代选择、诊断规划、候选排序或停止条件。未覆盖部分沿用该 recipe 的默认行为。所有 hook 的适用范围由 recipe 声明；传入不支持的 hook 在启动时拒绝，避免“注册了却不生效”。

**完整新算法：** 实现 `initialize` 与 `reduce`，返回下一状态及操作列表。SDK 提供顺序、并行、汇合、重复和任务流 helper。用户无需直接调用 Git、写数据库、计预算或实现崩溃恢复。

建议模板（TypeScript 版本）：

```text
my-algorithm/
  algorithm.ts          # 算法 / recipe overrides
  gear.json             # 实验配置
  algorithm.test.ts     # toy provider 上的行为与恢复检查
  package.json          # SDK、构建和测试脚本
```

建议 CLI（均为待实现）：

```text
gear-refine algorithm init ./my-algorithm --template rho
gear-refine algorithm init ./my-python-algorithm --template rho --language python
gear-refine algorithm check --config ./my-algorithm/gear.json
gear-refine serve --config ./my-algorithm/gear.json
```

`init` 生成模板；`check` 编译/解析插件，生成内容身份，核对配置和 provider 能力并显示实际生效组合，不调用模型或提交评测。`serve` 启动后仍通过现有控制面请求开始任务。

### 2.2 独立公开包入口

增加 `rsi-gear/algorithm`、`rsi-gear/algorithm/testing` 与 recipe 子路径。新入口不能为了读取类型或使用 toy runner 就加载 DSH 宿主、Hitch、GPU 或私有 runtime。

本地 TypeScript 通过模板构建流程生成 ESM 制品；服务实际加载已编译 ESM。首版不支持网络 URL 模块、不在启动时自动安装依赖，也不静默调用全局 TypeScript loader。

插件装配分为：实现注册、实验配置引用、实际能力验证。缺失实现、重复 ID、配置错误或能力不足均在创建 campaign 前报错。

Python 提供独立轻量 SDK（暂定分发名 `gear-algorithm`、导入名 `gear_algorithm`），模板使用 `algorithm.py`、`pyproject.toml` 和 `test_algorithm.py`。用户指定已准备好的 Python 环境，worker 导入其模块；无需写 TypeScript 适配代码。SDK 不依赖训练包、torch 或 CUDA，算法可以按需使用自己的依赖。跨语言接入走下述协议，不加载 Python 到 Node 进程内部。

## 3. 模块边界和文件落点

下列均是拟新增文件；先按职责建立目录，避免第一批就生成大量空接口。

| 模块 | 拟落点 | 职责与现有依赖 |
| --- | --- | --- |
| 作者 API | `src/algorithm/api.ts`、`contracts.ts`、`registry.ts`、`loader.ts`、`testing.ts` | 插件合同、schema 校验、身份、加载、toy fixtures；不依赖具体宿主 |
| 跨语言协议与 Python SDK | `protocol/algorithm/v1/*`、`src/algorithm/hosts/python.ts`、`packages/python-sdk/{pyproject.toml,src/gear_algorithm/*}` | 语言无关 schema/fixtures、worker 启动与通信、Python 类型/组合 helper/testkit；独立于已有 `python/gear_training` |
| 算法 recipe | `src/algorithm/recipes/{gepa,rho,ahe,evo-harness}.ts` | 完整算法及允许覆盖的策略；论文专属阶段/字段放这里 |
| 持久执行内核 | `src/algorithm/runtime/{runner,journal,operations,budget}.ts` | 决策提交、操作 outbox、事件、资源预留/结算、恢复 |
| Campaign | `src/algorithm/campaign/{spec,store,service,projection}.ts` | 实验准入、版本化状态、运行状态投影、停止/恢复；与旧 evolution registry 分开 |
| 版本产物 | `src/artifact/{types,store,git,files,bundle}.ts` | Git Harness、文件树 skills/memory、结构化报告和组合版本；大模型文件后续适配 |
| 角色任务 | `src/meta/jobs/{types,service,skill,dsh}.ts` | 通用 job、租约、身份、上下文与权限；复用已有宿主生命周期 |
| 运行和评价适配器 | `src/algorithm/providers/{rollout,feedback,artifacts,agents}.ts` | 将现有 builder/evaluator/trajectory 能力接到通用操作合同 |
| 集成入口 | `src/cli.ts`、`src/config.ts`、`src/skill/control-plane.ts`、`src/skill/gateway.ts`、`src/index.ts` | 新配置分流、方法路由、DSH/standalone 统一装配 |
| 发布与示例 | `package.json`、`examples/algorithms/*`、`scripts/check-algorithm-package.mjs` | 实际 tgz 的独立项目验收及开发教程 |

旧 `src/search` 是兼容运行路径；其中经过验证的恢复/预算语义可借鉴，但不能一开始就把整套 GEPA runtime 改名为通用内核。它目前仍依赖固定 partition、stage、workplan、archive 和 promotion。

## 4. 核心合同

以下 TypeScript 是接口草案的一种语言投影，字段命名可在 PR 1 固定；协议 schema 和跨语言 fixtures 才是共同合同，不以 TS 运行时对象为协议。不是可以直接导入的现有 SDK。

### 4.1 算法与决策

```ts
interface AlgorithmPlugin<Config, State> {
  id: string
  apiVersion: 1
  configSchema: Schema<Config>
  stateSchema: Schema<State>
  requirements: CapabilityRequirement[]
  initialize(input: AdmissionView<Config>): Decision<State>
  reduce(state: Readonly<State>, event: AlgorithmEvent,
    context: Readonly<DecisionContext>): Decision<State>
}

interface Decision<State> {
  nextState: State
  commands: OperationIntent[]
  outcome?: { status: 'completed' | 'failed'; resultRefs: VersionRef[] }
}

interface OperationIntent {
  localKey: string
  kind: string            // 例如 gear.agent.execute / mylab.gradient.align
  input: JsonValue       // 大输入使用已验证的不可变引用
  limits?: ResourceLimits // 只能收紧 campaign/role 上限
  after?: string[]
}
```

`DecisionContext` 只含封存配置、预算视图、输入投影、逻辑事件序号及确定性随机 helper，不暴露 store、凭据或发布函数。需要额外查询时发出 evidence-query 操作，其查询结果按当时视图封存后成为事件。

决策函数应无外部副作用；模型调用属于 `agent.execute` 操作，不在 reducer 内直接发请求。内核先持久化决策，再执行命令。输出大对象进入 artifact store，状态只保存索引和引用，防止把完整轨迹不断复制进 checkpoint。

命令在提交前由内核根据已封存的 provider 合同进行 schema、依赖、权限及资源校验，解析成包含实现身份、输入摘要、有效权限和预留资源的请求；这一阶段不执行外部操作。操作注册表支持命名空间和版本，新增训练/梯度算子无需往内核增加论文专属命令。`localKey` 在同一决策内唯一，依赖必须可解析且无环；重复事件按 operation/event ID 去重。

首版 helper 将 sequence/parallel/join/repeat 编译为上述状态和命令。高级 reducer 可表达动态流程，不受静态 DAG 限制。任意 `await` 脚本自动重放另列后续功能，不能借它推迟定义恢复合同。

### 4.2 运行状态与算法结果

运行生命周期：`queued / running / waiting / cancelling / completed / failed / cancelled`。`waiting` 附待完成操作或人工输入原因；外部状态不明表现为待恢复操作，不自动重试为新的候选。

算法状态自行记录：archive、当前状态、best measured、selected output、pending attribution、stream cursor 等。一次 round 没有提高分数，仍然可以是成功完成的算法步骤；不再用 `championChanged` 推导执行成功/失败。

以下结果分别记录：artifact validity、measurement status、archive membership、parent eligibility、active binding、final selection、deployment。部署沿用独立发布操作和权限；更新研究状态不隐式发布。

### 4.3 产物与组合版本

```ts
interface VersionRef {
  kind: string
  digest: string
  schemaVersion: number
}
interface ArtifactRevision {
  ref: VersionRef
  contentRef: ContentRef
  createdByOperation: string
  lineage: Array<{ relation: string; source: VersionRef }>
}
interface ExecutionBundle {
  harness: VersionRef
  model: VersionRef
  skills?: VersionRef
  memory?: VersionRef
  environment?: VersionRef
}
```

复用现有精确 commit/tree/manifest 验证，不把 branch name 当版本。首版支持 Git Harness、skills/memory 文件树和结构化 JSON。模型和环境先作为已有外部版本引用；训练和环境生成 provider 后续接入。

关系至少区分 `code-base`、`merged-from`、`informed-by`、`trained-from`、`derived-from`。原来的单代码基底限制可以保留在具体 Git edit 操作内；合并多个来源需要独立 merge 操作和合并后验证。参考两个候选不等于发生了代码 crossover。

skills/memory 挂载必须由 Target 适配器实现并进入 bundle 条件身份。不能只在数据库记了技能新版本，却让实际 rollout 仍使用旧文件；Evo-Harness 的验收必须检查实际加载的内容。

### 4.4 测量与实验协议

拆开 `rollout.run` 与 `feedback.compute`：前者输出轨迹/产物引用和真实运行身份，可以没有任务标签；后者可以是 executable grader、pairwise preference、soft verifier 或成本计算。

现有 raw metrics、objective 和约束作为默认 scorer 复用；反馈类型保留 `source`、`status`、`scope`、`subjectBundle`、`metricContract`、`purpose`。模型偏好不能被包装成可执行正确性，缺失值不能填零。

数据视图包含任务集合快照及 cursor、任务/标签可见性、允许的操作/角色、结果可见性、是否参与自适应选择、暴露记录。`seed/held-out` 只作为 GEPA 适配后的命名视图，不是公共内核枚举。

新算法仍须遵守启动时固定的实验协议。若没有独立 final test，报告明确说明；不能自动推断泛化。插件拿不到未经授权的全量物理路径。

## 5. 操作日志、事务和恢复

### 5.1 存储布局

```text
stateRoot/
  evolutions/...                  # 旧格式，不改写
  campaigns/<id>/
    spec.json                     # 冻结算法、配置、角色、数据协议与运行实现
    objects/<digest>              # 不可变状态、决策、命令和事件批次
    journal/head.json             # 单一提交头，CAS + 单写者锁
    derived/                      # 可重建索引、状态投影、报表
    workspaces/...                # 临时编辑环境
```

第一版采用现有文件系统风格，不引入数据库服务。每次变更先写不可变对象，再在持有 campaign 锁时验证预期 head 并更新提交头。决策状态、发出的命令、预算 reservation 在同一个提交对象中引用；衍生索引失败可重建。

原子 rename 只解决单文件替换，不代表多文件事务。实现需要明确 fsync/父目录持久化、锁失效处理、损坏记录检测和悬空对象清理规则；强持久保证以实际支持的本地文件系统和故障测试为准，不宣称支持任意网络盘。

新 campaign 的 archive、active binding、best/final selection 与 cursor 都引用同一个已提交状态，不分别写多个可变 registry。Git/artifact 先封存成不可变对象，再提交引用；中断遗留的未引用产物可回收。跨到旧 champion registry 或外部部署系统时，另存提交意图，冻结 expected revision 和目标版本，逐步幂等执行并记录回执；CAS 冲突停止提交，不能重新选择后覆盖对方状态。

### 5.2 外部操作生命周期

```text
intent-recorded + budget-reserved
  → submitted / unknown
  → running
  → completed / failed / cancelled
  → result-recorded + budget-settled
```

操作 ID 由 campaign、已提交决策 ID 和 `localKey` 派生；输入摘要不同不能复用同一 ID。并行结果到达顺序写成事件序列，恢复沿用该顺序；需要确定性汇合的 recipe 按 slot 排序后处理。

外部 provider 合同：`submit(request, idempotencyKey)`、`inspect(key/handle)`、`cancel(key/handle)`、输入输出 schema 和 capability 声明。provider 声明幂等范围与结果保留期限。

- 对已有 reservation 的恢复始终先 inspect 原 key；请求可能已执行但响应丢失时，不能重新唤醒 Meta 或直接新建操作。
- 确认 not-started：才可使用原 key 提交；已超预算/截止时间则停止新执行。
- running/unknown：保存 handle 与原因，等待或显式 reconcile；unknown 不当作失败计分。
- 完成：先保存并验证结果身份，再在一次 journal commit 中写完成事件和结算。
- 取消：要求能确认停止或不存在；取消超时保留可见状态，不能释放额度后启动替代任务。

不承诺网络副作用“恰好执行一次”。保证有唯一操作身份、幂等/reconciliation、结果不重复入账。没有可恢复能力的 provider 只能显式进入不支持自动恢复的运行模式，不能用于声称通过恢复验收的算法。

### 5.3 预算和时钟

沿用 reserve/settle 思路，资源采用注册表中的有单位计数器，例如 rollout cells、模型请求、tokens、GPU 秒；deadline 单独处理。硬上限只在 provider 可强制执行时允许配置；软估算与实际测量分列。

预算视图随操作状态持久化。重新领取 lease、重启 server、恢复 role session 都不能重置原预算。结果读取和取消确认不因生成 deadline 到期而被阻断。

## 6. Meta Job 与外部 Skill 协议

### 6.1 通用任务

`AgentJob` 包含 role、角色实现身份、输入引用、context policy、输出 schema、读写能力、session policy、资源上限。角色模型/Skill/runtime/采样逐一冻结；同模型可承担不同角色，但访问域和会话策略分开。

首版只提供两类默认输出：

1. `structured-result`：诊断、批评、偏好、技能建议等结构化 artifact。
2. `workspace-edit`：在授权工作区修改文件，经 check/seal 后返回精确版本。

上下文策略至少有 fresh、fork、resume。扩展任务可以定义自己的输出 schema，不要求所有诊断都存在 GEPA dossier/failure cluster，也不要求所有工作都具有 candidateId。

### 6.2 兼容路径

保留原 `meta.claim`、`candidate.*`、`meta.call` 的字段和语义。新增独立 `job.claim`、`job.call`、`job.complete`、`job.fail` 协议，能力握手后新 Skill 才领取通用任务。

新 job lease 绑定 campaign/job/attempt/role/client/identity；旧 candidate lease 不能调用新 job 方法，反之亦然。所有 handler 先授权后解析操作专属参数；不能依赖调用者自报角色扩大权限。

复用底层 Skill/DSH 会话控制，但提取生命周期所需的最小接口。旧 `MetaSessionController` 继续由适配器满足，不直接改变历史 candidate evidence receipt。

`workspace-edit` job 的完成流程复用 builder/workspace 的 preflight、compiler、seal 与身份核验；`structured-result` job 只写有 schema 的结果，不制造一个假候选来绕过旧协议。

## 7. 配置加载、身份与信任边界

新实验配置至少包括 algorithm、roles、datasets、providers、initialBundle、budgets、protocol。旧配置继续走原 ConfigSchema。入口先按显式 schema/kind 判别，不能先用旧必填字段拒绝一个不需要 held-out/Hitch 的 RHO 配置。algorithm 按 language 判别；下例为 TypeScript，Python 对应配置见第 13 节。

```json
{
  "schemaVersion": 1,
  "kind": "algorithm-campaign",
  "algorithm": { "language": "typescript", "module": "./dist/algorithm.mjs", "export": "default", "config": {} }
}
```

以上只是入口片段，其余运行字段由模板补齐。模块相对路径以配置文件目录为基准，npm 包从该项目解析；不能依赖服务当前 cwd。

算法导出 `id/configSchema/stateSchema/requirements`；不由用户手填 implementation digest。TypeScript 构建器封存实际 ESM、本地依赖、prompt/其他声明资源、manifest，以及明确外置依赖的版本和内容身份。SDK/Node ABI、provider 实现和算法配置分别记录；Python 按第 13 节封存代码、依赖与实际运行环境。首版拒绝无法确定身份的动态依赖；运行中从封存代码加载并验证环境，不能加载当前磁盘上被编辑的新代码。

已安装的本地算法包属于用户信任的控制面代码。TypeScript 类型和纯 reducer 约定不能构成安全沙箱；由 Meta 自动生成、未经信任的算法应在后续隔离进程模式中运行，首版不授予它直接加载进服务的能力。

静态 `check` 校验协议与能力，不证明 provider 实际运行成功。真实端到端探针与模型/训练适配器认证单列，尤其不能把现有训练 preflight 当作完整 GPU 训练验证。

## 8. 四个首版 recipe 的具体流程

### 8.1 GEPA

将当前父代选择、scope、failure clusters、workplan、local/bridge/global-seed/held-out、archive、promotion 作为 recipe 内部状态与策略。其余算法不导入这些类型。

迁移拆两步：先提供调用旧 engine 的兼容 driver，验证入口与配置路由；随后为新 campaign 实现基于通用操作的 GEPA recipe。**前一个 wrapper 只是过渡，不能计为已完成解耦。**

用相同 toy 输入比较候选/父代/任务范围/排名/晋升/预算语义；若持久格式和身份不同，不强求新旧对象 digest 相同。各路径内部的重放和身份校验必须分别成立。

### 8.2 RHO

历史轨迹 → 困难/多样性 coreset → baseline 分组 rollout → diagnosis → N 个同基底目录候选 → 候选 rollout → 对固定 baseline 的 pairwise preference → `max(S)>0` 才选择候选，否则基线。

role 与算法均不可获得真实标签。序列化 coreset、baseline 轨迹、比较顺序和偏好结果。默认示例按笔记的 10/3/3 配置，但未公开的 prompt/细节标成 Gear 实现选择，不能称完整复现。

### 8.3 AHE

运行当前已提交版本 → 核验前一份 manifest 的 predicted fixes/risk tasks → 决定文件级回滚 → 生成分层证据 → 修改并提交下一版 → 进入下一轮。

状态保存 `executedRevision`、`pendingRevision`、`manifestRef`、`verdictRefs`、`bestMeasuredRevision`。回滚生成新版本，不修改旧 commit。已测分数永远绑定被执行的具体 revision，不能赋给刚产生的新版本。结束时返回最佳已测版本，未测修改保留为草案。

### 8.4 Evo-Harness

读取批次 cursor/skill snapshot → 每题检索并实际挂载技能 → solver rollout 与外部反馈 → 失败提案 → 批末 curator add/merge/revise/skip → 新技能树封存 → 原子提交新 skill binding 和 cursor。

批内同一 skill snapshot；重启后不重消费任务或重复合并。被处理的真实外部事件有稳定 ID；来源不能重放时保存输入快照或显式限制恢复。无需虚构独立 executable promotion gate。

## 9. 控制面和旧实验迁移

### 9.1 独立记录、统一展示

内部新增 `CampaignService` 和 `campaign.start/status/resume/cancel`。现有 `control.*` 保持旧响应；新版 Skill/CLI 通过能力发现调用新方法。应用层可聚合列表，但不能把不同对象的 ID 和状态混用。

第一版不把旧 `EvolutionRegistryStore` 内容原地转换。新 `campaigns` registry 与旧 `evolutions` 并存；显示时带 `kind`。正式发布仅接受已选定、能映射到部署适配器的精确 bundle，并保留当前显式发布语义。

### 9.2 实现身份是迁移的硬约束

`src/search/identity.ts` 对 engine/runtime/adapter/objective 等完整闭包计算字节摘要。移动实现、修改 re-export 或改变同一文件中的注册逻辑，都可能导致旧未完成实验无法恢复；源码运行和构建制品也不是同一个字节身份。

因此：

1. PR 0 固定实际运行制品、构建环境与 identity fixtures，不能仅保存 commit 名就说旧运行时已可用。
2. 首轮采用新增目录，不改旧 search identity 闭包；旧服务继续使用原运行环境。
3. 若后续必须改到闭包，保留匹配旧身份的完整制品/运行目录，按原身份在单独进程/原服务中继续执行。新服务只路由控制请求，不同时抢同一个 evolution 的写锁。
4. 缺少匹配制品时，终态仍可读取，未完成任务明确报告需要原运行时；不关闭校验，也不把旧记录强行交给新 recipe。
5. 从旧结果创建新 campaign 是显式导入：核验 artifact/evidence 后记录 lineage、新算法和协议。它不是旧 run 的 resume；旧选择结果不自动成为新算法选择结果。

旧实现长期维护需要单独的版本支持策略。首版至少保留本次基线的可恢复路径及现有历史 fixture 覆盖，不承诺恢复任意曾发布的未知环境。

## 10. 实施批次与依赖

每批只创建实际需要的模块；预计是一组可独立评审的 PR，下面是工作边界而非工期承诺。

| 批次 | 交付 | 主要文件 | 依赖与退出条件 |
| --- | --- | --- | --- |
| PR 0：兼容基线 | 记录原制品身份、旧 GEPA 行为 fixtures、旧恢复样本与新 spec 约定 | `tests/fixtures`、identity/recovery tests、设计文档 | 无前置；明确哪些旧运行制品可以恢复 |
| PR 1：作者合同和加载 | 语言无关 schema/fixtures、AlgorithmPlugin、registry、配置分流、ESM manifest、只读 check | `protocol/algorithm/v1/*`、`src/algorithm/{api,contracts,registry,loader}.ts`、CLI、package exports | PR 0；协议无 JS 专属对象，外部模块无需 DSH 依赖可加载，漂移/缺能力启动前拒绝 |
| PR 2：持久内核 | Campaign journal、runner、outbox、预算、恢复和 toy operation provider | `runtime/*`、`campaign/{spec,store}.ts`、testkit | PR 1；提交窗口崩溃、结果丢失、重复事件、取消不明等故障测试通过 |
| PR 2P：Python 作者入口 | Python worker/SDK、模块 manifest、轻量 wheel、Python 模板及跨语言合同测试 | `src/algorithm/hosts/python.ts`、`packages/python-sdk/*`、protocol fixtures | PR 1 后可并行开发，依赖 PR 2 验收；Python 完整 toy 算法跨进程重启恢复，用户不写 TS glue |
| PR 3：版本和运行适配 | Git/file-tree/bundle、证据投影、无标签 rollout、feedback provider | `artifact/*`、`providers/{rollout,feedback,artifacts}.ts` | PR 2；执行对象和真实证据匹配，技能挂载可证明，标签不可见测试通过 |
| PR 4：角色任务与服务 | job lease/role schema、structured-result/edit、Skill/DSH adapters、campaign RPC | `meta/jobs/*`、`campaign/service.ts`、gateway/control-plane | PR 2–3；新旧协议隔离，取消/恢复不重复提案，两宿主适配通过 |
| PR 5：GEPA 接入与迁移 | 兼容 driver、新 GEPA recipe、合法 hook 和状态投影 | `recipes/gepa.ts`、兼容路由、search 对照测试 | PR 3–4；新旧科学行为对照通过，旧身份路径保持，wrapper 不作为终点 |
| PR 6：RHO 与 AHE | 两个完整外部 recipe，至少 RHO 使用 Python；无标签偏好、延迟归因/回滚 | `examples/algorithms/{rho,ahe}`、必要 SDK helpers | PR 2P、3–4；两例不修改内核、不依赖 GEPA 假 round，关键反例通过 |
| PR 7：Evo 与流式状态 | retriever/proposer/curator、稳定任务 cursor、批末技能提交 | `examples/algorithms/evo-harness`、file-tree/stream provider | PR 3–4；批内快照、真实挂载、断点重复消费测试通过 |
| PR 8：发布级开发体验 | 两语言 init 模板、运行报告、能力说明、tgz/wheel 外部安装与四 recipe 验收 | CLI、`examples/algorithms`、`scripts/check-algorithm-package.mjs`、Python packaging、docs | PR 2P、5–7；两语言用户只写算法/配置/测试即可接入，现有文档准确标明兼容路径 |

PR 6 与 PR 7 在共同基础稳定后可并行；不为了并行让两套恢复/身份协议各自生长。先完成外部 recipe，再冻结 SDK v1，避免只用 GEPA 验证接口。

### 后续覆盖批次

| 批次 | 方法与新增能力 | 可复用部分及验收 |
| --- | --- | --- |
| A：开放 archive 和复杂选择 | DGM、Meta-Harness、Self-Harness、RRSI、SkillSmith；多前沿、成本/新颖性、atomic edit bundle | 复用状态/证据/版本；低分可繁殖、非单调选择、双切分 gate、合并版本独立评测 |
| B：记忆探索与课程 | RSIAgent、人工参与的 Learning from Failure | 并行练习、按序恢复 actor 合并、持久人工等待；目标暴露和环境 reset 有记录 |
| C：训练动作 | Harness-R1、SkillMaster、Socratic-SWE | 复用已有训练身份/检查点/作业协议；新增 editor token credit、双奖励/梯度算子、联合状态；真实 GPU 端到端探针单列 |
| D：环境与自主编排 | EnvHarness、HarnessDev、Gödel Agent | 训练 wrapper 版本、Agent planner command、算法版本切换；保持固定证据核心，运行时 patch 的不可恢复边界明确 |

LLM-as-a-Verifier 以 feedback/ranking provider 接入；Experience Graphs 的逻辑视图由 journal/索引支持，首版不引入专用图数据库。HarnessFix 的 HTIR/锚点是 evidence/analysis 插件，可在角色协议稳定后独立开发。

## 11. 验收清单

### 框架正确性

- 决策落盘前不执行命令；状态和 outbox 不会在崩溃后分离。
- 同一操作 key/输入不可重复计费或重复接纳；输入漂移明确失败。
- submit 响应丢失、provider running/unknown、结果已到但未提交等窗口均可恢复或明确等待。
- 取消无法确认时不释放成可重新执行状态；租约切换有 fencing，旧客户端不能继续写。
- raw evidence 绑定实际 bundle、任务与执行条件；未测量、无标签、无效运行保持不同状态。
- 研究角色看不到协议禁止的标签；内核日志、错误、状态接口也不能绕过投影泄漏。
- 并行结果事件可重放；join 语义由 recipe 明确，预算不会并发超额预留。
- 配置、算法制品、provider 或身份改变，不能静默继续旧 campaign。

### 方法表达力

- GEPA：父代/任务计划、阶段选择、晋升与预算逻辑等价；恢复不重新抽样。
- RHO：完全无真实标签，最高偏好不为正则保留基线。
- AHE：下一轮评测归给实际旧版本；新版本尚未评测时不能成为 best measured。
- Evo：实际 Target 使用该批技能快照；批末状态与 cursor 同时提交。
- 后续 DGM/RRSI/R1 等按各批次的非单调、临时产物或训练 credit 反例验收，不能只验 API 能注册。

### 开发体验与打包

- 真实 tgz 安装到仓库外的临时项目，仅公开入口即可编译和运行。
- 真实 Python wheel 安装到独立 venv，完整 RHO 不需 TS glue；Python 环境漂移、worker 崩溃、迟到响应和协议污染均有合同测试。
- 一个小型确定性算法的 TS/Python 实现对共同 wire fixtures 产生相同语义决策；哈希、数字与随机源语义不依赖语言默认行为。
- 至少接入一个已有 Python 库，通过受支持的回调/检查点验证复用路径；报告具体恢复粒度，不能把任意脚本包装当成完整可恢复算法支持。
- 不需要手写 digest、内部 registry 构造、RefineService 构造或数据库逻辑。
- 对不支持的 hook、logprobs、标签访问、token 硬预算和恢复能力，在执行前给出具体错误。
- toy/provider stub 完成全流程及故障注入；真实 provider 再做有明确预算的小规模集成验收。
- 文档将“框架可表达”“Gear 实现选择”“论文原文未披露”“真实复现实验结果”分开。

## 12. 本轮交付与下一步

本轮只创建隔离 worktree/分支，并写入本实施方案和此前研究文档。没有更改源代码、安装运行依赖、启动模型/评测/训练或迁移已有实验。

如果进入实施，第一项工作是 PR 0 的身份与恢复基线，随后实现 PR 1 的合同/加载和 PR 2/2P 的持久内核与 Python 入口。首个功能里程碑是仓库外的 Python/TypeScript 自定义算法能在 toy provider 上跨中断完成；首个产品里程碑是四种 recipe 共用同一套正式执行能力。

## 13. Python 算法与现有研究代码的接入

### 13.1 总体选择：一个内核、两种作者语言

保留 TypeScript 宿主及现有控制面、版本与恢复实现；增加 Python SDK 和独立 worker。Python 能拥有整个算法循环，不只是被 TS 算法调用的一项工具。两种语言共用 Campaign、操作、artifact、角色和反馈协议，不在 Python 中再建第二套调度、存储和预算系统。

```text
Python 算法 / TypeScript 算法
        ↓ 相同的状态、事件、决策与操作合同
Gear 持久执行内核
        ↓
Agent / rollout / feedback / Python 库与训练作业
```

现有 `src/selection/llm-verifier.ts` 已通过 Python 子进程调用 verifier，`src/training/process.ts` 与 `python/gear_training` 已有结构化 Python 作业桥。可复用 argv、身份、输出校验和恢复经验；它们不等于已经具备通用 Python Algorithm SDK，也不能把训练依赖强加给普通算法作者。

### 13.2 作者只需要 Python 和配置

```text
my-algorithm/
  algorithm.py
  gear.json
  pyproject.toml
  test_algorithm.py
```

配置片段（待实现）：

```json
{
  "algorithm": {
    "language": "python",
    "interpreter": "./.venv/bin/python",
    "module": "algorithm",
    "export": "algorithm",
    "config": {}
  }
}
```

路径以配置目录解析，准入时解析为确切解释器和封存代码；SDK 自动处理通信、schema 和结果封装。作者可使用自己的 NumPy、优化器或研究代码。轻量计算可在决策函数中完成；模型调用、训练和长时计算等有副作用或需独立恢复的工作必须作为 provider operation 执行。

完整新算法继续采用 `initialize(input)`、`reduce(state, event, context)` 和 recipe helpers；返回可序列化状态与命令。进程内变量只是缓存，不能作为唯一持久状态。第一版不尝试保存 Python 调用栈、generator、闭包或整个解释器，也不要求每个使用者手写 reducer：常见变体使用 recipe 配置与 hook 模板。

混合语言 hook 以版本化 `ComponentRef` 注册。TS recipe 引用 Python selector 时，把调用转为有身份、有结果记录的 `policy.decide` 操作，Python SDK 负责 worker 接线；不能要求作者把 Python 函数伪装成一个同步 JS callback。具体 recipe 须声明支持的 hook 及输入输出合同。

### 13.3 Worker 通信与恢复

首版采用本机受管理的常驻 Python 子进程，使用版本化 stdio JSON 消息；暂不引入远程 worker 集群。算法 worker 提供 describe、initialize、reduce、shutdown。消息包含协议版本、请求 ID、campaign、预期状态版本/事件 cursor、实现身份；超时、退出和迟到响应均显式处理。

协议输出与日志分离：stdout 只允许协议帧，SDK 将普通 Python 日志/print 导向 stderr；第三方原生库污染协议流时明确报错，不能从混杂文本里猜 JSON。设置帧大小、超时及队列上限，大轨迹、数组、模型和数据集只传 artifact 引用。业务错误与通信/进程错误分开。

Gear 保存已提交 state/event/decision。worker 崩溃后，从相同封存代码、环境及状态恢复；已提交决策不重新执行，未提交纯决策可对同一输入重算。响应必须匹配当前请求与预期 cursor，旧 worker 响应不能推进新状态。provider 的已提交副作用按原 operation key inspect/reconcile，不能因 Python 进程消失就重新跑。

Python provider 使用与第 5 节相同的 submit/inspect/cancel 合同，由独立作业适配器执行；不能把训练或长期模型请求放在纯决策 worker 的 reduce 请求里。作业生命周期与算法 worker 的生命周期分开，重启后依靠稳定 job ID 和检查点重新连接。

传输只使用受 schema 限制的 JSON 值与不透明引用；不传 pickle、Python 对象、JS 回调或任意宿主路径。数字限制为共同可表达范围，超大整数/精确十进制使用有类型的字符串，NaN/Infinity 使用显式缺失或错误状态。对象身份按协议规定的规范化编码计算，由宿主核验；随机源与逻辑时钟使用 SDK 的共同定义及 golden fixtures，不依赖 Python/JS 默认随机算法。

worker 提供进程和依赖隔离，不自动构成文件/网络安全沙箱。首版算法仍是用户信任的本地代码；未经信任的自动生成代码需要后续隔离执行方案。可见性权限在受管理 API 边界执行，不能声称阻止受信任插件主动绕过宿主读取其已有系统权限范围内的数据。

### 13.4 复用已有 Python 算法的三个层次

| 原代码形态 | 接入方式 | 可承诺的恢复与观测 |
| --- | --- | --- |
| 打分、排序、检索、候选计算等函数 | 在 Python 算法或 component 中 import；有模型/外部副作用时包装为 operation | 纯决策可重算，副作用有独立操作身份 |
| 提供 evaluator/LLM callback、step/ask-tell 或 checkpoint 的优化器 | 薄适配层接上 Gear 操作，保留其搜索逻辑；保存库状态和实际支持的随机状态 | 按库公开的步骤或 checkpoint 恢复；回调经 Gear 记录证据与成本 |
| 将模型请求、文件修改和整个循环写死的研究脚本 | 先作为外部作业导入结果；需要细粒度控制时再替换对应调用/增加检查点 | 先只有作业级状态与输出，不能宣称任意一步可恢复或拥有完整调用预算 |

因此“不重写成 TS”可以做到，“任意 Python 仓库零修改获得精细恢复”不能统一承诺。未经过 Gear 的直接模型请求不能被自动准确计费或约束；必须接 callback/client adapter，或明确标记外部作业的可观测范围。对于未知执行状态的外部脚本，不默认重启整个任务。

只有 callback、没有可导出状态/checkpoint 的 `.optimize(...)` 仍是作业级恢复；它的请求能被记录，不代表 Python 栈能恢复。首版优先接 step/ask-tell 库，将每步转成显式状态和命令。需要库自行驱动多个外部请求时，独立 adapter 必须定义稳定子操作 ID、父预算和断点映射，否则不能通过细粒度恢复验收。

### 13.5 Python 环境与交付验收

封存算法源码/wheel、配置、schema、声明资源、SDK/协议版本；记录并验证实际 Python 实现/版本、安装依赖内容及原生扩展环境。lockfile 只描述期望，不能代替实际环境观测。editable/local 依赖先快照或拒绝可恢复模式；恢复时环境漂移必须显式处理。

普通算法使用独立 venv 即可，无需强制容器。GPU provider 另行绑定实际 CUDA/驱动/训练环境；环境一致不代表 GPU 数值必然位级确定，因此训练仍沿用作业与 checkpoint 恢复，不能按纯 reducer 重算承诺处理。服务不自动修改用户的 Python 环境或安装依赖。

Python 属于首版范围：PR 1 先建立共同协议，PR 2P 接 worker/SDK，PR 6 至少用 Python 实现完整 RHO；再用已有 Python 库的适配用例验证代码复用。wheel 安装、跨语言 fixtures、Python 独立配置启动、混合语言 hook、worker 断开后的状态恢复均为发布门槛。无需把每个 recipe 复制实现成两种语言。

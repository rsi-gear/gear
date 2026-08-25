# Gear 可组合进化实验框架改造方案

- 状态：第一阶段已实现；依赖上游能力的多候选与质量—多样性阶段待完成
- 日期：2026-08-25
- 目标：在保留 Gear 现有 Git 身份、隔离、held-out 保密和 promotion 事务安全的前提下，把固定的单候选进化流程升级为可配置、可审计、可扩展的研究实验框架。

## 1. 背景与结论

当前 Gear 已经具备一组可靠的执行基础：candidate 使用完整 Git commit 标识，dataset 和 evolution spec 带有 digest，Meta 与 target 隔离，seed/held-out 分区受到控制，promotion 通过 champion compare-and-swap 完成。

当前缺口不在于能否运行一次安全的 harness refinement，而在于实验算法和实际运行参数没有形成统一、不可变、可恢复的研究接口：

- `metaSampling` 被保存和记录，但没有进入真实 Meta 模型请求；
- `continue` 从当前全局配置创建 Meta session 和 Hitch evaluator，而不是完全从 evolution spec 恢复；
- Hitch rollout 配置没有固化进 evolution spec；
- baseline/candidate 只验证 Hitch invocation 配置一致，没有显式的配对评测条件身份；
- 顶层只支持一个全局 DSH Meta host/preset、Hitch/Harbor evaluator 和固定 promotion gate；
- 每轮只有一个 Meta proposal、一个 workspace 和一个 candidate；
- 当前状态只能表达单一 champion，不能表达 candidate population、survivor 和 lineage；
- evaluator 和 evidence 类型仍然绑定 Hitch，社区 provider 无法仅通过插件加入。

Meta Agent 本身不需要 Gear 重新发明模块系统。DSH preset 已经能够组合完整 Agent 的 system prompt、skills、tools、workflows、hooks、plugins 和文档 memory。Gear 的缺口是当前只在插件启动时选择一个全局 `metaPreset`，没有把解析后的完整 DSH preset 作为 per-evolution、可 digest、可恢复的一等实验身份。

改造按以下顺序推进：

1. 修复参数实际生效和 continuation 正确性；
2. 引入类型化、可 digest 的评测条件和配对证据；
3. 建立受约束的组件 provider 接口；
4. 支持 best-of-N，但仍保持单 survivor；
5. 再引入 population、lineage 和多 survivor；
6. 最后增加 trajectory diversity 和质量—多样性选择器。

## 2. 术语

### 2.1 Meta Agent

读取 baseline evidence、诊断失败并生成 harness candidate 的模型和执行环境。

### 2.2 Rollout

使用某个确切 harness commit 执行一个 task 的独立评测运行。每个 rollout 必须拥有独立容器、workspace、DSH session、trajectory 和 run ID。

### 2.3 EvaluationCondition

一次评测使用的不可变条件定义，包括 task、repetition、seed、模型、sampling 和预算。它不是 IPython cell，也不是正在运行的容器或 session。

baseline 和 candidate 可以引用同一个 `EvaluationCondition`，但必须分别创建隔离的 rollout execution。共享的是条件身份，不是运行时状态。

### 2.4 PairedTrial

在同一个 `EvaluationCondition` 下，分别执行 baseline 和 candidate 后形成的配对证据。

### 2.5 Candidate pool

同一轮生成并参与比较的全部 candidate 集合。

### 2.6 Survivor

一轮 selection 后保留、可以参与下一代进化的 candidate。

### 2.7 Population

当前所有 survivor 的集合。现有 Gear 可以视为 population size 永远为 1，唯一成员就是 champion。

### 2.8 Lineage

candidate 之间的父子演化关系，例如 `H0 -> B -> B2`。lineage 用于恢复分支、解释 candidate 来源以及决定下一代从哪个 parent 继续生成。

### 2.9 Champion

当前部署或作为默认 target 使用的单一 harness。即使研究 population 包含多个 survivor，deployment champion 仍然保持唯一。

### 2.10 Commit SHA 与 Tree SHA

两者都是 Git 自动生成的对象 ID，但语义不同：

- Commit SHA 标识一个完整版本节点，包含根 tree、parent、author/committer、时间和 message；
- Tree SHA 标识该 commit 对应的文件内容、路径和目录结构快照，不包含 parent 和提交元数据。

因此，不同 commit 可以拥有相同 Tree SHA。Gear 使用 Commit SHA 表达 candidate 的版本、血缘、评测输入和 promotion 目标；使用 Tree SHA 表达 Git 内容等价性，用于多 candidate 去重、内容寻址缓存和一致性检查。Tree SHA 不能替代 Commit SHA，也不能单独证明两个实验等价。

## 3. 设计原则

### 3.1 Spec 是实验语义的唯一权威来源

全局插件配置只为新 evolution 提供默认值。evolution 创建后，Meta、rollout、evaluation、selection 和 promotion 的语义必须完全来自其不可变 spec。

`continue` 不得从当前全局配置补全或覆盖已有 spec。所需组件或模型已经不可用时，必须拒绝 continuation。

### 3.2 记录实际生效值，而不是声明值

模型 attribution 必须读取真实 DSH `request/header.config`。rollout evidence 必须记录 provider 实际执行的 task、模型、sampling、seed 和 run identity。

配置声明和实际执行不一致时，结果不得用于 promotion。

### 3.3 共享评测条件，隔离执行环境

同一个 paired comparison 中：

- baseline/candidate 引用相同 `EvaluationCondition`；
- task definition、task digest、seed、模型、sampling、预算和 verifier 相同；
- harness commit 是唯一计划内差异；
- baseline/candidate 分别运行在独立容器、workspace、session 和 trajectory 中；
- 一边的文件和进程状态不能影响另一边。

### 3.4 算法组件可插拔，安全核心不可绕过

可插拔组件可以决定 proposal、task sampling、rollout、judge、selection 和 promotion 算法，但不能绕过：

- exact Git commit 和 manifest 校验；
- candidate workspace containment；
- held-out projection 禁止；
- immutable spec 和 resolved plan digest；
- baseline/candidate parity；
- champion CAS；
- terminal cleanup 和恢复规则。

### 3.5 研究 population 与部署 champion 分离

population 可以包含多个 survivor，但 target worker 的默认版本仍然由单一 champion 或显式 published pointer 决定。

### 3.6 复用 DSH 原生 Agent 组合

开发者继续通过 DSH preset 开发完整 Meta Agent。Gear 不定义第二套 system prompt、skill、tool 或 memory DSL，只负责解析和固定 preset 及其模型可见资源、按 evolution 创建 session，并追加不可替换的 candidate/evidence 安全能力。

### 3.7 版本身份与内容身份分离

sealed candidate 必须同时记录 Git commit OID 和该 commit 引用的根 tree OID，但二者承担不同职责：

| 操作 | 权威字段 |
| --- | --- |
| candidate 版本、父子血缘 | Commit SHA / Candidate ID |
| 创建 worktree、生成 diff | Commit SHA |
| Hitch 评测输入 | Commit SHA |
| Git ref 保活、champion promotion | Commit SHA |
| 判断 Git 内容是否相同 | Tree SHA |
| 查找可复用构建或评测 | Tree SHA 加完整条件 digest |

Tree SHA 是 sealed candidate 的标准记录字段，但不是 candidate 的主键，也不是 promotion authority。Gear 不自行实现 Git tree 哈希；它必须从 Git 读取并验证：

```text
candidateTree == candidateCommit^{tree}
```

Git object ID 应作为不透明字符串处理，不能假设固定为 40 位 SHA-1。只要 candidate commit 和其保活 ref 仍存在，Tree SHA 可以重新推导；持久化它的目的是索引、审计和避免后续历史记录迁移，而不是建立第二套版本系统。

## 4. EvolutionSpec

不新增一套与现有 `EvolutionSpec` 平行的权威对象，直接对当前类型做破坏性升级。

当前项目仍处于 demo 阶段，不承诺读取旧状态，因此暂不引入 `schemaVersion`、旧格式 union 或迁移器。代码只接受当前 `EvolutionSpec`；结构发生不兼容变化时，删除旧 demo state 并重新创建 evolution。等 Gear 开始承诺跨版本 continuation 或保留真实长期实验后，再在持久化边界统一引入格式版本。

```ts
interface ArtifactRef {
  ref: string
  digest: string
}

interface ComponentRef<C extends JsonValue = JsonValue> {
  kind:
    | 'candidate-generator'
    | 'task-sampler'
    | 'rollout-provider'
    | 'judge'
    | 'candidate-selector'
    | 'promotion-policy'
  id: string
  apiVersion: 1
  implementation: {
    package: string
    version: string
    integrity: string
  }
  config: C
  configDigest: string
}

interface MetaSamplingConfig {
  temperature?: number
}

interface RolloutSamplingConfig {
  temperature?: number
}

interface ResolvedDshPresetRef {
  id: string
  digest: string
  resources: Array<{
    logicalPath: string
    kind: 'composition' | 'system-prompt' | 'skill' | 'workflow' | 'document' | 'plugin'
    digest: string
  }>
}

interface DshMetaAgentSpec {
  runtime: {
    type: 'dsh'
    version: string
    integrity: string
  }
  preset: ResolvedDshPresetRef
  model: {
    provider: string
    model: string
    maxTokens?: number
  }
  sampling: MetaSamplingConfig
}

interface EvolutionSpec {
  evolutionId: string
  createdAt: string

  initialHarness: ArtifactRef
  datasets: {
    seed: ArtifactRef
    heldOut: ArtifactRef
  }

  metaAgent: DshMetaAgentSpec

  candidateGeneration: {
    strategy: ComponentRef
    maxCandidates: number
    budget: {
      maxModelRequests?: number
      maxTokens?: number
      timeoutMs: number
    }
  }

  rollout: {
    provider: ComponentRef
    taskSampler: ComponentRef
    repetitions: number
    seeds?: number[]
    model: string
    sampling: RolloutSamplingConfig
    agentConfig: JsonValue
  }

  evaluation: {
    judges: ComponentRef[]
    primaryMetric: string
  }

  selection: {
    strategy: ComponentRef
    survivors: number
  }

  promotion: {
    policy: ComponentRef
  }

  taskBudgetMs: number
  toolchainRef: string
  sandboxProfileRef: string
}
```

### 4.1 Component integrity

`implementation.integrity` 必须来自可验证的实际实现身份，例如 npm package integrity、Git commit 或本地 bundle digest。组件自行声明的版本字符串不足以证明实现没有变化。

### 4.2 Meta preset identity

`metaHarnessRef` 或 `metaPreset` 的字符串名称不能单独作为 preset 身份。新 evolution 创建时必须解析 DSH preset 的真实模型可见依赖闭包并计算 digest，包括 composition、system prompt、skills、workflows、Agent 文档和本地 plugin 实现。`continue` 时重新解析并校验；内容变化时拒绝继续。

DSH preset 是完整 Meta Agent 的开发和插拔单元。不同 evolution 可以选择不同 preset，但同一 evolution 一旦创建就必须固定解析后的 preset identity。Gear 不把这些资源重新解释为自己的 Agent DSL。

### 4.3 Agent 文档与会话状态

当前不引入 Gear 专属 `MemoryProvider` 或 memory mode。system prompt、skills 和 Agent 可读文档都是完整 DSH preset 的内部资源，其 digest 直接包含在 preset identity 中。DSH 运行过程中产生的消息历史、工具结果和 notebook/session 状态属于运行时状态，不进入不可变 `EvolutionSpec`。

Gear 只负责保存 DSH session 的恢复与分叉引用；未来只有出现可替换的跨 evolution 外部长期记忆后端时，才单独设计 provider、snapshot、检索证据和写入隔离协议。

## 5. DSH Meta Agent 与有效请求归因

### 5.1 开发者扩展方式

开发者通过不同的 DSH preset 提供完整 Meta Agent：

```text
.agent-presets/
├── refine-meta-basic/
│   └── agent.cordis.yml
├── refine-meta-with-skills/
│   └── agent.cordis.yml
└── refine-meta-with-docs/
    ├── agent.cordis.yml
    ├── system.md
    ├── skills/
    └── docs/
```

preset 可以使用 DSH 原生 composition 组合 system prompt、skills、workflows、plugins、扩展工具和只读文档。Gear 为每个 evolution 解析指定 preset，固定其 dependency digest，并在 agent scope 中追加 candidate workspace、evidence、finalization 和 held-out 隔离能力。

开发者 preset 不能覆盖 Gear-owned provider、读取 held-out、访问 candidate Git metadata 或改变 promotion state。Meta Agent 内容始终位于 target/candidate repository 之外。

### 5.2 Per-evolution Meta Agent

当前全局 `DshMetaAgentHost(config.metaPreset, config.metaModel)` 必须改为根据 `spec.metaAgent` 创建 runtime。同一 Gear 进程应能同时运行：

```text
Evolution A -> refine-meta-basic
Evolution B -> refine-meta-with-docs
Evolution C -> refine-meta-security
```

每个 evolution 的 preset、模型、sampling 和 Meta session ownership 相互隔离。普通全局配置只为新 evolution 选择默认 preset。

### 5.3 Agent 内部状态

静态资料随 preset 固定；动态历史由 DSH session 自己管理。Gear 不解释 Agent 内部的“记忆”语义，只持久化恢复和分叉所需的引用：

```ts
interface MetaRuntimeState {
  sessionId: string
  parentSessionId?: string
  checkpointRef?: string
  checkpointDigest?: string
}
```

多 candidate 从同一个已持久化 session checkpoint 分叉，之后各自拥有独立 session。winner 或 survivor 继续使用自身的 session lineage；Gear 不为此建立平行的 memory lineage。

### 5.4 当前 Gear 可直接支持的 sampling 范围

当前 DSH 请求配置支持 `temperature`，但不支持统一的 `topP` 和 `seed`。第一阶段只接受：

```yaml
metaAgent:
  sampling:
    temperature: 0.8
```

配置出现当前 DSH 无法执行的 `topP` 或 `seed` 时必须启动失败，不能静默忽略或只写入审计。

### 5.5 请求注入

Meta Agent scope 通过 DSH `agent/request` waterfall 注入 sampling：

```ts
agentCtx.on('agent/request', async (_payload, next) => {
  const current = await next()
  return {
    ...current,
    ...(sampling.temperature === undefined
      ? {}
      : { temperature: sampling.temperature }),
  }
})
```

create 和 resume 必须使用同一逻辑，并从 evolution spec 读取配置。

### 5.6 Attribution

```ts
interface EffectiveMetaRequest {
  requestHeaderSeq: number
  config: {
    provider: string
    model: string
    maxTokens?: number
    temperature?: number
  }
}
```

round attribution 从真实 `request/header.config` 构造 `EffectiveMetaRequest`，不得把 spec 中的声明值直接复制成“有效值”。

如果同一 proposal 期间出现多个不同的有效 request header，现有 fail-closed 行为继续保留；未来只有在 proposal evidence 能逐请求归因时才允许放宽。

## 6. Continuation 与运行时解析

### 6.1 新 evolution

普通 `/refine` 使用当前配置完成以下解析：

1. 解析完整 DSH Meta preset dependency closure 并计算内容 digest；
2. 解析所有 component implementation identity；
3. 验证 provider capabilities；
4. 生成 `EvolutionSpec`；
5. 计算 spec digest；
6. 原子写入 evolution registry 和 state。

### 6.2 Continue

`/refine continue <evolution-id>`：

1. 读取并验证 spec digest；
2. 根据 spec 中的 `ComponentRef` 解析组件；
3. 验证实现 integrity、DSH runtime identity、preset dependency digest 和 dataset digest；
4. 使用 `spec.metaAgent` 中的 preset、model、sampling，以及独立持久化的 `MetaRuntimeState` 创建或恢复 session；
5. 使用 spec 中的 rollout provider 和配置创建 evaluator；
6. 任一组件缺失、版本不兼容或 digest 不一致时拒绝继续。

全局配置在此流程中不得提供实验语义 fallback。

### 6.3 Demo 阶段的破坏性升级

当前不实现旧 spec 迁移或兼容读取。`EvolutionSpec`、round plan 或 population 结构发生不兼容变化时：

- 开发者显式清理旧 demo state；
- 使用当前配置重新创建 evolution；
- 不允许用当前默认值补齐旧记录后继续运行；
- Git candidate commit 和 Hitch RunRecord 可以继续独立保留，但旧 Gear state 不保证可恢复。

一旦项目开始保留不可丢失的长期实验或发布稳定版本，必须在那次发布前补充持久化格式版本和迁移策略。

## 7. EvaluationCondition 与配对评测

### 7.1 类型

```ts
interface EvaluationCondition {
  conditionId: string
  task: {
    id: string
    digest: string
  }
  repetition: number
  seed?: number
  model: string
  sampling: RolloutSamplingConfig
  timeoutMs: number
}

interface ResolvedRoundPlan {
  planId: string
  digest: string
  seedConditions: EvaluationCondition[]
  heldOutPlanRef: string
  heldOutPlanDigest: string
}
```

Evolution spec 保存 task sampling policy。每轮开始时，`TaskSampler` 把 policy 解析成确切任务和 `EvaluationCondition`，Gear 在任何 rollout 前持久化 `ResolvedRoundPlan`。

### 7.2 独立执行

对同一条件 `C101`：

```text
baseline H0 × C101 -> container A -> session A -> run A
candidate H1 × C101 -> container B -> session B -> run B
candidate H2 × C101 -> container C -> session C -> run C
```

三个 rollout 共享 `conditionId` 和不可变条件定义，但容器、workspace、session、trajectory 和 run ID 完全隔离。

task 也必须从同一不可变 definition 或 snapshot 分别 materialize，不能共享一个可写 task instance。

### 7.3 Evidence

```ts
interface RolloutExecutionEvidence {
  conditionId: string
  harnessRef: string
  runId: string
  sessionId?: string
  reward: number
  requestedConfig: JsonValue
  effectiveConfig: JsonValue
  trajectoryRef?: string
  providerRequestId?: string
}

interface PairedTrial {
  conditionId: string
  baseline: RolloutExecutionEvidence
  candidate: RolloutExecutionEvidence
  rewardDelta: number
}
```

promotion 使用 `PairedTrial` 聚合结果，不再仅依赖两个 Hitch invocation fingerprint 相等。

### 7.4 Semantic config 与 execution config

```ts
interface RolloutSemanticConfig {
  model: string
  sampling: RolloutSamplingConfig
  repetitions: number
  seeds?: number[]
}

interface RolloutExecutionConfig {
  maxConcurrent: number
  setupTimeoutMs: number
  terminationGraceMs: number
}
```

semantic config 进入 experiment/plan digest。execution config 记录在运行 manifest 中，主要控制调度，不作为独立实验维度。

如果并发会改变 provider 行为或限流结果，该影响必须出现在 execution evidence 和基础设施错误分类中，不能伪装为 candidate reward。

## 8. 组件 provider

优先复用 Cordis service/provider 生命周期，不建立无所有权和卸载语义的进程全局 registry。

DSH preset 已经是 Meta Agent 的原生插拔单元，不再定义平行的 `MetaAgentProvider`。Gear需要注册的是进化算法组件：CandidateGenerator 决定生成哪些方案，CandidateSelector 决定保留哪些方案，PromotionPolicy 决定 finalist 是否足以替换 champion。

```text
生成哪些方案
    -> CandidateGenerator
从 seed/dev candidate pool 中选谁
    -> CandidateSelector
finalist 是否通过 held-out 并替换 champion
    -> PromotionPolicy
```

### 8.1 CandidateGenerator

CandidateGenerator 扩展搜索空间。它可以实现 single proposal、best-of-N、多温度采样、ablation、beam search 或 population-based generation。不同完整 DSH Meta presets 首先作为不同 evolution 的 `metaAgent` 身份；未来若一个 generator 要在同一 evolution 内编排多种 Meta Agent，必须把所有 resolved Meta Agent identities 显式固化进 spec，不能从运行时全局配置临时选择。

```ts
interface CandidateGenerator {
  generate(
    request: CandidateGenerationRequest,
    capabilities: CandidateGenerationCapabilities,
  ): Promise<CandidateSubmission[]>
}

interface CandidateGenerationRequest {
  evolutionId: string
  roundId: string
  parentPopulation: ParentCandidate[]
  baselineEvidence: EvaluationEvidence
  metaAgent: DshMetaAgentSpec
  maxCandidates: number
  budget: {
    maxModelRequests?: number
    maxTokens?: number
    timeoutMs: number
  }
}

interface CandidateGenerationCapabilities {
  forkMetaAgent(parentSessionId: string, checkpointRef?: string): Promise<MetaAgentHandle>
  createWorkspace(parentHarnessRef: string): Promise<CandidateWorkspaceHandle>
  runCandidateCheck(workspaceId: string): Promise<CandidateCheckResult>
  sealWorkspace(workspaceId: string): Promise<CandidateDiffSummary>
}

interface CandidateSubmission {
  candidateId: string
  parentCandidateIds: string[]
  metaSessionId: string
  workspaceId: string
  finalization: CandidateFinalization
  metaEvidence: MetaAttribution
  metaCheckpointRef?: string
}
```

CandidateGenerator 不直接创建 Git commit、读取 held-out、写 Gear state 或更新 champion。Gear创建和约束 workspace，并在收到 submission 后执行 seal、diff 校验、固定 compiler、manifest 和 exact commit 流程。

`maxCandidates` 和生成预算属于 CandidateGenerator，不在 selector 中重复声明 `candidatePoolSize`。

### 8.2 CandidateSelector

CandidateSelector 扩展搜索策略。它只读取已经持久化的 seed/dev evaluation 和 metrics，不生成 candidate、不读取 held-out、不更新 champion。

```ts
interface CandidateSelector {
  select(request: CandidateSelectionRequest): Promise<SelectionDecision>
}

interface CandidateSelectionRequest {
  evolutionId: string
  roundId: string
  candidates: Array<{
    candidateId: string
    parentCandidateIds: string[]
    harnessRef: string
    evaluation: EvaluationEvidence
    metrics: MetricSet
  }>
  survivorLimit: number
}

interface SelectionDecision {
  selectedCandidateIds: string[]
  rankedCandidateIds?: string[]
  reason: string
  metricsDigest: string
}
```

第一批 selector 可以依次支持 highest quality、max paired gain、weighted score、Pareto frontier、diversity-aware selection 和 MAP-Elites。selector 应尽量是纯函数，使同一 candidate pool 可以离线重放和比较多种算法，而不重新消耗 rollout。

### 8.3 PromotionPolicy

PromotionPolicy 是 selector 之后的最终业务 gate。selector 回答“pool 中谁最好”，PromotionPolicy 回答“这个 finalist 是否足以替换当前 champion”。pool 中最好的 candidate 仍可能因为 held-out regression、required task 退化、成本或安全指标而被拒绝。

```ts
interface PromotionPolicyProvider {
  decide(request: PromotionRequest): Promise<PromotionDecision>
}

interface PromotionRequest {
  evolutionId: string
  roundId: string
  currentChampion: ArtifactRef
  candidate: {
    candidateId: string
    harnessRef: string
    harnessDigest: string
  }
  seedEvaluation: EvaluationEvidence
  heldOutEvaluation: EvaluationEvidence
  pairedTrials: PairedTrial[]
  metrics: MetricSet
}

interface PromotionDecision {
  decision: 'accept' | 'reject'
  reason: string
  checks: Array<{
    name: string
    passed: boolean
    observed?: number
    threshold?: number
  }>
}
```

PromotionPolicy 只能返回结构化决定，不能直接写 `champion.json`、更新 Git ref、publish 或 rollback。Gear先执行不可配置的完整性和安全检查，再调用 policy；只有 policy 返回 accept 后，Gear才执行 champion CAS。

以下硬性规则不能被 PromotionPolicy 插件关闭：

- candidate 必须是本轮 Gear 构建的 exact commit；
- baseline/candidate evidence 必须匹配同一 resolved plan；
- required rollout 和有效配置证据完整；
- 基础设施失败不能被当作零分 candidate；
- held-out 不进入 Meta Agent 或 CandidateSelector projection；
- current champion parent identity 未发生变化；
- component implementation 和配置与 spec 一致；
- promotion 必须由 Gear通过 CAS 完成。

### 8.4 其他算法组件

```ts
interface TaskSampler {
  resolve(request: TaskSamplingRequest): Promise<ResolvedTaskSet>
}

interface RolloutProvider {
  run(request: RolloutRequest): Promise<RolloutExecutionEvidence[]>
}

interface Judge {
  evaluate(request: JudgeRequest): Promise<MetricSet>
}
```

TaskSampler 只解析 seed/dev 或由 Gear控制的 held-out task set；RolloutProvider 负责隔离执行；Judge 把 evidence 转换为质量、成本、安全和多样性指标。

### 8.5 权限与信任级别

| 组件 | 核心职责 | held-out | workspace/Git 写权限 | champion 写权限 |
| --- | --- | --- | --- | --- |
| CandidateGenerator | 生成 candidate submission | 无 | 仅通过 Gear受限 capability | 无 |
| CandidateSelector | 从 seed/dev pool 选择 survivor | 无 | 无 | 无 |
| PromotionPolicy | 判断 finalist 是否可 promotion | 仅 Gear提供的受限 aggregate/evidence | 无 | 无 |
| Gear Core | 校验、隔离、提交和 CAS | 管理权限 | 有限且权威 | 唯一写者 |

CandidateSelector 最适合开放给第三方，因为它可以是无文件系统和模型权限的纯计算组件。CandidateGenerator 可高度扩展，但必须使用 Gear签发的 capabilities。PromotionPolicy 风险最高，只允许 trusted control-plane provider，并始终位于 Gear硬性 gate 之后。

### 8.6 Cordis 注册

```ts
ctx.candidateGenerators.register('best-of-n', generator)
ctx.candidateSelectors.register('pareto', selector)
ctx.promotionPolicies.register('paired-no-regression', policy)
```

Evolution spec 固化所选 provider 的 package、version、integrity、config 和 config digest。运行时找不到完全匹配的 provider 时拒绝新建或 continue，不按同名 provider 静默替换。

### 8.7 Capability validation

provider 在 admission 时声明能力：

```ts
interface ProviderCapabilities {
  temperature: boolean
  topP: boolean
  seed: boolean
  effectiveConfigEvidence: boolean
  providerRequestId: boolean
  nativeTrajectory: boolean
}
```

spec 请求 provider 不支持的能力时，新 evolution 创建失败。

### 8.8 泛化 evaluator evidence

`RefineEvaluator` 不再返回 `HitchEvaluationEvidence`。通用 evidence 只包含 Gear 所需字段，Hitch 特有数据放入 namespaced metadata：

```ts
interface EvaluationEvidence {
  provider: string
  planDigest: string
  executions: RolloutExecutionEvidence[]
  metrics: MetricSet
  metadata?: JsonValue
}
```

## 9. Best-of-N：先保持单 survivor

第一版多候选仅支持：

```yaml
candidateGeneration:
  strategy: dsh-meta-forked-proposals
  maxCandidates: 4
selection:
  strategy: highest-quality
  survivors: 1
```

### 9.1 每轮流程

1. 固化 `ResolvedRoundPlan`；
2. baseline 执行全部 seed/dev conditions；
3. 从同一个固定 Meta history prefix fork N 个 Meta session；
4. 为每个 session 创建独立 candidate workspace；
5. 生成和 finalize N 个 candidate；
6. 所有 candidate 执行相同 seed/dev conditions；
7. `CandidateSelector` 选出一个 finalist；
8. 只有 finalist 运行 held-out conditions；
9. `PromotionPolicyProvider` 决定是否更新 champion；
10. 未入选 candidate、session 和 evidence 归档，所有 workspace 清理。

### 9.2 Meta session fork

```text
Meta history prefix P
├── proposal session A
├── proposal session B
├── proposal session C
└── proposal session D
```

各 proposal session 不能顺序共享新增历史，否则后一个 proposal 会受到前一个 proposal 的思路影响，不再是相同起点的独立样本。

winner 的 Meta session 可以成为下一轮 lineage head；未入选 session 只保留审计记录。

### 9.3 Candidate 状态

```ts
type GitObjectId = string

interface SealedCandidateVersion {
  // candidate 的版本、血缘、评测和 promotion 身份。
  commitOid: GitObjectId
  // commitOid 引用的根 tree；用于内容等价、去重和缓存。
  treeOid: GitObjectId
  manifestDigest: string
  patchDigest: string
  immutableRef: string
}

interface CandidateRecord {
  candidateId: string
  roundId: string
  parentHarnessRef: string
  parentCandidateIds: string[]
  metaSessionId: string
  metaCheckpointRef?: string
  workspaceId: string
  sealedVersion?: SealedCandidateVersion
  proposal?: CandidateFinalization
  seedEvaluation?: EvaluationEvidence
  status:
    | 'generating'
    | 'ready'
    | 'evaluating'
    | 'selected'
    | 'discarded'
    | 'failed'
}
```

`sealedVersion` 在 candidate finalize 前不存在；seal 成功后一次性写入并保持不可变。Gear Controller 必须创建 commit、读取根 tree、校验二者关系并创建不可变 namespaced ref。Meta Agent 只能修改受控 workspace，不能自行 commit、移动 ref 或更新 champion。

如果两个 Candidate Record 的 `treeOid` 相同，它们仍然是两个独立 candidate：各自保留 proposal、parent、Meta session、生成成本和 lineage。Gear 可以将其标记为内容重复，并让后一个 candidate 显式引用前一个 candidate 的可复用结果，但不得合并或删除其生成事实。

评测复用不能只比较 Tree SHA。至少必须同时匹配实际参与结果的条件身份：

```text
treeOid
+ manifestDigest
+ evaluation condition / resolved plan digest
+ toolchain、sandbox 和 rollout provider 的有效身份
```

完整匹配时才能复用运行或缓存；否则只能得出“Git 文件内容相同”，不能得出“实验相同”。模型、sampling、task、seed、外部 dataset 和运行环境都不包含在 Tree SHA 中。

`RefinementRound` 的单值 `candidateRef/candidateDigest/evaluation` 迁移为：

```ts
candidatePool: CandidateRecord[]
selection?: SelectionDecision
promotedCandidateId?: string
```

## 10. Held-out 使用规则

candidate pool 只能根据 seed/dev evidence 选择 finalist。默认每轮只有一个 finalist 进入 held-out：

```text
candidate pool
  -> seed/dev selection
  -> one finalist
  -> held-out evaluation
  -> promotion
```

禁止对全部 candidate 使用 held-out 后再选择最高分。这样会随着轮数增加而把 held-out 变成隐式训练集。

如果 finalist 未通过 held-out，本轮直接拒绝。默认不自动尝试第二名，避免反复探测 held-out。未来若支持多重比较，必须在 spec 中显式声明固定预算和校正策略。

## 11. Population、survivor 与 lineage

best-of-N 稳定后，再支持 `survivors > 1`。

```ts
interface PopulationState {
  evolutionId: string
  generation: number
  members: PopulationMember[]
  digest: string
}

interface PopulationMember {
  candidateId: string
  harnessRef: string
  harnessDigest: string
  parentCandidateIds: string[]
  lineageRootId: string
  metaSessionId: string
  metaCheckpointRef?: string
  metrics: MetricSet
  selectedAt: string
}
```

下一代必须持久化 parent allocation：

```ts
interface ParentAllocation {
  parentCandidateId: string
  proposalCount: number
}
```

示例：

```text
H0
├── B
│   ├── B1
│   └── B2
└── D
    ├── D1
    └── D2
```

Gear 必须记录每个 child 的 parent commit、parent candidate、Meta session lineage、metrics 和 selection reason。

population state 与 champion state 分开保存：

```text
population = [B, D]
deployment champion = B
```

## 12. Judge 与质量—多样性选择

```ts
interface MetricSet {
  quality: number
  taskSuccessRate: number
  cost?: number
  latency?: number
  safety?: number
  trajectoryDiversity?: number
  descriptors?: Record<string, string | number>
}
```

trajectory diversity 可以组合：

- tool-call 序列差异；
- action type 分布；
- 错误恢复路径；
- token、成本和延迟；
- 完成步骤数；
- 最终策略 embedding；
- 不同任务类别上的行为描述符。

selector 按以下顺序交付：

1. highest quality；
2. weighted score；
3. Pareto frontier；
4. quality-diversity；
5. MAP-Elites。

MAP-Elites 必须在 spec 中固定 feature descriptors 和 niche boundaries，不能只使用一个未定义的“多样性分数”。

## 13. DSH 与 Hitch 依赖改造

### 13.1 DSH

Gear 第一阶段可使用现有 `agent/request` 支持 `temperature`。如果研究接口需要 `topP/seed`，DSH 需要同步增加：

- `LlmCallConfig.topP/seed`；
- `GenerateOptions` 映射；
- durable `request/header` 记录；
- call-config equality；
- provider adapter 序列化；
- resume/reconstruction tests；
- capability discovery。

provider 不支持某字段时必须明确拒绝。

### 13.2 Hitch

短期由 `HitchCliRolloutProvider` 将 conditions 转换为单次或分组 Hitch 调用。

长期建议 Hitch 支持：

```text
hitch eval run --plan rollout-plan.json
```

plan/result 合同必须包含：

- `conditionId`；
- task identity 和 digest；
- repetition；
- seed；
- requested/effective sampling；
- harness commit；
- run ID；
- reward 和 trajectory ref。

未支持 seed 的 provider 必须将结果标记为 `stochastic-unseeded`，Gear 不得把它表示为严格 seed-paired comparison。

## 14. 状态与恢复

新增持久对象：

```text
evolutions/<evolution-id>/
  spec.json
  champion.json
  population.json             # 多 survivor 阶段启用
  meta.json
  meta-resources/
    preset-manifest.json
  rounds/<round-id>.json
  plans/<round-id>.json
  candidates/<candidate-id>.json
  locks/
  candidate-worktrees/
```

恢复规则：

- spec、resolved plan、candidate record 和 population 都必须验证 digest；
- sealed candidate 必须验证 `treeOid == commitOid^{tree}`，其不可变 ref 必须仍指向同一个 `commitOid`；
- resolved DSH preset dependency manifest 和 Meta session checkpoint 必须验证 digest；
- 并行 proposal 必须从明确的 parent session checkpoint 分叉，不能共享可变 session；
- 进程重启时不重新执行未达到 durable checkpoint 的模型请求；
- 未完成 rollout 标记基础设施失败或根据明确 retry policy 重试；
- 已完成 rollout evidence 不得因重启重复计分；
- candidate workspace 继续使用 sidecar 精确恢复和清理；
- population 更新、champion promotion 和 registry touch 各自保持原子语义；
- accepted/rejected/discarded candidate 的 Git ref 和 evidence 保持可审计。

## 15. 测试与验收

### 15.1 Meta sampling

- `temperature` 出现在真实 request header；
- attribution 读取有效 header；
- create/resume 行为相同；
- `topP/seed` 在 provider 不支持时拒绝；
- 声明值和有效值不一致时 fail closed。

### 15.2 DSH Meta Agent 与 session

- 不同 evolution 可以同时解析并运行不同 DSH Meta presets；
- preset 中 system prompt、skill、workflow、只读文档或 plugin 内容变化都会改变 dependency digest；
- Gear-owned candidate/evidence providers 不能被开发者 preset 覆盖；
- preset 不能引用 target/candidate repository 或 held-out；
- Meta session 状态不写入不可变 `EvolutionSpec`；
- 并行 proposal 从同一个已持久化 session checkpoint fork，但后续 session 相互隔离；
- winner/survivor 只继续自身的 Meta session lineage；
- session checkpoint digest 不一致时拒绝恢复。

### 15.3 Continuation

- 修改全局 Meta 配置后 continue 仍使用旧 spec；
- 修改全局 Hitch 配置后 continue 仍使用旧 spec；
- preset 内容变化时拒绝 continue；
- component integrity 不匹配时拒绝 continue；
- 不兼容的旧 demo state 被明确拒绝，不使用当前默认值隐式补全。

### 15.4 Evaluation conditions

- baseline/candidate 使用相同 condition IDs；
- harness commit 是 paired condition 中唯一计划内差异；
- rollout 容器、workspace、session 和 run ID 不同；
- task 从同一 immutable snapshot 分别 materialize；
- provider 回显的 effective config 与 condition 一致；
- 缺失 condition 或错配 evidence 不能 promotion。

### 15.5 算法组件

- CandidateGenerator 不能读取 held-out、直接提交 Git commit 或写 champion；
- CandidateSelector 对相同持久输入产生可重放 decision；
- CandidateSelector 只读取 seed/dev evidence；
- PromotionPolicy 只能返回结构化 decision，不能写 state 或 Git ref；
- Gear硬性 evidence、commit、plan 和 CAS gate 不能被插件关闭；
- component package/version/integrity/config 不匹配时拒绝运行；
- `maxCandidates` 仅由 CandidateGenerator spec 定义，`survivors` 仅由 CandidateSelector spec 定义。

### 15.6 Best-of-N

- N 个 Meta session 从同一 prefix fork；
- N 个 workspace 相互不可读写；
- 每个 sealed candidate 都记录并验证 `commitOid`、`treeOid`、manifest digest、patch digest 和不可变 ref；
- 相同 Tree SHA 的不同 candidate 仍保留独立 proposal 和 lineage；
- 只有 Tree SHA 和完整 resolved evaluation condition 均相同时才能复用评测结果；
- baseline evidence 可按 plan digest 复用；
- 所有 candidate 使用相同 seed/dev conditions；
- 只有 finalist 运行 held-out；
- 未入选 candidate 不改变 champion；
- 任一 candidate 失败不污染其他 candidate；
- 所有 terminal/error/restart path 清理 workspace。

### 15.7 Population

- survivor parent/child lineage 可完整恢复；
- population digest 检测篡改；
- 多 survivor 不改变单一 deployment champion 语义；
- 不同 lineage 的 Meta history 不混用；
- selector 决策包含输入 metrics、component identity 和 reason。

## 16. 实施顺序

建议拆成以下独立里程碑：

1. `metaSampling.temperature` 真正进入 DSH request，并记录有效 header；
2. 将完整 DSH Meta preset 解析为 per-evolution identity，固定 dependency digest；
3. 持久化 DSH Meta session checkpoint，支持恢复和隔离 fork；
4. 升级 `EvolutionSpec`，Meta/Hitch/preset 全部从 spec 恢复；
5. `EvaluationCondition`、`ResolvedRoundPlan` 和 `PairedTrial`；
6. 泛化 evaluator evidence，引入 `RolloutProvider`；
7. 分别引入 CandidateGenerator、CandidateSelector、PromotionPolicy Cordis provider 和 implementation integrity；
8. sealed candidate 标准记录 `commitOid/treeOid/manifestDigest/patchDigest/immutableRef`，建立版本身份、内容身份和 ref 保活约束；
9. best-of-N，保持 `survivors: 1`，增加基于 Tree SHA 与完整条件身份的去重和条件化缓存；
10. population、lineage 和 `survivors > 1`；
11. trajectory diversity 和质量—多样性 selector；
12. DSH/Hitch 上游增加 `topP`、`seed` 和 plan execution 支持。

## 17. 非目标

第一阶段不承诺：

- 重新发明一套 Gear 专属 Meta Agent、system prompt、skill、文档或 memory provider DSL；
- hosted model 在相同 seed 下产生 bitwise-identical token 输出；
- 自动合并多个 survivor 的代码或 Meta history；
- 使用 held-out 选择 candidate pool；
- 允许算法插件绕过 Gear 的 workspace、evidence 或 promotion 安全核心；
- 在没有 feature descriptors 的情况下直接实现 MAP-Elites；
- 为不支持 seed 的 provider 声称严格可复现。

Gear 的可复现目标是：实验计划可重放、配置和实现可验证、实际请求可审计、baseline/candidate 条件可配对、随机实验可以在相同声明条件下重复并进行统计比较。

## 18. 当前实现状态

截至 2026-08-25，本方案已经落地以下部分：

- `EvolutionSpec` 已直接破坏性升级，不引入 `EvolutionSpecV2`、`schemaVersion` 或旧状态迁移；
- `metaSampling.temperature` 通过 DSH `agent/request` 进入真实请求，attribution 从真实 `request/header.config` 读取并校验；
- 完整 DSH preset 文件闭包、外部文档和 DSH runtime package bytes 都进入 per-evolution identity，`continue` 会重新解析 preset、runtime、dataset 和 component identity；
- rollout、task sampler、judges、selection 和 promotion 配置固化进不可变 spec；
- `EvaluationCondition`、`ResolvedRoundPlan`、provider-neutral `EvaluationEvidence` 和逐 trial `PairedTrial` 已持久化，并在 baseline/candidate provider、condition 和有效配置不一致时 fail closed；
- CandidateGenerator、TaskSampler、RolloutProvider、Judge、CandidateSelector 和 PromotionPolicy 已进入公开 `ComponentRegistry`，registry 作为 `ctx.evolutionComponents` Cordis service 暴露，注册返回卸载函数；
- 组件引用校验 `type/apiVersion/package/version/integrity/configDigest`。内置组件 integrity 来自实际发布模块和 package manifest bytes，而不是仅对版本字符串做摘要；
- sealed candidate 标准记录并恢复校验 `commitOid/treeOid/manifestDigest/patchDigest/immutableRef`；
- round 已使用 `candidatePool`，并持久化 selection、population、parent IDs、lineage root 和 metrics；当前 population size 仍为 1；
- 候选生成 `timeoutMs` 会真实中止和清理；DSH 无法审计的总请求数/总 token 预算会明确拒绝；
- demo 旧 state 会被明确拒绝，不会用当前全局配置隐式补齐。

以下能力没有伪装成已实现，而是在 admission/continue 阶段明确拒绝：

| 能力 | 当前行为 | 所需前置能力 |
| --- | --- | --- |
| `meta topP/seed` | 类型暂不暴露 | DSH call config、adapter 和 durable request header 支持 |
| rollout `seeds/temperature` | 配置出现即拒绝 | Hitch plan/result 合同和 adapter 有效值回显 |
| 每个 task/repetition 的独立 condition cell | 当前 condition 固定一次不可变 dataset invocation，内部 trial 形成 `PairedTrial` | Hitch 在执行前解析并回传显式 rollout plan |
| `maxCandidates > 1` | 创建 evolution 前拒绝 | DSH durable session checkpoint/fork |
| `survivors > 1` | 创建 evolution 前拒绝 | 多候选执行完成后才能启用的 parent allocation 和 session lineage |
| trajectory diversity、Pareto、MAP-Elites | 尚未提供内置实现 | 规范化 trajectory descriptors 和多候选池 |

因此当前代码完成的是安全、可恢复、可扩展的第一阶段骨架，以及单候选路径上的真实参数闭环；它没有声称已经完成受 DSH/Hitch 上游能力阻塞的 best-of-N 和质量—多样性算法。后续实现这些能力时应删除对应 capability rejection，并补齐第 15 节中相应验收测试，而不是绕过验证。

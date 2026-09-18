# Meta Agent 轨迹重建与 Verifier Evidence 实施方案

- 状态：Gear 与 Hitch verifier phases implemented；本地端到端验证通过
- 涉及仓库：`gear`、`agent-hitch`
- Gear 核查基线：`c9da5f9e8244f7d91e735ac36d16a1531f22e866`
- Hitch 核查基线：`4ad697d9bc8219917a2d2d234107deaeca81b41e`
- Hitch verifier 实现：`6351425787c242f1318b89f3405697cbee930893`
- 日期：2026-09-02
- 取代：[Hitch Run Evidence 与语义轨迹查询开发需求](hitch-run-evidence-query-development-requirements.md)

## 1. 决策摘要

新的实现采用以下职责边界：

```text
Hitch
├── 继续保存原生 Agent trajectory
├── 继续保存 canonical DSH trajectory
├── 公开 structured verifier result 与 bounded verifier diagnostics
└── 校验 run、artifact、路径和 digest

Gear
├── 直接读取 canonical DSH trajectory
├── 缓存每个 run 的完整 canonical trajectory
├── 使用 DSH surface/header 语义重建有效上下文
├── 按 turn/step/callId 投影 semantic steps
├── 合并 Hitch verifier evidence 与 Gear baseline reward
├── 生成面向 Meta Agent 的 failure bundle
├── 返回可直接执行的恢复动作与诊断进度
└── 根据 bundle coverage 记录 diagnosis receipt
```

关键决策：

1. Hitch 不负责重建 Meta Agent 使用的 semantic trajectory；
2. Gear 不读取 provider-native trajectory，也不直接访问 Hitch 内部文件；
3. Gear 通过现有 `hitch trajectory inspect <run-id> --json` 获取 canonical DSH trajectory；
4. Hitch 只新增 verifier evidence 的稳定只读接口；
5. 第一阶段可以不修改 Hitch，先完成 Gear-only 轨迹重建；
6. Meta 的证据前置条件失败必须返回结构化恢复计划，不能只抛一段错误字符串；
7. server-side trajectory 索引或过滤属于后续性能优化，不是首轮正确性前提。

## 2. 为什么这样划分

### 2.1 Gear 已经能读取 canonical DSH trajectory

Hitch 当前为 DeepSeek run 保存：

```text
runs/<run-id>/
├── trajectory/provider/deepseek-session.jsonl
└── trajectory/canonical/.../session.jsonl
```

现有命令：

```bash
hitch trajectory inspect <run-id> --json
```

返回 canonical DSH trajectory 的：

```json
{
  "schema_version": "1",
  "run_id": "run_...",
  "ref": {},
  "header": {},
  "events": []
}
```

因此“Meta Agent 无法读取 DSH trajectory”不是事实。当前问题是 Gear 收到后只做 raw event 分页，没有应用 DSH 已有的 surface、request header 和 message projection 语义。

### 2.2 DSH trajectory 已经包含重建所需结构

canonical trajectory 已包含或定义：

- `request/header`；
- `user/message`；
- assembled `assistant/message`；
- `tool/call`；
- `tool/result`；
- `turn/start` / `turn/end`；
- `step/start` / `step/end`；
- `surfaceOp`；
- `sourceEventSeqs`；
- compaction replacement；
- `ignorable` 扩展事件。

Gear 又已经依赖 `@deepseek-ai/dsh-session`，可以复用 `foldSurface()`、`deriveEventMessage()` 和 `foldRequestHeader()` 的合同。将这些逻辑移到 Hitch 会重复实现 DSH 语义，并使 Meta 专用投影侵入 run storage 层。

### 2.3 Verifier evidence 属于 Hitch

Hitch 已经拥有：

- run manifest observation；
- reward；
- `verifier_result_ref`；
- `runs/<run-id>/verifier/result.json`；
- run 到 eval/trial/Harbor job 的身份映射；
- verifier artifact 的文件边界和完整性校验。

Gear 当前只通过 CLI 集成 Hitch，不应直接打开 `hitch.root/runs/...` 或 Harbor job 目录。因此 verifier result/log 的公开读取必须由 Hitch 提供。

## 3. 当前问题

### 3.1 Gear 轨迹读取

当前 Gear 每次查询都会：

```text
执行 hitch trajectory inspect
→ 接收完整 trajectory JSON
→ 解析全部 events
→ events.slice(offset, offset + limit)
```

默认 limit 为 20，上限为 100。一个包含 103,479 条事件的 run 需要约 1,035 页，其中 103,321 条是 `assistant/chunk`。

### 3.2 Gear diagnostics

当前只提供：

- event type 计数；
- tool call/result/error 数量；
- 最多 20 个错误摘录；
- 最后三条 assistant 摘录。

没有提供有效消息 surface、步骤结构、完整工具配对、verifier 失败和 reward=0 原因。

### 3.3 Diagnosis gate

当前只要 Meta 查询某个 run 的 `offset=0`，Gear 就把该 run 记入 `diagnosedRunRefs`。这只能证明访问过首页，不能证明读取了有效轨迹或 verifier evidence。

### 3.4 Hitch verifier 读取

Hitch 已经把 structured verifier result 写入 run bundle，但现有 `trajectory inspect` 只返回 trajectory，不返回 observation 或 verifier result。

正常 verifier stdout/stderr 和 CTRF 可能仍位于 Harbor eval/job 目录，没有稳定的 run-centered CLI。

### 3.5 Finalization 失败不可操作

当前初始提示虽然要求 Meta 检查每个失败 baseline run，finalization 校验失败时也会列出缺失 run ID，但恢复体验仍然不足：

- 失败消息只有 run ID，没有任务名、reward、已完成数量和剩余数量；
- 没有返回可直接调用的 `trajectory_query` 参数；
- `candidate_check` 不检查 evidence readiness，问题只能到最终提交时才暴露；
- 每次轨迹查询后，不会告诉 Meta 还剩哪些失败任务；
- 普通错误字符串没有稳定错误码，Meta 需要自己解析自然语言；
- `finalize_candidate` 工具包装器必须区分“已接受”和“可恢复拒绝”，否则可能错误结束当前回合。

这会让 Meta 在接近时限时反复提交、手工映射 run ID，甚至已经补查最后一个 run 后仍来不及再次提交。

## 4. 目标与非目标

### 4.1 目标

1. Meta 一次查询即可看到一个失败 run 的 task、reward、verifier、关键步骤和 final answer；
2. 默认结果不包含 `assistant/chunk`；
3. Gear 能重建某次 LLM request 当时真正生效的消息 surface 和 request header；
4. Gear 能按 turn/step/callId 展示 assistant/tool 行为；
5. 每个 run 在一个 Gear 进程内只全量读取一次；
6. verifier result 和可用 diagnostics 通过 Hitch CLI 返回；
7. 缺失 verifier log、child session 或 workspace diff 时明确降级 coverage；
8. 只有成功读取 failure bundle 才能形成 diagnosis receipt；
9. 所有可恢复的 evidence gate 失败都返回明确的下一步工具调用；
10. Meta 在正式提交前可以主动查询 finalization readiness。

### 4.2 非目标

- Hitch 生成 semantic trajectory；
- Hitch 调用 LLM 总结 Agent 行为；
- Gear 解析 provider-native trajectory；
- 第一阶段实现 Hitch server-side trajectory paging/index；
- 把完整 trajectory 复制进 Gear state；
- 暴露 held-out evidence；
- 从工具调用伪造权威 workspace diff；
- 强制保存完整 Harbor 容器文件系统。

## 5. 总体数据流

```text
                        ┌─────────────────────────────┐
                        │ Hitch canonical DSH traj    │
                        │ header + events + digest    │
                        └──────────────┬──────────────┘
                                       │ trajectory inspect，一次/run
                                       ▼
┌──────────────────────┐      ┌─────────────────────────────┐
│ Gear baseline state  │─────▶│ Gear TrajectoryProjection   │
│ task/run/reward/eval │      │ surface/context/steps/cache │
└──────────────────────┘      └──────────────┬──────────────┘
                                             │
┌──────────────────────┐                     │
│ Hitch verifier API   │─────────────────────┤
│ result + diagnostics │                     │
└──────────────────────┘                     ▼
                                  ┌──────────────────────┐
                                  │ Gear FailureBundle   │
                                  │ bounded + references │
                                  └───────────┬──────────┘
                                              ▼
                                  ┌──────────────────────┐
                                  │ Meta trajectory_query│
                                  └──────────────────────┘
```

## 6. Phase A：Gear-only 轨迹重建

Phase A 不要求修改 Hitch。

### 6.1 新增 TrajectoryProjection 模块

建议新增：

```text
src/evaluator/trajectory-projection.ts
```

职责：

```ts
interface TrajectoryProjection {
  identity: TrajectoryIdentity
  sourceSummary: TrajectorySourceSummary
  contextEpochs: ContextEpoch[]
  semanticSteps: SemanticStep[]
  finalAnswer?: MessageEvidence
  diagnostics: ProjectionDiagnostics
}

function projectTrajectory(
  page: CompleteHitchTrajectory,
): TrajectoryProjection
```

该模块必须是确定性的纯投影，不读取 Gear state、不调用 Hitch、不调用模型。

### 6.2 完整 trajectory 读取

在 `HitchCliEvaluator` 中区分：

```ts
loadTrajectory(runId, signal): Promise<CompleteHitchTrajectory>
inspectTrajectory(...): Promise<HitchTrajectoryPage> // legacy/raw API
```

`loadTrajectory()`：

1. 执行一次 `hitch trajectory inspect <run-id> --json`；
2. 验证 schema、run ID、header 和 event seq；
3. 从 `trajectory.ref` 解析 canonical file SHA-256；
4. 返回完整 canonical trajectory；
5. 使用 single-flight cache，避免并发重复加载。

不得再把“读取 Hitch”和“截取 Meta 页面”放在同一个方法中。

### 6.3 缓存

首版使用进程内 bounded LRU：

```ts
interface CachedTrajectory {
  runId: string
  trajectorySha256: string
  bytes: number
  loaded: CompleteHitchTrajectory
  projection: TrajectoryProjection
}
```

要求：

- 同一 run 的并发首次读取共享一个 Promise；
- terminal Hitch run 视为 immutable；
- cache 同时受条目数和总 bytes 限制；
- eviction 只删除派生内存，不影响 Hitch evidence；
- abort 的调用不能留下 rejected Promise 永久占位；
- 不把完整 raw trajectory 持久化进 Gear round JSON。

建议配置：

```ts
trajectoryCache: {
  maxEntries: number
  maxBytes: number
}
```

### 6.4 Surface 重建

按 canonical seq 顺序应用 DSH surface 语义：

```text
surfaceOp: append
  → 把 user/message、assistant/message 或 tool/result 加入 surface

surfaceOp: replace
  → 替换 start..end 对应的当前 surface 连续区间
```

要求：

- 应用所有 replacements，不能只识别最近一次 compaction；
- 保留 replacement 与 shadowed seq 的来源关系；
- raw events 不删除；
- unknown required event 使 exact reconstruction 失败；
- `ignorable: true` event 可以跳过并计数；
- 没有合法 `surfaceOp` 的旧轨迹只能标记为 normalized/legacy，不能标记 exact；
- 输出应与 `@deepseek-ai/dsh-session` 的 `foldSurface()` fixtures 一致。

### 6.5 Context epoch

`step/start` 先建立候选检查点；同一步骤内若随后出现 `request/header`，先更新 header。
在该步骤第一条 `assistant/chunk` 或 `assistant/message` 到来前再次 fold surface/header，
将该时刻固定为实际模型请求边界。这样既不会漏掉 `step/start` 之后追加的消息，少量
initial/resume/change header 也能覆盖后续所有模型步骤：

```ts
interface ContextEpoch {
  id: string
  boundarySeq: number
  requestSeq?: number
  turn: number
  step: number
  requestHeaderDigest: string
  header: {
    config: JsonValue
    adapterDefaults?: JsonValue
    system?: ContentRef
    tools?: ContentRef
  }
  surfaceMessageSeqs: number[]
  omittedSurfaceMessageSeqCount?: number
  replacementGeneration: number
}
```

大 system prompt 和 tool schemas 不在多个 epoch 中重复复制，使用 digest/content ref 去重。
`adapterDefaults` 必须保留，因为它区分 exact adapter 自动填入的有效值和会话显式设置。
进入 failure bundle 时，config/defaults 和消息 seq 列表都转换为带 digest 与省略计数的
有界摘要；`view:"context"` 仍可用于单 run 深入读取。

### 6.6 Semantic steps

按 `turn + step` 聚合：

```ts
interface SemanticStep {
  id: string
  turn: number
  step: number
  seqStart: number
  seqEnd: number
  contextEpochId?: string
  assistantMessages: MessageEvidence[]
  toolActions: ToolAction[]
  terminalReason?: JsonValue
}
```

规则：

- 使用 assembled `assistant/message`，默认完全忽略 `assistant/chunk`；
- chunks 只通过 `sourceEventSeqs` 作为消息来源证据；
- `tool/call` 和 `tool/result` 按 `callId` 配对；
- 保留 raw arguments、model-facing result、structured error 和 seq；
- open/unpaired tool call 显式标记；
- `tool/code-dispatch-*` 作为 `run_code` 的子动作按需展开，不与顶层动作重复；
- 文件 effect 区分 `authoritative`、`observed`、`possible`；
- 不生成“Agent 意图”或“失败原因”等无直接证据的自然语言推断。

### 6.7 大内容

Meta 输出中的大字段使用：

```ts
interface ContentExcerpt {
  preview?: string
  tail?: string
  bytes: number
  sha256: string
  truncated: boolean
  source: {
    runId: string
    seq: number
    field: string
  }
}
```

首版 locator 可以是 Gear 内部的 typed source ref，不需要 Hitch 增加 content API，因为完整 trajectory 已在 Gear cache 中。

## 7. Phase B：Hitch Verifier Evidence API

Phase B 是 Hitch 唯一必需的功能修改。

### 7.1 Public CLI

建议新增：

```bash
hitch verifier inspect <run-id> --json
```

该命令只读取 verifier/run evidence，不返回 trajectory，不生成 semantic steps。

### 7.2 输出合同

```ts
interface HitchVerifierEvidenceV1 {
  schema_version: '1'
  kind: 'verifier-evidence'
  run_id: string

  parent?: {
    eval_id: string
    trial_id: string
    attempt: number
  }

  observation?: {
    status: 'valid' | 'invalid'
    reward?: number
    invalid_reason?: string
    verifier_result_ref?: string
  }

  verifier: {
    status: 'complete' | 'result_only' | 'missing' | 'corrupt'
    result?: JsonValue
    result_sha256?: string

    diagnostics?: {
      ctrf?: VerifierArtifactExcerpt
      stdout?: VerifierArtifactExcerpt[]
      stderr?: VerifierArtifactExcerpt[]
      infrastructure_error?: JsonValue
      retry_history?: JsonValue[]
    }
  }

  redactions?: Array<{
    rule_id: string
    count: number
  }>
}
```

`result_only` 表示 structured result 存在，但没有可用 CTRF/stdout/stderr。它是成功响应，不等于完整失败解释。

### 7.3 数据来源

按以下顺序读取：

1. `manifest.json` 中的 observation；
2. `observation.verifier_result_ref`；
3. run bundle 中的 `verifier/result.json`；
4. run bundle 中的 infrastructure error/retry history；
5. 通过 `parent.eval_id + parent.trial_id` 稳定定位的 Harbor verifier artifacts。

Hitch 必须复用现有 run record 文件边界校验：

- relative path；
- run/eval identity；
- regular file；
- symlink 拒绝；
- path traversal 拒绝；
- JSON/schema 校验；
- digest（如已有）校验。

### 7.4 Verifier 日志持久化

`verifier/result.json` 已经进入 run bundle，不需要改变保存逻辑。

对于以下文件：

```text
verifier/ctrf.json
verifier/test-stdout.txt
verifier/test-stderr.txt
verifier/stdout.txt
verifier/stderr.txt
```

采用两级策略：

1. 如果 Hitch 能通过 durable eval/trial record 稳定读取，则查询时读取；
2. 如果 Harbor job artifacts 会被清理或不能随 run bundle 迁移，则在 trial import 时保存 bounded 副本。

bounded 副本要求：

- 单文件可配置上限；
- 小文件原样保存；
- 大文件保存 head + tail；
- 记录原始 bytes、SHA-256 和 truncated 状态；
- owner-only 权限；
- 不因日志缺失改变已经有效的 reward；
- 缺失通过 `status: result_only` 表达。

这不是 canonical trajectory 格式修改，只是补充 verifier diagnostics artifact。

### 7.5 输出预算与脱敏

- structured result 和每个 diagnostics artifact 都必须有独立上限；
- stdout 不能无界增长；
- 返回前应用 Hitch 现有 credential/provider redaction；
- 不返回 Hitch root、Harbor root 或 workspace 绝对路径；
- Gear 仍执行 configured secret 和 held-out ref 的二次脱敏。

### 7.6 兼容

- 新命令是 additive；
- 现有 `trajectory inspect` 不变；
- 现有 run/trajectory schema 不变；
- 如果新增 bounded diagnostics sidecar，应是可选字段或固定 verifier 子目录，不改变 reward identity；
- Gear preflight 通过 Hitch semver 或机器可读 capability 判断是否支持；
- 旧 Hitch 进入 `verifier: unavailable` fallback。

## 8. Phase C：Gear Failure Bundle

### 8.1 `trajectory.query` 新语义

保持无 refs 的 round index 行为：

```ts
trajectory_query({})
```

传 refs 时新增 view：

```ts
trajectory_query({
  refs: ['run_...'],
  view: 'bundle' | 'steps' | 'context' | 'events',
  cursor?: string,
  limit?: number,
  maxBytes?: number,
  turn?: number,
  step?: number,
  eventTypes?: string[],
  aroundSeq?: number,
  radius?: number,
  errorsOnly?: boolean
})
```

默认：

```text
refs 存在且 view 省略 → view=bundle
```

旧 raw 分页保留为显式 `view=events`，不再作为默认结果。

### 8.2 Bundle 结构

```ts
interface GearFailureBundleV1 {
  schemaVersion: 1

  identity: {
    evolutionId: string
    roundId: string
    phase: 'seed-baseline' | 'seed-candidate'
    evalId: string
    runId: string
    taskName: string
    trialName?: string
    attempt?: number
    trajectorySha256: string
  }

  task: {
    prompt?: ContentExcerpt
  }

  outcome: {
    trialStatus: 'completed' | 'errored'
    reward?: number
    invalidReason?: string
    verifierStatus: 'complete' | 'result_only' | 'missing' | 'unavailable'
    verifierResult?: JsonValue
    verifierDiagnostics?: JsonValue
  }

  trajectory: {
    fidelity: 'exact-surface' | 'normalized-surface' | 'minimal' | 'unavailable'
    rawEventCount: number
    omittedEventTypes: Record<string, number>
    omittedEventTypeCount?: number
    contextEpochCount: number
    semanticStepCount: number
    keySteps: SemanticStep[]
    omittedStepCount: number
    finalAnswer?: MessageEvidence
  }

  workspace: {
    status: 'complete' | 'observed-only' | 'missing'
    pathsObservedThroughTools: string[]
    omittedPathCount?: number
  }

  crossSourceSignals: Array<{
    kind: string
    evidence: EvidenceRef[]
  }>

  coverage: {
    task: 'complete' | 'missing'
    trajectory: 'complete' | 'partial' | 'missing'
    verifier: 'complete' | 'result_only' | 'explicitly-missing' | 'unavailable'
    childSessions: 'complete' | 'partial' | 'none' | 'unavailable'
    workspace: 'complete' | 'observed-only' | 'missing'
  }

  bundleDigest: string
}
```

### 8.3 Key step 选择

默认 bundle 不嵌入所有步骤。按预算选择：

1. 第一条实质 assistant/tool step；
2. 所有含 structured tool error 的步骤；
3. 最后一次文件写入步骤；
4. 最后一次测试/检查步骤；
5. 最终回答步骤；
6. verifier diagnostics 能以路径、测试名或结构化 ref 关联的步骤；
7. 剩余预算内的相邻步骤。

其余步骤通过 `view=steps` 查询。

### 8.4 Cross-source signals

Gear 只生成结构化事实信号，不推断因果：

- `completed_run_with_zero_reward`；
- `completed_run_with_verifier_failure`；
- `completed_run_with_tool_errors`；
- `workspace_paths_observed_without_authoritative_diff`；
- `verifier_evidence_unavailable`。

“Agent 在最终回答中声称测试通过”由 Meta Agent 结合 final answer 判断，不由 Gear 用关键词假装成权威事实。

## 9. Phase D：Meta 可恢复失败协议

本阶段解决“服务端知道缺什么，但 Meta 不知道下一步该怎么做”的问题。目标不是增加更多提示词，而是让 authoritative gate 返回稳定、可执行、可追踪的恢复合同。

### 9.1 三层提醒

同一份 finalization readiness 应在三个时间点暴露：

1. `trajectory_query({})`：Meta 刚进入 round 时就看到失败 run 总数、已诊断数量和下一批查询；
2. `candidate_check()`：编译检查之外，同时返回 evidence readiness，让阻塞项在正式提交前暴露；
3. `finalize_candidate()`：作为最后防线，返回结构化可恢复拒绝和精确的下一步动作。

三层必须调用同一个 readiness 计算函数，不能分别复制规则，否则提示和最终校验会漂移。

### 9.2 Readiness 单一事实源

在 service 层新增确定性的只读计算：

```ts
interface MissingDiagnosis {
  taskName: string
  runId: string
  trialName?: string
  attempt?: number
  reward?: number
}

interface FinalizationReadiness {
  ready: boolean
  baselineEvalId: string
  failedRunCount: number
  diagnosedRunCount: number
  remainingRunCount: number
  missing: MissingDiagnosis[]
  blockers: RecoveryBlocker[]
  nextActions: CapabilityAction[]
}

function finalizationReadiness(
  round: RefinementRound,
  baseline: EvaluationEvidence,
  audit: ProposalEvidenceAudit,
): FinalizationReadiness
```

`failed run` 的判定必须与 authoritative finalization gate 共用同一个 predicate。任务名只作为展示标签；run ID、eval ID 和 receipt 才是证据身份。

`missing` 使用稳定顺序。API 最多接受 10 个 refs，但服务端恢复动作每批最多 5 个 run，
为每个 bundle 保留关键步骤的输出预算，并保证后续 run 不会遗漏。

若某个批次在实际序列化后仍无法为每个 run 保留至少一个关键步骤，`trajectory_query`
不会抛出只有自然语言的错误，也不会记录部分 receipt，而是返回
`BUNDLE_BATCH_TOO_LARGE`、`batchAccepted:false` 以及逐 run 的
`nextAction`/`remainingActions`。Meta 应执行这些拆分动作，而不是重试原批次。

### 9.3 通用恢复动作合同

```ts
interface CapabilityAction {
  actionId: string
  tool: 'trajectory_query' | 'candidate_check' | 'finalize_candidate'
  arguments: JsonValue
  reason: string
  coversRunIds?: string[]
}

interface MetaRecoveryRequiredV1 {
  schemaVersion: 1
  accepted: false
  recoverable: true
  code:
    | 'BASELINE_SUMMARY_REQUIRED'
    | 'MISSING_BASELINE_DIAGNOSIS'
    | 'EVIDENCE_REF_NOT_ACCESSED'
  failedOperation: 'candidate.finalize' | 'candidate.decline'
  message: string
  readiness: FinalizationReadiness
  nextAction: CapabilityAction
  remainingActions: CapabilityAction[]
  retry: {
    tool: 'finalize_candidate' | 'decline_candidate'
    reusePreviousArguments: true
  }
}
```

要求：

- `message` 是给模型看的简短说明；
- `code`、`readiness` 和 `nextAction` 是机器可读的权威数据；
- `nextAction.arguments` 必须能原样传给对应 typed tool；
- 服务端生成 action，不从 task prompt、trajectory 文本或 verifier 日志中提取命令；
- 任务名等不可信文本只能作为结构化 label，不能拼接成新的 Meta 指令。

### 9.4 缺失诊断时的具体返回

例如还缺一个任务时，`finalize_candidate` 返回：

```json
{
  "schemaVersion": 1,
  "accepted": false,
  "recoverable": true,
  "code": "MISSING_BASELINE_DIAGNOSIS",
  "failedOperation": "candidate.finalize",
  "message": "提交尚未完成：27 个失败 baseline run 中已诊断 26 个，剩余 1 个。请执行 nextAction，成功后使用相同参数再次调用 finalize_candidate。",
  "readiness": {
    "ready": false,
    "failedRunCount": 27,
    "diagnosedRunCount": 26,
    "remainingRunCount": 1,
    "missing": [
      {
        "taskName": "make-doom-for-mips",
        "runId": "run_...",
        "reward": 0
      }
    ]
  },
  "nextAction": {
    "actionId": "diagnose-failed-baseline-1",
    "tool": "trajectory_query",
    "arguments": {
      "refs": ["run_..."],
      "view": "bundle"
    },
    "reason": "读取最后一个失败 baseline run 的完整 failure bundle",
    "coversRunIds": ["run_..."]
  },
  "remainingActions": [],
  "retry": {
    "tool": "finalize_candidate",
    "reusePreviousArguments": true
  }
}
```

如果缺少超过单次 refs 上限的 run，`nextAction` 返回第一批，`remainingActions` 返回后续批次。每完成一次 bundle 查询，响应都附带更新后的：

```ts
diagnosisProgress: {
  failedRunCount: number
  diagnosedRunCount: number
  remainingRunCount: number
  missing: MissingDiagnosis[]
  readyToFinalize: boolean
  nextAction?: CapabilityAction
}
```

因此 Meta 不需要自己维护 run ID 到任务名的映射，也不需要猜是否已经全部读取。

### 9.5 `candidate_check` 返回两个维度

`candidate_check` 不应把编译成功和 finalization readiness 混成一个 `ok`：

```ts
{
  compiler: {
    ok: true,
    summary: {}
  },
  finalizationReadiness: {
    ready: false,
    blockers: [],
    nextActions: []
  }
}
```

缺少 trajectory diagnosis 是可恢复的 readiness blocker，不应伪装成编译失败，也不应只在最后一次提交时才被发现。

### 9.6 Finalize 工具的回合语义

`finalize_candidate` 的 notebook wrapper 必须改为：

```ts
const result = await call(...)
if (result.accepted === true) exec.concludeTurn()
return result
```

当 `accepted: false, recoverable: true` 时：

- 不调用 `concludeTurn()`；
- 不设置 `finalizationSubmitted`；
- 不 seal 或释放 candidate workspace；
- 不消耗 candidate；
- Meta 可以执行 `nextAction` 后重试原始提交。

不可恢复的身份错配、越权 ref、stale round 和内部损坏仍然抛 hard error，不伪装成恢复动作。

### 9.7 Prompt 文案

system prompt 只需要说明协议，不负责动态列举 run：

```text
Before finalizing, inspect finalizationReadiness from candidate_check.
If a tool returns accepted=false and recoverable=true, execute nextAction exactly,
then process remainingActions and retry the failed operation with the same arguments.
Do not end the turn until the operation returns accepted=true.
```

动态缺失列表始终由 typed response 提供，避免提示词与服务端真实状态不一致。

## 10. Diagnosis receipt

### 10.1 修复原则

下列行为不再标记 diagnosed：

- 查询 round index；
- 查询 `view=events`；
- 查询 raw event offset 0；
- 只得到 trajectory header；
- 查询因输出限制而没有返回 bundle coverage。

只有 `view=bundle` 成功返回并验证后才记录 receipt。

### 10.2 Receipt 结构

```ts
interface DiagnosisReceipt {
  runId: string
  bundleDigest: string
  trajectorySha256: string
  projectionVersion: number
  verifierStatus: 'complete' | 'result_only' | 'explicitly-missing' | 'unavailable'
  sanitizationPolicyDigest: string
  inspectedAt: string
}
```

建议把当前：

```ts
diagnosedRunRefs: Set<string>
```

升级为：

```ts
diagnosisReceipts: Map<string, DiagnosisReceipt>
```

为了兼容已有 state schema，可以在首版同时派生 `diagnosedRunRefs`，但 finalization gate 应校验 receipt，而不是只校验字符串集合。

### 10.3 可接受 coverage

一个 reward<=0 的 run 至少满足：

```text
task = complete
trajectory = complete
verifier = complete | result_only | explicitly-missing
```

`result_only` 可以签发 receipt，因为“verifier 没有保存更详细 diagnostics”本身已经被明确观察；receipt 必须保留该降级状态，Meta 不得把它描述为完整 verifier failure explanation。

`unavailable` 默认不能签发可通过 gate 的完整 receipt。旧 Hitch fallback 只有在部署方显式设置
`hitch.allowUnavailableVerifierDiagnosis=true` 时才允许 trajectory-only receipt；该 receipt
保留 `verifierStatus: unavailable` 和 `compatibility: allow-unavailable-verifier`，不能静默等同于 complete。
未开启兼容时，finalization 返回 `recoverable:false` 和精确 `operatorAction`，避免 Meta 重复查询同一 bundle。

## 11. Child session 与 workspace

### 11.1 Child session

当前 `trajectory inspect` 返回 root canonical session。DeepSeek child sessions 可能只存在于 provider artifacts。

首版：

- Gear 只重建 root canonical session；
- bundle 返回 `childSessions: unavailable` 或根据 trajectory ref 报告 `partial`；
- 不宣称已经读取完整子 Agent 行为。

后续如果确实需要子 Agent 分析，再给 Hitch 增加：

```bash
hitch trajectory sessions <run-id> --json
hitch trajectory inspect <run-id> --session <session-id> --json
```

子会话不是首轮 verifier/trajectory 修复的阻塞项。

### 11.2 Workspace

如果 Harbor 返回 `workspace_retained=false`：

- `workspace.status = missing` 或 `observed-only`；
- 可以返回从结构化工具调用观察到的文件路径；
- 不能返回伪造的 authoritative diff；
- Meta 必须知道最终产物无法完全验证。

最终 workspace snapshot/diff capture 是独立需求，不与本方案绑定。

## 12. 具体代码修改

### 12.1 Gear

建议修改：

```text
src/evaluator/hitch-cli.ts
  - 拆分 loadTrajectory 与 legacy inspectTrajectory
  - 解析 canonical SHA-256
  - 增加 bounded LRU/single-flight
  - 调用 hitch verifier inspect

src/evaluator/trajectory-projection.ts
  - 新文件
  - surface fold
  - context epochs
  - semantic steps
  - content excerpts

src/types.ts
  - CompleteHitchTrajectory
  - HitchVerifierEvidence
  - TrajectoryProjection
  - GearFailureBundle
  - DiagnosisReceipt
  - FinalizationReadiness
  - MetaRecoveryRequired
  - CapabilityAction
  - trajectory.query view 参数

src/capabilities.ts
  - refs 默认返回 bundle
  - steps/context/events drill-down
  - 合并 baseline 与 verifier evidence
  - bundle 成功后才记录 receipt
  - round summary 和 bundle 响应附带 diagnosisProgress
  - candidate_check 返回 compiler 与 finalizationReadiness
  - recoverable finalization blocker 返回 typed action plan
  - 过大 bundle batch 返回逐 run typed recovery actions
  - projection LRU 只缓存投影，不持有原始 trajectory，并同时受条目和字节预算约束
  - 保留 held-out/secret sanitization

src/notebook/tool.ts
  - 更新 trajectory_query schema
  - 提示 Meta 先读 bundle，再按需 drill-down
  - 说明 accepted=false 的恢复协议
  - finalize/decline 只在 accepted=true 时 concludeTurn

src/meta/session.ts
src/meta/skill.ts
src/meta/controller.ts
  - evidence access 从 run ID 集合升级为 receipt

src/refine/service.ts
  - finalization gate 验证每个失败 run 的 receipt
  - 新增共用 finalizationReadiness 计算
  - recoverable evidence blocker 不消费 candidate/workspace

src/config.ts
  - trajectory cache 条目/字节预算
  - failure bundle 输出预算
```

### 12.2 Hitch

建议修改：

```text
src/cli/commands/verifier.ts
  - 新增 verifier inspect CLI

src/cli/output.ts
  - 帮助文本与能力说明

src/runs/records.ts
  - 读取并验证 verifier result/artifacts

src/evals/trial-import.ts
  - 必要时复制 bounded verifier diagnostics

src/evals/verifier-diagnostics.ts
  - 统一 CTRF/stdout/stderr excerpt 与 digest

src/domain/*
  - VerifierEvidence V1 输出类型和验证
```

Hitch 不需要修改：

```text
src/trajectories/projector.ts
src/trajectories/store.ts 的 canonical 写入格式
trajectory.ref.json schema
现有 trajectory inspect 输出
```

## 13. 测试方案

### 13.1 Gear unit tests

- 100,000+ events 中 chunks 不进入 projection；
- surface append；
- 多次 replacement/compaction；
- request/header 对应正确 surface snapshot；
- assistant/tool call/result 配对；
- tool error；
- open/unpaired call；
- unknown required 与 ignorable events；
- 大 tool result 形成 excerpt；
- 同一 run 只调用一次 Hitch trajectory inspect；
- 并发 query 共享同一个加载 Promise；
- cache eviction；
- abort 后可重试；
- bundle/steps/context/events view；
- `view=events` 不标记 diagnosed；
- bundle receipt 绑定 trajectory digest；
- round summary 直接返回缺失任务名、run ID 和诊断进度；
- `candidate_check` 在 compiler 成功时仍能报告 readiness blocker；
- finalization 少一个、十个和超过十个 run 时生成正确 action batches；
- recoverable finalization 拒绝不调用 `concludeTurn`；
- recoverable finalization 拒绝不设置 `finalizationSubmitted`；
- 完成 `nextAction` 后 progress 递减并最终变为 ready；
- hard error 不被错误包装成 recoverable；
- taskName 等不可信文本不能改变 action 的 tool/arguments；
- secret 和 held-out redaction。

### 13.2 Hitch unit/integration tests

- verifier result 正常读取；
- reward 0 仍返回 valid observation；
- verifier result missing/corrupt；
- CTRF failure extraction；
- stdout/stderr head+tail truncation；
- path traversal 和 symlink 拒绝；
- run/eval/trial identity mismatch；
- diagnostics artifact 缺失返回 `result_only`；
- 旧 run bundle 兼容；
- JSON stdout 与 stderr 分离；
- cancellation。

### 13.3 Cross-repository contract test

固定一个 Hitch fixture：

```text
reward = 0
100,000+ events
95,000+ assistant/chunk
20+ assistant/message
20+ tool pairs
1+ compaction replacement
1+ tool error
verifier/result.json
bounded verifier stdout 或 CTRF
```

验证 Gear 最终得到：

```text
0 assistant/chunk in bundle
完整 task/reward/verifier status
正确 effective surface
正确 tool pairing
可定位 final answer
bundle 在字节预算内
有效 diagnosis receipt
缺失 receipt 时返回带任务名的 nextAction
执行 nextAction 后可用原参数成功重试 finalize
```

## 14. 实施顺序

### Step 1：Gear projection

先实现纯 `projectTrajectory()` 和 fixtures，不改能力接口。

完成标志：给定完整 DSH trajectory，可以得到稳定的 context epochs 和 semantic steps。

### Step 2：Gear cache

拆分 Hitch 完整读取与 Meta 分页，增加 single-flight LRU。

完成标志：同一 run 多次 bundle/context/events 查询只执行一次旧 `trajectory inspect`。

### Step 3：Gear bundle API

修改 `trajectory.query`，默认返回 bundle，raw events 改为显式 view。

完成标志：103,479-event run 一次查询即可看到几十条语义记录，不出现 chunks。

### Step 4：Meta 可恢复失败协议

在 Gear 中加入共用 `finalizationReadiness` 和结构化恢复响应。权威 gate 只接受带 digest、投影版本、脱敏策略和 verifier 状态的 `diagnosisReceipts`；旧的 `diagnosedRunRefs` 仅保留为观察字段，不能作为已读证明。

完成标志：finalization 被 evidence gate 拒绝时，Meta 回合继续，返回任务名、进度、可直接执行的 `trajectory_query` 参数和明确的重试动作。

### Step 5：Hitch verifier API

实现 `hitch verifier inspect`，先返回 observation + structured result；随后补充 bounded CTRF/log diagnostics。

完成标志：Gear 不读取 Hitch 内部路径即可取得 reward 和 verifier evidence。

### Step 6：Diagnosis receipt

升级 Meta evidence audit 和 finalization gate。

完成标志：读取 raw 首页不再满足诊断要求；完整 bundle 才能提交 candidate。

### Step 7：可选优化

只有实测 Gear 首次传输/解析仍然成为瓶颈时，才实现 Hitch server-side trajectory query/index。

触发条件可以包括：

- 单条 canonical trajectory 经常超过 `maxTrajectoryOutputBytes`；
- 单次完整读取超过可接受延迟；
- 进程内 LRU 内存压力过高；
- Gear 与 Hitch 迁移到远程边界。

## 15. 验收标准

### 15.1 正确性

1. Gear 的有效消息与 DSH `foldSurface()` 结果一致；
2. compaction shadow 的消息不进入后续 context epoch；
3. raw chunks 不进入 bundle；
4. tool call/result 配对保持 callId 和 seq；
5. reward 与 verifier result 来自 Hitch/Gear 权威记录，不从文本推断；
6. verifier diagnostics 缺失时明确显示 `result_only`；
7. workspace 未保留时不生成权威 diff；
8. finalization receipt 绑定 trajectory 和 bundle digest；
9. readiness 与 authoritative gate 使用同一个缺失项计算；
10. 每个 missing run 同时返回 taskName、runId、reward 和 typed nextAction；
11. recoverable 拒绝不会结束 Meta 回合或消费 candidate；
12. 补齐最后一个 bundle 后明确返回 `readyToFinalize: true`；
13. Meta 可用相同参数重试并成功完成 finalization。
14. context epoch 保留 DSH `adapterDefaults`，且边界位于每步第一次模型输出之前；
15. 即使 config、surface seq 和观察路径极大，单 run bundle 仍能保留至少一个关键步骤并落入最小输出预算。

### 15.2 性能

1. 一个 run 在 Gear 进程内最多完整读取一次；
2. 100,000-event fixture 的 bundle 输出不超过配置预算；
3. bundle/context/steps/events drill-down 使用缓存；
4. 27 个失败 run 不再产生数万次 Hitch 调用；
5. 缺失 run 超过单次查询上限时，服务端生成完整、无遗漏的 action batches；
6. Hitch verifier 输出有固定字节上限。

### 15.3 安全

1. Meta 只能查询 Gear 当前 round 允许的 seed refs；
2. Hitch verifier API 不接受任意文件 path；
3. Hitch 输出不泄漏绝对路径或 credential；
4. Gear 对 secret/held-out ref 二次脱敏；
5. taskName、trajectory 和 verifier 文本不能注入或改写 recovery action；
6. corrupt trajectory、verifier ref 或跨 run identity fail closed。

## 16. 最终结论

本方案把首轮改造重点放回 Gear：canonical DSH trajectory 已经存在，也已经可以通过 Hitch CLI 读取；Gear 应直接使用它重建 Meta Agent 所需的有效上下文和语义步骤。

Hitch 的必需修改缩小为 verifier evidence：公开已经保存的 `verifier/result.json`，并为 CTRF/stdout/stderr 提供稳定、bounded、经过校验的 run-centered 读取。只有当完整 trajectory 的首次传输成为实际瓶颈时，才继续增加 Hitch server-side trajectory 索引。

最终调用路径为：

```text
hitch trajectory inspect <runId> --json
  → Gear 缓存并重建 DSH surface/steps

hitch verifier inspect <runId> --json
  → Gear 合并 verifier result/diagnostics

Gear trajectory_query(view=bundle)
  → Meta Agent 获得可分析的 failure bundle

Gear candidate_check()
  → 同时返回 compiler result 与 finalization readiness

Gear finalize_candidate(...)
  → ready 时 accepted=true 并结束回合
  → 未 ready 时 accepted=false + nextAction，回合继续
  → Meta 执行 action 后用原参数重试
```

# DSH Self-Evolving Harness Plugin Spec

- 状态：Draft v0.4.0
- 目标运行时：DeepSeek Harness（DSH）
- 评测后端：Hitch 0.1.x + Harbor
- 更新：2026-08-20 — 确立 V1 最终架构：固定 MetaHarness 管理原生 DSH TargetHarness 代码演进；取消 declarative policy interpreter；所有 target/rollout session 均在隔离 TargetWorker/Harbor 中运行；补全 meta session、round admission、NotebookRuntime、verifier sidecar、归因与持久化合同。

## 1. 目标与定位

实现一套运行于 DSH 生态内、但不把不可信 TargetHarness 加载进控制面进程的自动演进系统：

1. 每个 DSH session 可拥有独立、持久的 IPython kernel；
2. `/refine` 和 `refine.run()` 可异步发起 refinement round；
3. 固定 meta agent 根据 baseline 轨迹与 verifier 证据直接编写原生 DSH plugin source；
4. RefineService 构建 immutable candidate，并用 Hitch + Harbor 对 baseline/candidate 做对等评测；
5. 满足固定 promotion gate 的 candidate 自动成为 champion，不经过人工代码审批。

V1 是 **meta-managed harness evolution**：MetaHarness 是固定优化器，TargetHarness 是演进对象。这里的 “Self-Evolving” 指系统在固定控制面管理下自动改进 target harness，不表示 meta agent 正在修改自己当前使用的 harness。演进 MetaHarness、模型、Seed Task、DSH Agent Loop、权限或 sandbox profile 均不属于 V1。

## 2. 核心不变量

- **控制面永不激活 TargetHarness**：RefineService、MetaHarness、task verifier 和 promotion gate 所在进程不得 import、mount 或执行 champion/candidate plugin。
- **代码是动作空间**：meta 直接生成 DSH 原生 TypeScript/JavaScript plugin、prompt、skill 和 composition 文件；系统不引入另一套 policy 语言或解释器。
- **类型只约束事务，不解释行为**：`HarnessMutation` 是带 CAS、路径、证据和源码内容的提交 envelope；它不声明 pre/routing/post 的业务语义，也不替候选代码执行这些语义。
- **所有 candidate 都按可执行代码处理**：不区分“安全 declarative candidate”和“危险 executable candidate”；首次构建后只能在固定隔离环境内加载。
- **外部评测决定 promotion**：candidate 内部的 action verifier 可帮助 target 自纠，但不能参与可信评分或放宽 promotion gate。
- **内容寻址与运行时钉住**：每个 TargetWorker、rollout、Hitch resolution 和 round record 都绑定不可变 `TargetHarnessRef`；pointer 更新不热替换已有 session。
- **模型可见即已记录**：IPython tool call、target 轨迹、meta proposal 与实际模型 request header 都可由 durable event/ref 重建；kernel namespace 只是便利状态。
- **基础设施失败不是零分**：构建、Harbor setup、DSH 启动、模型 transport 或 verifier spawn/I/O 失败使 round 进入 `failed`，不得伪装成 candidate 得分为 0；正常到达配置预算的 rollout/verifier timeout 是可比较的 task failure，仍保留 workspace 并评分。

## 3. 进程与信任架构

```mermaid
flowchart LR
    UI["UI / command plane"] --> CP["Control Plane\nRefineService + fixed MetaHarness"]
    CP --> HM["Harness repo + immutable artifacts"]
    CP --> HC["Hitch control client"]
    HC --> HB["Harbor baseline/candidate trials"]
    HB --> VS["Fixed task verifier\non disposable workspace copy"]
    CP --> WM["TargetWorkerManager"]
    WM --> TW["Isolated TargetWorker\none immutable TargetHarnessRef"]
    TW -->|"session.event / status"| WM
    TW -->|"capability RPC: refine.run/status"| CP
    CP -->|"accepted pointer"| HM
```

### 3.1 Control Plane

Control Plane 只装配固定 DSH composition：RefineService、`refine-meta` preset、MetaHarness 的 IPython/typed API、TargetWorkerManager、HitchClient、HarnessBuilder、task verifier runner 和 promotion gate。它不扫描 TargetHarness 的 skill 目录，不把 target prompt 注入 system prompt，也不提供可 import target artifact 的 Cordis loader 路径。

### 3.2 TargetWorker

普通交互 target session 不再运行于 Control Plane。TargetWorkerManager 为某个 immutable `TargetHarnessRef` 启动隔离子进程或容器；该 worker 在启动时把 target artifact 作为自己的 DSH composition 加载，并在退出前始终钉住同一 ref。

V1 复用现有 DSH SDK runtime，而不是另造 agent loop：`dsh-jsonrpc-agent` 已支持一个长驻进程承载多个 session，并通过 `session.event` 转发完整 `SessionEvent`、通过 `session.status` 转发 agent 生命周期。TargetWorker 所需的增量协议是：

| 增量 | 目的 |
| --- | --- |
| `session/open { sessionId, mode: create | resume }` | 显式调用 `ctx.agents.create()` 或 `ctx.agents.resume()`，并在 unpublished setup 中挂载 worker boot 时固定的 content-addressed target preset；避免现有 lazy-create 无法表达 crash recovery |
| `session/cancel` / `session/close` | 支持交互取消、关闭单 session；进程级 `shutdown` 保留 |
| server→client `control/refine.run` / `control/refine.status` | target 侧 Host Bridge 只有这两个 capability；Control Plane 校验 worker/session/ref 后代理到 RefineService |

现有 SDK runtime 的长驻进程、完整事件流和 TypeScript client 直接复用；TargetWorkerManager 使用 low-level `HarnessClient` 的 prompt receipt + notification subscription，不用把一次 idle interval 当完整交互 session 的 high-level `run()`。Harbor 使用 fixed `dsh-eval-runner` 通过同一 SDK client启动相同 worker composition并实时投影 notifications，不再另扩展 headless。现有 `subagent-dsh-sdk` 的“一次 subagent 新起一个进程”生命周期不复用。协议扩展需同步 TypeScript/Python SDK projection。

worker 记录 `{workerId, sessionId, targetHarnessRef, sandboxProfileRef}`。promotion 后，新 session 读取新 champion；已有 session 继续使用旧 worker。旧 worker crash 时，TargetWorkerManager 必须按记录重新启动旧 ref并 `resume` 原 session，不能偷偷升级到新 champion。

### 3.3 全自动安全前提

全自动 promotion 的安全边界是容器/进程外部策略，不是源码审查：

- TargetWorker 与 Harbor trial 使用同一 immutable runtime image、TargetHarness artifact、filesystem policy、CPU/memory/time limits 和 network policy；交互 worker 可长驻，trial 是一次性，但权限不得更宽。
- worker 不继承 host environment、Hitch credential、Git credential或 Control Plane filesystem。模型访问经固定 allowlisted proxy；worker 只拿短期、限额、不可用于其他服务的 capability token。
- TargetWorker 的 project mount 必须 mask `.dsh-refine`、Harness repo、Seed/held-out repo、Hitch root 与 host state；即使这些目录物理上位于 project tree 下也不可见。交互 target 只看到用户 task workspace projection。
- 默认禁止外网；若 Seed Task 明确需要网络，只能使用固定 allowlist/profile，candidate 不能修改。
- target artifact 无法改变 sandbox、credential broker、模型/provider、task verifier、Hitch、RefineService 或 promotion 配置。
- 如果部署还不能提供上述隔离和 scoped model credential，V1 必须 fail closed，不能退化为在 host DSH 进程中自动加载 candidate。

## 4. Harness 身份与代码动作空间

### 4.1 Artifact 布局

```text
harness/
  manifest.json
  preset/
    agent.cordis.yml
  plugins/
    context.ts
    pre-action.ts
    routing.ts
    post-action.ts
    action-verifiers.ts
  prompts/
  skills/
  workflows/
```

文件可按 candidate 需要增删；上图只是推荐布局。`agent.cordis.yml` 使用 DSH Loader/Cordis 原生 composition，plugin 使用 DSH 已有 extension points，例如 `ctx.systemPrompt.section()`、`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、tool/skill/subagent registries 和 workflow services。

```ts
interface HarnessManifest {
  schemaVersion: 1
  parentRef?: HarnessRef
  dshRevision: string
  toolchainRef: string
  sandboxProfileRef: SandboxProfileRef
  artifacts: Array<{ path: string; digest: string; bytes: number }>
  digest: string
}
```

manifest 中不保存可变 path 作为身份；`digest` 覆盖规范化 manifest 与所有 artifact bytes。Git commit 是人和 Hitch 使用的 revision id，manifest digest 是运行时/preset 使用的内容 id，两者都写入 resolution/round record。

这意味着 meta 可以在 `pre-action.ts` 加 validation/planning，在 `routing.ts` 改 tool/skill/subagent routing，在 `post-action.ts` 加 normalization、reflection 或经验提取，也可以在 `action-verifiers.ts` 自行选择 action 后、target round 结束时或其他现有 hook 上触发检查。系统不提供固定 pre/routing/post interpreter；candidate plugin 本身就是行为实现。

### 4.2 固定 substrate 与可演进代码

| 固定且不可修改 | TargetHarness 可演进 |
| --- | --- |
| MetaHarness、RefineService、HarnessBuilder/Loader | supplemental prompt 与 context assembly plugin |
| DSH revision 与构建 toolchain | pre-action / routing / post-action plugin |
| TargetWorker/Harbor sandbox profile 与 credential policy | action-level verifier 与自纠逻辑 |
| Hitch adapter、task verifier runner、promotion gate | DSH 原生 skills、workflows、tool wrappers |
| 模型/provider 与实际 LLM config parity 检查 | compaction/retrieval policy（限固定 API/依赖） |
| Seed Task / held-out ref 与评分公式 | 允许路径内的 composition 文件 |

需要新增 DSH service、依赖、系统权限、网络能力、provider 或 sandbox mount 的 proposal 不能由 candidate 自行实现，记为 `rejected-for-substrate`。这不是限制 meta 编写普通 plugin code，而是禁止 candidate 扩张固定信任基础。

### 4.3 Mutation envelope

```ts
interface HarnessMutation {
  parentRef: HarnessRef
  parentDigest: string
  target: SemanticTarget
  ops: ArtifactOp[]
  rationale: string
  evidenceRefs: EvidenceRef[]
  expectedOutcome: string
}

type SemanticTarget =
  | 'context'
  | 'pre_action'
  | 'routing'
  | 'post_action'
  | 'action_verifier'
  | 'skill'
  | 'tool'
  | 'workflow'
  | 'compaction'

type ArtifactOp =
  | { type: 'create'; path: string; content: string; expect: 'absent' }
  | { type: 'patch'; path: string; patch: string; expectedDigest: string }
  | { type: 'delete'; path: string; expectedDigest: string }
```

`ArtifactOp.content` 可以是完整原生代码。固定 validator 只执行结构检查：parent CAS、相对路径与 symlink containment、允许目录、单一 semantic target、操作大小/数量上限、held-out evidence 禁止、依赖/lockfile 禁止和 manifest 完整性。它不尝试理解代码是否“真的属于 post_action”，也不把源码翻译为 policy。

默认每轮只修改一个 semantic target，可包含为完成该目标所需的多个文件。绝对路径、`..`、symlink escape、package manager lifecycle script、lockfile/依赖新增、二进制、生成物直写以及 evaluator/control/sandbox 路径一律拒绝。

### 4.4 Build 与 identity

HarnessBuilder 在 disposable build sandbox 中：

1. 对 parent digest 做 CAS；
2. 应用 ops 到新 worktree；
3. 用固定 DSH revision、Node 版本、compiler 配置和依赖 allowlist typecheck/build；
4. 生成完整 preset/artifact manifest；
5. 计算覆盖 source、composition、skills、build output、toolchain ref 与 sandbox profile ref 的内容身份；
6. 创建 immutable Git commit 和 prepared artifact。

content-addressed preset id 采用 `target-<manifestDigest>`，不得覆盖同名目录。candidate artifact 在 build 完成后也不能被 Control Plane import；其首次运行必须在 Harbor/TargetWorker 内。

## 5. Session 角色、能力与 Meta 生命周期

### 5.1 能力矩阵

| Session 角色 | 运行位置 | `ipython_input` | Host Bridge / 控制能力 |
| --- | --- | --- | --- |
| `refine-meta` | Control Plane，固定 MetaHarness | 有 | `harness.current`、`harness.read`、`seed_tasks.load`、`trajectory.query`、`hitch.status`、`submit_refinement_proposal` |
| target interactive | isolated TargetWorker | 有 | 仅 `refine.run`、`refine.status` |
| rollout | Harbor trial | 可选，默认启用但不持久化 snapshot | 无 refine/trajectory/Hitch/champion API |
| task verifier | Control Plane 管理的 disposable verifier sandbox | 无 agent/session | 无；仅 argv + workspace copy + fixed env |

Meta session 不挂载 champion preset，其 SkillProvider locator、`skill-filesystem.customSkillDirs`、system-prompt sections、tools、hooks 与 workflows 均不得指向 harness repo。TargetHarness 内容进入 meta 的唯一通道是 typed API 返回的带 ref/digest/来源标记的数据；它可能影响 meta 的判断，但不能成为 meta 的活跃 composition 或 authority。`harness.current()` 返回 ref、manifest 与 path/digest index；`harness.read({ref,path,offset,limit})` 只读允许 tree、校验 ref/path/digest并有 page/byte bounds。MetaHarness 的固定 skill catalog 可以包含 pinned DSH API/插件开发文档，但不得包含 TargetHarness 目录。任何 meta-visible refinement-history projection 必须删除 `heldOut*` fields 和 partition refs；Control Plane 的完整 record 不直接暴露给 meta。

target 的 `refine.status` 也只返回 public projection：round id、粗粒度 status、terminal decision 与 seed-side summary；不返回 held-out ref/delta、workspace/verifier refs、Meta session id 或 Control Plane path。特权 UI 若要审计完整 record，使用独立 human-authorized control endpoint，不能复用 target capability。

### 5.2 Meta session 由谁创建、如何唤醒

workspace-scoped RefineService 是 meta session 的唯一 owner。状态写入 `.dsh-refine/meta.json`：

```ts
interface MetaSessionState {
  sessionId: SessionId
  metaHarnessRef: MetaHarnessRef
}
```

RefineService 第一次需要 meta 时执行：

1. 读取 `meta.json`；若 `metaHarnessRef` 与当前固定 manifest 不同，创建新 session 并原子替换记录；
2. 若 id 对应 live agent，复用其 `AgentHandle`；
3. 否则优先 `ctx.agents.resume({ resumeSessionId, setup: mountRefineMeta })`；持久化中不存在时才 `ctx.agents.create({ sessionId, setup: mountRefineMeta })`；
4. RefineService 持有 handle 直到 workspace service dispose。

每个 round 在 baseline evidence 就绪后，用 `agent.followup(roundEnvelopeMessage)` 唤醒同一个 meta session。消息只包含 round/ref/证据索引，不内联整份 target tree；meta 通过 typed API 分页读取。MetaHarness 变更必须 rotate session，禁止在已有 meta history 上换 composition。

`submit_refinement_proposal({roundId, mutation: HarnessMutation | null})` 是一次性提交协议：只接受当前 waiting-proposal round、正确 meta session 与未使用 round id；成功 append durable proposal event 后由 tool execution 调用 `concludeTurn()` 结束该 meta turn。stale/duplicate submission 拒绝。每轮记录 `metaSessionId`、proposal-producing request 所适用的最近一个 `request/header.seq` 和 proposal event seq；若该 round 内出现多个不同的有效 header，则 fail closed，从而形成输入配置到 proposal 的归因链，而不假设 DSH 每轮都会重复写一条未变化的 header。

## 6. Session-aware NotebookRuntime

持久 IPython 使用独立 capability seam `NotebookRuntime`，不伪装成现有 one-shot `CodeRuntime` provider。现有 `CodeRunRequest` 刻意不包含 session/owner，provider 无法仅凭 `run()` 正确选择 kernel；在 provider 内暗建 session map 会把 consumer 责任泄漏到 service definition 之外。

```ts
interface NotebookExecuteRequest {
  sessionId: SessionId
  cwd: string
  code: string
  role: 'meta' | 'target' | 'rollout'
  signal: AbortSignal
}

abstract class NotebookRuntime extends Service {
  abstract execute(request: NotebookExecuteRequest): Promise<NotebookResult>
  abstract interrupt(sessionId: SessionId): Promise<void>
  abstract restart(sessionId: SessionId): Promise<void>
  abstract disposeSession(sessionId: SessionId): Promise<void>
}
```

Provider 为每个 `SessionId` 懒创建一个 kernel、串行执行 cell，并在 session/agent disposal 时回收。Prime Agent 的对应做法也是由 `AgentSession` 持有 `IpythonKernelProvisioner`，工具 closure 捕获 provisioner；`KernelManager.sessionId` 用于 ownership/cleanup，而不是让一个无 session 参数的全局 runtime 猜调用者。

Host Bridge handlers 在 session setup 时按角色注册；每个 request 带 generation、request id、abort signal 和 current-generation check。kernel 不保存 host credential。snapshot 是 owner-private、绑定 session id + Target/MetaHarnessRef 的可选 dill 文件；rollout 默认禁用。恢复失败或无 snapshot 时启动空 namespace，并向模型记录 notice；系统不自动重放历史 cell 来重新执行副作用，日志重放只重建模型当时看见的证据。

busy kernel 在无 UI 的 meta/rollout 中按固定超时自动 interrupt，仍 busy 则 kill/restart 并记录 reset；interactive target 可由 UI 选择继续等待或 restart。完整移植设计见 [IPython Kernel 移植决策](ipython-kernel-port.md)。

## 7. `/refine` admission 与 round 状态机

```text
/refine <seed-task-ref> [--rounds N] [--budget B] [--target TARGET]
/refine status [ROUND_ID]
/refine rollback <VERIFIED_HARNESS_REF>
```

`/refine` 是 command-plane 调用，不发送给 target 模型。它由 fixed TargetWorker/UI command adapter 截获并经同一个 capability RPC 转给 RefineService；handler 不属于 candidate preset。target kernel 的 `refine.run()` 走相同 RPC。两条入口都只做 admission：验证参数、获取 workspace 跨进程锁、创建 round record，然后立即返回 `{roundId, status: "queued"}`。UI request/target turn 随后取消或断开不会取消已接受 round；后台 RefineService 是唯一 owner。

同一 workspace 同时至多一个 active round。锁必须跨进程，round/champion/meta 文件使用 temp + fsync + atomic rename，并以 parent ref/digest CAS 更新 champion。重复请求返回 active round id，不创建第二轮。

### 7.1 单轮流程

1. **admit**：钉住 parent champion、Seed Task ref、held-out ref、MetaHarnessRef、target/meta model policy、sandbox profile、预算和阈值。
2. **baseline**：若 cache key 完全一致则复用；否则用 parent artifact 在 Harbor 跑 seed tasks。
3. **external verify**：对每个正常结束或达到配置 rollout timeout 的最终 workspace 创建 disposable copy，在固定 verifier sandbox 运行 task verifier，写 immutable sidecar；Harbor/setup/export 等基础设施失败不进入评分。
4. **wake meta**：同一 persistent meta session 读取 target manifest、seed trajectory、verifier sidecar 与 redacted history；held-out ref、aggregate delta、目录和证据完全不可见。
5. **proposal**：meta 提交一个 `HarnessMutation` 或 `null`。`null` 直接记 `no-op`，不创建 candidate。
6. **validate/build**：执行结构 validator、CAS、fixed-toolchain build；需要 substrate 扩张则 `rejected-for-substrate`，普通失败则 `failed`。
7. **candidate eval**：candidate 在与 baseline 同参数的 Harbor trials 上执行 seed tasks与 fixed task verifier。
8. **seed gate**：基础设施全部成功、required tasks 无回归、总分 delta 达阈值后才继续。
9. **held-out gate**：分别以 parent/candidate 跑不可见 held-out 集，产生独立 run/verifier refs；required/回归阈值必须通过。
10. **promote**：以 parent CAS 原子更新 `champion.json`；否则记 `rejected`。任何结果都写完整 record、释放锁；下一轮只能从已接受 champion 开始。

`--rounds N` 由后台 service 串行创建最多 N 个 round；一次拒绝/no-op 不改变 parent，是否继续由固定 Config 决定，默认继续；`failed` 终止本次 multi-round job。`--budget B` 是每 task wall-clock timeout；LLM output cap 由实际 `LlmCallConfig.maxTokens` 管理，不把 wall time 冒充 token budget。

进程重启时，持锁但非 terminal 的 round 标记 `failed`，V1 不做 step-level resume；已写的 Hitch artifacts/sidecars可由后续新 round 按完整 cache key 复用。

## 8. 评测、Verifier 与 Promotion

### 8.1 三类 verifier

- **action verifier**：TargetHarness 原生 plugin code，可在 pre/post/action/target-round hook 上运行，帮助 agent 自纠；属于被演进行为，不可信。
- **task verifier**：Seed Task 固定 evaluator，rollout 后由 RefineService 在 disposable workspace copy 中运行；不加载 TargetHarness，是 reward 的权威来源。
- **promotion gate**：RefineService 固定代码，比较 infra、parity、required tasks、score delta 和 held-out delta；candidate 不能调用或修改。

task verifier 不追加到已经关闭的 Hitch run，也不修改 Hitch 保留的 authoritative workspace。RefineService 写 `.dsh-refine/verifiers/<verifier-run-id>.json` immutable sidecar，记录源 run/workspace digest、disposable verifier snapshot digest、verifier id/digest、argv、timeout、exit、stdout/stderr spill refs。`RefinementRecord.verifierRefs` 将它与 Hitch run 关联。

### 8.2 Parity

baseline/candidate 必须相同：Seed Task commit 与顺序、provider/model、实际 `LlmCallConfig`、DSH revision、runtime image、sandbox/credential/network profile、task workspace seed、timeout、CPU/memory、task verifier digest 与评分公式。允许的唯一差异是 `TargetHarnessRef` 及其 prepared artifact identity。

DSH 当前 `LlmCallConfig` 的可比字段是 `provider`、`model`、`reasoningEffort?`、`temperature?`、`maxTokens?`、`stop?`。系统从每个 trial 实际 `request/header` 读取并逐字段比较，不记录不存在的 random seed/top-p 承诺。provider 本身不保证确定性；通过多任务与阈值控制噪声。

### 8.3 Hard constraints

promotion 至少要求：

- 所有 baseline/candidate rollout 和 task verifier 基础设施成功；
- `required: true` 的 seed 与 held-out task 不回归；
- seed score delta `>= minScoreDelta`；
- held-out score delta `>= -maxHeldOutRegression`；
- actual request header parity、sandbox profile identity 与 artifact identity 校验通过；
- parent champion CAS 仍成立。

V1 分数为 `passed / total`，每 task 一次 attempt；阈值均为 RefineService Config。连续分、多次统计检验和动态 task generation 后续再做。

### 8.4 Hitch/Harbor

所有 candidate 都包含或可能包含可执行 plugin code，因此 baseline、candidate 和 held-out 全部使用 Harbor；`hitch run` 的 host workspace 不能作为安全替代。Harness Git commit 是版本 id，Hitch resolution/prepared artifact/run/eval 是执行权威，RefineService 只保存 refs。

Hitch 当前 eval 拒绝 local `git+file`，而自动演进 candidate 首先只存在本地 immutable commit。V1 前置交付是一个 opt-in 的 guarded local-source 路径：只接受 allowlisted clean repo 的 exact `git+file://...#<40-char-sha>`，锁定 resolution identity，把带 digest 的 portable Git source bundle 送进 Harbor，并在 trial architecture 内用 trusted recipe prepare；默认 eval guard 保持不变。不能完成该前置时，全自动 V1 不可用。细节见 [Hitch ↔ DSH 对接改动](hitch-dsh-integration.md)。

## 9. Seed Task Set

```ts
interface SeedTask {
  id: string
  prompt: string
  cwd?: string
  required?: boolean
  verifier: {
    id: string
    argv: string[]
    timeoutMs: number
  }
  tags?: string[]
}
```

Seed Task Set 是独立 Git repo，ref 必须是 exact commit。V1 task workspace 素材必须自包含于该 repo；另一个可变 source repo 不在 V1 范围。`cwd` 是相对 task 目录的受 containment 校验路径。`argv` 不经过 shell，verifier 文件及其 digest 来自 exact Seed Task commit。rollout materializer 只把 task prompt/workspace 交给 TargetHarness；verifier executable、argv 与 promotion thresholds 不挂进 target container，在之后的 verifier sandbox 中单独注入。

`tasks/` 是 meta 可见优化集，`held-out/` 只对 RefineService 可见。`seed_tasks.load`、`trajectory.query` 和 proposal evidence validator 从根上过滤 held-out task/ref/path，不能依赖 prompt 提醒。held-out ref 轮换后 baseline cache key 变化。

## 10. 持久化与记录

```text
.dsh-refine/
  champion.json
  meta.json
  locks/round.lock
  rounds/<round-id>.json
  verifiers/<verifier-run-id>.json
  workers/<session-id>.json
  meta-harness/<meta-harness-ref>.json
```

```ts
type RoundStatus =
  | 'queued'
  | 'baseline'
  | 'waiting-proposal'
  | 'building'
  | 'candidate-eval'
  | 'verifying-seed'
  | 'held-out-eval'
  | 'verifying-held-out'
  | 'terminal'

interface RefinementRecord {
  id: RoundId
  status: RoundStatus
  parentRef: HarnessRef
  candidateRef?: HarnessRef
  mutationRef?: MutationRef
  metaHarnessRef: MetaHarnessRef
  metaSessionId?: SessionId
  metaRequestHeaderSeq?: number
  proposalEventSeq?: number
  metaModel?: LlmCallConfig
  sandboxProfileRef: SandboxProfileRef
  baselineEvalRef?: HitchEvalRef
  candidateEvalRef?: HitchEvalRef
  baselineRunRefs: HitchRunRef[]
  candidateRunRefs: HitchRunRef[]
  verifierRefs: VerifierRunRef[]
  heldOutBaselineEvalRef?: HitchEvalRef
  heldOutCandidateEvalRef?: HitchEvalRef
  heldOutBaselineRunRefs?: HitchRunRef[]
  heldOutCandidateRunRefs?: HitchRunRef[]
  heldOutVerifierRefs?: VerifierRunRef[]
  decision?: 'accepted' | 'rejected' | 'rejected-for-substrate' | 'no-op' | 'failed'
  scoreDelta?: number
  heldOutScoreDelta?: number
  createdAt: string
  updatedAt: string
}
```

`status !== 'terminal'` 时 `decision` 必须缺省；进入 `terminal` 的同一次 atomic write 必须写入 decision。`accepted` 还必须具备 candidate、两侧 seed/held-out refs、对应 verifier refs 与 score delta；package invariant 直接检查这些关系。baseline 之前失败的 round 可以没有 `metaSessionId`，因为 Meta session 按需创建。

`MetaHarnessRef` 指向 immutable manifest，覆盖 DSH revision、refine plugin/build、`refine-meta` preset、meta prompt/fixed skills、typed API schema 与 sandbox profile。V1 为常量；未来若演进 meta，它可直接成为独立 lineage pointer，无需改变 record 结构。

## 11. DSH 实现要求与验收

实现为 DSH packages 时遵守仓库规范：capability seam 包含 Definition/Provider/Consumer；跨进程/持久化输入运行时校验；`RoundId`/`HarnessRef` 等用 `Branded<B>`；新增 `refine/*` events 更新 persistence catalog；每个 package 有 invariant、README/JSDoc、HMR disposal、REAL composition、keyless snapshot；SDK wire 改动同步 TypeScript/Python projection；非平凡改动写 Agent Note。

V1 必须证明：

- MetaHarness/Control Plane 的 module graph、skill locator 与 prompt sources 中没有 TargetHarness 路径；向 target artifact 放置同名控制 plugin 不能在 host 激活。
- target/rollout 看不到 meta APIs；target 只有 `refine.run/status` public projection 且 project mount 看不到 `.dsh-refine`/Harness/Seed/Hitch state；rollout 无控制 capability；调用绕过路径在 executor/RPC handler 被拒绝。
- Meta session 可 create、进程重启后 resume、MetaHarnessRef 变化时 rotate；每个 proposal 可追到 proposal-producing request 的有效 request header 与唯一 proposal event。
- `/refine` 和 `refine.run()` 在持久化 admission 后立即返回；调用方取消不取消 round；跨进程并发只产生一个 active round。
- Notebook namespace 按 SessionId 隔离并跨 tool call/compaction 保持；dispose、interrupt、restart 和 worker crash 不遗留 kernel；snapshot 缺失不会伪称已重放副作用。
- meta 可提交原生 pre/routing/post/action-verifier plugin code；系统没有 policy interpreter；构建只使用固定依赖/toolchain。
- candidate source 在 host import 会被架构测试阻断；所有 candidate/baseline/held-out trials 均在 Harbor 或等价固定隔离 profile 中运行。
- baseline/candidate `request/header`、resource/profile、Seed Task 与 verifier digest 除 harness ref 外逐字段相同；infra failure 产生 `failed` 而非零分。
- task verifier 在 disposable copy 上运行、不修改 Hitch run/workspace；sidecar immutable 且每个 score 可反查 run、workspace digest、verifier digest 和输出。
- held-out 数据及 aggregate delta 不能经 meta typed API、target `refine.status`、history projection、filesystem 或 evidence ref 泄露；未通过 held-out gate 不更新 champion。
- promotion/rollback 只原子移动 pointer 到已验证 immutable ref；已有 target session 始终钉住原 ref并可按该 ref resume。

## 12. 非目标

- 演进 MetaHarness、模型、provider、Seed Task、task verifier、promotion gate、sandbox 或 DSH Agent Loop；
- 在运行中的 target session 热替换 harness；
- 为 candidate code 提供人工 review gate（V1 选择全自动，以隔离和外部 evaluator 兜底）；
- 把 IPython、Hitch workspace 或 TypeScript typecheck 当作安全 sandbox；
- 自动新增 npm/Python 依赖、系统服务、credential、网络权限或 container mount；
- 完整 GEAR Supervisor、训练/checkpoint evolution、连续分或多次统计评测。

## 13. 参考

- [IPython Kernel 移植决策](ipython-kernel-port.md)
- [Hitch ↔ DSH 对接改动](hitch-dsh-integration.md)
- [DSH SDK JSON-RPC server](../deepseek-harness/packages/sdk/server/README.md)
- [DSH SDK client](../deepseek-harness/packages/sdk/client/README.md)
- [DSH agent factory/resume](../deepseek-harness/packages/core/agent-loop/README.md)
- [DSH agent presets](../deepseek-harness/packages/preset/agent-presets/README.md)
- [DSH command subsystem](../deepseek-harness/docs/subsystems/commands.md)

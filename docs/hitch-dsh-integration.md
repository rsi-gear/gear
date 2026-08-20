# Hitch ↔ DSH 对接改动

- 状态：Draft v0.4
- 目的：落实 [DSH Self-Evolving Harness Plugin Spec](dsh-self-evolving-harness-spec.md) 的隔离评测链路
- 代码基线：agent-hitch `src/` 与 DSH SDK runtime（核查于 2026-08-20）
- 更新：2026-08-20 — baseline/candidate/held-out 全部 Harbor；Hitch runner 复用与 interactive TargetWorker 相同的 DSH SDK runtime/composition，不再扩展 headless；本地 immutable candidate 通过 guarded source bundle 进入 trial；补完整 workspace snapshot 与 verifier sidecar 合同。

## 1. 结论与交付物

Hitch 不能原样执行本设计，V1 需交付五组改动：

1. agent-hitch 新增硬编码 `dsh-evolving` adapter；
2. DSH SDK server 增加 TargetWorker 所需的 preset/open/resume/cancel/control-RPC 合同；
3. 新增 protocol-pure `dsh-eval-runner`：通过现有 TypeScript SDK client 驱动同一 TargetWorker composition，并把 SDK notifications 投影到 stdout NDJSON；
4. Hitch eval 在默认拒绝本地源的前提下，新增受 allowlist 控制的 immutable local source bundle；
5. Harbor/Hitch 导出 final workspace snapshot，RefineService 在独立 verifier sandbox 运行固定 Seed Task verifier并写 sidecar。

前三项是 DSH adapter 能执行 task 的前置，第四项是本地自动演进能进入 Harbor 的前置，第五项是 promotion 有可信 reward 的前置。因为 meta 可生成任意原生 plugin code，旧方案“文本/declarative candidate 先用 host `hitch run`，以后 executable candidate 再 Harbor”已经失效。Hitch `worktree | copy` 只隔离工作目录，不是进程安全边界。

现有代码可直接复用：exact commit resolution、prepared artifact cache、`--resolved-revision-file`、run supervision、Harbor backend、`memory_mb`、`HITCH_EVAL_BOOTSTRAP_DIR`、trial/reward records，以及 DSH SDK runtime 的长驻进程、`session.event` 完整 durable event stream、`session.status` 与 TypeScript client notification subscriptions。

## 2. 为什么评测也使用 SDK TargetWorker

当前 DSH headless 是另一套 one-shot driver：task 来自 positional config，创建 bare Agent，最后只写 assistant text。为 Hitch 给它增加 stdin、preset mount、event stream 和 cancel，会复制 SDK runtime 已有的绝大部分 transport/lifecycle能力，而且 interactive TargetWorker 与 rollout 会走不同的 agent 创建路径。

V1 改用一份固定 `dsh-eval-runner`：

```text
Hitch stdin prompt
  -> dsh-eval-runner (trusted SDK client, stdout NDJSON)
  -> dsh-jsonrpc-agent child (same TargetWorker cordis.yml + target preset)
  -> target Agent/session
```

runner 只做一次 task orchestration，TargetHarness 仍只在 child worker process 内加载。interactive manager 与 eval runner 使用同一个 worker artifact/config builder、相同 SDK server preset setup 和 sandbox profile；差别只有 owner：interactive manager 保持 worker 长驻，eval runner 在一个 session idle 后关闭 worker。candidate 因此不能通过检测 headless 与 SDK 两种完全不同的 substrate 来选择行为。

## 3. DSH TargetWorker runtime 与 eval runner

### 3.1 SDK server 增量

现有 `HarnessSdkJsonRpcServer` 已转发 context 内所有 `session/event` 和 agent `running/idle`，但 `createSession()` 不挂 preset、未知 session lazy-create、没有 cancel/close，也不会发 server→client request。V1 增加：

- worker boot config 固定 `targetPresetId = target-<manifestDigest>`；`session/open(mode=create|resume)` 在 `ctx.agents.create/resume` 的 unpublished `setup(agentCtx)` 中执行 `ctx.agentPresets.mount(agentCtx, targetPresetId)`；wire caller 不能选择另一个 preset；
- `session/prompt` 只接受已 open session，不再把 typo id 隐式变成新 agent；
- `session/cancel` 与 `session/close` 拥有单 session lifecycle，进程级 `shutdown` 保留；
- fixed target Host Bridge 通过 server→client `control/refine.run/status` 请求 Control Plane；eval runner 不注册这些 request handlers，所以 rollout 调用明确被拒绝；
- worker initialize/ready result回报 `targetHarnessRef`、preset digest、DSH revision 和 sandbox profile ref，manager/runner 在首个 prompt 前逐字段核对。

协议扩展同步 `@deepseek-ai/dsh-sdk-protocol`、TypeScript client、Python SDK expected outputs 和 SDK server docs/tests。interactive manager 使用 low-level client subscription；eval runner 可在显式 `session/open` 后复用 high-level receipt-to-idle collection，但必须实时透传 notifications，不能等结束后批量伪造 streaming。

### 3.2 `dsh-eval-runner`

trusted builder 将固定 runner 与 content-addressed target preset/worker config一起物化到 prepared artifact。runner：

1. 从 stdin 读取一个有界 UTF-8 prompt，EOF 后开始；空输入失败；
2. 启动 child SDK runtime，使用固定 model profile与 scrubbed environment；
3. mint rollout SessionId，执行 `session/open(create)`；
4. stdout 先写 `dsh.session.created`，随后按到达顺序写每个 SDK notification；
5. 等目标 root agent进入 idle，关闭 SDK client并等待 child 完整退出；
6. transport loss、协议错误或 child failure 写 bounded stderr diagnostic并非零退出。

stdout 只允许一行一个 JSON object：

```json
{"type":"dsh.session.created","sessionId":"session-..."}
{"type":"dsh.sdk.notification","method":"session.event","params":{"sessionId":"session-...","event":{"type":"assistant/chunk","seq":12,"time":0,"data":{}}}}
```

runner 不写最终纯文本副本；`assistant/message` 已是唯一 completed truth。SDK child stdout 是 runner 消费的 JSON-RPC pipe，不直接继承为 Hitch stdout。stderr 只放 diagnostics。Hitch kill runner 时必须终止完整 process tree，避免 SDK child/kernel 成为 orphan。

### 3.3 能力隔离

rollout worker composition 不挂 target/UI command adapter、Control Plane connection 或任何 `refine.*` handler；只有 agent tools 与可选 session-local NotebookRuntime。它看不到 `.dsh-refine`、Harness/Seed/Hitch roots、host credential 或 interactive session persistence。模型访问使用与 interactive TargetWorker 同 profile的短期 scoped proxy token。

## 4. `dsh-evolving` Hitch adapter

### 4.1 定义

agent-hitch 的 adapter registry 是 `src/adapters.js` 内 `definitions` 对象，没有配置注册面；V1 直接新增：

```js
"dsh-evolving": {
  id: "dsh-evolving",
  display_name: "DSH Evolving Harness",
  command: "dsh-eval-runner",
  path_env: "HITCH_DSH_EVOLVING_PATH",
  version_args: ["--version"],
  revision_sources: {
    commit: {
      type: "git",
      url: "<registered fallback remote>",
      commands: [
        { executable: "dsh-harness-build", args: ["--manifest", "harness/manifest.json"] }
      ],
      entrypoint: "dist/dsh-eval-runner"
    }
  },
  capabilities: {
    non_interactive: true,
    streaming: true,
    structured_messages: true,
    structured_tool_events: true,
    sessions: true,
    resume: false,
    model_selection: false,
    graceful_cancel: false
  },
  process(request, executable) { /* 下文 */ },
  translate(event, state) { /* §4.3 */ }
}
```

`revision_sources.commit.commands` 调用 fixed toolchain 中的 trusted builder，不能执行 candidate repo 的 `package.json` script/lifecycle hook。builder 验证 manifest/允许路径/依赖、按 pinned DSH/Node/compiler 构建 worker config、target preset 与 runner entrypoint。candidate 不能修改 builder executable 或 runner source。

`streaming: true` 只有在 `assistant/chunk` 映射测试通过后成立。`model_selection: false` 表示 provider/model 来自固定 worker/eval profile；RefineService 通过实际 `request/header` 检查 parity，不允许 candidate 或 `agent_args` 改模型。

### 4.2 Process ownership

prepared entrypoint 已钉住 DSH revision、TargetHarness、worker config 和 target preset；adapter 不重复传 profile/config/preset：

```js
process(request, executable) {
  const args = validatedDshArgs(request.agent_args);
  return { executable, args, input: request.prompt };
}
```

`validatedDshArgs` 只接受固定无权限参数；RefineService 正常调用传空数组。sandbox/model/network/fs 不能由 `agent_args` 覆盖。timeout/cancel 继续由 Hitch supervisor 终止完整 runner + SDK child进程树；SDK wire尚无 graceful process-wide cancel 前保持 `graceful_cancel: false`。

### 4.3 Event mapping

| SDK notification | Hitch normalized event | 规则 |
| --- | --- | --- |
| `dsh.session.created` | `session.created` | 使用 exact root SessionId |
| `session.event: assistant/chunk`，text-delta | `message.delta` | `text = chunk.text`；reasoning delta保留 `provider.event` |
| `session.event: assistant/message` | `message.completed` | 拼接 text content blocks |
| `assistant/message.usage` | `usage.updated` | 与 completed 同次 translate返回 |
| `session.event: tool/call` | `tool.started` | `callId/name/arguments` 原样关联 |
| `session.event: tool/result` | `tool.completed` | `callId` 关联；`error` 是否存在决定 failed/succeeded；content放 output/native |
| `session.event: turn/end` error | `diagnostic` | code/message 与 raw reason |
| `subagent.started/finished` | `provider.event` + lineage native | root/tree collector据此关联 child events |
| 其他 notification/event，包括 `request/header` | `provider.event` | raw payload不丢，供 parity/审计 |

同一 assistant 输出先产生 delta，最后产生一次 completed；completed 不再伪造 delta。`request/header` 虽无 Hitch 统一词汇，必须保留，RefineService 从 raw native event读取实际 `provider/model/reasoningEffort/temperature/maxTokens/stop`。

## 5. Guarded local immutable source 进入 Harbor

### 5.1 当前守卫

`src/evals.js` 有两层拒绝：`validateEvalRequest()` 拒绝 explicit `git+file`，`runEval()` 要求 Git resolution `registered === true`。自动演进 candidate 在 promotion 前不应先推送未知代码到远端，但不能简单删除守卫或把 host `file:///...` 塞进 container。

### 5.2 V1 source-bundle 方案

Hitch 增加默认关闭的 deployment policy：

```ts
interface LocalEvalPolicy {
  allowedRoots: string[]
  requireFullCommit: true
  requireCleanRepository: true
}
```

只有 RefineService 专用 Harness repo realpath 位于 `allowedRoots`，且 ref 为 `git+file://...#<40-char-sha>` 时接受。host resolve 后：

1. 验证 repo clean、commit 存在、canonical full SHA 与请求一致；
2. 导出只含所需 commit 的 portable Git bundle；
3. 计算 bundle digest并把 `{resolutionIdentity, commit, bundleDigest}` 写入 eval plan；
4. bundle 放进本次 `runtime/bootstrap/local-sources/<identity>.bundle`；
5. Harbor agent 上传 runtime，在 trial 内导入 `/tmp/hitch-sources/<identity>.git`；
6. `hitch prepare` 用新增 internal source-bundle option 验证 bundle digest、commit/tree 与 locked resolution，再从该 cache 用 trusted recipe原生构建。

bundle 只解决 source 可达性，不改变 canonical ref或 resolution identity。普通 eval 未配置 `allowedRoots` 时仍拒绝 local source。bundle/resolution/prepared manifest/adapter recipe identity 全部进入 records；digest/commit/path/cleanliness 任一不符都在 trial 前 fail closed。

`--resolved-revision-file` 继续使用：host resolve一次，Harbor 内消费同一锁定 resolution；source bundle 是受验证 transport，不是第二次 resolve。

## 6. Harbor rollout、workspace handoff 与 verifier

### 6.1 不回写 Hitch run

Hitch run 在 runner terminal 后已经关闭。事后修改 `events.jsonl`/`result.json` 会破坏 immutable execution record并混淆 agent 事实与外部评分。RefineService 只引用 Hitch records，不追加 verifier event。

### 6.2 Workspace snapshot

每个 Harbor agent trial 完成后，在 container 仍存活且 target worker 已退出时导出 task workspace immutable snapshot：

- 排除 Hitch state、credential、socket、kernel temp 与非 task mounts；
- 规范化 tar/content manifest，限制文件数、单文件/总字节与 special files；symlink 作为 link记录，解包重新做 containment；
- Harbor backend下载 snapshot/manifest到 eval record，在 trial metadata 写 `workspaceSnapshotRef`/digest；
- 正常 rollout timeout 仍导出；snapshot/export失败属于 infrastructure failure。

RefineService 从 snapshot 创建 disposable verifier workspace，不修改原 snapshot或 Hitch workspace。

Harbor 内 `hitch_run_id` 只在 trial 临时 root 有意义，不能裸写 round record。backend 下载 run result/events 后生成 host-resolvable ref：

```ts
interface HitchRunRef {
  evalId: string
  trialId: string
  runId: string
  revisionIdentity: string
  artifactId: string
}
```

resolver 以 `evalId + trialId` 定位下载内容，再核对内部 run id/revision/artifact；container 绝对路径不进入 durable API。

### 6.3 Verifier sidecar

RefineService 从 exact Seed Task commit 读取 `{id, argv, timeoutMs}`，在固定 verifier image/env 中运行；`argv` 不经过 shell，verifier source只读注入，TargetHarness/模型 credential不加载。

```ts
interface VerifierRunRecord {
  id: VerifierRunRef
  hitchRunRef: HitchRunRef
  taskRef: SeedTaskRef
  verifierId: string
  verifierDigest: string
  sourceWorkspaceDigest: string
  verifierSnapshotDigest: string
  argv: string[]
  timeoutMs: number
  exitCode?: number
  timedOut: boolean
  stdoutRef?: SpillRef
  stderrRef?: SpillRef
  status: 'passed' | 'failed' | 'infra-error'
}
```

snapshot/spawn/image/I/O 或 supervisor 自身 deadline是 `infra-error`，使 round `failed`；verifier 正常非零退出或达到声明 `timeoutMs` 是 task `failed`（后者 `timedOut: true`）。target rollout达到配置预算也保留 workspace并评分；只有 runner/SDK/Harbor/setup/export失控才是 infrastructure failure。

sidecar 写 `.dsh-refine/verifiers/`，atomic create-only；`RefinementRecord.verifierRefs` 关联。Harbor 自带 reward可保留作诊断，promotion score只使用固定 sidecar。

## 7. 对照评测与 cache

RefineService 对 parent/candidate分别调用 Harbor eval；Hitch 当前一次 eval只含一个 harness ref。seed与 held-out分别产生 baseline/candidate eval/run refs，不能混在单一 held-out数组。

每次 eval 使用相同 dataset materialization、task order、attempts、model profile、timeout/setup timeout、`memory_mb`、CPU/network/filesystem profile、bootstrap/toolchain、worker substrate与 adapter args。`request.json` 允许差异只有 harness ref；raw `request/header` 再验证实际 LLM config。

cache key：

```text
TargetHarnessRef
+ SeedTaskRef/partition
+ DshRevision
+ ModelProfileRef
+ SandboxProfileRef
+ ResourceBudgetRef
+ VerifierDigest
+ WorkerProtocolRef
+ AdapterRecipeRef
```

parent与完整 key未变可复用 baseline eval + verifier sidecars；champion、held-out ref、model/profile、verifier、worker protocol或 adapter recipe变化都重跑。errored/cancelled Harbor trial、runner/SDK failure、workspace export失败或 sidecar infra-error使 round `failed`，不产生可比较 score。

## 8. 实施顺序与验收

1. **TargetWorker SDK protocol PR**：preset setup、explicit open/create/resume、cancel/close、control RPC与 ready identity；同步 TS/Python SDK。
2. **Eval runner PR**：stdin → SDK child → realtime NDJSON；stdout purity、process-tree teardown、chunk/message/tool/error/request-header snapshots。
3. **Hitch adapter PR**：definition、trusted build recipe、translate；`hitch list --json`可发现。host `hitch run`只用于 adapter smoke，不用于 promotion。
4. **Local source bundle PR**：allowlisted exact local commit → bundle → Harbor native prepare；默认 guard regression test保持拒绝。
5. **Workspace export PR**：final snapshot、limits/digest/special-file tests、失败传播。
6. **Verifier integration**：disposable sandbox + immutable sidecar + baseline/candidate/held-out refs。
7. **Parity/promotion integration**：request/header diff、required tasks、score/held-out gate、failure classification。

端到端验收：一个只改 `post-action.ts` 的 candidate运行 parent/candidate Harbor eval；两侧能反查 exact resolution/prepared artifact、同版本 TargetWorker identity、完整 DSH events、workspace snapshot与 verifier sidecar；除 TargetHarnessRef外 parity全等。candidate build failure、SDK child failure、Harbor error、snapshot export failure、verifier infra-error分别得到 `failed`；verifier正常不通过得到 `rejected`；只有 seed + held-out gate通过才更新 champion。

## 9. 参考

- [主 spec](dsh-self-evolving-harness-spec.md)
- [Hitch adapters](../../agent-hitch/src/adapters.js)
- [Hitch eval guards](../../agent-hitch/src/evals.js)
- [Hitch resolution/artifacts](../../agent-hitch/src/artifacts.js)
- [Hitch Harbor backend](../../agent-hitch/src/harbor-backend.js)
- [Hitch Harbor agent](../../agent-hitch/integrations/harbor/hitch_harbor_agent.py)
- [DSH SDK protocol](../deepseek-harness/packages/sdk/protocol/README.md)
- [DSH SDK server](../deepseek-harness/packages/sdk/server/README.md)
- [DSH SDK client](../deepseek-harness/packages/sdk/client/README.md)

# Prime Agent IPython Kernel 移植决策

- 状态：Implemented seam；高级 Jupyter wire/snapshot 仍为后续方向
- 目的：为 [DSH Self-Evolving Harness Plugin Spec](dsh-self-evolving-harness-spec.md) 定义 session-aware `NotebookRuntime`
- 参考实现：Prime Agent `KernelManager`、`IpythonKernelProvisioner`、state snapshot 与 Python comm runtime
- 更新：2026-08-20 — 最终选择独立 `NotebookRuntime` capability seam；不在 one-shot `CodeRuntime` provider 内隐藏 session kernel map；补全 Meta/TargetWorker/rollout 生命周期、角色化 Host Bridge 与无 UI busy-kernel 策略。

## 1. 结论

移植 Prime Agent 的 Jupyter wire client、kernel lifecycle、uv/venv bootstrap、Host Bridge comm 与可选 dill snapshot，但不移植它的 Python-skill 安装模型，也不把 IPython 做成 DSH 唯一工具。

DSH 新增独立、明确携带 `SessionId` 的 `NotebookRuntime` capability seam。它与现有 `CodeRuntime` 并列：

- `CodeRuntime.run(request)` 是 one-shot program execution，`CodeRunRequest` 刻意没有 session/owner；
- `NotebookRuntime.execute(request)` 是 session-owned stateful execution，namespace 与进程必须跨多次 tool call 延续；
- terminal 是 PTY/字节流，Notebook 返回结构化 cell result，不落到 terminal seam。

因此不采用“provider 内按 session 延续 kernel”的隐藏实现。那种方案需要 provider 从一个不含 session id 的 `CodeRunRequest` 猜 owner，或者依赖 ambient Cordis scope；这与 DSH 明确跨边界传 `Agent`/`Session` 的约定冲突，也无法可靠处理 resume、worker crash 和 disposal。

## 2. Prime Agent 实际如何拥有 kernel

Prime Agent 不是一个全局解释器服务按字符串查 session。`AgentSession` 持有自己的 `_ipythonKernelProvisioner`；构建 session runtime 时把 `cwd`、`sessionId`、Host Bridge handlers、snapshot 目录和 previous-dispose gate 交给 provisioner，随后 `ipython` tool closure 直接捕获它。`KernelManager.sessionId` 用于全局 live-kernel cleanup 与 snapshot ownership。

这提供了两个可移植原则：

1. kernel owner 必须是明确 session，不是全局 provider 的隐式调用者；
2. tool execution 必须把 exact `exec.agent.session.id` 传进 NotebookRuntime，resume 后同 id 才能选择同一 namespace/snapshot。

DSH 的 `ToolRunContext.agent` 已提供 exact Agent；`tool-ipython` consumer 缺少 agent 时必须 fail loud，不能回退到 process cwd 或共享 kernel。

## 3. Capability seam 与 packages

建议包布局：

```text
packages/notebook/
  notebook-runtime/           # Service Definition
  notebook-runtime-ipython/   # Provider: KernelManager + bootstrap + snapshot
  tool-ipython/               # Consumer: ipython_input tool
  notebook-host-bridge/       # Provider-neutral role/capability registration
```

Definition 最小接口：

```ts
interface NotebookExecuteRequest {
  sessionId: SessionId
  cwd: string
  role: NotebookRole
  code: string
  signal: AbortSignal
}

interface NotebookResult {
  generation: number
  value?: JsonValue
  stdout: string
  stderr: string
  displays: JsonValue[]
  error?: { name: string; message: string; traceback?: string[] }
  reset?: boolean
}

abstract class NotebookRuntime extends Service {
  abstract execute(request: NotebookExecuteRequest): Promise<NotebookResult>
  abstract interrupt(sessionId: SessionId): Promise<void>
  abstract restart(sessionId: SessionId): Promise<void>
  abstract disposeSession(sessionId: SessionId): Promise<void>
}
```

Provider 的内部 `Map<SessionId, KernelRecord>` 是该显式接口的正常实现细节：key 来自 request，而不是 ambient context。`KernelRecord` 至少包含 cwd、role、generation、provisioner、snapshot identity 和 memoized disposal。相同 session id 使用不同 cwd/role/harness identity 时拒绝，不能静默重绑。

`tool-ipython` 注册 `ipython_input`，`executionMode` 为 exclusive/sequential，`presentCall` 使用 terminal card。它从 `exec.agent.session` 取 id/cwd，从 session setup 写入的固定 role descriptor 取 role，然后调用 `ctx.notebookRuntime.execute()`。Gear 的 refine-meta scope 同时挂载只读 evidence tools、DSH 原生 `read/write/edit/glob/grep/bash` 和 Gear 的 `candidate_diff/candidate_check/finalize_candidate/decline_candidate`。这些工具与 Python dotted control API 调用同一 capability implementation；coding tools 则通过 session-bound Candidate provider 操作 Git worktree。IPython 的 OS sandbox scratch 与 candidate worktree 是两个不同权限域，Python 自身不能直接打开 candidate 或 control-plane host path。

## 4. Session 与进程生命周期

| 角色 | Notebook owner | snapshot | Host Bridge | disposal |
| --- | --- | --- | --- | --- |
| Meta | Control Plane 的 persistent meta session | 可选，绑定 `MetaHarnessRef` | meta typed API | MetaHarness rotate 或 RefineService dispose |
| Target interactive | isolated TargetWorker 内的 target session | 可选，绑定 `TargetHarnessRef` | 仅 `refine.run/status` RPC proxy | session close；worker crash 后按同 ref/session resume |
| Rollout | Harbor trial 内的 ephemeral session | 默认关闭 | 无控制 API | trial 结束无条件回收 |

每个 DSH process 运行自己的 NotebookRuntime provider；Control Plane 不远程代管 TargetWorker 的 kernel。这样 target plugin 与其 IPython 都处于同一隔离 profile，worker crash 时 kernel 随进程退出，不会在 host 留下子进程。

Provider 监听 authoritative agent/session lifecycle，调用 `disposeSession()` 并等待 kernel shutdown。根 Cordis fiber dispose 时先拒绝新 execute，再 interrupt/flush/terminate 全部 kernels，最后等待进程退出。相同 session 的新 generation 启动前必须等待旧 generation disposal，避免两个 kernel 竞争同一 snapshot。

## 5. KernelManager 保留部分

### 5.1 Jupyter wire protocol

保留 Prime Agent 自研实现：

- ZMQ `shell` Dealer、`iopub` Subscriber、`control` Dealer 三通道；
- Jupyter multipart frame 与 HMAC-SHA256 签名；
- connection file 零端口回填、bounded poll 与 stderr tail 诊断；
- shell request/reply 串行，iopub `status: idle` 作为 cell 完成条件；
- `stream`、`execute_result`、`display_data`、`error` 的结构化采集；
- stdout/stderr/output 按完整结果位置执行 byte bounds 和 spill，而不是逐 chunk 截断。

V1 只用直接 `python -m ipykernel_launcher` spawn，不移植 Linux fork-server。fork-server 是启动优化，不影响语义；macOS fork safety、模板进程环境固化与 orphan port recovery 会显著扩大首版范围。

### 5.2 Bootstrap

保留 uv + venv、自举锁与 bootstrap version digest：

1. 解析 Config 指定 Python 或用 uv 安装固定 Python 版本；
2. 创建 owner-private venv；
3. 安装 pinned `ipykernel`、`dill` 与 DSH notebook runtime shim；
4. runtime shim 源码/lock digest 变化时原子重建；
5. 并发 bootstrap single-flight，失败输出有界诊断和 override 指引。

不安装 Prime Agent 的 editable Python skills。DSH skills 仍是 `SKILL.md` + SkillProvider/catalog；kernel 只安装固定 Host Bridge shim 和明确列入 provider Config/lock 的分析库。TargetHarness 不能通过 candidate 修改 venv dependencies。

`zeromq` 是新的原生 Node dependency。实现前必须验证 DSH engines/CI 覆盖的 macOS arm64/x64、Linux 和 Windows prebuild；没有可靠 prebuild 时先评估维护中的替代依赖。该选择是独立 substrate PR，不能让 candidate 自行添加。

## 6. Host Bridge 与角色化能力

Python shim 通过 Jupyter comm `target_name="host.request"` 发请求；Node 在 control channel 回复，避免占用正在等待的 shell execute request而死锁。每个 handler 调用携带：

```ts
interface HostRequestContext {
  sessionId: SessionId
  requestId: string
  generation: number
  signal: AbortSignal
  isCurrent(): boolean
}
```

handler registry 在 session setup 时按角色固定，不能由 Python payload 选择角色：

| role | handlers |
| --- | --- |
| meta | `harness.current`、`harness.read`、`seed_tasks.load`、`trajectory.query`、`hitch.status`、`candidate.diff/check/finalize/decline`；源码编辑走同 session 的 DSH coding tools |
| target | `refine.run`、`refine.status` |
| rollout | 空 |

Meta handler 是 Control Plane 内部 typed calls。Target handler 不持有 RefineService object；它通过 TargetWorker SDK JSON-RPC 的 server→client capability request 到 Control Plane，后者校验 worker id、session id、pinned harness ref、参数和 admission policy。Rollout 即使构造原始 comm payload也因 handler 不存在而拒绝。

generation 变化后旧 comm handle 全部失效；handler 必须在开始和 commit 前检查 `isCurrent()`。kernel 进程不接收模型、Hitch、Git 或 host credential，返回值也不得包含 authority-bearing object。

## 7. Cell 日志与 snapshot 语义

`ipython_input` 是普通 DSH tool：源码写入 `tool/call.arguments`，完整模型可见结果写入 `tool/result`。不新增 `cell/run` 事件，避免同一执行有两套 durable truth。

模型决策可以从 session log 重建，因为它看到过的 stdout/result/error 已在 `tool/result`；这不表示系统会自动再次执行历史 cell。自动执行历史代码可能重复写文件、发网络请求或启动 refinement，属于不安全副作用。resume 时只有两种合法状态：

- snapshot 安全恢复成功：记录恢复的变量/失败变量摘要；
- 无 snapshot、identity 不匹配或恢复失败：空 namespace + durable notice，模型按需要显式重算。

snapshot 使用 dill 逐顶层变量存储，跳过隐藏名、runtime shim、open handles 等不可恢复对象；设置总大小上限、atomic replace 和 owner-only permissions。manifest 绑定 Python/runtime version、SessionId、role 和 `MetaHarnessRef`/`TargetHarnessRef`。pickle 是可执行格式，只能读取该 session 自己在相同隔离域内生成的文件；不得从 TargetHarness repo、Seed Task 或用户 workspace 自动发现 snapshot。

## 8. Interrupt、busy kernel 与 crash

| 场景 | V1 行为 |
| --- | --- |
| caller abort | control `interrupt_request`；grace 后当前 execute 以 aborted settle |
| meta/rollout 仍 busy | fixed wait → repeated interrupt → kill/restart；在 `tool/result` 标记 namespace reset |
| interactive target 仍 busy | UI 可选择继续等待或 restart；UI 断开不放弃 owned cleanup |
| kernel process exit/iopub failure | 当前 execute error，generation 失效，下一次 lazy start fresh kernel |
| TargetWorker crash | container 回收其完整进程树；manager 按旧 TargetHarnessRef resume DSH session，snapshot best-effort |
| root/service dispose | 停止 admission，bounded snapshot flush，shutdown，最后 terminate process tree并等待 |

Prime Agent 的 `<ipython_kernel_reset>` / restore notice 语义保留，但在 DSH 中作为结构化 tool result/context 投影并进入日志。无交互环境禁止弹 UI 或无限等待。

## 9. 与安全隔离的关系

Prime Agent 的 direct-spawn IPython kernel 不是 sandbox，`isolation: process` 也不是安全声明。Gear 只复用它的 session ownership、持久 namespace 与 lifecycle 结构，不复用其“kernel 拥有用户 OS 权限”的 trust model。

`refine-meta` helper 的整个进程树必须运行在 OS sandbox 内，而不是只包装 `bash`/`%%bash`。kernel 的实际 cwd 是 per-session scratch；read 默认 deny root，只放行 Python runtime、packaged helper 与当前 scratch；write 只放行当前 scratch；network 全禁；host environment 采用白名单重建，HOME/TMPDIR/XDG/IPython state 指向 scratch。Control Plane 的 workspace、DSH repo、state/session logs、Hitch state、held-out 与 credentials 均不在这个可见集合中。Meta 访问 champion、seed public projection 和 trajectory public projection只能经过固定 Host Bridge。

macOS provider 使用 `sandbox-exec`，Linux provider 使用 Bubblewrap；依赖缺失、sandbox 初始化失败或 unsupported platform 必须在插件初始化时 fail closed。`metaSandbox.mode: disabled` 只能用于明确选择 Prime-style trusted local diagnosis 的场景；启用后不得宣称 held-out secrecy、typed-API-only input 或有效 promotion attribution。

Target/rollout kernel 的安全来自整个 DSH process 所在的 TargetWorker/Harbor container。candidate code 与 kernel 权限相同，因此必须共用固定 filesystem/network/credential profile。

NotebookRuntime 不提供任意 host file mount、credential lookup 或 package installation handler。需要这些能力的 proposal 属于 `rejected-for-substrate`。

## 10. 实施顺序与测试

1. `NotebookRuntime` Definition + fake provider，证明 session id/cwd/role 显式传递、dispose ownership 和 consumer composition。
2. IPython provider：target/rollout direct spawn、meta whole-process sandbox launch、wire protocol、structured result、interrupt/restart/teardown；加入原生依赖平台 gate。
3. `tool-ipython` REAL composition + keyless snapshot，证明 `tool/call`/`tool/result` replay 和 exact agent session routing。
4. role Host Bridge：meta/target/rollout denial tests；target 反向 RPC 集成在 TargetWorker protocol PR。
5. snapshot：identity/permission/size/partial restore/crash tests；rollout disabled path。

必须覆盖两个 session 并发不共享变量、同 session 连续执行保留变量、resume identity 匹配、cwd/role mismatch fail loud、dispose 与 execute race、旧 generation comm 被拒绝、busy meta 自动 reset、TargetWorker crash 不遗留 host kernel。

## 11. 参考

### Prime Agent

- `packages/coding-agent/src/core/kernel/index.ts` — KernelManager/Jupyter client
- `packages/coding-agent/src/core/kernel/bootstrap.ts` — uv/venv bootstrap
- `packages/coding-agent/src/core/kernel/state-snapshot.ts` — dill snapshots
- `packages/coding-agent/src/core/tools/ipython.ts` — provisioner/tool wiring
- `prime-agent-runtime/src/rlm/__init__.py` — Python comm peer

### DSH

- [CodeRuntime Definition](../deepseek-harness/packages/code-runtime/code-runtime/src/index.ts)
- [Tool execution context](../deepseek-harness/packages/core/tools/src/index.ts)
- [Agent create/resume lifecycle](../deepseek-harness/packages/core/agent-loop/README.md)
- [Terminal ownership reference](../deepseek-harness/packages/terminal/terminal/src/index.ts)
- [SDK TargetWorker transport basis](../deepseek-harness/packages/sdk/protocol/README.md)

# prime-agent IPython Kernel 移植决策

- 状态：Draft v0.4
- 目的：为 DSH 自进化 harness 插件（[spec](dsh-self-evolving-harness-spec.md)）的 `PythonNotebookRuntime` 组件提供移植决策
- 参考实现：`../prime-agent/packages/coding-agent/src/core/kernel/`（KernelManager，1605 行）+ `src/core/tools/ipython.ts`（工具层）+ `prime-agent-runtime`（Python 侧 rlm shim）
- 更新：2026-08-19 — 基于对 prime-agent 源码的完整阅读与四轮探索调研
- 更新：2026-08-19 — v0.2：按 DSH 源码核查修正一处事实（"Python SDK 渲染器"实为 TS 侧 codegen `py-types.ts`，`python/` 目录无渲染器）；补 zeromq 原生依赖进 DSH 仓库的工程代价与决策记录
- 更新：2026-08-20 — v0.3：澄清移植边界——prime-agent 的 Python skills（pyproject 包 editable 安装进 kernel venv、cell 内 await 调用）不移植；DSH 的 skill 加载保持原生，`ipython_input` 只是工具面的新增成员
- 更新：2026-08-20 — v0.4：取消独立 `cell/run` 事件域（cell 即工具调用，复用 `tool/call` + `tool/result`），与 spec v0.3.5 同步

## 1. 结论

prime-agent 的 IPython kernel 是一套**自研的 Jupyter wire protocol 客户端**（ZMQ 三通道 + HMAC 签名），配合 uv venv 自举、Linux fork-server 快启、dill 逐变量命名空间快照，构成"常驻内核 + 上下文外置"的 RLM 执行层。**核心（KernelManager + 工具层 + 快照）整体可移植到 DSH**，需要替换的外围只有三处：进程/会话生命周期钩子、`rlm` Python shim（替换为 spec 的预加载 typed API）、以及（可选）fork-server。

移植边界论证：持久 kernel 落在 `ctx.codeRuntime` 缝的 **Provider** 角色上（`language: 'python'` 是 well-known 值、为 Python 语言生成模型可见 SDK 的 codegen 已就绪——注意实现在 TS 侧 `packages/core/tools/src/py-types.ts`，`python/` 目录本身无渲染器、只含 SDK 客户端与捆绑运行时定位器——README 明言 persistent kernel 是 future work）；与 `ctx.terminals` 缝的边界是：**状态性像 terminal、语义像 code-runtime**——结果必须是结构化 `{value, logs, error}`（入 `tool/result` 日志可重放），而不是 PTY 字节流。

## 2. 引入方式（wiring）

per-session 一个 kernel，模型侧只有一个 `ipython` 工具（`executionMode: "sequential"`，kernel 单线程）。

```
agent-session.ts _buildRuntime()
  → new IpythonKernelProvisioner(cwd, { sessionId, hostHandlers, pythonSkills,
      snapshotDir, readyGate: previousDispose, onRestore })
  → createIpythonToolDefinition(cwd, { provisioner })   // ctx.tools.register 等价物
```

`IpythonKernelProvisioner`（`tools/ipython.ts:329-545`）职责：

| 能力 | 实现 | 移植到 DSH 的落点 |
| --- | --- | --- |
| 懒启动 + 并发去重 | `ensure()` memoized startup promise，失败清 memo 重试 | provider `run()` 内首次调用时启动 |
| 后台预热 | `prewarm()` 吞错，下次 ensure 暴露 | 可做可不做（V1 不做） |
| 启动进度 | startup listeners，中途加入可重放当前阶段 | 经工具 `onUpdate` 流式推 UI |
| 生命周期 | `dispose()` / `kill()`，`readyGate` 防新旧 kernel 竞争快照文件 | DSH session dispose（参照 `ctx.terminals` 的 owner-isolated dispose） |
| 全局 boot 限流 | `withKernelBootPermit` **只包 spawn**，restore/bootstrap 在门外 | 保留（防 fan-out 打爆 OS 进程数） |

## 3. 实现核心：KernelManager

`kernel/index.ts` — 自研 Jupyter 客户端，无 JS jupyter 库依赖。

### 3.1 通信协议（保留原样）

- 多帧报文 `[<IDS|MSG>, HMAC-SHA256 签名, header, parent_header, metadata, content]`，`createHmac("sha256", key)` 对 4 个 JSON 帧签名（`index.ts:427-478`）
- 三通道：`shell` Dealer（execute request/reply）、`iopub` Subscriber（输出流）、`control` Dealer（interrupt/shutdown）；SUB 订阅后 50ms slow-joiner
- connection.json 端口先写 0，ipykernel 回填真实端口，Node 每 25ms 轮询等待（5s 超时，失败带 stderr 尾部 1024 字诊断）

### 3.2 进程启动

```
直接路径: spawn(python, ["-m", "ipykernel_launcher", "-f", connection.json],
                { cwd, env, stdio: ["ignore","pipe","pipe"] })
Linux 快路径: fork-server — 常驻模板进程（付一次 ~1.2s 导入成本）+
              gc.freeze() COW 共享 + os.fork()（~ms 级）
```

- fork 请求超时可能已 fork 出占用端口的孤儿：回退直接 spawn 前 `rmSync` 旧 tempDir + **重新 mint connection** 防端口冲突（`index.ts:708-719`）
- fork-server 仅 Linux（macOS 上 fork-without-exec 不安全）；env 覆盖 `PYTHON*`/`VIRTUAL_ENV`/`CONDA_PREFIX` 时拒绝 fork 走直接 spawn（sys.path 导入时已固化）；fork 后必须 `IPKernelApp.clear_instance()`（jupyter_client Session 要在子进程 pid 内创建，否则 `check_pid` 静默丢消息）
- **V1 决策：不做 fork-server**，直接 spawn 够用

### 3.3 执行与输出采集

- `execute()` promise 链全串行（Jupyter shell 是 request/reply）
- iopub pump 以 `status→idle` 为 cell 结束信号；收集 `stream`/`execute_result`/`display_data`/`error`；stdout/stderr 截断 64K 字符 + 尾部标记
- `display_data` 自定义 MIME 提取结构化产物（edit 的 diff、attach-image 的附件、agent-message 的消息）——**移植时映射到 DSH 的 `tool/result` 结构化结果**
- 内部 execute（快照/恢复/列名）打 `internal: true` 标记，不计入 `lastCellCode`

### 3.4 中断与崩溃恢复

| 场景 | 处理 |
| --- | --- |
| abort | control 通道 `interrupt_request` + 1s grace 后强制以 `"aborted"` settle |
| busy kernel | 5s 内每 500ms 重发 interrupt → 超时抛 `KernelBusyAfterInterruptError` → UI 选择「等待保留状态 / 杀掉重启」；杀后结果带 `<ipython_kernel_reset>` 提示变量已丢失 |
| 直接 spawn 意外退出 | `error`/`exit` 事件记诊断、置 shutdown、清理资源 |
| forked 意外死亡 | 1s 轮询 `process.kill(pid, 0)`（ESRCH 才算死） |
| iopub 泵失败 | reject 当前 execute |
| 进程信号 | `beforeExit`/`SIGINT`/`SIGTERM` 异步 shutdown（flush 快照）、`exit` 同步 disposeSync；`liveKernels` 全局 Set + session 级资源清理按 sessionId 匹配 |

busy-kernel wait/kill 选择 + `<ipython_kernel_reset>` 通知是**设计上直接照搬**的部分。

## 4. venv 自举（bootstrap.ts）

`ensureKernelPython()`（memoized，key = env + pythonSkills JSON）：

- 默认：`uv python install 3.11` → `uv venv --seed` → `uv pip install ipykernel prime-agent-runtime dill + 12 个默认包`（venv 在 `~/.prime/agent/kernel-venv`）
- `.bootstrap-version` 文件记录 runtime 源码 sha256——**runtime 源码任何改动自动重建 venv**
- Python skills 按 pyproject 依赖拓扑增量 `--editable` 安装，pyproject hash 未变则跳过
- `PRIME_AGENT_KERNEL_PYTHON` override：校验 ipykernel + 13 个 `rlm.harness` 方法签名 + 12 个默认包
- 锁目录 + pid 文件防并发 bootstrap；失败统一 `formatBootstrapFailure` 说明需联网/可设 override

**移植决策**：机制保留；`prime-agent-runtime` 替换为 spec 的 Python API 包（`harness.current()`、`seed_tasks.load()`、`trajectory.query()`、`hitch.status()`、`refine.run()`）；12 个默认包裁剪为 seed-task 实际需要的；kernel python 路径进 provider `Config`（DSH 约定：部署级变量必须可配置）。

## 5. 状态保持：dill 逐变量快照（state-snapshot.ts）

- **逐顶层变量独立 pickle**（`dill.settings["recurse"]=True`）——单个不可序列化对象（打开的文件、GPU tensor）只跳过该变量并上报，不毁整个快照
- 跳过 `_` 开头、`user_ns_hidden`、`always_skip = {rlm, asyncio, In, Out, get_ipython, exit, quit, open}`（rlm/asyncio 每次启动由 bootstrap 重建）
- 上限 256MiB；payload 原子写（`.tmp` + `os.replace`）+ manifest（saved/skipped/bytes/pythonVersion）
- 触发：每次 execute 成功后 debounce 1500ms；dispose/退出前有界 flush（5s）；`kill()` 不 flush
- restore 在 bootstrap **之前**（bootstrap 随后用活的 rlm/skills 句柄覆盖旧句柄）；恢复结果 `RestoreResult{restored, failed, path}` 经 `<ipython_state_restored>` 上下文消息告知模型
- 生成代码内 builtins 走本地 `_b` 别名，用户 shadow `list`/`open` 不影响

**与 spec 的一致性**：spec §4 明确"snapshot 是可丢弃的恢复便利，不是真相源；变量缺失可重算，session 日志不可丢"——prime-agent 的降级语义（跳过不可序列化 + 上报）完全吻合。**直接照搬**。

## 6. Host Bridge：comm 协议走 control 通道

```
Python 侧:  rlm.host_request(type, payload)
            → ipykernel.comm.Comm(target_name="host.request", primary=False)
            → comm.open(data={**payload, "type": type}) → 等 comm_msg 回复
Node 侧:    handleCommMessage → handleHostRequest（按 data.type 查 hostHandlers 注册表）
            → 注入 cellSourceCode（触发 cell 源码）→ 回复走 control 通道
```

- 回复走 control 而非 shell 通道：**避免"admission 回复死锁活跃 execute_request"**（`docs/rlm-runtime.md:121-128`）
- hostHandlers 注册表（`agent-session.ts:8760`）：`rlm.run`、`rlm.find_models`、`rlm.list_subagents`、`rlm.delete_subagent`、`model.info`、`goal.*`、`compact.run`、`refine.run`、`refine.status`、`rlm_heartbeat.*`、`agent_message.*`
- handler 安全：symbol + WeakSet 品牌校验，`HostRequestContext` 带 `requestId`/`generation`/`signal`/`isCurrent()`

**移植决策**：comm 机制保留（它让 kernel 内 async 任务也能发起 host 调用）；`rlm.*` handlers 替换为 spec §4 的预加载 typed API。**与 prime-agent 的差别**：spec 禁止 kernel 直接写 harness repo（prime-agent 的 `rlm.harness.*` 是纯 Python 直写 JSON——spec 明确不采纳，改为 `HarnessMutation` 校验后走 git commit）。

## 7. 依赖清单与替换表

| prime-agent 依赖 | DSH 侧 | 决策 |
| --- | --- | --- |
| `zeromq`（Dealer/Subscriber） | DSH 无 ZMQ 依赖 | 新增 `zeromq` npm 依赖（代码原样移植）。注意：**原生模块**——DSH 仓库当前零 ZMQ 依赖，且带 hygiene/publint 门禁与 Windows wine CI；引入前需确认预构建二进制的平台覆盖（macOS arm64/x64、Linux、Windows），必要时评估 prebuildify 或改用纯 JS 的 `js-zeromq` 替代（性能损失可接受性待基准） |
| `@earendil-works/pi-ai` 的 `registerSessionResourceCleanup`/`cleanupSessionResources` | DSH session 生命周期 | 替换：挂 `session/disposed` 事件或 provider dispose |
| `uv` + venv | 保留 | 机制原样，`PRIME_AGENT_KERNEL_PYTHON` → provider `Config.python` |
| `prime-agent-runtime`（rlm shim） | 新建 spec 的 Python API 包 | 替换（见 §4） |
| `ipykernel` / `dill` | 保留 | 不变 |
| fork-server（Linux） | — | V1 不做 |

## 8. 移植到 DSH 的完整落点

| prime-agent 组件 | DSH 落点 | 说明 |
| --- | --- | --- |
| `ipython` 工具 | `ctx.tools.register(defineTool({ name: 'ipython_input', ... }))` | `presentCall` → `{ card: 'terminal' }` render intent；避开保留名 `run_code` |
| KernelManager | `packages/code-runtime/code-runtime-ipython/`（Provider） | `class IpythonCodeRuntime extends CodeRuntime`，`language='python'`，`isolation='process'`（标签非安全声明） |
| busy kernel wait/kill + `<ipython_kernel_reset>` | 工具 execute 内 | 直接照搬 |
| dill snapshot | provider 内 | 直接照搬；与 spec §4 语义一致 |
| venv 自举 | provider 内 | 机制保留，python 路径 Config 化 |
| host bridge comm | provider 内 | comm 机制保留，handlers 换 spec API |
| `rlm.harness.*` 直写 | **不做** | 改为 `HarnessMutation` + git commit（spec §5） |
| `_rebuildSystemPrompt` 热生效 | `systemPrompt.section()` 注册（agent scope） | 见 harness 装配分析 |
| cell 结果入日志 | 复用工具管道的 `tool/call` + `tool/result`（不设独立事件域） | `ipython_input` 注册为普通工具即自动满足；无需新增 `cell/run` 事件域 |

**说明**：prime-agent 的 Python skills（pyproject 包 `--editable` 安装进 kernel venv、cell 内 `await skill(...)` 调用）不移植——DSH 的 skill 加载保持原生（SKILL.md + SkillProvider 缝 + catalog），`ipython_input` 只是工具面的新增成员，不是唯一工具（DSH 既有工具面由 preset 组合决定，原样保留）。

## 9. 需要论证的边界（spec §10 要求）

1. **与 code-runtime 缝**：定义是 one-shot（`CodeRunRequest` 无 streaming/会话句柄）。持久 kernel 两条路：(a) 保持 `run()` 单次语义、kernel 内部按 session 延续命名空间（每次 `run()` 只是往同一 kernel 塞一段 program）；(b) 扩展 `CodeRuntime` 加 session 方法（属破坏性定义变更，需评审）。V1 建议 (a)。
2. **与 terminal 缝**：terminal 是"进程树 + 字节流"，code-runtime 是"program + bindings + 结构化结果"。持久 kernel 的**模型可见输出必须是结构化结果**（经 `tool/result` 入日志），不能是 PTY 字节流——这是 cell 重放契约（`tool/call` + `tool/result`）的前提。
3. **进程安全**：kernel 不是安全沙箱（prime-agent 与 spec §11 一致）；不可信 hook/tool 代码走 Harbor Docker，与 kernel 隔离正交。

## 10. 参考文件索引

### prime-agent（`../prime-agent/`）

| 文件 | 用途 |
| --- | --- |
| `packages/coding-agent/src/core/kernel/index.ts` | KernelManager：Jupyter 协议客户端、生命周期、comm 桥 |
| `packages/coding-agent/src/core/kernel/bootstrap.ts` | uv venv 自举、runtime 校验 |
| `packages/coding-agent/src/core/kernel/boot-gate.ts` | 全局 boot 信号量 |
| `packages/coding-agent/src/core/kernel/fork-server.ts` / `fork-server-script.ts` | Linux fork 快启（V1 不做） |
| `packages/coding-agent/src/core/kernel/state-snapshot.ts` | dill 逐变量快照/恢复 |
| `packages/coding-agent/src/core/tools/ipython.ts` | 工具层 + provisioner + bootstrap code |
| `packages/coding-agent/src/core/refinement/refinement.ts` | Continual Harness 状态机（无评测循环——spec 的 Hitch 部分是新增） |
| `packages/coding-agent/docs/rlm.md` | RLM 编程模型（4 条不变量） |
| `prime-agent-runtime/src/rlm/__init__.py` | Python 侧 `host_request` comm 对称实现 |
| `test/ipython-provisioner.test.ts` | 测试策略：stub python 可执行文件 + spawn 计数 |

### DSH（`../deepseek-harness/`）

| 文件 | 用途 |
| --- | --- |
| `packages/code-runtime/code-runtime/src/index.ts` | `CodeRuntime` Service Definition（Provider 落点） |
| `packages/code-runtime/code-runtime-worker-thread/src/index.ts` | Provider 模板 |
| `packages/terminal/terminal/src/index.ts` | owner-isolated 会话生命周期模板 |
| `packages/core/tools/src/index.ts` / `presentation.ts` | 工具注册 + render intent |
| `packages/interaction/commands/src/index.ts` | `/refine` 命令注册 |
| `packages/core/session/src/types.ts` | `SessionEventMap` 事件域 |
| `packages/plan/plan-mode/src/index.ts` | 插件事件域最小范例 |

## 11. 相关历史

- [DSH 自进化 harness spec](dsh-self-evolving-harness-spec.md)（v0.2，2026-08-19）
- prime-agent 顶部 TODO（`kernel/index.ts:1`、`ipython.ts:1`）："reconsider persistent kernel vs stateless `python -c` once RLM-1 weights land"——持久 kernel 是为 RLM 推理设计，移植时保留该决策点

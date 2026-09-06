# DSH Meta Agent Context Offloading

- 状态：V1 已实现；具体配置、恢复边界与验证见第 13 节
- 日期：2026-09-06
- 范围：Gear 中 `metaAgent.runtime.type === 'dsh'`
- 首版范围：支持 candidate 执行中的 step 边界交接，保留 workspace，重建 notebook

## 1. 核心提议

Meta 的有效上下文接近预算时，控制器在安全的 step 边界生成一个有界 handoff，创建新的 DSH session，并让它继续同一个逻辑执行。旧 session 的日志持久保留，按需读取，不再整体进入后续模型请求。

一个 candidate generation attempt 可以对应多个连续的物理 session：

```text
candidate C / attempt 1 / workspace W
  session S0 -> handoff H0 -> session S1 -> handoff H1 -> session S2
                                                           -> finalize
```

轮换不改变 evolution、round、candidate、attempt、parent、baseline 或 workspace，不重置 deadline、模型请求数和 token 消耗；不自动产生新的评测、proposal 或 commit。

换 session 本身不会减少上下文，减少来自“完整历史留在存储，下一次请求只加载恢复所需内容”。如果只需要缩短请求，同 session compaction 是改动更小的方案。本提议选择 fresh session，是为了显式记录每次交接和执行连续性；代价是要处理 session 绑定迁移、局部运行时重建，以及可能的 prompt cache 损失。

## 2. 已核对的实现基础

### 2.1 Gear 当前代码

- `src/meta/session.ts`：`fork()` 使用 checkpoint 的完整事件前缀作为 `seed`。轮换根 session 不能解决已存在的 candidate session 或 population member checkpoint 的上下文增长。
- `src/refine/service.ts`：candidate 执行、workspace 路由、finalization 与单个 `metaSessionId` 绑定；`wake.completion` 在旧 session idle 且没有 proposal 时会被视为失败。
- `MetaSessionManager.wakes` 和 `evidenceAccess` 按 session 存在内存中，包含当前轮次和诊断回执，不能依赖模型重新叙述来迁移。
- `MetaCheckpointRef` 标识真实日志前缀：`sourceSessionId + eventCount + prefixDigest`。历史 checkpoint 不能因 offloading 被改写。
- Notebook kernel 按 session 管理。新 session 不会自然继承 Python 变量、进程句柄或 scratch 文件。

现有主 spec 的“每个 evolution 至多一个 persistent Meta session”需要在方案定案时修订为：一个根 Meta 逻辑上下文，以及各 candidate 的上下文分支；每个分支可以保留多个历史 session，同一执行最多一个可写 session。

### 2.2 DSH 可复用能力

本机 DSH 源码工作树基于 `99f6f02fec`，已包含：

- `dsh-token-meter`：按有效 surface、request header 与 provider usage 估计请求压力。
- `agent/pre-step`：下一次模型请求前的控制点。
- `agent/request-error` 与规范化 `CONTEXT_WINDOW_EXCEEDED`：provider 确认溢出的恢复入口。
- 工具调用/结果配对检查，以及 `whenIdle()`、`runMaintenance()`、session flush。
- `dsh-compaction-basic`：同 session 摘要替换、自动压力阈值和溢出恢复，可参考其计量和摘要路径。

源码位置：`packages/llm/token-meter`、`packages/core/agent`、`packages/compaction`。Gear 当前依赖未直接声明 token-meter/compaction 包；本机源码的能力不等于 Gear 所装版本已经暴露全部所需能力，实施时必须验证版本与插件挂载。

`agent/request` 只允许替换调用配置，不是修改历史的接口。`runMaintenance()` 只允许在真正 idle 时执行；不能在占用 agent 的 pre-step hook 内等待该 agent idle，否则可能死锁。当前 `pre-step` 的公开 decision 只有 enter/reject，不能把 reject 自动理解成可恢复的 pause；必须显式保存已 claim 的消息和交接意图。

### 2.3 从 Codex 借鉴什么

参考公开源码 commit [`6af345407d9c2a568da9d01b6c4b81a9e61495c0`](https://github.com/openai/codex/tree/6af345407d9c2a568da9d01b6c4b81a9e61495c0)，不推断未公开的桌面实现：

- [compact.rs](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/core/src/compact.rs) 的摘要路径在同一 session 中替换有效历史，保留有界的用户消息，并重新注入必要初始上下文；替换与 compaction metadata 一起持久化，随后重新计算 token usage。
- [摘要 prompt](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/prompts/templates/compact/prompt.md) 要求保留进度、决定、约束、未完成工作和继续所需引用。
- [compact_remote.rs](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/core/src/compact_remote.rs) 提供远端压缩路径，不能假设其返回物可直接用于 DSH。
- 该版本还存在 [compact_token_budget.rs](https://github.com/openai/codex/blob/6af345407d9c2a568da9d01b6c4b81a9e61495c0/codex-rs/core/src/compact_token_budget.rs) 的无摘要新 context window 路径。因此本文只借鉴明确核对过的摘要交接机制，不将所有 Codex compaction 等同于一种实现。

Gear 借鉴“有界恢复上下文、持久化替换、继续原任务”，选择新建物理 session 是本 spec 的设计选择。

## 3. 身份与必须保持的事实

建议新增逻辑执行身份 `executionId`，对应 `(evolutionId, roundId, candidateId, attempt)`；它具有单调递增的 `generation` 和当前 `activeSessionId`。根 Meta 上下文使用独立 owner，不冒充 candidate execution。

必须满足：

1. 同一 execution 最多一个 session 拥有修改与提交权限；所有 candidate 能力验证当前 generation。
2. session rotation 不增加 attempt；真正的 generation failure 才进入现有 retry 流程。
3. deadline 和资源预算覆盖全部 session 及辅助摘要请求。不能靠轮换获得新预算。
4. 同一 attempt 内保留 workspace，包括未提交修改；不从 parent 重建 worktree，不重放写操作。
5. 已完成的 finalize/decline 优先结束 execution，不再为它轮换。一次 execution 最多提交一次业务结果。
6. 新 session 使用 evolution 封存的 Meta preset、provider/model、sampling 与权限边界。
7. 所有历史 session 和 checkpoint 保持可寻址；释放 live handle 不删除日志。

## 4. 什么时候交接

### 4.1 检查点

- fork/wake 前：将即将加入的 round envelope 计入预算，避免刚启动就溢出。
- 每次模型请求前：工具 step 完整结束后检查压力，覆盖单个长 turn。
- provider 返回规范化 context overflow 时：进入有界的紧急恢复。

默认不按固定轮数、wall time、累计计费 token 或日志字节数触发。

### 4.2 预算口径

记：

- `C`：有效模型的 context window，来源于 adapter metadata 或显式封存配置。
- `P`：下一请求前已占用的上下文压力，包括 system、tools、有效消息，以及即将注入的内容。
- `R`：继续一个受限 step 并完成 handoff 所需的余量，包含下一输出、工具返回、摘要指令/输出与估算误差；组合时按各请求的峰值计算，不重复计算同一 token。

建议初始策略：`P >= min(0.8 * C, C - R)` 时交接。`0.8` 是待校准的 Gear 初值，不是 Codex 默认值。

`model.maxTokens` 是输出限制，不是 `C`。DSH token-meter 的 `totalTokens` 已包含其定义的 request/response pressure；接入层必须明确哪些输出已在 anchor/surface 中，不能再次把历史输出全量加一遍。使用 DSH 对 cache usage 的规范化口径，缓存命中不等于不占上下文。

first request 没有 usage 时，按完整请求估算。尚未写入 session 的 pending/claimed messages 要额外计入并去重。缺少 `C` 时不猜测模型容量：要求配置后启用主动轮换；显式选择仅溢出恢复的模式需报告该限制。

模型可见的单次工具返回和同一步聚合返回必须有大小边界，大结果保留正文并返回摘要/ref。否则任何软阈值都无法保证下一步不突然溢出。沿用 Gear 当前 diagnostic card/detailRef 模式；不要为了本功能给 Meta 开放整个宿主日志目录。

### 4.3 防止反复轮换

- 新 session 的完整 bootstrap 必须低于触发线，并留出足够继续工作的空间；建议目标不超过 `0.5 * C`，属于可校准值。
- 摘要自身建议初始上限 4k tokens；具体值应适配模型窗口，不能挤掉用户约束与业务事实。
- 相同 source checkpoint 只能提交一次同 owner 的 handoff；不能将同一份超长上下文反复创建成新 session。
- 没有任何有效工作推进便再次 overflow 时，最多进行一次紧急恢复，然后返回可诊断失败。
- 固定 system/tools/必须保留的输入本身放不下时，报告 `context-unrecoverable`；轮换不能修复这一问题。

## 5. Handoff 包

每次交接落盘一个不可变 bundle，分为控制器事实、模型摘要和按需读取的历史引用。以下为概念结构，字段命名未定：

```text
handoff/
  manifest.json   # schema、owner、source checkpoint、generation、digest、artifact refs
  state.json      # Gear 生成的恢复事实
  summary.md      # 模型生成的有界工作摘要
```

### 5.1 控制器生成的 state

包含：execution identity、原始/当前任务输入的引用、sealed spec identity、parent/baseline、workspaceId、当前修改摘要和 digest、诊断审计快照、finalization 状态、剩余预算/绝对 deadline、pending 输入及 delivery cursor、可用 artifact 索引。

事实来自现有 store、workspace 和 session 记录。LLM 不生成或修改 session ownership、evidence receipts、剩余预算、文件 digest 或权限。

### 5.2 模型生成的 summary

目标区和运行状态区独立于摘要：原始任务 envelope、按顺序保留的用户修正，以及 controller 最新状态都直接传给摘要生成器和接续 session，不经过 LLM 重写或历史裁剪。后来的用户修正覆盖先前冲突要求；摘要中的目标和旧进度不能覆盖这些精确输入。目标输入在工作记录中按消息 ID 去重，不重复压缩。

只总结与当前目标有关的可见工作记录，不要求转储内部推理。固定内容：

1. 与独立目标区一致的工作发现；不重新生成目标、约束、完成条件和运行游标。
2. 已确认的诊断及对应 evidence refs；明确区分事实与尚待验证的假设。
3. 已采取的修改、涉及文件和验证结果。
4. 已否定的方法及简短原因，避免重复试错。
5. 未完成工作、阻塞点，以及具体的下一步。
6. 继续工作必须按需读取的文件、诊断详情或历史片段引用。
7. 不能自动继承的局部运行时状态，以及是否需要重建。

摘要可以合并上次 handoff 与后续增量，但每次都重新取 Gear 权威事实，生成一份整合后的摘要；不能把历代 handoff 原文层层嵌套。

摘要引用不能充当“已经读取证据”或“已获得权限”的证明。原始证据中的指令保持数据属性，不能因进入摘要而被提升成控制指令。

### 5.3 摘要生成与新 session 加载

控制器对冻结的 source snapshot 发起一次辅助模型调用，默认使用同一封存模型；输出预算单独记录。该调用不驱动业务工具、不允许 finalize，不向旧 proposal turn 加入额外业务 request header。可以沿用稳定前缀以争取 cache 命中，但不保证新 session 的缓存效果。

完整原始日志只在存储中保留。新 session 加载：

```text
封存的 Meta preset / system / tools
+ 当前 round/candidate 恢复 envelope
+ 必须精确保留的用户输入与新 steering
+ 最新 controller 状态（独立于摘要）
+ 一个有界 handoff summary
+ 少量确有必要的最近内容或 artifact refs
```

默认不复制完整旧事件前缀。若保留原生消息尾部，必须满足工具调用与结果配对；否则将它转换成有出处的事实摘要，不能放入孤立 tool result。

历史读取需要受 owner、checkpoint 上界和 evidence policy 约束的分页接口。它只访问该分支本来可见的内容，限制输出大小；sibling session、held-out、宿主任意路径不因为 offloading 变得可读。当前 Gear 尚无通用 Meta transcript 读取接口，不能把此能力假定为已存在。

## 6. 交接流程与持久化

```text
running -> quiescing -> prepared -> activated -> running(new session)
                          |             |
                     abort/recover   retire old handle
```

1. **请求交接**：在安全边界记录 rotation intent，阻止旧 session 进入下一模型 step；先确认尚未 finalize/decline。
2. **达到静止**：完成当前已发起的工具调用和返回落盘。保存所有尚未处理、已 claim 或新到达的输入。旧 DSH turn 可以结束，但逻辑 execution 的 completion 仍保持 pending。
3. **冻结并持久化**：flush 旧日志，记录真实 checkpoint 和 workspace/evidence revision；进入 maintenance 后生成摘要和 bundle。若仍有写进程、notebook 执行或未知结果，先收敛，不能宣布安全交接。
4. **准备新 session**：以 fresh context 创建，不传完整历史 seed；装载相同 preset，校验 bundle、ownership、请求预算。此时不授予业务写权限，也不启动 continuation。
5. **提交切换**：以 execution revision/generation 做 CAS，持久记录 active session 的切换。新旧权限路由均以这一个权威指针为依据；不能依赖跨文件写入天然原子。
6. **激活并继续**：重建 workspace/evidence 路由，按 durable delivery cursor 投递 continuation 和交接期间的新输入。flush 可恢复的 session/input 状态后启动，最后释放旧 live handle。

transaction journal 至少记录 intent、source checkpoint、bundle digest、预分配的 successor sessionId 和切换是否提交。重复恢复沿用同一 successor，不额外创建活跃分支。

切换提交前失败：保持旧 owner，可在确认尚有上下文空间时恢复旧 session，或继续同一交接事务。切换提交后失败：仅恢复新 owner，不能重新激活旧 session。恢复遇到 workspace 丢失、digest 不符或副作用状态未知时，明确失败，不能自动重放编辑/命令以猜测状态。

手动取消、attempt timeout、round timeout 对全部阶段生效；摘要和创建 successor 也使用同一 deadline。迟到摘要与迟到 successor 不得复活已经停止的 execution。

## 7. 证据、proposal 与分支

### 同一个 attempt 内 rotation

已访问 refs、diagnosis receipts 在静止点持久化，以 execution 为 owner，保留 origin session/seq 或已有 receipt 引用；新 session 可以继承这些经控制器验证的审计事实，不必重复读取已完成的诊断卡。

最终 proposal 仍归属于真正执行 finalize 的物理 session 和真实 request/tool event；另外记录 executionId、generation、handoff refs 以追溯早期工作。摘要不伪造 DSH 事件，也不代替 ProposalEvidenceAudit。

### 从 parent checkpoint fork 新 candidate

新 candidate 是新的 owner。可以继承允许访问的工作知识；父轮次/父 candidate 的证据读取状态不能转换成本轮审计，新 baseline 仍按当前规则诊断。

fork 前若继承上下文已经过大，从不可变 parent checkpoint 构造有界 bootstrap。parentCheckpoint 的语义仍是实际父日志前缀，handoff 作为另一份可审计产物记录，不能偷偷改变 checkpoint 指向。

同一 checkpoint、sealed policy 和可见性范围的兄弟 forks 可以复用同一份已生成 bootstrap，避免在父上下文准备阶段引入无意义的差异。不得将 sibling 后续编辑或评测注入其他分支。

## 8. Session 局部运行时

- Candidate worktree 原样保留，新 session 绑定同一逻辑路径。
- V1 默认创建新 notebook kernel；不搬运 Python heap、pickle 或旧进程句柄。
- 必须继续使用的数据先显式保存为该 execution 可访问的 artifact，或通过可重复的读取/分析代码重建。不能假设旧 session scratch 路径在新 sandbox 下仍可访问。
- 摘要需说明已丢失的变量/句柄和恢复办法；读取外部状态、重新执行有副作用的命令不能被视为普通 runtime 恢复。
- 已提交但仍运行的业务操作必须有结果或显式可恢复的操作记录；首版没有跨 session 进程接管时，等待或按既有取消流程收敛，禁止两个 session 同时控制它。

## 9. 失败语义

| 情况 | 行为 |
| --- | --- |
| 接近阈值 | 主动生成 handoff，继续同 attempt |
| 请求确认 overflow | 从冻结事实和受限历史构造紧急 handoff；不重发原样超长请求 |
| 完整历史已无法用于摘要 | 保留现有权威事实、上一份有效摘要、近期增量及日志 refs；必要时有界缩减摘要输入，并记录 coverage 限制 |
| 无有效摘要或输出截断/不收缩 | 不激活新 owner；有界重试或报告 `context-handoff-failed` |
| 固定输入过大/恢复后立即重复溢出 | `context-unrecoverable`，停止本 attempt |
| 权限、digest、owner 校验失败 | 失败关闭，保留日志与 workspace 供恢复 |
| 停止/预算耗尽 | 结束整个 execution，不创建新 attempt 来绕过预算 |

如果进入现有 candidate retry 策略，必须记为真实的基础设施失败，遵守原来的 attempt 上限；不能折叠成 no-change/decline，也不能把 retry 与成功 rotation 混为一谈。

DSH 内建自动 compaction 与 Gear rotation 必须只有一个主动协调者。建议本模式中关闭 Meta preset 的独立 auto-compaction，由 Gear 负责轮换；可复用计量与摘要实现。不能让两个 pre-step/error handler 按偶然插件顺序争抢一次压力事件。若保留先 prune 后 rotation 的组合，顺序和预算必须显式定义。

## 10. 接口与实施边界

优先改动以下责任边界，具体 TypeScript 接口待定：

- `MetaSessionController`：区分逻辑 completion 与物理 session idle，能观察 active session 变化，并按 execution 取消/释放；外部 skill adapter 不被迫采用 DSH rotation。
- `MetaSessionManager` / `DshMetaAgentHost`：检测压力、冻结 snapshot、生成/加载 handoff、管理 session lineage；根 session 与 candidate session 各有正确 owner。
- `RefineService`：保持 attempt、deadline、finalization promise 和 workspace 连续，承接 active session 切换；rotation 不触发 `MetaTurnEndedWithoutProposalError`。
- `CandidateWorkspaceManager` / capabilities：所有写入口验证 active generation，切换时拒绝旧 session 的迟到调用。
- state store / types：持久化交接 journal、session 链和审计快照；旧状态按 generation 0 读取，不迁移或重写历史日志。
- dependency/preset identity：封存 offloading policy、summary prompt 版本/摘要模型身份以及必需的 DSH 插件配置；修改这些会影响后续 evolution identity。旧 evolution 缺少此策略时不静默启用。

V1 不新增全局向量记忆系统，不替代现有 evidence store，不触及 target agent 或其他 runtime 的 context 策略，不依赖 OpenAI 私有 compact endpoint。

## 11. 验收场景

1. 低阈值下，同一 candidate 连续跨两次 session，保留未提交 diff，最终只 finalize 一次。
2. 一个很长的工具 turn 在 step 边界交接；旧 session idle 不导致 attempt 失败，也不丢已 claim 的输入。
3. 普通工具输出突然超长时走受限返回/ref；真实 overflow 只进行有界恢复。
4. 最終归因指向 successor 的真实事件，证据审计可追溯 predecessor，父轮次和 sibling 证据不能越权继承。
5. 在 intent、bundle 落盘、新 session 创建、CAS 后、continuation 投递之间分别故障注入；恢复只有一个写 owner，输入不会被重复投递或静默丢弃。
6. rotation 与 finalize/decline/timeout/cancel 竞争时，没有重复提交、迟到写入或 execution 复活。
7. 所有 session、摘要调用和恢复请求累计计入原预算；deadline 不顺延。
8. 恢复后的 bootstrap 在预算内；不能收缩、缺少 model capacity、固定 prompt 过大均可诊断。
9. population 从旧 checkpoint fork 仍可工作；旧 checkpoint digest 不变，新 candidate 审计重新起算。
10. notebook 变量未继承时可从显式 artifact 重建，不假定 kernel state 或 scratch 自动存活。

运行记录至少包含：trigger、估算口径、切换前后压力、source/successor、bundle digest、摘要耗时/usage、预算消耗、结果与失败原因。用低阈值故障测试验证机制，再用长 candidate 实验评估摘要遗漏、重复读取、延迟和最终质量；token 降幅不能独自代表交接成功。

## 12. 设计时的选择（V1 取舍见第 13 节）

1. **首版覆盖范围**：推荐包含 candidate 执行中的 step 边界；只在 round/fork 边界切换更简单，但不能解决单个长 attempt。
2. **fresh session 是否为硬要求**：本文沿用该方向。若目标仅是解除 context 限制，可选 DSH 同 session compaction，减少 Gear ownership 与 notebook 迁移工作。
3. **局部运行时连续性**：推荐 V1 保留 workspace 和显式 artifacts，重建 notebook；无缝 notebook/process 接管另立范围。
4. **策略参数**：80% 主动触发、50% 恢复目标、4k 摘要是讨论用起点；最终值应通过目标模型与长 candidate 实验确定。

## 13. V1 实现与使用

本次实现选择 fresh session 和 candidate 执行中的 step 边界，保留 worktree 与诊断回执，重建 notebook kernel。上文的 80% / 50% / 4k 初值作为可配置默认值，尚未通过真实长任务实验校准。没有改动 target 或外部 skill adapter 的 context 策略。

### 配置与封存

```yaml
metaAdapter:
  kind: dsh
metaContextOffloading:
  mode: proactive
  contextWindow: 128000
  triggerRatio: 0.8
  bootstrapRatio: 0.5
  reserveTokens: 8192
  summaryMaxTokens: 4096
  maxToolResultTokens: 8192
  maxStepToolResultTokens: 16384
```

`contextWindow` 必须是所选模型的实际容量。未显式填写时，proactive 模式从 DSH exact-model metadata 解析并封存；缺失容量则拒绝启用。`overflow-only` 明确允许没有容量，但仅在 provider 确认溢出时恢复，其辅助摘要输入有独立上界，不能保证未知窗口可容纳它。不存在配置时保持旧行为；已有 evolution 使用原封存策略，不因当前 profile 新增配置而静默开启。

小窗口默认降低 reserve、summary 和 tool-output 上限。显式参数必须满足正整数及比例关系，不能把固定上下文挤出窗口。未设置 `metaModel.maxTokens` 时，每次业务请求使用封存的 `reserveTokens` 作为输出上限；显式 output limit 保持封存值。生产参数仍需要结合模型和工具负载校准。

实际触发余量取 `max(reserveTokens, effectiveOutputLimit + maxStepToolResultTokens)`，因此较大的显式输出上限会提前触发交接。已有历史输出已包含在 token-meter 压力中，不再次累加；独立摘要请求按自己的有界输入计算峰值。

摘要调用使用同一封存 provider/model/sampling、独立 `purpose: compaction` 请求，不带业务 tools，也不写 proposal session 的 request header。新策略封存 `gear-handoff-v2` 摘要 prompt 版本，已有 `gear-handoff-v1` evolution 继续使用原 prompt，不静默升级。DSH token-meter 固定为 `0.1.0-rc.8`。Meta preset 若包含独立 compaction 插件，会在启用时被拒绝。

V2 将精确任务、用户修正和最新 controller 快照放在独立的 `protected-handoff-context` 消息中，先从摘要输入预算扣除，再为旧摘要和近期轨迹分配剩余空间。目标区本身无法容纳时明确失败，不裁剪目标或约束。工作记录保留外层 event type / message source，内部历史任务的 USER 文本不升级为当前用户指令。摘要期间到达的新用户输入仍精确投递给 successor，并在下一次交接纳入保留区。

### 持久化与权限

- `src/meta/offloading-policy.ts`：策略解析、校验和摘要 prompt。
- `src/meta/offloading-host.ts`：有效 surface / request envelope 计量、pending 去重与工具禁用的辅助摘要调用。
- `src/meta/offloading-execution.ts`：逻辑 completion、安全边界、冻结、摘要、CAS、投递和恢复。
- `src/meta/offloading-store.ts`：execution CAS、不可变 bundle、owner-scoped 大结果存储。
- `MetaSessionManager` 与 `RefineService`：证据回执迁移、session 路由和真实 proposal 事件归因。

每个 execution 的单一 JSON 文件同时保存 revision、generation、active session、session 链、交接阶段、预算、deadline 和输入投递记录。bundle 用一个 content-addressed JSON 原子落盘，其中分别包含 manifest、控制器 state 和 summary；这是第 5 节概念目录的等价容器。日志与 bundle 通过 digest 验证，不把模型摘要作为权限或证据已读取的证明。

原 session 在下一 step 前先保存已 claim 的消息，再 reject 该物理 step。模型请求、正在进行的工具与 notebook 的生命周期先收敛；摘要在 idle maintenance 中执行。新 session 在 staging 期间没有模型执行和业务工具权限。CAS 完成后切换 worktree 绑定、证据回执与可观察的 candidate session，然后在 maintenance 内持久化 continuation，再让模型继续。原 finalization promise、attempt 和 timeout 不重建。

真实 parent checkpoint 的 eventCount 与 prefixDigest 保持不变。candidate 初次 wake 会将其继承的历史和当前 envelope 一并检查，必要时在第一次业务请求前交接；不同 candidate 的证据审计仍从各自 baseline 开始。V1 的 summary 由各 execution 独立生成，没有增加跨 sibling 的摘要缓存。

普通大工具结果保存完整正文，返回有界文本和 `output:` ref；同一步也有聚合限制。`meta_context_read` 只分页读取当前 execution 的 output refs 或其 handoff checkpoint 上界内的可见消息，不提供宿主路径接口。读历史不会登记为已读取本轮 baseline 证据。历史查询不重新激活已退休 agent。

预算先保守预留完整请求与输出，再按 DSH 规范化 usage 结算。input、cache-read、cache-write 各计一次，reasoning 不在 output 之外重复累加；provider 没有 usage 或请求结局未知时保留预留额度。摘要的 request、tokens 和耗时单独记录，同时计入原 attempt 总预算。恢复不延长 attempt 和 round deadline。

### 恢复与失败

启动时可恢复处于 handoff intent/prepared 或已激活、尚无未知业务副作用的 execution。落盘但尚未写入 journal 的 bundle 按 execution 与预分配 successor 身份找回。新 session 沿用同一预分配 ID；CAS 后只恢复新 owner。已落盘的 inbox/message ID 用于避免重复投递相同输入。

DSH 在首次 append 时才物化 session。若 owner CAS 已提交、continuation 尚未投递，successor 可能不在持久化列表中；只有 journal 的 activated 状态与已提交 bundle 的 owner、generation 和 successor ID 一致时，才允许按原 ID 重建空 session。delivered 状态下缺失日志仍拒绝恢复。恢复同一 attempt 时沿用 journal 封存的 parentCheckpoint，避免空 root 在重启后获得新 ID 而误判；当前 workspace、diff 与证据快照仍重新计算并校验。

恢复会核对封存身份、worktree parent、diff digest 和证据快照。若新 session 已执行工具调用而无法确认其业务副作用，或 workspace 内容不匹配，则失败关闭，保留 workspace 与日志供检查。V1 不尝试接管未知外部进程、不重放写命令来推测其结果。取消或超时覆盖 summary、session 创建和 activation；终止状态不能经 CAS 重新变为 running。

取消与 DSH maintenance 异常竞态时，抛出并持久化逻辑 execution 的原始 abort reason，避免底层取消对象将原因覆盖为 `[object Object]`。

### 验证

`tests/unit/meta-offloading.spec.ts` 使用真实 DSH agent loop 与离线模型 adapter 验证连续两次交接、预算、溢出恢复、摘要失败、取消、交接期间 steering、大工具返回、owner 隔离。intent / bundle 落盘 / prepared / activated / delivered 五处重启测试使用真实 PersistenceCoordinator，在销毁旧 context 后通过 `MetaSessionManager.restore()` 冷恢复，并验证日志缺失、owner 不匹配、未知副作用与 workspace 变化时拒绝恢复。`tests/unit/refine-service.spec.ts` 覆盖相同 Git worktree、单一 attempt、空 root 重建后的 parent checkpoint 保留和最终 session 归因。真实模型长任务的摘要遗漏、质量与阈值校准仍应由后续实验评估。

2026-09-06 的 V2 历史回放验证使用 GPT-5.6 Luna / medium、272,000-token 实际窗口和 80% 自然阈值：完整处理 56 条失败训练轨迹投影的 178 页（3,053,098 字符），经过 5 次交接、6 个 session，最大实际请求输入 217,311 tokens，未观察到上下文溢出。任务信封在全部交接中精确保留，成功处理的页码连续、无重复。4 次交接后误提交上一页被回放工具拒绝后恢复；摘要仍出现缩写引用和伪工具调用文本。该结果验证了这批材料上的目标隔离和可恢复接续，不代表摘要格式或工具参数始终正确；未执行新的 benchmark 或改动候选。

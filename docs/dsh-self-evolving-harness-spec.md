# DSH Self-Evolving Harness Plugin Spec

- 状态：Draft v0.1
- 目标运行时：DeepSeek Harness（DSH）
- 设计参考：Prime Agent persistent IPython + `/refine`
- 版本与评测后端：Hitch 0.1.x

## 1. 目标

实现一个运行在 DSH 内的自进化 Harness plugin：

1. 为每个 DSH session 提供持久 IPython 环境；
2. 提供 `/refine`，根据指定 Seed Task 分析当前 Harness，并在受限动作空间内生成、验证和评测改进；
3. 使用 Hitch 管理不可变 Harness revision、构建产物、隔离运行、评测记录和回滚所需历史。

V1 只演进 Harness，不演进 Seed Task、模型或 DSH Agent Loop。

## 2. 核心原则

- **小步修改**：一次 refinement 只修改一个语义目标，便于归因和回滚。
- **证据驱动**：每个修改必须引用 Seed Task trajectory、错误或 verifier 结果。
- **先计划后应用**：proposal 生成期间不修改 Harness；应用前使用 parent digest 做 CAS 检查。
- **候选隔离**：candidate 不修改当前 champion，也不在当前 turn 中热替换正在执行的 Harness。
- **评测决定激活**：candidate 通过相同 Seed Task、模型、环境和预算的对照评测后才能成为 champion。
- **基础层不可变**：原始 DSH system prompt、模型、权限和 evaluator 不属于自动修改范围；`system_prompt` mutation 只修改 supplemental prompt layer。

## 3. 架构

```mermaid
flowchart LR
    User["User or Agent"] --> Refine["DSH /refine"]
    Seed["Seed Task Set"] --> Refine
    Champion["Current Harness Ref"] --> Refine
    Refine --> Baseline["Hitch baseline rollout"]
    Baseline --> Evidence["Trajectory and verifier evidence"]
    Evidence --> Evolution["Evolution Agent in IPython"]
    Evolution --> Mutation["Validated HarnessMutation"]
    Mutation --> Candidate["Immutable Harness commit"]
    Candidate --> Hitch["Hitch resolve / prepare / eval"]
    Hitch --> Decision["Compare baseline and candidate"]
    Decision -->|accept| Champion
    Decision -->|reject| History["Refinement history"]
```

DSH plugin 包含五个组件：

- `PythonNotebookRuntime`：管理 per-session IPython kernel；
- `RefineCommand`：注册 DSH `/refine` slash command；
- `RefineService`：执行 refinement 状态机；
- `HarnessLoader`：把 champion/candidate overlay 装配进 DSH；
- `HitchClient`：只调用 Hitch CLI、daemon 和 schema，不复制 Hitch 内部实现。

## 4. Persistent IPython

每个 DSH session 拥有一个独立 kernel。kernel 在多次 tool call 和 context compaction 之间保持变量、import、函数和分析结果。

模型可见工具：

```ts
interface IpythonInput {
  code: string
}
```

最低能力：

- cell 串行执行，支持 stdout、stderr、result、display 和异常；
- 支持 interrupt、restart、dispose；
- 可选 safe snapshot，session resume 时逐变量恢复；
- kernel restart 后撤销旧 generation 的 Host Bridge handle；
- kernel 不保存模型 credential、Hitch token 或 DSH Host authority。

预加载的 typed Python API：

```python
harness.current()                 # 当前 Harness manifest 和 ref
seed_tasks.load(ref)              # 读取 Seed Task Set
trajectory.query(round_id, ...)   # 分析 rollout evidence
await hitch.status(run_id)        # 查询 Hitch run/eval
await refine.run(seed_tasks=...)  # 与 /refine 共用 RefineService
```

Python API 通过 DSH Host Bridge 执行。kernel 可以分析和提交 proposal，但不能直接写 Harness repo、创建 commit 或切换 champion。

## 5. Harness 与动作空间

一个 Harness revision 是可由 DSH 加载的不可变 overlay：

```text
harness/
  manifest.json
  prompts/
  memories/
  skills/
  hooks/
  workflows/
```

```ts
interface HarnessManifest {
  schemaVersion: 1
  parentRef?: string
  dshRevision: string
  artifacts: Array<{ path: string; digest: string }>
  digest: string
}

interface HarnessMutation {
  parentRef: string
  parentDigest: string
  target: SemanticTarget
  ops: ArtifactOp[]
  rationale: string
  evidenceRefs: string[]
  expectedOutcome: string
}

type ArtifactOp =
  | { type: 'create'; path: string; content: string; expect: 'absent' }
  | { type: 'patch'; path: string; patch: string; expectedDigest: string }
  | { type: 'delete'; path: string; expectedDigest: string }
```

V1 动作空间：

| Target | 可修改组件 |
| --- | --- |
| `context` | supplemental system prompt、skill catalog、tool visibility、history policy、memory retrieval、ordering |
| `pre_action` | validation、routing、planning |
| `post_action` | normalization、reflection、retry、experience extraction、workflow update |
| `skill` | trigger、policy、capabilities、context、verifier、recovery |
| `routing` | tool、skill、subagent routing；模型和 provider 固定 |
| `memory` | retrieval、write policy、retention |
| `verifier` | correctness、quality、safety、cost；candidate verifier 不能单独决定自身 promotion |

默认一次 Mutation 只能命中表中的一个组件。绝对路径、`..`、symlink escape、任意 shell operation 和修改 evaluator/Hitch/权限的操作必须被拒绝。

## 6. `/refine` 合同

```text
/refine <seed-task-ref> [--rounds N] [--budget B] [--target TARGET]
/refine status [ROUND_ID]
/refine rollback <HARNESS_REF>
```

`/refine` 运行在 DSH command plane，不作为普通 user message 发送给 Target Agent。`await refine.run(...)` 与 slash command 调用同一个服务，并在当前 turn 结束后的 idle boundary 执行。

每轮流程：

1. 固定 champion、Seed Task Set、模型、DSH revision、环境、seed 和预算；
2. 使用 Hitch 对 champion 执行 baseline rollout；
3. Evolution Agent 在独立 DSH session/IPython kernel 中读取 Harness、trajectory、verifier 结果和 refinement history；
4. 输出一个 JSON `HarnessMutation`；没有充分证据时输出空 proposal；
5. 校验动作空间、风险、路径和 parent digest；
6. 在专用 Harness Git repo 中应用 mutation 并创建不可变 candidate commit；
7. 使用 Hitch resolve/prepare candidate，并对 baseline/candidate 执行匹配评测；
8. 满足 hard constraints 且 score 改善达到阈值时更新 champion pointer，否则保留原 champion；
9. 记录 proposal、diff、evidence、Hitch refs、score、decision 和 rollback target。

`--rounds N` 重复上述过程；下一轮只能基于上一轮接受的 champion。失败或拒绝的 candidate 不得成为后续 parent。

## 7. Hitch 集成

Harness Git commit 是版本 ID，Hitch 是 revision、artifact、run 和 eval 的权威执行记录：

```text
hitch resolve dsh-evolving@commit:<sha> --json
hitch prepare dsh-evolving@commit:<sha> --json
hitch run --harness dsh-evolving@commit:<sha> --output jsonl ...
hitch eval run --backend harbor --harness dsh-evolving@commit:<sha> ...
```

V1 直接复用 Hitch 已实现的：

- exact commit resolution 和 content identity；
- prepared artifact cache；
- run supervision、timeout、cancel 和 terminal status；
- `worktree | copy` workspace isolation；
- authenticated daemon queue；
- Harbor eval、trial 和 reward records。

需要新增一个薄的 Hitch harness definition：`dsh-evolving`。它负责从指定 commit 构建 DSH overlay，固定 `dshRevision`，并启动 DSH headless profile；不得重写 Hitch resolver、artifact store、scheduler 或 process supervisor。

Hitch Harbor 一次只评测一个 Harness ref，因此 baseline 和 candidate 使用两次参数完全一致的 eval，由 `RefineService` 合并结果。Hitch workspace 不是安全 sandbox；executable hook/tool candidate 必须使用 Harbor Docker。

Hitch 不决定哪个版本是 champion。DSH plugin 只维护一个最小索引：

```ts
interface RefinementRecord {
  id: string
  parentRef: string
  candidateRef?: string
  mutationRef?: string
  baselineRunRefs: string[]
  candidateRunRefs: string[]
  decision: 'accepted' | 'rejected' | 'failed'
  scoreDelta?: number
  createdAt: string
}
```

该索引只保存 lineage 和 Hitch record reference；不复制 Hitch artifact、event 或 terminal state。

## 8. 评测与激活

baseline 和 candidate 必须使用相同：

- Seed Task revision 和任务顺序；
- 模型、provider 和 sampling 参数；
- DSH base revision；
- workspace image、permission、seed、timeout 和 token budget；
- verifier 和评分公式。

自动接受仅适用于 declarative mutation。修改 executable hook、tool 或 verifier code 的 candidate 即使得分更高，也需要人工确认；权限、网络、credential、模型和 evaluator 变更永不自动接受。

champion 只在任务边界更新。新任务由 `HarnessLoader` 加载新 ref；正在运行的 session 不热替换。rollback 只移动 champion pointer 到已存在且验证过的 Harness ref。

## 9. 最小持久化

```text
.dsh-refine/
  champion.json
  rounds/<round-id>.json

<harness-repo>/
  harness/...

<hitch-root>/
  store/
  runs/
  evals/
  workspaces/
```

`<hitch-root>` 必须位于被管理的 source repo 之外，并由 Hitch 独占写入。

## 10. V1 验收标准

- IPython 状态跨 tool call 和 compaction 保持，interrupt/restart/dispose 不遗留失控 kernel；
- `/refine` 能在指定 Seed Task 上产生 baseline evidence；
- proposal 只能包含动作空间内的单一语义修改，并携带 evidence 和 expected outcome；
- parent digest 冲突时 candidate 不会被部分应用；
- 每个 candidate 都对应一个 exact Hitch commit ref，重复 resolve 得到相同 identity；
- baseline/candidate 评测除 Harness diff 外完全一致，并能反查 Hitch run/eval records；
- rejected/failed candidate 不改变 champion，accepted candidate 只在任务边界生效；
- rollback 不重建旧版本，只切换到已有 immutable ref；
- DSH plugin 不复制 Hitch 的版本解析、artifact cache、进程、workspace 或评测状态机。

## 11. 非目标

- 完整 GEAR Supervisor 或 Data Infra；
- Seed Task 生成、模型训练或 checkpoint evolution；
- 在运行中的 turn 内自修改；
- 自动修改权限、credential、网络策略、模型、evaluator 或 DSH Agent Loop；
- 把 IPython 当作安全 sandbox。

## 12. 设计参考

- [Prime Agent refinement implementation](../../agentfw/prime-agent/packages/coding-agent/src/core/refinement/refinement.ts)
- [Prime Agent IPython tool](../../agentfw/prime-agent/packages/coding-agent/src/core/tools/ipython.ts)
- [Prime Agent kernel manager](../../agentfw/prime-agent/packages/coding-agent/src/core/kernel/index.ts)
- [Prime Agent RLM programming model](../../agentfw/prime-agent/packages/coding-agent/docs/rlm.md)
- [DSH command subsystem](../../agentfw/deepseek-harness/docs/subsystems/commands.md)
- [Hitch README](../../agent-hitch/README.md)
- [Hitch design](../../agent-hitch/docs/design.md)
- [Hitch Harbor evaluation](../../agent-hitch/docs/evals.md)
- [RSI Harness Action Space](https://my.feishu.cn/wiki/ZsTUwNqC6i0Ot0kVZqAcZqv3nrh)

# Gear + Hitch evaluation rerun 联合修复规范

- 状态：Proposed
- 目标分支：Gear `dev`；agent-hitch `main`
- 评审基线：Gear `7ae6aac`
- Hitch 基线：`agent-hitch v0.2.4`
- 目标合同版本：`agent-hitch v0.2.5`

## 1. 决策摘要

本修复必须先完成，当前 Gear PR 才可合并。Gear 与 Hitch 的改动作为同一兼容性合同交付，先发布 Hitch `v0.2.5`，再合入依赖它的 Gear 变更。

实现采用以下决策：

1. Hitch 把 `(task_id, attempt)` 定义为唯一的逻辑 trial slot，支持任意正整数 `attempts` 的 invalid/missing slot rerun。
2. 不从 Harbor 的随机 trial 名推断 attempt。Hitch 将 `attempts=N` 拆成 N 个 `n_attempts=1` 的 Harbor shard，并显式把逻辑 attempt 序号传入 Harbor bridge 和 trial importer。
3. `/eval rerun --invalid` 选择全部无效或缺失 slot；`--task <task>` 选择该 task 下全部无效或缺失 slot。Hitch 按 attempt 分组执行 shard，只替换被选中的 invalid slot，绝不覆盖 valid slot。
4. 新合同由 `agent-hitch v0.2.5` 提供。v0.2.4 的 `attempts=1` eval 继续兼容；v0.2.4 创建的 `attempts>1` eval 因缺少可靠 attempt identity，必须 fail closed，不做猜测性迁移或 rerun。
5. Gear 要求 `agent-hitch >= 0.2.5`，并在启动时验证实际 executable 的版本；不允许在 `--eval-id` 失败后去掉参数重跑。
6. Gear evaluation rerun 是 `RefineService` 管理的一等 active repair job。job 在调用 Hitch 前登记，持有 `AbortController`、completion promise 和 evolution round lock。
7. `dispose()` 必须 abort 并等待所有 active repair jobs；job 完成、失败或把 lock 移交给 resumed drive 前不得释放 lock。
8. 已完成 repair 通过独立的 durable `evaluationRepairResume` intent 贯穿 resumed drive，直到 terminal/commit intent 才与 attempt `settled` 原子消费；启动恢复必须在任意中间 round phase 识别并继续该 intent。
9. seed candidate evaluation 失败且导致可选 candidate 不足时，只要存在可修复的 failed Hitch attempt，round 必须停在 `failed`，不得提交 `rejected/no-change`，也不得继续 batch。
10. 不重开已经终结的 `rejected/no-change` round。repair 只接受尚未进入 population/champion commit protocol、且 frozen parent 未变化的 `failed` round。

本文中的“必须”“不得”和“应”分别对应 MUST、MUST NOT 和 SHOULD。

## 2. 背景与问题

Gear PR `7ae6aac` 已能为 evaluation 预留稳定 `evalId`、保存 failed attempt，并通过 Hitch `eval rerun` 修复 baseline/held-out 的无效 task，但当前有四处合同断裂：

- rerun 使用未保存的 `new AbortController()`，不属于 `active` 或 `drives` 生命周期；服务无法取消或等待它。
- hard restart 会把 `repairing-evaluation` round 改为 `failed`，却把 attempt 留在 `rerunning`，使下一次 rerun 永久被拒绝。
- seed candidate evaluation failure 被局部 catch，候选不足后 round 变成 `rejected/no-change`；只接受 `failed` round 的 rerun 命令无法修复它。
- Gear 对任意 Hitch `0.2.x` 和任意正数 attempts 均表现为可修复，但 `--eval-id`、`eval rerun` 从 Hitch `v0.2.4` 才存在，且 v0.2.4 rerun 只接受 `attempts=1`。

Hitch 侧不能通过删除 `attempts !== 1` 校验来支持多 attempts。当前 Harbor trial 名使用不透明随机后缀，Hitch 的 importer/bridge 在后缀不是 `__(digits)` 时会回退到 attempt 1；这会让多个物理 trial 落到同一个逻辑 `(task_id, 1)`。因此必须由 Hitch 显式分配 attempt，而不是从 Harbor 输出反推。

这些问题必须同时闭合 Hitch logical identity、Hitch durable progress、Gear in-memory ownership、Gear durable state、restart recovery 和 CLI capability 六个边界。

## 3. 目标与非目标

### 3.1 目标

- Hitch 对 `attempts >= 1` 提供稳定的 task-level rerun，每个 slot 可独立识别、保存和替换。
- valid slot 的 run identity、reward 和 verifier reference 在 rerun 前后保持不变。
- 初次 eval、partial rerun、rerun 中断和再次 rerun 都从同一份 durable progress 推导完整性。
- Gear rerun 在正常完成、Hitch 失败、service dispose 和进程重启后都有确定的 terminal/retryable 状态。
- seed-baseline、seed-candidate、held-out-baseline、held-out-candidate 四种 Gear attempt 使用同一 repair protocol。
- 每个 Gear repair 继续使用原 `evalId`、condition、dataset、model 和 exact commit；不得创建第二个 evaluation identity。
- 修复成功后从 durable round state 继续原 round，不重新生成已 sealed candidate，也不重跑已有 valid evidence。
- 运维人员可以从 `/refine status` 找到可修复的 `evalId` 和 phase。

### 3.2 非目标

- 不从 Harbor trial 名、目录顺序或完成顺序猜测 attempt 序号。
- 不迁移或猜测性修复 v0.2.4 创建的 `attempts>1` eval。
- 不自动触发 invalid task rerun；repair 仍由显式 `/refine rerun` 触发。
- v0.2.5 不新增单独的 `--attempt` selector；`--task` 选择该 task 的全部 invalid/missing attempts。
- 首个版本不并行执行多个 attempt shards；先保持全局 concurrency 上限与取消语义清晰。
- 不重开已有 `decision` 或 `commitIntent` 的 Gear round。
- 不在 Gear 中复制 Hitch 的 progress、rerun lock 或 slot selection 逻辑。
- 不通过捕获 “unknown option” 后删掉 `--eval-id` 重试普通 evaluation。

## 4. Hitch 多 attempt 合同

### 4.1 Logical trial slot

Hitch 定义：

```ts
interface EvalTrialSlot {
  task_id: string
  attempt: number
}
```

slot key 必须等于 `task_id + "\u0000" + attempt`。对冻结计划中的每个 task，合法 attempt 范围为 `1..plan.attempts`。

- `valid slot`：progress 中恰好存在一个相同 key、且 `observation_status === 'valid'` 的 trial ref。
- `invalid slot`：progress 中存在相同 key，但 observation invalid。
- `missing slot`：冻结计划中应存在该 key，但 progress 没有 trial ref。

`EvalProgressV1` 必须满足：

- `planned_tasks === plan.tasks.length`；
- `planned_trials === plan.tasks.length * plan.attempts`；
- `request.attempts === plan.attempts`；
- 每个 trial 的 task 属于冻结计划，attempt 是范围内的安全正整数；
- `trial_id`、`run_id` 和 logical slot key 各自唯一；
- progress 可以暂时缺少 slot，但不得包含计划外或重复 slot。

`mergeEvalProgressTrial()` 必须新增 logical slot duplicate guard。只有 rerun 的 `replaceInvalidEvalProgressTrial()` 可以替换相同 slot，并且只能把 invalid/missing slot 替换为新的 valid ref；valid slot 不可替换。

### 4.2 Attempt-sharded initial eval

新 eval 在 `plan.json` 写入 additive execution marker：

```json
{
  "schema_version": "1",
  "attempts": 3,
  "attempt_execution": "harbor-attempt-shards-v1"
}
```

计划、request 和 progress 必须在启动第一个 Harbor process 前 durable。

当 request `attempts=N` 时，Hitch 按 attempt `1..N` 顺序运行 N 个 Harbor shard：

```text
<eval>/harbor/attempt-0001/
<eval>/harbor/attempt-0002/
...
<eval>/harbor/attempt-00NN/
```

每个 shard：

- Harbor config 固定 `n_attempts: 1`；
- dataset 包含该 eval 的全部冻结 tasks；
- `n_concurrent_trials` 仍为用户配置的 `max_concurrent`；
- agent kwargs 携带显式 `logical_attempt: K`；
- backend/import options 携带相同的 `expectedAttempt: K`；
- 只允许发布 attempt 为 K 的 refs。

shards 必须串行执行。这样总并发不超过 `max_concurrent`，abort 会终止当前 shard且阻止后续 shard启动。如果 shard K 失败，Hitch 停止启动 K+1..N；已发布的 progress 保持 durable，剩余 slot 作为 invalid/missing 由后续显式 rerun 修复。

`result.json` 的 `trials` 与 `summary` 从完整 progress 生成，而不是只使用最后一个 Harbor result。多 shard 诊断使用按 attempt 排序的 additive `backend_runs: Array<{ attempt, backend, backend_summary }>`；仅有一个 shard 时保留当前 singular `backend`/`backend_summary` 字段，避免破坏 attempts=1 消费者。顶层 `status` 只有在所有 planned slots valid、所有已需执行的 shards 成功且未 abort 时才是 `succeeded`。

### 4.3 Bridge 与 importer identity

`RunHarborBackendOptions`、job config builder 和 trial import options 增加显式 logical attempt。

Python Harbor bridge 必须：

1. 接受 `logical_attempt`；
2. 验证它是安全正整数；
3. 将它写入 run parent、agent context metadata 和 trial bundle；
4. 在提供该字段时不得再从随机 Harbor trial name 推断 attempt。

TypeScript importer 必须：

1. 接受 `expectedAttempt`；
2. 要求 bundle parent attempt 与 expected value 完全相同；
3. diagnostic fallback 也使用 expected value；
4. 对 attempt mismatch 抛出稳定 identity error，不发布 progress。

为了兼容非 eval 或旧 attempts=1 路径，未提供显式 value 时可以保留现有解析逻辑；新 `harbor-attempt-shards-v1` 路径不得使用 fallback。

### 4.4 Multi-attempt rerun

Hitch 内部 selector 从 task list 升级为 slot list：

```ts
type RerunTrialSelector =
  | { mode: 'invalid' }
  | { mode: 'tasks'; taskNames: readonly string[] }
```

CLI 语义保持简单：

- `--invalid`：选择冻结计划内全部 invalid/missing slots；
- `--task foo`：选择 foo 下全部 invalid/missing slots；
- task 不在计划中返回 `eval_rerun_unknown_task`；
- task 的所有 attempts 均 valid 时返回 `eval_task_already_valid`。

选中的 slots 按 attempt ordinal 分组。每组运行一个 `n_attempts=1` Harbor shard，只把该组的 task names 放入 dataset，并传入该组的 logical attempt。目录为：

```text
<eval>/reruns/<rerun-id>/harbor/attempt-0002/
```

publish 必须验证返回 slot 精确属于 selected set；仅凭 task name 匹配不够。一个 valid result 发布后立即原子更新 progress 和 rerun state，因此后续 shard 失败时，已修复 slots 仍然 durable。再次执行 rerun 只选择剩余 invalid/missing slots。

rerun 期间始终持有当前 eval 的单一 rerun file lock。abort 停止当前 shard、阻止后续 shard，并保留已完成的 slot replacements。异常路径必须尽力用最新 progress 重建顶层 eval result。

### 4.5 Rerun output

保持现有 task-level 字段，新增 slot-level additive 字段：

```ts
interface EvalRerunResult {
  selected_tasks: string[]
  repaired_tasks: string[]
  remaining_invalid_tasks: string[]
  selected_trials: EvalTrialSlot[]
  repaired_trials: EvalTrialSlot[]
  remaining_invalid_trials: EvalTrialSlot[]
}
```

数组按 `task_id`、再按 `attempt` 稳定排序。task-level 数组是对应 slot 数组去重后的 task IDs：

- `repaired_tasks` 表示至少一个 slot 在本次成功替换的 task；
- `remaining_invalid_tasks` 表示仍至少有一个 invalid/missing slot 的 task；
- `eval_status === 'succeeded'` 仅当冻结计划的全部 slots valid，否则为 `failed`。

### 4.6 旧 eval 兼容性

兼容规则必须明确：

| Eval 来源 | 行为 |
| --- | --- |
| v0.2.4，`attempts=1`，无 execution marker | 按 legacy single-attempt 计划 rerun |
| v0.2.5+，有 `harbor-attempt-shards-v1` marker | 按本节 slot 合同 rerun |
| v0.2.4，`attempts>1`，无 marker | 拒绝，不能可靠恢复 logical attempt |
| marker 未知、plan/progress 不一致或有 duplicate slot | fail closed，不调用 Harbor |

旧多 attempt 计划的稳定错误至少应包含：

```text
eval was created without explicit logical-attempt identity; create a new eval with agent-hitch >= 0.2.5
```

该错误使用稳定 code `eval_rerun_legacy_attempt_identity`。

Hitch `v0.2.5` 必须在 Gear 合入前发布。版本说明应明确这是首个支持 multi-attempt task rerun 的版本。

## 5. Gear repair 状态机

### 5.1 Round 与 attempt 状态

`failed` 仍是自动 drive 的 terminal 状态，但可作为显式 repair 入口。是否可修复是派生属性，不新增持久化的 `repairable` round status。

| 时点 | Round status | 目标 attempt status | 内存 owner | Lock owner |
| --- | --- | --- | --- | --- |
| 原 evaluation 失败 | `failed` | `failed` | 无 | 无 |
| repair 已登记、Hitch 即将/正在执行 | `repairing-evaluation` | `rerunning` | `ActiveEvaluationRepair` | repair job |
| Hitch 返回失败、证据不完整或 repair 被 abort | `failed` | `failed` | 无 | 释放 |
| Hitch 返回完整 evidence、准备交给 round drive | `repairing-evaluation` + `evaluationRepairResume` | `repair-completed` | repair job，随后转 `ActiveRound` | 同一 lock 转交 |
| resumed drive 继续处理中 | 任意 non-terminal、无 commit intent phase + `evaluationRepairResume` | `repair-completed` | `ActiveRound` | active round |
| round 形成 commit intent 或明确 terminal | `promoting`/terminal，无 resume intent | `settled` | `ActiveRound` 或无 | active round/释放 |
| hard restart 发生在 resumed drive 任意无 commit intent 阶段 | 保留原 phase + `evaluationRepairResume` | `repair-completed` | 启动时重建 `ActiveRound` | stale lock 清理后重新获取 |

repaired evidence、目标 attempt 的 `repair-completed` 状态、`completedAt` 和 round-level `evaluationRepairResume` 必须在同一次原子 round write 中提交。`repair-completed` 必须有 matching evidence，并由 resume intent 在任意 non-terminal、无 decision/commit intent 的 round phase 中唯一拥有。首次 resumed transition 不消费 intent；只有形成 durable commit intent、明确 terminal/no-change，或遇到可归因的非取消 drive failure 时，才把目标 attempt 原子改为 `settled` 并删除 resume intent。

### 5.2 Gear 全局不变量

- 同一 evolution 只能有一个持有 evolution round lock 的 round、repair 或管理操作。
- 同一 `(evolutionId, roundId)` 最多有一个 active repair job。
- repair job 和 resumed `ActiveRound` 不得同时独立拥有两个 lock；handoff 使用 job 的原 lock。
- 调用 Hitch `eval rerun` 前，round 与 attempt 的 `repairing-evaluation/rerunning` 状态必须 durable。
- 完整 repaired evidence 只能与 `repair-completed` 状态原子落盘，不得形成新的 `rerunning + evidence` 快照。
- `evaluationRepairResume` 存在时必须唯一指向 matching `repair-completed + evidence` attempt；terminal、decision 和 commit intent 状态不得持有该 intent。
- job 仍可能操作 Hitch 子进程时，`dispose()` 不得释放 lock 或清空 runtime。
- attempt 的 provider、`evalId`、phase、owner、condition、dataset、model、requested commit 和 repetitions 在 repair 中不可修改。
- population 或 champion 一旦偏离 round 的 frozen parent，旧 round 不得 repair。
- `commitIntent` 一旦存在，repair 必须 fail closed；commit recovery 仍由 `reconcileCommitIntent()` 独占。

### 5.3 Hitch compatibility preflight

`HitchCliEvaluator` 增加可缓存的 compatibility check，`RefineEvaluator` 用 optional preflight 方法暴露该能力。Gear 插件启动时必须对配置的 evaluator 执行 preflight；从 persisted evolution spec 创建的新 evaluator，也必须在第一次 reservation/evaluation/repair 前完成同一检查。

preflight 规则：

1. 运行配置中的 `<hitch.executable> --version`，超时不超过 5 秒，stdout/stderr 各有小型上限；
2. 解析 semantic version；
3. 版本必须 `>= 0.2.5`，prerelease 按标准 semver 排序；
4. executable 不存在、退出非零、超时、输出不可解析或版本过低都阻止 Gear 启动；
5. 错误包含 executable、observed version 与最低版本；
6. 成功结果可在 service lifetime 内按 executable 缓存，失败不得缓存为成功。

稳定错误至少应包含：

```text
unsupported Hitch CLI <observed>; Gear requires agent-hitch >= 0.2.5 for stable eval identity and multi-attempt rerun
```

普通 evaluation 必须始终携带 Gear 预留的 `--eval-id`。任何 compatibility error 都不得触发第二次 `hitch eval run`。

### 5.4 Repair eligibility 与 fail-closed 顺序

`rerunEvaluation()` 在任何 round/attempt 状态写入前，必须在 evolution lock 下按顺序验证：

1. service 未 disposed，且 round 不在 `active` 或 active repair map 中；
2. evolution 存在且仍为 `active`；
3. round 属于该 evolution，且 `round.status === 'failed'`；
4. `round.decision === undefined` 且 `round.commitIntent === undefined`；
5. 当前 population digest 等于 `round.parentPopulationDigest`；
6. 当前 champion ref/digest 等于 `round.targetHarnessRef/targetHarnessDigest`；
7. round 恰好拥有指定 `(provider: 'hitch-cli', evalId)` attempt；
8. attempt status 为 `failed`，owner 仍存在且 exact commit 未变化；
9. frozen evaluation request 与 attempt 的 condition、dataset、model、commit 和 repetitions 一致；
10. evaluator 实现 rerun 且 Hitch compatibility preflight 成功。

任一检查失败都不得修改 round、candidate 或 attempt，也不得调用 Hitch。这里不再限制 `repetitions === 1`；任意正整数 repetitions 由 Hitch v0.2.5 slot 合同处理。

如果 evolution 已通过后续 round 改变 population/champion，错误必须指出 failed round 已 stale，操作者应创建新 round，而不是重开旧状态。

### 5.5 Active repair job

`RefineService` 增加独立于 candidate `ActiveRound` 的 registry：

```ts
interface ActiveEvaluationRepair {
  evolution: EvolutionRuntime
  roundId: string
  evalId: string
  lock: WorkspaceLock
  abort: AbortController
  completion: Promise<EvaluationRerunResult>
  handedToDrive: boolean
}
```

registry 使用 `(evolutionId, roundId)` 作为 key。应先构造 job 和 completion，再放入 map，最后启动异步 repair body。map 登记必须发生在 durable transition 和 Hitch 调用之前，`dispose()` 才不会漏掉刚获得 lock 的 repair。

repair body 顺序：

1. 完成第 5.4 节的所有只读验证；
2. 单次原子 `writeRound`：round → `repairing-evaluation`，目标 attempt → `rerunning`，清除旧 `completedAt/failure`，清除 round failure；
3. 将 job 的 `abort.signal` 传给 evaluator `rerun()`；
4. 验证 rerun envelope 的 provider/eval identity；
5. 从 `eval inspect` 读取 frozen plan，验证完整 evidence 的 condition/dataset/commit identity，并验证计划内每个 `(task, attempt)` slot 在 `1..repetitions` 中恰好出现一次；
6. 原子写入 repaired evidence、目标 attempt `repair-completed`、`completedAt` 和 round-level `evaluationRepairResume`，形成 durable pending-resume intent；
7. durable write 返回后同步检查 `disposed` 和 repair abort signal；关闭已开始时保留 pending-resume intent、释放 lock 且不创建 drive，否则用同一 lock 创建带 `repairAttempt` identity 的 `ActiveRound`；
8. resumed drive 的第一次 durable transition 只把 round 改为 `baseline-running`，保留 `evaluationRepairResume + repair-completed`；后续 transition 同样保留，直到形成 commit intent 或明确 terminal 时才原子 settle attempt 并删除 intent；
9. handoff 后 repair job 不再释放 lock，最终由 `drive()` 释放。

步骤 2 后、步骤 6 前发生异常时，repair body 必须在同一次 failure write 中把 round 和目标 attempt 都改回 `failed`。步骤 6 完成后不得删除 evidence；dispose/abort 或 hard restart 保留 pending-resume intent，明确的非取消 drive failure 才在原子 failure write 中 settle attempt 并删除 intent。错误 code 优先保留 evaluator error code；无 typed code 时使用 `evaluation_rerun_failed`。Hitch 返回 remaining invalid trials 时，failure details 应保留 task 和 attempt。

如果 resumed drive 被 dispose/abort，它必须保留 intent 和 evidence，不得把 round 降级为不可恢复的 failed state。如果发生非取消 drive failure，则根据 intent identity 把 `repair-completed` attempt 原子改为 `settled`、删除 intent 并把 round 标为 resume failure；完整 evidence 不得与 failed attempt 组合。

### 5.6 Dispose 语义

`dispose()` 顺序：

1. 设置 `disposed = true`，阻止新 round 和 repair admission；
2. abort 所有 `ActiveRound` 与 `ActiveEvaluationRepair` controller；
3. reject/cancel candidate finalization；
4. `Promise.allSettled()` 等待当前 drives 和 repair completions；
5. 等 job/drive 的 `finally` 完成后释放残余 lock、清空 maps；
6. 最后 dispose Meta runtimes。

Hitch 子进程沿用现有 SIGTERM → `terminationGraceMs` → SIGKILL 行为。`dispose()` 只有在当前 Harbor shard exit、repair promise settle 且 durable failure state 写完后才可 resolve。未启动的后续 attempt shards 不得启动。

repair 从 `repair-completed` durable write handoff 到 `ActiveRound` 的临界区不得包含 `await`。write 返回后的关闭检查与 `active.set()` 必须同步连续执行：若 dispose 已设置标记或 abort repair，保留 `repair-completed` 供下次启动恢复；若 dispose 在 `active.set()` 之后开始，则它必须能在 active scan 中看到并取消该 drive。

`ActiveRound.abort` 还必须作为整个 drive 的父取消信号：drive 在恢复入口、阶段边界和 commit 前检查该 signal，新建 candidate execution 时把它与 execution-local signal 组合。dispose 扫描 active 后不得再启动新的 candidate execution、Meta wake 或 population/champion commit；只要尚未形成 commit intent，就保留 `evaluationRepairResume + repair-completed` 供下次启动恢复。

因 dispose 终止的 rerun 记录为可重试的 attempt `failed`，建议 code `evaluation_rerun_aborted`，message 保留 `RefineService disposed`。

### 5.7 Startup recovery

`initialize()` 必须先识别 durable pending-resume：

- 任意 non-terminal、无 decision/commit intent round 中的 `evaluationRepairResume + repair-completed + matching evidence`：保留状态并重建持有同一 round lock 的 `ActiveRound`；
- 旧版本可能留下的 `repairing-evaluation + repair-completed/rerunning + matching evidence`：单次原子写补齐 `evaluationRepairResume`，随后按上一条继续；
- pending resume 恢复必须验证 intent/attempt/evidence identity；archived evolution 保留 intent 但不得启动 drive；
- 若 pending resume round 同时存在另一个中断的 `running/rerunning` attempt，必须 settle 已完成 repair、把中断 attempt 与 round 原子标为 failed，交由相同 eval identity 的下一次 repair 处理，不能静默启动重复 benchmark。

存在多个 pending resume 时，`initialize()` 必须先为它们全部获取 runtime/lock 并登记 active，全部成功后才能启动任何 drive。中途失败必须释放此前已登记的 active/lock 并 dispose 已创建的 runtime，不能在插件初始化失败后留下后台 drive。

对其余无 commit intent 的非 terminal round，必须先生成完整 next-round value，再用单次 `writeRound()` 原子替换：

- round status → `failed`；
- round failure phase → `recovery`；
- 每个 `running` attempt → `failed`，补 `completedAt` 和 `evaluation_interrupted_by_restart`；
- 每个没有 matching evidence 的 `rerunning` attempt → `failed`，补 `completedAt` 和 `evaluation_rerun_interrupted_by_restart`；
- `repair-completed` 只能由 matching `evaluationRepairResume` 或上述 legacy migration 路径处理；已 terminal 的 `settled`、`failed`、`cancelled` attempt 保持不变。

恢复写入必须幂等：第二次 `initialize()` 不得改写已恢复 attempt 的 code/timestamp。

round 有 `commitIntent` 时仍先执行 commit reconciliation，绝不能把它转换为普通 repairable evaluation failure。

### 5.8 Seed candidate failure

candidate seed evaluation 的局部 catch 仍可把单个 candidate 标为 `failed`，让其他 candidate 继续评测。selection 前必须区分：

| 条件 | Round 结果 | Batch 行为 |
| --- | --- | --- |
| `selectable >= survivors` | 正常 selection/promotion | 正常 |
| `selectable < survivors`，且至少一个缺失 candidate 有可修复 failed Hitch `seed-candidate` attempt | `failed`，无 decision/commitIntent | 暂停 |
| `selectable < survivors`，且不存在可修复 attempt | `rejected` + `decision: no-change` | 可继续下一 round |

可修复 seed-candidate attempt 至少要求：

- provider 是 `hitch-cli`，status 是 `failed`，phase 是 `seed-candidate`；
- owner candidate 仍有与 attempt owner 相同的 sealed commit；
- candidate 尚无完整 seed evidence；
- round 尚无 decision/commitIntent。

failed round 的 failure message 应列出可修复 eval IDs。不得在此路径写 population、champion 或 commit intent。

repair 成功后，`repairedEvidencePatch()` 把 candidate 恢复为 `evaluating`，清除 candidate failure/derived comparison/metrics。resumed drive 必须复用 repaired seed evidence，重新计算 parity、paired trials、required regressions 和 judges，再执行 selection；只有满足原 promotion policy 时才进入 held-out/promotion。保留原 batchId、roundIndex 和 roundCount。

### 5.9 Status 与可发现性

`PublicRoundStatus` 增加 additive 字段：

```ts
repairableEvaluations?: Array<{
  provider: 'hitch-cli'
  evalId: string
  phase: EvaluationPhase
  candidateId: string
  repetitions: number
}>
```

只有满足第 5.4 节 durable eligibility 的 failed attempts 才出现。`/refine status <evolution-id> <round-id>` 因而能给出下一条 rerun 命令所需 identity。

Gear 的 `EvaluationRerunResult` parser 应接受 Hitch 新增的 slot arrays，并把 remaining invalid `{task_id, attempt}` 保留在 typed failure details；task-level 字段继续兼容。

命令帮助、README 和安装指南必须说明：

- 需要 `agent-hitch >= 0.2.5`；
- repetitions/`hitch.attempts` 可以是任意正整数；
- `--invalid` 修复所有 invalid/missing slots；
- `--task foo` 修复 foo 的所有 invalid/missing attempts；
- v0.2.4 创建的 multi-attempt eval 必须新建 eval，不能原地 repair；
- round stale、已有 decision 或已有 commit intent 时不能 repair。

## 6. 失败语义

| 场景 | 结果 | 是否可重试 |
| --- | --- | --- |
| Gear 发现 Hitch 版本过低/未知 | Gear 启动失败，无 round mutation | 升级后重启 |
| Hitch 发现 legacy v0.2.4 multi-attempt plan | 不改 progress，不调用 Harbor | 不能原地修；新建 eval |
| Hitch attempt shard 失败 | 保留已发布 slots，其余 invalid/missing | 是 |
| Hitch rerun 后仍有 invalid/missing slots | `eval_status=failed` 并返回 slot details | 是 |
| Gear 验证 repaired evidence 不完整或 identity 不匹配 | round/attempt 均 `failed` | 修复外部状态后可重试 |
| Gear dispose 中止 rerun | round/attempt 均 `failed` | 重启后是 |
| hard restart 中断 rerun | initialize 原子恢复为 round/attempt `failed` | 是 |
| Gear round parent population/champion 已变化 | 不修改旧 round | 否；创建新 round |
| Gear round 已有 commit intent | 只走 commit recovery | 否 |

## 7. 代码改动范围

### 7.1 agent-hitch

| 文件 | 需要的改动 |
| --- | --- |
| `src/evals/service.ts` | 写 execution marker；initial eval 按 logical attempt 串行分 shard；从完整 progress 生成 result |
| `src/evals/rerun.ts` | plan compatibility、slot selector/grouping、multi-shard rerun、slot-level output、partial repair durability |
| `src/evals/progress.ts` | logical slot duplicate guard 与 replacement invariants |
| `src/evals/trial-import.ts` | `expectedAttempt`、bundle identity validation、diagnostic attempt |
| `src/backends/harbor/backend.ts` | `logicalAttempt` option、`n_attempts=1` shard config、bridge kwargs |
| `integrations/harbor/hitch_harbor_agent.py` | 显式 `logical_attempt` validation/propagation，不从随机 suffix 推断新 eval |
| `src/domain/eval-records.ts`、rerun result types | additive slot result type；必要的 backend run diagnostics |
| `docs/evals.md`、CLI help、changelog/package version | multi-attempt 语义、legacy 限制、发布 v0.2.5 |
| `test/evals.test.ts`、`test-support/bridge_smoke.py` | plan/progress、shards、selector、partial failure、bridge identity、legacy compatibility tests |

### 7.2 Gear

| 文件 | 需要的改动 |
| --- | --- |
| `src/refine/service.ts` | active repair registry、eligibility helper、repair/handoff、dispose 等待、startup recovery、seed-candidate repairable 终结、status projection |
| `src/evaluator/hitch-cli.ts` | `>=0.2.5` preflight/cache；解析 additive slot arrays；所有 evaluation 继续使用预留 `--eval-id` |
| `src/types.ts` | optional evaluator preflight、slot rerun details、additive `repairableEvaluations`；无需改变 persisted round schema |
| `src/index.ts` | 插件启动 preflight、rerun help/error 文案 |
| `src/state/store.ts` | 如需要，仅加强 recovery 后 attempt lifecycle 校验；不做破坏性 migration |
| `tests/unit/refine-service.spec.ts` | repair lifecycle、seed-candidate、dispose、restart、multi-attempt、stale-state tests |
| `tests/unit/hitch-cli-evaluator.spec.ts` | version probe、旧版本拒绝、新 result parse、无 fallback、abort tests |
| `tests/unit/command-input.spec.ts` | rerun usage/help 与 selector validation |
| `README.md`、`docs/plugin-installation-and-usage.md` | 最低 Hitch 版本、multi-attempt 语义、status/rerun runbook |

## 8. 必须新增的测试

### 8.1 agent-hitch

1. **initial eval attempts=3 uses explicit shards**
   - 写入 `attempt_execution: harbor-attempt-shards-v1`；
   - 生成三个串行 Harbor configs，每个 `n_attempts=1`；
   - logical attempts 分别为 1、2、3，planned trials 为 `tasks * 3`；
   - 全局并发不超过 request `max_concurrent`。

2. **bridge preserves explicit attempt with random Harbor name**
   - random suffix trial 在 `logical_attempt=2` 时，run parent、metadata 和 imported ref 都是 attempt 2；
   - bundle/expected attempt mismatch 被拒绝。

3. **progress validates logical slots**
   - duplicate `(task,attempt)`、范围外 attempt、duplicate trial/run identity 均失败；
   - missing slot 合法存在于 running/failed progress；
   - valid slot 不可被 replace。

4. **selector expands task to invalid attempts**
   - task A 的 attempt 1 valid、2 invalid、3 missing；
   - `--task A` 只选择 A/2、A/3；
   - `--invalid` 选择全计划的 invalid/missing slots。

5. **multi-attempt rerun preserves valid evidence**
   - rerun 前保存 valid refs 的 run IDs、rewards、verifier refs；
   - 按 attempt 分组生成精确 task lists；
   - rerun 后旧 valid refs byte-for-byte 不变，仅目标 slots 替换。

6. **partial shard failure is resumable**
   - attempt 2 shard 成功、attempt 3 shard 失败；
   - attempt 2 replacements 已 durable；
   - 下一次 rerun 只选择 attempt 3 的 remaining slots。

7. **output is backward-compatible and slot-aware**
   - task arrays 是 slot arrays 的稳定去重投影；
   - all slots valid 才返回 `eval_status=succeeded`。

8. **legacy compatibility**
   - v0.2.4 attempts=1 plan 可 rerun；
   - 无 execution marker 的 attempts>1 plan 在任何 Harbor 调用前稳定失败；
   - unknown marker 与 corrupt progress fail closed。

9. **abort/lock across shards**
   - abort 当前 shard 后不启动后续 shard；
   - rerun lock 直到 cleanup/state write 后才释放。

### 8.2 Gear RefineService

1. **seed-candidate invalid → repair → round continues**
   - candidate shortage 后 round 为 `failed`，不是 `rejected/no-change`；
   - population/champion/commitIntent 未变化；
   - status 暴露相同 evalId；
   - rerun 后 candidate 恢复并进入原 selection/held-out/final decision。

2. **multi-attempt repair succeeds**
   - frozen repetitions 为 2；
   - failed evidence 只缺一个 `(task,2)`；
   - Gear 不在 mutation 前拒绝；Hitch 使用同一 evalId 修复；
   - repaired evidence 每个 task 恰有两个 attempts，paired evidence/parity 正常。

3. **multi-attempt evidence fails closed**
   - frozen repetitions 为 2；
   - succeeded result 分别缺少 slot、重复 slot、包含 attempt 3；
   - Gear 根据 inspected frozen plan 全部拒绝，evidence 不进入 round。

4. **single-attempt evidence 同样 fails closed**
   - frozen repetitions 为 1；
   - succeeded result 分别缺少 planned task、重复 slot、包含 attempt 2；
   - Gear 仍读取 frozen plan 并全部拒绝。

5. **dispose aborts and waits for rerun**
   - fake rerun 阻塞并观察 signal；
   - `dispose()` abort 后必须等待 fake evaluator settle；
   - 最终 round/attempt 均 `failed`，lock 可再次获取。

6. **dispose blocks post-write repair handoff**
   - 阻塞 `repair-completed` durable write，并在 write 返回前启动 dispose；
   - repair completion settle 后 dispose 有界完成，不出现新的 active drive；
   - round 保留 `evaluationRepairResume + repair-completed + evidence`，lock 已释放，供下次启动恢复。

7. **dispose cancels and restarts an already handed-off drive**
   - active 已登记，且 resumed drive 的 `baseline-running` durable transition 已完成；
   - dispose 后不得创建 candidate execution，且保留 `evaluationRepairResume + repair-completed + evidence`；
   - dispose 有界完成并释放 lock；新 service initialize 后继续原 round，直到 commit/terminal 才 settle attempt 并删除 intent。

8. **restart distinguishes interrupted and completed repair**
   - 构造无 evidence 的 `repairing-evaluation + rerunning`，initialize 后 round/attempt 均 `failed`，含 recovery codes；
   - 分别构造 `evaluationRepairResume + repair-completed + evidence`、legacy `repair-completed + evidence` 和 `rerunning + evidence` 崩溃快照；
   - initialize 不抛错，legacy 快照先原子迁移，随后继续 drive；处理中 attempt 保持 `repair-completed`，commit/terminal 时才 `settled`；
   - evidence identity 和 evalId 保持不变，不再调用 Hitch rerun。

9. **startup pending resume preparation is all-or-nothing**
   - 构造两个 pending resume，并让第二个 runtime 初始化失败；
   - initialize 失败后第一个不得启动 drive，所有 active/lock/runtime 都已清理；
   - durable pending resume intent 保持不变。

10. **non-repairable candidate shortage remains no-change**
   - candidate generation/compiler 失败但没有 failed Hitch attempt；
   - round 仍为 `rejected/no-change`。

11. **stale or committed round cannot reopen**
   - parent population changed、champion changed、commitIntent exists 均无 mutation、无 Hitch call。

12. **same round permits only one repair job**
   - 两个并发请求仅一个进入 evaluator，另一个稳定失败；不泄漏 lock/job。

13. 保留 baseline rerun success，并补 held-out 与 seed-candidate regression，证明四种 phase 共用 identity guard。

### 8.3 Gear HitchCliEvaluator

1. `agent-hitch 0.2.5` 和更高版本通过 preflight。
2. `0.2.4`、prerelease、不可解析输出、非零退出和 executable missing 均在启动阶段失败。
3. compatibility 失败时没有任何 `eval run` 调用。
4. 普通 evaluation 只调用一次 Hitch且始终包含预留的 `--eval-id`，不存在删参 fallback。
5. parser 接受 task-level 与 slot-level rerun arrays，并保留 remaining invalid slot details。
6. rerun 收到 abort 后对子进程执行 TERM/KILL lifecycle 并拒绝原 promise。

### 8.4 全量验证

Hitch：

```sh
npm run typecheck
npm test
npm run build
```

Gear：

```sh
npm run typecheck
npm test
npm run build
```

测试不得依赖真实 Harbor/Docker；使用可控 fake executable 和 bridge smoke fixtures。另增加一个可选、非 gating 的真实 Harbor smoke，确认随机 trial suffix 下 logical attempts 仍正确。

## 9. 交付顺序

1. 在 agent-hitch 实现第 4 节合同与测试。
2. 发布 `agent-hitch v0.2.5`，确认 npm/package metadata、tag 和 changelog 一致。
3. 在 Gear 将最低版本提升到 `>=0.2.5`，实现 active repair/state recovery/seed-candidate 修复。
4. 用 v0.2.5 fake + integration fixture 验证 Gear multi-attempt repair。
5. 更新两仓文档和命令帮助。
6. 两仓 typecheck/test/build 全绿后再更新 PR review 状态。

## 10. 合并验收标准

全部满足后，Gear PR 才可从 `Request changes` 转为可合并：

- Hitch 使用显式 logical attempt，不依赖 Harbor random suffix；
- attempts=2+ 的 invalid/missing slot 可修复，valid slots 不被覆盖；
- partial multi-shard failure 可从 durable progress 继续；
- v0.2.4 legacy multi-attempt eval 明确 fail closed；
- Gear service dispose 或 hard restart 后不存在永久 `repairing-evaluation/rerunning`；已完成 repair 的 pending-resume 能继续 drive；
- durable `evaluationRepairResume` 覆盖 resumed drive 的全部无 commit intent 阶段，首次 transition 后崩溃或 dispose 不会丢失恢复能力；
- archived evolution 不启动 repair，rerun eligibility 同时校验完整 champion ref/manifest identity；
- Gear 对 Hitch inspection request/plan 的 dataset、benchmark、candidate commit/revision 和 logical-attempt execution identity fail closed；
- seed-candidate invalid task 可通过公开命令修复并继续原 round；
- Gear 启动时明确拒绝 Hitch `<0.2.5`；
- multi-attempt repair 在任何 state mutation 前不再被 Gear 拒绝；
- repair 不可跨 population/champion/commit boundary 重开历史 round；
- 两仓新增测试、typecheck 和 build 全部通过；
- README、安装指南、Hitch eval docs 和命令帮助与实际合同一致。

# Continue / Resume：基于 Champion 与已有基线继续迭代的修复规范

- 状态：Proposed v1；实现与验收合同，不表示功能已交付。
- 日期：2026-09-06。
- 代码基线：Gear `1370e9af8be5f76ba0e1b5856c5b8a1e83f150d3`。
- 范围：Gear 迭代状态、Hitch 评测身份与证据复用、Meta 上下文交接、控制协议、迁移及状态展示。
- 需求依据：追加轮次和恢复具有相同的优化语义，均从已经存在的 champion、对应基线与研究记录继续迭代。
- 本文的 MUST / MUST NOT 为必须满足的要求；文中新增类型、字段、方法及能力标识均为拟议合同。

## 1. 决策与边界

2026-09-12 兼容说明：本文的 champion 作为唯一代码父代约束继续适用于旧模式。显式启用 `failure-cluster-gepa-v1` 的新 evolution 使用[专长 archive 规范](candidate-promotion-and-specialist-archive-spec.zh-CN.md)选择实际代码父代，champion 独立冻结为发布比较 anchor；基线身份、恢复与 held-out 隔离要求继续适用，不迁移历史实验。

统一迭代起点为：

```text
IterationHead = 当前 champion + 对应基线证据引用 + 可继承的研究记录
```

1. `continue` 与 `resume` MUST 使用同一个起点解析和阶段恢复实现。两者仅在轮次管理上不同：追加增加待执行轮数，恢复接续尚未完成的轮数。
2. 新轮次的所有候选 MUST 从当前 champion 生成。未晋升候选可以保存为研究记录，但 MUST NOT 成为后续轮次的隐式父版本。
3. 基线 MUST 绑定 harness 版本与评测条件，不绑定 round、batch、Meta session 或某次进程启动。
4. 已有可用基线 MUST 复用。新建 round、重新启动控制面、恢复 Meta、切换评测角色，都不是重新评测的理由。
5. 候选晋升时，champion 与该候选已经产生的基线证据引用 MUST 一起提交。下一轮不得再次评测刚晋升的同一个版本来建立基线。
6. 候选未晋升时，champion 及其基线 MUST 保持不变；记录本轮研究结果后，后续候选仍从该 champion 出发。
7. 身份无法验证时 MUST 阻塞并说明原因，不得把“无法判断能否复用”静默转换成完整重跑。
8. 暂停和恢复 MUST 保留已完成阶段、有效 trial、封存候选、诊断记录和已用预算。恢复不等于创建空白 round。

本规范确定的是 **champion 驱动的迭代合同**。现有 population 探索算法可以保留历史和独立实现，但不作为本合同下 `continue` / `resume` 的父版本来源。本次不重设计多样性搜索，也不改变任务评分公式、晋升门槛或 held-out 隔离规则。

## 2. 当前实现与缺口

| 当前入口 | 当前行为 | 本次修复 |
| --- | --- | --- |
| [continueEvolution](../src/refine/service.ts) | 校验封存配置后直接创建新 batch / round | 先解析共同 IterationHead 和可复用阶段；追加与恢复共用核心 |
| [newRound / queueContinuation](../src/refine/service.ts) | 从 population 分配父版本 | champion 合同下父版本必须是 round 固定的 champion |
| [findReusableBaseline](../src/refine/service.ts) | 已支持将历史候选评测作为基线，但依赖 evaluator 提供身份 | 将证据引用挂在 IterationHead；历史查找用于初始化与迁移 |
| [HitchCliEvaluator.evaluationIdentity](../src/evaluator/hitch-cli.ts) | 标准 benchmark 或 daemon 模式直接返回 undefined，跳过复用 | 增加不执行任务的计划解析，返回可验证身份或明确阻塞原因 |
| [nextPopulation / RoundCommitIntent](../src/refine/service.ts) | 新候选可以晋升失败但仍替换研究种群；champion 不含基线指针 | 种群不再决定本合同的父版本；原子提交 champion 和基线 |
| [SkillMetaSessionManager](../src/meta/skill.ts) | checkpoint 保存逻辑会话身份，eventCount 为 0 | 显式交接研究记录，区分谱系与真实宿主历史继承 |
| [RefineSkillGateway](../src/skill/gateway.ts) | 有 continue/rerun，无完整 pause/resume 协议 | 增加暂停意图、可恢复阶段、幂等恢复与清理确认 |
| [启动恢复](../src/refine/service.ts) | 普通未完成 round 多被归为 failed | 恢复时对账外部工作并保留阶段，禁止自动重置到基线执行 |

现有测试同时证明：核心服务支持“晋升候选评测直接成为下一轮基线”，Hitch adapter 又明确测试了“标准 benchmark 禁止提前复用”。必须打通这两个层次，而非仅删除一个条件分支。

## 3. 不变量

| ID | 必须成立的条件 |
| --- | --- |
| INV-01 | round 的 parentHarnessRef 等于该 round 固定的 champion ref |
| INV-02 | baseline 的 harness ref、manifest 和评测语义身份与其 champion 一致 |
| INV-03 | 相同可用基线的 continue/resume 不启动 baseline Target rollout |
| INV-04 | 角色从 seed-candidate 变为 seed-baseline 不改变原始 run、reward 或证据身份 |
| INV-05 | champion 晋升与新基线引用不存在可见的混合状态 |
| INV-06 | 未晋升候选不能改变下一轮父版本 |
| INV-07 | pause/resume 不抹去已完成阶段，不重复消费轮次或提交操作 |
| INV-08 | missing、invalid 与有效低分是三种不同状态；有效零分不得被当成补跑对象 |
| INV-09 | 旧证据、旧决定与旧 spec 均不可被覆盖以伪造兼容或完整性 |
| INV-10 | held-out 内容、任务身份、轨迹和分数不进入 Meta 的研究上下文 |
| INV-11 | 同一 evolution 同时只有一个推进写者；取消完成前不能派发下一阶段 |
| INV-12 | 继承研究上下文必须有实际可读取的内容，不能仅以 session ID 或 lineage 作为完成证明 |

## 4. 状态模型

### 4.1 不可变证据引用与迭代起点

以下为概念类型，实现必须配套运行时校验、版本化序列化和内容摘要。

```ts
interface EvidenceSnapshotRef {
  provider: string;
  evalId: string;
  snapshotDigest: string;
}

interface BaselinePartition {
  conditionDigest: string;
  requiredSlotsDigest: string;
  evidence?: EvidenceSnapshotRef;
  availability: 'complete' | 'partial' | 'missing' | 'blocked';
  coverage: { planned: number; valid: number; invalid: number; missing: number };
}

interface IterationHead {
  schemaVersion: 1;
  evolutionId: string;
  specDigest: string;
  revision: number;
  champion: { ref: string; manifestDigest: string };
  baselines: {
    seed: BaselinePartition;
    heldOut: BaselinePartition;
  };
  researchContextRef?: { id: string; digest: string };
  sourceRoundId?: string;
  digest: string;
}
```

- `digest` 为排除自身后的规范化内容摘要。
- 证据仍由 Hitch 持有；Gear 保存经验证的不可变快照引用及投影，不复制出另一套可修改分数。
- seed 与 held-out 的基线绑定都属于控制面内部状态。Meta 只获得 seed 投影。
- 原有 champion 文件可以保留为兼容投影，但不得与 IterationHead 形成两个独立写入权威。
- bootstrap 可以有 missing 基线；缺失基线必须在相关阶段按第 5 节建立。缺失不能伪装成空数据或零分。
- 每个 round 保存 `parentHeadRevision`、`parentHeadDigest`、`parentHarnessRef` 和实际使用的基线快照，固定本轮比较对象。

### 4.2 批次与执行状态

轮次的业务阶段与执行状态 MUST 分开保存。

```ts
interface BatchExecutionState {
  batchId: string;
  requestedRoundCount: number;
  completedRoundIds: string[];
  currentRoundId?: string;
  desiredState: 'running' | 'paused';
  executionState: 'ready' | 'running' | 'pausing' | 'paused'
    | 'interrupted' | 'blocked' | 'failed' | 'completed';
  pendingOperationId?: string;
}
```

- round 保留 `candidate-editing`、`candidate-seed-running` 等阶段；暂停不会把阶段改成“从头开始”。
- accepted、rejected、明确的 no-change 消费一个逻辑轮次。进程故障、中断和人工暂停不消费一个已完成轮次。
- substrate 不支持、不可修复证据、预算耗尽等必须停止调度并报告；不得通过新 round 静默重置预算来凑足轮数。
- `remainingRounds = requestedRoundCount - completedRoundIds.length`，同一个 terminal round 只能计入一次。
- batch 总轮数以批次账本为准；现有 round.roundCount 如保留，只作为创建时快照，不再作为可追加批次的唯一调度依据。

## 5. 评测身份、复用与补齐

### 5.1 先解析身份，再决定执行

Hitch MUST 提供不启动 Target trial 的计划解析能力。拟议 capability 为 `evaluation_plan_identity: 1`，具体 CLI 或 RPC 名称在实现时统一发布；本文不假设现有 `hitch eval plan` 已存在。

```ts
type EvaluationPlanResolution =
  | { status: 'resolved'; planRef: string; planDigest: string;
      harnessIdentityDigest: string; conditionDigest: string;
      slotsDigest: string; runtimeAudit: object }
  | { status: 'blocked'; code: string; reason: string; requiredAction: string };
```

该操作可以解析与验证不可变资源，但 MUST NOT 启动 Target 模型、Harbor task、任务容器或 benchmark verifier，也不能通过先 submit/run 再 cancel 来获得身份。

身份必须分成两层：`HarnessIdentity` 固定具体 commit 与 manifest，`ConditionIdentity` 固定任务、模型和执行/评分条件。`reusableEvaluationKey = digest(HarnessIdentity, ConditionIdentity)`。基线复用比较完整 key；baseline/candidate 的配对比较只要求 ConditionIdentity 相同，允许它们的 harness 不同。不得把候选 commit 混入 conditionDigest，导致两个版本无法比较。

组合身份至少覆盖：

- 具体 harness commit、manifest 及固定 substrate / toolchain；
- 数据集内容、实际任务集合、partition 和逻辑 `(taskId, attempt)` slots；
- Target provider/model、实际采样参数和已解析默认值、重复次数及已配置随机种子；
- adapter/compiler 的任务运行语义、任务环境与初始化快照、verifier 和评分合同；
- 任务超时、sandbox 及实际影响结果的执行策略。

roundId、batchId、evolutionId、候选/基线角色、Meta session 和纯审计路径 MUST NOT 作为禁止复用的语义差异。Meta 模型与研究选择策略仍受实验身份校验，但不是 Target 评测缓存键。宿主 PID、安装位置和不改变执行结果的日志配置仅进入审计。

不得仅因二进制摘要变化就认定评测语义必然变化，也不得自行假设新旧 runtime 兼容；兼容性由版本化 provider 合同证明。对可变外部环境无法形成可靠身份时，返回 blocked。

daemon 默认策略必须在此阶段解析并固定；后续实际执行必须引用同一计划或重新验证摘要。发生变化时返回 `EVALUATION_PLAN_CHANGED`，不得“查旧配置缓存、按新配置执行”。

### 5.2 决策表

| 已有证据情况 | 默认行为 | 允许的新增评测 |
| --- | --- | --- |
| 条件一致，证据完整且所需轨迹/验证材料可访问 | 直接绑定原证据 | 0 个 baseline trial |
| 条件一致，有 valid slots，也有 invalid/missing slots | 保留有效 slots，仅补齐缺口 | 只执行缺口 |
| bootstrap 或确实没有同版本基线 | 建立基线并记录原因 | 缺失的全部 slots |
| 分数有效，但诊断材料缺失/损坏 | 尝试恢复证据读取；无法恢复则 blocked | 不自动重跑有效任务 |
| 条件无法解析或无法验证 | blocked，返回具体原因 | 0 |
| 数据集、模型或评分语义不再符合封存 spec | 拒绝继续，要求明确的新实验配置 | 0 |
| 显式要求重新采样 | 独立 refresh 操作与新证据快照 | 按明确指定的范围执行 |

seed 基线在进入 Meta 生成前要求完整有效，延续当前完整基线要求；partial 基线通过补齐而非全量重跑达到该状态。held-out 基线在需要晋升比较时才补齐，不阻塞纯 seed 诊断。既有 partial 晋升决定保持历史事实，不被追溯撤销或改分。

本次不自动改变 candidate 的 partial 配对及晋升门槛。若候选以 partial 证据晋升，其快照照实进入新 head；下一轮按上述规则补齐所需的基线缺口。

### 5.3 证据绑定和补齐合同

1. 优先使用 IterationHead 已绑定的证据，不按历史最高分选择样本。
2. 初始化或迁移尚无 head 引用时，先使用 champion 的实际晋升来源评测。其他历史查找必须有确定的、与分数无关的选择顺序，记录来源和原因。
3. 同一份 `seed-candidate` 证据可绑定为新 round 的 `seed-baseline`。只新增消费关系，不修改原 eval 的 phase、owner、时间戳或结果。
4. 新增 `baselineBinding` 记录来源 round/eval/snapshot、用途、验证身份及复用原因；复用不伪造一次真实执行的 evaluation attempt。
5. 补齐选择依据为冻结计划的 invalid/missing slots，不依据 reward。有效零分属于完整证据。
6. 已有 failed eval 若符合现有 `rerun` 合同，可使用该入口。已经 settled 的 partial 证据不得通过改状态绕过现有限制。
7. 对 settled partial，Hitch 需提供版本化的证据补齐能力：保留原不可变快照，执行缺口，产出新的派生快照及完整来源映射。可以采用独立补齐 eval；不得覆盖被旧决定引用的快照。
8. 新快照对每个逻辑 slot 恰好绑定一个有效来源。已有 valid runId、reward、轨迹摘要保持不变；重复、越界或身份不一致的 slot 必须拒绝。
9. 基线补齐导致 head revision 变化时，必须在同一个受保护的恢复意图中更新当前 round 的锚点。已有候选的父 commit 不变；若 seed 证据扩大了诊断要求，提交前补齐新增失败 run 的诊断。
10. refresh 必须明确记录采样目的及新快照替换关系；不得择优挑选多次重跑中分数较高的一份作为基线。

## 6. 追加与恢复共用的流程

内部新增统一入口 `advanceEvolution()`；追加与恢复不得分别维护两套基线和候选生成路径。

```text
接收幂等操作请求
  -> 获取 evolution 推进锁
  -> 校验 spec、Meta 身份、当前 head 与待恢复批次
  -> 对账未完成提交、真实外部工作和阶段产物
  -> 根据 append / resume 更新待执行轮次
  -> prepareIterationContext(head, durable round state)
       -> 绑定已有基线 / 仅补齐缺口 / 明确阻塞
       -> 恢复研究记录和已完成阶段
  -> 从第一个未完成阶段执行
  -> 原子提交本轮结果
  -> 若有剩余轮次，读取新 head 并重复
```

### 6.1 控制协议

| 方法 | 请求要点 | 行为 |
| --- | --- | --- |
| `control.planContinue`（新增） | evolutionId、intent: append/resume、append 时 rounds | 只解析计划和复用决策，不执行评测 |
| `control.continue`（扩展） | evolutionId、rounds、requestId | 追加 N 轮，通过共同入口推进 |
| `control.resume`（新增） | evolutionId、可选 batchId、requestId | 继续原有剩余轮次，不增加轮数 |
| `control.pause`（新增） | evolutionId、可选 batchId、requestId | 持久化暂停意图，停止调度并等待清理 |
| `control.status`（扩展） | 原有查询参数 | 返回 head、轮次账本、复用决定及执行/清理状态 |

- `control.continue` 本身必须调用相同的计划解析逻辑，不要求用户每次先手动调用 preview。
- `requestId` 绑定方法和规范化请求体；重发同一请求返回同一结果，不能重复追加轮次。相同 ID 携带不同内容必须报错。
- 无未完成 batch 时，append 创建新 batch；有未完成 batch 时，append 将 N 加入该 batch 的剩余工作，不创建并行批次。
- 对 paused batch 调用 append 表示恢复并追加；响应必须明确显示原剩余数、新增数及合计，不能只报告 N。
- resume 没有待恢复工作时返回 `nothing-to-resume`，不得新建一轮。resume 不接受 rounds 参数。
- 同一 evolution 有多个遗留未完成 batch 时，必须先显式定位待恢复对象，不能任选一个。
- 不可修复失败或预算耗尽时，追加不能绕过阻塞去启动另一批工作。
- focus 仅作用于尚未创建的新轮次。已有 round 的 focus、父版本和评测条件不得在 resume 中偷偷替换。

### 6.2 按阶段恢复

| 中断位置 | 恢复动作 | 禁止动作 |
| --- | --- | --- |
| 尚未生成候选，champion 有完整基线 | 直接向 Meta 提供该基线 | 重跑同版本基线 |
| 正在补齐基线 | 对账已完成 slots，只接续缺口 | 丢弃有效 slots 重开完整 eval |
| 候选编辑中 | 验证保存的 diff、工作区和研究记录；重新绑定有效 lease | 在丢失编辑后假称无缝恢复 |
| 候选已封存，尚未评测 | 使用相同 commit 进入候选评测 | 重新生成候选或重复提交 |
| 候选 seed / held-out 评测中 | 先接管可验证的现存工作，或在清理后修复缺口 | 同一 slot 的旧任务仍运行时启动重复任务 |
| seed 已结算，等待 held-out | 保留 seed，按晋升阶段继续 | 重新跑 seed 或重新让 Meta 修改已封存候选 |
| 晋升提交中 | 幂等完成或对账同一 commit intent | 再做一次选择、改候选或重新计算旧分数 |
| 本轮已完成，下一轮未创建 | 计数一次，从当前 head 创建下一轮 | 重复消费已完成轮次 |

恢复旧候选的前提是其父版本与原 round 锚点一致。若 head 被另一个已提交操作改变，返回 `ITERATION_HEAD_CONFLICT`，不得把候选自动换父或继续相对旧 champion 晋升。

候选编辑必须具备持久化恢复依据：每次向 Meta 返回成功的 write/edit/remove，都要对应已保存的变更记录或候选快照及摘要。暂停前完成检查点写入，不能先删除工作区再尝试提取 diff。崩溃后可从原 champion 重建工作区并重放已经确认的变更，但必须重新验证可编辑根目录和最终内容摘要；无法证明一致时返回 `RECOVERY_ARTIFACT_UNAVAILABLE`。恢复后签发新 lease、重新读取 observation digest；旧 lease 和旧文件观察不可直接重放。compiler 检查只有在候选内容及工具链身份都一致时可复用，否则重新运行 compiler，不因此启动 benchmark。

## 7. 候选选择、晋升与原子提交

### 7.1 父版本与研究选择

- `maxCandidates > 1` 时，本轮多个候选均从同一个固定 champion 生成；每个候选使用独立工作区和 lease。
- selector 可以选择本轮 finalist 和保留研究记录，但其 survivor 结果不控制下一轮生成父版本。
- 通过 seed 条件后才执行需要的 held-out 比较，沿用封存的晋升政策。
- 不通过晋升的候选及其 seed 证据可以帮助后续 Meta 避免重复错误，但只作为上下文；实际可编辑树仍从 champion 创建。

### 7.2 提交协议

扩展现有 `RoundCommitIntent` 为以 IterationHead revision/digest 为条件的提交：

1. 先固化候选 commit、证据快照、配对结果、研究记录和决定。
2. 写入 intent，包含 expectedHeadRevision、expectedHeadDigest、nextHead 和本轮计数变更。
3. CAS 提交单一权威 head：
   - accepted：champion 指向候选，基线引用指向该候选本轮已有的 seed / held-out 快照；
   - rejected / no-change：保留 champion 和基线，仅更新研究记录与轮次结果。
4. 幂等更新兼容投影和 batch completedRoundIds，最终确认 round 完成。

新证据必须先 durable，再发布引用。崩溃恢复不得出现“H1 champion + H0 baseline”，也不得在晋升 intent 未对账完成时派发下一轮。rejected 的研究记录更新可以增加 head revision，但不得改变其 champion/基线。

## 8. Meta 研究记录与会话交接

本修复不要求实现 SKILL.state，也不要求保存模型未公开的内部推理。独立的 [SKILL.state 规范](skill-state-implementation-spec.md) 保持其原有范围。

新增可版本化的 `ResearchContext`，至少包含：

- 父 champion 和实际使用的 seed evidence refs；
- 已提出的改进假设、候选改动摘要和对应文件引用；
- seed 评测支持或否定了什么、仍有哪些不确定性；
- 本轮已完成诊断的记录及可访问的原始证据引用；
- 中断时已完成的步骤、仍待执行的步骤和实际宿主 checkpoint 引用（若可用）。

协议要求：

1. assignment 返回可读取的研究上下文引用和摘要身份；新增读取能力复用 lease 和 evidence policy，不暴露主机私有路径。
2. 同一候选恢复时，宿主优先恢复已保存的实际会话；无法恢复时，加载研究记录和真实候选文件重建上下文，并报告恢复方式。
3. 跨候选/轮次时，宿主必须实际读取适用的研究记录，不能只创建一个新 session ID 后声称继承历史。
4. 区分 `history-fork`、`research-context-loaded` 和 `lineage-only`。最后一种不得被报告为研究上下文已恢复。
5. 研究笔记不是分数、授权、文件 digest 或诊断完成的权威。当前 lease 仍需绑定精确证据并满足 finalization readiness；已有笔记只有在证据一致且被实际读取时才可复用。
6. Meta 投影只含 seed 可见信息，不含 held-out 分数、任务、失败细节或推测性指导。完整晋升审计单独保存。

## 9. 暂停、取消清理与控制面重启

1. pause 先 durable 写入 `desiredState: paused` 和暂停意图，再停止新的候选、trial 和下一轮派发。
2. 对正在执行的 Meta 与 rollout 发出取消。直接模式和 daemon 模式都必须通过 evaluator 的受控取消/对账合同确认当前 eval，不依赖用户根据 PID 猜测进程。
3. 暂停过程可以先返回 `pausing`；只有调度已停止、活跃工作已退出或由 provider 确认停止、相关 lease 已释放，才能报告 `paused`。
4. 清理超时必须返回 `cleanup-pending` 及具体阻塞对象，不得报告全部停止；resume 在清理完成前不得派发同一工作。
5. 物理 Hitch eval 可以是 cancelled，逻辑 Gear round 仍保留原阶段及 paused 状态，不把人工暂停伪装成候选质量失败。
6. 重启后先读取 desiredState。paused 批次只能对账、收尾，不能自动恢复评测。
7. running 批次发生进程丢失时标记 interrupted，先识别尚存工作、已发布证据和未完成 intent，再执行同一恢复流程；不得无条件标记 failed 并另起基线。
8. 已用 Meta 请求/token/活动执行时间、生成 attempts 和真实 rollout 成本必须累计保留；暂停等待时间不计活动执行预算。恢复不能隐式重置封存预算。被取消的 Target trial 可能需要重启该 slot，这不等于恢复同一次模型调用。
9. pause 到达时若已经存在晋升 commit intent，必须先完成该本地提交对账，确定 head 和轮次计数，再停在 paused；不得为响应暂停而留下混合 head，也不得派发下一轮。

## 10. 可观测性与错误合同

状态至少提供：

```text
headRevision / championRef / parentHarnessRef
batchRequestedRounds / completedRounds / remainingRounds
roundPhase / desiredState / executionState / cleanupState
baseline.source = existing-head | promoted-candidate | imported | completed | bootstrap | refresh
baseline.action = reuse | complete-missing | evaluate-missing | blocked
baseline.sourceEvalId / sourceSnapshotDigest / sourceRoundId
baseline.validSlots / missingSlots / invalidSlots / plannedNewTrials
baseline.reasonCode
meta.contextRestoreMode / researchContextDigest
```

Meta/public seed 状态与 operator 审计必须分层；上述涉及 held-out 的详细字段不得直接加入 Meta 响应。

必须定义稳定错误码：

| code | 含义 |
| --- | --- |
| `BASELINE_IDENTITY_UNRESOLVED` | 当前评测计划身份不能在执行前验证 |
| `BASELINE_CONDITION_MISMATCH` | 旧证据与所需条件不一致 |
| `BASELINE_EVIDENCE_UNAVAILABLE` | 分数或诊断证据缺失、损坏或不可访问 |
| `EVALUATION_PLAN_CHANGED` | 解析后的计划与实际待执行计划不同 |
| `ITERATION_HEAD_CONFLICT` | round 固定起点与当前推进状态冲突 |
| `CONTINUATION_CONTRACT_UPGRADE_REQUIRED` | 旧实验不具备新迭代合同 |
| `RECOVERY_ARTIFACT_UNAVAILABLE` | 恢复所需候选编辑或上下文不可恢复 |
| `CLEANUP_PENDING` | 尚有未确认停止的外部工作 |
| `BUDGET_EXHAUSTED` | 剩余工作超出原有预算，不能靠恢复重置 |

unknown、missing 与 mismatch 不得统一折叠成“cache miss”。Hitch terminal result、真实 lease 和 Gear executionState 必须对账；旧 progress.json 的 running 标签不能覆盖已经 cancelled 的结果并误报仍在运行。

## 11. 兼容与迁移

### 11.1 实验合同版本

新实验封存 `iterationContract: champion-baseline/v1`，采用本规范。新增/变化的 generator、selection 状态含义及 Meta bundle identity 都必须进入新的 spec / component identity。

旧 evolution 的 population 语义属于已封存实验，MUST NOT 原地修改 spec.json、组件摘要或历史 round 来假装它一直执行 champion 合同。

迁移采用显式创建 **继承实验（successor evolution）**：

- 新 spec 引用来源 evolution、原 spec digest、实际 champion 和迁移计划摘要；
- 除本规范明确改变的迭代合同及相应实现身份外，原数据集、Target 模型/采样、任务预算和晋升参数保持不变；Meta 宿主与模型沿用用户已选配置，不读取新全局默认值替换它们；
- 原 evolution、历史决定、population、评测证据及失败记录保留；
- 从原 champion 建立新 head；验证一致的旧 Target evidence 直接导入为引用，不因 evolutionId、Meta skill 版本或父版本策略改变而重跑；
- 新实验准确封存实际 Meta runtime/model/sampling/bundle 身份；不得伪造旧 identity 来绕过校验；
- 若 Target 评测身份无法从旧冻结计划和证据中重建，则迁移报告 blocked，不补写猜测值；
- 迁移自身不执行评测，不自动恢复已暂停任务。迁移后保持 paused，待明确恢复操作。

新增 `control.planMigration` / `control.migrateContinuation`（拟议）用于产生并应用该迁移，返回来源映射和新的 evolutionId。禁止“修复 continue”时后台悄悄创建继承实验。此兼容方案是工程迁移决策，不改变用户确认的共同迭代起点语义。

### 11.2 本次 Marketing 实验的回归场景

| 项目 | 固定来源 |
| --- | --- |
| 原 evolution | `90b190ce-aa58-48dd-9a15-d8855a5f872c` |
| 已接受 Candidate | `6c41fa1e-d5dc-41a3-9724-c25910534c61-candidate-1` |
| champion commit | `1b9907414efc55201e825568a0c6c505c50bca05` |
| Meta 与任务配置 | Codex CLI 0.145.0，gpt-5.6-luna / medium；80 seed + 20 held-out，4 并发，每任务 60 分钟 |
| 该候选已有 seed eval | `eval_faa3f5733dec4584899f224f4b882d84`，80/80 有效，24/80 通过 |
| 已停止的多余基线重跑 | `eval_9dca96cbbeac4a04b5f2287c265637e8` |
| 已停止 batch | `6c61cd40-38b5-4cb0-96bd-1bc23d986232`，请求 2 轮，完成 0 轮 |

修复验证应使用 champion 的原候选 seed eval 作为来源；不得把 24/80 改写成其他分数，也不得为了凑完整基线恢复这次已取消的重复评测。取消记录照实保留，旧 partial 结果不删除。

迁移时显式转交剩余 2 轮的工作请求，并标记旧 batch 已由新 batch 接续，防止双重调度；这不改变旧 round 的 failed/cancelled 历史。不得把“剩余 2 轮”又作为新增 2 轮累计成 4 轮。当前实际任务仍保持停止，创建本文不执行迁移或恢复。

## 12. 实现拆分

| 工作包 | 主要位置 | 必须交付 |
| --- | --- | --- |
| 评测计划身份 | Gear `src/evaluator/hitch-cli.ts`；agent-hitch 计划解析、capabilities 与执行入口 | 标准 dataset / benchmark、直接 / daemon 的非执行计划解析；执行与计划绑定 |
| 不可变证据复用与补齐 | Gear evidence binding；Hitch evidence snapshot / repair | candidate→baseline 引用、valid slots 保留、settled partial 的派生补齐合同 |
| IterationHead 与提交 | `src/types.ts`、`src/state/store.ts`、`src/state/evolution.ts`、`RoundCommitIntent` | 单一 head 权威、原子 champion/基线提交、崩溃对账 |
| 共同迭代驱动 | `src/refine/service.ts`、`src/evolution/components.ts` | champion 父版本、共同 prepare/resume 流程、幂等批次账本 |
| Pause / Resume 协议 | `src/skill/gateway.ts`、CLI、evaluator 生命周期 | 持久化暂停意图、受控取消、恢复阶段与预算 |
| Meta 上下文 | `src/meta/skill.ts`、`src/meta/controller.ts`、外部 Codex host、refine skill 文档 | 可读取的研究记录、真实恢复模式、正确 lease 重新绑定 |
| 迁移和展示 | 迁移 API、公开 status、Rear 兼容投影、README / protocol 文档 | 来源链、复用原因、缺口计划、paused 状态与新实验标识 |

推荐实施顺序：评测身份与证据合同 → IterationHead 和共同驱动 → 暂停/恢复与 Meta 交接 → 迁移和完整集成验收。仅删掉标准 benchmark 的复用禁用分支，或仅调整外部启动脚本，不构成本修复完成。

## 13. 验收场景

下表均为必须覆盖的行为测试；“调用数”指真实 Target trial 派发，不是状态查询或证据读取次数。

| ID | 场景 | 必须满足的结果 |
| --- | --- | --- |
| T01 | 标准 benchmark，champion 已有完整 seed 基线，追加 1 轮 | baseline 调用数为 0，Meta 使用原 eval/run refs |
| T02 | 同条件 daemon 模式追加 | 提前解析冻结策略，已有基线复用，不通过 submit 获得身份 |
| T03 | 完整候选 H1 晋升后进入下一轮 | parent 为 H1，seed 基线引用 E1；需要 held-out 时复用 H1 已有对应证据 |
| T04 | A seed=30%，唯一候选 B seed=10%，晋升失败 | champion 和基线仍是 A，下一轮 parent 必须为 A |
| T05 | 一轮多个候选、多个保留研究记录 | 本轮均从固定 champion 生成；下一轮不被 survivor 列表改父 |
| T06 | 80 slots 中 79 valid、1 invalid/missing | 仅派发 1 个缺口，79 个原 runId/reward/digest 不变 |
| T07 | 80 slots 全部有效，其中 56 个 reward=0 | 不补跑这些有效低分；正常向 Meta 提供失败诊断 |
| T08 | 旧证据是 settled partial 且被历史决定引用 | 不调用不合法的旧 rerun；新派生快照补齐，旧快照与决定不变 |
| T09 | 分数存在但轨迹/验证详情不可恢复 | blocked，baseline 调用数为 0，不伪造诊断完成 |
| T10 | 数据集、verifier、Target 模型或实际采样条件不兼容 | 明确拒绝复用/继续，不静默改 spec 或启动完整基线 |
| T11 | 仅 round/evolution ID、Meta session、角色或纯审计路径变化 | 经语义验证后复用成立，原证据不可变 |
| T12 | preview 身份尚未解析，或执行前计划摘要变化 | 返回稳定错误码；Target 调用数为 0 |
| T13 | 候选已封存后暂停，再 resume | 沿用该 commit 和已有 seed 证据，不重新生成候选 |
| T14 | 评测中暂停，部分 slots 已完成 | pause 停止后续派发，确认清理；resume 只处理剩余有效缺口 |
| T15 | 暂停后重启控制面 | 保持 paused，无后台模型或 trial 调用 |
| T16 | accepted intent 提交各阶段分别崩溃 | 恢复后只有 H0/E0 或 H1/E1，轮次只计数一次 |
| T17 | append / resume 同一 requestId 重复发送 | 只增加或恢复一次；不同 body 使用同 ID 报错 |
| T18 | 原剩余 2 轮，resume；随后明确 append 1 轮 | resume 后仍为 2，append 后为 3；无新并行 batch |
| T19 | Meta 进程或控制器跨候选重建 | 实际加载研究记录；lineage-only 不得显示为历史已恢复 |
| T20 | 新 lease 复用旧研究笔记 | 验证证据身份、实际读取与当前 readiness；旧 lease 不可重放 |
| T21 | 人工暂停、正常故障和候选被拒绝 | 三者状态可区分；paused 不消耗完成轮次，不自动恢复 |
| T22 | 旧实验迁移及本次 Marketing 回归 | 原 spec/决定不变，24/80 原 seed 证据导入，取消重跑不恢复，剩余轮数为 2 |
| T23 | 两个推进请求竞争同一 head，或旧候选恢复时 head 已变化 | 单写者或明确冲突，不产生混合比较和双重晋升 |
| T24 | 暂停/恢复反复调用且生成预算耗尽 | 保留已用预算和成本，不能反复恢复重置预算 |
| T25 | operator held-out 状态与 ResearchContext / Meta assignment | 私有细节不会进入 Meta 投影或研究笔记 |
| T26 | 相同条件下比较不同 harness，及相同 harness 的跨角色复用 | 前者可正常配对但缓存 key 不同；后者可使用同一证据 |
| T27 | 成功返回候选 edit 后立即崩溃，工作区随后丢失 | 从持久化变更恢复相同候选内容；重新签发 lease，不丢编辑或重放旧 capability |

单元测试覆盖身份与决策，集成测试覆盖真实 Gear→Hitch 计划/证据协议和进程取消生命周期。使用可计数的确定性 fixture 验证零重跑与缺口补齐，不靠完整模型评测证明调度逻辑。

完成标准：上述合同、迁移与文档一起交付；首次从已有完整 champion 继续时，在启动 Meta 之前可证明 baseline 新派发数为 0，且失败候选不会改变后续父版本。真实实验的恢复是修复交付后的独立操作。

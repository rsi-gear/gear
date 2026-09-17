# Candidate 晋升与任务专长 Archive 优化规范

- 实现与接入见[接入说明](candidate-promotion-implementation.zh-CN.md)。任务子集、逐题缓存和分阶段调度由 Gear 内部适配现有 evaluator 完成，无需 Hitch 新增能力声明或接口。
- 范围：Gear 共享失败诊断、分类分工与多 candidate 生成、分阶段评测、父代选择、跨轮研究归档、过程指标兼容、champion 晋升、失败回归任务、状态恢复。
- 设计依据：Gear 搜索与评测接口及 GEPA 任务专长前沿机制。
- 文中的 MUST / MUST NOT 是验收要求；SHOULD 是允许说明理由后调整的建议。

## 1. 决策摘要

新增显式启用的 `failure-cluster-gepa-v1` 搜索模式，将四个问题分别建模：

1. **一轮中分别改什么？** 对实际父代已有失败证据统一诊断，按共同可修复原因分类，为多个 candidate 分配不同修改假设和任务范围。
2. **从哪些版本继续改进？** 在固定局部评测范围内维护 GEPA 专长前沿，跨轮保留候选并抽取父代。
3. **哪个版本替换 champion？** 只为少数提名版本扩大评测，最终与本轮固定 champion 做完整配对发布验证。
4. **以后用哪些任务检验改进？** 把可复现失败固化为版本化回归任务，通过新的实验快照纳入评测。

研究资格不等于发布资格。平均结果较差但有独特能力的 candidate 可以成为父代；其子代能否晋升仍相对于 champion 判断。Gear 的自动 champion 更新与显式 `publish` 仍是两个动作；本规范不新增自动 publish。

过程指标是可选通道。无过程指标时，逐任务结果 archive、父代抽样、配对晋升和回归任务均 MUST 正常工作。不得为了启用新模式而生成虚构过程分或追加隐式 LLM judge。

默认流程是：

```text
GEPA 选择父代（初始为 champion）
  → 复用父代 baseline，统一诊断并聚类
  → 冻结多个 CandidateWorkPlan
  → 各候选独立生成、检查、封存
  → 本组代表任务 + 共享回归 + 跨组抽查
  → 按 scope 更新研究前沿、保留局部专长
  → 少数组内优胜者在共同 bridge 集比较
  → 最多一个提名版本补齐全局 seed，再验证 held-out
  → 提交 archive；满足独立发布门时更新 champion
```

第一版采用以下边界：

- archive、诊断和父代抽样仅使用 seed/dev；一轮最多分配 4 个 mutation candidate，默认每个有效失败类别一个，不为凑数制造类别。
- 多数 candidate 只完成其冻结的局部 scope，不要求先评完整 seed 才能继续研究；完整全局证据仅要求于 champion 晋升路径。
- 统一诊断的事实可复用，candidate 只需实际消费其分配内容；不再要求每个 candidate 重复诊断父代全部失败。
- outcome 与 process 分别形成任务前沿，不合成一个加权质量分；二者仅在父代探索预算中分配比例。
- 完整性以当前阶段计划为分母；区分未安排、等待执行和执行缺失。未评任务不计零，也不自动算作通过。
- champion 默认不允许结果退步；过程改善可支持结果持平时晋升，也可阻止过程退步被结果均分掩盖。
- 保留只有结果分的 benchmark；保持旧 evolution 原有策略与部分证据规则。
- 失败任务先入提案队列，再形成新的任务集版本；不原地扩充正在运行的 evolution。
- v1 保持每个候选一个代码父代，生成默认串行；并行执行和自动代码合并不是此次交付前提。分工使改动保持模块边界，为后续合并提供输入。

## 2. 旧模式行为与相关规范

### 2.1 旧模式与新模式的差异

| 位置 | 旧模式行为 | 新模式行为 |
| --- | --- | --- |
| [CandidateGenerator / config](../src/evolution/components.ts) | 已支持 `maxCandidates` 个 sibling 槽位，默认 1；当前校验返回数量必须相等 | 新模式中它是上限；baseline 诊断后按有效工作计划确定实际数量 |
| [finalizationReadiness](../src/refine/finalization-readiness.ts) | 每个 candidate 都要取得全部父代失败的诊断 receipt | 引入共享 DiagnosisDossier 和真实的 candidate 级消费凭据 |
| [Skill Meta 输入](../src/meta/skill.ts) | `advisoryFocus` 是 round 级；没有 candidate 级任务分配 | 增加绑定父代、失败组、诊断和评测范围的 CandidateWorkPlan |
| [TaskRewardJudge / HighestQualityCandidateSelector](../src/evolution/components.ts) | `quality` 默认来自结果分；按综合 quality 排序 | 增加逐任务证据与独立的 archive 更新、发布提名 |
| [newRound / drive](../src/refine/service.ts) | generator 只能使用固定 champion；`championParent` 同时参与父代恢复 | 分离 generation parents 与 promotion champion |
| [passesSeed / passesHeldOut](../src/refine/service.ts) | seed 前置门硬编码结果门槛，后置门才调用 promotion provider | 两阶段都使用同一版本化策略合同 |
| [CandidateSeedComparison / PairedTrial](../src/types.ts) | 已保存可选过程分及过程增量 | 补充指标语义、适用范围、缺失状态、证据摘要 |
| [nextPopulation / RoundCommitIntent](../src/refine/service.ts) | 下一 population 来自本轮 selected candidates；与 champion 一起提交 | archive 可以引用历史成员；提交与恢复支持独立发布决定 |
| [store validation](../src/state/store.ts) | finalist 必须是 survivor；population 成员必须出自本轮 | v2 合同分别校验 archive 来源与 finalist 来源 |
| [champion parent resolver](../src/refine/champion-parent.ts) | champion 恢复依赖来源轮 population 中的成员 | champion 父代快照独立保活，不受 archive 剪枝影响 |

旧模式的 generator 在 baseline 读取前分配槽位，生成器输入不含失败证据；因此仅提高 `maxCandidates` 或增加 selector 插件不能实现本规范。`maxCandidates` 控制候选数量，`maxAttemptsPerCandidate` 控制同一候选的生成重试上限。

### 2.2 与已有规范的关系

- 旧模式从 champion 生成候选；新模式按本文规则显式抽取父代，champion 独立作为晋升比较基准。两条路径都遵守基线复用、身份验证、恢复和 held-out 隔离要求。
- [可组合实验框架](research-evolution-component-abstraction-plan.md) 的研究 population / 唯一 champion 分离原则继续适用；本文具体定义跨轮 archive 的算法与合同。
- [部分证据实验](partial-evidence-promotion-experiment-plan.md) 的“有效交集可继续晋升”保留给原策略；新模式的研究要求局部计划完整、发布要求全局计划完整，不回溯修改旧决定。
- [Benchmark 结果规范](hitch-evaluation-source-and-evidence-contract-spec.zh-CN.md) 的 total / process / feedback 分离继续适用；本文定义这些信号如何用于搜索和晋升，不接管 verifier。其旧版整条 observation 有效性规则继续保留；第 5 节的独立通道有效性须通过新的 adapter/result schema 显式启用。

## 3. GEPA 搜索机制

Gear 使用逐任务前沿保留候选的局部专长，通过冗余剪枝和 membership 权重选择后续迭代的父代。研究 archive 与 champion 晋升分别决策：前者按第 6 节的 scope 与通道规则选择父代，后者按第 8 节与固定 champion 做完整配对验证。

各机制的设计如下：

| 机制 | Gear v1 决定 |
| --- | --- |
| 逐任务前沿、冗余剔除、membership 抽样 | 使用固定精度处理与确定性回放 |
| 过程通道 | 可选、独立前沿；不把过程分覆盖写入 `quality` |
| 小批量候选筛选 | 采用冻结的 local/shared/cross scope；以任务前沿与显式回归门保留专长，不要求子代局部总均分严格胜过父代才记录证据 |
| 多 candidate 的改进方向 | 基于共享诊断与失败类别分工，不依赖同一提示的重复随机提案 |
| 稀疏评测 | 每个 scope 独立前沿；跨组以共同 bridge 比较，额外评测不自动获得更多父代权重 |
| 发布 | 固定 champion 的 seed + held-out 配对门，不使用研究父代替代 champion |
| 在线失败提升为任务 | 收集失败提案，封装可复现任务，使用套件版本和不可变实验边界 |

## 4. 术语与不变量

- **ResearchArchive**：跨轮候选、逐任务证据和前沿的不可变快照；区别于仅保存本轮 survivors 的旧 population。
- **EvaluationScope**：冻结的本组任务、共享回归和跨组抽查及其槽位清单；表示可比较的研究范围。
- **FailureCluster**：有证据支持、可能由同一类 Harness 修改解决的问题集合；可多标签，不等于业务类别或任务随机分片。
- **DiagnosisDossier**：按父代和证据版本生成的共享诊断事实；不是所有 candidate 的个人阅读记录。
- **CandidateWorkPlan**：绑定具体父代、失败类别、修改假设、诊断范围、评测 scope 和预算的生成指令。
- **Active parent set**：至少在一个活跃 scope 取得研究资格、具有正抽样权重的候选集合。
- **Generation parent**：本轮为某 candidate 显式抽中的代码父版本。
- **Promotion anchor**：本轮开始时固定的 champion、manifest、seed/held-out 基线引用和版本 revision。
- **Frontier cohort**：相同任务内容、评分合同、模型/采样、预算和逻辑重复槽位下可比较的证据集合。
- **Regression proposal / suite**：尚未进入评测的失败任务提案 / 已封存的可复现回归任务集。

必须满足：

1. 所有候选、父代与 champion 均以 exact Git commit 和 manifest 验证；tree 相同仅能证明内容等价。
2. 父代选择、归档、反馈摘要只消费 seed/dev；不得消费 held-out 分数、任务身份、断言或轨迹。
3. archive 留档与 champion 接受分别决策；“未晋升”“无专长”“证据不足”“执行失败”不得合并。
4. admission 先固定父代批次、anchor 和预算；诊断完成后再固定实际 candidate workplans。恢复不重新抽签，不重写已封存的聚类、工作分配或阶段决定。
5. Meta 相对实际父代诊断和修改；champion 晋升相对固定 promotion anchor 检验。
6. 评测复用由 harness + condition + scorer + slots 身份决定；角色或 round 改变不能触发重复执行。
7. 计划外未评任务不是缺失，更不是零分；计划内 missing/invalid 不能标为计划外。缺失过程分不是过程能力不存在。
8. archive 剪枝不删除审计证据，不使 champion 或已分配父代失去可恢复性。
9. 完全中性的变更默认不能替换 champion；特殊中性接受策略必须显式配置。
10. 新策略、新任务内容或新评分合同不原地写入旧 evolution；旧 spec 和旧决定保持不变。
11. 同一 scope 的候选使用相同任务及重复槽位；不同 scope 的局部均值不能直接做全局排名。
12. 共享诊断、聚类、生成、补评与发布预算分别计量，并受统一 round/evolution 上限约束；进入新阶段不能刷新预算。

## 5. 指标与证据合同

### 5.1 版本化能力声明

沿用 benchmark adapter 的公开评分合同；若现有 manifest 未提供足够语义，增加版本化扩展。Gear 不按 benchmark 名称猜测能力。

```ts
interface MetricContract {
  id: string;
  revision: string;
  digest: string;
  channel: 'outcome' | 'process';
  evidenceKind: 'final-outcome' | 'final-state-partial-credit' | 'trajectory';
  granularity: 'dataset-aggregate' | 'trial' | 'component';
  direction: 'maximize' | 'minimize';
  range?: { min: number; max: number };
  normalization?: { kind: 'fixed-linear'; min: number; max: number };
  comparisonQuantum: number;
  repetitionReducer: 'mean';
  applicableTaskSetDigest: string;
}

type MetricObservation =
  | { status: 'available'; rawValue: number; contractDigest: string; evidenceRef: string }
  | { status: 'unsupported' | 'not-applicable'; declarationDigest: string }
  | { status: 'missing' | 'invalid'; contractDigest: string; reason: string };
```

- outcome 是必需通道，可以为二元或连续分数；连续 outcome 不自动变成 process。
- 指标方向、量纲、比较精度、归一化和任务适用集合在 spec / resolved plan 中封存。
- 原始值保留；增益统一按 `u(candidate) - u(baseline)` 计算，其中 `u` 应用封存 direction 与 normalization；未启用 normalization 时才退化为 `directionSign × (candidate - baseline)`。
- 不同原始量纲的任务做宏平均时，必须提供固定转换；禁止用本轮 candidate 的 min/max 动态归一化。同一量纲可以直接使用原始值。
- `comparisonQuantum` 必须为正。所有排序与增益先使用封存 direction / normalization 得到效用值 `u`，原始分数只用于保存和展示。前沿 key 为 `floor(u / quantum + 0.5)`；使用确定的十进制定点/有理数运算而非依赖平台浮点临界舍入。宏平均完成后采用对应聚合合同的 quantum 比较，避免基于 pairwise epsilon 的非传递并列。
- 只有 dataset 总聚合过程分的 provider 可以展示该分数，但不能据此建立逐任务前沿或触发新模式的过程晋升路径。必须区分这一情况与旧合同的 `process.json.detail_status: aggregate-only`：后者是每个 trial 已有合法过程标量、仅缺 components，仍可正常参与过程前沿与晋升。
- 旧记录的裸 `processScore` 若缺少评分语义证明，仅作旧格式展示。显式适配器可通过已验证的 benchmark revision 建立合同映射，不能依据分值范围猜测。

### 5.2 缺失状态与兼容行为

| 场景 | Archive 行为 | Promotion 行为 |
| --- | --- | --- |
| benchmark 声明不支持 process | 只建 outcome 前沿，全部抽样预算归 outcome | 合法的结果分策略；不要求过程字段 |
| 混合任务集，仅部分任务声明适用 process | process 只覆盖预声明任务 | 仅在该固定集合上检查，不把其他任务计零 |
| 完整、有效 process，包括值为 0 | 可建 process 前沿 | 正常比较；0 是实际观测 |
| 预期提供，但部分过程槽位 missing / invalid | provider 独立认证 outcome 有效时保留其资格；process 资格待补齐 | promotion 已启用 process 时为 `insufficient-evidence`，不得运行时降级为不支持；off 时只按有效 outcome 判断 |
| 只有 dataset-aggregate process | 结果前沿 + 过程展示 | 按预先解析的 outcome-only 模式处理，记录不支持逐任务消费 |
| 每 trial 有 scalar，但没有 components | 正常建立过程前沿 | 正常过程比较；不能声称具有 assertion 级保护 |
| metric / scorer identity 不一致 | 不进入同一 cohort | 协议错误，不能通过剔除异常值绕过 |

`process.mode` 为 `off | auto | required`：

- `off`：决策不消费过程；原始证据仍保存。
- `auto`：admission 时依据合同解析可消费的任务集合；空集合时为合法 outcome-only。
- `required`：若无可消费的逐任务过程指标或固定集合为空，admission 失败并说明原因。

解析结果必须封存，不能随 candidate 是否输出过程分而变化。`auto` 只兼容能力不存在，不容忍已声明能力悄悄失效。

独立通道有效性依赖拟议的 `score-envelope-v2`：provider 必须分别证明 outcome 与 process 的状态、身份和原始产物来源，并声明任务级适用范围。只有在 outcome 被 provider 独立认证为有效时，Gear 才能在 process missing / invalid 时保留 outcome 资格。旧协议将缺失过程文件判为整条 observation invalid 的，Gear MUST 保持 invalid，不得自行取出其中的 outcome 抢救为有效证据。

旧 manifest 的统一 `process supported` 映射为所有计划任务适用；旧 manifest 无过程能力映射为全部 unsupported。混合适用范围需要新 schema 的明确声明，不能根据运行输出推断某任务不适用。provider 不支持 v2 时继续使用原 observation 规则；这不影响原本合法的 total-only benchmark。

### 5.3 配对、重复与覆盖率

task key 包含任务内容 digest；cell key 包含 task key、逻辑 repetition / seed 以及执行条件 digest。当前 `(taskName, attempt)` 只有在 provider 明确证明 attempt 对应计划 repetition 时才可作为其投影。

先按相同逻辑槽位配对，再在任务内聚合，最后按封存 task weights 做宏平均。不得因为某任务重复更多而获得更大隐式权重。基础设施 retry 不是新增统计样本；不得选择表现最好的一次替代有效观测。

新模式 v1 分开记录执行覆盖与指标能力，`not-evaluated` 不是 `MetricObservation` 的伪造数值：

| 执行覆盖状态 | 含义 | 是否进入本阶段完整性分母 |
| --- | --- | --- |
| `not-evaluated` | 未纳入该 candidate 当前阶段计划的 task/cell | 否；只能通过新扩展计划纳入 |
| `pending` | 已纳入计划，尚未执行完毕 | 是；阶段未完成 |
| `missing / invalid` | 已结算但缺产物，或 provider 判为无效 | 是；按原计划 repair，不能缩小分母 |
| `available` | 计划内有效证据，包括实际零分 | 是 |

- 某 scope 的 outcome 研究资格只要求该 scope 及其探索硬门的全部计划 outcome slots 有效；scope 外未评任务不阻止入档或成为父代。
- process 资格额外要求该 scope 的全部预声明 process-eligible slots 有效，不要求 scope 外过程分。是否支持某过程指标由合同决定，不由这次是否安排运行决定。
- outcome 合格但过程证据不完整的 candidate 可进入该 scope 的 outcome 前沿，不能进入其 process 前沿。过程比较明确记录完整证据候选集合。
- shared 或 cross 任务一旦进入本地计划，也是完整性要求；不能只保留本组好结果、删掉跨组失败。
- global seed 与 held-out 阶段要求各自固定全局任务计划完整，不能沿用局部 coverage 报告替代。过程 `auto` 已解析启用时，按这些阶段各自的适用集合检查。
- 每份结果保存 `universeDigest`、`stagePlanDigest`、`scopeDigest`、`planned / available / paired / pending / missing / invalid` 与全局尚未评测数量。不输出不同 scope 混合而成的全局均分。

局部、bridge、global 阶段之间以不可变 `StageEvaluationPlan` 扩展证据。新计划可以引用旧有效 cells，但旧快照保持原有范围；从局部清单扩到按全集比例计算的 bridge 清单是新计划，不是把原来未安排的任务改标为评测故障。

实现须有 provider 可验证的 task-level subset plan 与 cell-level evidence reuse 合同：任务内容、模型/采样、环境、scorer、repetition 相同且 provider 证明批次成员不会改变该 cell 行为时，才能复用。不得直接以不同 aggregate dataset identity 推断等价。provider 不支持这些能力时，新模式在 admission 阻塞并说明缺少能力，不静默退回每候选全量运行。

所有投影或 repair 后的聚合 MUST 从实际所选 slots 重算。无法聚合时必须移除旧 aggregate，包括顶层 `processScore`，不能因为对象展开保留原 eval 的全量分数。

### 5.4 断言、反馈和轨迹

过程总分、逐断言变化和轨迹判断分别保存。逐断言比较要求稳定 ID、参数和评分语义一致；`excluded` 是 rubric 状态，不是数据 missing。

硬约束必须由版本化任务/策略明确标记，不能从 `not_*` 命名或自然语言推测严重程度。未提供断言的 benchmark 可使用显式 protected task 的结果回归门；不提供二者时必须记录 `constraintCoverage: unavailable`，不能声称“已证明无约束回归”。

独立 LLM trajectory assessor 不属于默认依赖。后续启用时必须封存 judge、rubric 和预算，输出带证据引用的独立通道，不能覆写 benchmark outcome，也不能把 Meta 的自述当成执行事实。

## 6. 跨轮任务专长 Archive

### 6.1 输入和身份

archive 的输入为：上一已提交快照、本轮全部候选的有效阶段证据，以及已封存的历史补齐/扩展证据版本。记录先于选择存在；未被选为父代或未晋升都不删除证据。

同一 cohort 固定 seed 任务全集、task/scorer contracts、Target/model/sampling、每任务预算、环境和逻辑 repetitions。cohort 内的 scope 是全集的冻结子集，不是新的 benchmark；跨 scope 复用必须通过第 5.3 节的 cell 身份校验。

每个 scope `g` 的清单为 `S_g = local_g ∪ shared ∪ cross_g`，至少包含一道本类代表任务（去重后可归入 shared 桶），且所有成员都来自 seed/dev：

- `local_g`：该失败类别的代表任务，兼顾失败模式、难度和修改模块。
- `shared`：各组共同的少量开发回归任务，用来发现通用能力退步；不是 held-out。
- `cross_g`：从其他类别预先选出的抽查任务，不根据候选结果临时替换。
- 范围内 task/slot、用途、权重和 process 适用集合必须在候选生成前封存。同组所有候选使用同一 `scopeDigest`。

同任务落入多个桶时，按 shared → local → cross 优先级分配唯一计分桶，只运行一次。local/shared/cross 的默认计分桶权重为 `0.6/0.25/0.15`，桶内 task 等权；空桶按固定规则在非空桶间归一化，并写入 manifest。任务数和运行预算独立配置，不由这三个计分权重推断。全局发布的 task weights 独立，不沿用局部偏置权重。

**任务集合规模统一按全集参数化。** 令 `N` 为本 evolution 已冻结 seed/dev 全集的去重任务数；不包含 held-out，不是失败任务数、当前组任务数或 repetition/cell 数。local、shared、cross、bridge 共用 `search.taskSetSizing`，各自配置比例 `r_x`，不使用固定题数默认值：

```text
L_x = min(N, configuredMinTasks_x ?? 0)
U_x = min(N, configuredMaxTasks_x ?? N)
Q_x = min(U_x, max(L_x, ceil(N × r_x)))
```

`Q_x` 是规划目标，`minTasks / maxTasks` 为可选的目标下限/容量上限，默认均未设置；全集上限始终生效。minTasks 不保证任务池有足够成员，实际不足必须明示，不能伪装成已满足下限。比例使用确定的十进制定点计算，并封存向上取整规则。默认配置示例为 local `0.08`、shared `0.04`、cross `0.03`、bridge `0.40`，均可修改；比例是采样规模参数，与计分桶权重无关。

- admission 校验比例为有限值且在 `[0,1]`，local 比例必须大于 0，三局部桶比例之和不得大于 1；显式限额为非负整数，且 `minTasks ≤ maxTasks`。配置为 0 的桶表示关闭，不能同时要求正的 minTasks 或必需核心任务；bridge 为 0 表示本轮仅做局部研究，不绕过 bridge 直接发布。
- 正比例在非空全集上经 ceil 至少请求一题，显式 `maxTasks=0` 与正比例冲突；`N=0` 时拒绝新模式 admission。小全集下显式 minTasks 大于 N 时只取全集并记录裁剪，不能复制任务凑数。
- shared 清单在同一 epoch 统一解析、冻结一次，各组不能为凑 local 数量删改它。按 shared → local → cross 选择和去重，在各自合格任务池中回填至 `Q_x`。若任务池不足，或小全集取整后请求总数超过 N，则只取仍可用的任务并记录 `requested / resolved / selected`、候补耗尽或全集耗尽原因；不把 local 缺额悄悄转为其他类别，不重复执行同一 task 来充数。最终 scope 仍须包含本类代表（可已归入 shared），否则不创建该 workplan。
- shared 核心回归必须纳入该桶；若核心数超过 `Q_shared`，规划返回配置/容量不足并报告所需数量，修订比例或限额须通过新的 admission，不静默超配额或删除核心。额外 exploration guards 单独并入 scope 必测清单与预算，全部去重；因此实际 scope 数量可以高于三个桶之和，但不超过 N。桶的 maxTasks 约束该桶，不能被解释为整个 scope 含额外 guards 的费用上限。
- bridge 的 `Q_bridge` 同时是该阶段目标与容量上限，不再另设会冲突的 target/max 规模来源；完整的入选 scope 并集和 bridge guards 必须容纳其中。无法容纳时按第 8 节减少入选组并重新计算并集，或取消扩评，不隐式提高比例。global seed 与 held-out 仍覆盖各自已冻结全集，不使用局部采样比例。

规模解析记录包含 `universeDigest / N`、各比例/限额、取整算法、目标数量和最终清单摘要，随 scope epoch / stage plan 封存。同组所有候选共享相同解析结果，恢复不按临时数据重新算数量；切换到新的全集版本必须重新 admission。运行费用上限独立于任务数量：预算不足时减少候选或阶段参与者，不在 workplan 封存后缩小必测集合。

候选研究状态按 `(candidateId, scopeDigest)` 记录为 `pending-evidence | scored | parent-eligible | inactive | ineligible`，过程资格独立。整体 archive 是各 scope 视图与原始证据的集合，不存在从不同局部均值拼接出来的“全局 best”。

探索门与发布门分离：`explorationGuards` 默认空，v1 支持绝对 `minimum-score / must-pass`；`deploymentGuards` 影响发布，不自动剥夺研究价值。探索门的任务即使不在 local/shared/cross 中，也必须计入该 scope 的必测 guard 范围与预算，不能以未安排绕过。

父代资格先过滤 sealed identity、scope 完整性和探索门，再形成前沿。无有效证据、生成/验证失败或探索门未通过的版本不能占住有效候选的前沿。

### 6.2 Scope 内的 GEPA 前沿

令 `C_o(g)` 为 scope 完整且探索门通过的候选，`C_p(g)` 为其中该 scope 过程证据完整的候选。每个前沿都带这两个已比较集合的摘要：

```text
F_o(g,t) = { c ∈ C_o(g) : q_o(c,t) = max q_o(*,t) }
F_p(g,t) = { c ∈ C_p(g) : q_p(c,t) = max q_p(*,t) }
```

`q` 使用第 5 节的效用和固定 comparison key。只在 scope 内适用的任务建立过程前沿，过程赢家不必先在 outcome 并列第一。

规则：

- “该 scope 的已评候选中领先”是有范围的观测结论，不是未评候选也已被击败。
- 每个 `(scope, task, channel)` 最多贡献一个前沿；不把 assertion 数量当探索权重。
- 全候选同分的维度标为 `uninformative`；只有一个合格候选时使用 fallback，不声称已证明独特能力。
- 候选在 scope 外多跑了任务，也不会自动增加前沿维度或抽样权重。
- 候选进入另一个 scope，必须由跨组准入计划补齐那个 scope 的全部清单；单个共享任务得分不足以取得另一组资格。

### 6.3 Scope 内去重与冗余剪枝

每个 scope 独立处理同 tree 代表与冗余候选。只在环境、评分 cohort 一致且均具备该 scope 资格的版本间去重；代表按最早完成该 scope 评测、再 canonical ID 选择，不能挑同内容的最高随机得分。原 commit、lineage、evidence 均保留，不合并不同版本的 samples，也不借用其他 commit 的过程分拼成 profile。

只对 informative 前沿执行剪枝；两通道都没有 informative 前沿时直接按第 6.4 节选 fallback，不用空集合覆盖规则把全部候选删空。在一个 scope 中按其 outcome 效用均值从差到好、再 canonical ID 遍历。只有某候选所属的每个 informative outcome/process 前沿均还有其他存活候选覆盖时才移出该 scope 的 active set，重复到不能再删。

该候选仍可能在另一个 scope 活跃；active parent 总集合取各活跃 scope 的并集。任何跨 scope 淘汰都不得直接比较局部均值。champion 快照、已分配父代与待完成事务引用独立保活。

v1 不以硬 top-N 静默删除唯一专长。触及封存资源上限时停止增加 scope/候选并报告预算原因，历史证据保持；近似覆盖淘汰须另立策略版本。

### 6.4 先抽 Scope，再抽父代

外层使用预声明 scope 权重 `π_g`，默认活跃失败类别之间等权，每个类别同时仅有一个用于抽样的 scope epoch。内层使用 GEPA membership，避免候选仅因多评任务、或某组任务更多而天然获得更多预算：

```text
w_o(c|g) = Σ_{t∈I_o(g)} taskWeight_g(t) × 1[c ∈ F_o(g,t)]
w_p(c|g) = Σ_{t∈I_p(g)} taskWeight_g(t) × 1[c ∈ F_p(g,t)]
P_o(c|g) = w_o(c|g) / Σ_c w_o(c|g)
P_p(c|g) = w_p(c|g) / Σ_c w_p(c|g)
P(c|g)   = (1-rho) × P_o(c|g) + rho × P_p(c|g)
P(c)     = Σ_g π_g × P(c|g)
```

`I_o(g) / I_p(g)` 仅包含相应通道的 informative 任务；无此类任务时不计算零分母概率，按下述 fallback 规则处理。默认 `rho=0.25` 是过程专长的探索预算比例，不是过程分在总质量中的权重；所有默认比例都是待验证的设计起点。

- process 不支持或 off 时，scope 内全部预算归 outcome。某通道无 informative front 时预算转给另一通道；两者都无前沿时，在该 scope 合格父代中优先 champion，否则按 scope outcome 效用、canonical ID fallback。
- scope 没有合格父代时，记为待建立证据，不偷偷选择缺证据版本；它不能获得正常抽样资格。所有 scope 都不可用时为 `blocked-no-eligible-parent`。
- 外层只在已封存的可用 scope 集合归一化，并保存被暂缓的组与原因。新候选临时缺过程分不改变能力声明或组权重。
- 同一候选在多个组有经验证的资格，可以获得多个组的抽样机会；仅复制相同 manifest 或重命名失败类别不能增加 π，等价 scope 必须合并。
- 单一 scope 的纯 outcome 示例 A=(90,90,40)、B=(50,50,100)、C=(80,70,30)，三任务等权时保留 A/B，概率为 2/3、1/3。并列使用 membership 总和归一化。

admission 默认抽一个 parent batch，为它预留至多 4 个工作槽位；因此第一轮可从同一 champion 产生多个针对不同失败的 sibling。配置多个 batch 时先固定各 batch 的候选配额，再按稳定顺序有放回抽 `(scope,parent)`；相同父代共享诊断，不复制 rollout。保存 PRNG 版本、seed、draw index、archive/概率摘要和选中父代，恢复不重抽。

### 6.5 跨组比较与 Scope 更新

局部 archive 不要求全量评测。跨组争取 global 评测预算时，各组先提名局部优胜者，再让这些版本与固定 champion 完成同一 bridge plan，之后才能按共同证据排序；见第 8 节。

任务分类、代表任务与跨组抽查可以更新，但只能在 round 的规划边界（本轮任何 candidate workplan 封存前）建立新 scope epoch：记录更新规则、历史证据截止点、manifest 和预算。正在运行的 workplan 不变，旧前沿和旧概率不改写；新视图随本轮研究提交落盘后才用于后续父代抽样。

新 epoch 激活前先让其 champion/fallback 与预算内选定的历史 specialist 获得所需局部证据；通过 cell 复用只补差集，不全库补评。未补齐的旧候选保留旧 scope 资格和历史记录，但不能声称已在新范围领先。准备预算不足则维持旧 epoch，不能把同一组的新旧 epoch 同时计为两个抽样组。

v1 默认 scope 在同一 evolution 内保持稳定；允许配置确定的更新周期。实现配置为 `scopeSampling.epochPolicy: periodic` 和正整数 `updateEveryRounds`，从第 0 轮开始按周期边界准备；可用非负整数 `maxHistoricalSpecialists` 限制额外历史版本，必要 champion/实际父代不受该额外名额上限省略。持续固定小集合的偏置由跨组 bridge、后续 scope epoch 和最终全局验证共同检查，不能把共享开发样本当独立测试集。

## 7. 统一诊断、失败分类与多 Candidate 生成

### 7.1 两次冻结与基线复用

admission 先固定 `promotionAnchor`、archive 快照、parent batches、候选槽位上限与全部阶段预算。baseline 证据就绪后，planner 才生成并封存实际 `CandidateWorkPlan[]`。当前 generator 的同步 `plan()` 无法承担这项需要证据的规划，应拆成 admission allocation 与异步 evidence-based planning。

```text
parent batch → 本批使用的实际父代、诊断输入与候选配额
workplan     → 一个 candidate 的父代、失败类别、修改假设与评测 scope
anchor       → 本轮固定 champion、完整发布比较与 CAS 预期值
```

如果未晋升 B 被抽为父代，B2 的 diff、诊断、候选检查和局部配对相对 B；B2 的发布比较相对固定 champion A。不得拿 A 的失败列表冒充 B 的诊断结论。

父代 baseline 按此次诊断/评测 scope 解析：已有完整且身份相同的 cells 直接复用；已安排但 invalid 的按 repair 合同处理；原本未安排的任务通过预算内新 baseline/probe plan 补差集。选择局部父代不得自动触发全 seed baseline。身份不明则阻塞，不用全量重跑代替身份验证。

初始 champion 的完整 seed baseline 可以建立一次，用于启动分类；已有快照时零新增 baseline rollout。后续 specialist 只需其此次所用 scope 的 baseline，不因缺全量分数失去父代资格。champion seed/held-out baseline 独立缓存，不被研究父代替换。

### 7.2 共享 DiagnosisDossier

每个实际父代的相同证据只做一次共享诊断。dossier key 至少包括 parent commit/manifest、baseline evidence revisions、诊断范围、投影器/分类器版本及 sanitization policy digest。

coordinator 在冻结诊断范围内：

1. 汇总已评任务结果与可选过程信息，保留成功任务作回归参照。
2. 对范围内失败 runs 读取可追溯诊断卡，记录来源、错误现象、可能原因和置信状态。
3. 将基础设施 invalid 放入执行修复队列；不得把未评任务、超时安装等自动归为业务能力失败。
4. 把缺证据或原因不确定者标记 `unknown / unresolved`；预算耗尽时保留未完成覆盖，不编造根因。

benchmark 没有过程分时，可使用 total score、公开 feedback 和已有 seed 轨迹；没有 feedback 也不能强制产生过程评分。LLM 分类器可显式配置，但其身份、输入、输出与 token 预算必须封存，输出是研究假设而非评分权威。

不同父代各有对应 dossier；相同父代被多次抽中时共享同一证据与诊断。底层 run/card 缓存可复用，诊断完成事实必须以实际生成的 dossier 验证，不能靠复制 candidate 目录取得。

### 7.3 按可修复原因分类与分配任务

分类依据为“同一种可定位的 Harness 修改是否可能改善这些失败”，结合任务结构、工具/数据流、断言/反馈、历史改动与回归。文本或业务名称聚类仅作辅助；不能把所有零分视为一个原因，也不能每个失败任务自动分配一个候选。

建议起始类别是来源/规则解析、集合与计算、请求构造、完成与约束检查；它们是可配置分类，不是对所有 benchmark 的强制 taxonomy。任务允许多个标签；若分类证据不足，留待诊断或安排有明确目标的探查计划，不为凑齐 4 个 candidate 伪造类别。

每个 cluster 保存成员任务/run、依据、可能共享的失败机制、候选可修改模块、反例/已成功样本、估计修复价值和评测成本。task 集按预计 token/时长平衡，不仅按数量平均切分；仅凭少数轮的分数相关性不能自动确认为共同根因。

分配规则默认每个 `(parent, failure family)` 一个 candidate；预算不足时按封存的优先级排序选择，默认优先保护要求相关失败、再覆盖任务数、再稳定 cluster ID。配置多个同类候选时必须给出不同修改假设，并使用同一 scope 比较；不能只复制相同指令。

候选计划至少包含：实际父代、dossier ref、cluster ID、目标任务、必须读取的诊断 refs、修改假设、建议模块边界、共享回归/cross 范围、scope manifest、生成与评测预算。`advisoryFocus` 保留为提示，不能代替这个强身份工作分配。

scope 任务在候选生成前按第 6.1 节的 `N × ratio` 和可选限额解析、选择并封存；每组 local 实际数量还受该类合格任务池约束，不写死题数。共享回归保持各组相同；各阶段完整性根据最终清单计算。若去重后的计划覆盖整个全集，明确记录本次局部阶段实际等于全集。

默认 sampler 使用以下顺序，所有选择仅基于截止点前的父代/历史 seed 证据，不读取本轮候选结果：

| 桶 | 选取方法 |
| --- | --- |
| shared | 先纳入预声明的 shared 核心回归，再从父代已成功任务按能力类别分层选代表；同一 epoch 的所有组共用该清单 |
| local | 在该类失败中先覆盖不同失败子模式与受影响模块，再按历史难度/预计成本分层，避免全选相似且便宜的题；保留已成功反例以检验改动边界 |
| cross | 在其他类别间按固定组权重分配名额，抽查可能被共享模块改动影响的任务；无足够类别时从其余 seed 抽取并标明一般抽查 |

分层内按封存 PRNG seed 和稳定 task ID 选择；去重后从同一桶候补顺序回填，不足则缩小，不借用候选好结果补位。显式必测 guard 不受抽样配额豁免，核心/guard 超预算时减少工作计划或停止扩评并记录原因。分类允许任务重叠，评测范围是少量代表与对照，并非把全部任务硬切成互不相交的几个子 benchmark。

已有 failure family 复用其活跃 scope epoch，不因当前父代失败列表变化就临时换题；修改假设可以变化，考核范围保持。新类别或范围更新按第 6.5 节在规划边界准备：预算内完成必要父代/anchor 证据后可形成本轮 workplan，新视图提交后再参与父代抽样。尚未具备合格范围的类别先记录为待规划，不能在 sibling 之间创建同名不同题的比较组。

用于检验的任务不必都已失败，但未评任务只能标为探索样本。新 scope 先取得父代的必要 baseline 差集，再封存最终 dossier/workplan；补评若推翻修改假设，记录取消该槽位和理由，不无限重聚类刷新预算。

实际候选数 `0 ≤ K ≤ maxCandidates`。没有可执行假设或不足预算时返回 `no-actionable-cluster / budget-exhausted`，保留研究记录；新模式不沿用“generator 必须恰好返回 maxCandidates 个槽位”的旧校验。planner 不自动增大全轮时间、token 或 rollout 上限。

### 7.4 候选读取凭据与提交门

共享诊断事实与个人读取事实分开：增加 `workplan-dossier-consumed` receipt，绑定 workplan、dossier/实际交付摘要、candidate/session、读取结果和 digest。它只证明候选消费了分配内容，不伪称该 candidate 亲自诊断了 dossier 的所有 runs。

新模式 finalization 检查：

- 对应父代的共享诊断有效，分配范围内必需证据已解析。
- candidate 实际读取了自身 workplan、相关诊断卡/有来源摘要和共享约束。
- candidate 引用的额外证据已通过访问审计；不能只在后台填满旧 `diagnosisReceipts`。
- sealed 版本、diff 父代、检查报告和实际工作范围可验证。超出建议模块的改动要披露影响范围，并触发预声明的更广评测准入规则，不能继续使用狭窄测试证明其安全。

无需每个 sibling 重读父代所有失败轨迹。旧模式保持原来的全失败 baseline receipt 规则；不能通过删旧审计来实现兼容。

### 7.5 独立生成与知识继承

每个 workplan 使用独立 workspace / Meta session，从其固定父代生成。v1 默认串行生成，所有 sibling 封存或明确失败后才开始本轮 candidate 评测；新候选不能偷看本轮其他 sibling 的结果后改变提案。

generation retry 保持同一 workplan、父代、scope 和总预算；它不是另一个独立 candidate。失败类别间可共享来源可靠的诊断事实，但不能将一个分支代码隐式作为另一分支父代。

评测后由控制面形成 seed-only `ResearchFinding`：修改假设、实际 diff、已观察的改善/回归、scope/support、未验证范围、工作流采用证据或未知、剩余缺口、下一步建议。候选是否进入全局阶段与是否成为父代分别记录。

DSH 可以继续经验证的 parent checkpoint；Skill 模式必须有真实可读的 findings/交接文件或 API。仅复制 session ID 或空 checkpoint 不算经验继承。后续轮次围绕被选父代的最新已知不足再分类，而非永久重复初始 champion 的失败列表。

## 8. 分阶段评测与独立的 Champion 晋升策略

### 8.1 局部筛选、共同 Bridge 与全局提名

archive 更新和 promotion nomination 是两个独立输出。局部专长足以获得继续演化的机会，不代表已通过全局 seed precheck；候选没有任务第一，但共同范围的宏平均更好时仍可被提名。候选被研究剪枝不应阻止它替换 champion。

评测按以下顺序分配预算，后续阶段复用身份一致的有效 cells：

| 阶段 | 参与者与任务 | 决策 |
| --- | --- | --- |
| Local | 每个有效 sealed candidate 完成本组 `local + shared + cross + guards`；实际父代完成同一清单 | 形成局部研究资格与前沿；决定本组提名，不要求每个候选跑全 seed |
| Bridge | 默认最多 2 个组内提名候选，与固定 champion 完成同一 bridge 清单，容量由全集 N 和配置解析为 `Q_bridge` | 用共同证据选择最多 1 个 global nominee；不能按不同组的局部均值直接排序 |
| Global seed | 仅 global nominee 与固定 champion 补齐完整 seed 的差集 | 执行完整 seed precheck；未通过则本轮没有 held-out finalist |
| Held-out | 仅通过完整 seed precheck 的唯一 finalist，与固定 champion 执行独立 held-out | 执行 final gate；通过后更新 champion |

local 阶段不要求 candidate 平均分严格胜过父代，也不要求取得正 process 增益才入档。scope 完整性、探索门和前沿决定其父代资格；未得到 bridge/global 配额记为 `retained-local / not-selected-for-expansion`，不能伪装成发布拒绝。

组内提名默认从本轮该组 outcome 完整的候选中选择一个；同组多候选按 scope outcome 效用、可比且完整的过程效用、canonical ID 排序。local/bridge 的扩评排序与过程门统一使用 admission 解析的 `promotion.process` 及该阶段预声明适用任务集合，`search.process` 仅控制 archive；因此 promotion 为 off 时不会被前置过程门间接拦截。任务/指标适用集合、计划参与者及完整性规则在结果产生前固定，实际合格候选由有效证据派生。

预期过程不完整的候选可以保留 outcome 研究资格，但需要补齐后才能参与已启用过程的阶段排序，缺失不能记零。没有可消费过程任务时直接跳过过程维度；过程量纲不能固定转换到同一尺度时分别检查适用下界，但不使用临时均值打破 outcome 并列，按 canonical ID 决定。

多个组争取较少 bridge 名额时，按已封存的组权重、轮换规则和稳定 ID 分配组配额，再取各组提名者；默认等权确定性轮换，避免固定偏向某一组。不得用不同组的均值高低抢占名额。若配置多个 parent batch，同组候选仍按同一 scope 竞争。

bridge 的规模比例、可选限额、选择规则、重复计划与晋级规则在 admission 封存；具体成员可在组内提名后按该规则实例化。先解析 `Q_bridge`，清单纳入入选候选 local 阶段全部必测任务的并集及 bridge 必需 guards，再按固定分层采样规则补至 `Q_bridge`；不能根据各候选分数挑对其有利的题。清单对全部入选者与 champion 相同，按全局任务权重在该共同子集上归一化，不沿用任何组的局部桶权重。

若该并集超过 `Q_bridge`，按预先固定的组配额顺序减少入选组并记录容量原因；若仍无法容纳一个组及必要 guards，本轮不扩评。bridge 总执行预算还需覆盖所有参与者的差集成本；容量够但费用不足时同样减少参与者或取消扩评，不临时减题。不得偷偷扩大为所有候选全量评测。所有参与者的 bridge 证据完整后才形成这一阶段的共同排名；执行失败或预算不足时保留原计划与 `insufficient-evidence`，不删除困难任务改变分母。

bridge 完整且满足其预声明扩大评测门的候选，按 bridge outcome 效用、可比过程效用、canonical ID 选出唯一 global nominee。默认扩大评测门检查 bridge 上已适用的 protected 要求以及 outcome/process 非退步，不要求实质改善；这些是扩大评测的启发式条件，不是全局发布结论。多过程量纲不能统一时分别检查下界，但不用于打破 outcome 并列。

v1 的 global nominee / finalist 仅从本轮 sealed candidates 中产生；都最多一个，也允许为空。global seed 或 held-out 未通过后，本轮不顺次尝试其他候选。历史 specialist 通过被抽为父代继续演化；v1 不直接让历史库候选反复挑战 held-out。

完整 seed precheck 的过程要求取决于 admission 解析的 promotion 能力。`promotion.process.mode: off` 或预声明不支持时省略过程完整性门及过程维度；provider 仍须证明 outcome 有效，不能绕过旧 observation invalid 合同。预算不足以完成全局证据时无自动晋升，已有局部前沿仍可提交。

每任务一次运行且有效 cells 可复用时，candidate seed rollout 的一般式为：`Σ_c n_local(c) + Σ_{c∈bridge}(n_bridge − n_local(c)) + (N − n_bridge)`；末项仅在存在 global nominee 时计入，且 bridge 包含这些候选已完成的完整 local 清单。计算使用实际去重清单数量，不使用未实现的抽样目标。

例如使用配置比例 local/shared/cross=`8%/4%/3%`、bridge=`40%`，各池充足、无额外 guards、无上限裁剪且去重后可回填；4 个 candidate、2 个 bridge 参与者、1 个 global nominee 的算术示意为：

| seed 全集 N | 每候选 local 阶段总任务 | 共同 bridge 任务 | candidate seed 新增 rollout | 各候选全量评测对照 |
| --- | ---: | ---: | ---: | ---: |
| 100 | 8 + 4 + 3 = 15 | 40 | 170 | 400 |
| 1,000 | 80 + 40 + 30 = 150 | 400 | 1,700 | 4,000 |

这些数值只展示比例如何随 N 缩放，不是固定数量或成本保证；初始 champion baseline、父代新 scope 补评、额外 guards、held-out、诊断和生成费用另计，全部仍受同一个总预算约束。

阶段筛选与发布分别使用接口，不能拿局部通过冒充完整 seed 通过：

```ts
interface PromotionPolicyV2 {
  precheckSeed(input: SeedPromotionInput): GateDecision;
  decideFinal(input: FinalPromotionInput): GateDecision;
}

interface EvaluationStageDecision {
  stagePlanDigest: string;
  candidateId: string;
  outcome: 'advance' | 'retained-local' | 'ineligible' | 'insufficient-evidence';
  reasonCodes: string[];
  supportDigest: string;
  nextStagePlanDigest?: string;
}

type GateDecision = {
  outcome: 'eligible' | 'accepted' | 'rejected' | 'insufficient-evidence';
  reasonCodes: string[];
  supportDigest: string;
  metricContractDigests: string[];
  comparison: object;
};
```

`precheckSeed` 仅接受完整 global seed，`decideFinal` 仅接受同一 finalist 的完整 seed 与 held-out。两个发布阶段共享指标、覆盖率和阈值实现；local / bridge 使用独立 StageDecision，注明支持范围。新模式不能先经过旧 `passesSeed` 的另一套硬编码门槛再调用该策略。

### 8.2 发布门顺序

以下规则和表格只决定完整全局验证的发布资格，不反向要求所有局部 archive 候选补齐全量任务。

1. **身份与有效性**：代码、任务、评分器、采样和逻辑 slots 满足合同；identity mismatch 是协议失败。
2. **完整性**：达到第 5 节要求；否则为 `insufficient-evidence`，不伪装成性能拒绝。
3. **受保护要求**：所有配置的 protected tasks 和 assertions 满足各自规则，缺失无法证明通过。
4. **结果下界**：seed 和 held-out 的 outcome 增益均不得低于封存容许退步值；默认均为 0。
5. **过程下界**：启用且适用的每个过程聚合组不得低于各自容许退步值；默认均为 0。
6. **实质改善**：seed outcome 严格超过 `minimumOutcomeGain`，或者完整、可比的 seed process 严格超过其 `minimumProcessGain`。默认阈值均为 0，比较使用封存 quantum。
7. **最终确认**：finalist 的 held-out 检查重复 1～5；通过后才允许 champion CAS。

结果-only 模式要求 outcome 实质改善；不会因为“没有过程分”而失去本来可成立的结果晋升资格。结果和过程同时持平默认拒绝，避免无收益替换。

过程通道在本策略中同时影响研究抽样、晋升下界与改善条件，具有独立作用。它既不能抵消 protected task / assertion 违反，也不能自动绕过结果下界。若显式配置允许少量 outcome regression，则过程改善可在该预算内支持晋升；这属于新 spec 的明确权衡，默认不启用。

多种过程量纲无法固定转换到同一效用尺度时，分组分别检查下界；“过程实质改善”要求至少一组严格改善且其他组不退步，不平均原始异构数值。

| 观测情况 | 默认发布决定 | 研究去向 |
| --- | --- | --- |
| outcome 改善，其他门通过 | seed eligible，held-out 通过后 accepted | 按前沿决定父代资格 |
| outcome 持平，process 改善，其他门通过 | 同上 | 同上 |
| outcome 改善，process 退步超限 | rejected | 仍可保留独特专长 |
| outcome 退步，process 改善 | rejected | 可留档并修复回归 |
| protected 要求违反 | rejected | 取决于独立 exploration guards |
| outcome/process 皆无实质变化 | rejected | 证据保留，通常剪除冗余 |
| 能力 unsupported，outcome 改善 | 结果-only 正常验证 | outcome 专长抽样 |
| 预期证据 missing / invalid | insufficient-evidence | pending；按规则补证据 |

### 8.3 Protected tasks / assertions

- task 规则显式选择 `no-regression` 或 `minimum-score`，并给出阈值、任务权重无关的判断和适用 partition。
- assertion 规则显式选择 `must-pass` 或 `no-new-violation`，绑定稳定 assertion identity / schema。要求不适用时必须有预声明依据。
- 这些门单独判断，不计入可被其他任务均分抵消的软奖励。
- 只提供 total score 的 benchmark 可使用 task 规则；不能要求它提供不存在的 assertions。
- seed protected 内容可以用于反思；held-out protected 内容仅控制面读取。

### 8.4 重复评测与独立验证

每任务的 repetitions、seed、聚合器与预算必须预先固定，baseline/candidate 使用相同逻辑重复计划。v1 不引入自适应“重跑直到赢”；有效零分和有效低分不能使用 infrastructure repair 接口重试。

若需要确认单次评测噪声，创建有明确预算的 confirmation plan，对 baseline 与 candidate 同时执行新增预定 slots，汇总全部指定样本。v1 首次实现可只支持 admission 时固定 repetitions，后续自适应确认另立协议；当前结果不宣称统计显著性。

新模式默认 `validationMode: independent-held-out`，要求 seed 与 held-out 的任务身份集合不相交；相同任务换目录或只换 phase 不构成独立验证。重复使用 held-out 的检查次数与预算必须记录；不把单次通过解释为未受反复选择影响的泛化估计。

显式 `shared-set-research` 可复现本案例的同集研究设置，但 v1 只能更新 archive 和生成 shadow promotion 建议，不自动更新 champion / published pointer。旧 evolution 已有同集晋升记录不受此规则追溯影响。

### 8.5 合并的边界

本版的“汇合”是候选进入共同评测与同一 archive；最终选择一个完整 Harness 版本。GEPA 的专长保留与父代抽样不会自动组合各分支能力，也不在线按任务切换 Harness。

后续可增加显式 crossover / merge operator：根据模块边界把互补改动合成一个新 candidate，保存来源父代、合并假设和冲突处理证据。但合成版本必须重新取得自己各阶段的证据，不能拼接 A 在任务一、B 在任务二的分数冒充合成版本表现；新增生成与评测也必须有独立预算。v1 不实现此 operator，不以自动合并为多 candidate 收益的前提。

## 9. 将失败转成版本化回归任务

### 9.1 失败提案

Gear 收集器必须核验业务失败的来源；基础设施 invalid 默认进入执行诊断，不自动物化为业务回归任务。新增任务须通过版本化套件与补评规则纳入后续实验，不直接叠加可增长 prompt 列表和旧评分向量。

Gear 默认关闭失败自动收集；显式启用后，收集器只产生提案，不修改当前 plan。提案至少包含：

```ts
interface RegressionProposal {
  id: string;
  source: { kind: 'seed-evaluation' | 'online-feedback'; evidenceRef: string };
  promptDigest: string;
  sanitizedPromptRef: string;
  fixtureRefs: string[];
  environmentRef?: string;
  expectedBehavior: string;
  graderRef?: string;
  failureCategory: string;
  deduplicationKey: string;
  status: 'proposed' | 'needs-fixture' | 'validated' | 'rejected';
}
```

收集必须限定来源、去重、限制数量并过滤凭证和不必要的个人数据；v1 默认提案上限 50，可在封存配置中修改。去重键包含任务语义、fixtures 和 grader 身份，不能仅靠相同 prompt 合并不同状态的任务。过滤后不能复现的内容标为 `needs-fixture`，不进入评分。

### 9.2 任务物化与门槛

提案只有具备以下内容才能进入 suite：可重建输入与环境、冻结 grader/判分标准、隔离执行方式、task digest、稳定失败重现记录或明确的反例验证记录。

代码任务应包含目标仓库 revision、必要输入、运行与测试环境；业务自动化任务应包含模拟服务初始状态和断言。只复制用户 prompt 不视为完成。

每个任务入集时明确其角色：

- `development`：参与下一实验的 seed、前沿与反思。
- `protected-regression`：仍为已知开发信息，并额外在发布时执行 no-regression / minimum-score 规则。

成为 protected 的严重程度与阈值须由预定义规则或显式操作者决定；不能由生成 candidate 的 Meta 自行降低。正常已知回归集不冒充独立 held-out。

### 9.3 不可变套件与新 evolution

`RegressionSuiteSnapshot` 封存成员 task digests、grader/环境身份、角色、保护规则、来源提案、父 suite digest、构建器版本和整体 digest。

第一版只在新 evolution admission 时纳入选定 suite：

```text
online / seed failure → proposal → reproducible task → suite vN
                                                   ↓
                           new EvolutionSpec + fixed seed/guard plan
```

运行中的 evolution 可以继续积累 proposals，但其 dataset、scorer、全局 task weights 和 promotion policy 不变。局部研究的 shared 子集从已冻结任务全集按第 6 节规则选取并封存，不要求每个 candidate 重跑整个回归 suite；完整发布验证仍覆盖全部适用 protected regression。局部子集通过不能宣称其他受保护任务已通过。

新 suite 上必须取得 champion 与 candidate 的成对证据。不能比较旧 suite 的 champion 均分与新 suite 的 candidate 均分。未变化 task 的 cell 只有在 provider 能证明完整条件身份等价时才可复用；不能推断现有整集缓存已支持跨 suite 复用。

不得自动从 held-out 失败生成对 Meta 可见的提案。若人为决定将某 held-out 样本转成开发任务，应建立新的数据划分与实验身份，该样本不再承担独立 held-out 验证作用。

## 10. 状态、接口与恢复

### 10.1 拟议状态

以下为概念模型，实现必须补充运行时校验与完整的 JSON schema，不可只增加 TypeScript 字段。

```ts
interface ResearchArchiveSnapshot {
  schemaVersion: 1;
  evolutionId: string;
  revision: number;
  cohortDigest: string;
  candidateRecordRefs: Array<{ candidateId: string; recordDigest: string }>;
  scopeViews: Array<{
    familyId: string;
    epoch: number;
    scopeDigest: string;
    outcomeEligibleIds: string[];
    processEligibleIds: string[];
    frontierRef: { digest: string; path: string };
    conditionalParentProbabilities: Record<string, number>;
    activeForSampling: boolean;
  }>;
  scopeProbabilities: Record<string, number>;
  activeParentIds: string[];
  parentProbabilities: Record<string, number>;
  pendingEvidenceIds: string[];
  digest: string;
}

interface ParentSelectionDecision {
  archiveDigest: string;
  algorithmRef: string;
  randomSeed: string;
  batches: Array<{
    batchId: string;
    sourceScopeDigest: string;
    parentCandidateId: string;
    parentCommit: string;
    parentSnapshotDigest: string;
    maxCandidateSlots: number;
    drawIndex: number;
  }>;
  digest: string;
}

interface DiagnosisDossier {
  parentSnapshotDigest: string;
  diagnosisPlanDigest: string;
  baselineEvidenceDigests: string[];
  diagnosisEntryRefs: string[];
  unresolvedTaskIds: string[];
  clusterRefs: string[];
  classifierIntegrity: string;
  coverageDigest: string;
  digest: string;
}

interface CandidateWorkPlan {
  candidateId: string;
  batchId: string;
  parentSnapshotDigest: string;
  dossierDigest: string;
  clusterDigest: string;
  hypothesisRef: string;
  requiredDiagnosisRefs: string[];
  modificationBoundaryRef: string;
  scopeDigest: string;
  localStagePlanDigest: string;
  generationBudgetRef: string;
  evaluationBudgetRef: string;
  digest: string;
}

interface StageEvaluationPlan {
  stage: 'baseline-probe' | 'local' | 'bridge' | 'global-seed' | 'held-out';
  universeDigest: string;
  taskSetSizeResolutionDigest: string;
  scopeDigest: string;
  taskSlotManifestRef: string;
  participantIds: string[];
  reusableCellRefs: string[];
  prerequisiteDecisionDigests: string[];
  selectionRuleDigest: string;
  budgetReservationRef: string;
  digest: string;
}

interface StageParticipantBinding {
  stagePlanDigest: string;
  participantId: string;
  sealedSnapshotDigest: string;
  digest: string;
}

interface PromotionNomination {
  candidateId?: string;
  championAnchorDigest: string;
  bridgeDecisionDigest?: string;
  globalSeedAssessmentDigest?: string;
  reasonCodes: string[];
  digest: string;
}
```

archive 分数、eligibility 和 fronts 由不可变 candidate evidence 派生；物化视图可重建。所有输出摘要注明 spec、算法、评分合同和 support digest，禁止存在另一个可手改的 score authority。

round v2 保存 `searchMode`、`archiveBaseDigest`、`parentSelectionDecision`、`generationParentSnapshots`、`promotionAnchor`、`diagnosisPlans / dossiers / clusters`、`workplans`、`stagePlans / decisions`、`archiveUpdateDecision`、`promotionNomination` 和统一 `budgetLedger`。阶段 plan 模板在 admission 固定，绑定具体参与者的实例在其依赖决策落盘后生成；恢复不得重新选择参与者。

workplan、sealed candidate 和评测计划用有向引用绑定，避免互相嵌入对方 digest 形成循环：local plan 在生成前固定参与者 ID，workplan 引用它；生成后追加 `StageParticipantBinding`，把该 plan 中的每个参与者绑定到唯一 sealed snapshot，再允许 rollout。后续 bridge/global plan 同样使用独立 binding，不能覆盖已绑定 commit。

`championParent` 的旧语义仅用于兼容读取。新模式的 champion seed parent snapshot 独立持久化，即使它不在 active archive 中也能恢复代码与 Meta 上下文。

### 10.2 组件合同

新增组件/API 版本必须封存 implementation integrity；旧 `apiVersion: 1` 不得在不换身份的情况下改变含义。

| 组件 | 新合同 |
| --- | --- |
| Evidence projector / assessor | 从公开 seed evidence 输出逐任务 outcome/process/constraints 与完整性；不覆写 outcome |
| Archive selector | 按 scope 消费历史/本轮证据，输出 scope fronts、归档决定及内外层概率；不决定 champion |
| Parent allocator | 输入已提交 archive，输出一次性可回放 parent batches 和配额；不预先伪造尚未诊断的工作计划 |
| Diagnosis coordinator | 复用实际父代 baseline，一次诊断生成有来源的 dossier，保存未解决项；不代替 candidate 的阅读行为 |
| Failure cluster planner / scope sampler | 用共享诊断生成可执行假设、实际 workplans 和同组统一任务范围；不按结果事后改组 |
| Candidate generator / Meta bridge | 独立 session 消费指定 workplan/dossier，绑定实际 parent 的 diff 和研究上下文；支持新消费 receipt |
| Stage scheduler / subset evaluator | 管理 local → bridge → global → held-out；任务级计划和身份可验证的 cell 复用；执行统一预算与阶段恢复 |
| Promotion policy v2 | 完整 seed precheck + final decision，始终比较固定 champion；不向 archive 暴露 held-out |
| Regression collector / materializer | proposal 与 suite 分离；不写运行中 dataset |

旧 `SelectionDecision.selectedCandidateIds` 与必填 `promotionCandidateId` 不适合承载新合同。新模式必须允许无 finalist，并独立验证历史 archive 成员及本轮 nomination，不能增加虚构 survivor 来满足旧校验。

### 10.3 提交与故障恢复

首次 bootstrap 在调用 candidate Meta 前执行：首次外部调用之前封存 initial anchor、bootstrap baseline plan、预算 reservation 和可恢复账本，费用计入首轮及 evolution 上限；再建立或复用初始 champion 的完整 seed baseline，验证 outcome 与探索资格，以只含 champion 的 bootstrap scope 提交初始 archive，然后分配首次 parent batch。bootstrap scope 只是初始化 fallback，不与后续失败组一起计入 π。baseline 未完成时只允许 baseline 执行/repair，不用虚构零分初始化 front。初始 champion 不满足探索门且没有其他合格父代时停止并报告原因。

首次分类产生失败组后，先通过 cell 身份校验把 champion baseline 投影到对应 scopes，再封存各 workplan。新组在本轮研究提交中替换 bootstrap scope。以后不为构造新 scope 强制全库或所有父代全量补评。

1. **Admission**：在唯一推进写者锁下读取已提交 archive/champion，落盘父代批次、anchor、规则和预算；恢复不重抽。
2. **Diagnosis / planning**：落盘 baseline/probe plans、dossiers、clusters 和取消槽位原因；在真实证据就绪后封存 workplans。停止/恢复继续同一规划实例，不借重新诊断刷新预算或换假设。
3. **Generation**：逐个记录读取凭据、检查和 sealed binding；本轮所有批次的候选都结算后才开始 local rollout。一个候选生成失败不强迫其他候选重新生成。
4. **Local**：按冻结清单执行并保存阶段结果与 archive 视图草稿。scope 证据不足保存 pending；其余已完整 scope 仍可形成研究决定。
5. **Expansion**：封存组配额和 bridge plan，完成共同比较后最多实例化一个 global seed plan；只有完整 seed 通过后才实例化对应 held-out plan。每一步使用剩余预算，不重新分配已消费额度。
6. **Research freeze**：根据本轮所有已结算的 seed stages 生成最终 archive update；字节与理由只由 seed 决定。没有 full seed 或没有 finalist 也可形成有效局部研究更新；后续 held-out 成败不改变它。
7. **Commit**：v2 `RoundCommitIntent` 同时记录 expected archive digest、next archive、expected champion revision/ref、可选 next champion snapshot，以及独立研究/发布结果。依次完成 archive CAS、可选 champion CAS 与 terminal round 标记；未完成 intent 先对账，禁止新 round 读取为稳定状态。
8. **Failure / recovery**：发布被拒绝仍可提交 archive；扩评执行失败时可提交已封存局部研究更新，另记 execution failure。crash recovery 只恢复原 stage / intent、父代与 finalist；CAS 冲突时阻塞，不偷换 champion 或重抽父代。

若外部动作改变 champion 而 archive 已提交，控制面保留已提交事实和冲突状态；恢复程序不得回滚或覆盖外部 champion。通过显式冲突处理结束旧 intent 后才能开始新的 round。

repair 按阶段区分：

- **阶段内 seed repair**：只修复该冻结计划内无效或缺产物的 slots；在首个消费对象（dossier、cluster/workplan 或 StageDecision）封存前重算派生结果。已经落盘的父代、dossier、工作分配不变；baseline/probe 已被消费后只能追加新的 evidence/dossier revision 供后续计划使用，不能修改当前 workplan 的诊断事实或已消费阶段结果。
- **Held-out repair**：允许在 seed update / finalist 已固定、commit intent 尚未建立时补齐无效 held-out slots，只重算 final gate。不得重选 finalist、改变 seed archive 或向 Meta 暴露修复细节。
- **Intent 之后**：只对账既有不可变证据引用与决定，不在同一 intent 中继续修复或改分。

历史 `pending-evidence` 必须有显式补齐出口：v1 增加独立的 `archive-evidence-completion` 计划，固定 candidate commit、原 stage/scope、evidence revision、缺失/invalid slots、条件与预算；它不调用 Meta、不修改代码、不执行 champion 晋升。计划在唯一推进写者锁下运行，复用所有有效 slots，只补原来已安排但无效或未运行的 slots，并追加带 `supersedesEvidenceDigest` 的新证据快照。下一次 archive update 接受该 completion ref，验证原有效值逐条未变，再更新 eligibility 和 fronts；来源 round 与旧 archive 快照保持原样。

原来 `not-evaluated` 的任务只允许进入新的 `archive-scope-expansion / StageEvaluationPlan`，不能伪装成历史 completion。局部 `n_local / n_local` 完整与 bridge `n_local / n_bridge` 待完成是两份不同结果；分母来自各自封存清单，后一阶段未完成不抹掉前一阶段的局部资格。进入新 scope 仍须完成其全部清单，新增 cells 不自动增加旧 scope 的抽样权重。

若 outcome 已有效、仅 process 缺失，只允许从同一次运行保留的原始产物中恢复经同一评分合同验证的过程证据，不能借 completion 重跑该有效 outcome 直到过程变好。没有足够原始产物时保留 process pending，另开带新重复计划的实验；不能把补齐伪装成基础设施 repair。completion 使用自身 idempotency key 和提交摘要，恢复后不重复执行已完成 slots。

## 11. 配置与迁移

### 11.1 新模式配置示意

以下配置由新模式解析并在 admission 时写入 spec；默认接入由 Gear 基于标准自包含 task dataset 准备子集、验证逐题结果和复用缓存，继续调用现有 evaluator。完整预算配置及接入方式见[实现说明](candidate-promotion-implementation.zh-CN.md)。

```yaml
candidateGeneration:
  maxCandidates: 4             # adaptive upper bound in the new mode
search:
  mode: failure-cluster-gepa-v1
  seed: 0
  parentBatchCount: 1
  parentSampling: scoped-frontier-membership-v1
  scopeWeights: uniform-by-family
  archiveCoverage: complete-scope
  diagnosis:
    sharing: parent-evidence-dossier
    planner: evidence-failure-clusters-v1
    candidatesPerFamily: 1
  taskSetSizing:
    basis: seed-universe
    rounding: ceil
    local:  { ratio: 0.08, minTasks: null, maxTasks: null }
    shared: { ratio: 0.04, minTasks: null, maxTasks: null }
    cross:  { ratio: 0.03, minTasks: null, maxTasks: null }
    bridge: { ratio: 0.40, minTasks: null, maxTasks: null }
  scopeSampling:
    bucketWeights: { local: 0.6, shared: 0.25, cross: 0.15 }
    epochPolicy: stable
  evaluationStages:
    bridge:
      maxCandidates: 2
      groupAllocation: weighted-round-robin
      taskSelection: nominated-scopes-union-then-stratified
    globalSeed:
      maxCandidates: 1
    reuseValidCells: true
  process:
    mode: auto
    parentBudgetFraction: 0.25
  globalTaskWeights: uniform
  explorationGuards: []
promotion:
  policy: paired-multisignal-v1
  validationMode: independent-held-out
  outcome:
    minimumGain: 0             # strict gain after fixed-precision comparison
    maxSeedRegression: 0
    maxHeldOutRegression: 0
  process:
    mode: auto
    minimumGain: 0
    maxSeedRegression: 0
    maxHeldOutRegression: 0
  allowNeutral: false
  protectedTasks: []
  protectedAssertions: []
regression:
  collectFailures: false
  maxProposals: 50
  suiteRef: null
budgets:
  round:
    maxNewRolloutCells: 500    # illustrative cap, includes every stage and baseline
    maxDiagnosisInputTokens: 100000
    maxDiagnosisOutputTokens: 20000
```

数字均为设计起点或示意上限，实际预算必须结合 benchmark 每题成本封存；500 cells 不是默认获批的推理额度。生成、Target 单次运行、repair、held-out 与 evolution 累计预算仍需显式配置，不能因示例省略而解释为无限。父代/候选新执行的 cells 都计费；缓存命中单独计数。基础设施 retry 不增加统计样本数，但实际推理、时间和费用仍计入总账及 repair 上限。local、bridge、global、held-out 先预留可负担额度，不足时减少候选/扩评配额并给出计划；允许明确只预留研究预算并关闭本轮发布扩评，不先生成大量候选再隐瞒无法验证。

所有任务集合数量仅由 `taskSetSizing` 统一解析；不再保留固定的 `localTasks / sharedTasks / crossTasks / bridge.targetTasks` 配置源。示例限额为 null，表示只按比例和任务供给计算；操作者可显式设置 minTasks / maxTasks 控制小集下限或大集成本。bridge 使用解析后的 `Q_bridge` 作为目标与容量上限，第 8.1 节的并集/guards 无法容纳时按封存组分配次序减少参与者。

任务集合规模与候选数量是两个维度。`maxCandidates` 是新模式的实际生成上限，不能同时套用旧 generator 的恰好槽位数合同；`parentBatchCount` 必须不大于该上限，batch 配额之和不能超限。

archive 与 promotion 的 process `auto` 使用同一能力解析，但消费目的不同；显式 `off` 可以单独禁用某一用途。若启用多组量纲，gain/regression 阈值必须按 contract group 配置，不能使用含义不明的一个全局数值。task normalization、quantum 和 repetitions 来自封存评测合同，不依赖此示意中的省略值。

`allowNeutral: true` 仅允许完全满足各门且 outcome/process 均无实质变化时替换，不允许突破回归下界；默认 false。

### 11.2 兼容要求

- 缺少新字段的历史 spec 按其原有 schema、组件和 champion-only 合同读取。继续运行不读取新全局默认值。
- 新模式必须通过新 evolution 显式选择；不改写案例 `cf603144-...` 的 spec、population、champion 或任何历史 verdict。
- 此次修订将尚未实现的草案模式名 `specialist-archive-v1` 改为 `failure-cluster-gepa-v1`，不代表存在需迁移的历史状态。旧模式 `maxCandidates` 默认 1 和恰好槽位数校验保持；新模式显式采用分类后确定的 `0..maxCandidates`。
- provider 必须支持可验证的 subset plans / cell reuse，新模式才能减少 rollout；能力不足在 admission 明确拒绝，不声称已节省推理。无过程能力本身不是拒绝原因。
- 旧 `paired-gate` 保留允许零增益和部分交集的原语义；新模式结果-only 的“严格改善”属于明确新策略，不伪称所有旧实验会保持相同 verdict。
- 原生 benchmark 不提供过程分是合法输入；新配置能力解析必须在评测前发现 `required` 不支持，不能运行完再拒绝全部 candidate。
- 新 evolution 可以显式以旧 champion commit 作为 initial harness；v1 不自动导入旧 archive、Meta 私有历史或跨 evolution evidence。跨实验导入需独立的身份校验合同。
- 旧历史可通过只读 shadow replay 研究策略；回放输出必须标记 `advisory`，没有真实新 champion，也没有未运行的 held-out 证据。

## 12. 可观测性与实现计划

每个 candidate 的状态页至少分别显示：父代与 champion anchor、失败类别与修改假设、dossier/workplan、当前 scope/阶段、范围内结果与可选过程均值、覆盖率与全局未评数量、任务胜负变化、局部前沿、分组与总父代概率、研究资格、扩评决定、完整发布决定及原因。明确区分“未安排评测”“计划内待补证据”“未获扩评配额”“发布被拒绝”。没有过程能力显示“不提供”，不能用 0 或绿色通过代替。

round 视图同时列出 seed 全集 N、任务规模比例/限额/解析数量/实际数量及裁剪原因、有效失败组数量、实际 K / 上限、共享诊断覆盖与复用次数、各阶段计划/新增/复用 cells、生成/诊断/评测费用和剩余预算。节约量使用同一执行条件下的明确对照计算，不能把未验证任务或生成失败算成质量提升。

研究页面不得借由父代概率、front labels 或 ResearchFinding 暴露 held-out 信息；操作者的私有 promotion 详情使用独立投影。`experiments.tsv` 是视图，不能成为恢复或评分权威。

实施顺序：

1. **证据与只读回放**：补充 metric contract、availability、task profile 与 support digest；离线重放案例历史，验证过程兼容和断言变化，不改变状态。
2. **共享诊断与多候选规划**：拆分 admission / evidence planner，定义 dossier、分类、workplan、消费 receipt 与实际 K；从同一父代按不同假设生成独立候选，替换新模式重复全失败读取门。
3. **局部 Archive 与评测调度**：subset plans / cell reuse、scope fronts、两层抽样、parent baseline 差集、bridge 扩评与统一预算；实现独立 champion snapshot 和真实研究交接。
4. **晋升与事务**：单一 global nominee、完整 seed/held-out 门、v2 commit intent、分阶段恢复、状态投影和旧 schema 兼容。
5. **回归任务**：proposal、物化验证、suite snapshot、new evolution admission、protected task 接入。

阶段 1～4 才构成可运行的新搜索/晋升模式；只提高 `maxCandidates`、替换 selector 或完成状态展示不得标记本 spec 已实现。第 5 阶段可独立上线，失败收集默认关闭。

实现位置主要涉及 `src/types.ts`、`src/config.ts`、`src/evolution/components.ts`、`src/refine/service.ts`、`src/refine/finalization-readiness.ts`、`src/refine/champion-parent.ts`、`src/refine/baseline-reuse.ts`、`src/state/store.ts`、`src/state/evolution.ts`、`src/state/experiments.ts`、`src/meta/skill.ts`、`src/skill/control-plane.ts`、`src/capabilities.ts` 及 evaluator 的证据投影。按职责新增 diagnosis / workplan / scope archive / stage scheduler / metric profile / regression suite 模块，避免继续扩大 service 中的算法逻辑。

## 13. 验收矩阵

测试必须使用自包含合成 fixtures；本机 evolution 只用于可选离线审计，不成为 CI 依赖。

| ID | 场景 | 必须验证 |
| --- | --- | --- |
| A01 | A/B/C 三任务示例 | A/B 留档，C 无父代权重，纯结果概率 2/3 与 1/3 |
| A02 | 并列第一、联合冗余覆盖 | 保留前沿覆盖；按 membership 总数归一化；剪枝顺序可回放 |
| A03 | 全 0、全 1 或全同分 | 不虚构专长；执行有资格检查的确定性 fallback，无合格父代时 blocked |
| A04 | 跨轮历史 specialist | 新一轮没有重新生成 B，B 仍保留且可被抽到 |
| A05 | 低 outcome、高 process | 可进入过程前沿；默认不得用其过程增益抵消发布结果退步 |
| A06 | 同 tree 不同 commit/评分 | 不择优挑随机结果，不丢 lineage / 原始证据 |
| A07 | archive 容量与冠军保活 | 不静默丢唯一专长；champion 被剪枝后仍可恢复 |
| A08 | exploration guard 与 bootstrap | 不合格候选不占前沿；首次 baseline 完整后才能调用 Meta，fallback 不绕门 |
| A09 | 候选只完成 15/100 全局任务 | 15/15 scope 完整可进入局部前沿；其余 85 道为未评，不计零、不阻塞局部父代资格 |
| A10 | 不同组难度、范围或规模不同 | 只在同 scope 比较；外层组权重与内层 membership 分开，局部高均值不能抢全局名额 |
| A11 | 同一候选多跑额外任务 | 不自动增加旧 scope 权重；进入另一 scope 必须补齐其全部清单；重复/改名 scope 不扩权 |
| A12 | scope epoch 更新 | 新旧视图不可变；预算内补差集，只有一个 epoch 参与该组抽样；预算不足保留旧 epoch |
| D01 | 同一父代 3 类有效失败、上限 4 | 生成 3 个不同 workplans；不凑第四个、不每题一候选；各自 scope/假设可审计 |
| D02 | 多父代 / 重复抽中同父代 | dossier 绑定实际父代；同父代证据复用，不用 champion 失败冒充 specialist 失败 |
| D03 | 分类未知、只有 total score、基础设施 invalid | 不虚构过程分或共同根因；合法结果路径与 unresolved 分开，invalid 进入执行修复 |
| D04 | 共享诊断与候选读取 | coordinator 的诊断不伪装为每个 candidate 的全量阅读；候选必须消费自身 workplan/dossier，旧 receipt 规则保持 |
| D05 | 零个可执行类别、生成重试或超预算 | K 可为 0；重试仍为原 candidate；数量、时间、token、cells 均不因重规划刷新 |
| D06 | 扩大 scope 的 baseline 推翻假设 | 封存 workplan 前取消并给理由；不编造诊断，不无限补评重聚类 |
| D07 | 独立 sibling 生成与越界修改 | 单代码父代；本轮 sibling 结果不可用于封存前反思；越界触发预声明更广评测门 |
| E01 | 比例配置下 N=100 / 1,000，4→2→1 候选扩评 | 满足供给、身份与嵌套条件时 candidate seed 新增 cells 分别为 170 / 1,700；held-out/baseline/诊断另计，未选者保留局部专长 |
| E02 | 跨组 bridge 比较 | 全部参与者与 champion 用同一完整清单、同一权重；不得比较不同组均值或删掉缺证据题 |
| E03 | bridge 并集或 guards 超上限 | 按预定组配额减少参与者或不扩评；不隐式对全部候选全量运行 |
| E04 | global/held-out 失败或预算不足 | 本轮不换下一个 finalist 重试；研究更新保留，性能拒绝/预算不足/执行故障分别记录 |
| E05 | 局部平均退步但有独特改善 | 不被“严格胜过父代”前置门抹去专长；局部资格不冒充完整 seed 通过 |
| E06 | Gear 子集执行与逐题复用 | 默认通过现有 evaluator 完成 4→2→1；无需 Hitch 声明。源任务身份或结果槽位不可验证时拒绝，不使用整集缓存假扮 cell 复用；合法无 process 不受牵连 |
| E07 | 互补候选 A/B | 前沿保留两者不代表已产生合成能力；任何显式合成版本不得拼接来源分数 |
| E08 | 比例取整与可选限额 | 固定精度计算 ceil(N×ratio)，显式 min/max 生效且不超过 N；不把 bucketWeights 当规模比例 |
| E09 | 小全集、空任务池、任务重叠 | 去重/同桶回填后按实际清单计分；不足不复制任务，取整超额按固定顺序裁剪并保存原因 |
| E10 | 非法比例/限额、空 seed、关闭某桶 | 越界、非有限比例、局部比例和大于 1、负或冲突限额明确拒绝；零比例不暗中抽题，必需 core/guards 不被豁免 |
| E11 | bridge 按比例不足以容纳并集/guards | 减少参与者或本轮不扩评，不改比例、不删必测任务、不临时突破总费用 |
| E12 | 规模解析后 resume / 新全集版本 | 原 N、比例、取整结果和清单可回放；更换全集只在新 admission 重算 |
| P01 | 子代优于研究父代、弱于 champion | 研究与发布决定不同，比较对象身份正确 |
| P02 | 宏平均最优但没有任务第一 | 可独立提名并晋升，不强制属于 active parent set |
| P03 | outcome 持平、过程改善 | 两阶段策略均可识别；不存在旧 seed gate 提前拦截 |
| P04 | outcome 改善、过程回归 | 过程下界生效，不能仅凭结果接受 |
| P05 | protected task / assertion 退步 | 其他任务改善不能抵消；没有 assertion 的 benchmark 可用 task 保护 |
| P06 | outcome-only 严格改善 / 完全中性 | 前者正常验证；后者按新策略拒绝，旧策略结果不变 |
| P07 | seed 与 held-out 同集或同内容不同路径 | 独立验证模式拒绝该配置；shared 模式只提交研究与建议 |
| M01 | 不支持 process / dataset-aggregate | 不增加虚构字段或 LLM 请求；合法结果路径 |
| M01b | trial scalar、detail_status=aggregate-only | 保留过程前沿与晋升资格，只缺 assertion 级能力 |
| M02 | 混合 benchmark process 适用范围 | 仅按预声明集合比较，不惩罚无过程任务、不动态改分母 |
| M03 | process=0 / missing / invalid | 三种语义严格区分；已声明能力缺失不能自动降级 |
| M04 | process 部分缺失、candidate 子集不同 | 不用局部均值冒充完整比较；显示 coverage 和 pending |
| M05 | direction/range/scorer/quantum 改变 | 不同合同不配对；minimize 增益方向正确；并列关系可传递 |
| M06 | projection / repair 后不能聚合 | 移除旧 aggregate，不残留旧顶层 processScore |
| M07 | 不同重复次数、retry 与有效零分 | 按任务宏平均；retry 不增加统计权重；零分不作为 repair 对象 |
| M08 | 新旧 observation schema、promotion process off | 旧 invalid 不被抢救；v2 独立有效 outcome 在 process off 时可正常晋升 |
| M09 | 多过程量纲的 outcome 并列 | 不合成临时过程均分；按 v1 固定规则确定 finalist |
| M10 | 局部不适用 process，全局部分适用 | scope process 集合可以为空，局部按 outcome；全局完整性仍按其预声明适用任务判断 |
| R01 | restart / resume / repair | 复用同一次抽样、父代与基线；不重复消费有效 Target 运行 |
| R02 | archive CAS 后 crash、champion CAS 后 crash | 对账原 intent，无重复发布、重新抽签或半提交读取 |
| R03 | champion 并发变更 | 明确冲突，不覆盖外部版本、不偷换比较 anchor |
| R04 | held-out 执行故障 | 有效 seed archive 可保留，故障不伪装为性能拒绝 |
| R05 | Skill 模式空 checkpoint | 必须能读取实际 findings/交接内容，而非只验证 session ID |
| R06 | seed 已封存后的 held-out repair | 只补无效 held-out slots；finalist、父代、seed archive 不变 |
| R07 | 历史 pending completion | 新证据版本使候选获得资格；旧有效值、旧 round 和旧 archive 均不变 |
| R08 | diagnosis/workplan/各 rung 后崩溃 | 两次冻结、工作分配、参与者、任务清单与预算可回放，不重复生成或重抽任务 |
| R09 | n_local/n_local 完整，bridge n_local/n_bridge 未完 | 分母取各自参数化后封存的实际清单；local 资格保持，扩展不是 repair，旧阶段决定不被改写 |
| R10 | stage 决策已消费后收到补证据 | 只能追加新 revision，不能修改旧 shortlist/nominee 或本轮已封存决定 |
| G01 | 在线失败只有 prompt | 留在 needs-fixture，不纳入评测，不修改运行中 spec |
| G02 | 提案重复、含凭证、超上限 | 按封存规则处理，有原因和来源，不能漏进任务集 |
| G03 | suite 新版本 | 只在新实验启用；champion/candidate 同套件配对，旧均分不复用冒充 |
| G04 | held-out 失败 | 不进入 Meta 可见提案/研究概率；显式转开发后不再视为 held-out |
| C01 | 历史 spec / round / component v1 | 原 champion-only、部分证据、基线复用与恢复测试保持 |
| C02 | 案例 shadow replay | 历史文件字节不变；所有建议带 advisory，未声称实际晋升 |

完成条件：上述合同通过有意义的单元、状态恢复及组件集成测试；完整流程同时跑通 outcome-only benchmark fixture 和 outcome+process fixture；配置、API、状态展示及相关既有规范同步更新后，才将本文状态改为 Implemented。

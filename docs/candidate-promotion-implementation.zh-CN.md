# Candidate 晋升策略实现与接入

## 算法扩展入口

新增父代策略、公开测试工具和包消费示例见 [搜索算法作者指南](search-algorithm-authoring.zh-CN.md)。下文说明内置流程与接入方式；插件扩展应使用作者指南中的 `search/api`、`search/presets/failure-cluster-gepa` 和 `search/testing` 入口。

新增可选的 [champion 与 GEPA 混合父代抽样](champion-gepa-parent-sampling.zh-CN.md)：默认 50% 直接选择当前 champion，剩余 50% 按 GEPA 权重抽样；每个候选独立选择父代。以下未特别说明的 scope membership 规则描述原策略及新策略的 GEPA 探索分支。

`failure-cluster-gepa-v1` 实现 Gear 搜索驱动、控制面接入和独立晋升策略。仅对新建 evolution 显式启用；没有 `searchSettings` 的历史 spec 保持原路径、组件身份和 verdict。

默认路径由 Gear 内部处理分阶段评测，不需要为 Hitch 新增协议、参数或能力声明。

## 已接入的流程

首次完整 seed baseline → 固定 archive/champion/父代批次 → 共享失败诊断 → 冻结实际工作计划 → 独立生成候选 → 局部评测与专长归档 → 共同 bridge → 唯一 global nominee → 完整 seed/held-out → archive CAS 与可选 champion CAS。

- local/shared/cross/bridge 均根据去重 seed 全集计算比例，支持可选 min/max，精确十进制向上取整。任务数与桶计分权重独立。
- outcome/process 分别建立逐任务前沿，以 scope 权重和 membership 概率抽父代。全同分使用有资格检查的确定性 fallback，历史专长和原始证据保留。
- 可选周期 scope 更新在 workplan 封存前完成准备，提交后的新视图供下一轮抽样；必要预算不足或证据不合格保留旧 epoch。
- scope 的语义身份从任务、权重和 guards 重算；等价范围合并证据与抽样机会。每份局部计划必须覆盖完整 scope，跨计划的同一有效 cell 不得出现冲突值；较旧的 missing 视图仍可保存，不覆盖已补齐资格。
- 全局与 bridge 按 `globalTaskWeights: uniform` 做逐任务等权宏平均；provider 的 task weight 不改变这项策略。scope 仍使用自己冻结的桶权重。
- bridge → global-seed 不因过程分退步而否决候选，最多一个候选进入全量评测。全量晋升标准为：默认 outcome 和每个可比较的过程组都不能退步，且 outcome 或过程至少一项严格提升；outcome 提升不能豁免过程分退步。比较继续使用冻结的量化整数键，并遵守配置中的 `minimumGain`、回退容差与 `allowNeutral`。完整证据与保护任务/断言检查仍生效，独立 held-out 保留非退步复核。shared-set research 的显式 champion CAS 仍需满足相应配置条件。
- `SearchTask.repetitionIndices` 可选择全局逻辑 repetition manifest 的非空子集；省略时使用全部 slots。重复更多的任务不获得更多统计权重，计划费用、coverage 和配对均按各任务实际 slots 计算，任务规模比例仍基于 N。
- 过程能力在 admission 解析。原生 outcome-only、逐 trial scalar、过程缺失和旧版整条 invalid 分开处理；新模式不会添加 LLM judge。
- 每个候选领取自己的工作计划、有来源的 dossier 摘要、共享约束和父代 findings。Skill claim 和 DSH 投递产生独立消费凭据，不填充伪造的旧诊断 receipts。修改边界是相对 harness 根目录的路径。
- `SearchExecutionHooks.generate` 接收冻结的 `baselineContext`（universe、plan、scope 和过程模式）。Meta 基线只能投影完整 planned outcome；摘要按任务及 scope 权重计算，逻辑 slots 单独计数。只有单一、完整、可聚合的过程组才产生顶层过程均分。Skill 同时收到 `plannedTrialCount` 和 `scoringContext`，新模式的存储校验重算这些摘要，旧模式校验不变。
- 所有候选生成结束后才评测。重试共享工作计划和总生成预算；显式配置 token/request 限额时要求 Meta 适配器可强制执行。DSH 的独立计量支持普通与 context offloading 两条路径；Skill 可以省略这些可选限额运行，显式不支持的限额仍拒绝接纳。账本按完整、可执行的 reservation 保守计费，不把该上界宣称为实测用量。
- 阶段计划、bindings、诊断、提名、结果和 commit intent 使用内容摘要持久化。每次外部执行先冻结请求和预算 reservation，provider 使用幂等键恢复；部分 cell 已写入或诊断已结算时的中断不会重算请求或重新执行。
- evolution 级规则和任务身份跨轮固定，存在未解决 round 时不能新开 round。cell 缓存按 exact commit/manifest 与执行条件寻址，保留原始 snapshot 来源，候选角色或谱系标签变化不产生新执行槽位。
- bridge 预算按所有参与者的实际缺失 cells 与 repair 成本计算，已完成的 local cells 不重复收费；组配额、容量不足和费用不足分别记录。
- held-out 前先冻结 seed research；缺失 held-out 可以在 intent 之前补评。历史局部证据通过独立 completion 追加 revision，有效零分和有效过程分不可替换。
- `shared-set-research` 默认只生成研究更新和 advisory 决定。明确配置 `promotion.allowSharedSetPromotion: true` 后，达标候选可通过原有 CAS 更新研究 champion；此时结果不再是仅建议，`advisory` 为 false，`validationMode: shared-set-research` 保留共享研究集标记，不声称具有独立 held-out 验证。未配置该选项的旧流程行为不变。
- 回归收集默认关闭。provider 可声明冻结的 `regressionTemplate`；有效 seed 业务失败进入过滤、去重、有容量限制的 proposal 队列。提案包含 prompt digest 和已过滤内容对象引用；收集器同步持久化对应对象。物化 suite 必须经可重现性验证，只能在新 admission 纳入。

## 代表任务采样

新 scope 从封存的父代 baseline 和已提交 seed history 构造 `ScopeSamplingEvidence`，记录历史截止点、诊断 cluster digests 与任务特征；scope 保存 `samplingEvidenceDigest`。当前 sibling 结果不会进入本轮采样。已有 scope 继续沿用原清单，仅在配置的 epoch 边界更新。

local 先覆盖不同诊断子模式与受影响模块，再按历史难度和预计成本分层挑选。历史难度只统计逻辑 slots 完整的代码版本，同一次执行跨计划出现时不重复计数。存在相关成功反例且 local 名额允许时，至少保留一个；配额不足和无足够任务分别留原因码。shared 仍先纳入预声明核心，再从实际父代成功任务按能力类别选取，整个 epoch 共用。

cross 对其他类别实行等权轮转，组内优先抽查共享修改模块的任务，再使用难度/成本顺序；无足够其他类别时从剩余 seed 抽取，记录 `general-seed-sampling-fallback`。三桶去重，所有数量仍由冻结的 N × ratio 决定，guards 单独加入。

## 阶段状态与决定

`RefineService.status` 返回的 `searchProgress` 是 seed 状态投影：当前研究阶段、各 participant 的计划 cells、运行/已结算状态、逐任务结果与 coverage，以及已封存的 local/bridge 决定。held-out 开始前阶段停在 `seed-research-complete`，该投影不包含 held-out 计划、证据或执行用量。操作员单独看到的 `searchPendingOperation` 保持原恢复用途。

`research.stageDecisions` 与状态投影使用同一组 `EvaluationStageDecision`。每项绑定 `stagePlanDigest`、candidate、可读取的 `supportDigest`、原因码和可选下一计划引用。local 证据完整但未获扩评名额时记录 `retained-local`；缺证据记录 `insufficient-evidence`；越过修改范围记录 `ineligible / requires-broader-evaluation`。bridge 有未完成 participant 时不挑另一个 finalist。范围更大的评测尚未完成不撤销已证明的局部专长。

每份 workplan 在生成前封存 `modificationBoundaryRule`：越界修改要求完整 seed 清单，原 local plan 没有覆盖时仅保留研究结果，不能凭狭窄范围继续发布。允许用新的 admission 预先安排全 seed 范围；若本轮冻结 scope 已覆盖全集，完成原计划后可进入通常的 bridge/global/held-out 门。实际变更路径与越界原因均保存，不在看到结果后临时缩减或扩大清单。

生成尝试之间退出后，恢复保留原 candidate、workplan、父代、已失败 attempt、总截止时间及预算 reservation；只执行剩余尝试。终态写入后退出的恢复会清理所属 active-round 标记。阶段参与者绑定、工作计划、诊断、archive、预算账本和 commit intent 均有运行时结构校验，配合现有的摘要、完整性、来源与条件语义校验。

## 不可变回归套件

新实验设置 `regression.suiteRef` 时，seed provider 必须同时返回匹配的 `TaskUniverse.regressionSuiteDigest` 和完整 `regressionSuite` manifest，并通过 `verifyRegressionSuite` 证明任务、grader、环境等已实际物化。只提供 digest 不足以接入；每个成员必须匹配 seed 的任务 ID 和内容 digest，已知 suite 不得作为 held-out。

`resolveRegressionSettings` 在 admission 合并所有 `protected-regression` 的明确 seed guard，保留已有 operator 规则。完全相同的 guard 去重，不用较弱规则替换较强规则；不同规则同时执行。`development` 成员参与 seed，不隐式变成硬门。控制面将合并后的策略写入新 `EvolutionSpec`；独立 SDK 另行封存 `resolvedSettings`。运行参数、源数据与已存在 evolution 的策略不变，换 suite 必须建立新 evolution 并取得成对 baseline/candidate 证据。

独立使用 `collectFailure` 的调用方可用 `sanitizedRegressionPrompt` 取得提案引用的内容对象并一并保存。`materializeSuite` 验证来源提案、角色、保护规则、可重现输入与验证记录；验证回调收到副本，不能更改已封存套件。

## Scope 周期更新

默认 `scopeSampling.epochPolicy: stable` 继续沿用旧范围。新实验可配置：

```yaml
search:
  scopeSampling:
    epochPolicy: periodic
    updateEveryRounds: 5
    maxHistoricalSpecialists: 1
```

`updateEveryRounds` 为正整数，首轮为 index 0，在 index 5、10 等规划边界准备新范围。候选数量与任务比例仍按原独立配置计算；`maxHistoricalSpecialists` 只限制额外补证的历史专长版本，可为 0。

每次更新先冻结历史 archive 截止点、共享任务清单、family 历史诊断、原抽样决定、新范围与计划参与者。champion 和本轮实际抽中的代码父代为必要参与者，额外历史版本按旧 membership 排序选择；先按缓存差集检查预算，再执行。必要证据不足或探索门不通过时保留旧 epoch。预算不足可以在执行前减少额外历史版本，不能缩小已冻结任务清单。

`research.scopePreparation` 显示范围、参与者及 prepared、unchanged、budget-insufficient、baseline-ineligible 等原因。新视图只在本轮 archive 提交后供下一轮抽样；本轮父代抽签仍绑定旧 archive。原 scope、原证据、原概率所在的历史 archive 均保留，同一 family 仅一个 epoch 占外层权重。

## 默认接入与自定义 provider

启用 `search.mode: failure-cluster-gepa-v1` 后，`RefineService` 自动为普通 `RefineEvaluator` 包装 Gear 内部的 `EvaluationSearchAdapter`。原 evaluator 对象不被修改；已经注入 `RefineEvaluator.search` 的自定义实现继续使用原路径。

默认输入为现有标准 compiler 生成的本地自包含 task dataset，包含 `benchmark.adapter.json` 和各题的 `task.toml`。Gear 从评分声明解析 outcome/process 合同，对原文件和逐题内容计算摘要；源数据变化、任务目录不完整或评分声明非法会在评测前拒绝。远程引用须先解析成本地标准数据集。这是 Gear 的输入准备条件。

阶段调度只把缺少证据的任务复制到 evolution 的 `search/datasets/<digest>`，复制后再次核验内容，原目录保持只读。每个逻辑 repetition 通过现有 `evaluate` 发起普通单次评测，模型、采样、超时及代码版本沿用原计划。未显式指定随机种子时记录 `seed: null`，不伪造受控随机种子。新调用不会重复执行已经有效的逻辑槽位。

Gear 在外部调用前持久化请求、提交意图和 reservation；完成后封存原始结果，核对 exact commit、配置、子集、任务及 attempt 身份。Hitch 路径直接复用已有 `eval run` / daemon submit/watch，恢复使用 Gear 新增的通用只读 `inspectResult` 端口，其实现调用 Hitch 已有 `eval inspect --json`。不修改 Hitch 程序或 CLI 协议。提交结果不明且无法恢复原 reservation 时保持 unknown，不新建评测。

直接模式在执行前冻结实际配置。daemon 模式通过 Gear 的 `submittedEvaluationIdentity` 读取已有提交记录中的实际执行配置，在接纳结果前将所有 seed/held-out batch 绑定到同一 cohort；不同候选和任务子集不改变这个共享配置摘要。配置漂移的提交会被拒绝并取消，旧证据不能与新配置的结果混用。这使 daemon 无需在提交前提供它原本没有的身份查询能力。

默认共享诊断读取已有 verifier 产物，仅用具体失败 code/component ID 建立有来源的研究假设，修改边界取实际 harness manifest。没有有效诊断证据时保持 unresolved（可能 K=0），不把低总分强行归为同一根因；不新增 LLM judge。结果通道合法且 benchmark 未声明 process 时可完整评测和晋升。旧 observation 整条 invalid 的语义保留。

高级用法可继续通过 `RefineEvaluator.search` 注入 `{ provider, diagnosis }`，提供其他数据源、诊断方式、回归 suite 或独立 v2 证据。这些扩展合同属于 Gear 搜索模块，Hitch 不需要对外声明它们。

`SearchProvider` 必须提供：

1. `describe('seed' | 'held-out')`：冻结 task content、metric contract、模型/采样/环境/评分条件、逻辑 repetitions、稳定分层与成本估计。
2. `capabilities`：Gear 内部或自定义 provider 对 task subset plans、batch-independent cells、idempotent execution 的保证；默认包装自行实现，不读取 Hitch capability flags。
3. `evaluate`：只执行列出的 cells；同一幂等键必须恢复同一执行，不能创建新随机尝试；遵守 abort 与调用预算。
4. `verifyCell`：验证实际产物来源、任务/评分/执行条件及 `harnessCommit/harnessManifestDigest`，不能只相信 Gear 提交的字段。`snapshotDigest` 保留原始证据来源；另一角色复用时，必须证明 exact commit、manifest 和其余执行身份全部相同，不能仅凭同 tree 替代。
5. 可选 `inspectEvaluation` / `inspectProcess`：按原幂等键只读查询已存在操作，返回 complete、not-started、running（原 handle）或 unknown。查询不能新建或重启 Target。超时后只有这类查询可用于恢复；没有查询能力时保留 unknown，不能猜测远端已经停止。
6. 可选 `completeProcess`：只从原 run 产物恢复过程证据，不重跑有效 outcome。
7. 启用 `suiteRef` 时，用 `verifyRegressionSuite` 证明整个版本化 suite 已纳入该新 seed universe。

`evaluate` 的普通异常被视为传输/执行状态不明。只有 provider 核实外部操作已终止后，才可抛出带 `code`、`evidenceRef` 和可选部分 cells 的 `SearchExecutionFailure`；有效 cells 继续保留，发布门记录执行不可用。已确认失败、预算不足和性能拒绝分别记录。

`DiagnosisProvider.inspectDiagnosis` 和 `SearchExecutionHooks.inspectGeneration` 使用相同的只读恢复约定。诊断、生成、评测、补评和原产物过程恢复均先记录 reservation，之后结算结果；未知操作保持原预算预留，不能靠重试或换标签刷新额度。

`DiagnosisProvider` 接收实际父代的 seed cells 和预算，返回有证据引用的失败机制/假设/修改边界或 unresolved。它的实现和清洗策略摘要均冻结；不能把所有零分自动分为同一原因。生成的摘要只投递相关类别与共享任务内容。

完整类型及运行时结构 schema 见 [`src/search/types.ts`](../src/search/types.ts) 和 [`src/search/schema.json`](../src/search/schema.json)。结构校验之外仍执行 metric、预算、task applicability、Git/证据身份等语义校验。通过 `node scripts/generate-search-schema.mjs` 重建 schema。

## 配置

以下合并到正常 Gear 配置中。预算值只是示例，须按实际任务成本设置；不会修改旧 evolution 的冻结配置。

```yaml
candidateGeneration:
  maxCandidates: 4
search:
  mode: failure-cluster-gepa-v1
  seed: 0
  taskSetSizing:
    local:  { ratio: 0.08 }
    shared: { ratio: 0.04 }
    cross:  { ratio: 0.03 }
    bridge: { ratio: 0.40 }
promotion:
  policy: paired-multisignal-v1
  validationMode: independent-held-out
  process:
    mode: auto
budgets:
  round:
    maxNewRolloutCells: 500
    maxDiagnosisInputTokens: 100000
    maxDiagnosisOutputTokens: 20000
    maxGenerationTokens: 100000
    maxGenerationRequests: 100
    maxRepairCells: 20
    timeoutMs: 14400000
  evolution:
    maxNewRolloutCells: 2500
    maxDiagnosisInputTokens: 500000
    maxDiagnosisOutputTokens: 100000
    maxGenerationTokens: 500000
    maxGenerationRequests: 500
    maxRepairCells: 100
    timeoutMs: 86400000
regression:
  collectFailures: false
  maxProposals: 50
```

`resolveSearchSettings` 补全新模式的规则默认值，并写入 `EvolutionSpec.searchSettings`。显式 `bridge.ratio: 0` 关闭发布扩评；局部研究仍可提交。改动超出分配模块的候选记录 `requires-broader-evaluation`，不能凭狭窄证据进入本轮发布路径。

上面的 token/request 数值适用于可计量的 Meta。使用 Skill 时，从 `budgets.round` 和 `budgets.evolution` 删除 `maxGenerationTokens`、`maxGenerationRequests`，并省略 `candidateGeneration.budget` 中的 `maxTokens`、`maxModelRequests`。这些字段分别可选，任一层显式配置即要求执行；`0` 表示耗尽，不等于省略。未配置的生成资源在 `remainingBudget` 中为 `null`，生成结果缺少对应 `usage` 字段，表示未知用量。评测、诊断、修复和时间预算仍按配置约束。

## 状态与恢复 API

终态 `control.status` 的 `search` 包含 sizing、实际 workplans、scope coverage、未评数量、前沿、父代概率、扩评状态、独立 promotion 决定和剩余预算；`research.bridge` 另含冻结计划及各候选未扩评原因。scope 视图分开记录待补证据与探索门不合格。运行中的阶段信息通过 `searchProgress` 展示。`experiments.tsv` 对新模式区分 `retained-local`、`global-nominee` 和发布决定。

外部状态未知时，操作员状态返回 `searchPendingOperation`，包含原操作、阶段、参与者、状态和原 handle。候选/研究可见状态不会暴露该字段或 held-out repair 引用。

调用 `control.search-resume`，参数为 `{ "evolutionId": "...", "roundId": "..." }`，可恢复同一轮次；服务重启也会继续尚未结算的搜索轮次。截止前仍使用原幂等键，截止后只读查询已有操作；已完成的结果和 commit intent 可以继续对账，禁止新运行。没有能够证明终态的查询结果时保持 pending，不另选 finalist 或开启新一轮。补评操作本身需要用原 `repairId` / completion ID 再次调用；原操作未解决时拒绝换 ID 创建第二次执行。

缺失 held-out 时，状态返回 `searchPendingEvidence`。可通过 Skill 控制 API 调用：

```json
{
  "method": "control.search-repair",
  "params": {
    "evolutionId": "...",
    "roundId": "...",
    "repairId": "repair-1",
    "evidenceDigest": "sha256:..."
  }
}
```

它对应 `RefineService.repairSearchStage`：在同一写者锁下修复原无效 slots，再继续原 round；原 finalist、父代、seed research 和预算不变。存在未解决 round 时，`continue` 拒绝另开一轮。

独立历史补齐使用 `completeArchivedEvidence`，调用方持有 evolution 写者锁。已有 evolution 只能补齐其已提交 archive 中的原 result、plan 和 snapshot，未提交的证据在花费预算或写入队列前拒绝。它不调用 Meta、不晋升；新 revision 在下一次 archive update 消费。尚无 evolution/archive 的独立 SDK 补齐仅返回证据结果，不写研究队列。不能用这个入口增加原计划外任务。两个补评入口先读取经过验证的完成缓存；即使用新 completion ID 引用旧的部分结果，也不重跑已完成的 outcome 或 process。两个补评入口都验证算法、provider 与任务身份，并遵守 round/evolution 的原有时间预算。它们也支持超时后查询原评测/过程恢复操作；不会重跑已有有效 outcome。

dossier、workplans、local 决定、nomination 与 archive 在发布引用前保存证据消费记录。消费边界按 plan + participant 绑定，而不是等到整个后续阶段完成；已消费的 seed 证据只能走追加 revision 的历史补齐流程。

异常退出时，已封存的候选与外部幂等执行继续复用。已完成的 Meta 生成直接复用封存结果；仍在运行或终态不明的原 attempt 保留句柄与工作区，不重新生成。Skill 生成实际接收统一搜索截止信号；截止后原尝试关闭并结算，不能开始下一次尝试。champion CAS 冲突保留外部版本和原 intent，需要明确处理冲突后才能继续。

## 历史证据只读回放

`replaySearchCase` 与 `scripts/search-shadow-replay.mjs` 可读取 legacy 单次观测缓存，核验输入摘要，返回包含指标假设、来源摘要和输入未变更检查的 advisory 报告。

```sh
npm run build
node scripts/search-shadow-replay.mjs BASELINE_CACHE CANDIDATE_CACHE NEW_OUTPUT_JSON
```

该命令只创建新的输出文件，不生成候选、补评或更新 archive、champion、published pointer。回放结果不构成晋升证据。

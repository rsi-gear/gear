# Candidate 晋升策略实现与接入

本次变更实现 `failure-cluster-gepa-v1` 的 Gear 搜索驱动、控制面接入和独立晋升策略。仅对新建 evolution 显式启用；没有 `searchSettings` 的历史 spec 保持原路径、组件身份和 verdict。

实现位于独立分支 `codex/candidate-promotion`，基于 `e0e8a7f`。没有合并到正在运行实验的 `dev`，没有重建其 `lib`，没有修改实验配置、数据、champion 或 published pointer。开发和测试工作目录为 `/private/tmp/gear-candidate-promotion-20260912`。

## 已接入的流程

首次完整 seed baseline → 固定 archive/champion/父代批次 → 共享失败诊断 → 冻结实际工作计划 → 独立生成候选 → 局部评测与专长归档 → 共同 bridge → 唯一 global nominee → 完整 seed/held-out → archive CAS 与可选 champion CAS。

- local/shared/cross/bridge 均根据去重 seed 全集计算比例，支持可选 min/max，精确十进制向上取整。任务数与桶计分权重独立。
- outcome/process 分别建立逐任务前沿，以 scope 权重和 membership 概率抽父代。全同分使用有资格检查的确定性 fallback，历史专长和原始证据保留。
- 过程能力在 admission 解析。原生 outcome-only、逐 trial scalar、过程缺失和旧版整条 invalid 分开处理；新模式不会添加 LLM judge。
- 每个候选领取自己的工作计划、有来源的 dossier 摘要、共享约束和父代 findings。Skill claim 和 DSH 投递产生独立消费凭据，不填充伪造的旧诊断 receipts。修改边界是相对 harness 根目录的路径。
- 所有候选生成结束后才评测。重试共享工作计划和总生成预算；无法认证实际 token 用量的外部 Skill 会按完整 reservation 计费。
- 阶段计划、bindings、诊断、提名、结果和 commit intent 使用内容摘要持久化。每次外部执行先冻结请求和预算 reservation，provider 使用幂等键恢复；部分 cell 已写入或诊断已结算时的中断不会重算请求或重新执行。
- held-out 前先冻结 seed research；缺失 held-out 可以在 intent 之前补评。历史局部证据通过独立 completion 追加 revision，有效零分和有效过程分不可替换。
- `shared-set-research` 只生成研究更新和 advisory 决定，不能自动更新 champion。
- 回归收集默认关闭。provider 可声明冻结的 `regressionTemplate`；有效 seed 业务失败进入过滤、去重、有容量限制的 proposal 队列。物化 suite 必须经可重现性验证，只能在新 admission 纳入。

## Provider 接入条件

**当前内置 `HitchCliEvaluator` 尚未声明新合同，新模式会在 admission 明确拒绝它。** 这不是自动回退到全量评测。没有尝试替换或升级本机正在运行的 Hitch。

通过 `RefineEvaluator.search` 提供 `{ provider, diagnosis }`。`createSkillControlPlane(config, { evaluator })` 已有的 evaluator 注入点可使用该实现。对旧 evaluator 不增加要求。

`SearchProvider` 必须提供：

1. `describe('seed' | 'held-out')`：冻结 task content、metric contract、模型/采样/环境/评分条件、逻辑 repetitions、稳定分层与成本估计。
2. `capabilities`：明确证明 task subset plans、batch-independent cells、idempotent execution。
3. `evaluate`：只执行列出的 cells；同一幂等键必须恢复同一执行，不能创建新随机尝试；遵守 abort 与调用预算。
4. `verifyCell`：验证实际产物来源、任务/评分/执行条件和 exact snapshot 身份，不能只相信 Gear 提交的字段。
5. 可选 `completeProcess`：只从原 run 产物恢复过程证据，不重跑有效 outcome。
6. 启用 `suiteRef` 时，用 `verifyRegressionSuite` 证明整个版本化 suite 已纳入该新 seed universe。

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

## 状态与恢复 API

`control.status` 的 `search` 包含 sizing、实际 workplans、scope coverage、未评数量、前沿、父代概率、扩评状态、独立 promotion 决定和剩余预算。`experiments.tsv` 对新模式区分 `retained-local`、`global-nominee` 和发布决定。

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

独立历史补齐使用 `completeArchivedEvidence`，调用方持有 evolution 写者锁。它不调用 Meta、不晋升；新 revision 在下一次 archive update 消费。不能用这个入口增加原计划外任务。两个补评入口都验证 provider 与任务身份，并遵守 round/evolution 的原有时间预算。

异常退出时，已封存的候选与外部幂等执行继续复用。未完成且无法恢复的 Meta 生成 attempt 明确结算为失败，不悄悄重新生成同一候选。champion CAS 冲突保留外部版本和原 intent，需要明确处理冲突后才能继续。

## 验证与交付边界

测试全部使用临时 Git 仓库和合成 provider，没有读取本机实验作为测试依赖，也没有调用真实模型。

- outcome-only 与 outcome+process 的完整搜索均有集成测试；100/1,000 seed 任务的 4→2→1 路径分别产生 170/1,700 次 candidate seed 新执行。
- 覆盖精确比例、无效配置、局部稀疏证据、历史专长、固定抽样、过程零值/缺失/旧 invalid、独立划分、过程晋升、预算、无 bridge、advisory、commit crash、历史 completion 和 held-out repair。
- 控制面测试实际通过 Skill claim、Git 修改/封存、v2 评测、champion 更新；旧生成、部分证据、champion baseline、状态、Meta 和能力测试继续运行。

2026-09-12 验证记录：13 个相关测试文件共 237 项通过（最多两个 worker）；补评身份约束的最终修改另行重跑对应测试。`npm run typecheck`、标准构建、生成 schema 一致性和 npm 文件清单检查通过。发布清单包含新 SDK 入口及运行时 JSON schema。

完整 spec 的全部验收矩阵仍是长期验收合同。此次没有使用真实 Hitch 演化证明收益，也不把合成 fixture 的计算节约宣称为真实 token/时长节约。内置 Hitch 的 capability adapter 尚需后续接入，因此原 spec 不标为整体验收完成。

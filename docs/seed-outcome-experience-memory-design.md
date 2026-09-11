# Gear：面向后续 Proposer 的 Seed Outcome Experience 设计

状态：V1 的 skill-first 最小切片已于 2026-09-08 交付；本文其余内容保留为背景与后续提案。

已交付范围是 seed-only 不可变 record、逐轮 snapshot、最多三张自动卡片（含 direct parent）、确定性 `experience.query`、有界 `experience.read` 及历史 seed trajectory 下钻。现有未启用 evolution 保持原行为。尚未交付、也不属于本次 V1 的是 curator/跨案例 lesson、磁盘 Markdown 视图、可重建持久搜索索引或向量库、独立持久化的 experience access audit / `experienceRefs` attribution、跨 evolution 导入，以及 DSH-owned adapter 接入。文末公开源码核查仍是设计背景，并非重新运行论文实验。

### 2026-09-11：已交付修改资源使用证据

新生成的 V1 record 可选保存 `observation.modificationUse`，并在每个 candidate trial 上保存有界的逐资源证据。旧 record 不补写字段，旧 snapshot 仍指向原 digest。后续 snapshot 会在冻结前为可读取的历史 seed trial 派生证据；已经完整校验来源的派生记录可从最近的冻结 snapshot 复用。来源不完整、预算不足和临时读取失败会在未来 snapshot 重试；完整来源中的 unsupported 等 `unknown` 仍保持未知，提取器版本变化时再派生。

状态语义如下：

- `observed`：至少一个变更资源存在精确且成功的 read / injected 证据；多文件修改仍逐资源保留状态，不能由其中一个成功覆盖其他资源的 `unknown`。
- `attempted-failure`：存在精确目标的失败尝试，且没有成功证据。
- `not-observed`：在 manifest 列出的全部已校验 native session 文件中没有精确匹配。它只表示“未记录到匹配”，不表示资源未被使用或对结果无效。
- `unknown`：来源缺失、覆盖不完整、内容无法校验、资源类型尚无可靠观察方式，或预算阻止读取。`unknown` 不转换成 `not-observed`。

Skill 证据要求结构化 skill 名、同一 session 内按 `callId` 配对的成功 tool-result，以及与候选文件按运行时规则去掉 frontmatter 后完全相同的 instruction body。普通文件 read 要求精确路径和精确返回内容；prompt 注入只匹配明确的 model-visible system 内容或 skill-invocation 内容。日志中的子串、自述、同名工具调用、编译成功或一次通用工具调用都不是变更资源被实际使用的证据。资源 body 相同而只改 metadata 时，也不能据此声称变更后的 instruction 已执行。

当前 Hitch trajectory analysis API（含 2026-09-11 核查的 `origin/dev` 11963b5）仍只投影单个 canonical session，并将 child-session coverage 标为 unavailable。Gear 因此仅对 sealed spec 中 direct DeepSeek Hitch root 启用独立的只读 native observer：它读取每个 run 的 `trajectory.ref.json`，只接受列出的 `provider_events` 文件，校验路径、字节数和 SHA-256，验证 main `provider_session_id` 及 child `parentSession` 链，并流式解析 main/child JSONL。其他 harness、daemon 模式或不可靠来源保持 `unknown`。扫描有共享 snapshot 字节预算、逐 run/file 上限和有界并发；只保留 skill/read、对应结果、skill invocation、`header.system` 与 session 身份，不保留无关长输出。

持久证据中的 child `seq` 只属于它的 native source 文件/session。`sourcePath`、`sourceDigest`、`sessionId` 和 `seq` 必须一起解释，不能把 child seq 伪装成旧 canonical-main trajectory detail ref。`experience.read` 的 task-results 返回有界证据示例并明确给出 omitted 数量，完整的匹配计数和逐 task 配对结果仍保存在不可变 record 中。自动卡片先显示变更路径、逐 task 的 parent→candidate 定量结果、排除数和 use coverage；这些仍是描述性观察，不构成“变更分支运行”或因果结论。

## 1. 建议采用的形式

保留现有 round JSON 作为实验事实来源；从中生成按候选分条、不可变的 experience JSON，建立可重建的检索索引，再为人和 Meta 渲染有长度上限的 Markdown。Meta 通过受控的 `experience.query` 和 `experience.read` 查询。

不建议让 Meta 反复维护一个全局 `MEMORY.md`，也不需要在第一版引入向量数据库。

| 层 | 保存什么 | 写入方 | 是否必须 |
|---|---|---|---|
| 原始实验记录 | proposal、diff、精确版本、seed evidence、配对结果 | Gear 现有状态机 | 已有 |
| Experience records | 每次修改的可核对 seed 结果与来源，包含负面和不确定结果 | Gear 确定性提取器 | V1 |
| Snapshot / index | 本轮允许查询的记录版本、排序所需字段 | Gear | V1 |
| Markdown card / overview | 同一 JSON 的可读呈现 | Gear 渲染器 | API 文本呈现为 V1；磁盘 MD 可选 |
| 整理后的 lesson | 跨多个案例的假设、适用条件、反例 | 后续独立 curator | V2 |

这里的 experience 服务于 **Meta 怎样改 harness**。Target 使用的 `harness/skills/` 属于另一种产物。不能把所有 Meta 经验直接写进 Target，否则会改变被评测的 harness、增加运行时上下文，并混淆经验检索与技能演化。

## 2. Gear 现在已经存了什么

`RefineStateStore` 将完整 round 写入 `rounds/<roundId>.json`，采用临时文件、sync、rename。`CandidateRecord` 已有 proposal、diff、sealedVersion、seedEvaluation、seedComparison、generationAttempts 和 failure。另有 experiments.tsv 面向人提供索引。

现有证据位置：

- [round 存储](../src/state/store.ts)
- [原子写入](../src/state/store.ts)
- [候选数据](../src/types.ts)
- [实验索引](../src/state/experiments.ts)

实际缺口是这些结果没有形成稳定的 proposer 输入。`resultCheckpoint` 在候选评测前保存，下一代继承这个 checkpoint；skill adapter 的 checkpoint 不包含对话事件。当前 wake 明确限定 current-round evidence，查询也围绕当前父本 baseline。

- [checkpoint 时机](../src/refine/service.ts)
- [下一代继承](../src/refine/service.ts)
- [skill checkpoint](../src/meta/skill.ts)
- [DSH wake](../src/meta/session.ts)
- [当前 evidence 范围](../src/capabilities.ts)

因此 V1 应复用已有实验事实，不要求先实现完整故障图谱，也不依赖先训练或调用新的经验总结模型。

## 3. 记录单元：一次候选修改及其结果

一条记录对应一个 candidate 的一个可验证 seed evidence 版本。多个候选即使修改意图相同，也保留独立记录。相同内容通过 digest 去重。

最小字段组：

| 字段组 | 必须表达的内容 |
|---|---|
| identity | evolution、round、candidate、schema / extractor 版本 |
| applicability | model、toolchain、dataset、condition 身份；parent commit；适用的 semantic targets / 路径 |
| proposal | 原有 rationale、expectedOutcome、semanticTargets；这些是提案者的主张 |
| change | parent/candidate commit、patch digest、变更文件摘要 |
| observation | 与该候选实际 parent baseline 的配对结果、task/attempt、reward delta、有效覆盖、来源 eval/run refs |
| classification | 数值上的改善/回归/混合/持平/证据不足；执行是否完成 |
| provenance | 允许字段组成的 seed projection digest、记录 digest、可选 supersedes |

不能直接把 `candidate.metrics.quality` 当真实收益，因为可选 LLM assessor 会改变其含义。应使用 `seedComparison.pairedTrials` 和匹配的 parent baseline / candidate seed evidence。当前代码也允许多个 research parent，不能统一拿 champion baseline 给所有历史修改记账。

### 3.1 负经验的精确定义

至少将两条轴分开：

1. `execution`：有可用评测、构建失败、生成失败、主动 decline、基础设施证据不可用。
2. `effect`：观察到改善、观察到回归、同时改善和回归、持平、证据不足。

`discarded / not selected / not promoted` 不能直接映射为负经验。候选可能有效，只是另一个候选更优。基础设施异常也不能记为 reward=0，更不能总结成某个修复机制无效。

分类仅描述已观测的样本变化，不表示统计显著性或因果确认。部分证据需保留 planned / paired / excluded 数量与具体 support；同一道题的重复 attempts 不能当作独立任务支持度。连续 reward 使用 task gain/loss 与原始 delta；只有存在明确成功判定时才输出 fail→pass/pass→fail。

建议按有效配对的 reward delta 分类，比较精度与容差封存到 policy：有 gain 且有 loss 为 mixed；只有 gain 为 improved；只有 loss 为 regressed；全部在容差内为 unchanged；无可比较配对为 insufficient。部分配对仍可描述观察到的 effect，但必须同时显示 partial 与排除数量。unchanged 只代表本批样本没有观测到变化，不能自动表述成“这个机制无效”。

### 3.2 示例记录

下面是说明结构的虚构例子，任务名、ID、digest 和数值均非 Gear 的真实实验结果；实际实现的 digest 使用完整值。

```json
{
  "schemaVersion": 1,
  "id": "exp_example",
  "source": {
    "evolutionId": "evolution-example",
    "roundId": "round-03",
    "candidateId": "candidate-03-b",
    "parentCommit": "<full-parent-oid>",
    "candidateCommit": "<full-candidate-oid>",
    "seedConditionId": "<condition-digest>",
    "seedProjectionDigest": "sha256:<digest>"
  },
  "proposal": {
    "expectedOutcome": "限制超长工具输出，避免上下文溢出",
    "semanticTargets": ["post_action"]
  },
  "change": {
    "files": ["plugins/output-limit.ts"],
    "patchDigest": "sha256:<digest>"
  },
  "observation": {
    "comparison": "candidate-vs-parent-seed",
    "plannedPairs": 24,
    "paired": 20,
    "excluded": 4,
    "baselineMean": 0.45,
    "candidateMean": 0.50,
    "delta": 0.05,
    "failToPass": 2,
    "passToFail": 1,
    "evidenceRefs": ["<baseline-seed-eval>", "<candidate-seed-eval>"]
  },
  "classification": {
    "execution": "evaluated",
    "effect": "mixed",
    "evidenceCompleteness": "partial"
  }
}
```

完整事实记录还保存或引用不可变的逐 task/attempt 配对投影。上面的均值不能独立成为证据；仅指向后续可能被 rerun 更新的 round 路径也不够。原始长轨迹继续由 Hitch 保存，experience 只保留受控引用，不复制全部日志。

Markdown 卡片可确定性地呈现为：

```text
经验 exp_example：工具输出限制
原意：避免长输出耗尽上下文。
修改：plugins/output-limit.ts；parent → candidate；patch digest …
观察：20/24 个有效配对，2 个 fail→pass、1 个 pass→fail，平均 +0.05。
结论级别：混合结果、部分证据；尚不能归因到单个修改。
下钻：task-results / diff / seed trajectory
```

“可能截掉了关键测试信息”属于待证实解释，需标为 hypothesis 并附来源；不能仅根据上面的分数自动写成事实。

## 4. 存储与快照

建议逻辑布局如下；`<gear-state>` 是配置的状态根，不是项目源码目录：

```text
<gear-state>/evolutions/<id>/
  rounds/<round-id>.json                 # 现有实验状态，含私有评测信息
  experience/
    records/<record-digest>.json         # 分条不可变的 seed-only 投影
    snapshots/<snapshot-digest>.json     # 允许查询的记录精确版本
    cache/index-v1.json                  # 可重建的搜索缓存
    views/<snapshot-digest>/overview.md  # 可选，只读生成视图
    views/<snapshot-digest>/<id>.md      # 可选，只读生成卡片
```

每条 JSON 独立原子写入，比让多个过程追加一个大 MD 更容易处理幂等、重启和证据修订。JSONL 可以作为导出格式；第一版不需要专门的数据库。

事实来源仍是 Gear 的校验过的状态；record 保存当时使用的 seed 投影，从而在 rerun 后仍能复查旧快照。索引与 Markdown 均可以删除后重建，不能反向修改事实。摘要渲染必须保留 record / source digest。

### 4.1 写入时机与可见性

1. 候选 seed 评测及其配对结果成功落盘后，提取 experience record。
2. 已有构建/生成失败只按实际保存的信息形成操作类记录；没有保存的临时补丁不补造出来。
3. 当前轮的新结果不进入当前轮 proposer 的可查询集合。
4. 下一轮开始前，在 round lock 下收集先前已经稳定落盘的 seed 记录版本，封存 snapshot；随后才启动本轮候选提案。
5. 同轮不同候选、同候选生成重试和 context handoff，使用同一个 snapshot digest。

历史记录的入选和排序不依赖 held-out 分数、promotion 结果或哪个分支最后获胜。无需等到 promotion 才生成 seed outcome。候选 seed 证据有效但后续 held-out 阶段失败，也不应丢掉这条 seed 经验。

`roundIndex` 是批次内序号，不能作为跨 continue 的全局历史顺序。快照显式保存记录 ID + digest 的成员集合及来源 round，不能只用 `roundIndex < current` 或一个时间戳推断权限。

### 4.2 崩溃、修复与重启

- 不把 experience 更新塞进 population/champion 的 CAS 事务：它是可重建的派生层。
- seed 结果已写、record 未写时，下一轮准备阶段重建缺失 record，再封存 snapshot。
- record 已写、索引未写时，扫描校验后的 record 重建索引。
- 相同 seed 投影重复处理生成相同 digest，不重复记录。
- 定向 rerun 改变配对结果后生成新 revision，标注 supersedes；旧 revision 留给旧 snapshot。
- 已经开始的 round 不更换 snapshot；新轮才能使用新的 revision。
- 重新读取 source 时如 digest 与 snapshot 不一致，返回明确的 evidence unavailable / revision mismatch，不悄悄用最新结果替换历史。

## 5. Meta 怎样获得经验

采用“自动带少量摘要 + 主动查询 + 证据下钻”。两种 Meta adapter 共享同一个生成器。

### 5.1 Wake 自动携带的内容

加入 `experienceContext`：snapshot digest、可用记录数、父本最近一次修改的 outcome，以及与当前失败任务/路径/focus 相关的少量卡片。

默认建议最多 3 张卡，总计不超过 1,500 个估算 tokens，并额外设置字节硬上限。这些是初始实验参数，需要随 memory policy 一起封存。负经验只在相关时优先；没有相关历史则返回空，不凑满数量。

提示中说明：历史是可复查的实验数据；继续诊断当前失败，不能因过去失败就永久禁止一种机制。当前轮的 evidence gate 不由历史读回替代。

### 5.2 `experience.query`

通过现有 `meta.call` 使用；身份由当前 lease / session 决定。下面只展示 capability 部分，实际调用继续带已有 clientId、leaseId、leaseToken：

```json
{
  "capability": "experience.query",
  "arguments": {
    "query": "tool output truncation loses test diagnostics",
    "semanticTargets": ["post_action"],
    "paths": ["plugins/output-limit.ts"],
    "effects": ["regressed", "mixed", "unchanged"],
    "limit": 5
  }
}
```

服务端绑定当前 snapshot，返回 `snapshotDigest`、`queryDigest`、`results[]`、`nextCursor`。每个结果包括短卡、实际 support、匹配原因和不透明 `experienceRef`。调用方不能通过传任意 evolutionId、状态文件路径或 runId 扩大范围。

V1 检索顺序：

1. 先限制为 snapshot 内、同 evolution、允许的 seed-only 记录。
2. 按 task、semantic target、改动路径等显式条件筛选。
3. 使用标题、rationale、expectedOutcome、路径和已有标签做确定性的词项匹配；可采用轻量 BM25 或直接字段加权。
4. 优先同父本/同 lineage、相同失败任务、相关负面与混合结果，按固定次序破同分；返回匹配原因。
5. 同时限制条数和返回字节数，游标绑定 query + snapshot。

不需要为 V1 发明并预先填满 failure taxonomy。已有 semanticTargets、diff paths 和 task IDs 就能启动检索。以后添加 LLM 生成标签时，标签需标为推断并封存生成器身份，不覆盖真实数值。

### 5.3 `experience.read`

```json
{
  "capability": "experience.read",
  "arguments": {
    "ref": "<experienceRef returned by query>",
    "view": "task-results",
    "limit": 20
  }
}
```

支持 `card`、`task-results`、`diff`、`trajectory`。`trajectory` 先返回该 experience 授权的历史 seed run 目录与 detail refs，再通过同一受控读取器分页。继续复用 Hitch 的有界投影、完整性校验与 Gear 的公开证据净化。

不要全局放开当前 `trajectory.query` 的 current-round 限制，也不要让历史任意 run 查询自动记入当前 baseline 的 diagnosis receipts。历史访问单独记入 `experienceAccessAudit`：snapshot、record/revision、view digest、查询 digest 与引用记录。

上下文换代后，不透明 view token 可以重发，但 record 身份、快照与内容 digest 不变。失效 token 不能退化成自由文件读取。

### 5.4 Markdown 的作用

Meta 接收到的工具结果可以渲染成 Markdown，因此模型依然像读笔记一样阅读经验。人可查看生成的 overview 和逐条卡片。未来若提供只读虚拟文件视图，也必须由同一 snapshot 和授权读取器生成。

V1 采用 API 是为了兼容 DSH 与外部 skill adapter，并复用当前 lease、输出上限和证据审计。它不意味着 Markdown 不好用；Markdown 负责呈现，JSON 与版本身份负责事实及可复现性。

## 6. 哪些信息不能直接照搬论文实现

HarnessFix 的 accepted/rejected repair memory 包含 validation gate 与回归任务；其 planner 也读取 validation 回归分析。Gear 现有协议把 held-out 与 Meta 隔离，不能将这些字段原样导入。

V1 必须从允许字段重建正向投影，而不是复制整份 round 再删除几个明显键。尤其不使用 round-level decision、held-out metrics、promotion reason、混合所有分区的汇总，以及可能间接依赖 held-out 的候选标签。净化后的 seed proposal / diff / reward facts 才进入索引、摘要和查询。

保持两个独立引用域：`evidenceRefs` 继续满足当前 seed baseline 的前置要求；新增 `experienceRefs` 用于说明历史启发，并验证确实在当前 snapshot 中被读取。两者不互相替代。

这约束的是 Gear 提供给 Meta 的能力通道，不把外部 skill 宿主原本的操作系统权限误称为已被 Gear 全面限制。

## 7. 最小实现落点

下表是原始建议落点。V1 已用 `src/experience/memory.ts`、现有 state store、service、skill coordinator 与 capability gateway 完成上述最小切片；表中拆分模块、磁盘视图、持久索引和 DSH-owned adapter 仍是未来提案，不应理解为已交付接口：

| 改动 | 落点 | 目的 |
|---|---|---|
| ExperienceRecord / Snapshot / AccessAudit 类型 | `src/types.ts` 或新的 `src/experience/types.ts` | 分开事实、推断、访问记录 |
| seed-only 事实提取器 | 新增 `src/experience/projector.ts` | 从已校验 round/candidate 提取；纯函数，避免额外 LLM 调用 |
| 不可变 record、snapshot、可重建索引 | 新增 `src/experience/store.ts` | 借鉴现有 atomicWrite 模式 |
| 有界检索与 Markdown renderer | 新增 `src/experience/query.ts` / `render.ts` | 相同输入和快照生成相同结果 |
| 轮前 snapshot barrier 与重建 | `src/refine/service.ts` | 在 proposer 启动前固化历史视图 |
| 两个 Meta 读取能力 | `src/capabilities.ts` | 从 active session 解析权限与 snapshot |
| 共享 wake context 与访问审计 | `src/meta/controller.ts`、`session.ts`、`skill.ts` | 两种 adapter 提供相同经验，不依赖宿主会话记忆 |
| DSH 工具与 skill 协议 | `src/notebook/tool.ts`、`skills/refine/references/protocol.md` | 暴露 experience_query / experience_read 的统一语义 |

现有 [gateway](../src/skill/gateway.ts) 已将 `meta.call` 转给 capabilities，无需另起一套服务。

第一版不需要新的算法扩展点、向量数据库、长期开着的 curator 或自动修改全局记忆文件。memory projection / retrieval / bootstrap 的实现身份和配置应纳入新 evolution 的封存 spec。已有未配置 memory 的 evolution 保持原行为；离线导出可用于核查，不能静默改变正在继续的实验协议。跨 evolution 导入与通用 lesson 库留到后续显式设计。

## 8. 验收与收益实验

协议检查：

1. 对每个有 seed 结果的候选提取 outcome，包含未选中候选；数值与原始配对一致。
2. 缺失证据不记零分；infra failure、decline、未获选择不被误写成回归。
3. 只改变 held-out 结果，experience 内容、检索结果与 seed-only 内容 digest 不变。
4. 重启、写入中断、重复处理、rerun revision 可恢复；旧 snapshot 的内容不漂移。
5. 同轮候选看不到 sibling 当前结果；生成重试与 handoff 沿用同一 snapshot。
6. DSH 与 skill adapter 返回相同记录与内容 digest；历史访问不满足当前诊断 gate。
7. 查询无法访问其他 evolution、未授权 run、任意路径；分页和文本硬上限有效。

收益实验采用相同 proposer、任务与总预算，比较：A 当前流程；B 只自动注入直接父本上一条 seed outcome；C 自动摘要加 query/read。先检验最小反馈是否足够，再决定是否值得加 curator。

报告重复无效修改比例、重复触发已知回归的次数、首次有效候选所需 rollout 数、每个有效候选的 Meta tokens、检索命中和证据读回成本，以及独立测试上的最终收益。没有匹配经验的任务也要保留在统计中。不要仅以“检索调用次数增加”判断有效。

## 9. 公开源码核查

以下为 2026-09-08 读取公开仓库源码的结果，不是重跑论文实验。AHE 与 Meta-Harness/RHO 两组由 Sol 只读代理完成后复核；Evo-Harness 的 Sol 执行被模型服务中断，其 Terminal-Bench 路径由主代理补查；HarnessFix 由主代理直接核查。没有执行这些仓库的实验脚本。

### 9.1 HarnessFix：最直接的结构化正负经验检索

核查版本：`9167a0b9a58748c73b56c3ee04fdc3437ba0c56e`。

- writer：pipeline 在 audit / validation gate 后调用 `step_record_memory`，按 gate 与 audit 的结果记为 accepted 或 rejected。
- storage：`failure_analysis/memory/accepted_repairs.jsonl` 与 `rejected_repairs.jsonl`。每条含 version、summary、改动文件、defect classes、operator families、audit/gate 结果及 improved/regressed task IDs。
- reader：同时读取两种 outcome；按 mode、component、defect、operator 标签重合打分，取前若干条。此路径是字段加权检索，没有向量检索。
- prompt：将选中记录格式化为文本，进入下一轮聚合规划上下文；agent 模式还写出 `memory.txt` 等上下文文件让 planner 阅读。

证据：[记录结构、写入与检索](https://github.com/HarnessFix/HarnessFix/blob/9167a0b9a58748c73b56c3ee04fdc3437ba0c56e/failure_analysis/harness_memory.py#L9-L134)、[pipeline 写入](https://github.com/HarnessFix/HarnessFix/blob/9167a0b9a58748c73b56c3ee04fdc3437ba0c56e/run_pipeline_terminal_bench.py#L524-L543)、[下轮检索及上下文注入](https://github.com/HarnessFix/HarnessFix/blob/9167a0b9a58748c73b56c3ee04fdc3437ba0c56e/aggregate_results.py#L1315-L1388)。

对 Gear 的借鉴是“正负案例结构化保存 → 按当前问题匹配 → 有界呈现”。不能照搬 accepted/rejected 语义或把 validation gate 信息直接映射为 Gear 的 held-out 可读经验。

### 9.2 AHE：把预期与实际结果主动交给下一轮

核查版本：`8b2a55d97590363fe50c3cc6b5e833b020a4bb4c`。

它同时保留 `task_history.json`、`evolution_history.md`、每轮的代码/轨迹/分析目录、`change_manifest.json` 与 `change_evaluation.json`。后者把 manifest 声明的 predicted fixes、risk tasks 和实际任务变化对照，产生 actually fixed、still failed、risk realized 以及结果标签。

下一轮 `build_evolution_query` 直接插入上轮修改结果表、未修好的任务和回归信息；还插入上一轮各 variant 的表现，明确包括落选 variant。更深的材料由 agent 读取 overview、逐任务分析及原始文件，工具支持文本搜索。

证据：[修改结果计算与落盘](https://github.com/china-qijizhifeng/agentic-harness-engineering/blob/8b2a55d97590363fe50c3cc6b5e833b020a4bb4c/evolve.py#L2267-L2339)、[下轮自动注入修改结果及 variant 经验](https://github.com/china-qijizhifeng/agentic-harness-engineering/blob/8b2a55d97590363fe50c3cc6b5e833b020a4bb4c/evolve.py#L2825-L2893)、[分层读取指引](https://github.com/china-qijizhifeng/agentic-harness-engineering/blob/8b2a55d97590363fe50c3cc6b5e833b020a4bb4c/agents/evolve_agent/evolve_prompt.md#L160-L175)。

对 Gear 最值得借鉴的是自动带入直接父本修改的实际结果，避免“工具虽然存在，proposer 却从不调用”。AHE 对单项 change 的结果仍依赖预先声明的任务集合，不能把其 HARMFUL / INEFFECTIVE 标签当成严格的因果结论；Gear 应保留候选整体的配对观察和证据完整度。

### 9.3 Meta-Harness：官方 artifact 与 RHO 复现必须分开

官方 artifact 核查版本：`57fefdb2ff84af3fd81b69d67814acbe69bd0743`。其公开内容是最终演化出的 Terminal-Bench agent；README 明确表示演化细节待补。没有在这个 artifact 中核实到完整的经验写入、历史检索与 proposer 搜索实现。[官方说明](https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact/blob/57fefdb2ff84af3fd81b69d67814acbe69bd0743/README.md#L32-L36)

RHO 仓库版本：`e5f2d1a8a06ab3523ab42e0042d2fa13d9acb701`。其中独立的 `src/rho/meta_harness/` baseline 实现了可核查的全历史方案，不能当作官方原实现：

```text
history/
  summary.jsonl                   # 每个已评测候选的假设、父本、任务分数、轨迹 ID
  frontier.json                   # 当前最佳候选
  candidates/<harness-id>/        # 历史源码
  traces/<harness>/<task>/<run>/  # 历史执行证据
  reports/iter_<n>.md             # 前面 proposer 写下的事后分析
```

外层循环追加结构化结果，再为下一轮物化只读 history。proposer 用文件读取和文本搜索查询，先补写缺失的事后分析，再深读当前最佳和近期回归的原始轨迹。已评测但落选的候选也保留；未成功形成可评测候选的 proposer 尝试，不自动获得同样的 CandidateRecord。

证据：[JSONL writer](https://github.com/wbopan/retro-harness/blob/e5f2d1a8a06ab3523ab42e0042d2fa13d9acb701/src/rho/meta_harness/store.py#L9-L41)、[history 物化](https://github.com/wbopan/retro-harness/blob/e5f2d1a8a06ab3523ab42e0042d2fa13d9acb701/src/rho/meta_harness/history.py#L11-L57)、[proposer 读取与分析协议](https://github.com/wbopan/retro-harness/blob/e5f2d1a8a06ab3523ab42e0042d2fa13d9acb701/src/rho/meta_harness/prompts.py#L8-L54)。

RHO 自身的主循环另有 diagnosis、候选评测和产物存档；这些文件留在磁盘，并不表示主循环已把历次落选修复自动回馈给下轮 optimizer。[主循环](https://github.com/wbopan/retro-harness/blob/e5f2d1a8a06ab3523ab42e0042d2fa13d9acb701/src/rho/loop.py#L344-L478)

对 Gear 的借鉴是分层历史视图和证据下钻。Gear 已有两个 Meta adapter、有界轨迹能力及证据范围约束，因此建议在同一数据之上提供 query/read API；之后可再增加同源的只读文件视图。

### 9.4 Evo-Harness：整理后的技能，与修改结果账本不同

核查版本：`3c7c7b8c62a3f07da1d4407aa03f0ca079954bcf`，分支 `release/evo-harness`。以下结论限于核查过的 `evo_harness/terminal_bench.py` 路径。

主要长期产物是 `skills/**/SKILL.md`，另有 `SKILL_TREE.md`、`STATS.json` 和逐任务结果 JSON。curator 根据本批任务的反馈及已有技能做接受、合并、跳过或一般技能更新；合并会更新当前技能文件。技能供后续 solver 使用。

加载默认把技能正文加入 system prompt；实现也支持按 task 用小模型选 topic，以及只列名称/描述、通过 `read_skill` 按需加载。核查的 launcher 配置把 topic 技能上限设为 0，并未打开 lazy loading，不能据此声称默认实验使用了所有这些检索选项。

证据：[技能选择与注入](https://github.com/A-EVO-Lab/a-evolve/blob/3c7c7b8c62a3f07da1d4407aa03f0ca079954bcf/evo_harness/terminal_bench.py#L663-L814)、[topic curator 写入](https://github.com/A-EVO-Lab/a-evolve/blob/3c7c7b8c62a3f07da1d4407aa03f0ca079954bcf/evo_harness/terminal_bench.py#L1210-L1268)、[批次结果、统计与演化流程](https://github.com/A-EVO-Lab/a-evolve/blob/3c7c7b8c62a3f07da1d4407aa03f0ca079954bcf/evo_harness/terminal_bench.py#L1876-L2057)、[launcher 实际参数](https://github.com/A-EVO-Lab/a-evolve/blob/3c7c7b8c62a3f07da1d4407aa03f0ca079954bcf/scripts/run_terminal_evolve.sh#L9-L18)。

这个路径没有为每次被拒绝的技能提案建立可查询的、与父本配对的修复结果账本。`STATS.json` 的 pass/fail 计数也不能当作技能因果收益：相关名称列表包含全部已加载技能，不等同于本次真实读取或发挥作用的技能。

对 Gear 而言，技能整理可作为 V2 研究方向；P0 先把每次修改实际发生了什么保存好并交回 proposer。将这些事实进一步归纳成跨案例 lesson，需要保留支持案例、反例、适用条件与来源，不能用一段不断改写的总结替代原始结果。

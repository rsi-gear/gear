# SoL-Pi 调研与 Gear 支持方案

调研日期：2026-09-20。本文是源码调研与实现建议，未安装 SoL-Pi、未运行模型评测、未实现下述新增能力。

核查基线：Gear 本地 `dev`，HEAD `5c672f090dc53a6775d01ddaea1d2d792b072ea1`，包含调研开始时已有的未提交改动；SoL-Pi 官方 main 固定在 `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`（2026-09-18）。Gear 的结论针对当前工作区，不代表远端最新版本。

## 结论

本次需求已明确为：**完整保留各种原始得分与计量，用户在 Refine 启动时定义它们的加权组合作为优化目标。默认通过率，也支持 `0.5 × pass_rate + 0.5 × process_score`；SoL-Pi 通过费用、token、耗时等原始指标纳入同一机制。** 具体合同见 [Refine 原始指标与加权优化目标规范](refine-objective-spec.zh-CN.md)。该规范 V1 已实现于 `failure-cluster-gepa-v1`，使用方式见[加权目标指南](refine-objectives.zh-CN.md)。

benchmark / adapter 负责指标来源、单位与聚合语义，用户的 `objective` 配置负责选项、权重及可选定标。最终 `objective_score` 独立派生，不能替代原始结果；即使只优化通过率，也保留已产生的其他分数和 usage。修改权重无需改 benchmark 或预先注册命名评分方案，可用完整兼容的原始证据重新计算。

Gear 已有外层研究控制的主体：提出候选、修改 harness、评测、保留证据、选择和导出版本。SoL-Pi 四机制可以作为候选方案，放在实际 Target harness 中；安装或触发它们不直接加分，移植它们也不是评分能力的前置条件。

下文保留官方项目与运行时接入调研作为背景；第 4–6 节按“完整原始指标＋用户定义加权目标”修订。

## 1. SoL-Pi 提供了什么

需要区分研究方法与开源交付物：

- **研究方法**：从轨迹识别浪费，拓展多个机制假设，分别实施、独立审查与实验，在预先冻结的质量容差内筛选效率改善，最后冻结候选做隔离评测。
- **当前开源交付物**：Pi 的独立扩展，包含下面四个机制。此次核查的官方仓库未发现可直接运行的完整研究调度器、研究循环模板或论文所述 535 个研究环境。不能把安装扩展等同于获得完整 auto-research 平台。[论文方法](https://arxiv.org/html/2609.20519v1#S2)、[固定版本源码](https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1)。

| 机制 | 具体行为 | 实现边界 |
| --- | --- | --- |
| Action Fusion | 一次 edit/write 请求携带后续命令，修改完成后执行验证，合并返回结果，减少中间一次模型决策。 | 适合执行前已确定的命令；需要先观察修改结果才能决定的操作不能强行合并。 |
| ObservationPack | 大文本归档；在前两次 provider 请求中完整发送，此后用稳定引用和短摘录替代；支持分页读取原文。 | 关键在模型请求前的历史投影，不只是第一次截断输出。原文可恢复不等于模型始终保有同等决策信息。 |
| Evidence-Preserving Reducer（EPR） | 把长诊断日志交给辅助模型，返回带来源定位的结构化回执；确定性核验通过才替换原输出，失败回退。 | 核验引用确实存在，不能证明摘要完整、推断正确或没有遗漏错误。辅助调用本身也有成本。 |
| Online Context Compact（OCC） | 完成计划步骤时估计剩余请求量、上下文增长和缓存重写代价；合算或窗口压力高时调用 Pi 原生压缩并续跑。 | 是有损摘要与经济启发式；不是简单按 token 阈值压缩，也不保证每次压缩都省钱。 |

实现来源：[Action Fusion](https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/action-fusion)、[ObservationPack](https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/observation-pack)、[EPR](https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/evidence-preserving-reducer)、[OCC](https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/src/sol-pi/extensions/online-context-compact)。

官方报告的 EdgeBench 结果是相对 Pi token 流量降低约 45–49%、API 等价费用降低约三分之一，同时保留约 94% 的平均分。因此应描述为受约束的质量—效率折中，不能称为无损提速，更不能把这些幅度当成 Gear 的预期收益。[官方结果](https://nvlabs.github.io/SoL-Pi/index.html#results)

固定版本使用 MIT 许可，测试依赖 Pi 0.85.1；四机制默认关闭。搜索索引仍有旧版 Pi 0.84.2 文本，落地应以选定 commit 的源码与兼容文档为准。[package.json](https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/package.json)、[兼容说明](https://github.com/NVlabs/SoL-Pi/blob/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1/docs/compatibility.md)

## 2. Gear 已有的基础

| 层次 | 已有实现 | 对此次接入的意义 |
| --- | --- | --- |
| Target harness 载体 | `examples/dsh-codex-luna/target-carrier/fixed/target-loader.js:9,40,74` 支持 preset/plugins/prompts/skills/workflows，并校验 manifest。 | 四个机制可以成为版本化候选插件，交给 Gear 迭代和导出。 |
| 编译与加载验证 | `src/harness/compiler.ts:46`，支持独立 subprocess 与运行时检查报告。 | 可检查插件加载、工具注册和上下文装配；真实触发行为仍需要专项测试与 rollout。 |
| 搜索闭环 | `src/search/engine.ts` 与 `src/search/runtime.ts` 已有 baseline、诊断、候选生成、local/bridge/global-seed/held-out、恢复与提交。 | 无需重建研究执行底座。 |
| 证据与身份 | `src/search/evaluation-adapter.ts:268` 校验 cell 来源；`src/search/archive.ts:90` 限制 archive 只收 seed 证据。 | 支持固定版本、成对比较、去重与重放，能约束实验混用。 |
| Meta 大输出外置 | `src/meta/offloading-execution.ts:198` 超预算输出写入存储，`meta_context_read` 分页读取。 | 可借鉴归档和读取语义，但这是 Meta 侧能力，尚非 Target 的 ObservationPack。 |
| Meta 上下文交接 | `src/meta/offloading-host.ts:61,96` 测量上下文、生成摘要；执行层做持久化交接。 | 可借鉴 continuation 与任务约束保留，不等于已有 Target OCC。 |

两个容易误判的地方：

- Gear 外层评测成本、Meta 自身开销、Target 单任务运行成本应分开统计。只压缩 Meta 的上下文，不能据此声称目标 Agent 推理费用下降。Meta 启用 Gear offloading 时还会拒绝独立 DSH compaction 插件，不能直接把 OCC 叠到该 preset（`src/meta/isolation.ts:245`）。
- 当前 staged GEPA 并不使用旧版全部 generator/assessor/selector/judge/promotion 插件接口。公开父代策略可替换，阶段顺序与最终晋级仍在内置算法中。目标选择合同需要明确接入该路径，不能只注册一个旧 PromotionPolicy。[本地算法说明](search-algorithm-authoring.zh-CN.md)

## 3. 四个机制如何接到 DSH Target（后续参考，不属于本期）

### 3.1 Action Fusion：复用工具编排

在目标 harness 注册 edit-and-check / write-and-check 工具，或利用 DSH Code Mode 在单次模型请求中编排工具。保持修改与验证的顺序，修改失败则不执行依赖命令；结果分别携带修改状态、命令退出码和输出引用。

本地 DSH rc.8 的 tools 已定义 Code Mode 多工具程序、分支与顺序屏障，但当前安装只确认到 code-runtime 接口，未确认可用执行 provider。实际 target carrier 固定 DSH 0.1.1-rc.2，必须在其真实运行环境验证是否启用；不能据根项目依赖推断可直接运行。

缺少 provider 时需在固定 carrier 中安装并锁定依赖；候选可编辑目录不包含 package/lock 文件（`src/candidate/filesystem.ts:11`），这应作为实验基础环境变更单独完成，然后重新冻结基线。

移植时让融合工具里的子操作继续经过宿主的工具执行、取消与审计路径。SoL-Pi 的内部 bash 实现不宜未经适配直接搬入 DSH。

### 3.2 ObservationPack：先即时版本，再决定是否扩展宿主

可先在 `tools/post-execute` 做“完整归档 → 引用＋摘录 → recall 工具”，复用 Gear Meta offloading 的设计经验，存储则归属 Target trial/session。它能验证引用检索的收益与质量影响，但与 SoL-Pi 延迟投影的行为不同，实验中应使用不同机制名。

完整移植的关键缺口是请求前投影：此次检查的 DSH 0.1.0-rc.8 中，`agent/request` 只允许改变调用配置，`llm/stream` 的请求为深度冻结只读数据；模型消息来自 session 的已记录事件。没有确认到 Pi `context` 对等的非持久化消息投影口。

有两个候选实现方向：

1. 追加可审计的持久化结果替换事件，保留原始事件但改变有效上下文；接受其与“仅本次请求临时投影”的语义差异。
2. 增加带版本和来源记录的 provider-context projection 接口，保留原始轨迹，明确记录每次实际发送给模型的视图。

第二条更接近 SoL-Pi，适合可复用 SDK；也需要宿主支持，不能仅靠普通 prompt 或当前 `agent/request` 配置 hook 完成。DSH rc.2 的对应能力尚需在固定运行时另行验证。

### 3.3 EPR：在成本与原文归档打通后做

在工具结果进入模型前筛选长诊断日志：归档原始输出，调用独立 reducer 路由，核验返回的原文引用与来源摘要，合格后才替换为回执。辅助调用失败、引用不匹配、回执未明显缩短时保留原结果；如果增加行号定位，也应单独确定性核验。

原文、压缩回执与 provider 可见视图要保持同一来源链。建议先形成 EPR 回执，并让 ObservationPack 跳过已识别的回执，避免对原文和回执反复压缩或重复计费；这也符合当前 SoL-Pi 的组合方式。不能给“核验通过”赋予“日志已被完整理解”的语义。

### 3.4 OCC：压缩与续跑协调

复用 DSH 原生 compaction 接口，不直接删除 session 事件。插件记录计划步骤完成事件，在下一安全执行边界计算是否压缩，并保存续跑状态。

本地 rc.8 有 `compactIfNeeded` / `compactNow` / `compactRegion` 接口，但只确认到 compaction 接口层，未确认实际 provider。pre-step 应使用允许活动 turn 的 `compactIfNeeded` 或符合接口约束的 `compactRegion`；`compactNow` 只在 idle 调用。不能在工具执行过程中等待自己的 idle，也不能直接把 `compactNow` 搬到活动 pre-step 中调用。

在 Gear 中补充三类策略输入：剩余工作的估计、模型窗口余量、当前 provider 的缓存价格与未回收重写成本。原版默认 `cacheWriteReadRatio=12.5` 不应跨 provider 无条件照搬。先验证压缩后的目标、约束、证据引用及恢复行为，再评估成本收益。

### 宿主选择

若目标是尽快复现官方行为，可以新增 Pi Target 的固定载体、运行检查与 Hitch 执行适配，加载原版 SoL-Pi；本次未确认 Gear/Hitch 已有可直接使用的 Pi Target 完整配置。若目标是强化 Gear 现有 DSH 体验，则按上述路线移植宿主接口。`pi-ai` 模型适配依赖不等于 Pi coding-agent 扩展宿主。

第三方 [xinghaix/dsh-sol-pi](https://github.com/xinghaix/dsh-sol-pi) 已做 DSH 适配，可参考宿主解耦方式；它声明 delayed ObservationPack 的限制，并使用不同 DSH 版本，不能据其存在认定当前 Gear carrier 已兼容。

## 4. 本期方案：完整原始指标与加权目标

### 4.1 数据与优化偏好分开

评测持久化全部原始得分、通过状态、rubric 组件与 usage，再按 Refine 的 `objective.terms` 计算目标分。目标未选择的指标以及零权重指标也保留；缺失值记录缺失，不凭空补零。原始 artifact 中未适配的字段仍保留，只有具有明确指标合同的项才能进入目标。

用户直接配置加权项，无需 benchmark 预先定义 profile：

```json
{
  "objective": {
    "terms": [
      {"metric": "pass_rate", "weight": 0.5},
      {"metric": "process_score", "weight": 0.5}
    ]
  }
}
```

公式统一为 `S = Σ weight_i × (metric_i / scale_i)`，scale 默认 1。权重有限且不全为零，允许负权重，不要求和为 1，也不自动归一化或截断目标分。可选 scale 是 objective 中固定的正数，单位与所选指标一致；例如 0–100 的 process 分可除以 100，原值仍完整保留。

benchmark 已有 partial score 内部的组件权重保持原义。Refine 只对用户选择的指标再做组合，既不覆盖 process score，也不根据新权重重新解释原 rubric。

### 4.2 SoL-Pi 如何纳入

费用、token、耗时、模型请求数作为普通原始指标记录，用户可在同一目标中赋予负权重。例如：

```text
S = 0.5P + 0.5Q − 0.1 × cost_usd / 1 − 0.1 × tokens / 100000
```

假设 P、Q 原范围为 0–1，`P=0.8`、`Q=0.9`、同范围平均费用为 1 美元、平均 token 为 100000，则 `S=0.65`；保持质量，费用和 token 都减半，则 `S=0.75`。原费用、token 和质量值仍分别保留。用户可以只选择费用、增加耗时，或使用其他权重；这是 Gear 的配置示例，不是 SoL-Pi 官方评分公式。

加权和允许质量与效率交换。用户若要求保持能力，可以额外声明通过率、process score 相对固定初始 baseline 不回退或允许指定容差；约束失败时保留真实目标分与原因，并阻止晋级。该质量门是显式配置，不是所有效率目标的隐藏默认。

没有原 process score 的 benchmark 可以选择通过率与实际存在的效率指标，不虚构 partial 或要求新增 process 通道。四个 SoL-Pi 机制是改变这些实测指标的候选手段，启用机制本身不影响评分。

### 4.3 证据、诊断与晋级

费用/token 证据覆盖声明范围内的主模型、辅助调用、reducer、compaction 与重试；单位、价格快照、缓存桶、提取器和时间边界可追溯。已产生的 usage 无论是否被目标使用都保存；所需指标缺失时不填零、不删项、不重分权重。原 V1 assertion 组件不变，新增独立 raw metric 与 objective 证据，见[结果规范第 7.4 节](hitch-evaluation-source-and-evidence-contract-spec.zh-CN.md)。

原始指标先按固定的重复和任务范围聚合，再计算加权和。线性定标和共同范围的均值可交换，从而保持逐任务前沿与阶段分数一致。整个评测的消耗总账与目标使用的每任务均值分别保存、清楚命名；只有 dataset 总值而没有逐任务证据的指标不能伪造 staged 前沿。

`src/search/evaluation-adapter.ts:307` 当前会跳过已成功的 cell。新诊断要接收目标公式、单位、权重和各项贡献，才能分析成功但昂贵的轨迹。Meta 可参考完整 seed 指标提出改进，但最终排序始终服从封存目标。

当前晋级的 outcome 改善或 process 改善规则需要接入 objective gate 与显式约束。逐任务前沿、父代选择、local/bridge/global 比较和最终晋级使用同一加权定义，不能只修改展示或额外设置隐式 process tie-break。

### 4.4 冻结与实验边界

原始指标合同与 objective 分别版本化。用户的权重、scale、公式版本和约束在新 evolution admission 冻结，质量约束引用的 initial baseline 由既有评测流程产生后封存。运行中不按 champion、候选集合或 held-out 结果调整规则。

修改权重无需修改 benchmark；兼容、完整的原始证据可以生成新 objective 的派生评分，不强制重跑。新目标下继续搜索需要新 evolution，旧评分、前沿、排名和晋级决定不能跨目标身份复用。旧 evolution 的恢复维持历史行为。

现有 held-out 参与多轮 champion 选择，不等同于完全不反馈的最终测试集。要证明泛化仍应在冻结候选后另做隔离测试；本期评分能力不要求重构数据分区。

## 5. 实施顺序与验收

| 阶段 | 工作 | 完成标准 |
| --- | --- | --- |
| P0：完整原始结果 | 指标合同、完整得分和 usage 持久化、可用性与来源 | 即使只优化通过率，其他已产生指标仍完整可查 |
| P1：目标定义与重算 | inline objective、权重与可选固定 scale、独立派生证据 | 默认 P、0.5P+0.5Q、费用/token 负权重均可配置并重算 |
| P2：决策贯通 | 诊断、前沿、比较、gate、恢复与展示 | 不同权重产生相应排序，显式约束独立执行，旧实验不变 |
| P3：集成验收 | 自定义原始指标、缺失、版本兼容、原始证据复用 | 不丢未选指标，换权重无需修改 benchmark，所有决策使用同一目标 |

**交付重点是完整保存原始数据，再由用户定义优化偏好。** SoL-Pi 所需的效率观测作为普通指标扩展进去，不固定成一个 partial score 特例或另一个必须预先发布的评分方案。

## 6. 实现需要重点触及的文件

以下为建议修改面，不表示已经修改：

| 修改面 | 当前入口 |
| --- | --- |
| 原始指标合同与完整导入 | benchmark adapter、`src/evaluator/hitch-cli.ts`、runtime usage artifact |
| 启动 objective 与 spec | `src/skill/gateway.ts`、`src/skill/control-plane.ts`、`src/refine/service.ts`、`src/types.ts` |
| raw metrics 与加权派生证据 | `src/search/dataset-projection.ts`、`evaluation-adapter.ts`、`evidence.ts`、`types.ts`、`schema.json` |
| 连续效率计量 | Hitch/Target usage artifact、`src/evaluator/hitch-cli.ts` 导入校验 |
| 诊断与 Meta 输入 | `src/search/evaluation-adapter.ts`、`diagnosis.ts`、`src/meta/skill.ts` |
| 前沿与晋级 | `src/search/promotion.ts`、`archive.ts`、`engine.ts`、`contracts.ts` 及非 staged 路径 |
| 协议、恢复与展示 | `src/state/`、Refine status、实现后的 Skill 协议与用户指南 |

本次验证限于官方材料与源码、Gear 当前实现、已安装 DSH rc.8 类型及运行代码的静态核查。尚未实测 Target rc.2 插件兼容性、机制触发与性能收益。

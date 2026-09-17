# 案例二：定制进化算法

定制 Gear 的算法组件：先实现一个最小精英选择器，再研究使用 [GEPA](https://arxiv.org/abs/2507.19457) 算法的 Marketing 实验。实验采用 Gear 的 GEPA 变体，通过共享失败诊断与分阶段评测优化 Harness。

![通过率与目标完成度二维图：原始 DSH 搭配 GPT 5.6 Luna medium 的基线、Marketing 迭代，以及虚线依次连接的 GPT 5.6 Luna max 和 GPT 6 Astra max（61% / 86.30%）、原生 Codex + Astra、带星号的官方 held-out Marketing 模型结果。](../assets/marketing-staged-search.svg)

横轴为严格通过率，纵轴为目标完成度（本地 `partial_credit`）。实线连接保留的迭代，虚线连接切换 effort 或模型后的独立评测，没有新增 Meta 轮次。Champion `a0740800` 搭配 GPT 6 Astra max 通过 61/100 个任务，目标完成度为 86.30%。模型名后的 `*` 表示官方 held-out Marketing 参考，通过率取自 Zapier，目标完成度取自 AA；[指标口径](results.md)。两图使用相同的放大坐标范围。[图表数据与来源](../assets/marketing-results.json)。

## 选择要定制的算法模块

Gear 在[组件库](../../../src/evolution/components.ts)中提供七类算法接口。替换要研究的决策模块，其余评测流程可以保持一致。

| 可编辑模块 | 接口 | 可以改变什么 | 服务组合字段 |
| --- | --- | --- | --- |
| 候选生成 | `CandidateGenerator.plan()` | 从控制器提供的父代集合分配候选槽位和父代。 | `candidateGeneration.strategy` |
| 任务采样 | `TaskSampler.resolve()` | 每轮任务范围、重复次数和冻结的评测条件。 | `rollout.taskSampler` |
| Rollout 后端 | `RolloutProvider.createEvaluator()` | 执行确切候选版本并收集证据的方式。 | `rollout.provider` |
| 适应度 / 评分 | `Judge.evaluate()` | 从评测证据计算指标。 | `evaluation.judges` 与 `evaluation.primaryMetric` |
| 候选评估 | `CandidateAssessor.assess()` | 排序依据和可选 verifier 判断。 | `selection.assessor` |
| 生存者选择 | `CandidateSelector.select()` | 精英保留、多样性、平分规则和待晋升候选。 | `selection.strategy` |
| Champion 晋升 | `PromotionPolicyProvider.decide()` | 接受阈值和与 baseline 配对比较的规则。 | `promotion.policy` |

通过对应的 `ComponentRegistry.register…()` 方法注册实现，创建带版本的 `ComponentRef`，在**新的**服务 / evolution 组合中使用该 ref。修改 Markdown 提示词会改变 Meta 的变异指令；替换上述组件会改变搜索算法。模型、benchmark、候选预算和保留数量则是组件周围的配置。

默认服务把 champion 作为生成父代。自定义 generator 只能在控制器传入的父代中选择；实现种群级繁殖还需要接入 archive 和父代池。槽位分配后，Meta 通过 Skill 生命周期执行实际变异。单独替换 selector 不会增加 crossover 或异步失败诊断。

定制算法仍保留确切 commit / manifest、证据完整性、配对条件一致、held-out 隔离和原子 champion 更新等框架约束。

![变异式搜索流程：选择父代，提出最多四个候选，最多两个进入 bridge，最多一个进入全量，然后记录 archive 与晋升决定。](../assets/staged-search-flow.svg)

## 定义进化算子

| 算子 | 在 Gear 中的实现职责 |
| --- | --- |
| 个体 | 确切 Harness commit、manifest 与谱系。 |
| 种群 | 按任务 scope 获得研究资格的 archive，保留证据。 |
| 父代选择 | 使用已记录 seed 和抽样记录选择合格 scope 与 parent。 |
| 变异 | Meta 将有证据支持的失败假设转化为 Harness 修改。 |
| 适应度 | 同一冻结任务范围上的严格成功率与声明的过程指标。 |
| 生存者选择 | 保留有用的专长候选，并分配后续评测阶段。 |
| 精英保留 | finalist 满足晋升规则前继续保留 champion。 |

这是以变异为主的进化算法变体。当前候选合同采用一个代码父代，本案例没有实现双亲 crossover；交叉扩展需要明确来源父代、合并/修改规则、谱系与评测前验证。

实现具有 archive 与父代选择机制，但这三轮实际所有候选都来自 `8b651c5`。结果没有展示不同 archive 成员之间的多代繁殖。

## 先实现一个最小扩展

随附的[选择器组件](../../../examples/evolution-search/selection.mjs)通过真实 `ComponentRegistry` 运行。它要求候选在同一 seed 条件下具有完整证据，按严格通过率排序，去除重复代码树，确定性处理平分，并保留精英集合。这是教学组件，与历史完整分阶段引擎分别标注。

```bash
npm run build
node examples/evolution-search/replay.mjs
node --test examples/evolution-search/selection.test.mjs
```

replay 先展示历史轮次，再在明确标注的合成 fixture 上运行组件；不会调用模型或写入实验状态。

```javascript
import { ComponentRegistry } from 'rsi-gear';
import { registerElitistSelector } from './examples/evolution-search/selection.mjs';
const registry = new ComponentRegistry();
const selectorRef = registerElitistSelector(registry);
const selector = registry.selector(selectorRef);
// 在自定义 RefineService 组合中：
// options.selection.strategy = selectorRef;
// 同一个 registry 作为 RefineService 最后一个构造参数传入。
```

组装服务时，将该 ref 放入 `RefineServiceOptions.selection.strategy`。当前 stock standalone CLI 在内部选择内置组件 ref，单纯注册不会自动启用新选择器。可基于 [Standalone 控制面源码](../../../src/skill/control-plane.ts)创建自定义组合，在 service 构造前替换 ref，传入同一个 registry；不修改旧 evolution 的封存 spec。组件源码和配置 digest 用于标识新算法。

## 使用 GEPA 进行分阶段评测

本实验使用 GEPA 算法，采用 Gear 的 `failure-cluster-gepa-v1` 变体。共享诊断将失败归类，为 Meta 生成不同方向的变异 workplan；候选依次接受局部、bridge 和全量评测，采用 4 → 2 → 1 的候选预算。

完整分阶段路径需要更多机制。原同步 `CandidateGenerator.plan()` 在异步失败诊断前分配槽位；基于证据生成 workplan，需要框架中的 admission/planning 生命周期支持。

固定版本新增 search 合同、archive 存储、scope sampling、共享诊断、执行引擎与晋升检查。每轮先冻结父代、archive 快照和预算，再由诊断封存 workplan 的假设、允许修改路径与任务 scope；恢复时沿用原决定，不重新抽样。

[实际算法设置](../../../examples/evolution-search/algorithm-settings.json)包含：

```json
{
  "search": {
    "mode": "failure-cluster-gepa-v1",
    "seed": 0,
    "parentBatchCount": 1,
    "evaluationStages": {
      "bridge": { "maxCandidates": 2 },
      "globalSeed": { "maxCandidates": 1 },
      "reuseValidCells": true
    }
  }
}
```

这是解释性节选；下载文件包含完整 search、promotion 和 budget 设置，但不是可直接部署的完整 server 配置。使用固定版本结合真实部署身份，或把教学组件适配到当前 checkout。

最多四个 workplan 分别针对不同失败问题，local 后最多两个进入 bridge，最多一个获得全量 100 题配额。local/shared/cross/bridge 比例为 8%/4%/3%/40%；去重回填后，实际 local 为 9、10 或 15 题。决策在冻结 scope 内比较，不直接比较不同 local 均值。复用有效 `(commit, task, attempt)`，只有新增执行消耗相应预算。

## 三轮实际结果

| 轮次 | 全量候选 | 探索了什么 | 新物理任务执行 |
| --- | --- | --- | --- |
| 起点 | baseline 36/100 | 复用案例一保留的 Harness：来源驱动的工作流与结构化 CLI 请求。 | 0 |
| 1 | c0：36/100 | 区分各项计算指标的统计范围；Drive 查询为空时扩大检索；逐条规则构建决策表；发送前检查收件人资格。 | 170 |
| 2 | 无 | 在请求辅助程序中校验收件人；先计算指标再筛选；区分批次成员资格与动作选择；独立查询未指明来源的规则。 | 104 |
| 3 | c2：40/100 | 写入记录前验证表格列结构变更；把缺失要求列为查询依赖；分离待处理记录查询与规则查询。 | 145 |

三轮共有 12 次实际 Meta 候选会话，10 个封存候选，2 个基于证据主动 decline。共 419 次物理任务执行、414 条有效 cell、5 条保留的无效执行。各阶段覆盖通过复用而重叠，不能相加当成新增模型工作。这些数量不是 API 请求数或 token 总量；实验也没有对等预算的算法对照，不能据此声称算法优于其他搜索方法。

## 最后一次 Meta 修改与最终 Harness

控制器交给该轮候选 Meta 的实际输入开头：

```text
You are the real Meta agent for ONE Gear candidate. The user requests three AutomationBench Marketing rounds with Gear failure-cluster-gepa-v1, Meta gpt-6-astra ultra and rollout gpt-5.6-luna medium. Gear owns the 4-to-2-to-1 staged evaluations and research archive. The verified historical baseline has 100 valid Marketing results, score 36/100; Gear imports it without new baseline rollouts. This is a shared-set research experiment with no independent held-out claims.
```

查看[实际 Meta 输入](../../../examples/evolution-search/meta-input.txt)与[最终补丁](../../../examples/evolution-search/last-meta-change.patch)。c2 修改两个 workflow：把未解决的批次要求列为显式查询依赖，并分离待处理记录查询与规则查询。检索规则时不盲目继承待处理队列的 unread/inbox/date 过滤。

真实补丁中的一条关键规则：

```diff
+Do not inherit unread-only, inbox-only, active-record, or processing-date filters
+into the guidance query. Governing instructions can be already read, outside
+the queue, or older than the records they govern. Keep the processing scope
+unchanged when broadening guidance discovery; an extra search hit is not itself
+a record to act on.
```

最终 champion 为 `a07408001d978e580bbdeab3d7f08d4d2034fb1a`。相对 medium baseline，14 题改善、10 题退步、76 题通过状态不变，36% → 40%；partial credit 从 0.811943599 到 0.838669818。原自动 round 因证据不足拒绝，后续补证和操作者晋升分别保留记录。

独立 max 评测得到 53/100，旧 Harness 的 max 为 50/100：11 题改善、8 题退步、81 题不变。没有新增 Meta 轮次，仅修复 1 个基础设施无效槽位，共 101 次物理执行、100 条有效计分结果，见[最终审计摘要](../../../examples/evolution-search/max-evaluation.json)。

[下载算法与 Harness 包](../assets/evolution-search-example.zip)或[浏览示例](../../../examples/evolution-search/README.md)。公开研究集参与过优化，官方私有集榜单不构成直接 SOTA 对比。

## 实现与版本

实际分阶段实现固定于 [Gear e172456](../assets/staged-search-source.zip)，开发于 PR 21。可阅读该版本的 `src/search/engine.ts`、`archive.ts`、`diagnosis.ts`、`scope-sampling.ts`、`promotion.ts` 和 `types.ts`。后续 API 变化不改变历史实验的版本归属。

在隔离 checkout 中研究该实现，可获取 PR 而不切换当前工作分支：

```bash
git fetch origin pull/21/head
git worktree add --detach ../gear-staged-example e172456672414bfe0a14c8b94fd1b640b6493c30
```

在该 checkout 构建，真实运行前先核对配置合同。第一轮与第二轮之间存在有记录的 Meta CLI/runtime 身份迁移，报告保留了这些变化。教程不提供凭据、私有状态副本或可能重启旧实验的 launch 脚本。

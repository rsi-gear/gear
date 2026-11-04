# Gear 算法工作流验证

这里验证 Gear 公共接口能否表达 13 种算法的关键行为。内置 GEPA 的迁移单独与 Gear 提交 `1f5c8e3` 对照。

**结果（2026-11-04）：13/13 个算法的下列关键机制都有通过的可执行用例。** 测试运行冻结的 Python 工作流和 Gear 运行器，用实际文件、封存版本、回执和终态断言行为。外部模型、目标反馈使用可控夹具；结果说明这些机制能由公共接口实现。复刻每个上游超参数、训练成本与论文分数未纳入这项验证。

| 算法 | 已验证的行为 |
|---|---|
| ADAS | 同一草稿设计后继续反思修改；中断恢复后看到前一轮文件，只在最终封存时产生一个候选 |
| ACE | 原题首测计入在线成绩，带反思的派生题面沿用原评分规则，重试的得分与原观察分别保存 |
| AHE | 校验角色声明路径与实际差异；允许已经合法的退分编辑作为下一轮诊断的起点 |
| Arbor | 概念树可以剪掉分支；下一编辑使用当前代码主干；训练回退跳过 dev，dev 打平保留主干 |
| DarwinX | 三方重组读主父代、donor、共同祖先；筛选和确认重新采样，按不变量决定是否接纳 |
| EvoHarness | 用批次首次轨迹反思，topic/general 两轮分别改 skill；来源绑定当前批次，后续批次使用新版本 |
| EvoPrompt | 多份文本作为角色输入；重复文本不占据新种群成员，应用新文本并用 dev 比较 |
| GEPA（训练集反思、开发集选择） | 同批父代的轨迹兼作反思和基线；训练参考答案给反思角色，独立可见的 dev 用于选择 |
| Meta-Harness | 从 seed 开始编辑，角色可查看多个已测历史版本、索引和授权轨迹；结果不收录这些目录 |
| ModularRSI | 各模块限路径编辑；集成角色查看分支；完整 diff 审查与“运行完成”单独判断 |
| OPRO | 根据历史 prompt 与分数，以及领先版本的实际输出提出新 prompt，去重后测量 |
| RRSI | 每个目标试验有成本、以重新采样校准；critic 可退回同一草稿修复，缺成本不能冒充零成本 |
| SkillOpt | 在配对任务上比较两个版本，合并补丁后仅在 dev 严格提升时采用，非法修改保留原候选 |

这 13 行可以分三组重跑：

- [ADAS、AHE、EvoHarness、Meta-Harness、ModularRSI](../../tests/integration/harness-workflows.spec.ts)。ADAS 将较差、打平和改进的设计都记入档案；EvoHarness 拒绝证据不足的 general skill；Meta-Harness 的编辑器读到旧版退分的源码和非首页轨迹；ModularRSI 在分支来源、可写范围和零分但成功执行的门槛上分别断言。[ADAS 生产配方](../../python/gear/algorithms/adas.py)与[其余工作流示例](../../examples/algorithms/harness_workflows.py)可单独阅读。
- [EvoPrompt、OPRO、Arbor、GEPA（训练集反思、开发集选择）、SkillOpt](../../tests/integration/prompt-workflows.spec.ts)。EvoPrompt 的 GA 与 DE 各在 Pi、DSH 上运行，使用适配器声明的指令文件；其余用例分别检查历史输出、主干与概念树、训练反思与 dev 选择、多文件补丁与平局处理。[机制夹具](../../tests/fixtures/prompt_workflows.py)描述固定的验收情境。
- [ACE、DarwinX、RRSI](../../tests/integration/research-workflows.spec.ts)。分别验证在线首测、三方重组与新试验组、按每次目标执行用量选择及草稿修复；[工作流示例](../../examples/algorithms/research_workflows.py)与拒绝场景另见下文。

另有两个独立边界检查。[Codex 操作用例](../../tests/integration/codex-operation.spec.ts)覆盖 ADAS 在第二次编辑及最终封存之后丢失回执，恢复后保留全部修改且无重复提交；[模型角色用例](../../tests/integration/model-role.spec.ts)通过本地 HTTP 服务验证一次请求、JSON 输出校验、未知结果处理以及冻结后的角色路由。

在仓库安装锁定的 Node 依赖及 Python 运行依赖（包括 PyYAML），将两个环境变量指向该 Python 3.12 环境，即可重跑矩阵：

```sh
export GEAR_PYTHON="$(command -v python3.12)"
export GEAR_TRAINING_TEST_PYTHON="$GEAR_PYTHON"
npm test -- tests/integration/prompt-workflows.spec.ts tests/integration/harness-workflows.spec.ts tests/integration/research-workflows.spec.ts --maxWorkers=2
```

读文件、挂载参考版本和轨迹材料均有体积界限；Meta-Harness 验证的是完整的授权 canonical 会话分页，未包含未导出的子会话。两种内置 Harness 可编辑自身声明的项目资源，固定上游运行时源码仍由 Harness 的构建与版本能力决定。

Gear 自身的回归另测 SeedGate、动态 seed champion、promotion widths、候选预算、生成预算、独立 held-out 和五个策略挂钩。验收时分别报告控制流/夹具验证、真实隔离执行器验证，以及外部模型或 benchmark 的实际运行范围。

## 内置 GEPA 与原版对照

从 `1f5c8e3` 导出原始 Python 包，给旧版与新版输入同一组确定性回执，比较每一步的操作批次、理由、研究记录与提名。默认流程、多父代及回退筛选、SeedGate、预算不足、诊断失败、部分生成失败六种场景的 JSON 逐字节相等。仓库内的策略回归见 `python/tests/test_gepa_workflow.py`。这一项验证的是 Gear 自身的 GEPA；表中的 GEPA（训练集反思、开发集选择） 另行验收。

## 独立测量与在线机制

项目在 `gear.yaml` 中声明可自适应使用的数据。这里的 train、dev 均为已有 seed 任务的具名、不重叠子集，最终 held-out 继续由原验收流程控制。示例配置如下。

```yaml
research_data:
  train: [train-a, train-b]
  dev: [selection-a]
  allow_derived_inputs: true
  include_train_labels: true
  report_only: true
```

已配置 Target 与可编辑工作区的 Meta profile 后，可直接运行 ADAS。例如上面的 dev 只有一道题，执行一轮设计与两次反思时，配置应至少容纳基线和新候选各一次评测、一个封存候选。

```python
from gear import Project
from gear.algorithms.adas import ADAS

run = Project.open(".").refine(algorithm=ADAS(max_steps=1, num_reflections=2))
```

`include_train_labels` 只向算法开放 train 参考内容；目标进程依然只从任务目录取得题面。该协议由项目准入后冻结，算法包的 options 不能授权这些能力。`report_only` 允许在实际试验预算内交付研究结果，无需购买全量基线或最终 held-out 试验，并禁止提名 champion。默认项目继续按原规则处理。

`ctx.measure(candidate, tasks=..., repetitions=..., group=..., key=...)` 运行独立试验。省略 group 时用 key 命名新试验组；显式重用相同候选、组与相同实例计划时复用已完成的观察，不再付费。修改同组计划会失败。任务实例有自己的 id 和来源 task_id，因此同一道题在同批出现多次、或分别加入不同反思，都保留独立身份。`ctx.data.derive(task, question, id=...)` 创建实际题面，沿用原任务的评分合同。`ctx.evaluate` 继续维护正式 seed 槽位，两类观察分别保存。

每条 `ResearchTrial` 带候选、实例、样本、输入摘要、来源操作、分数/状态、原始指标、目标用量和轨迹引用。目标用量缺失为 null。Hitch 的规范化 assistant 事件只能提供部分观测时，会标为 `complete:false`，要求完整 policy-token 成本的算法必须拒绝据此计算 RRSI 成本规则。公共轨迹引用使用不透明 trial_id；真正的 provider 定位信息只保存在操作回执中。`ctx.evidence.trajectory(trial, key=...)` 通过冻结的 reader 和源摘要读取获准页面。

`ctx.result(selected=..., candidates=..., data=..., nominate=False)` 可交付候选集合和算法自述数据。项目报告里的 `algorithm_result` 标注 `algorithm-reported`，与正式 gate 结果分列。默认 `ctx.result(selected=...)` 保持原提名语义，report-only 项目默认不提名。

实际执行路径的验证材料如下。

- `tests/integration/research-trials.spec.ts` 使用冻结 Python worker、DurableRunner、sealedProvider、HitchOperationProvider 和真实 benchmark 编译器。在提交回执丢失后恢复，覆盖独立重采样、显式复用、同题多实例、派生题面、未知用量，以及预算小于全量基线的 report-only 运行。
- `python/tests/test_research_inputs.py` 编译真实 LLM 评分任务，确认反思只改变目标 instruction.md，评分请求中的原题和参考内容保持原合同。
- `tests/integration/research-workflows.spec.ts` 使用实际 draft/candidate 存储和冻结 worker 运行 `examples/algorithms/research_workflows.py` 三个机制示例。ACE 只报告学习前首测；DarwinX 按三方来源生成并重新测量；RRSI 读取真实 pinned Hitch 轨迹页面，在批评后继续编辑同一草稿并按目标成本选择。外部模型及目标反馈为受控夹具，这些示例验证接口与控制流，不代表完整上游算法或外部模型效果实验。
- `python/tests/test_research_workflows.py` 补充拒绝案例，包括均分更高但破坏某父代任务的重组、伪造原文引述、缺失成本和 guard 不通过。
- `tests/unit/research-isolation.spec.ts` 与 `tests/unit/project-plan.spec.ts` 确认独立观察不会覆盖正式 seed 轨迹，也不会混进跨运行复用的基线分数和历史成本。

## 本次回归范围

在独立构建目录运行非训练 Vitest 回归，结果为 658 项通过、8 项按环境条件跳过。另有 139 项 Python 搜索、协议、评测与证据回归通过。上述三组算法矩阵共有 17 个集成场景，覆盖 13 个名字；矩阵的数量不等同于外部 benchmark 的执行次数。还核对了 npm 发布清单，作者指南、工作流示例、Python SDK 与模型执行器均包含在包内。

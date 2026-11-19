# Forge-inspired harness 外层配方

[`forge_experiment.py`](forge_experiment.py) 固定模型权重，用失败生成的练习改进 `AGENTS.md` developer prompt。每一步通过正式 `Project.refine(ReflectiveSearch(..., training_gate=True))` 执行；新题在后续新 run 准入。它是一个可执行的调用方配方，没有给 `gear.curriculum` 增加执行器、状态机或 adapters。

这是针对 IFEval 文本任务的 Forge-inspired 实现，行为依据 [Forge 论文附录 A](https://arxiv.org/html/2609.15209v1#A1)。它不代表论文全部环境、工具和多模块 LM 程序的复现，也不表示已经证明真实模型收益。

## 闭环行为

1. 固定 train/dev/test 及源码、算子描述、语义判定 prompt、模型和预算。先测初始 prompt 的逐题 dev 分数。
2. 排除逐题分数被其他候选支配的候选；按候选在多少 dev 题上并列最高分分配抽样权重，选择父候选。
3. 从当前混合训练池按打乱的 epoch 顺序取 batch。执行父候选、反思、约束检查及有限修订，再在**相同 batch** 执行新候选。只有严格提高训练均分的候选才进入候选池并获得 dev 评测。即使 dev 总分未提高，也保留这个候选的逐题分数。
4. 从父候选的完整训练执行建立失败记忆，dev/test 不作为诊断或生成材料。连续 `patience` 步没有刷新历史最好 dev 总分时，触发生成。
5. 按失败支持次数分配尝试预算，明确循环 positive / negative / boundary / stress 四类意图。每次均抽取真实支持案例；生成器可以修改白名单内的 IFEval 约束及其显式参数，因此负向和边界变异不被限制成原模板的主题改写。
6. 先执行官方 strict verifier 的参考答案及负例校准、来源与精确重复检查，再由独立模型调用判断任务和参考是否合理、是否符合目标失败机制及变异意图。最后的 `ValidatePractice` 报告用 **semantic** 类型记录目标一致性；模型判断不充当执行证明。只有完整通过的任务追加到训练池。
7. 生成事件后，旧记忆及引用保留供审计，活动记忆清空。未见原题与新题优先进入后续 batch，已访问题后置。每次扩池都保持这个访问状态；不修改已有任务。
8. 每一步重新准入一个 run；跨 run 只复制经过 manifest 核验的候选 prompt 字节，记录前一候选来源和新 anchor，不把旧 CandidateRef 当作新 run 权限。最终按固定 dev 总分选出候选，冻结后才打开 test。

生成预算计的是尝试次数，格式错误、空结果和验证拒绝均不会免费补齐。没有活动失败或合格生成题时明确保留原池。未知模型结果、执行身份改变和未完成搜索会停止；不会被记为普通数据拒绝。模型回执使用既有 `TextCalls` reconcile，正式搜索复用原 journal，外层重放核对每步冻结快照。

## 与论文的适配差异

| 部分 | 本示例的明确边界 |
| --- | --- |
| 执行对象 | 单个文本 prompt；使用 Pi 资源格式封存，但不执行 Pi 工具、extensions 或多模块程序 |
| 训练池 | 新 run 准入，保留 source family；没有单 run 动态任务权限 |
| 反思和归因 | 复用 `ReflectiveSearch` 的完整 batch 反馈与 `ContrastiveDiagnoser`；按 batch 合并不可变模式，不实现论文逐条 assign/create/rename 协议 |
| batch | 最后不足一个 batch 时不重复填充，符合当前唯一 task ID 合同；扩池后的未见优先规则保留 |
| 验证成本 | 每个新 run 还会测一次父候选 dev；这些额外评测计入调用成本。候选池使用第一次存下的逐题 dev 分数，不用重测结果偷偷重选历史分数 |
| 模式预算 | 默认 frequency / largest-remainder；频次相同按 mode ID 排序，单次诊断最多 8 模式；未实现模式描述原地改名 |
| 生成验证 | 官方约束检查与独立 LLM 语义判断；没有搜索工具或真实状态环境探索。只做精确去重，未声称做语义近重复过滤 |
| 停止 | 最后一步不生成无法进入下一步学习的数据；另有生成事件数和总逻辑调用上限 |

`ForgeStudy` 构造参数允许直接替换 `generator`、`diagnoser`、`selector` 以及 `fidelity_prompt`，配置进入冻结身份。任务转换、四类意图调度和官方验证留在这个具体调用方里，不引入统一转换层。替换后得到的是不同配方配置，不能沿用旧实验身份。

## 运行

先按 [基础示例](README.zh-CN.md) 准备固定依赖和官方 IFEval，再构建 Gear。`--previous-splits` 继承前序所有排除来源，切分改动必须使用新目录：

```bash
PYTHONPATH=python /tmp/gear-curriculum-llm-env/bin/python \
  examples/curriculum-harness/forge_experiment.py \
  --workspace /tmp/gear-forge-study \
  --ifeval-root /tmp/gear-curriculum-ifeval \
  --previous-splits /tmp/previous-study/splits.json \
  --steps 6 --patience 2 --batch-size 4 \
  --synthesis-attempts 8 --max-synthesis-events 2 --max-calls 600 \
  --phase all
```

`preflight` 只检查第一次 run；`optimize` 冻结选择而不打开 test；`all` 在完成选择后评测最终候选和初始基线。默认 split seed 为 `20261122`，8 train / 16 dev / 24 test，至少一个可确定参数的约束。它与四组正式对照是独立运行，不能将单配方结果当作固定/随机/失败三组效果对照。

保存的证据包括 `identity.json`、`steps/*.json`、各 run 的 journal、`lineage.json`、`synthesis-*/synthesis.json`、各次语义判断、`selection.json` 和可选的 `final.json`。使用 SDK 回执统计真实 token；逻辑 turn 上限不能限制 SDK 内部的 HTTP 重试或保证美元硬上限。回执缺失的用量保持未知。

## 已验证范围

`test_forge_curriculum_harness.py` 检查 Pareto/front 权重、连续扩池优先级、四向尝试及语义拒绝、配置身份。启用 `GEAR_TEST_FORGE_RUNTIME=1` 后，还通过真实 CLI、隔离 worker 与离线 process provider 执行三轮，验证训练门槛、持平候选保留、新题后续准入、外层中断恢复不重复提交、活动记忆清空以及 dev/test 不进入模型反思材料。该测试验证控制流与证据绑定，不是模型效果实验。

```bash
GEAR_TEST_FORGE_RUNTIME=1 PYTHONPATH=python python -m unittest \
  discover -s python/tests -p test_forge_curriculum_harness.py
```

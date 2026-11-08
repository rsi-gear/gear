# 数据分析 Harness 开发

实现 [Data Analyst Agent 工作流 v2](../../docs/data-analyst-agent-workflow-v2-spec.zh-CN.md)。一个 rollout 是一个逻辑实验；一个 Gear cell 是五次顺序实验。每轮从公共起点生成一次打乱的 5-fold CV，所有实验、候选及新旧 harness 共用这五折，按所选方案的 CV 均值比较。新任务没有额外的本地 val/test 留出集；最终导出才执行一次完整训练。

Target 的九阶段为：任务理解、EDA、验证设计、数据处理、特征工程、模型选择、调参、错误分析、选择交付。`task_inspect` 只加载一个阶段；阶段可以复用、跳过或回退，依赖变化会使下游结论失效。`experiment` 统一提供 `search/get/compare/record/run/select`；所有授权历史可以分页读取，旧记录缺失的配置保持 unknown。

Meta 以分析能力与交付质量为目标，从工具调用、代码、产物和实验记录诊断遗漏，改进 `workflow.yaml`、短提示词、技能及 `tools/experiment/`。插件的索引、缓存、迁移、查询排序与展示可修改；原始成绩、预算、执行和权限属于固定内核。`workflow.yaml` 使用 JSON 兼容 YAML，便于固定执行层读取。

[真实 Titanic 验收记录](../../docs/data-analysis-harness-validation-2026-11-06.zh-CN.md)包含同起点比较、五步选择、合并续跑、导出失败及修复后的精确交付。

Titanic 直接使用官方完整 CSV：891 行有标签数据全部参与 CV，418 行官方 test 只用于最终预测，不计分、不选模型。其他 Kaggle 任务可使用 **MLE-bench 任务目录与 prepared/public、prepared/private 格式**，已对齐 NOMAD 的双目标 RMSLE、May 2022 的概率 AUC。详见 [MLE-bench 接入与运行说明](../mle-bench/README.zh-CN.md)。固定 Python 依赖、CPU 和 Hitch local Docker；Target 动态生成 `build_pipeline(config)` 工厂，将学习型变换放入 sklearn Pipeline。运行时负责拟合、计分和预测处理。没有预写的 Titanic 模型，也不自动向 Kaggle 提交。

## 准备

构建 Gear 和对应 Hitch 源码。固定执行器使用干净 Git 仓库中的精确 commit；开发中的 Hitch CLI/producer 和该只读源码仓库可以分开指定。Hitch 必须声明 `run_output_artifacts=1`、`sealed_source_execution=1` 和资源能力 `bounded-tmpfs@1`。

运行镜像须固定 OCI digest，提供 `/opt/kaggle-runtime` 的只读 Python chroot、NumPy/Pandas/scikit-learn 与 libseccomp；沿用 Hitch 仓库的 `benchmark-packages/kaggle/runtime/Dockerfile`。生成代码只能看到 `/work/source`、`/work/inputs`、`/work/scratch`，没有网络、凭据、外部标签或进程 fork 权限。

```sh
node examples/data-analysis-harness/prepare.mjs \
  --out /absolute/research-project \
  --competition titanic \
  --train /absolute/titanic/train.csv --predict /absolute/titanic/test.csv \
  --hitch-repository /absolute/agent-hitch \
  --hitch-root /absolute/hitch-state \
  --hitch-executable /absolute/gear/assets/hitch-codex-wrapper.mjs \
  --executor-executable /absolute/agent-hitch/dist/bin/hitch.js \
  --executor-repository /absolute/clean-hitch-checkout \
  --executor-commit EXACT_COMMIT \
  --base-image REGISTRY/IMAGE@sha256:DIGEST --platform linux/arm64 \
  --model openai-codex/gpt-6-astra
```

准备阶段保留完整训练数据，不再切出本地 test 或 val。分类任务使用打乱的分层五折，回归任务使用打乱的普通五折；本协议不允许 Target 改折数、分组方式或划分种子。每轮种子由冻结的公共起点和验证策略确定，同轮两侧一致，恢复运行不变；合并后的下一轮重新划分。记录保存种子、行 ID、逐行折号、五折分数、均值、标准差和 OOF 预测。`--python` 可指定 Python；Titanic 也接受 `--deployment-train`/`--deployment-predict` 作为完整输入的兼容参数。其他 MLE-bench 任务保留 public/train.csv 和 public/test.csv，并可用 deployment 参数登记最终输入。路径、数据、划分、预测 schema、资产、执行代码与镜像绑定摘要。

普通 CSV 入口须显式加 `--legacy-csv`，同时提供 `--train --predict --id-column --target-column --family`；不再接受已经切分过的 `--existing-competition`。新 MLE 任务使用 `analysis-task@5`，Titanic/普通 CSV 使用 `analysis-task@6`，新实验使用 `analysis-experiment@5`。历史协议原样读取，不重写 digest，也不把旧留出集成绩视为新 CV 成绩。

搜索计划包含候选配置、固定五折、模型种子、`maxFits` 与 `refitReserve:1`；模型种子不改变本轮 CV 划分。N 个候选至少预留 `N × 5 + 1` 次拟合，实验只执行 N × 5 次，最后一次留给最终 refit，不追加本地测试拟合。可另外指定组件拟合调用上限 `maxFitCalls`。每个候选的实际参数、逐折结果、失败和消耗均记录。首版搜索采用显式枚举候选，配置接口见 [pipeline 技能](target-carrier/harness/skills/data-analysis/SKILL.md)。

`analysis-solution@2` 包含 ResolvedPipeline、实际参数清单、代码及运行时身份。最终 refit 只接受这个版本，不能重新搜索或改变参数。旧搜索程序仍可查询，但直接 refit 会被拒绝；必须在新登记的研究实验中迁移。新执行核心需要重新 prepare 并使用包含本次 Hitch 修改的执行器 commit；旧项目和此前 25 次实验保持封存。

模型凭据沿用既有 Hitch wrapper 配置，通过宿主环境提供，不写入配置或候选。模型 token/请求次数默认**不限额、仅记 usage**；内部重试和缺失 usage 未核验时报告下界，费用为 unknown。每条序列仍限定五次实验、1800 秒总时间、2400 CPU 秒、150 次工具调用，保留 300 秒/600 CPU 秒用于固定交付。工作区 1 GiB，单文件 16 MiB，输出合计 64 MiB。

## 公共起点与五次实验

默认项目上限是 25 个 Target 实验、5 条序列。顺序改进每轮登记一个 harness，5 轮共 25 次；配对比较每轮登记旧、新两个 harness，5 轮共 50 次，需要在新的研究计划中明确登记相应上限。Bootstrap 也占一个 Target 槽，不默认额外执行。下面是一次配对阶段的身份文件 `harnesses.json`：

```json
[
  {"commit":"REFERENCE_COMMIT","manifestDigest":"sha256:REFERENCE_MANIFEST"},
  {"commit":"CANDIDATE_COMMIT","manifestDigest":"sha256:CANDIDATE_MANIFEST"}
]
```

```sh
node examples/data-analysis-harness/research.mjs plan --project /absolute/research-project \
  --stage stage-1 --harnesses /absolute/harnesses.json
node examples/data-analysis-harness/research.mjs run --project /absolute/research-project \
  --stage stage-1 --commit REFERENCE_COMMIT
node examples/data-analysis-harness/research.mjs run --project /absolute/research-project \
  --stage stage-1 --commit CANDIDATE_COMMIT
```

两条分支可并行执行。每一步都是新会话，只继承本分支前序 checkpoint。代码失败、Debug、Confirm 和兼容历史解法登记均占一个槽。成功、无增益和失败实验都会保存；每步封存当时选择，不能用审计成绩改写 C1–C5。提前停止保留五个选择槽，未启动槽标记为 `not_started`。

重复同一命令只检查已登记的 run 或返回已封存 receipt，不会重抽模型样本。中断或基础设施未决时保留 pending 和预算预留；不要删除序列状态来重试。工具中断会调用 Hitch cancel；取消后不能重启该序列。异常退出遗留锁时，应先核实锁中 PID 已终止再恢复控制器，不能并发强行解锁。

## Gear 比较与 Meta

`compare.mjs` 对两份已预登记方法使用真实 staged search、raw metrics 和开发晋升。它不生成新候选，也不声称自主 Meta 发现了预登记修改：

```sh
node examples/data-analysis-harness/compare.mjs --project /absolute/research-project \
  --config /absolute/base-config.json --stage stage-1
```

主目标为实际 C5 所选方案的五折平均 utility，即 Titanic 的平均 accuracy，要求 `valid_output >= 1`。序列结束时认证并引用已有 CV receipt，不另跑测试集。这是开发选择分数，不是独立测试分数或 Kaggle 官方分数。共享集模式复用原 seed 证据；关闭 `allowSharedSetPromotion` 时只给建议。独立验证模式和任务/计分条件不一致时拒绝复用。缺失必需产物的 cell 不可晋升。

自主候选编辑使用 `start.mjs` 接入既有 Refine Skill/隔离 Meta runner：

```sh
node examples/data-analysis-harness/start.mjs --project /absolute/research-project \
  --config /absolute/base-config.json --prepare-only
node examples/data-analysis-harness/start.mjs --project /absolute/research-project \
  --config /absolute/base-config.json

GEAR_META_TASK_CONTEXT_FILE=/absolute/gear/examples/data-analysis-harness/meta-task-context.txt \
  node examples/codex-skill-meta-runner.mjs --evolution-id ID --round-id ID
```

基础配置和 runner 环境见 [Meta 部署指南](../../docs/harness-agnostic-refine-skill.md)。保留打印出的控制面 socket 与真实 Meta identity；不要使用占位身份。运行 Meta 的宿主仍须隔离原始数据、私有标签和凭据。具有全盘 shell 的开发聊天不构成该隔离证明。

`start.mjs` 使用配对评估，打印的预算预览会包含两侧全部 Target 槽。Meta 的主提示位于 `harness/prompts/meta.md`，部署时通过上面的 `GEAR_META_TASK_CONTEXT_FILE` 加载。诊断先看概览，再用公共 `trajectory.query` 查询工具调用/结果，并绑定 run、canonical digest、seq 与字段。不得将未获取到的证据当作未执行某阶段。

工程验收：`node --test examples/data-analysis-harness/tests/*.test.mjs`；带 pandas/sklearn 的 Python 执行 `tests/test_workflow_runtime.py`。设置 `GEAR_ANALYSIS_HITCH_REPOSITORY` 可验证两仓协议一致。测试涵盖原 25 条记录回放、阶段复用、插件迁移失败恢复、预算与最终配置冻结；这些检查不产生新的 Kaggle 分数。

## 审计、合并与续跑

```sh
node examples/data-analysis-harness/report.mjs --project /absolute/research-project \
  --sequence PLAN_DIGEST --audit
node examples/data-analysis-harness/research.mjs merge --project /absolute/research-project \
  --stage stage-1 --adopted ADOPTED_COMMIT --decision-ref /absolute/comparison.json
```

新 CV 协议的审计只复用本轮已封存的 CV 结果，不调用模型、不新增拟合。历史留出集协议仍可按原规则补做最多五个 refit，使用独立的 1500 秒/3000 CPU 秒预算。报告分别列出最终质量、五点曲线、oracle、选择损失和覆盖缺失，未知值不按零处理。审计和外部评分永远不导入 Target checkpoint。

合并包括未晋升分支与负结果，公共 current solution 指向采用分支的 C5；项目总预算不重置。`--decision-ref` 接受包含 `adoptedCommit` 的决策 JSON 或已保存的 CAS 引用，阶段日志绑定该决策的不可变内容。`stage-2` 从新 head 开始重新登记计划；新 checkpoint 创建新 cohort，`start.mjs` 默认采用上一阶段选中的 harness。不同 checkpoint 的分数不能解释为 harness 增益。

`checkpoint.mjs export/import` 支持源代码、OOF 与内部实验历史的完整闭包；import 会用 Hitch 公共 artifact 接口逐条认证原始 receipt，并核验标签权限与验证计划。import 返回 CAS 引用，不自动移动公共 head。

固定交付因基础设施失败时，可在原序列截止前执行一次显式恢复：

```sh
node examples/data-analysis-harness/research.mjs recover-delivery \
  --project /absolute/research-project --stage stage-1 --commit EXACT_COMMIT \
  --reason '已查明并修复的基础设施原因'
```

恢复保持原 request、solution 和槽位，保留原 run 身份，未知旧消耗按 600 CPU 秒保守计入。有效低分、已确认的候选失败和取消不能走此路径。原生 verifier-only/collect-only 修复使用 Hitch 的公共恢复接口，再检查同一 operation；不重跑 Target。

## 最终导出

```sh
node examples/data-analysis-harness/refit.mjs --project /absolute/research-project \
  --sequence SELECTED_SEQUENCE_PLAN_DIGEST --out /absolute/finalization
```

入口只接受该序列真实有效的 C5，核验源任务、预算、runtime、harness、每个子 run 与输出清单。相同 solution 在准备阶段登记的 refit 输入上重训，导出 `submission.csv` 和 `refit.json`；模型请求为零，不产生外部测试成绩。Titanic 在全部 891 行上拟合一次，为官方 418 行生成预测；其他任务须在准备时登记所需 deployment 输入。来源或产物不完整时停止，不自动改选 oracle。候选代码在 refit 中失败时，仍保存 `refit.json` 并结算成本；再次执行返回相同失败，不重跑源码。需要修改解法时，应在新阶段预登记新的实验机会。

## 验证

```sh
GEAR_ANALYSIS_HITCH_REPOSITORY=/absolute/agent-hitch \
  node --test examples/data-analysis-harness/tests/*.test.mjs
npx vitest run tests/unit/search-seed-reuse.spec.ts tests/unit/search-evaluation-adapter.spec.ts
```

`tests/worker-canary.py` 须在真实固定镜像中运行，挂载 fixed 源码到 `/runner`、临时盘到 `/opt/kaggle-runtime/work` 和 `/run`。它使用非 Titanic schema 检查五折行隔离、OOF 汇总、伪造分数、路径/网络/凭据/进程越权、CPU 与输出限制。

`tests/workflow-canary.py` 在同一固定镜像中检查实际 Pipeline 拟合：两个候选各五折，共十次拟合，无额外留出集拟合；最终 refit 一次且没有搜索。临时盘使用 root 所有、`mode=0755`，保证 chroot 预检通过。

首版只证明单任务开发链路。`lib/exposure.mjs` 提供按数据来源记录的迁移冻结与曝光账本；本次没有运行多任务 transfer suite，不声称泛化能力提升。

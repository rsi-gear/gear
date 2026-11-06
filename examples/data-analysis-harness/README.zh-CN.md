# 数据分析 Harness 开发

实现 [analysis-five-rollout@1 规范](../../docs/data-analysis-harness-spec.zh-CN.md)。一个 rollout 是一个实验；一个 Gear cell 是同一 harness 从同一个公共 checkpoint 出发的五次顺序实验，以及一次不调用模型的 C5 交付。五折 CV 在每次实验内部完成。

[真实 Titanic 验收记录](../../docs/data-analysis-harness-validation-2026-11-06.zh-CN.md)包含同起点比较、五步选择、合并续跑、导出失败及修复后的精确交付。

新 Kaggle 任务统一使用 **MLE-bench 任务目录与 prepared/public、prepared/private 格式**。已对齐 NOMAD 的双目标 RMSLE、May 2022 的概率 AUC，并提供自定义 Titanic accuracy 任务。详见 [MLE-bench 接入与运行说明](../mle-bench/README.zh-CN.md)。固定 Python 依赖、CPU 和 Hitch local Docker；Target 动态生成训练代码，Meta 可修改通用提示、技能和 `workflows/research/{policy.py,memory.py,policy.json}`。没有预写的 Titanic 模型，也不自动向 Kaggle 提交。

## 准备

构建 Gear 和对应 Hitch 源码。固定执行器使用干净 Git 仓库中的精确 commit；开发中的 Hitch CLI/producer 和该只读源码仓库可以分开指定。Hitch 必须声明 `run_output_artifacts=1`、`sealed_source_execution=1` 和资源能力 `bounded-tmpfs@1`。

运行镜像须固定 OCI digest，提供 `/opt/kaggle-runtime` 的只读 Python chroot、NumPy/Pandas/scikit-learn 与 libseccomp；沿用 Hitch 仓库的 `benchmark-packages/kaggle/runtime/Dockerfile`。生成代码只能看到 `/work/source`、`/work/inputs`、`/work/scratch`，没有网络、凭据、外部标签或进程 fork 权限。

```sh
node examples/data-analysis-harness/prepare.mjs \
  --out /absolute/research-project \
  --mlebench-repository /absolute/mle-bench \
  --mlebench-data /absolute/mle-bench-data --competition titanic \
  --hitch-repository /absolute/agent-hitch \
  --hitch-root /absolute/hitch-state \
  --hitch-executable /absolute/gear/assets/hitch-codex-wrapper.mjs \
  --executor-executable /absolute/agent-hitch/dist/bin/hitch.js \
  --executor-repository /absolute/clean-hitch-checkout \
  --executor-commit EXACT_COMMIT \
  --base-image REGISTRY/IMAGE@sha256:DIGEST --platform linux/arm64 \
  --model openai-codex/gpt-5.6-luna
```

MLE-bench 导入保留原 public/train.csv 和 public/test.csv，不再切分外层测试集；仅在 public/train.csv 上冻结五折。`--python` 可指定 Python。`--deployment-train` 与 `--deployment-predict` 可另行登记 Kaggle 官方训练集和测试集，供最终固定源码重训使用；不传时 refit 仍使用公开 benchmark 输入。所有路径、行集合、五折计划、预测 schema、公开资产和镜像均绑定内容摘要。标签、producer、scorer 或执行条件改变会阻止原合同继续使用。

旧 CSV 入口须显式加 `--legacy-csv`，同时提供 `--train --predict --id-column --target-column --family`；该兼容入口仍接受 `--existing-competition`。历史 `analysis-task@1` / `analysis-experiment@1` 保持原 accuracy 语义；新格式使用 `@2`。

模型凭据沿用既有 Hitch wrapper 配置，通过宿主环境提供，不写入配置或候选。模型 token/请求次数默认**不限额、仅记 usage**；内部重试和缺失 usage 未核验时报告下界，费用为 unknown。每条序列仍限定五次实验、1800 秒总时间、2400 CPU 秒、150 次工具调用，保留 300 秒/600 CPU 秒用于固定交付。工作区 1 GiB，单文件 16 MiB，输出合计 64 MiB。

## 公共起点与五次实验

先运行一次公开 bootstrap，成本归入共同历史。随后冻结两份精确 harness 身份，例如 `harnesses.json`：

```json
[
  {"commit":"REFERENCE_COMMIT","manifestDigest":"sha256:REFERENCE_MANIFEST"},
  {"commit":"CANDIDATE_COMMIT","manifestDigest":"sha256:CANDIDATE_MANIFEST"}
]
```

```sh
node examples/data-analysis-harness/research.mjs bootstrap --project /absolute/research-project
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

主目标为实际 C5 的 `total_score`，要求 `valid_output >= 1`。共享集模式复用原 seed 证据，不增加 held-out 物理 run；关闭 `allowSharedSetPromotion` 时只给建议。独立验证模式和任务/计分条件不一致时拒绝复用。缺失必需产物的 cell 不可晋升。

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

## 审计、合并与续跑

```sh
node examples/data-analysis-harness/report.mjs --project /absolute/research-project \
  --sequence PLAN_DIGEST --audit
node examples/data-analysis-harness/research.mjs merge --project /absolute/research-project \
  --stage stage-1 --adopted ADOPTED_COMMIT --decision-ref /absolute/comparison.json
```

审计在序列封存后执行，不调用模型，最多补做五个 refit，使用独立的 1500 秒/3000 CPU 秒预算。实际 C5 直接复用。报告分别列出最终质量、五点曲线、oracle、选择损失和覆盖缺失，未知值不按零处理。审计和外部评分永远不导入 Target checkpoint。

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

入口只接受该序列真实有效的 C5，核验源任务、预算、runtime、harness、每个子 run 与输出清单。相同 solution 在准备阶段登记的 refit 输入上重训，导出 `submission.csv` 和 `refit.json`；模型请求为零，不产生外部测试成绩。要输出 Kaggle 官方 test，须在准备时登记 deployment 输入。来源或产物不完整时停止，不自动改选 oracle。候选代码在 refit 中失败时，仍保存 `refit.json` 并结算成本；再次执行返回相同失败，不重跑源码。需要修改解法时，应在新阶段预登记新的实验机会。

## 验证

```sh
GEAR_ANALYSIS_HITCH_REPOSITORY=/absolute/agent-hitch \
  node --test examples/data-analysis-harness/tests/*.test.mjs
npx vitest run tests/unit/search-seed-reuse.spec.ts tests/unit/search-evaluation-adapter.spec.ts
```

`tests/worker-canary.py` 须在真实固定镜像中运行，挂载 fixed 源码到 `/runner`、临时盘到 `/opt/kaggle-runtime/work` 和 `/run`。它使用非 Titanic schema 检查五折行隔离、OOF 汇总、伪造分数、路径/网络/凭据/进程越权、CPU 与输出限制。

首版只证明单任务开发链路。`lib/exposure.mjs` 提供按数据来源记录的迁移冻结与曝光账本；本次没有运行多任务 transfer suite，不声称泛化能力提升。

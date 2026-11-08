# MLE-bench 适配

本示例将 MLE-bench 的任务定义和 prepared 数据接入 Gear Project API。Gear 使用 Python GEPA 比较和晋升研究方法，Hitch 负责隔离执行、固定评分和输出取证。导入、执行、评分、导出及测试均位于本目录。

每个候选方法从同一 checkpoint 开始，按统一配置进行顺序实验。新项目对全部训练行使用打乱的 5-fold CV，同一轮新旧 harness、全部实验及候选共用同一划分；合并后的下一轮重新划分，恢复运行不会重抽。按最终槽所选方案的 CV 平均 utility 比较方法，不追加本地 val/test 评分。这是开发选择证据，不等于独立测试或 Kaggle 官方成绩。

本次对齐固定上游 commit `507f92e1138bb6e40dac5c6ee7a6758e6424bf97`。[上游说明](https://github.com/openai/mle-bench/blob/507f92e1138bb6e40dac5c6ee7a6758e6424bf97/README.md)和实际 Python 源码是格式依据。实现覆盖下面三个明确注册的表格任务；新增 grader 要补充固定评分适配和与上游的一致性测试，未知 grader 会在导入时拒绝。

## 两个参照任务

| 项目 | NOMAD 2018 | Tabular Playground May 2022 |
|---|---|---|
| ID | `nomad2018-predict-transparent-conductors` | `tabular-playground-series-may-2022` |
| 公开数据 | `train.csv`、`test.csv`、`sample_submission.csv`，以及 `train/<id>/geometry.xyz`、`test/<id>/geometry.xyz` | `train.csv`、`test.csv`、`sample_submission.csv` |
| 目标 | `formation_energy_ev_natom`、`bandgap_energy_ev` | `target` |
| 提交 | 两列非负连续值 | 0–1 概率 |
| 原指标 | 两列分别计算 RMSLE 后取均值，越低越好 | ROC AUC，越高越好 |
| 上游外层划分 | 原有标签 train 的 90% / 10%，seed 0 | 原有标签 train 的 800,000 / 100,000，seed 0 |
| ID | train/test 各自从 1 编号，跨集合允许重叠 | train/test 重新编号，两个集合不重叠 |
| 评分对齐 | 上游按行位置比较，因此严格按 sample/test 顺序导出 | 上游按 ID 对齐 |

这些差异分别来自 [NOMAD prepare](https://github.com/openai/mle-bench/blob/507f92e1138bb6e40dac5c6ee7a6758e6424bf97/mlebench/competitions/nomad2018-predict-transparent-conductors/prepare.py)、[NOMAD grade](https://github.com/openai/mle-bench/blob/507f92e1138bb6e40dac5c6ee7a6758e6424bf97/mlebench/competitions/nomad2018-predict-transparent-conductors/grade.py)、[May prepare](https://github.com/openai/mle-bench/blob/507f92e1138bb6e40dac5c6ee7a6758e6424bf97/mlebench/competitions/tabular-playground-series-may-2022/prepare.py) 和 [May grade](https://github.com/openai/mle-bench/blob/507f92e1138bb6e40dac5c6ee7a6758e6424bf97/mlebench/competitions/tabular-playground-series-may-2022/grade.py)。

MLE-bench 的 `public/test.csv` 是本地 benchmark 测试集。它由原始有标签训练集重新划分，不等于 Kaggle 官方无标签 test。benchmark 答案只能用于独立 verifier；用于正式 Kaggle 提交的全量训练/test 必须另行登记。

## 目录与接口

```text
mle-bench/                         # 固定版本的上游源码
  mlebench/competitions/<id>/
    config.yaml                   # dataset 路径、grader、preparer
    description.md
    prepare.py                    # prepare(raw: Path, public: Path, private: Path)
    grade.py                      # grade(submission: DataFrame, answers: DataFrame) -> float
    checksums.yaml
    leaderboard.csv               # 官方任务排名/奖牌报告使用

data-root/<id>/
  raw/
  prepared/
    public/                       # Target 可见
      train.csv
      test.csv
      sample_submission.csv
      ...                         # 保留目录和附属文件
    private/                      # 只在独立 verifier 中可见
      test.csv
      gold_submission.csv         # 可选；由 config.yaml 声明
```

`config.yaml` 使用原生字段 `id/name/competition_type/description/dataset/grader/preparer`。`description` 相对源码仓库；`dataset` 下的路径相对 data-root；Python 入口沿用 `module:function`。私有 test 可以含特征列，Gear 只将 ID 和目标列复制到 verifier 的 `expected.csv`。完整私有表、grader 与宿主路径不进入研究 checkpoint。

导入保留公开 CSV 的原始字节与行序；读取 sample_submission 推导 ID、目标列和导出顺序。全部公开 train 行参与五折，分类使用分层划分。学习型变换放入 `build_pipeline(config)` 返回的 Pipeline，每折仅用该折训练标签拟合。NOMAD 每折只挂载对应资产，验证行资产由 `train/<id>/` 映射成 `test/<id>/`，外层 test 资产不进入训练。记录保存逐行折号、OOF 预测、五折分数、均值和标准差。模型种子与本轮划分种子独立。

输入身份包含定义文件、grader 及共享 helper 的 SHA-256、全部公开文件的递归 SHA-256、CSV 字节摘要、留出划分和 runtime。官方 prepared 数据先核对上游 MD5 checksums；未被上游 checksums 列出的几何文件仍被本次导入的 SHA-256 冻结。改变数据、grader 或运行条件需要新项目，不能续用原 checkpoint。

## 准备官方任务

先构建 Gear 和配套的 [Hitch 适配](https://github.com/rsi-gear/agent-hitch/pull/61)。Hitch 须支持 `run_output_artifacts=1`、`sealed_source_execution=1` 和 `bounded-tmpfs@1`。固定执行器使用干净 Git checkout 的精确 commit。

运行镜像使用 Hitch 的 `benchmark-packages/kaggle/runtime/Dockerfile`，以 OCI digest 固定，提供只读 Python chroot、NumPy/Pandas/scikit-learn 与 libseccomp。生成代码只能访问本次实验的源码、输入与临时目录，无法访问网络、凭据和私有标签。

```sh
npm ci
npm run build
```

使用 MLE-bench 环境按照上游要求准备已经获得访问权限的数据：

```sh
mlebench prepare -c nomad2018-predict-transparent-conductors
mlebench prepare -c tabular-playground-series-may-2022
```

随后将实际 data-root 和固定源码路径传给 Gear：

```sh
node examples/mle-bench/mlebench.mjs inspect \
  --repository /absolute/mle-bench --data-root /absolute/mle-bench-data \
  --competition nomad2018-predict-transparent-conductors

node examples/mle-bench/prepare.mjs \
  --out /absolute/research-project \
  --mlebench-repository /absolute/mle-bench \
  --mlebench-data /absolute/mle-bench-data \
  --competition nomad2018-predict-transparent-conductors \
  --python /absolute/python-with-mlebench \
  --hitch-repository /absolute/agent-hitch \
  --hitch-root /absolute/hitch-state \
  --hitch-executable /absolute/gear/assets/hitch-codex-wrapper.mjs \
  --executor-executable /absolute/agent-hitch/dist/bin/hitch.js \
  --executor-repository /absolute/clean-hitch-checkout \
  --executor-commit EXACT_COMMIT \
  --base-image REGISTRY/IMAGE@sha256:DIGEST --platform linux/arm64 \
  --model openai-codex/gpt-5.6-luna
```

May 2022 只需替换 competition ID。数据准备环境需 pandas、scikit-learn、PyYAML、py7zr、appdirs、tqdm 等上游依赖；执行环境仍是固定容器。模型凭据沿用现有 wrapper 环境变量。

## Titanic 自定义任务

Titanic 不属于这份上游官方任务集；本仓库提供兼容扩展，明确标记为自定义任务，不声称官方 MLE-bench/Lite 成绩或奖牌。将任务定义安装进固定上游 checkout，再使用真实 Titanic `train.csv` 准备：

```sh
cp -R examples/mle-bench/competitions/titanic /absolute/mle-bench/mlebench/competitions/
mkdir -p /absolute/mle-bench-data/titanic/raw
cp /absolute/titanic/train.csv /absolute/mle-bench-data/titanic/raw/train.csv
node examples/mle-bench/mlebench.mjs prepare-local \
  --repository /absolute/mle-bench --data-root /absolute/mle-bench-data \
  --competition titanic --python /absolute/python-with-mlebench
```

`prepare-local` 直接调用原生 `Registry.get_competition(...).prepare_fn`，拒绝覆盖已存在的 prepared 目录。随附 checksums 对应真实 891 行 Titanic 的固定分层 seed 0 划分：713 行 public/train、178 行 public/test。`--record-checksums` 仅允许自定义 Titanic 初次生成 checksums；官方任务不允许该选项覆盖上游 checksums。

按照上面的 Gear prepare 命令使用 `--competition titanic`。需要最终 418 行 Kaggle 提交时，准备阶段再加：

```sh
--deployment-train /absolute/titanic/train.csv \
--deployment-predict /absolute/titanic/test.csv
```

这两个输入只用于已选解法 的固定源码重训，不能改变本地 benchmark 数据或研究历史。当前 deployment 登记支持无逐行附属文件的任务；需要新的资产映射时应建立独立任务定义。

## 实验预算、统一验证和导出

准备时可通过 `--research-config /absolute/research-config.json` 传入统一配置，例如：

```json
{"maxExperiments": 7, "validation": {"folds": 5, "shuffle": true, "scope": "round", "seed": 42}}
```

不传时使用 `lib/research-config.mjs` 中的默认值。实验数和预算随项目冻结，同轮分支共用相同起点和五折划分。`task_inspect.experiments` 动态提供当前槽和剩余次数；`task_inspect.validation` 提供本轮策略；`task_inspect.training` 提供受剩余总预算约束的训练墙钟和 CPU 上限。五折、打乱和整轮共享由固定执行层强制，Target 不能改变。历史项目可读取原 fraction 配置，新项目只能登记 round CV。

最终无模型交付会用完整公开 train（包括研究验证行）重训已选源码，并在原 MLE-bench public/test 上预测；原 private 答案仅用于外部 verifier。

准备好 Meta profile 后运行：

```sh
node examples/mle-bench/start.mjs --project /absolute/research-project \
  --meta-profile META_PROFILE --prepare-only
node examples/mle-bench/start.mjs --project /absolute/research-project \
  --meta-profile META_PROFILE
```

`start.mjs` 生成标准 `gear.yaml` 项目，并通过 Project API 运行 Python GEPA。Meta 只能修改通用提示、技能和 `workflows/research/{policy.py,memory.py,policy.json}`；Target 在固定 carrier 中生成训练代码。配置与身份管理见 [Refine Skill](../../skills/refine/SKILL.md)。

相同命令会恢复已登记的 run；也可显式传入 `--resume RUN_ID`。恢复保留实验 ID、预算预留和已封存结果，不重新采样。原预算到期后仍可核验和收取已完成执行的结果，但不能重新提交未完成或未登记的执行。源数据、grader、执行条件或 checkpoint 改变时需要新项目或新 cohort。不要删除运行状态来重试。

每个 harness 一个序列，实验槽数量来自 `research.maxExperiments`；失败、Debug、Confirm 和复用都消耗槽位。单次正式训练上限为 1800 秒（30 分钟）墙钟、3600 CPU 秒，以容纳 2 CPU 持续运行；工具包装层超时为训练上限加 60 秒，固定评分与数据检查仍计入总预算。训练时长在固定合同中定义，可编辑 prompt 从工具读取。

序列预算按实验数 N 派生：墙钟为 `N × (1800 + 300) + 1800` 秒，CPU 为 `N × (3600 + 60) + 3600` 秒。每个实验另计 5 分钟墙钟、60 CPU 秒的分析与编排余量，最终交付预留 30 分钟墙钟、3600 CPU 秒。默认 N=5 时，总墙钟为 12300 秒（3 小时 25 分钟），总 CPU 为 21900 秒；工具调用仍为 150 次。bootstrap、独立重训和审计也从已登记预算取得训练时限，Hitch 的固定重训执行器支持相同的 30 分钟上限。项目保留最多 12 条研究序列，总墙钟/CPU 上限按序列预算的 12 倍计算，辅助操作也计入其中。模型 token/请求只记录 usage，不设置硬上限；缺失 usage 或内部重试无法核实时，成本只表示下界。新预算在准备新项目时冻结，已登记项目的预算不会被续跑命令改写。

新记录使用 `analysis-task@5`（MLE-bench）或 `analysis-task@6`（Titanic/直接 CSV），实验使用 `analysis-experiment@5`。正式选择记录 `meanScore`、`meanUtility`、`stdScore`、`foldMetrics` 和 OOF 摘要。accuracy/AUC 的 utility 等于原分数；RMSLE 先对每折做 `1/(1+score)` 再求均值。序列结束认证已封存的 CV 结果，不新增拟合。历史协议保持可读，不把旧留出分数或不同轮次的 CV 分数直接排名。

验证预测通过内容寻址保留全部 ID 与预测值。大表使用确定性的 gzip JSON，单个压缩产物限 16 MiB、解压限 64 MiB；读端兼容此前的普通 JSON，按页向模型提供记录。80 万行概率 OOF 已验证无损往返，不靠截断记录来满足产物上限。

导出本地 benchmark 的最终解法的已封存预测，不重新调用模型或重训：

```sh
node examples/mle-bench/mlebench.mjs export \
  --project /absolute/research-project --sequence SEQUENCE_DIGEST \
  --out /absolute/benchmark-submission

node examples/mle-bench/mlebench.mjs grade \
  --repository /absolute/mle-bench --data-root /absolute/mle-bench-data \
  --competition titanic --python /absolute/python-with-mlebench \
  --submission /absolute/benchmark-submission/submission.csv
```

输出 `submission.csv`、来源 receipt 和标准 `submissions.jsonl`：

```json
{"competition_id":"titanic","submission_path":"/absolute/benchmark-submission/submission.csv"}
```

`grade` 调用上游 Registry 与 Grader，报告未舍入的 `raw_score` 和上游保留五位小数的 `score`。官方任务可另交上游 CLI 生成 leaderboard 报告；自定义 Titanic 没有与新划分匹配的官方 leaderboard，使用原生 Grader 入口，`medals` 为 null，不生成虚构排名。

官方 Kaggle 418 行导出使用 `refit.mjs --project ... --sequence ... --out ...`。它核验已登记 deployment 输入，执行同一最终解法源码，模型请求为零。此文件与 178 行 benchmark submission 分目录保存。两者都不会自动上传 Kaggle。

## 预登记比较和 checkpoint

需要比较两份已知研究方法时，将其精确 `commit` 和 `manifestDigest` 写入 `harnesses.json` 数组，再运行：

```sh
node examples/mle-bench/research.mjs plan --project /absolute/research-project \
  --stage stage-1 --harnesses /absolute/harnesses.json
node examples/mle-bench/compare.mjs --project /absolute/research-project --stage stage-1 \
  > /absolute/comparison.json
node examples/mle-bench/research.mjs merge --project /absolute/research-project \
  --stage stage-1 --adopted ADOPTED_COMMIT --decision-ref /absolute/comparison.json
```

`compare.mjs` 使用 Project/Python GEPA 比较已登记方法。合并保留失败和未晋升分支的实验事实，公共 current solution 指向采用分支的最终解法，项目总预算继续累计。可以从空 checkpoint 开始；可选 `research.mjs bootstrap` 的成本计入共同历史。

`research.mjs run --project ... --stage ... --commit ...` 可单独执行某个已登记方法。`report.mjs --project ... --sequence ... --audit` 生成诊断报告；审计不能改变实际各槽选择。`checkpoint.mjs export/import` 处理包含源码、验证预测和实验历史的闭包，并认证原始 Hitch receipt。

[Checkpoint 示例](fixtures/checkpoint-holdout.example.json) 展示四条实验记录：基线、分数下降而未采用的改动、训练超时失败、修复后采用的新解法。该文件通过当前 schema 和摘要校验，但所有分数与产物引用都是示意数据，没有对应的真实 Hitch 执行，不能作为可导入的执行证据。

Checkpoint 的 `history` 保存全部已封存实验及合并分支，包括失败、负结果和未晋升方法。记录涵盖假设、阶段证据、候选配置、实际参数、逐折结果、成本和解释。`experiment` 统一提供 `search/get/compare/record/run/select`，完整授权历史可以分页读取，旧记录缺失的信息保持 unknown。公共 current solution 指向采用分支的最终选择，源码、OOF 和分析产物按内容摘要保存。官方成绩不导入 Target checkpoint。

## Titanic 全量 CV 与分析工作流

Titanic 使用官方 train.csv 的全部 891 行，不保留 178 行本地 test 或额外 val。准备时传入 `--competition titanic --train /absolute/train.csv --predict /absolute/test.csv`，无需 MLE-bench repository/data 参数；也接受成对 deployment 输入作为兼容入口。每折验证行数为 179/178/178/178/178，每行恰好验证一次。官方 418 行无标签 test 不参与评分，最终用选定配置在 891 行上拟合一次并生成 submission.csv。

Target 按需完成任务理解、EDA、验证设计、数据处理、特征工程、模型比较、调参、错误分析和交付。Meta 依据可观察的执行证据改进 workflow.yaml、短英文提示词、技能与实验记录工具。N 个候选至少预留 N×5+1 次拟合；实验执行五折，最后一次留给最终 refit，禁止重新搜索。

`tests/test_workflow_runtime.py` 使用带 pandas/sklearn 的 Python；`tests/workflow-canary.py` 在固定 Linux 镜像验证隔离执行、十次 CV 拟合、无额外留出拟合以及一次冻结配置 refit。这些检查不产生新的 Kaggle 成绩。

## 验证与运行边界

```sh
npm run test:mle-bench
```

专项测试覆盖数据导入、提交格式、checkpoint、可配置实验预算、恢复及 Project/Python GEPA 接入。可用 `GEAR_PYTHON` 指定 Project Python，`GEAR_MLEBENCH_PYTHON` 指定安装了 MLE-bench 依赖的 Python；设置 `GEAR_MLEBENCH_REPOSITORY` 启用原生 grader 一致性测试，设置 `GEAR_ANALYSIS_HITCH_REPOSITORY` 启用跨仓库合同一致性测试。没有配置这些仓库时，对应测试明确跳过。

两份参照任务使用固定上游 config/prepare/grade/checksums 和缩小的**合成数据 fixture**验证目录、列、ID、附属文件与指标。合成测试不代表完整比赛数据或真实模型成绩。`tests/worker-canary.py` 需在固定 Linux 镜像中执行，用于检查训练/验证数据隔离、独立评分及 worker 权限边界。

当前运行配置仍为 2 CPU、4 GiB 内存、1 GiB 工作区；源代码单文件 16 MiB、输出总计 64 MiB、输入 CSV 单文件最多 1 GiB。May 的完整 800k 行任务尚未进行资源压测，能够导入不代表任意模型都能在该配置和 30 分钟实验墙钟预算内完成。扩大执行资源需要新的 runtime 与研究预算合同。模型 token/请求次数维持不限额、仅记 usage；实验槽数量和 CPU/墙钟预算在准入时冻结。

新增任务按本页定义格式接入；不同类型数据、额外指标或运行依赖需明确扩展适配器及测试。

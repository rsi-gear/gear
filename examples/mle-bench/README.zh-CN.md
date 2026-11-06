# Kaggle 统一任务格式：MLE-bench

后续新增 Kaggle 任务按 MLE-bench 的定义目录和准备后数据目录接入。Gear 负责固定预算研究、checkpoint、五次实验与选择，Hitch 负责隔离执行、独立评分和输出取证。数据入口不再要求用户把每个任务改造成 Titanic 的二分类 CSV。

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

导入保留公开 CSV 的原始字节与行序；读取 sample_submission 推导 ID、目标列和导出顺序。在公开 train 上生成固定五折，不再次划分外层 test。NOMAD 的每折只挂载本折训练资产，验证行的资产由 `train/<id>/` 映射成 `test/<id>/`，原外层 test 资产不进入该折。生成模型仍使用统一 CLI：`--train --predict --output --seed`；调用参数由适配器传入。附属目录相对输入 CSV 所在目录解析。

输入身份包含定义文件、grader 及共享 helper 的 SHA-256、全部公开文件的递归 SHA-256、CSV 字节摘要、五折计划和 runtime。官方 prepared 数据先核对上游 MD5 checksums；未被上游 checksums 列出的几何文件仍被本次导入的 SHA-256 冻结。改变数据、grader 或运行条件需要新项目，不能续用原 checkpoint。

## 准备官方任务

使用 MLE-bench 环境按照上游要求准备已经获得访问权限的数据：

```sh
mlebench prepare -c nomad2018-predict-transparent-conductors
mlebench prepare -c tabular-playground-series-may-2022
```

随后将实际 data-root 和固定源码路径传给 Gear：

```sh
node examples/data-analysis-harness/mlebench.mjs inspect \
  --repository /absolute/mle-bench --data-root /absolute/mle-bench-data \
  --competition nomad2018-predict-transparent-conductors

node examples/data-analysis-harness/prepare.mjs \
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
node examples/data-analysis-harness/mlebench.mjs prepare-local \
  --repository /absolute/mle-bench --data-root /absolute/mle-bench-data \
  --competition titanic --python /absolute/python-with-mlebench
```

`prepare-local` 直接调用原生 `Registry.get_competition(...).prepare_fn`，拒绝覆盖已存在的 prepared 目录。随附 checksums 对应真实 891 行 Titanic 的固定分层 seed 0 划分：713 行 public/train、178 行 public/test。`--record-checksums` 仅允许自定义 Titanic 初次生成 checksums；官方任务不允许该选项覆盖上游 checksums。

按照上面的 Gear prepare 命令使用 `--competition titanic`。需要最终 418 行 Kaggle 提交时，准备阶段再加：

```sh
--deployment-train /absolute/titanic/train.csv \
--deployment-predict /absolute/titanic/test.csv
```

这两个输入只用于已选 C5 的固定源码重训，不能改变本地 benchmark 数据或研究历史。当前 deployment 登记支持无逐行附属文件的任务；需要新的资产映射时应建立独立任务定义。

## 五次实验、评分和导出

通过 [研究项目](../data-analysis-harness/README.zh-CN.md) 的标准 `gear.yaml` / Project API 使用 Python GEPA 比较和晋升，也可使用 plan/run 接口逐步检查序列，每个 harness 一个序列、五个实验槽；每个新候选内部做五折 CV。可以从空 checkpoint 开始；共享 bootstrap 是可选的额外研究记录，不是五个槽中的重复序列。

新记录 `analysis-task@2` / `analysis-experiment@2` 分开记录 `metric`、`pooledScore`、`pooledUtility`。accuracy/AUC 的 utility 等于原分数；RMSLE 使用 `1/(1+score)`。五折汇总由完整 OOF 预测重新计算：AUC 不能取五个 fold AUC 的均值，双目标 RMSLE 也不能先平均目标的平方误差再开方。晋升仍使用实际 C5 的 utility，要求输出有效；审计不能改写 C1–C5。

OOF 通过内容寻址保留全部 ID 与预测值。大表使用确定性的 gzip JSON，单个压缩产物限 16 MiB、解压限 64 MiB；读端兼容此前的普通 JSON，按页向模型提供记录。80 万行概率 OOF 已验证无损往返，不靠截断记录来满足产物上限。

导出本地 benchmark 的真实 C5 已封存预测，不重新调用模型或重训：

```sh
node examples/data-analysis-harness/mlebench.mjs export \
  --project /absolute/research-project --sequence SEQUENCE_DIGEST \
  --out /absolute/benchmark-submission

node examples/data-analysis-harness/mlebench.mjs grade \
  --repository /absolute/mle-bench --data-root /absolute/mle-bench-data \
  --competition titanic --python /absolute/python-with-mlebench \
  --submission /absolute/benchmark-submission/submission.csv
```

输出 `submission.csv`、来源 receipt 和标准 `submissions.jsonl`：

```json
{"competition_id":"titanic","submission_path":"/absolute/benchmark-submission/submission.csv"}
```

`grade` 调用上游 Registry 与 Grader，报告未舍入的 `raw_score` 和上游保留五位小数的 `score`。官方任务可另交上游 CLI 生成 leaderboard 报告；自定义 Titanic 没有与新划分匹配的官方 leaderboard，使用原生 Grader 入口，`medals` 为 null，不生成虚构排名。

官方 Kaggle 418 行导出使用 `refit.mjs --project ... --sequence ... --out ...`。它核验已登记 deployment 输入，执行同一 C5 源码，模型请求为零。此文件与 178 行 benchmark submission 分目录保存。两者都不会自动上传 Kaggle。

## 验证边界

两份参照任务使用固定上游 config/prepare/grade/checksums 和缩小的**合成数据 fixture**验证目录、列、ID、附属文件、指标与原生 Grader；没有将 fixture 声称为官方完整数据。真实模型端到端验收使用 Titanic，见 [验收记录](../../docs/mle-bench-validation-2026-11-06.zh-CN.md)。

当前运行配置仍为 2 CPU、4 GiB 内存、1 GiB 工作区；源代码单文件 16 MiB、输出总计 64 MiB、输入 CSV 单文件最多 1 GiB。May 的完整 800k 行任务尚未进行资源压测，能够导入不代表任意模型都能在该配置和 240 秒实验墙钟预算内完成。扩大执行资源需要新的 runtime 与研究预算合同。模型 token/请求次数维持不限额、仅记 usage；五次实验槽和 CPU/墙钟预算仍固定。

旧 `--legacy-csv` 只保留历史兼容。未来任务按本页定义格式新增；不同类型数据、额外指标或运行依赖通过明确的任务/运行适配扩展，避免静默转成 accuracy 或丢弃文件。

# MLE-bench 格式接入验收

本次验证关注任务格式、指标一致性、角色隔离和真实导入运行。两份上游参照任务使用合成 fixture；真实 Titanic 使用新划分、新 checkpoint 和一个 harness 的五次顺序实验。它不构成两份 harness 的配对比较，也不构成官方 MLE-bench/Lite 成绩。

上游固定于 `507f92e1138bb6e40dac5c6ee7a6758e6424bf97`，格式和复现入口见 [接入说明](../examples/mle-bench/README.zh-CN.md)。

## 已验证的格式与评分

- NOMAD：双目标、非负回归预测、train/test 重复 ID、几何文件原目录、按折重新映射几何文件、固定原始输出行序。删除必需的 geometry 文件会拒绝导入，改变文件会改变任务身份。
- May 2022：概率预测、独立 ID 集合、私有完整 test 与 gold_submission、按 ID 对齐的 AUC。包含一个反例：每折 AUC 都为 1 时，合并 OOF AUC 仍可能为 0.75，确认固定计分器使用完整 OOF。
- 原生 Registry/Grader：NOMAD 合成样例 `raw_score=0.24105138330142376`，上游舍入为 `0.24105`；May 合成样例 `0.5`。另有含并列概率的 AUC 和非零双目标误差的逐数值一致性测试。
- 输入 checksums、grader/helper 源码摘要、公开递归树摘要与私有答案身份均固定。未知或被修改的 grader 拒绝执行，fixture 不可标成官方完整数据。
- 新旧 schema 与 checkpoint 兼容；Gear 使用原始 `task_score` 与晋升 utility，RMSLE 保留 minimize 方向且不假设上界为 1。
- 80 万行 OOF 压缩/解压保留全部 ID 与原浮点值，编码可重复；文件小于 16 MiB。旧 JSON OOF 仍可读取。

自动检查：Gear 27 项通过；Hitch 38 项通过；旧 Kaggle producer 3 项通过、1 项环境相关检查跳过。真实 Docker canary 通过原二分类、AUC、双目标 RMSLE 五折路径，以及网络、凭据、进程、CPU、内存、墙钟和不安全输出检查。原始日志在本地 `tmp/mlebench-gear-tests.log`、`tmp/mlebench-hitch-tests.log`、`tmp/mlebench-hitch-legacy-tests.log`。

## 真实 Titanic

原始数据 891 行有标签 train、418 行 Kaggle test。自定义 MLE-bench `prepare(raw, public, private)` 通过上游 Registry 调用，seed 0 固定分层为 713 行 public/train、178 行 public/test。答案只交给独立 verifier，官方 891/418 deployment 输入另行登记。

工作目录：`tmp/analysis-mlebench-titanic-20261106`。模型为 `openai-codex/gpt-5.6-luna`，单一 harness `7e29aad2605c68364a59941a3aae0cc77cb15d29`。序列 `09163c3986f2ebf7abb9eeb79f2b15102e462d7f2a5d9f9c9de1234771ab7b8d` 从空 checkpoint 开始，没有额外 bootstrap 或重复序列。模型 token/request 不限额，仅记 usage；实验槽及 wall/CPU 预算固定。

| 实验槽 | 结果 | 五折 pooled OOF accuracy | 当时选择 |
|---|---|---:|---|
| V1 | completed | 0.82187938 | V1 |
| V2 | completed | 0.79242637 | V1 |
| V3 | completed | 0.83450210 | V3 |
| V4 | completed | 0.84011220 | V4 |
| V5 | candidate_failed | 无 | V4 |

V1 使用折内预处理和结构特征的 ExtraTrees；V2 加入折内姓氏/票号 target encoding 后下降，保留 V1。后续实验得到更好的 RandomForest 解法。V5 试图增加姓氏组统计，但工作区的 `inspect.py` 遮蔽了 Python 标准库，候选在首折开始前失败。失败消耗第五个槽且完整保留，没有免费补跑第六次。

实际 C5 为 V4 的封存 source：`sha256:1d40fd7daff3dabdc609dba272377136d3645e73b965092cbc80d6ab487a66ff`。独立 verifier 的 178 行 accuracy 是 **150/178 = 0.8426966292134831**；上游原生 `Registry/Grader` 复核完全一致，舍入分数 **0.84270**。

| 产物 | 行数 | 固定执行 run | SHA-256 |
|---|---:|---|---|
| benchmark-submission/submission.csv | 178 | `run_c1bef2b4aaca4b00a870d6e693c2932e` | `2da0c1481e8038dd243ea2af4584a18ee13187af9b0b9a61dc69eb99775f77a7` |
| kaggle-submission/submission.csv | 418 | `run_c12ef360ea854c528c3a0af73d7244e5` | `45cbd61f7a078ee3e37a3fc8fe222ba79020ad8afcd06cd28a1592412d16529b` |

两次固定执行都没有模型调用，使用同一 solution。418 行文件来自事先登记的完整 891 行训练集重训，ID、标签、列顺序和源代码身份均已校验；没有本地未知 Kaggle test accuracy。178 行文件同时输出标准 submissions.jsonl、来源 receipt 和 native-grade.json。

全部五个实验已合并进公共 checkpoint `sha256:0d7d97f7cd52853f3c677695d2f36f42a02e14f9f417e23bcb49373462c1e3f0`，当前解法仍为 V4。单分支合并只用于保留研究状态，不声称配对晋升增益。该序列记录 52.566194 CPU 秒、423,831 tokens、64 次 adapter model calls；token/call 统计在 provider 内部重试不可核实时仅为下界，费用未知。refit 成本另记。

本轮执行器冻结在 Hitch `15a7ff1445639a1e48b7e2da9094504b51531188`，CLI、producer 和源码已保留在 `tmp/analysis-mlebench-executor`；切换到这份固定副本后 execution binding 摘要不变，并再次验证导出幂等性。后续 OOF 无损压缩提交 `ba624557295ea18ee7a182da406d705f61a85b16` 单独通过 80 万行测试、真实 Docker 五折 canary 和 NOMAD 固定执行器 canary：模型请求 0、几何资产可见、乱序预测规范化后两侧 RMSLE 同为 `0.6627497144996801`。它没有改写本轮已封存的 JSON OOF、runtime 或运行记录。

完整 task、每折指标、五步选择、费用、Hitch 输出清单、交付、refit 与合并身份见 [机器可读证据](mle-bench-validation-2026-11-06.json)。此前 Titanic 的 0.77751/0.75837 是用户提供的 Kaggle 线上分数，不能与本次新划分的本地分数直接比较。

## 适用范围

NOMAD 与 May 的官方完整数据尚未训练；May 全量模型在当前 2 CPU、4 GiB 配置中的资源表现未验收。Titanic 是兼容格式的自定义扩展，没有新划分对应的官方 leaderboard，因此只使用原生 Grader 分数，奖牌字段为 null。未自动上传任何文件到 Kaggle。

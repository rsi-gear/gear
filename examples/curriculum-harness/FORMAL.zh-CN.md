# 正式 Project.refine 的四组对照

`formal_experiment.py` 将每轮新练习交给新的 `Project.refine` 运行，使用 `ReflectiveSearch`、正式隔离 worker、候选封存、执行记录及恢复路径。`gear.curriculum` 仍只有纯算子及输入输出；这个目录负责模型调用、任务转换、实验记录和外部评测。

[首轮正式实测与审计](../../research/curriculum-harness-2026-11-20/README.zh-CN.md)已完成，包含 1,475 次调用。离线复核发现官方大小写检查内部的语言检测未固定 RNG，影响一次候选采纳；原始结果保留。后续运行的 `verifier_policy.language_detection_seed=0` 已进入冻结身份，旧报告不因此自动获得确定性验收通过。

## 固定协议

| 项目 | 设置 |
| --- | --- |
| 更新对象 | developer prompt；1800 字符硬上限，1000 字符生成目标，最多 2 次修订；模型权重固定 |
| 学生 / teacher | 默认 `gpt-5.6-luna` / `gpt-6-astra`，effort `low`；运行前验证实际可用性 |
| 数据 | 固定提交的官方 IFEval strict verifiers；沿用原示例的可确定验证子集 |
| 验证 RNG | 当前固定 language detection seed 0；原始正式实验漏项及影响见审计报告 |
| 切分 | 排除前一轮所有 train/dev/test 来源；新的 8 train、16 dev、24 test，切分 seed `20261120` |
| 重复 | 优化种子 101/202/303，各 2 轮；种子控制数据抽样和组执行顺序，原生解码没有 seed 保证 |
| 学习预算 | 每轮每组最多 6 条，按四组验证通过数共同缩减，少于 3 条则停止 |
| 搜索预算 | 每组每轮 1 个提案机会、同样的修订上限、相同的固定 dev 任务；严格提高 dev 均分才采纳 |
| 最终评价 | 各 seed/arm 全部完成并冻结后，才执行同一 24 道 test；另复测原始训练题，分别统计修复与回归 |
| 有效性门槛 | 训练基线通过率在 25%–87.5%；每组每种子每轮均有满足约束的提案；不满足时测试集保持未评测 |

四组分别为固定训练数据、无失败反馈的随机生成、只看当轮失败的条件生成，以及保留历史案例和失败模式的 memory 组。memory 组使用当前策略的测量退役／重新激活模式，按频次安排针对性练习，混入固定题与随机探索；变异意图覆盖新主题、边界难度、干扰重述与最小针对练习。这是显式的记忆调度消融，不等同于完整 Forge 论文复现。

另有[独立 Forge-inspired 配方](FORGE.zh-CN.md)，增加同批训练门槛、逐题候选 front、验证停滞触发和四类变异；它不改写本对照的冻结协议，不能用单配方运行代替四组实验。

训练与选型都在 Gear 的 seed 准入集合中，但 `ReflectiveSearch` 显式分开两个范围：模型只收到训练任务和训练 assessment，dev 只供确定性比较。每轮 `nominate=False`，不触发正式发布 gate；最终测试由外层调用方执行。候选采纳不等于更新项目 champion。

## 模型与预算边界

`formal_provider.py` 实现已有 process provider 协议。候选使用 Pi 的资源封存格式，但这个实验只读取 `AGENTS.md` 并作为 developer prompt 发给 LLM；配置、扩展或 skills 发生修改会被拒绝。它没有运行 Pi agent，也没有验证工具编排的改进。

`model_calls.py` 在调用前保存意图、thread/turn 身份，确认丢失时只读取原会话。无法确定结果时停止，不自动重复收费。已恢复但没有原生用量的结果保持用量未知。provider 不声明取消或原生 HTTP 预算能力；SDK 内部重试次数不可见，因此报告区分 SDK turn 次数、实际回执 token 与未知的 HTTP 请求数。1800 次上限是整个实验的逻辑调用配额，不是原生 HTTP 请求数或美元硬上限。搜索、诊断和数据生成均占用该配额。

同样的候选机会和训练／验证任务预算不表示各组消耗相同 tokens。候选修订、数据生成与诊断的实际用量都应计入成本比较；不能把固定组没有执行的生成记成消费。

## 运行与恢复

先按 [原示例](README.zh-CN.md) 安装固定 SDK／verifier 依赖并准备数据，再构建 Gear。使用独立工作区与已有登录：

```bash
PYTHONPATH=python /tmp/gear-curriculum-llm-env/bin/python \
  examples/curriculum-harness/formal_experiment.py \
  --workspace /tmp/gear-formal-study \
  --ifeval-root /tmp/gear-curriculum-ifeval \
  --previous-splits /tmp/previous-study/splits.json \
  --phase all
```

`--phase preflight` 仅检查 benchmark、资源与 provider 握手，`readiness` 仅评测训练基线，`optimize` 到完成搜索为止。相同工作区重复执行会校验冻结配置／源码，复用模型回执与原 run；未知模型结果需要先 reconcile。不能通过删除意图文件重试。源码、模型或切分改变必须新建实验，并披露此前已看到的数据。

数据来自公开基准，样本较小；多个优化种子共享测试题和初始基线，不是独立数据集重复。应展示每种子的配对差异与不确定性，并允许负结果或不显著结果。该实验不预设 failure 生成必然优于随机生成。

`--previous-splits` 会递归继承文件中的 `excluded_ids`，排除所有先前用过的来源，而不只是紧邻的一轮。剩余来源不足时明确停止。可显式用 `--minimum-instructions` 和 `--split-seed` 定义新的任务范围；配置冻结后不能改写，改变任务范围的研究必须单独报告，不能把其分数与旧范围直接合并。

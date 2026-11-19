# 正式 harness 搜索：四组、三个种子的真实 LLM 实验

**闭环已完成，仍未证明 failure 生成的数据带来稳定的留出提升。离线复核还发现语言检测的随机性影响了一次候选采纳，因此本轮不能作为完全通过确定性验证的最终验收。** 原始选型与测试结果全部保留，没有在看到测试后重新选择 harness。

学生为 `gpt-5.6-luna`，优化器／生成器为 `gpt-6-astra`，effort 均为 `low`。模型权重没有更新，只更新 `AGENTS.md` 对应的 developer prompt。执行经过真实 `Project.refine`、隔离 Python worker、持久执行器和示例 process provider；该 provider 不运行 Pi 扩展或工具循环。

## 留出结果

三个优化种子均在同一组 24 道新留出题上评测。baseline 单次为 **22/24（91.67%）**。

| 数据策略 | seed 101 | seed 202 | seed 303 | 三种子的描述性均值 |
| --- | ---: | ---: | ---: | ---: |
| fixed 固定训练数据 | 19/24 | 20/24 | 21/24 | 83.33% |
| random 随机生成 | 19/24 | 19/24 | 19/24 | 79.17% |
| failure 当前失败条件生成 | 20/24 | 19/24 | 22/24 | 84.72% |
| memory 历史记忆与混合调度 | 20/24 | 23/24 | 22/24 | 90.28% |

failure 相对 fixed 的均值差为 +1.39 个百分点，相对 random 为 +5.56 个百分点；这些是小样本描述值，不能据此声称策略胜出。各 seed 中 failure 对 fixed/random 的双侧精确 McNemar p 均不小于 0.25。完整配对差、修复／退步数、5000 次按题配对 bootstrap 区间在 [summary.json](summary.json)。三个种子共享测试题与 baseline，不是 72 道独立测试题，也不是三个独立数据集复现。

memory 在 seed 202 和 303 都没有采纳新 prompt，却分别得到 23/24 和 22/24。其他使用同一初始 prompt 的测试最低为 19/24。这直接表明，最高单次分数不能归因于记忆调度。provider 不提供 native decoding seed，种子只控制调用方的采样和组别运行顺序。

## 离线复核发现的验证器问题

官方 IFEval 的 `english_capital / english_lowercase` 检查同时调用 `langdetect` 判断英文。实验冻结了源码、参数和 NLTK 表，但遗漏了语言检测 RNG；语言检测因而不是确定性的。

在保留所有原始回答的前提下，以语言检测 seed 0 重评分得到：

- 512 份外层诊断／最终测试回答的评分不变；102 份生成参考答案与负例校准结果不变。
- 904 份搜索评测中，8 份回答的细项检查变化，其中 6 份的整题通过标签变化。
- 24 次搜索中，**seed 303、failure、第一轮**的采纳决定受影响：原运行以父代 11/16、候选 12/16 采纳；确定性重评分变成父代 12/16、候选 10/16，应拒绝。其他采纳决定不变。

这次复核是事后审计，不是一次新的预注册实验。没有重新执行模型，没有替换失败组的最终 prompt，也没有把事后重选结果混入上表。仅作敏感性观察，去掉受影响的 seed 303 后，failure 与 fixed 都是 39/48；这仍不能支持 failure 优势。

导出的 [manifest.json](manifest.json) 明确标记 `stochastic_language_check_differences`，没有写成全部评分复现通过。差异逐条保存在 `verifier_audit`。后续代码已在每次评分前重置显式语言检测种子，并把该设置加入实验冻结身份；对这 8 个敏感回答扰动外部 RNG 后重复检查 32 次，结果稳定。该修复不会追溯修改本轮的冻结源码或历史结果。

## 候选有效性与多轮变化

本轮 24/24 个候选首次生成便满足 1800 字符硬约束，长度为 1020–1134，实际没有消耗修订调用。每组同样获得每轮一次提案和最多两次约束修订机会。正式修订、收费回执丢失后的恢复及训练门槛另有集成测试。

开发集选型要求严格提升。原运行采纳次数分别为 fixed 2/6、random 1/6、failure 2/6、memory 1/6。它解决了上轮多数候选超长的问题，但没有消除选型噪声。正式实验使用直接开发集选型；后来加入的 `training_gate=True` 不属于本轮协议。

下表是固定 8 道训练诊断题上的通过数，第三列在第一轮更新后测量，第四列在第二轮结束、所有 harness 冻结后测量；它是训练诊断曲线，不是泛化曲线。

| seed | 策略 | 初始 → 第一轮后 → 第二轮后 |
| --- | --- | --- |
| 101 | fixed / random / failure / memory | 7→6→8 / 7→8→7 / 7→7→8 / 7→7→8 |
| 202 | fixed / random / failure / memory | 7→8→8 / 7→7→7 / 7→7→8 / 7→7→6 |
| 303 | fixed / random / failure / memory | 7→7→7 / 7→7→7 / 7→8→7 / 7→7→7 |

初始只有一道训练失败。三种子重复诊断中的修复分别为 fixed 2/3、random 0/3、failure 2/3、memory 1/3；这里的分母 3 是同一道题的三次运行。memory 在 seed 202 另外出现一次旧成功题回归，其余组未观察到这 7 道旧成功题的回归。训练修复样本太少，不能替代留出收益结论。

## 冻结协议与实际成本

源码冻结于 `dabf5fb21` 对应的实现；各文件摘要在证据的 `identity.implementation`，本地原字节另有 `source_snapshot`。新切分排除了 [上轮](../curriculum-harness-2026-11-19/README.zh-CN.md) 使用过的全部 64 个来源任务，以 seed `20261120` 划分 8 train / 16 dev / 24 test，优化种子为 101、202、303，每组两轮。

fixed 使用固定来源题；random 不接收失败材料；failure 使用当前诊断，无失败时按冻结规则转为 random；memory 保留跨轮模式、按当前策略测量掌握状态，并混合固定、随机与定向练习。memory 的四种变异是本例的通用调度消融，**不是 Forge 的完整四类变异或论文复现**。

每个 seed/round 按各组合格数据的共同最小值匹配任务数：101 和 202 为 5、6；303 为 6、6。共生成 102 个草案，100 个通过验证，未通过项不进入搜索；因共同预算截取，并非所有合格草案都会使用。每次扩展数据均进入新的已准入 run，训练反思与开发选型 task scope 明确分开。宿主会用 dev/test 文本作精确重复排除，但这些内容不进入反思／生成模型；最终测试执行发生在所有优化结束后，优化期间没有 held-out 发布门槛调用。

| 归属 | 实际模型调用 | 原生 input+output tokens |
| --- | ---: | ---: |
| 共享 baseline | 32 | 285,715 |
| fixed | 352 | 3,120,635 |
| random | 358 | 3,165,517 |
| failure | 363 | 3,269,818 |
| memory | 370 | 3,361,612 |
| 合计 | **1,475** | **13,203,297** |

全部调用有原生 usage。input 为 12,854,715，output 为 348,582；cached input 9,371,776 已包含在 input 中，不能再次相加。额外数据生成／诊断为 random 6 次、failure 11 次、memory 18 次。每组搜索和学生评测调用数量相同，token 总量和总成本没有强行宣称相等。

生成验证实际执行了 612 次参考／负例判分；验证 CPU 时间未单独测量。权重训练步数为 0。预算上限 1800 的单位是逻辑 SDK turn；SDK 内部 HTTP 重试数未知，provider 不宣称硬 token/HTTP 限额或强制取消能力。连通性探测不包含在主实验成本中。不推算账单金额；由于没有可靠的增益证据，本轮也不给出“每单位成本的已证实收益”。

## 复核与证据

- [evidence.json](evidence.json)：请求、回答、用量、冻结切分与配置、24 个正式 run、全部草案验证和随机评分审计；不导出 native thread/turn ID。
- [summary.json](summary.json)：结果、逐轮选型、配对统计和按用途拆分的成本。
- [manifest.json](manifest.json)：完整证据摘要、实际重评分数量和未通过确定性验收的标记。
- [示例入口](../../examples/curriculum-harness/README.zh-CN.md)、[复核工具](../../examples/curriculum-harness/export_formal_results.py)、[第三方来源](NOTICE.md)。

准备好固定版本的 IFEval 和示例依赖后，可只用导出文件离线复核，不调用模型：

```bash
PYTHONPATH=python python examples/curriculum-harness/export_formal_results.py \
  --verify-export research/curriculum-harness-2026-11-20 \
  --ifeval-root /path/to/pinned-ifeval
```

复核会验证文件摘要，重新评分全部 1,416 份学生回答与生成参考，保留原始随机评分的已声明差异。新实现和本轮实验的状态分别记在[实施台账](../../docs/curriculum-implementation-status.zh-CN.md)；本轮结果不能替代完整设计验收。

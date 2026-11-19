# 正式 harness 对照第五版：闭环与离线审计完成，未观察到 failure 优势

本轮完成 fixed、random、failure、memory 四组、三个优化种子、每组两轮的真实 LLM 闭环。24/24 次搜索的候选满足约束，全部调用、评分及采纳决定通过离线复核。**failure 与 memory 的留出均值均为 94.44%，低于 fixed 的 95.83% 和 random 的 97.22%；没有证据证明 failure 数据带来稳定收益。**

学生为 `gpt-5.6-luna`，生成／诊断／优化器为 `gpt-6-astra`，effort 均为 `low`。模型权重没有更新，搜索对象为 `AGENTS.md` 对应的 developer prompt。执行经过真实 `Project.refine`、隔离 Python worker、持久执行器和示例 process provider。它验证文本 harness 优化，不验证工具执行循环、完整 Forge 或两模型权重训练。

## 留出结果与可归因范围

三个种子使用同一组 24 道留出题，baseline 单次为 **22/24（91.67%）**。

| 数据策略 | seed 101 | seed 202 | seed 303 | 三种子的描述性均值 |
| --- | ---: | ---: | ---: | ---: |
| fixed 固定训练数据 | 23/24 | 24/24 | 22/24 | 95.83% |
| random 随机生成 | 22/24 | 24/24 | 24/24 | 97.22% |
| failure 当前失败条件生成 | 23/24 | 21/24 | 24/24 | 94.44% |
| memory 历史记忆与混合调度 | 22/24 | 22/24 | 24/24 | 94.44% |

failure 相对 fixed 为 −1.39 个百分点，相对 random 为 −2.78 个百分点。各 seed 的 failure 对 fixed/random 双侧精确 McNemar p 均不小于 0.25；逐题配对差、修复／退步数及 5000 次 bootstrap 区间见 [summary.json](summary.json)。这些结果既不支持 failure 胜出，也不足以证明它普遍更差。三种子共享测试题和 baseline，不能当成 72 道独立题或三个独立数据集。

四组各采纳一次新 prompt：fixed 在 seed 101 第二轮采纳，其他三组均在 seed 303 第二轮采纳。其余八个最终 harness 仍为初始 prompt，同一 prompt 的留出分数从 21/24 到 24/24 波动。provider 不提供 native decoding seed，种子只控制调用方采样和组别顺序；单次最高分不能归因于数据策略。

failure 在 seed 202、303 的第二轮诊断为 8/8，按冻结规则回退到随机生成。**failure 唯一被采纳的新 prompt 正来自 seed 303 的随机回退轮次**，因此它的 24/24 尤其不能解释为失败定向数据的收益。memory 在 seed 303 第二轮也使用了随机生成回退。这些实际 conditioning 保存在生成计划与调用记录中，没有事后改名或筛掉。

初始训练诊断只有一道失败，说明失败信号有限。以下为固定八道训练诊断题的通过数；它是训练修复曲线，不是泛化曲线。

| seed | fixed | random | failure | memory |
| --- | --- | --- | --- | --- |
| 101 | 7→8→8 | 7→8→8 | 7→7→8 | 7→8→8 |
| 202 | 7→7→8 | 7→8→7 | 7→8→7 | 7→7→6 |
| 303 | 7→8→8 | 7→8→8 | 7→8→8 | 7→8→8 |

原失败题的三次重复诊断中，fixed/failure 修复 3/3，random/memory 修复 2/3；failure 和 memory 各出现一次旧成功题回归，fixed/random 为零。分母 3 是同一道题的三次运行，不能用它代替留出结论。

## 冻结协议与候选有效性

调用方源码冻结于 `139bfc533`，18 个相关文件摘要记录在 `identity.implementation`，原字节另保存在原工作区的 `source_snapshot`。IFEval 固定提交、验证器源码、NLTK 表及语言检测 seed 0 均进入冻结身份。新切分 seed 为 `20261124`，排除此前使用的 256 个来源，划分 8 train / 16 dev / 24 test，最少一条指令；优化种子为 101、202、303，每组两轮。

本版在运行前固定 `constraint-aware-negatives-v1`、`exact-ending-v1` 和结构化生成，修复前版的末尾短语双句点问题。readiness 为 7/8，preflight 通过；两者不读取最终留出评分。所有候选、生成器和协议在最终测试前冻结，没有依据本轮测试重选 harness 或更改规则。

fixed 使用固定来源训练题；random 不接收失败材料；failure 使用当前失败，无失败时随机回退；memory 保留跨轮模式、测量当前掌握状态并混合固定、探索和定向练习。memory 为本例通用调度消融，不等于完整 Forge 配方。

各 seed/round 四组共同使用六条学习样本，六次配对均没有因短缺减少数量。104 个草案全部通过本例的参考解、环境、目标保留、精确重复检查和负例校准；新颖性不是语义去重保证，IFEval 指令通过也不证明回答内容质量。生成与反思不接收 dev/test 文本；宿主仅以它们作精确重复排除。

24 个 prompt 候选均首次通过 1800 字符硬约束，实际长度 1013–1121，没有使用约束修订调用。各组具有相同的一次提案及最多两次约束修订机会；修订与回执恢复由另行集成测试覆盖。选型要求在 16 道 dev 题上严格提升，`training_gate=False`；本轮没有把后来实现的训练门槛算作已测功能。每次新数据进入新的已准入 run，训练反思与开发选型的 task scope 分离。

## 实际成本

| 归属 | 实际逻辑模型调用 | 原生 input+output tokens |
| --- | ---: | ---: |
| 共享 baseline | 32 | 283,498 |
| fixed | 354 | 3,162,627 |
| random | 360 | 3,232,841 |
| failure | 364 | 3,297,401 |
| memory | 368 | 3,339,489 |
| 合计 | **1,478** | **13,315,856** |

全部调用有原生 usage：input 12,903,739，output 412,117。cached input 10,127,488 已包含在 input 中，不能重复计费求和。各组搜索／学生评测次数相同，额外生成／诊断分别为 random 6、failure 10、memory 14 次，token 和总成本没有宣称相等。

生成验证执行 676 次参考／负例判分，验证 CPU 时间未单独测量。权重训练步数为 0。1800 的预算单位为逻辑 SDK turn，内部 HTTP 重试次数未知，也不是金额或 token 硬上限。独立连通性／渲染探测不计入本表；前四版的已归档成本也未合并为第五版成本。没有可靠收益证据，故不报告“单位成本的已证实收益”。

## 离线复核与证据

导出时核对了 1,478 次调用的原生记录、24 次正式 run、104 个草案验证、候选约束与全部采纳决定。512 份外层回答和 912 份搜索回答共 1,424 份均用冻结的官方验证器重评分一致；参考与负例校准也一致。语言检测 seed 0 与原运行一致，检查差异和采纳差异均为空，未重选 harness，未新增模型调用。

- [manifest.json](manifest.json)：`official_verifier_regrade="passed"`，证据摘要 `sha256:4a53937dcaf9aca2aceaef61366f8c6fb7eb379930f73f595da498b73a4673d1`。
- [evidence.json](evidence.json)：冻结配置／切分、请求与响应、usage、任务评分、生成计划／验证及搜索记录；不导出 native thread/turn ID。
- [summary.json](summary.json)：逐组统计、选型过程、配对比较及用途成本。
- [第三方来源](NOTICE.md)、[正式实验入口](../../examples/curriculum-harness/FORMAL.zh-CN.md)、[实施台账](../../docs/curriculum-implementation-status.zh-CN.md)。

导出后的独立复核也已通过。准备好固定版本 IFEval 与依赖后，在仓库根目录执行：

```bash
PYTHONPATH=python python examples/curriculum-harness/export_formal_results.py \
  --verify-export research/curriculum-harness-2026-11-20-v5 \
  --ifeval-root /path/to/pinned-ifeval
```

本轮完成受限文本任务上的真实 harness 对照验收，结论为未观察到 failure 优势。它不替代完整设计中的其他算法配方、真实训练后端和广泛效果验收。

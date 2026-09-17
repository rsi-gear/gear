# Champion 与 GEPA 混合父代抽样

## 配置与范围

新增显式策略 `search.parentSampling: epsilon-greedy-gepa-v1`，`search.championProbability` 默认为 `0.5`，允许 `[0,1]` 内的有限数值。其探索分支沿用归档的 GEPA 权重，**不是在全部版本中均匀抽样**。

```yaml
search:
  mode: failure-cluster-gepa-v1
  parentSampling: epsilon-greedy-gepa-v1
  championProbability: 0.5
```

其余搜索、晋升和预算配置沿用已有配置。代码调用者也可以使用导出的 `defaultEpsilonGreedySearchConfig`。既有 `defaultSearchConfig` 和显式 `scoped-frontier-membership-v1` 保持原选择规则；旧策略不接受 `championProbability`，避免配置被静默忽略。新策略每个候选独立抽样，`parentBatchCount` 仅控制旧策略。

不修改 Hitch、Target、模型参数或评测接口。4→2→1 评测和晋升门保持不变。算法完整性版本递增；不得替换运行中 evolution 的固定实现或修改其冻结配置。启用新规则需建立新 evolution。

## 概率

设当前 champion 为 `h`，配置的直接选择概率为 `p`，归档原始 GEPA 概率为 `q(c)`：

```text
P(c) = p × 1[c = h] + (1-p) × q(c)
```

GEPA 分支覆盖整个归档分布，也包含 champion；未取得 GEPA 抽样资格或被剪除的版本可以是零权重。`p=0.5` 表示直接选择 champion 的分支占 50%，不是限制 champion 最终只能有 50%。例如 `q(A)=2/3、q(B)=1/3` 且 A 是 champion，最终为 `P(A)=5/6、P(B)=1/6`。

直接选择 champion 不受 GEPA 冗余剪枝影响，但仍要求该 exact snapshot 有完整、通过探索硬门的 seed scope 证据。没有合法 seed 证据时阻塞，不以 champion 身份绕过证据检查。探索分布为空但 champion 合格时回退到 champion。只有 champion 一个可用版本时最终概率为 100%。

`p=0` 完全按 GEPA 抽样；`p=1` 全部从 champion 起步。零概率分支不能被抽中。

## 每个候选单独抽样

每轮有 N 个候选预算槽位，就冻结 N 个父代 batch，每个 batch 最多生成 1 个 candidate：

1. 按 `p / (1-p)` 抽 champion 分支或 GEPA 分支。
2. Champion 分支直接使用本轮冻结的 champion。
3. GEPA 分支按原 scope 权重抽 scope，再按该 scope 的条件 GEPA 概率抽父代。

没有固定 3＋1、2＋2 配额，也不会只抽一次父代决定整轮所有候选。相同父代重复中签时，共享相同 scope 的诊断及有效 baseline cells；已分配的相同修改假设不重复生成，没有足够假设时不为凑齐预算制造候选。

每个槽位保存 `selectionBranch`、scope、父代 snapshot、draw index。PRNG 仍为版本化确定性哈希计数器；seed、round ID 和归档摘要固定后，恢复不能重抽。

## 晋升、补证与恢复

新策略在下一轮开始时依次冻结：

```text
已提交 archive → 待补证引用 → 当前 champion 的 parent-archive → 父代抽样
```

`parent-archive` 先合并已完成 seed 补证，按当前 champion 重算 GEPA 与混合概率。它是独立的不可变对象；轮次最终提交仍对原已提交 archive 做 CAS，不提前修改全局归档指针。

当前 champion 已有的兼容 global seed cells 可投影到既有 bootstrap scope，支持其完整诊断范围，保留原始证据来源，不新增 rollout。该投影只用于 champion 的 bootstrap 视图，不自动把所有历史结果投影到其他 GEPA 类别。

`ResearchArchive.parentMixture` 保存策略、champion、配置概率、champion 诊断 scope 和原始 `explorationParentProbabilities`；顶层 `parentProbabilities` 保存混合后的实际概率。上一轮的 champion 和概率记录保持不变；晋升后的身份在下一轮选择前进入新视图。Held-out 分数和轨迹不参与概率计算。

共同父代选择任务集、历史候选跨 scope 对称准入属于后续证据覆盖改造。本策略沿用现有 GEPA 探索分布，混合后仍保留其覆盖偏差，不能把混合概率解释为全量能力排名。

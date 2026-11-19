# 第四版正式 harness 实验：练习准入不足而中止

本次运行完成 8/24 个正式搜索，在 seed 202 第 0 轮生成后中止。failure 组只准入 1 条练习，低于冻结协议要求的每组至少 3 条；最终留出评价没有开启。这不是已完成的策略对照，不能据此判断 failure 数据优于固定或随机数据。

## 冻结配置与实际运行

运行使用 `a308c78ab` 的冻结源码，student 为 `gpt-5.6-luna`、teacher 为 `gpt-6-astra`，effort 为 low；模型权重固定，仅搜索 developer prompt。切分 seed 为 20261123，排除前几次使用过的 208 个来源；train/dev/test 为 8/16/24，道数门槛为至少一个 IFEval 约束。训练 readiness 为 6/8，通过预设区间。

计划对 fixed/random/failure/memory 四组分别运行 seeds 101、202、303，每个 seed 两轮。原生结构化输出已启用，语言检测 seed 为 0，负例策略为 `constraint-aware-negatives-v1`。所有 seed 101 的八个搜索完成；seed 202 第 0 轮 random/failure/memory 分别准入 6/1/5 条，尚未开始该轮搜索就触发数量门槛。不能将前三组截取为另一项已完成实验。

## 中止原因

seed 202 的 failure 组尝试生成六条练习：

- 三条来自 `ifeval-2677`。冻结 `end_phrase` 是 `Yes Mom, I am Dave.`，但上游 `build_description` 在短语后再加说明句的句号，渲染为 `Yes Mom, I am Dave..`。三个生成参考都使用了双句号，均被官方 `startend:end_checker` 拒绝。后续修复需要明确标出字符串边界，不能修改这些原始响应或放宽原验证器。
- 三条来自 `ifeval-1130`，要求字母 `t` 少于两次。其中一个参考出现一次而通过，另两个均出现两次而失败。它们的字符限制判断正确，不能为了凑足配额而准入。

这次没有错误 JSON，也没有沿用第二版的负例探针缺陷。生成参考不满足约束，导致有限尝试预算下的有效练习不足。

后续 `exact-ending-v1` 修复仅明确标出结尾字符串边界。使用同一批训练失败和两个已冻结生成计划另做两次真实调用，精确结尾参考在该探针中为 3/3 通过，字母限制仍为 1/3 通过；没有修改第四版任何原始材料。探针的 [回执与验证记录](rendering-probe-evidence.json)和[用量清单](rendering-probe-manifest.json)单列，不计入以下原实验用量，也不作为策略效果证据。

## 归档核验

[`manifest.json`](manifest.json)记录 359 次已完成逻辑模型调用、3,295,234 个有回执的 token，usage 缺失为 0；HTTP 请求数与重试次数未知。1800 是逻辑 SDK turn 上限，不是 HTTP 或金额硬上限。

导出时验证了原始 pending/result 对应关系、回执摘要、调用键及请求绑定；40 条外层训练评价、288 条正式搜索评价全部按固定 seed 重新评分一致，51 份草稿验证记录的参考与原始负例也重新执行。八个搜索 journal 均完成，保存了候选文本和摘要。导出未执行完整采纳策略审计，`full_selection_audit` 明确为 `not_performed`，不能称为完整效果验收。

证据包为 [`evidence.json`](evidence.json)，摘要 `sha256:4615794b3b7893cfa10aa189c8fa6a14a69cc9ad36a1ba6ea8c81eb3b2ae1efe`。原生 thread/turn ID 未放入可分享归档。留出模型调用为 0，源题目与生成内容的许可见 [NOTICE.md](NOTICE.md)。

可在保留原本地 workspace 和 pinned IFEval 环境时重新导出：

```bash
PYTHONPATH=python python examples/curriculum-harness/export_aborted_results.py \
  --workspace /private/tmp/gear-curriculum-formal-20261120-v4 \
  --ifeval-root /private/tmp/gear-curriculum-ifeval \
  --output /private/tmp/gear-curriculum-v4-reexport
```

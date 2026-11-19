# 真实 LLM 的 failure→data→harness 对照

这个调用方示例保持 LLM 权重不变，更新可复用的 developer prompt。它组合 `gear.curriculum` 的案例、诊断、目标选择、生成、验证与筛选算子，执行两轮反思式提示词搜索；不宣称完整复现 GEPA。模型调用、请求恢复、任务格式转换、源数据封存和评测全部在示例中，curriculum 核心不增加执行层。

[2026-11-19 实测报告](../../research/curriculum-harness-2026-11-19/README.zh-CN.md)：363 次真实调用；baseline/fixed/random/failure 分别为 46/45/45/46（共 48 题）。观察到局部练习修复，但未验证到测试集提升；候选超长与开发集饱和限制了归因，报告保留完整记录。

后续的 [正式 Project.refine 四组对照](FORMAL.zh-CN.md) 使用 `ReflectiveSearch`、有限修订、新来源切分和多个优化种子；本页保留先前探索实验的原始协议。

## 实验定义

| 项目 | 固定设置 |
| --- | --- |
| 模型 | `gpt-6-astra`，reasoning effort `low`，三个实验组相同 |
| 更新对象 | developer prompt，最多 1800 字符；不更新模型权重 |
| 执行条件 | 每题独立会话，关闭 shell 和 web search；任何工具事件均报错 |
| 数据与评分 | [Google 官方 IFEval](https://github.com/google-research/google-research/tree/e6890f85757dd84e27ca6df2dd30651dafad28e0/instruction_following_eval)，strict prompt accuracy 为主指标 |
| 子集 | 至少两条可确定性验证的指令；排除语言识别和句子分段等类型，显式词数参数不超过 200；共 113 个符合条件的原始任务 |
| 切分 | seed `20261119`；8 train、8 dev、48 test；原始 prompt/source family 不交叉 |
| 预算 | 两轮，每轮每组最多 8 条训练数据、一次候选提案、8 条开发评测；相同候选采纳规则 |
| 生成不足 | 在更新任何组之前取三组有效数据数的共同最小值，确保每组学习样本数相同；不足两条则停止 |
| 采纳 | 候选的开发集通过数不低于当前 harness 时采纳；最终测试不参与采纳 |
| 无效候选 | JSON/schema/长度不合格则保留当前 harness；消耗本轮提案机会，仍执行同额开发评测，不调用模型修复 |
| 最终测试 | baseline 与三个最终 harness 使用同一 48 题；只在优化完成后执行 |
| 调用限制 | 最多 380 次模型请求，同时最多 4 个，单次超时 240 秒 |

三组的区别：

- **fixed**：每轮继续使用固定训练任务。
- **random**：调用方均匀抽样训练约束模板，LLM 生成新主题和参考回答；生成器不接收失败反馈。
- **failure**：LLM 诊断当前 harness 的真实失败，算子按失败频次分配生成预算，再生成针对这些失败模板的新任务。没有可用失败目标时使用显式随机回退，记录实际 conditioning。

三组的优化、有效学习样本和开发评测预算相同。生成与诊断的额外成本单独记录，不能把固定数据组没有使用的生成额度计作已消耗成本。报告中的真实 token 用量来自 SDK 原生回执；恢复时缺失的用量标为未知。

## 任务生成与独立验证

模型生成新的主题请求、参考回答，以及调用方预先采样的 template slot。调用方根据原始 IFEval 约束构造实际任务，生成器不能改变 verifier 或来源 family。官方判分代码检查参考回答，并运行空答案与非空错误答案控制；未通过的草案不会进入 harness 优化。

目标忠实度在这里指保留选中约束模板。新颖性检查是精确文本去重，不声称语义新颖性已经得到证明。该实验衡量可验证的指令遵循，不把满足格式检查等同于回答内容质量；IFEval 是公开基准，结果也不是其全量官方榜单成绩。

## 运行

在仓库根目录使用独立 Python 3.12 环境，并确保已有 Codex 登录：

```bash
python3.12 -m venv /tmp/gear-curriculum-llm-env
/tmp/gear-curriculum-llm-env/bin/python -m pip install \
  -r examples/curriculum-harness/requirements.txt
/tmp/gear-curriculum-llm-env/bin/python examples/curriculum-harness/prepare.py \
  --output /tmp/gear-curriculum-ifeval
PYTHONPATH=python /tmp/gear-curriculum-llm-env/bin/python \
  examples/curriculum-harness/ifeval_experiment.py \
  --ifeval-root /tmp/gear-curriculum-ifeval \
  --workspace /tmp/gear-curriculum-harness --phase all
```

SDK 自带与固定版本匹配的 CLI，不要求替换系统安装。`prepare.py` 只下载固定公开源码与四份纯文本英文分词表，验证提交和文件摘要；不执行下载的安装脚本。Google 源码的 Apache-2.0 notice 保留在下载文件和许可证中。

可先运行 `--phase baseline`，再以相同工作区运行 `--phase all`。已完成调用由请求与响应摘要校验后复用；有已提交但未知的结果时先读取原始会话完成状态，无法确认则停止，不自动重复收费请求。环境或代码变化会拒绝复用旧工作区。

工作区保存 `identity.json`、`implementation.py`、`splits.json`、每次调用的 prompt/response/原生用量、生成与验证报告、每题评分、候选及采纳记录、最终 `summary.json`。临时 API 故障不计作 task failure。

完成后可离线重新判分并导出不含原生会话 ID 的证据：

```bash
PYTHONPATH=python /tmp/gear-curriculum-llm-env/bin/python \
  examples/curriculum-harness/export_results.py \
  --ifeval-root /tmp/gear-curriculum-ifeval \
  --workspace /tmp/gear-curriculum-harness \
  --output /tmp/gear-curriculum-harness-report
```

导出器校验请求回执摘要、验证证据、每题结果与汇总一致性。`evidence.json` 保存最终回答、生成任务、候选、采纳记录和原生 token 用量；其中验证引用的 `record` 对应同文件 `validation` 对象内的记录。

这类优化不需要梯度训练。[GEPA](https://github.com/gepa-ai/gepa) 使用反思和进化搜索优化文本参数，可覆盖 prompt、代码和配置；[ACE](https://github.com/ace-agent/ace) 把执行经验增量写入上下文 playbook。本示例只更新 developer prompt，没有实现工具调度、运行时代码演化或完整 GEPA/ACE 算法。

## 如何解释结果

对比 failure 与 fixed/random 的同题通过变化，报告净增、修复和退步数量、按题配对 bootstrap 区间以及 exact McNemar p 值。置信区间只描述这次固定 harness 在该测试子集上的差异，不覆盖优化随机性。一次优化种子的探索性对照可以发现信号，也可能显示无增益或回归；不能据此声称 failure 生成普遍优于随机生成。

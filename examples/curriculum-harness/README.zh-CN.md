# 用失败生成的数据改进 harness

这个示例固定 LLM 权重，用 `Project.refine` 和 `ReflectiveSearch` 搜索 developer prompt。它比较四种练习来源：固定训练题、无失败反馈的随机生成、针对当轮失败的生成，以及使用跨轮失败记忆的生成。每组使用相同的样本和候选预算，在相同的留出题上评价。[文本对照源码](formal_experiment.py) · [工具调用对照](SENTINEL.zh-CN.md)

## 运行

在仓库根目录构建 Gear，使用 Python 3.12 安装锁定的依赖。准备脚本核对官方 IFEval 源码和英文分词表的摘要。预检只加载基准、检查资源和 provider 握手。

```bash
npm ci
npm run build
python3.12 -m venv /tmp/gear-curriculum-llm-env
/tmp/gear-curriculum-llm-env/bin/python -m pip install -r examples/curriculum-harness/requirements.txt
/tmp/gear-curriculum-llm-env/bin/python examples/curriculum-harness/prepare.py --output /tmp/gear-curriculum-ifeval
PYTHONPATH=python /tmp/gear-curriculum-llm-env/bin/python examples/curriculum-harness/formal_experiment.py \
  --workspace /tmp/gear-formal-study --ifeval-root /tmp/gear-curriculum-ifeval --phase preflight
```

使用已有的模型服务登录，在同一工作区把 `--phase preflight` 改成 `--phase all` 即可运行完整对照。`readiness` 只评测训练基线，`optimize` 在完成搜索后停止。首次运行可省略 `--previous-splits`。后续研究传入上一工作区的 `splits.json`，会排除以往各轮用过的 train、dev、test 来源。来源不足时停止。

## 对照协议

| 项目 | 约定 |
| --- | --- |
| 模型与候选 | 默认学生模型 `gpt-5.6-luna`，teacher 为 `gpt-6-astra`，effort 均为 `low`。每轮提案一次，生成目标 1000 字符，硬上限 1800 字符，最多修订两次。 |
| 切分与重复 | 默认 8 道 train、16 道 dev、24 道 test。切分种子为 `20261120`，优化种子 101、202、303 各运行两轮，控制抽样和组执行顺序。原生模型解码不受这些种子控制。 |
| 生成与验证 | teacher 与 Meta 使用 SDK 的 `output_schema`。调用方固定 IFEval 的数据、参考和验证器字段。官方 strict 验证器须接受参考答案并拒绝空回答和至少一个非空反例，反例含固定样本和按约束参数构造的样本。 |
| 验证器身份 | 语言检测种子固定为 0。`exact-ending-v1` 用字符串边界表达指定结尾，其余约束沿用官方描述。切分前检查任务是否可校准。 |
| 训练材料 | 每轮每组最多 6 条，按四组验证通过数的最小值取齐，少于 3 条则停止。memory 组根据当前策略测量停用或重新激活失败模式，按频次采样，并混入固定题和随机探索。 |
| 选型与测试 | 初始训练通过率须在 25%–87.5%。模型只见训练任务及反馈，候选严格提高 dev 均分才采纳。各组、各种子、各轮都有合规提案并冻结选型后，才打开相同的 test，再复测原训练题以统计修复与回归。 |

memory 组涵盖新主题、边界难度、干扰重述和最小针对性练习。独立的 Forge 配方另有同批训练门槛、逐题候选选择和验证停滞触发条件。[Forge 配方](FORGE.zh-CN.md)

隔离 worker 从封存的 Pi 资源读取 `AGENTS.md` 作为 developer prompt，拒绝修改配置、扩展或 skills 的候选。每轮使用 `nominate=False`，不发布候选。需要调整筛选范围时可指定 `--minimum-instructions` 和 `--split-seed`，并使用新工作区。[模型调用入口](formal_provider.py)

## 恢复与计量

相同工作区会核对源码、配置和切分，复用已有 run 与模型回执。调用前会保存请求及 thread/turn 身份，回执丢失时查询原会话。无法确认结果时停止。同一个调用键绑定原始输入和 schema。[模型请求与恢复](model_calls.py)

整个对照最多提交 1800 个逻辑 SDK turn，涵盖诊断、生成、搜索和评价。各组按回执分别统计实际 token，缺失值标为未知。SDK 内部 HTTP 重试不计入可观察的调用数。最终工作区包含每题结果、各优化种子的配对差异和实际用量。各优化种子共享测试题和初始基线。[结果导出与离线复核](export_formal_results.py)

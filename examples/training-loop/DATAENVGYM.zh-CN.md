# DataEnvGym-inspired skill-tree 配方

`dataenvgym_cpu.py` 把技能树探索、数据配额调整、生成与验证接入现有四阶段 `TrainingLoop`。实际运行会更新学生参数，再把当前学生的固定训练探针反馈送给下一轮 teacher。`gear.curriculum` 只增加两个纯算子和四个输入输出定义；状态与格式转换均保留在调用方。

DataEnvGym 是数据生成 agent 的实验框架，包含多种 teacher 策略。此实现参考其 [skill-tree 组件](https://github.com/codezakh/DataEnvGym/blob/master/src/dataenvgym/gym/data_generation_agents/math/bandit_components.py)中的子技能提案和 explore/exploit 组织方式，重新实现 Gear 的纯输入输出边界，没有复制其模型执行层。这里的 `expand-or-refocus-v1` 是一个显式示例策略，不代表上游的唯一算法。

## 运行

```bash
PYTHONPATH=python python3 examples/training-loop/dataenvgym_cpu.py \
  --workspace /tmp/gear-dataenvgym-cpu
```

默认六轮，每个根技能每轮最多请求四条练习。CPU teacher 为正／负输入建立根技能，将绝对值区间 1–10、11–20、21–30、31–40 作为可探索子技能。无分支、已掌握或配额归零时，在预算内添加分支；否则为尚未掌握的技能重新分配练习。两种动作都经过纯算子的版本、范围和预算检查。

生成器只返回此前未使用的训练输入。调用方实际计算独立参考值、执行负例校准、检查子技能区间与新颖性，再把选中草案转换成原有 `{x, target}` 格式。生成量可能低于请求量；不会暗中补齐。没有合格数据时保留原 checkpoint，明确跳过更新。

训练探针取 -4、-1、1、4，评测使用独立输入 -100、-75、75、100。`observed_gain` 比较相邻 checkpoint 在同一训练探针上的变化，首轮标为未知。

## 边界与恢复

`ProposeSubskills.prepare/parse` 分离外部生成与提案校验。响应最多包含请求数量的子技能；失败引用只允许来自相应 family 的完整失败。`PlanSkillPractice` 对旧树摘要绑定的 explore 或 exploit 动作生成新树与 `LearningTarget[]`。配额表示本轮生成请求数，不表示累计数据量或质量证明。

调用方在 `rounds/*/task-source/workspace/teacher.json` 保存树、动作、观察、生成／验证／准入数和阶段身份。恢复时检查参数、任务、验证证据摘要以及训练阶段 operation ID；已有结果不重复更新。配置或证据改变会拒绝恢复。`test_curriculum_skills.py` 验证六轮更新、两种动作、字节不变的重复运行、提案／生成／验证三个位置的中断恢复，以及证据篡改拒绝。

默认例子不依赖模型服务；诊断和生成是本地可重复计算。真实 LLM 接入仍须在调用方提供计费回执与 reconcile，真实 tokenizer／LLM updater、GPU 执行及固定／随机对照也尚未在这个配方上验收。不能将本例的阶段恢复测试当成收费调用 exactly-once 的证明。

# 训练开发：写四个阶段，然后运行

开发者只需要提供四个普通 Python 对象：生成任务、执行任务、构建训练数据、更新模型。`TrainingLoop` 负责按顺序执行多轮、传递当前 checkpoint、保存阶段结果和断点续跑。所有阶段都可以不用 agent。

## 先跑一个完整例子

在仓库根目录执行（Python 3.10+，macOS 或 Linux）：

```sh
python3.11 -m venv .venv
. .venv/bin/activate
python -m pip install -e ./python
python examples/training-loop/linear_cpu.py --workspace ./runs/linear --rounds 12
```

[这个例子](../../examples/training-loop/linear_cpu.py)用四个普通类拟合 `y=3x`，执行真实的梯度下降更新。它不需要 GPU、agent、torch 或外部模型。输出包括初始 loss、最后一轮更新前的 loss、最终参数和完成轮数。再次运行相同命令会读取已完成结果，不再重复更新。

## 你的训练脚本长这样

```python
from gear_training import TrainingLoop, TrainingConfig

# 四个对象实现下表的方法；可以是你的类，也可以是适合该合同的封装。
loop = TrainingLoop(
    task_source=MyTaskSource(),
    rollout_executor=MyRolloutExecutor(),
    dataset_builder=MyDatasetBuilder(),
    model_updater=MyModelUpdater(),
)

result = loop.run(TrainingConfig(
    workspace="./runs/my-experiment",
    rounds=10,
    initial_checkpoint={"model_path": "/models/start"},
    parameters={"learning_rate": 0.00001},
))
print(result.checkpoint)
```

上面是接口示意，`My…` 四个类由你实现；可直接运行的完整版本见 CPU 示例。配置也可以传同字段的字典。已有异步程序中使用 `result = await loop.arun(config)`，不要嵌套调用 `run`。

| 阶段 | 实现的方法 | 返回什么 |
| --- | --- | --- |
| TaskSource | `generate(ctx)` | 本轮任务 |
| RolloutExecutor | `execute(ctx, tasks)` | 任务执行轨迹 |
| DatasetBuilder | `build(ctx, trajectories)` | 更新器要消费的数据 |
| ModelUpdater | `update(ctx, dataset)` | 下一轮 checkpoint |

方法既可以用 `def`，也可以用 `async def`，同一个循环中可以混用。无需继承基类、注册插件、手动推进状态或了解 CAS/租约。

例如固定任务源只需要：

```python
class MyTaskSource:
    def generate(self, ctx):
        return [{"question": "1 + 1 = ?", "answer": "2"}]
```

规则生成、文件读取、历史采样和调用 agent 都可以放在这个方法里。框架只关心输入输出合同，不指定任务生成方式。

## 阶段里可以读什么

| 字段 | 用途 |
| --- | --- |
| `ctx.checkpoint` | 本轮开始时的模型状态；四阶段都看到同一个起点 |
| `ctx.round_index` | 从 0 开始的轮次 |
| `ctx.history` | 已完成轮次的任务、轨迹、数据和 checkpoint |
| `ctx.config.parameters` | 学习率、数据来源等你定义的 JSON 参数 |
| `ctx.workspace` | 本阶段独立的工作目录，可写数据文件或 checkpoint |
| `ctx.operation_id` | 同一阶段重试时稳定的操作 ID，供外部训练后端去重 |

`ctx.run_workspace` 是整个运行目录。通常只需写自己的 `ctx.workspace`，不应修改框架保存的输入、结果或身份记录。

各阶段拿到独立的输入、checkpoint 和历史副本，原地修改不会污染之前的产物。下一轮使用 updater 返回的新 checkpoint；框架不会猜测模型存在哪里。

返回值必须是 JSON 可保存的值，如字典、列表、字符串、数值。更新器必须返回 checkpoint，不能忘记 `return`。大型数据或模型应保存到阶段工作目录，返回路径、摘要和格式等元信息；不要返回打开的文件、tensor、SDK client 或生成器。`initial_checkpoint` 可以是完整的小模型状态，也可以是你的后端能读取的 checkpoint 描述。

四个方法之间的数据结构由你的实现约定。框架不会把任意 SFT 数据自动转换成 GRPO batch，也不会根据 reward 猜测数据的训练目标。

## 恢复不需要再写一个流程

保持同样的配置与四个实现，重新调用 `loop.run(config)` 即可。框架校验运行身份与已保存结果，跳过成功阶段，从第一个未完成阶段继续。同一运行目录有互斥锁，不能同时被两个循环写入。

每个阶段的输入、输出摘要和操作 ID 自动保存；成功产物不会因重试重新生成。若配置、阶段身份或已保存结果不匹配，框架报错，而不是悄悄接着训练。改变轮数、参数或策略版本时，使用新的 workspace。

默认阶段身份是类的模块名和类名，**不会自动识别源码或实例属性变化**。影响结果的设置放入 `parameters`；修改算法后可为类设置版本：

```python
class MyDatasetBuilder:
    stage_id = "my-dataset-builder:v2"

    def build(self, ctx, trajectories):
        return [row for row in trajectories if row["verified"]]
```

版本变化会让旧 workspace 拒绝续跑，不会覆盖旧结果。

如果 updater 调用外部训练服务，服务可能已更新成功，而进程在保存阶段返回值前退出。这时框架会用相同 `ctx.operation_id` 再调用 updater，后端应据此查询或去重。框架保证已保存阶段不重跑，不能替任意外部系统承诺 exactly-once。返回文件路径时，后端也需保证 checkpoint 完整、不可被后续更新覆盖；循环的 JSON 校验不等于校验该文件的全部字节。

## 想用 agent 时再接入

agent 是阶段内部的可选实现。例如你的 `generate(ctx)` 可以调用任意 runner，把结果转换成任务后返回；`build(ctx, trajectories)` 也可以调用 agent 选择或转换数据。训练循环无需改变。

已有的通用 `AgentRunner` 合同、Codex 实现和 factory 接入说明见 [agent 阶段说明](stages.zh-CN.md#通用-runner-与恢复)。其中 `gear_training.stages` 下的 GRPO helper 属于原后端的内部接线，方法签名与这里的公开四阶段接口不同，不应直接传给 `TrainingLoop`。复用时写一个实现上述方法的薄包装，并保持原有验证。

不要为了普通 Python 任务源安装 SDK，也不必为每个 runner 新增 TS 类。

## 使用现有 Slime GRPO 后端

如果目标是运行 Gear 已有的 Hitch/Slime 训练，而不是编写自定义四阶段脚本，准备好 [v2 配置](controller-v2.zh-CN.md) 后只需：

```sh
gear-refine training run spec.json --config controller.json
```

该命令创建实验与训练 run，并持续执行已有协调流程，包括 preflight、rollout、更新和独立评估。它会输出实验/run ID 和状态变化；不再需要手动反复 `advance`，也不会自动发布模型。

跟踪已有 run 时使用保存的 ID：

```sh
gear-refine training run EXP_ID RUN_ID --config controller.json
```

`run spec.json` 每次创建新实验，不用于恢复原实验。`run EXP_ID RUN_ID` 遇到 completed、paused、blocked、interrupted 或 failed 会停止；需要恢复时先显式 `resume` 原 run，再执行 `run EXP_ID RUN_ID`。Ctrl+C 请求原有暂停流程，直到控制端收到暂停结果或需处理的错误；直接强杀进程仍可能留下待清理资源。

公开 Python 循环与现有 GRPO 后端目前是两个入口：前者支持你的四个实现；后者保留已有的严格 token、租约、checkpoint 和评估合同。这里没有把 CPU 示例或任意自定义四阶段宣称为已认证的 Slime/GPU pipeline。具体 GRPO 任务生成和数据筛选配置仍见 [四阶段后端说明](stages.zh-CN.md)。

## 改框架时再读这些入口

| 修改内容 | 代码 / 测试 |
| --- | --- |
| 公开四阶段接口、循环与恢复 | [loop.py](../../python/gear_training/loop.py)、`python/tests/test_loop.py` |
| 无 agent 的完整用法 | [linear_cpu.py](../../examples/training-loop/linear_cpu.py) |
| 现有后端持续运行命令 | [cli.ts](../../src/training/cli.ts)、`tests/unit/training/run.spec.ts` |
| agent runner 与输出校验 | [agents.py](../../python/gear_training/agents.py)、[agent_stage.py](../../python/gear_training/agent_stage.py)、`test_stages.py` |
| GRPO rollout、训练数据与更新 | [rollout.py](../../python/gear_training/rollout.py)、[samples.py](../../python/gear_training/samples.py)、[driver.py](../../python/gear_training/driver.py) |

只改普通阶段，可以先运行自己的 CPU 用例与循环测试：

```sh
PYTHONPATH=python:python/tests python -m unittest test_loop
```

修改原 GRPO/controller 框架时再准备 Node 开发环境及 gateway 依赖，并执行相关回归：

```sh
npm ci
python -m pip install -e './python[gateway]'
export GEAR_TRAINING_TEST_PYTHON="$PWD/.venv/bin/python"
export GEAR_TRAINING_LOCK_PYTHON="$GEAR_TRAINING_TEST_PYTHON"
npm run test:training
npm run typecheck
npm run build
```

检查测试报告中的 skipped 项；optimizer 恢复测试需要 CPU torch。SDK smoke、真实 Harbor 执行和 GPU 更新属于不同验证层级。影响原后端运行时、权重同步或 checkpoint 的改动，仍按 [GPU 验证要求](README.zh-CN.md#gpu-验证与认证)验证。

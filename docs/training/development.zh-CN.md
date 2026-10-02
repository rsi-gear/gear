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

## 通过控制器运行自己的脚本

控制器现在可以运行普通四阶段脚本，也可以运行使用 Hitch/Slime 的四阶段脚本。两者使用同一个工厂接口：

```python
from gear_training import TrainingLoop

def build_loop(config, runtime):
    return TrainingLoop(
        MyTaskSource(config),
        MyRolloutExecutor(config),
        MyDatasetBuilder(config),
        MyModelUpdater(config),
    )
```

`config` 包含 `rounds`、`initialCheckpoint`、`parameters`。运行配置沿用 Gear 控制协议的 ASCII 对象键约定，文本值可包含中文；阶段结果支持包括中文键在内的 JSON。`runtime.workspace` 是本次作业目录，`runtime.store` 提供内容存储，`runtime.check_cancel()` 供长阶段主动响应暂停。原生训练环境还提供 `runtime.hitch`、`runtime.slime`；普通 Python 环境不初始化这些服务。

把脚本和自己的辅助模块放在独立目录中。控制器提交时封存该目录并传到节点，worker 加载 `module:factory`，调用工厂得到 `TrainingLoop`。无需注册插件、编写 TS 类或实现控制协议。目录最多 1024 个文件、16 MiB；拒绝符号链接和隐藏文件，自动忽略 `.git`、`.venv`、`node_modules`、`__pycache__`。模型、数据及第三方依赖放在运行环境或内容存储中，不塞进源码目录。

### 普通 Python 脚本

[linear-script.json](../../examples/training-loop/linear-script.json) 与 [linear.py](../../examples/training-loop/recipes/linear.py) 是可运行的 CPU 示例。使用已有 v2 controller 配置即可：

```sh
gear-refine training run examples/training-loop/linear-script.json --config controller.json
```

普通脚本不要求 GRPO 配置、native 更新记录或训练后评估；其最终结果就是四阶段循环返回的 checkpoint。`source` 相对 spec 文件所在目录解析。四个类可以同步或异步，也可以在其中调用任意 agent runner。

没有已有部署时，可用轻量控制器配置，只指定存储和节点连接。例如本机 `script-controller.json`（替换绝对路径）：

```json
{
  "schemaVersion": 1,
  "kind": "training-script-controller",
  "storeRoot": "/absolute/controller-store",
  "node": {
    "transport": {"type": "local"},
    "workspace": "/absolute/workspace",
    "python": ["/absolute/venv/bin/python"],
    "configPath": "/absolute/node.json"
  }
}
```

对应的 `node.json` 只需：

```json
{
  "schemaVersion": 2,
  "nodeId": "local-python",
  "nodeRoot": "/absolute/node-state",
  "storeRoot": "/absolute/node-content"
}
```

节点环境需要安装 Gear Python 包和脚本依赖；控制端需要 Gear CLI。远程使用已有 SSH Host alias：`"transport": {"type": "ssh", "host": "training-node"}`，其余路径和 Python 命令属于远程节点。控制器会探测并固定节点身份，不要求开发者手填进程 ID。

命令打印 `script_…` 运行 ID。后续命令不再读取源目录：

```sh
gear-refine training status SCRIPT_ID --config controller.json
gear-refine training pause SCRIPT_ID --config controller.json
gear-refine training resume SCRIPT_ID --config controller.json
gear-refine training run SCRIPT_ID --config controller.json
```

`resume` 显式继续并跟踪运行；`run SCRIPT_ID` 重新跟踪已有运行，不自动恢复已暂停/失败的作业。`run SPEC.json` 每次创建新运行。Ctrl+C 请求协作式暂停：已正常返回的阶段会先保存结果，再在边界停止；长阶段可调用 `runtime.check_cancel()`。不主动检查的阶段会继续到返回。进度包含轮次和阶段；worker 的 stdout/stderr 保存在节点的 `script-jobs/SCRIPT_ID/worker.log`。

恢复固定源码和配置；修改代码或参数后要创建新运行。依赖包由节点环境管理，源码快照不会自动冻结第三方依赖。脚本属于受信任的 Python 代码，不是沙箱。子进程应留在 worker 的私有 session 中并在阶段结束前回收；若同 session 的子进程仍活着，控制器不会把资源报告为已释放或启动另一个 worker。

### 使用 Hitch、Slime 基础组件

沿用原来的模型、数据、GPU 和 runtime lock 配置，在 native spec 顶层增加：

```json
{
  "scriptSource": {
    "directory": "./recipes",
    "entrypoint": "hitch_slime:build_loop"
  }
}
```

这是合并到完整训练 spec 的片段。`directory` 相对 spec 路径；[hitch_slime.py](../../examples/training-loop/recipes/hitch_slime.py) 给出工厂实现。执行仍是一条命令：

```sh
gear-refine training run native-spec.json --config controller.json
```

控制器把 `scriptSource` 转成冻结的 `trainer.script`，随训练请求上传；节点动态加载该脚本。自定义参数放在 `trainer.scriptConfig`，工厂和阶段通过 `config.parameters` / `ctx.config.parameters` 读取。轮数和初始 checkpoint 来自 native 训练配置及模型状态。已封存代码引用也可直接放在 `trainer.script`；不要同时提供这两种来源。

Hitch/Slime 的设备安排、权重同步、完整 checkpoint、任务执行桥接和独立评估仍由现有运行环境负责。开发者可直接复用内置的 `FrozenTaskSource`、`HitchRolloutExecutor`、`PolicyDatasetBuilder`、`SlimeModelUpdater`，也可替换其中的类；任务源不要求 agent。直接调用组件的底层接口时须遵守其数据和生命周期合同，通常优先组合内置阶段。

内置 Slime 适配支持 GRPO、GSPO、CISPO、REINFORCE++、REINFORCE++ baseline 和离线 SFT，具体目标由 `trainer.recipe` 冻结。在线脚本使用 `gear_training.online_rl` 的四个组件，提供精确轨迹和兼容 batch；REINFORCE++ 可使用单样本组，组内奖励相同也会保留。`dev_grpo` 的原导入路径继续可用。

离线 SFT 使用 [offline_sft.py](../../examples/training-loop/recipes/offline_sft.py)：任务源选择封存数据窗口，执行阶段读取记录，构建阶段封存助手 token 掩码，更新阶段交给 Slime。它不启动 Hitch 在线采样或推理模型服务。先按 [离线数据指南](recipes.zh-CN.md#离线数据作者入口) 使用 `seal-sft`，设置 `trainer.recipe: "offline-sft-v1"` 和 `offlineTraining`，再把 `scriptSource.entrypoint` 设为 `offline_sft:build_loop` 即可使用同一个运行命令。

使用内置 updater 的脚本须通过 Slime 提交完整 checkpoint；更换算法或离线数据合同必须建立新的 optimizer lineage。完全不同的数据合同或优化器可以使用普通脚本运行入口。现有 `stages` agent 配置不与 `trainer.script` 同时使用，也不用于离线 SFT；agent 调用可写在自定义阶段中。

原 dev 的默认脚本是 [recipe.py](../../python/gear_training/recipes/dev_script/recipe.py)，与自定义脚本走相同加载接口；不再使用 `trainer.pipeline` 开关。便利命令保留：

```sh
python -m gear_training.dev_grpo --spec dev-spec.json --config controller.json
```

它选择默认四阶段源码，再交给控制器；默认工厂根据 `trainer.recipe` 组合在线或 SFT 阶段。原生运行继续使用 `EXP_ID RUN_ID` 查询/恢复，普通脚本使用 `SCRIPT_ID`。这是两种运行环境的作业身份；开发者的四阶段工厂合同相同。

## 改框架时再读这些入口

| 修改内容 | 代码 / 测试 |
| --- | --- |
| 公开四阶段接口、循环与恢复 | [loop.py](../../python/gear_training/loop.py)、`python/tests/test_loop.py` |
| 通用脚本控制器、节点 worker 和加载 | [script-controller.ts](../../src/training/script-controller.ts)、[script_job.py](../../python/gear_training/script_job.py)、[script_source.py](../../python/gear_training/script_source.py) |
| 原 dev 四阶段 recipe 和运行入口 | [dev_grpo.py](../../python/gear_training/dev_grpo.py)、[启动脚本](../../examples/training-loop/dev_grpo.py) |
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

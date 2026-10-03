# 用自己的 GPU 运行四阶段训练

这份文档面向接手训练流程的开发者。你可以直接复用 Terminal-Bench（TB）GRPO / SFT 示例，也可以替换其中一个或多个阶段。训练逻辑用 Python 编写；控制器负责把脚本放到指定节点运行、跟踪状态和恢复，不要求你为四个阶段写 TypeScript 实现。

推荐阅读顺序：四阶段 → 修改方式 → GPU 一次性配置 → 选一个示例启动。

## 1. 框架是什么

每轮执行下面四步，更新器返回的 checkpoint 成为下一轮的起点：

```text
当前 checkpoint + 历史
          ↓
TaskSource → RolloutExecutor → DatasetBuilder → ModelUpdater
  本轮任务       执行轨迹           训练数据        新 checkpoint
          ↑                                         │
          └──────────── 下一轮 ──────────────────────┘
```

| 阶段 | Python 方法 | 做什么 | 可以怎么实现 |
| --- | --- | --- | --- |
| TaskSource | `generate(ctx)` | 决定下一批练习 | 固定任务、读取文件、按历史弱点采样，或调用 agent |
| RolloutExecutor | `execute(ctx, tasks)` | 当前模型执行任务，得到轨迹 | Hitch 执行 TB；SFT 可以直接读取已有记录 |
| DatasetBuilder | `build(ctx, trajectories)` | 将轨迹处理成训练数据 | 验证并计算 reward、筛选成功解、提取首错前动作，或生成助手监督数据 |
| ModelUpdater | `update(ctx, dataset)` | 从本轮起点按指定目标更新，返回新 checkpoint | Slime GRPO、Slime SFT，或自己的训练后端 |

**轨迹与训练数据是两个产物。** 例如 GRPO 数据包含策略 token、生成时 logprob 和 reward；SFT 数据包含 token 和助手 loss mask。框架不会把二者自动互换，builder 与 updater 必须约定相同的数据格式。

三个部件分工如下：

- **TrainingLoop**：依次调用四个方法，执行多轮，保存阶段结果。
- **控制器**：加载 `build_loop(config, runtime)`，连接本机或 SSH GPU 节点，协调执行、恢复和独立评估。
- **Hitch / Slime**：可复用的基础组件。Hitch 负责 TB 的工具执行与验证；Slime 负责模型生成、梯度更新和 checkpoint。

TaskSource 和 DatasetBuilder 都是普通 Python 对象。agent 只是内部可选的实现：可以用 Codex、Claude Code、dsh 或其他 runner；使用文件和规则实现时无需安装 agent SDK。

## 2. 怎么修改四个阶段

一个脚本只需提供工厂，返回组合好的 `TrainingLoop`。例如现成的 TB GRPO 工厂位于 [tb21.py](../../examples/training-loop/terminal-bench-2.1/recipe/tb21.py)：

```python
from gear_training import TrainingLoop
from gear_training.online_rl import (
    FrozenTaskSource, HitchRolloutExecutor,
    PolicyDatasetBuilder, SlimeModelUpdater,
)


def build_loop(config, runtime):
    return TrainingLoop(
        FrozenTaskSource(runtime),
        HitchRolloutExecutor(runtime),
        PolicyDatasetBuilder(runtime),
        SlimeModelUpdater(runtime),
    )
```

修改任务选择，只替换第一个对象；修改轨迹到数据的转换，只替换第三个对象。四个方法可以同步或异步，无需继承框架基类。

### 普通 Python 阶段

例如文件任务源：

```python
import json
from pathlib import Path


class FileTaskSource:
    stage_id = "my.file-tasks:v1"

    def generate(self, ctx):
        path = Path(ctx.config.parameters["tasks_file"])
        return json.loads(path.read_text())
```

普通 loop 中成功轨迹筛选可以写成：

```python
class SuccessDatasetBuilder:
    stage_id = "my.success-only:v1"

    def build(self, ctx, trajectories):
        return [row for row in trajectories if row["verified"]]
```

这里的 `verified` 字段属于示例自定义数据合同。**使用现成 Slime GRPO updater 时，不能直接返回这个列表**：应保持其 sealed batch、完整 reward 分组、原生 token / logprob 和来源校验。固定 TB GRPO 示例会拒绝随意替换任务或样本；要采用新数据合同，应同时适配相应 executor / builder / updater。完整普通脚本和原生组件扩展见 [接口开发指南](development.zh-CN.md)。

### 阶段拿到的上下文

| 字段 | 用途 |
| --- | --- |
| `ctx.checkpoint` | 本轮开始时的 checkpoint，四阶段看到同一个起点 |
| `ctx.round_index` | 从 0 开始的轮次 |
| `ctx.history` | 已完成轮次的任务、轨迹、数据和 checkpoint |
| `ctx.config.parameters` | 你在配置中定义的参数 |
| `ctx.workspace` | 本阶段可写目录 |
| `ctx.operation_id` | 重试不变的操作 ID，外部训练服务可以据此去重 |

返回值必须能保存为 JSON。大文件、轨迹和权重放在文件或制品库中，返回路径 / 引用；不要返回 tensor、SDK client 或打开的文件。Updater 必须返回下一轮 checkpoint；需要续训时应包含 optimizer、scheduler、RNG 等状态或它们的引用。

### 让控制器加载你的工厂

例如文件为 `my_recipe/recipe.py`，在自己的 native base spec 中选择：

```json
{
  "scriptSource": {
    "directory": "./my_recipe",
    "entrypoint": "recipe:build_loop"
  }
}
```

这是合并到完整 spec 的片段。路径相对于 spec 文件；选择 `scriptSource` 时删除旧的 `trainer.script`。参数放在 `trainer.scriptConfig`，工厂中通过 `config["parameters"]` 读取；运行阶段通过 `ctx.config.parameters` 读取。

然后统一启动：

```sh
python -m gear_training run my-spec.json --config controller.json
```

对于不使用 Hitch / Slime 的普通四阶段脚本，使用 `kind="training-script"` 和轻量脚本控制器即可，配置样例见 [普通脚本入口](development.zh-CN.md#通过控制器运行自己的脚本)。它们都使用同一工厂接口。

修改实现后更新 `stage_id` 或使用新的运行目录；普通 loop 不会自动识别类内源码变化。原生控制器还会封存工厂源码，已有实验不会随工作树修改而改变。

## 3. 自己的 GPU：只做一次的接入准备

**下文“一键运行”指配置好自己的环境之后，一条命令封存示例数据、校验并持续运行整个流程。** 仓库目前不提供从一台空白 GPU 主机自动安装并认证全部依赖的入口。模型、设备和运行时需要先按本节接入，不能把其他人的私有路径、GPU UUID 或证书直接复制过来。

推荐 v2 部署：控制端运行 Gear / Hitch / Harbor / Linux Docker，模型节点运行 Slime / Megatron / SGLang。两端可以在同一台 Linux GPU 主机，也可以让控制端通过 SSH 连接 GPU 节点。纯模型节点不需要 Docker。

在 Gear checkout 根目录安装控制器与 Python 接口：

```sh
npm ci
npm run build
python -m pip install -e './python[gateway]'
```

Python 需要 3.10+。GPU 节点安装同版本 Gear Python 包，以及相互匹配的 CUDA / torch / Slime / Megatron / SGLang；Hitch checkout 也需与锁定版本一致。具体配置见 [v2 控制器与节点](controller-v2.zh-CN.md)，依赖和补丁合同见 [训练运行时](README.zh-CN.md#配置和不可变输入)。安装 Gear Python 包本身不会安装整个 GPU 训练环境。

交接配置建议放在自己不提交的目录中：

```text
local-training/
├── controller.json       # 控制端路径、本机/SSH 节点、Hitch 配置
├── grpo-base.json        # 完整 GRPO spec：模型、运行时、优化器、预算、评估
├── sft-base.json         # SFT 对应配置；示例入口会补 datasetRef 和工厂
├── bindings.json         # TB 各任务的真实 Hitch 环境/任务/verifier 身份
└── tb-sft-input.json     # 审核过的 TB train 监督记录
```

这些 JSON 中引用的 CAS 制品也需要存在；一个含摘要的 spec 不是完整模型或数据的备份。

首次准备依次完成：

1. 按 v2 文档配置 `controller.json`、节点的 `node.json` / `job.json`，启动对应的 Hitch daemon。
2. 用 `preflight-deployment` 检查现场依赖，用 `freeze-deployment` 固定节点和任务执行环境。
3. 将模型放到 GPU 节点并用 `seal-hf-node` 封存。`initialModel` 填返回的 `modelRef`；在线 GRPO 的 `referenceModel` 是固定 KL 参照，后续轮次不会自动改成上一轮模型。SFT 不加载 reference actor。
4. 为模型选择完整的 Slime 参数，封存为 `hyperparametersRef`。GRPO / SFT 分别准备，不能只改 recipe 名称就把在线参数直接用于 SFT。
5. 从实际 Hitch 基线 / canonical 记录提取 task bindings，并固定**实际执行任务的 runner artifact**。Mac 控制端构建的 artifact 不能代替 Linux 执行端的 artifact。
6. 完成适用的 GPU 运行时探针和认证，将真实证据封存到 runtime lock；正式入口不接受 `pending-gpu` lock。认证流程见 [GPU 验证](README.zh-CN.md#gpu-验证与认证)。

部署检查命令，在配置对应的控制端执行：

```sh
node lib/cli.js training preflight-deployment --config local-training/controller.json
node lib/cli.js training freeze-deployment --config local-training/controller.json
node lib/cli.js training seal-hf-node /models/Qwen3.5-2B --config local-training/controller.json
```

`/models/Qwen3.5-2B` 是 GPU 节点上的路径，替换为自己的模型目录。检查通过和已有调试记录都不能替代新环境的正式认证。

单卡 GRPO 使用 colocated actor/rollout 和 sequential train/evaluation；SFT 训练为 actor-only。设备填实际 GPU UUID，容量取决于模型、序列长度、batch 和 CPU offload。`Qwen3.5-2B` 是已有单卡调试目标，相关适配及验证边界见 [调试记录](debugging/2026-10-02-qwen3.5-2b/README.zh-CN.md)。

## 4. 示例一：Terminal-Bench GRPO

四阶段组合：

```text
FrozenTaskSource → HitchRolloutExecutor → PolicyDatasetBuilder → SlimeModelUpdater
选择冻结 TB 任务    当前策略执行 TB        验证 + reward/token batch     GRPO 更新
```

**这是在线、on-policy GRPO，rollout 每轮都必须执行。** 正常两轮流程如下：

```text
第 1 轮：初始模型 → 执行 TB，采集新轨迹 → 验证并构建 batch₀ → 更新得到模型₁
第 2 轮：模型₁   → 再次执行 TB，采集新轨迹 → 验证并构建 batch₁ → 更新得到模型₂
```

可以重复选择同一道题，但必须由本轮当前策略重新执行；上一轮成功轨迹、其他运行保存的轨迹或人工轨迹都不能代替本轮 rollout。任务快照和 bindings 只固定题目与环境，不包含可跳过采样的训练答案。此 GRPO 命令不接收离线轨迹输入，也不使用跳过采样的调试脚本。

更新阶段将**本轮刚完成 rollout 的 batch**交给 Slime 做数据预处理和梯度更新，因此内部可能出现 `replayBatchRef`；这是四阶段间传递本轮数据，第二阶段已经真实执行，不表示跨轮使用旧轨迹。恢复时的复用边界见文末。

默认 [split.json](../../examples/training-loop/terminal-bench-2.1/split.json) 使用三道任务：train 为 `log-summary-date-ranges`，dev 为 `openssl-selfsigned-cert`，held-out 为 `pypi-server`。这是小规模训练示例的自定义拆分，不是完整 TB 官方分数。

一次性下载任务，在仓库根目录执行：

```sh
git clone https://github.com/harbor-framework/terminal-bench-2-1 ../terminal-bench-2-1
git -C ../terminal-bench-2-1 rev-parse HEAD
```

审核并记录输出的完整 commit；运行时传相同值，任务目录必须干净。`bindings.json` 的结构见 [绑定样例](../../examples/training-loop/terminal-bench-2.1/bindings.example.json)，身份提取方法见 [TB 示例说明](../../examples/training-loop/terminal-bench-2.1/README.md)。

在 `grpo-base.json` 中选 `trainer.recipe="agent-grpo-v1"`。先验证两轮时，设 `trainer.updatesPerCandidate=2`；B=1、G=2、global batch=2、DP=1 可作为 batch 配置起点，相应 Slime 每 rollout steps=1。模型结构、序列上限、优化器和 GPU 预算仍由自己的完整 base spec 指定。

**一条命令封存、校验、启动多轮及独立评估：**

```sh
python examples/training-loop/terminal-bench-2.1/prepare.py \
  --base-spec local-training/grpo-base.json \
  --config local-training/controller.json \
  --tasks-root ../terminal-bench-2-1/tasks \
  --revision "$(git -C ../terminal-bench-2-1 rev-parse HEAD)" \
  --bindings local-training/bindings.json \
  --output runs/tb-grpo-001 \
  --run
```

输出目录必须是新的。入口保留 base spec 的模型、优化器、运行时、预算与脚本参数，替换 TB 数据及对应四阶段工厂，然后调用统一控制器。`--split path/to/split.json` 可以换任务划分；对应 bindings 也要更新。省略 `--run` 只做 CPU 数据准备。

有效的 reward=0 也可进入 GRPO。若同组全为 reward=1，可能得到零 advantage / 零梯度；任务成功与参数发生非零更新需要分别查看。示例不会为得到正 reward 修改 verifier。

## 5. 示例二：Terminal-Bench SFT

SFT 使用已有、审核过的 TB train 解题记录，不需要再在线采样：

```text
DatasetTaskSource → OfflineRolloutExecutor → AssistantDatasetBuilder → SlimeModelUpdater
选择离线记录窗口      读取已封存记录            组装助手监督 batch          SFT 更新
```

工厂见 [tb21_sft.py](../../examples/training-loop/terminal-bench-2.1/recipe/tb21_sft.py)。第二阶段在这里承担读取既有轨迹的作用，不调用策略生成。独立 dev / held-out 评估仍会执行 TB。

### 一次性准备监督记录

可以使用之前 GRPO 得到的成功 train 轨迹，也可以人工编写并审核同一 train 任务的解题记录。保存为现有 `seal-sft` 接受的 `tb-sft-input.json`：

```text
schemaVersion: 1
modelRef: 与 sft-base.json.initialModel 相同
maxSequenceTokens: 与 sft-base.json.offlineTraining 相同
records:
  - source: {taskId, family, taskDigest}
    segments: [{role, tokens}, ...]
```

`source` 从准备好的 `runs/tb-grpo-001/spec.json` 的 `datasets.train.tasks` 提取：taskId=`id`、family=`family`、taskDigest=`taskRef.digest`。**这里是 CAS 任务快照摘要，与 bindings 中的 Hitch taskDigest 不同。** 如果换了任务内容或 split，重新准备数据来源。只有相同模型的 tokenizer / template 与 token 语义才能复用已有轨迹。

`segments` 中的 tokens 必须是实际模型编码的 token IDs；沿轨迹保留 user / assistant / tool 的角色边界。助手段参与 loss，工具输出、用户输入和 system 段不参与 loss；第一 token 始终不监督。不要用随意数字代替真实 token，也不要把整条工具对话都设为助手答案。

也可用 `messages`（可附 `tools`）代替 `segments`。这条入口要求 sealed tokenizer 的原生 chat template 能返回助手 generation mask；不支持时会报 `assistant-mask-unavailable`。已有精确 token 轨迹适合使用 `segments`。完整输入样例与封存约束见 [离线数据作者入口](recipes.zh-CN.md#离线数据作者入口)。

### 一次性准备 SFT base spec

复制自己的完整配置并调整：

| 配置 | SFT 含义 / 示例 |
| --- | --- |
| `trainer.recipe` | `offline-sft-v1` |
| `trainer.hyperparametersRef` | 自己封存的 SFT Slime 参数；保留模型结构 / seq-length / optimizer，移除在线 KL、clipping、rollout GPU 参数 |
| `trainer.rolloutBatchSize` | 每轮 example 数；示例为 1 |
| `trainer.globalBatchSize` / `dataParallelSize` | 示例均为 1 |
| `trainer.updatesPerCandidate` | 本次 loop 的更新轮数；示例为 2 |
| `offlineTraining.shuffleSeed` | 固定数据排列种子，例如 23 |
| `offlineTraining.maxEpochs` | 可读取的 epoch 上限；两条记录各读一次时为 1 |
| `offlineTraining.maxSequenceTokens` | 按真实数据长度和模型容量指定，不静默截断 |
| `offlineTraining.maskContract` | `assistant-token-mask-v1` |

`offlineTraining.datasetRef` 可省略，示例入口会封存输入并填入。这是入口准备前的 base 文件，最终 spec 才进入 schema 校验。确保 `记录数 × maxEpochs ≥ updatesPerCandidate × rolloutBatchSize`。若只有一条记录、要更新两轮，可设 maxEpochs=2。

SFT 使用独立 optimizer lineage 和适用于 SFT 的 runtime 证据；不能把 GRPO optimizer checkpoint 或 GRPO 证书直接当作 SFT 的续训状态。`fixedHarness`、verifier、dev / held-out、预算和评估 policy 仍保留。

**一条命令封存、校验、启动 SFT 多轮及独立评估：**

```sh
python examples/training-loop/terminal-bench-2.1/prepare.py \
  --base-spec local-training/sft-base.json \
  --config local-training/controller.json \
  --tasks-root ../terminal-bench-2-1/tasks \
  --revision "$(git -C ../terminal-bench-2-1 rev-parse HEAD)" \
  --bindings local-training/bindings.json \
  --sft-input local-training/tb-sft-input.json \
  --output runs/tb-sft-001 \
  --run
```

入口复用正式 `seal-sft`，校验模型、长度设置与 train 来源，不重新采样。初版支持最多 1024 条记录，全部 tokenized records 合计不超过 4 MiB；适合小规模验证。

## 6. 看结果、继续运行与排查

控制器启动时输出 `EXP_ID` / `RUN_ID`，记录这两个 ID：

```sh
python -m gear_training status EXP_ID RUN_ID --config local-training/controller.json
python -m gear_training pause EXP_ID RUN_ID --config local-training/controller.json
python -m gear_training resume EXP_ID RUN_ID --config local-training/controller.json
```

`resume` 会持续跟踪原运行。不要重新执行带新 output 的准备命令来恢复，否则会创建新实验。仅数据准备或校验失败、尚未创建实验时，可修复环境后运行已生成的 spec：

```sh
python -m gear_training run runs/tb-grpo-001/spec.json --config local-training/controller.json
# SFT 对应 runs/tb-sft-001/spec.json
```

多轮验证关注三件事：配置的更新轮数是否全部提交；第二轮是否使用上一轮模型及连续的 optimizer / scheduler / 数据 cursor；最终 HF 导出是否能重载。阶段结束、candidate 训练完成与 dev 评估通过晋级是不同状态，质量不达标不等于训练失败。

GRPO 的故障恢复只允许复用**同一运行、同一尚未提交的更新、同一采样时模型权重**下已经采集的 batch。例如第 1 轮 rollout 完成而训练失败，修复后可以恢复第 1 轮的原 batch；这不是新的训练轮。若完整 checkpoint 已保存而 HF 导出失败，则只补导出，不再执行梯度更新。该轮提交完成后，第 2 轮必须用更新后的模型重新 rollout，不能沿用第 1 轮 batch。

SFT 则按离线数据 cursor / epoch 读取既有记录。两种配方都应使用原 ID 恢复。若修改导致运行时 / 数据 / checkpoint 兼容性变化，会拒绝原地恢复，应显式创建新实验。为定位训练错误而单独复用轨迹、跳过采样的调试方式，不属于这里交付给开发者的正常 GRPO 示例。

常见入口问题：

| 报错 / 现象 | 处理 |
| --- | --- |
| `output directory already exists` | 恢复用原 ID；新实验换 output |
| dataset revision / tasks dirty | 使用已审核 commit，清理或提交任务变更后重新封存 |
| Hitch task / artifact identity drift | 从实际执行端重新取得身份；改 runner 后重启 daemon 并重新冻结 |
| `gpu-probes-pending` | 完成自己运行时的真实 GPU 认证，不能手改状态跳过 |
| `assistant-mask-unavailable` | 使用审核过的真实 role-token segments，或显式封存支持 mask 的模板 |
| SFT 来源或长度不匹配 | 对齐 sealed train task / 模型 / token 上限，重新准备输入 |

这些命令会管理训练进程，**不会替你关闭或删除云厂商租用的 GPU 机器和磁盘**。最终模型、原生 checkpoint 和日志的位置由 controller / node 的 storeRoot、jobsRoot 决定；结束租用前自行保存需要的制品。

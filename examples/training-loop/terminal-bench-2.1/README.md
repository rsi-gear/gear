# Terminal-Bench 2.1：四阶段 GRPO 示例

复用已经配置好的 Gear GRPO 模型、Hitch/Slime 环境和 controller，把任务换成 Terminal-Bench 2.1，再通过同一个 `training run` 入口运行。四阶段组合在 [recipe/tb21.py](recipe/tb21.py)：

```text
FrozenTaskSource → HitchRolloutExecutor → PolicyDatasetBuilder → SlimeModelUpdater
```

任务源是普通 Python 类，不需要 agent。改造其中一个阶段时，直接编辑这个工厂的组件；修改后重新准备 spec，会产生新的源码引用。

数据来自 [官方 TB 2.1 仓库](https://github.com/harbor-framework/terminal-bench-2-1)，任务位于 `tasks/`。默认 [split.json](split.json) 用三个不同任务做最小链路实验：train 为 `log-summary-date-ranges`，dev 为 `openssl-selfsigned-cert`，held-out 为 `pypi-server`。这是一份自行划分的训练实验，结果不代表完整 TB 2.1 官方 benchmark 分数。扩充 split 时把同一来源的任务变体归入同一 family，避免跨分区泄漏。

## 1. 准备已有运行配置

从 Gear 仓库根目录执行以下命令。先安装当前版本的 Python 包并构建 CLI：

```sh
npm ci
npm run build
python -m pip install -e './python[gateway]'
```

你需要已有的 `controller.json` 和 **完整 GRPO** `base-spec.json`，其中模型、reference、超参数、runtime lock、部署、GPU、fixed harness、verifier、评估条件和预算都来自真实环境。`trainer.recipe` 必须是 `agent-grpo-v1`。模型节点也要安装对应版本；Hitch daemon、Harbor/Docker 与锁定的训练依赖按 [部署指南](../../../docs/training/controller-v2.zh-CN.md) 准备。

本示例保留已有训练参数和预算，不替你选择模型大小、学习率、batch 或显存配置，也不把未验证的 runtime lock 标记为 validated。B×G、global batch、DP 以及 sealed Slime steps 必须保持一致。`controller.storeRoot` 使用绝对路径。

## 2. 下载并固定任务版本

```sh
git clone https://github.com/harbor-framework/terminal-bench-2-1.git /datasets/terminal-bench-2-1
git -C /datasets/terminal-bench-2-1 rev-parse HEAD
```

记录输出的完整 commit，后续命令用它替换 `TB21_COMMIT`。已有 checkout 可以先切到你审阅过的固定 commit。准备工具拒绝 revision 不匹配或 tasks 下存在未提交变更；不会自动下载新版数据。

## 3. 绑定真实任务环境

复制 [bindings.example.json](bindings.example.json) 为本地 `bindings.json`，填写每个任务的 family 和三个真实身份值。占位符不能直接启动。

环境身份来自同一任务版本、同一环境的可信 Hitch plan/canonical run。已有 canonical run 可通过下面的命令查看：

```sh
hitch runs inspect RUN_ID --json
```

| bindings 中的字段 | `runs inspect` 返回字段 |
| --- | --- |
| `environment.hitchEnvironmentIdentity` | `record.protocol.environment_identity` |
| `environment.taskDigest` | `record.context.task_digest` |
| `environment.verifierIdentity` | `record.context.verifier_identity` |

任务 ID 需与 `record.context.task_id` 一致。不要用 Gear CAS 的 task snapshot digest 替代 Hitch `task_digest`，也不要复制其他任务的值。训练时会重新与实际 canonical 证据比对；准备阶段只检查格式。若还没有可信环境身份，先按现有 Hitch 基线/任务规划流程获得它们。 每个训练任务封存为仅含一个任务子目录的数据集，路径结构为 `TASK_ID/TASK_ID/task.toml`；规划或基线也须使用这个数据集根目录，保证本地 benchmark revision 一致。

## 4. 准备数据并启动

```sh
python examples/training-loop/terminal-bench-2.1/prepare.py \
  --base-spec /your/config/base-spec.json \
  --config /your/config/controller.json \
  --tasks-root /datasets/terminal-bench-2-1/tasks \
  --revision TB21_COMMIT \
  --bindings /your/config/bindings.json \
  --output /your/runs/tb21-grpo

python -m gear_training validate /your/runs/tb21-grpo/spec.json \
  --config /your/config/controller.json

python -m gear_training run /your/runs/tb21-grpo/spec.json \
  --config /your/config/controller.json
```

准备阶段只使用 CPU：检查分区和 family，按真实字节封存单任务与完整 split，写入 controller CAS，冻结本例 Python 工厂，输出 `spec.json` 和 `dataset-provenance.json`。输出目录必须不存在；原 base spec 不会修改。`validate` 检查配置合同；`run` 才创建新实验并进入基线评估、训练、候选评估。实际运行仍受 GPU preflight 和 runtime 认证约束。

只有 train split 开启精确训练数据授权，dev/held-out 不进入训练请求。原 spec 的 `requiredTaskIds` 替换成这里的所有 dev/held-out 任务；旧自定义脚本选择也替换为 `tb21:build_loop`。其余评估政策保留。旧 `stages`/`trainer.pipeline` 和 SFT 配置会被拒绝，不会悄悄混用。

如果要扩大任务规模，编辑或另建 split JSON，并传 `--split /path/to/split.json`。所有选中任务都需要 bindings。模型在同组内全成功或全失败时，默认 GRPO 策略可能跳过零方差组并最终报告 no-update；这个小示例不保证产生梯度或提高分数。

## 5. 暂停与恢复

启动后记下输出的 `EXP_ID` 和 `RUN_ID`。Ctrl+C 请求暂停。恢复使用原 ID：

```sh
python -m gear_training resume EXP_ID RUN_ID --config /your/config/controller.json
```

`run spec.json` 会创建新实验，不能用它代替恢复。只查看状态可用 `training status EXP_ID RUN_ID`。本示例没有实际执行 GPU 训练或 TB 容器任务；CPU 检查不构成该数据集的 GPU/Harbor 兼容性认证。

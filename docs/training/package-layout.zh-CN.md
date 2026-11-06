# 训练包目录与迁移

正式 Python 命名空间是 `gear.training`。此次采用搬迁后整理：保留四阶段执行、Slime/Hitch 集成、预算、checkpoint 和恢复逻辑，将命令行入口与实现拆开。`gear_training` 包与旧 Python 模块命令不再提供。

```python
from gear.training import TrainingLoop, TrainingConfig
```

基础导入和 CPU loop 不导入 PyTorch、Transformers、Slime 或 aiohttp。GPU 与服务依赖只在相应后端启动时加载。

| 目录/文件 | 责任 |
| --- | --- |
| `contracts.py` | 四个 Protocol、TrainingConfig/Context/Result |
| `loop.py` | 四阶段顺序、同步/异步调用、阶段结果重放 |
| `storage/` | CAS、原子文件、锁、账本、模型与数据快照、阶段 journal |
| `runtime/` | 作业所有权、节点 RPC、进程回收、设备、preflight、源码冻结 |
| `backends/slime/` | Slime actor、在线/离线 rollout hook、checkpoint 导出及恢复 |
| `inference/` | 网关、模型服务附着、服务进程恢复 |
| `data/` | 轨迹、样本、GRPO/SFT 数据构建、离线监督、模型元数据 |
| `adapters/` | Hitch、agent runner、受控 agent 阶段 |
| `pipelines/` | 可组合的在线 RL 和离线 SFT 四阶段实现 |
| `recipes/` | 后端配方合同、默认 composition factory |
| `cli/` | 控制器命令、artifact RPC、agent-stage 子进程、脚本启动参数 |

模型评测的 task-macro 配对统计、dev/held-out 晋级规则和离线 SFT epoch 排序统一位于 `gear.algorithms.model_training`。这是不读写存储的固定计算模块；`training/data` 负责数据来源与合同校验，`training/pipelines` 负责四阶段组合，TypeScript 控制器调用同一份 Python 算法。每个 task 的重复尝试先求均值，再计算 task-macro 差值及任务级标准误；单任务标准误为 `None`。任务输出按 Unicode 码点排序，不依赖宿主 locale。离线记录排列保留既有 seed/epoch/index 的 SHA-256 顺序。

TypeScript 控制器与项目评估共用 `src/adapters/hitch/environment.ts` 的 provider 环境校验和 `json.ts` 的 Hitch JSON 摘要；训练部署只保留自己的 placement、来源 checkout 和 GPU 约束，避免维护重复的 daemon/worker 校验。

公共四阶段合同只有 `contracts.py` 一份。后端内部 helper 的签名可能不同，不能直接当成公共阶段传入 TrainingLoop。示例 factory 位于 `examples/training-loop/recipes/` 和 `examples/training-loop/terminal-bench-2.1/recipe/`；部署诊断程序在 `python/probes/`，不作为基础包导入。

## 入口映射

| 用途 | 当前入口 |
| --- | --- |
| 普通 loop | `gear.training.TrainingLoop` |
| 训练控制器 | `python -m gear.training` |
| 节点 RPC | `python -m gear.training.cli.node` |
| 后端作业 | `python -m gear.training.cli.job` |
| 自定义脚本作业 | `python -m gear.training.cli.script_job` |
| 受管原生部署 | `python -m gear.training.cli.native_deployment` |
| Slime actor 进程 | `python -m gear.training.cli.slime` |
| CUDA 设备枚举 | `python -m gear.training.cli.gpu_inventory` |
| 运行环境认证封存 | `python -m gear.training.cli.certify` |
| agent-stage 子进程 | `python -m gear.training.cli.stages` |
| 快照 RPC | `python -m gear.training.cli.artifacts` |
| 在线 RL 工厂 | `gear.training.pipelines.online_rl:build_loop` |
| 离线 SFT 工厂 | `gear.training.pipelines.offline_sft:build_loop` |
| Slime 在线 hook | `gear.training.backends.slime.rollout.generate_rollout` |
| Slime 离线 hook | `gear.training.backends.slime.offline.generate_rollout` |

恢复会验证实际阶段源码、显式 `source_dependencies`、`package_dependencies` 的安装版本、配置以及阶段输入/输出摘要。搬迁改变模块名和源码身份，旧作业必须使用原先冻结的运行版本；不能改写旧身份记录使其被新代码接受。新包不维护第二份旧实现。

## 开发检查

命令参数解析和模块执行入口集中在 `cli/`。`runtime/`、`inference/` 和 `backends/` 只提供可导入的实现；它们可以启动明确的 CLI 子进程，但不导入 CLI 模块。上述内部子进程命令由控制器调用，不是替代配置、预算或所有权检查的旁路。边界检查禁止在实现目录加入 argparse 或模块执行分支。

内置离线 SFT 阶段显式绑定共享排序算法与离线数据 helper 的源文件；后端 bridge 身份也覆盖训练和算法包的实际源码。修改算法后不能复用旧阶段的结果。

```sh
python -m pip install -e './python[gateway]'
python -m pip install ruff mypy
python -m ruff check python/gear
python -m ruff format --check python/gear
(cd python && python -m mypy)
PYTHONPATH=python python -m unittest discover -s python/tests
```

基础 wheel 的无 GPU 导入、CPU loop 和真实子进程入口还由发布包旅程验证。后端 GPU 执行需要对应的固定环境，不以 CPU fake 结果代替。

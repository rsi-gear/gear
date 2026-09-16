# 模型训练 · 实验性

Gear 也可在固定 Harness 和数据集的条件下协调 Slime GRPO 模型更新。它使用独立于 Harness 进化的实验生命周期。

## 已实现内容

TypeScript controller 与 Python bridge 负责封存输入、保存精确 policy tokens、完整 checkpoint、不可变 HF 模型导出、Hitch/Harbor 评估和晋升记录。v2 controller 区分控制主机、Harbor worker 与模型节点。

现有实机认证覆盖远程 RTX 5090 单卡 Qwen2.5-1.5B，以及本地 Gear/Hitch/Harbor Docker，包括更新、恢复和推理。该记录未认证远程 Docker/Harbor 与双卡拓扑；独立评估 reward 为零，认证证明执行和恢复覆盖，不代表模型质量提升。

## 部署流程

1. 阅读 [controller v2](../../training/controller-v2.zh-CN.md)，确定真实控制端与节点拓扑。
2. 固定 runtime、模型、tokenizer、template、verifier、recipe，仅应用对应精确版本的补丁。
3. 运行部署 preflight、freeze deployment，导入并封存模型与数据。
4. validate、init 实验，再 admit 和 preflight 工作。
5. 重复调用 `advance`，直到 completed，或明确的 blocked/failed 需要处理。
6. 检查不可变模型评估结果，再显式发布或回滚。

```text
gear-refine training
```

裸命令用于显示参数校验/用法，不会开始训练。完整子命令参数和 JSON schema 见[训练指南](../../training/README.zh-CN.md)。`advance` 是一次协调步骤，不是后台计时器；Slime job 和 Hitch eval 有各自生命周期。

## 验证范围

CPU bridge/controller 测试不能认证 GPU 执行。`pending-gpu` runtime lock 不能提交正式训练。[单卡认证记录](../../training/certifications/2026-09-10-rtx5090-single-gpu/README.zh-CN.md)说明当时验证过的确切身份与恢复检查；代码或 runtime 改变后需要重新核验。

## CPU 开发测试

使用 Python 3.12 和仓库固定的测试依赖，它们与生产 GPU runtime lock 分开管理。在 Gear 仓库根目录运行：

```bash
python3.12 -m venv python/.venv
. python/.venv/bin/activate
python -m pip install './python[gateway]' -c python/constraints-test.txt
python -m pip install torch -c python/constraints-test.txt --index-url https://download.pytorch.org/whl/cpu
GEAR_TRAINING_TEST_PYTHON="$VIRTUAL_ENV/bin/python" npm run test:training
```

macOS 安装 Torch 时省略 `--index-url`。CI 的 `Training / CPU` 会运行 Python 测试。

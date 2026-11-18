# Skill 与 Meta 接入

操作员助手通过随包 `refine` Skill 或项目 API 管理实验，Python 算法决定要调用哪些算子。Meta 负责提案、反思或批评候选，Target 执行 benchmark 任务。Meta 与 Target 分别选择 profile，可以使用不同模型。

## Codex 通过 Hitch 执行

随包 `gear-meta-codex` 桥接按 **Gear → Hitch → Codex** 调用。Gear 负责输入授权、预算分配和结果校验；Hitch 负责 Codex 执行与隔离、模型代理、单次操作额度执行，以及持久回执、查询和取消。

用 `gear profile create NAME --kind codex --model YOUR_AVAILABLE_MODEL` 创建并选择 Meta profile。Meta 默认复用所选 Hitch Target profile 的 executable 和 root，也可通过 `configuration.hitch` 指定独立 Hitch。Hitch 必须声明 `isolated_agent_run: "1"` 与 `generation_budget: "1"`，不兼容的版本会在准入时被拒绝。具体见 [runner 配置](../../codex-meta-runner.zh-CN.md)和[生成与诊断预算](configuration.md#生成与诊断预算)。

Meta 只收到授权的任务输入、反馈和产物，不包含预期答案、held-out 数据或私有 journal；凭据保留在 Hitch 的可信执行侧。自定义 process provider 需要自行提供隔离与预算执行能力。

## Skill 与项目 socket

普通 CLI 不需要常驻服务。需要 socket 接入时：

```sh
gear serve --project /absolute/path/to/project --socket /tmp/gear-project.sock
gear --socket /tmp/gear-project.sock request run.refine '{"rounds":1}' --request-id first-round
```

原生 DSH 插件只配置项目位置：

```yaml
- id: refine
  name: rsi-gear
  config:
    projectRoot: /absolute/path/to/project
```

插件发布 `refine` Skill、`refine_request` 工具和 `/gear` 命令，全部调用 `ProjectController`。
例如自然语言要求“检查这个 benchmark，试跑一题 seed，然后运行一轮并解释报告”。

外部助手可安装 npm 包内完整 `skills/refine` 目录，并通过 CLI 或项目 socket 调用。
当前项目协议只有 benchmark/config/algorithm/run 方法，不接收原候选 lease 方法。

[七算法真实验证](algorithms.md#真实模型验证)已在十个 Marketing 任务上运行 Hitch/Codex Meta 和 Hitch/DSH Target。它验证记录中的配置和范围，不代表所有 provider 已验证，也不代表复现论文效果。中断和符合条件的失败反思使用 [Gear 恢复入口](evolutions.md)，复用已完成工作并查询原 Hitch 操作。

完整方法、请求 ID 和服务退出语义见[控制面参考](../../harness-agnostic-refine-skill.md)。

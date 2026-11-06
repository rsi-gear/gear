# Skill 与 Meta 接入

操作员助手通过随包 `refine` Skill 管理项目；执行候选生成的 Meta 由 `gear.yaml` 的 profile 选择。这两个角色可以使用不同模型。

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
随包 `gear-meta-codex` 已接入 operation 协议，并通过平台 sandbox 隔离候选副本和 seed 投影；支持持久 receipt、重复请求、取消和未知结果查询。配置与验证边界见 [Codex runner](../../codex-meta-runner.zh-CN.md)。任意自写 process profile 不会自动获得该隔离。真实模型认证与闭环仍待验证。

完整方法、请求 ID 和服务退出语义见[控制面参考](../../harness-agnostic-refine-skill.md)。

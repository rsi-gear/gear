# Harness-neutral Refine Skill 与独立控制面

## 项目控制面（重构分支）

当前 `gear serve --project DIRECTORY [--socket PATH]` 加载项目的 `gear.yaml`，通过
`ProjectController` 调用与普通 CLI 和 Python SDK 相同的应用服务。省略 socket 时使用
项目内 `.gear/control.sock`。原生 DSH 插件也装配同一控制面；旧 `serve --config`、
`control.start`、`meta.claim` 和候选 lease API 不再属于公开入口。

普通任务仍直接运行 `gear evaluate` / `gear refine`；常驻服务是部署选项。
程序化客户端使用以下方法，未知字段会报错：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `benchmark.check` | `{}` | 静态、fixture 检查及分区 |
| `benchmark.preview` | `task_id` | 任务及评分器预览（操作员入口） |
| `algorithm.test` | 可选 `entrypoint` | 离线算法合同测试 |
| `config.explain` | `{}` | 配置值及来源 |
| `run.evaluate` | `split`，可选 `limit` | 已持久化的 run ID，随后后台执行 |
| `run.plan` | 与 `run.refine` 相同 | 只读预览任务范围、已核验 baseline 复用、限制与提示，不创建 run 或调用模型 |
| `run.refine` | 可选 `rounds`、算法描述与源码依赖 | 已持久化的 run ID 与封存 plan，随后后台执行 |
| `run.resume` | `run_id` | 恢复现有运行，随后后台执行 |
| `run.cancel` | `run_id` | 持久化取消请求 |
| `run.report` | 可选 `run_id` | 与 CLI/SDK 相同的持久报告 |
| `run.archive` | `run_id` | 独立 seed 研究档案、Python 比较视图和当时的父代/排名记录 |
| `run.export` | `run_id` | 已完成运行的不可变导出 |

`run.evaluate` / `run.refine` 的请求 ID 是 admission 幂等键。相同项目、相同 ID 和
相同参数返回同一个运行；换参数或操作类型会返回 `admission-conflict`。丢失回复后应
重用请求 ID；发生执行故障后使用 `run.resume`，不能通过重复创建请求隐式重启。

`run.plan` 不是预算预约；admission 会重新检查输入。普通 CLI 在执行前展示封存计划，
`--json` 保持单个结构化响应。仅预览可用 `gear refine --dry-run --json` 或 Python
`Project.plan_refine()` / `await Project.aplan_refine()`。计划只含 seed ID 与 held-out
数量，不包含私有任务内容。单题 smoke 只能复用同一槽位，历史费用单列于
`baseline_reuse`，不占新 run 预算。用户已授权执行时，预览无需增加一次审批。

例如：

```sh
gear serve --project ./my-benchmark --socket /tmp/gear-project.sock
# 另一个进程中；重试仍使用 smoke-01
gear --socket /tmp/gear-project.sock request run.evaluate '{"split":"seed","limit":1}' --request-id smoke-01
gear --socket /tmp/gear-project.sock request run.report '{}'
```

取消与服务停止有不同语义：`run.cancel` 取消执行端任务；服务退出会中断本地等待并
保留可恢复状态。恢复先检查已提交任务，不能把未知结果当成未提交。客户端断开不
取消已接收的运行。socket 为 owner-only，活跃服务持有内核锁，第二个服务不能替换它。
失败原因写入运行 journal，重启控制面后仍可查询，成功恢复会清除该失败状态。

## 原生 DSH 入口

在 DSH composition 启用包内插件，配置只包含项目根目录和可选 socket：

```yaml
- id: refine
  name: rsi-gear
  config:
    projectRoot: /absolute/path/to/my-benchmark
```

插件发布同一随包 `refine` Skill，注册 `refine_request` 工具和 `/gear` 命令。
自然语言助手可调用 `run.refine`，也可以输入 `/gear refine --rounds 1`。
工具的 `request_id` 用于显式重试；省略时使用宿主 agent/call 身份。
操作员模型和执行生成的 Meta profile 是两个独立角色。

## 程序化入口与算法

npm 根入口提供 `ProjectApplication`、`ProjectController` 和
`createProjectControlPlane`。`rsi-gear/skill` 提供 socket 客户端、服务端、
原生 Skill 挂载和相同的项目控制面工厂。TS 的 search/worker/testing 扩展
子路径已撤销；算法统一从 Python `gear.algorithms` 使用，见
[算法开发索引](search-algorithm-authoring.zh-CN.md)。

外部执行 provider 使用 `OperationProvider` 的 describe/submit/inspect/cancel
合同；生成结果仍由 core 检查和封存。[随包 Codex runner](codex-meta-runner.zh-CN.md)
已实现项目协议与 OS 隔离；setup/doctor 的认证检查尚在完善，当前进度见 [实施记录](refactor-progress.zh-CN.md)。
原 lease 设计保存在 [设计档案](design/retired-control-plane.zh-CN.md)，不是当前接入教程。

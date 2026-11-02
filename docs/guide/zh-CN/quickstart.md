# 快速开始

本页使用 Gear 0.2.2 的 `gear` CLI。需要兼容 Node（22.19+ 的 22 系列或 24+）、Python 3.10+；开发和 CPU 测试使用 Python 3.12。Linux 的算法隔离还需要 bubblewrap、socat、ripgrep；macOS 使用系统隔离机制。Hitch/Harbor 任务另需其运行环境及 Docker。

## 安装当前工作树的包

```sh
npm ci
npm pack
npm install --global ./rsi-gear-0.2.2.tgz
gear setup --python python3.12
gear doctor
```

`setup` 在新目录安装并验证 Python worker，再切换受管理环境；失败时保留原环境。
终端交互模式继续引导创建或选择 Target/Meta profile；`--json` 使用非交互模式。
准备 Hitch/Harbor 与 Docker 镜像时使用 `gear setup --hitch --target dsh --python python3.12 --json`；
Pi 改为 `--target pi`。此步骤会下载固定版本的 harness、Harbor 和镜像并启动 Hitch daemon，
需要预先安装 Hitch、Docker 及平台隔离工具。安装本身不执行模型调用。

## 创建并检查 benchmark

```sh
gear init my-benchmark --target dsh
cd my-benchmark
gear benchmark check
gear benchmark preview sum-01
gear algorithm test gepa
```

选择 Pi 时将 `--target dsh` 改为 `--target pi`；文件产物模板使用 `--template files`。
编辑 `tasks.csv` 和 `benchmark.yaml`，替换演示任务。检查及离线算法测试不调用模型。
`benchmark.preview` 是作者检查评分规则的入口，不把其私有 expected 交给 Meta。

## 配置执行并试跑

用自己的模型名创建两个 profile；环境变量名必须对应所选 Target provider 接受的凭据：

```sh
gear profile create default-target --kind hitch --adapter dsh --model YOUR_TARGET_MODEL --pass-env OPENAI_API_KEY
gear profile create default-meta --kind codex --model YOUR_META_MODEL
gear profile use default-target --role target
gear profile use default-meta --role meta
gear doctor
```

创建 Hitch profile 会把本地 Docker 镜像标签解析为不可变摘要；缺少镜像时提示 setup。
Codex 默认引用 `CODEX_API_KEY`；已有文件登录可用 `--auth-home /path/to/codex-home`。
命令只接收凭据变量名或认证目录，不接收密钥值。详见[配置参考](configuration.md)。
`doctor` 分开报告依赖、能力和本地认证来源；`ready_for_seed_smoke` 只表示可以尝试单题运行。
`model_access: not_checked` 不代表远端授权已通过，须继续实际试跑：

```sh
gear evaluate --split seed --limit 1
gear refine --rounds 1 --dry-run
gear refine --rounds 1
gear report
```

评测返回 run ID；报告区分有效零分、评分失败、环境失败和物理执行次数。演示数据只用来检查流程，不能支持效果结论。
`--dry-run` 检查任务范围、重复数、预算和可复用 baseline，不创建 run 或执行模型。正式 `refine` 在首次执行前展示封存计划；单题 smoke 只抵扣条件一致的那个 seed 槽位。Python 中使用 `Project.open().plan_refine(rounds=1)`，异步对应 `aplan_refine()`。计划不是预约，正式开始时会重新检查输入。
恢复和导出见[运行管理](evolutions.md)。普通 CLI 无需手动启动 socket server；自然语言入口见[Skill 接入](meta-agents.md)。

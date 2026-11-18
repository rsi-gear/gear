# 快速开始

本页使用 Gear 0.2.4 的 `gear` CLI。需要兼容 Node（22.19+ 的 22 系列或 24+）、Python 3.10+；开发和 CPU 测试使用 Python 3.12。Linux 的算法隔离还需要 bubblewrap、socat、ripgrep；macOS 使用系统隔离机制。Hitch/Harbor 任务另需其运行环境及 Docker。

## 安装当前工作树的包

```sh
npm ci
npm pack
npm install --global ./rsi-gear-0.2.4.tgz
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install ./python
gear setup --python python3.12
gear doctor
```

这些命令在 Gear 源码根目录执行。激活的 `.venv` 用于运行下文的 Python SDK 示例；`gear setup` 管理执行 worker 的环境。安装包和 SDK 应来自同一份源码。Codex Meta 需要 Hitch 声明 `isolated_agent_run: "1"` 与 `generation_budget: "1"`；`gear doctor` 会检查能力，具体配置见[Meta 接入](meta-agents.md)。

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
gear report
```

评测返回 run ID；报告区分有效零分、评分失败、环境失败和物理执行次数。演示数据只用来检查流程，不能支持效果结论。

## 选择算法并运行

在项目目录中保存并运行以下 Python 示例。先在 `gear.yaml` 中按[配置参考](configuration.md#生成与诊断预算)设置 Meta 请求数/token 上限与目标评测预算，再选择一个[算法](algorithms.md)：

```python
from gear import Project
from gear.algorithms import OPRO

project = Project.open(".")
recipe = OPRO(prompt_path="prompts/system.md")
print(project.plan_refine(algorithm=recipe, rounds=2))
run = project.refine(algorithm=recipe, rounds=2)
print(run.id)
print(run.report.summary)
```

Pi 使用 `OPRO(prompt_path="AGENTS.md")`。将 recipe 换成其他算法即可复用项目配置；Harness2 还需[显式任务顺序和 blind 访问](algorithms.md#harness2)。Notebook 使用 `await project.aplan_refine(...)` 和 `await project.arefine(...)`。

预览检查任务范围、重复数、预算和可复用 baseline，不创建 run 或调用模型。正式准入会重新检查输入；预览不是预算预约。单题 smoke 只抵扣条件匹配的那个 seed 槽位。`rounds=2` 是轮数上限，预算不足可能提前结束，需在[报告](results.md)中确认实际完成情况。

CLI 默认使用项目配置的算法；`gear refine --rounds 2 --dry-run` 对应预览，`gear refine --rounds 2` 开始运行。两条路径调用同一个项目服务。

恢复和导出见[运行管理](evolutions.md)。普通 CLI 无需手动启动 socket server；自然语言入口见[Skill 接入](meta-agents.md)。

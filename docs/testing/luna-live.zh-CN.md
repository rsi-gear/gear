# Luna 真实模型验收

2026-10-12 按用户指定，使用现有本机登录测试 Luna。实际可调用的是
`gpt-5.6-luna`；`gpt-6-luna` 被本次登录对应的服务端明确拒绝。以下为小型合同验收，
不代表完整 benchmark 或统计显著的算法效果。

## 固定运行组合

| 部分 | 本次配置 |
| --- | --- |
| Gear | `codex/project-refactor` 当前未提交源码，Python 3.12.13、Node 26.7.0 |
| Meta | 独立 Codex CLI 0.145.0，`gpt-5.6-luna`，low reasoning，180 秒生成期限 |
| Target | Hitch 0.2.16；DSH 0.1.5-rc.3 / Pi 0.84.1；`openai-codex/gpt-5.6-luna` |
| 容器 | Docker Desktop ARM64 宿主，实际任务使用 `linux/amd64` 镜像和 Target artifact |
| 评分 | Gear text 模板的独立 verifier，实际答案文件与精确匹配规则 |
| 修复重试 | 关闭；失败探针单独保留，没有将重试失败计成模型零分 |

Python 基础镜像固定为
`mirror.gcr.io/library/python@sha256:2f2e5a876c71a6757f55ec57f2add0225ddaf01c802a33fcc29073943f94d907`。
Target 通过 Hitch 公开 artifact API 准备，实际目录和入口摘要进入身份；没有修改缓存依赖。
准备报告为 `/tmp/gear-luna-live-artifacts-1/report.json`。

使用独立临时 HOME、profiles、项目和自有 Hitch daemon。本机 OAuth 的 access token
由 host credential helper 按需提供，核对剩余有效期；Target 不接收 refresh token
或完整认证文件。Meta 复制现有认证到单次沙箱并清理。报告不保存认证值。

## Target 接入

Pi 在 `.pi/extensions/luna.ts` 中通过 `registerProvider` 注册
`openai-codex`，使用 `openai-codex-responses` API、
`https://chatgpt.com/backend-api` 和环境变量形式的 apiKey。
测试模型目录的价格字段仅为运行占位值，不作为真实费用证据。

DSH 使用其发布产物自带的 `llm-pi-ai` 插件，通过 Target 的原生插件调用
`settings.update('llm-pi-ai', ...)`，设置 `openai-codex` provider 的
`baseURL`、`apiKeyEnv`、`transport: 'sse'`、`reasoning: 'low'` 和模型目录。
这里不覆盖内置 provider 的 API 字段；DSH 所带 pi-ai 0.85.1 的 API 合同
与 Pi CLI 0.84.1 不同。测试配置在 `preset/agent.cordis.yml` 加载该插件。
这些设置属于 Target 原生资源，没有新增通用搜索中的 Harness 特例。

## 实际结果

| 场景 | 结果 | 本机证据 |
| --- | --- | --- |
| Pi 单题 Target | 1 次物理执行，1 条有效证据，0 条无效，得分 1 | `/tmp/gear-luna-hitch-live-4/pi-report.json` |
| DSH 单题 Target | 1 次物理执行，1 条有效证据，0 条无效，得分 1 | `/tmp/gear-luna-hitch-live-8/dsh-report.json` |
| Pi Python GEPA 一轮 | 基线 seed/held-out 均为 0，候选均为 1，独立 gate accepted | `/tmp/gear-luna-gepa-live-1/refined-report.json` |
| DSH Python GEPA 一轮 | 基线 seed/held-out 均为 0，候选均为 1，独立 gate accepted | `/tmp/gear-luna-gepa-dsh-live-1/refined-report.json` |
| DSH Meta 生成与重复提交 | 真实生成完成；重连 inspect、同 operation 再 submit 返回原回执，事件文件不增长 | `/tmp/gear-luna-meta-live-1/report.json` |

两个单题 Target 场景只是 smoke，不视为完整 baseline。
GEPA 场景使用两题：seed 为算术题，held-out 为大小写转换题；原规则刻意要求给
答案增加 `RESULT: ` 前缀。Pi 的真实 Meta 诊断和生成将规则改为允许精确输出任务
省略前缀。Python GEPA 保存了父代、提案、评测和提名决策，运行层执行独立留出集 gate。

Pi 的独立 baseline 为 `run_b66f0161faa440d29e78e0e08207d066`；refine 为
`run_51f5944aebe048e896ada3cbd0e2f7a4`。预览与正式运行均复用原 seed 槽位，
新 baseline 执行数为 0，保留 1 次历史用量；refine 新执行 3 次，覆盖候选 seed
及 anchor/candidate held-out。最终 4 个逻辑槽位均有效，无重试和无效证据。
诊断与生成 token 合计 103746；请求数和费用未得到完整计量，继续为 `null`。

DSH 使用相同的任务数据与算法配置：benchmark 摘要和 Python 实现身份均与 Pi 一致。
它的 baseline 为 `run_e9381aeb0f314ac4b3943e15cf444acd`，refine 为
`run_a97213b7c26443079aa3a5052e8eba28`。实际修改仅在 `prompts/system.md`；
同样复用 1 次 seed 基线、增加 3 次执行，4 个逻辑槽位均有效，独立 gate accepted。
诊断与生成 token 合计 102638，请求数和费用为 `null`。两套运行均已结束，自有 daemon
退出；没有为了得到通过结果重新提交失败操作。

## 接入修复与回归

- macOS `/etc` 别名下的不存在文件按 ENOENT 处理，避免被沙箱错误拒绝。
- Codex 身份包含可选 code-mode companion 与 macOS 系统 CA PEM；沙箱继续校验证书。
- 原生 Meta transport 等待期限为生成期限加 30 秒；关闭 Meta 子进程的应用连接和插件。
- worker 写完回执并释放锁的竞态中，调用方再次检查回执，避免把已完成操作误报为 unknown。
- Hitch benchmark 编译使用临时根下尚不存在的 dataset 子目录，匹配 Python 编译器的创建合同。

相关五个测试文件 47 项通过、2 项跳过；之后的回执竞态修复另经 24 项 Codex operation
回归。最终全量 TS 回归 127 个文件通过、4 个文件跳过，1601 项通过、31 项跳过，
日志 `/tmp/gear-luna-ts-all.log`。类型、lint、格式、TS/Python 依赖边界和生成合同通过；
Python Ruff 检查与 140 个文件的格式检查通过，mypy 的 38 个公开类型检查文件通过。
独立 npm/wheel 安装旅程通过，包含 CLI/SDK、CPU training、DSH/Pi 离线流程、
取消恢复、真实 Hitch 只读条件检查与 OS sandbox，日志 `/tmp/gear-luna-package.log`。
Python 实现本轮没有改动，未重复此前的 Python 全量单测；基础 wheel 和 CPU 旅程已重跑。

## 范围与重跑

真实 Meta 探针的显式运行方式见 [Codex Meta runner](../codex-meta-runner.zh-CN.md#验证边界)。
完整运行的临时驱动、profile、私有 journal 和回执保留在上述本机目录中；这些绝对路径
是本次证据位置，不是发布包依赖。驱动启动的 daemon 和任务容器在结束后清理。

本次固定环境中实际验证了跨 run baseline 复用，但没有关闭
[R1 的全部执行条件边界](../refactor-acceptance.zh-CN.md#r1实际执行条件仍有未封闭边界)：
公共观测仍不包含 daemon 模型端点环境、完整 Harbor 依赖闭包和已加载模块；
不能把本次成功推广为任意 daemon/端点变化下均可安全复用。

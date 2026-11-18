# Codex Meta operation runner

`gear-meta-codex` 是 Gear 到 Hitch 的 Meta 协议桥接，执行 `diagnose_seed` 和
`generate_candidate`。Gear 负责输入授权、额度分配和结果校验；Hitch 负责 Codex 执行、隔离、模型代理和逐请求预算。父代选择、抽样、候选计划、排名与停止由 Python 算法决定。
原 Codex lease runner 和 MCP transport 已移出发布包，只保留为历史协议回归 fixture。

每次 Meta 操作绑定独立 seed 经验快照与最多三张卡片。`input.json` 中的
`experience.reader` 给出只读查询程序的 argv 和 JSON 请求示例；程序与数据从已校验的
冻结源码/快照复制到当前沙箱，不挂载私有状态目录。分类、排序、匹配和分页均由 Python
执行，恢复沿用已提交的快照；缺失/失败结果不会当作零分或无改进。完整协议见
[Project operation protocol](../skills/refine/references/protocol.md)。若快照有已捕获的 Hitch 来源，
`experience.reader.trajectory` 提供历史内容读取示例。读取通过当前操作专用的 UNIX socket，
只允许快照中的 source ref，不能传宿主路径、run ID 或调用 Project 控制方法。
Hitch 私有根目录不挂载；每页最多 64 KiB、最多 50 个事件，每个操作最多 256 次读取，
并发最多 4 次。操作完成或取消会关闭 socket 并中断正在读取的 provider 子进程。
无来源为 `not_captured`，捕获失败为 `unavailable`；canonical 页面明确不包含子会话，
不能据此推断修改资源未被使用。

`experience.reader.read` 的 `modification-use` 视图读取快照中已净化的逐试验观测，
包含 `observed`、`attempted-failure`、`not-observed` 和 `unknown`。匹配来自独立 Python
读取器校验过的 DSH 原生 main/child 文件及精确资源内容，不在 Meta 沙箱中读取原日志。
清单不完整、来源不支持或内容不匹配保持未知；动作示例有界且不带正文。
这些观测只说明读取/注入，不能证明修改导致结果变化。

`experience.reader.read` 也提供 `verifier` 视图，读取父本与候选已冻结的任务得分、独立过程组件和公开反馈。每个试验最多 16 KiB，组件与反馈包含省略计数；原始 verifier result、diagnostics 和私有引用不会复制到 Meta 沙箱。失败代码只是待验证假设，不能据此声称根因或绕过 objective/晋级条件。缺失、不支持或无效来源保持明确状态。

## 配置

使用公开命令创建 profile；runner 路径由当前安装包决定，无需手写路径：

```sh
gear profile create default-meta --kind codex --model YOUR_AVAILABLE_MODEL
gear profile use default-meta --role meta --default
```

`--executable /absolute/path/to/codex` 可指定独立 Codex 二进制；不传时从 PATH 查找。
交互终端运行 `gear profile create default-meta` 会询问模型和认证来源。
保存到 `~/.config/gear/profiles/default-meta.json` 的配置如下：

```json
{
  "kind": "codex",
  "passEnv": ["CODEX_API_KEY"],
  "configuration": {
    "executable": "/absolute/path/to/codex",
    "model": "YOUR_AVAILABLE_MODEL",
    "allowedDomains": ["api.openai.com", "chatgpt.com", "auth.openai.com"],
    "timeoutMs": 600000
  }
}
```

Meta 默认复用所选 Hitch Target profile 的 executable/root；也可在 `configuration` 中显式设置：

```json
{"hitch": {"executable": "/absolute/path/to/hitch", "root": "/absolute/path/to/meta-hitch-state"}}
```

Hitch 必须声明 `isolated_agent_run: "1"` 和 `generation_budget: "1"`。不支持时准入失败，不回退为 Gear 直接启动 Codex。`kind: "codex"` 保留为模型配置入口，执行统一经过 Hitch。

模型名来自用户实际可用的模型，runner 不设置默认模型。`reasoningEffort` 可选。
API key 通过 provider 进程环境传递，不写入 profile 或 operation journal。
`CODEX_API_KEY` 是 Codex 非交互执行支持的认证入口，见
[官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)。

已有文件认证可改为 `passEnv: []`，并设置 `configuration.authHome` 为包含 `auth.json`
的绝对目录。Hitch 读取此文件并把认证保留在可信模型代理中；模型进程的临时 CODEX_HOME 不包含真实凭据。
当前不支持从系统 keychain 提取凭据，也不把临时刷新后的凭据写回原文件；长期运行前需
自行维护有效登录。登录方式对应的网络域名须显式写入 `allowedDomains`，不接受通配域名。
模型只可访问本次 Hitch 网关；网关仅连接认证对应且已授权的模型服务域名。握手本身不验证登录或模型可用性。

`gear.yaml` 引用 `meta: {profile: default-meta}`。Target 仍需独立配置评测 provider。
`gear doctor` 检查实际二进制、能力、隔离进程及 profile 引用的认证来源。
环境变量认证只报告变量存在；文件认证把同一 `auth.json` 复制到临时目录后执行
`codex login status`，只保留退出状态，不输出凭据或 CLI 诊断。该命令成功表示本地凭据存在，
不是远端模型访问已验证，见[官方 CLI 登录说明](https://learn.chatgpt.com/docs/developer-commands)。
`model_access: not_checked` 和 `benchmark: not_run` 明确保留；模型能力以实际试跑为准。
`OPENAI_API_KEY` 若被显式列入 `passEnv`，runner 会映射为非交互 `CODEX_API_KEY`。

## 执行与隔离

- 新运行准入先初始化私有作业登记表；Node controller 在表中保存 operation intent，再启动独立 worker。模型启动也先登记，每个 operation 有自己的内核锁。原生 process 调用期限为生成期限加 30 秒（最多 24 小时），为终止和保存回执留出时间。
- Gear 向 Hitch 提交精确授权路径，Hitch 只向 Codex 挂载候选副本、指定 seed 任务与反馈、必要系统运行库和临时目录。
  完整项目、原候选目录、其他 operation 日志及 held-out 数据不在读取范围内。
- diagnosis 的候选目录只读；generation 可以修改副本。结果发布前校验资源类型、mutation
  policy 和 HarnessAdapter；core 随后重新验证父代、绑定候选 ID 并封存 manifest。
- 整个 Codex 进程及其工具在平台 sandbox 中执行。Codex 内层 sandbox 使用外部隔离模式，
  不依赖提示词限制文件读取；平台不支持时执行失败。当前面向 macOS/Linux。应用连接和插件功能在 Meta 子进程中关闭；生成仅使用本次操作给出的素材和工具。
- 每次使用独立 CODEX_HOME、`--ephemeral`、`--ignore-user-config`、`--ignore-rules` 和
  输出 JSON Schema；关闭自动读取候选 AGENTS 作为项目指令，候选规则通过任务数据阅读。
  相关设置见[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
- identity 绑定 Hitch 实际控制器运行时、隔离/预算能力以及实际 Codex 二进制、相邻的可选 `codex-code-mode-host`、版本、Node 版本及 runner 源码。macOS 另外绑定系统 `/etc/ssl/cert.pem`，供严格沙箱内的 TLS 校验使用，不开放额外 trustd IPC 或关闭证书校验。握手后替换二进制会拒绝
  提交；worker 开始前再次核对身份。运行中的文件替换仍需通过既有运行目录权限防护。

普通 process profile 属于受信执行适配器；任意用户自写 process 命令不会自动获得上述
隔离。该保证由 Hitch 的隔离执行实现；Gear 校验其能力和冻结身份。

## 恢复和诊断

运行级登记表位于 `.gear/runs/<run_id>/providers/codex/operations.json`，记录原配置身份、每个 operation 的输入摘要及 admitted/started/fenced 状态。它只在新运行准入创建；describe 保持只读，恢复不会重建缺失登记表。

单个作业的日志位于 `.gear/runs/<run_id>/providers/codex/<operation_digest>/`：

| 文件 | 用途 |
| --- | --- |
| `job.json` | 已绑定输入和实现身份；不含 API key 值 |
| `started.json` | worker 已获得执行权；PID 仅供诊断，所有权以内核锁为准 |
| `receipt.json` | 模型已确认停止且结果完成校验后的不可变结果、token 用量及来源；可以先于清理完成出现 |
| `cleanup-started.json` / `cleanup.json` | 私有清理进度与逐项结果；不混入模型结果或算法证据 |
| `events.jsonl` / `stderr.log` | 操作者私有诊断，不投影给后续 Meta/算法 |
| `cancel.json` | 取消记录，阻止同一 operation 后续重新启动模型 |

调用方超时或断连不停止 worker；`inspect` 可以找回持久化结果。显式取消会停止所拥有的
模型进程，并保存失败 receipt。worker 被强杀时，独立守护进程通过控制管道关闭而终止
模型进程；无 receipt 的操作返回 `unknown`，不会凭 PID 猜测或自动重发。需要人工调查
未知操作时，保留原 journal，不删除 intent 后重复计费。

执行结果与清理状态分别持久化。守护进程保留模型组 leader 的 PID，先终止同组遗留子进程、再回收 leader，并通过模型无法继承的专用管道确认；缺少确认时不发布 receipt，状态保持 `unknown`。macOS 对只剩 zombie 的进程组可能返回 `EPERM`，此时只有在有界的进程组状态检查确认全部成员已停止后才接受确认。

Hitch 负责模型组、临时 CODEX_HOME、模型代理与隔离资源的关闭。Gear worker 保持到 Hitch 的控制管道；worker 丢失时，Hitch 收到 EOF 后取消执行。Gear 只接受 Hitch 的 `execution.stopped: true` 回执；Hitch 被强杀或缺少停止确认时，操作保持 `unknown`、不发布结果、不自动重发，原预算预留保持占用。Gear 独立清理自己暂存的授权素材和经验读取器，临时根目录仅在模型已确认停止后删除。

## 请求和 token 预算

`generationBudget: true` 的依据是 Hitch 的逐请求代理，不是 Codex 轮次事件。每个实际 Responses 请求（包括客户端重试）在转发前占用 `model_requests`，并按剩余额度限制 `max_output_tokens`。`tokens` 包含实际输入和输出；缓存输入已包含在输入中，推理已包含在输出中，不重复相加。Meta 不执行 Target 评测，`physicalAttempts` 为 0；美元硬预算不支持。

输入预留采用文本 UTF-8 字节上界并额外预留协议开销；额度不足时可能在实际 token 数达到上限前停止。仅支持可计量的文本输入和客户端工具；服务端工具、图像/文件、外部 response 引用和未计量的加密推理会在转发前拒绝。加密推理仅可复用当前网关已测量过的响应。隐式压缩不能绕过网关。缺失、截断或矛盾的 usage 会阻止后续请求，未知 token 保持 `null`，Gear 保留相应预算。超限实际值保留用于审计，不截断为限额。

Gear receipt 的 `provenance` 包含 `provider: "hitch"`、`harness: "codex"` 和 `hitch_run_id`。Hitch 在 `runs/<hitch_run_id>/generation-budget.json` 保存额度和逐请求账本，并保留标准 interactions、trajectory 和 result。Gear 的私有 `events.jsonl` 保存 Hitch 终态 JSON，模型原生事件由 Hitch 保存。

显式上游代理仍通过 `passEnv` 的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 传给 Hitch，不交给模型。该路径使用 Node 内置代理支持，要求 Node 22.21+ 或 24.5+；不支持时明确失败。

## 验证边界

Gear 的协议 fixture 覆盖授权素材、Python 结果 schema、DSH/Pi 候选发布、重复提交、断连恢复、取消和未知状态。实际 OS 隔离、模型进程守护、逐请求预算和上游计量由 Hitch 测试验证。真实模型探针同时检查候选变更、Hitch 来源、请求/token 限额和回执重放；它使用合成 seed 反馈，不代替真实任务评测。

显式运行真实模型探针（会调用模型；输出目录必须不存在）：

```sh
GEAR_TEST_CODEX=/absolute/path/to/codex \
GEAR_TEST_CODEX_MODEL=gpt-5.6-luna \
GEAR_TEST_CODEX_AUTH_HOME=/absolute/path/to/auth-home \
GEAR_TEST_HITCH=/absolute/path/to/hitch \
GEAR_TEST_HITCH_ROOT=/absolute/path/to/meta-hitch-state \
GEAR_TEST_LIVE_OUTPUT=/tmp/gear-codex-live-proof \
node scripts/check-codex-live.mjs
```

先构建 Gear 和支持上述能力的 Hitch；`auth-home` 包含现有 `auth.json`。默认分别测试 DSH/Pi，可用 `GEAR_TEST_LIVE_ADAPTERS=dsh` 选择一个。证据目录保留私有回执与操作日志，不复制认证文件。桌面 App 内部二进制可能缺少相邻配套程序；本次使用独立安装的 CLI。

取消回包中的 `cancelled: true` 表示已确认停止或被持久化取消记录阻止启动，不能仅表示收到请求。已经启动的 Codex worker 必须写入 receipt 并释放执行锁后才确认取消；worker 丢失且没有 receipt 时返回未确认错误，保持可见的恢复状态。外部 process provider 缺少明确确认、返回 false 或非布尔字段时，也不会被视为取消完成。

运行准入同时保存私有取消连接快照。重启后的取消恢复不重新 describe Codex，而是保留原 configuration、context、request 与 implementation identity 调用 `cancel`；因此模型可执行文件丢失也不会阻止停止已启动的 worker。此路径不运行算法或生成新候选；当前基础 runner 仍需可执行。丢失登记表、作业文件、作业目录或整个控制目录时，inspect 返回 `unknown`，提交与取消不会把缺失状态当成从未启动；需保留原记录并调查恢复。丢失启动标记也不能绕过登记表重启模型，取消必须等待原结果和执行锁释放。实际 OS 进程故障注入覆盖了这些场景；这不代表能够自动修复丢失的数据。

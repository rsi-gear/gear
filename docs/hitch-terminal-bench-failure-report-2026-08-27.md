# Hitch × DSH × Harbor：Terminal-Bench 运行故障报告

- 状态：可提交给 Hitch 开发者
- 日期：2026-08-27
- Gear HEAD：`78631f7660a9f5b7c822f61c3737ea7bec1ecad9`（运行时使用本地 worktree build）
- agent-hitch：`0.2.0`
- DSH：`0.1.0-rc.8`
- Harbor：`0.21.0`
- Target Harness commit：`e244535673114f07b30f2ba5c694ee9b2db834b1`

## 1. 摘要

在一次 30 个 Terminal-Bench 2.0 train tasks 的 baseline 评测中，Harbor 完成了全部 30 个 trial，但 Gear 最终只得到 18 个有效 observation，另外 12 个被标记为 `infrastructure_failure`，因此 evolution 在生成 candidate 之前终止。

本次运行确认了两个 Hitch 侧的框架缺陷：

1. **DeepSeek adapter 直接把 prompt 放入 argv；当 prompt 以 `-` 开头时，DSH/Commander 会把它解析为选项。**
2. **Harbor bridge 读取 Hitch `result.json` 时没有可靠处理文件缺失、空白 stdout 和非法 JSON，导致二次 `JSONDecodeError` 掩盖原始失败。**

其余异常包括 agent timeout 和 Terminal-Bench verifier timeout。它们是重要运行发现，但现有证据不足以把它们认定为 Hitch 实现 bug：agent timeout 符合配置的 900 秒预算，verifier timeout 则发生在任务自带、依赖外部网络的 verifier 中。

## 2. 运行背景

### 2.1 实验身份

```text
evolution_id: 4e661f2b-bf97-4ee7-8e6c-1ee49315f0c5
round_id:     c75411e8-7117-4f9f-a22d-bc6f507783b2
eval_id:      eval_6a60e80ec30340e59bda62847267e5fc
partition:    train
tasks:        30
attempts:     1
concurrency:  4
model:        deepseek-official/deepseek-v4-flash
agent timeout: 900000 ms
```

Harbor 总运行时间为 `1h 20m 47s`。Harbor 的原始汇总为：

```text
30/30 trials finished
reward 1.0: 16
reward 0.0: 3
exceptions: 12
reported mean: 0.533
```

其中一个 exception 同时留下了 `reward=0`，所以 reward 计数和 exception 计数存在一条重叠记录。Gear 按 run-centered evidence 校验后得到：

```text
valid observations:   18
invalid observations: 12
```

Gear 没有把基础设施异常静默当成正常零分，而是终止本轮。这一 fail-closed 行为符合当前 Gear/Hitch 集成合同；本文重点讨论产生无效 observation 的底层原因。

## 3. 故障总表

| 任务 | 直接错误 | 当前归因 |
| --- | --- | --- |
| `pytorch-model-recovery` | `unknown option '- You are given ...'` | **确认：Hitch DeepSeek adapter bug** |
| `prove-plus-comm` | `JSONDecodeError: Expecting value` | **确认：Hitch Harbor bridge 健壮性 bug；原始失败仍被掩盖** |
| `code-from-image` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `compile-compcert` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `extract-moves-from-video` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `feal-linear-cryptanalysis` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `gpt2-codegolf` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `make-doom-for-mips` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `mcmc-sampling-stan` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `path-tracing-reverse` | Hitch run timed out | 预算耗尽，不足以认定框架 bug |
| `qemu-alpine-ssh` | Harbor `AgentTimeoutError` at 930 s | 外层 agent timeout，不足以认定框架 bug |
| `filter-js-from-html` | verifier timed out after 1800 s | Terminal-Bench verifier/网络依赖问题 |

## 4. Bug 1：以 `-` 开头的 prompt 被解析为 DSH 选项

### 4.1 现象

`pytorch-model-recovery/instruction.md` 的第一个字符是 `-`：

```text
- You are given a PyTorch state dictionary (/app/weights.pt) ...
```

trial 启动后立即失败，Hitch event 中出现：

```text
error: unknown option '- You are given a PyTorch state dictionary ...'
run.failed: agent exited with code 1
```

这不是模型回答错误，也不是任务 verifier 失败；DSH agent 尚未真正开始执行任务。

### 4.2 根因

Hitch 的 DeepSeek adapter 构造如下 argv：

```js
const args = ["--profile", "headless", ...request.agent_args]
args.push("--patch", patchFile)
args.push(request.prompt)
```

对应当前安装包：

```text
agent-hitch/dist/src/adapters.js:327-330
```

DSH headless 使用 Commander，并把任务声明成 `[task...]` positional argument。由于 argv 中没有 `--` 终止选项解析，任何以 `-`、`--help` 或其他 option-like token 开头的合法任务文本，都可能被 Commander 当成命令选项。

因此该 bug 与 prompt 内容语义无关，是 adapter 的 argv 编码不完备。

### 4.3 最小复现

任何以连字符开头的任务都可触发：

```text
prompt = "- reproduce this issue"
```

DeepSeek adapter 产生：

```text
dsh --profile headless --patch <patch-file> - reproduce this issue
```

DSH 把 `- reproduce this issue` 解析成未知选项。

### 4.4 建议修复

最小修复是在 positional prompt 前加入标准的 option terminator：

```js
args.push("--patch", patchFile)
args.push("--", request.prompt)
```

如果 DSH 后续提供 `--prompt-file` 或 stdin 协议，使用文件/stdin 会更稳健，也能避免超长 argv；但修复当前 bug 不需要等待新协议。

### 4.5 建议测试

DeepSeek adapter 至少应覆盖：

```text
"- starts with a dash"
"--help"
"--patch attacker-controlled-value"
"normal task"
"multi-line\ntask"
```

验收条件：上述文本必须全部作为单个任务内容传给 DSH，不得影响 adapter 自己的 `--profile`、`--patch` 或其他选项。

## 5. Bug 2：缺失/空白 Hitch result 被二次解析为 JSON

### 5.1 现象

`prove-plus-comm` 的环境和 agent setup 正常完成，但 agent execution 约 0.5 秒后结束，没有产生可用的 Hitch run result：

```text
agent/hitch-result.json: 0 bytes
```

Harbor bridge 最终抛出的却是：

```text
JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

traceback 指向：

```text
integrations/harbor/hitch_harbor_agent.py:528
hitch_result = json.loads(result.stdout)
```

这个错误没有说明 Hitch result 为什么缺失，反而覆盖了更早的执行失败。

### 5.2 根因

当前实现通过 shell pipeline 读取 result 并复制日志：

```python
result = await environment.exec(
    f"cat {shlex.quote(result_path)} | tee /logs/agent/hitch-result.json"
)
if result.return_code == 0 and result.stdout:
    hitch_result = json.loads(result.stdout)
```

这里有三个问题：

1. `cat ... | tee ...` 没有显式启用 `pipefail`。如果 `cat` 因文件不存在而失败，pipeline 仍可能返回 `tee` 的成功退出码。
2. `result.stdout` 只做 truthy 判断，没有 `strip()`；仅包含换行或空白的字符串仍会进入 `json.loads()`。
3. 非法 JSON 没有被转换成包含 `run_id`、result path、退出码和 bounded stderr 的结构化 Hitch infrastructure error。

因此，`JSONDecodeError` 是 Harbor bridge 自己产生的二次错误。底层 result 为什么缺失尚未被可靠保留下来，需要修复错误传播后重新复现。

### 5.3 建议修复

建议不要依赖无 `pipefail` 的 `cat | tee` 来判断 result 是否存在。读取前显式验证：

```text
test -s <result-path>
```

或者让 environment API 直接读取文件，再单独复制 artifact。解析逻辑至少需要：

```python
payload = (result.stdout or "").strip()

if result.return_code != 0:
    raise HitchRunResultError("result file could not be read", ...)

if not payload:
    raise HitchRunResultError("result file is missing or empty", ...)

try:
    hitch_result = json.loads(payload)
except json.JSONDecodeError as error:
    raise HitchRunResultError("result file is not valid JSON", ...) from error
```

结构化错误应保留：

- `eval_id`
- `trial_id`
- expected `run_id`
- result path
- read command exit code
- Hitch process exit code/signal
- bounded stdout/stderr 摘要
- 已观察到的最后一个 Hitch event

### 5.4 建议测试

Harbor bridge 应覆盖以下 result read cases：

1. result 文件不存在；
2. result 文件大小为 0；
3. stdout 只有 `"\n"` 或空格；
4. JSON 被截断；
5. JSON schema 不完整；
6. `cat` 失败但 `tee` 成功；
7. 正常 result JSON。

验收条件：前六种情况都必须返回稳定、可机器识别的 infrastructure error，不能裸抛 `JSONDecodeError`，也不能丢失原始进程信息。

## 6. Agent timeout：运行发现，不作为已确认 Hitch bug

以下 8 个 trial 由 Hitch 在 900 秒预算到期时终止：

```text
code-from-image
compile-compcert
extract-moves-from-video
feal-linear-cryptanalysis
gpt2-codegolf
make-doom-for-mips
mcmc-sampling-stan
path-tracing-reverse
```

`qemu-alpine-ssh` 则由 Harbor 的 930 秒 agent timeout 终止。

这些 trial 在超时前均留下了 agent 输出，内容显示 agent 正在进行构建、采样、逆向分析、视频处理或 QEMU 启动等长耗时工作。例如：

```text
compile-compcert: "Now let me check on the package installation:"
mcmc-sampling-stan: "model compilation plus 4×100k-iteration sampling"
qemu-alpine-ssh: "Boot is progressing ..."
```

所以当前证据更支持“任务在预算内没有完成”，而不是“adapter 没有启动”或“模型请求完全卡死”。Hitch 的 timeout supervision 实际生效了。

值得讨论但不应混入上述两个 bug 的增强项：

- eval 层是否支持只重试 `timed_out`/`infrastructure_failure` 的 trial；
- retry 是否产生新的 run identity，并保留每次 attempt；
- Harbor outer timeout 与 Hitch inner timeout 是否应在 result 中显式关联；
- 是否能导出超时前的 DSH native session/trajectory，避免只看到最后一条 headless message；
- 是否允许调用方配置 retry policy，而不仅是 `attempts`。

这些属于能力和策略设计，不能仅凭本次结果断言为 Hitch bug。

## 7. Verifier timeout：Terminal-Bench 任务基础设施问题

`filter-js-from-html` 的 agent run 已成功，失败发生在任务自带 verifier：

```text
VerifierTimeoutError: Verifier execution timed out after 1800.0 seconds
```

该 verifier 在 trial 内动态执行：

- `apt-get update`
- 安装 `curl`
- 从公网下载 `uv`
- 动态安装 pytest、Selenium、BeautifulSoup 等依赖
- 从 GitHub 下载 XSS testbed
- 启动多个 Chrome/Selenium 测试

因此它对公网、包源和浏览器进程高度敏感。本次 verifier 精确运行到 1800 秒后被 Harbor 终止。当前没有证据表明 Hitch 传输了错误的 candidate 或错误地调用了 verifier。

建议在 benchmark/task 层解决：预构建 verifier 依赖、固定外部数据、移除运行期网络下载，并为单个浏览器用例设置更严格的超时和进程清理。

## 8. Gear 的行为与责任边界

Gear 在收到 Hitch run-centered result 后，要求：

```text
total > 0
completed == total
invalid == 0
所有 trial observation_status == valid
```

如果存在 invalid observation，Gear 抛出：

```text
Hitch eval has invalid run observations: total=30, completed=18, invalid=12
```

并将 round 标记为 `failed`。这不是上述 trial 的直接根因，而是有意的 fail-closed 策略：基础设施失败不能被伪装成 candidate 的正常零分，否则 baseline/candidate comparison 会失去可归因性。

Gear 后续需要补充 per-cell retry/recovery policy，使一两个可重试的基础设施错误不必重跑整个数据集；但这与 Hitch adapter 的两个确定性 bug 是独立问题。

## 9. 建议修复优先级

### P0：DeepSeek prompt argv 编码

- 在 prompt 前插入 `--`，或改用 prompt file/stdin。
- 增加 option-like prompt 的回归测试。

这是确定性、低风险、容易复现的修复。

### P0：Harbor result 读取和错误传播

- 去掉会掩盖 `cat` 失败的 pipeline，或显式启用 `pipefail`。
- 对 stdout 做 `strip()`。
- 区分 missing、empty、malformed 和 schema-invalid result。
- 保留原始 Hitch process failure evidence。

这项修复不仅解决 `prove-plus-comm`，也会显著提高所有 Harbor trial 的可诊断性。

### P1：超时 run 的证据和重试接口

- 在 eval result 中明确 inner/outer timeout 来源。
- 确保超时 run bundle 包含 DSH native session 或可恢复的结构化 trajectory。
- 讨论类型化 retry policy，以及 attempt/run identity 合同。

### 非 Hitch 修复

- `filter-js-from-html` verifier 应由 benchmark 侧去除运行期公网依赖。
- Gear 应实现只重试无效 rollout 的 recovery policy。

## 10. 验收建议

修复后建议先运行 3 个定向 trial：

1. `pytorch-model-recovery`：验证以 `-` 开头的 prompt 能进入 DSH agent。
2. `prove-plus-comm`：验证无论底层成功还是失败，都不会再出现裸 `JSONDecodeError`，且能看到真实 root cause。
3. 一个故意超时的 fixture：验证 timeout source、run bundle、attempt identity 和 error schema。

定向测试通过后，再重跑 30-task baseline。验收标准不是要求所有任务都得到高 reward，而是：

- adapter 不因合法 prompt 形状而失败；
- 缺失/损坏 result 不掩盖原始错误；
- 每个 invalid observation 都有稳定、可机器读取、可归责的原因；
- Gear 能据此决定 retry、fail 或继续，而不需要解析非结构化 traceback。

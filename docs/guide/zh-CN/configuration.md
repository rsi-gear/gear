# 配置参考

`gear init` 生成项目文件；执行配置在命名 profile 中，凭据保留在 provider 支持的认证位置。
项目 `gear.yaml` 示例：

```yaml
version: 1
benchmark: ./benchmark.yaml
target: {adapter: dsh, path: ./target, profile: default-target}
meta: {profile: default-meta}
algorithm: gepa
objective: {metric: pass_rate}
validation: {mode: holdout}
budget: {rounds: 1, max_evaluations: 40}
```

路径相对项目根目录解析。默认值 < 项目文件 < 显式 CLI/SDK 参数；`gear config explain` 显示结果与预算、修补配置的来源。未知字段会报错。恢复读取已封存配置，不能通过改文件悄悄改变实验。

| 字段 | 当前含义 |
| --- | --- |
| `target.adapter` | `dsh` 或 `pi` |
| `algorithm` | `gepa`、`random-search`、Python entrypoint，或 `{name: gepa, options: {promotion_widths: [2, 1], global_gate: no_regression}}`；SDK 可传可替换策略实例 |
| `objective.metric` | `{metric: pass_rate}` 为默认简写；高级目标使用 `objective.terms` 和 `objective.constraints` |
| `validation.mode` | `holdout` 要求独立任务；显式 `research` 标记同集研究 |
| `budget.rounds` | 默认 1 |
| `budget.max_candidates` | 整个 run 的候选上限，默认 2 |
| `budget.repetitions` | 每题重复数，默认 1 |
| `budget.max_evaluations` | 整个 run 的物理 attempt 上限，默认 40，包含 baseline、候选、最终验证和失败修补 |

GEPA 默认的 `promotion_widths: [2, 1]` 限制每个父代批次进入 bridge、global 的候选数，不设置生成预算或父代批数。[4 → 2 → 1 示例](example-algorithm.md)显式设置 `max_candidates: 4`；项目默认生成上限仍为 2。算法选项在 admission 时冻结，恢复沿用原值。

未知是否已执行的请求占用预留；resume 沿用原账本。当前项目入口没有美元硬上限，缺失用量不能当成零。报告只在所有可能已执行的操作都提供同一字段时合计该字段；任何缺失、null 或仍未返回的提交使总值保持 null。尚未提交的预约不计入已消耗用量，运行层完全复用当前 run 证据而未调用 provider 时明确记录新增用量为零。费用估算和实际账单分别保存。决策步数上限按整个 run 计数，resume 不重置。

## 运行计划与 baseline 复用

`gear refine --dry-run --json`、`run.plan` 与 Python `plan_refine()` 使用同一应用服务，检查任务、Target 资源和 provider 能力，返回重复数、候选上限、最大物理 attempts、生成限制以及所需最终 gate 槽位。该步骤不运行算法、创建 run 或调用模型，`model_access` 仍为 `not_checked`。timeout 来自 provider 与任务配置，当前没有额外的整个 run 时长限制；计划不承诺美元硬上限。普通 refine 在首次执行前向 stderr 显示 admission 后封存的计划；`--json` 只返回一个 JSON，计划保存在报告 `plan` 中。

`limits.timeouts` 分开列出 Target/Meta 的 provider 调用等待、Hitch 评测以及 Codex 生成期限，单位为毫秒；任务声明按 seed/held-out 分组，只显示数量与秒数，不显示 held-out ID。模板默认 agent 为 600 秒、verifier 为 60 秒、两侧环境构建各 600 秒；LLM verifier 使用模型请求超时加 15 秒。原生 Harbor 保留 task.toml 的实际声明，null 表示由 runtime 默认决定，不能理解为无限制。`taskRuntime: harbor` 表示使用 Harbor；任意 process provider 标为 `provider-defined`，不能从模板声明推断它已实施相同限制。provider 调用超时只表示停止等待，不证明远端任务停止，原预约继续保留。

新 refine 可以复用一个已完成 run 中与当前初始 Target 一致的 seed 证据。核对 Target 内容与执行身份、完整 benchmark、seed、评分实现及原始 metric/assertion 合同；更换 Meta 或仅改变 objective 权重不会改变 Target 的原始观测身份。仅复用当前任务/repetition 范围内有效且满足当前所需通道的槽位；同一条件下优先覆盖更多槽位，再按完成记录的新旧选择，不根据分数挑选。无效、缺少所需通道、未完成或来源损坏的记录不复用。这里不从旧 run 发起额外投影。

单题 smoke 不能代替完整 baseline。复用部分保存来源凭证及历史用量，不占新 run 预算；只提交其余槽位，合法零分不会因分数低而重跑。计划分别说明 baseline 与最终 gate 的预算缺口；gate 预算提示只针对 baseline 后剩余额度，后续候选与修补也会消耗同一总额度。预览后配置或历史可能变化，正式 admission 会重新检查并封存选择，resume 不重选来源。

## 生成与诊断预算

`generation` 单独限制一个 run 内的 Meta 调用，包括 `diagnose_seed`、`generate_candidate` 及其内部重试、上下文总结和子请求。Target rollout、benchmark 的 LLM scorer 和评测次数不计入此额度；物理评测仍由 `budget.max_evaluations` 限制。单任务 timeout 属于 benchmark/Target 执行配置，不能用这个预算替代。

```yaml
generation:
  max_model_requests: 20
  max_tokens: 120000
  per_operation:
    max_model_requests: 4
    max_tokens: 24000
```

两个总上限和两个单次上限都可独立省略，填写时必须为正安全整数。省略总上限表示该维度没有 run 总限制；省略单次上限时，单次预约使用剩余总额。单次上限大于剩余额度时会缩小到剩余值。完整操作批次必须一次预约成功，不会先执行一部分。`config explain` 显示配置来源。

Meta provider 必须明确声明 `generationBudget: true`，并在每个实际模型调用前对整个 operation 的所有调用、内部重试和总结执行限制。当前随包 Codex CLI runner 不具备这种硬限制，配置上述限额会在 baseline 提交前返回 `generation-budget-unsupported`；不会将事后观察到的 token 用量当成硬保证。支持该合同的 process provider 可接入这一路径。

运行层在副作用前把 `generationLimits` 和 operation ID 一起持久化。只有已知、合法的实际用量会释放预约余量；缺失或 null 计量保留完整额度，丢失回包先 inspect 同一 operation。`tokens` 是所有调用的输入与输出 token 之和，缓存输入计入输入一次，不能把 reasoning token 重复加到已含它的输出中。若同时提供拆分计量，合计必须一致；实际 token 不能与零请求数矛盾。

报告的 `generation_budget` 显示适用范围、冻结规则、预约上界、已占用上界、未知操作数和可用额度。上界不是实际消费。provider 超过预约或返回矛盾计量时，原 receipt 留在 journal 的 violation 记录中，后续提交被阻止，该结果不能进入算法证据。取消和恢复不删除这些记录。

## 失败评测修补

运行层只补跑明确标记为 `environment_failed` 或 `scoring_failed` 的槽位。默认在初次执行后最多重试 2 次，等待 15 秒、60 秒；重试只占用失败任务的对应 repetition，不改变任务分母。高级配置：

```yaml
evaluation:
  repair:
    max_retries: 2
    max_projections: 2
    backoff_ms: [15000, 60000]
```

`max_retries: 0` 关闭执行重试，`max_projections: 0` 关闭指标投影补齐，两种次数均须是非负安全整数。等待列表不能为空；每项是 0–2147483647 的整数毫秒，尝试次数多于列表长度时复用最后一项。配置与到期时间都会封存，resume 不重置等待或次数。预约和原始 receipt 保留在同一 run 账本，未知提交先 inspect；所有物理执行共享 `budget.max_evaluations`。一次失败槽位批次超出剩余预算时不部分提交。

有效零分不会重跑。有效执行缺少 objective、约束或保护规则要求的指标或独立 assertion 时，支持此能力的评测 provider 可以重新读取原始材料进行投影，默认最多两次。这不执行 Target、不调用模型，也不增加物理 attempt。只允许补齐指定的不可用通道；原始得分、已有有效指标或 assertion、合同和原始 receipt 保持不变。Hitch 只接受新增的材料字段，拒绝改写原字段。不支持或次数耗尽时，证据仍不可用，原因记入 `evidence_projections.blocked`，不补零、不缩评分分母。独立模型过程观测仍需单独接入。

## 加权目标和保护任务

原始指标在 `metrics` 中声明来源、单位、聚合规则和精度；`objective.terms` 决定这些指标如何计分。两者分开封存，重新加权不会改写原始观测。新项目的父代前沿、排名、最终 gate 和报告均使用 Python 的同一投影实现。

```yaml
metrics:
  - id: process_quality
    revision: '1'
    unit: points
    direction: maximize
    source: {path: originalResult.process_quality, extractor: number-v1}
    range: {min: 0, max: 100}
    granularity: trial
    repetitionReducer: mean
    taskReducer: weighted-mean
    comparisonPrecision: 0.000000001
objective:
  terms:
    - {metric: pass_rate, weight: 0.5}
    - {metric: process_quality, weight: 0.5, scale: 100}
  constraints:
    - {metric: pass_rate, rule: no_regression, reference: initial_baseline}
protection:
  - {task_id: seed-critical, partition: seed, metric: pass_rate, rule: no_new_violation}
```

这里的 `process_quality` 必须由实际 provider 提供；`originalResult.*` 从原始 trial manifest 提取。Hitch 提供独立 verifier 过程观测时，可使用 `source: {path: verifier.process.score, extractor: number-v1}`；组件比例通常应配置 `unit: ratio`、`range: {min: 0, max: 1}` 和 `scale: 1`。只有来源验证成功才提供 `verifier.*` 命名空间；缺失保持 missing，不支持为 unsupported，损坏为 invalid，不补零或自动调用模型评分。`pass_rate` 固定为 scorer 分数严格等于 1 的布尔通过率，部分得分不算通过。自定义 process provider 从 evaluate request 的 `metrics` 读取已封存合同，按合同返回 `raw_metrics`，每个有效值必须有原始证据 digest。

每个 process provider 都必须声明布尔能力 `evidenceProjection`。值为 true 时，必须将 `project_evidence` 与 `submit` 分开处理，并持久保存可供 `inspect` 查询的 receipt。请求绑定原始 operation/request/provenance、直接来源 receipt、缺失指标和尝试序号，`evidence` 只包含待补齐的来源槽位，请求只发送给评测 provider。返回普通 receipt，保持原始得分与已有指标不变，`physicalAttempts: 0`、显式 `usage.model_requests: 0`，其他已报告用量也必须为零；未知用量不满足只读合同。Codex Meta 将此能力声明为 false。

`terms` 允许负权重作为惩罚，`scale` 必须为正。约束支持 `minimum` 和相对初始基线的 `no_regression`（可配置非负 `tolerance`）；阈值按 metric 的 maximize/minimize 方向判断。任务保护也支持这两种规则，以及适用于正向布尔/相等谓词的 `no_new_violation`：基线通过的任务不得变成不通过。被保护 task 必须属于指定分区。held-out 保护仅在最终 gate 检查，不向算法和 Meta 暴露其 task ID。

所有要求的槽位、指标和保护证据完整后才能晋级；有效零分仍然有效。用量指标还须声明 `measurement`（测量种类、provider/model、计量和重试边界，涉及价格时含价格快照）。未观测的费用不能作为零成本优化。报告保留原始聚合、加权贡献和每条规则的判定。

## Provider profile

默认目录为 `~/.config/gear/profiles/`，可由 `GEAR_PROFILE_ROOT` 指定。项目引用 `default-meta` 时读取 `default-meta.json`。外部 process profile 的字段如下；这是合同示例，需要替换为实际实现：

```json
{
  "command": ["/absolute/path/to/provider"],
  "workingDirectory": "/absolute/path/to/provider-workspace",
  "passEnv": ["PROVIDER_API_KEY"],
  "configuration": {},
  "timeoutMs": 300000
}
```

process 必须报告真实实现身份和能力，并持久实现 submit/inspect/cancel。仅把可执行文件路径填进去并不构成可用 provider。`passEnv` 是变量名列表，不在项目锁文件中保存变量值。

Target 也可使用 `kind: "hitch"` profile，字段为 `executable`、`root`、`harnessRef`、`model`、`baseImage`、`passEnv`、`timeoutMs`，以及可选的 `maxConcurrent`、`setupTimeoutMs`、`preparationTimeoutMs`。新建 Target profile 默认使用 DSH `0.1.5-rc.3` 或 Pi `0.84.1`；既有 profile 保留其精确版本。当前 DSH 版本由上游固定 HMR 依赖，无需 Gear 专用覆盖。DSH 的 harnessRef 必须是确切 `deepseek@version:...` 或 commit，Pi 使用 `pi@version:...` 或 commit；baseImage 固定 OCI sha256。运行前核对解析后的 harness 源码身份、能力和 daemon 状态，并用 fresh worker observation v2 绑定 Hitch controller、Harbor 可执行文件和 Docker 引擎的观测身份。评估明确提交到 `local-docker`；新提交前和保存回执前重新观测，变化时拒绝继续接纳。回包还必须匹配 controller runtime 和执行 provider。接纳回包及补取原材料时，还核对实际请求中的模型、载体参数、凭据变量名范围、重复/并发/重试次数和超时；不一致的结果不会接纳。计划、结果及 work item 的 prepared artifact、入口/目录摘要、任务映射和平台/Node 合同也必须一致；同一评估的重复试验不能使用不同依赖。原材料补取保留原始 artifact 证据。

Hitch profile 还可设置 `agentArgs`，内容为原生参数的 JSON 字符串数组。Gear 将它追加在 Target adapter 自己的参数之后，保留 DSH Target patch，再按传入顺序应用其他 overlay。创建时可附加 `--agent-args-json '["--patch","/opt/provider.json"]'`，导入 profile 时可写 `"agentArgs": ["--patch", "/opt/provider.json"]`。引用文件必须已存在于任务镜像内。参数顺序进入冻结的 provider 身份与回包核对，修改后需要新建运行。参数属于公开执行配置；密钥值应通过 `passEnv` 指定的环境变量提供，不得放入 `agentArgs` 或镜像文件。

自定义运行时仓库可使用 `deepseek@git+file:///absolute/repository#<full-commit>` 或对应的 `pi@` 引用。Git 必须指定完整的小写 40 位 SHA-1 提交号；profile 校验会拒绝分支、短哈希及 64 位 SHA-256 提交号。Hitch 当前的 Git 缓存和制品构建器仅支持 SHA-1 仓库。file URL 必须规范化，空格需百分号编码。Hitch 导出并构建固定提交及其锁定依赖，因此可加载自定义 provider 插件，无需修改 Gear 或依赖可变的已安装运行时。

Hitch 可附带可选的探测诊断；Gear 严格校验有界的阶段、结果、耗时、退出码和信号字段。Harbor 或 Docker 不可用时，包括 SDK 准备检查，返回 `provider-environment-unavailable`，并在持久化错误消息中保留这些安全元数据，不包含工具原始输出。诊断不进入环境身份，controller 或引擎身份变化仍被拒绝；没有诊断字段的旧观测继续兼容。

运行计划连接 provider 时，Gear 通过该 Hitch 安装的公开 SDK 编译任务平台声明并准备对应的 Harbor artifact。准备前后核对 SDK 与 daemon 观测到的 controller 和 Docker/Harbor 环境；实际 artifact、入口/目录摘要与逐任务平台绑定进入 provider/evaluation identity，供跨 run baseline 比较。新物理提交前再次校验缓存文件，回执必须匹配事先冻结的绑定。首次准备可能下载包和运行 Docker 构建器，单次准备/复核由 profile 的 `preparationTimeoutMs` 控制，默认 30 分钟；不创建评估作业或模型请求。`doctor` 保持只读，不执行 artifact 构建。

平台规划只物化任务配置、Compose 声明和 Dockerfile，不展开完整源码树和验证器数据。实际评估仍获得完整、独立的文件。每次编译使用有界的 32 MiB 缓存，避免重复解码、哈希相同的冻结 native blob；Linux 文件系统支持 reflink 时还可共享数据块，不支持时回退为独立复制，不使用硬链接。任务可写状态不共享；普通文件系统上的执行数据集仍需完整写入。

对明确声明仅供镜像构建的输入，可在导入前使用 `python -m gear.benchmark.shared_runtime`，将公共构建前缀准备为固定摘要 OCI 镜像。新数据集只保留每题差异，容器可写层仍独立；已有冻结数据集和宿主 Harbor 默认执行方式不变。声明格式、构建与绑定步骤、支持范围及验证方法见[共享 task 镜像准备](../../shared-task-runtime.zh-CN.md)。

还要求 Hitch 提供 `evaluation_environment_binding: "3"` 与 `evaluation_preparation: "1"` 能力；现有 0.2.16 发布版本本身不保证支持。Gear 调用 daemon 的 `eval bind`，将实际驻留环境、模型、变量名、冻结 helper 输出、Harbor Python 内容及受支持的环境引用文件的私有 HMAC 绑定加入运行身份；新准入与 Harbor 启动前由 Hitch 复核，回执必须携带同一绑定。Python 版本不变但依赖文件变化也会使旧绑定失效；正常生成的字节码缓存不会改变身份。标准证书和凭据配置文件自动检查；自定义主机文件变量在 daemon 环境中通过 `HITCH_EVALUATION_FILE_ENV_JSON='["MY_PROVIDER_CONFIG"]'` 声明，使用绝对文件路径。凭据不进入 Gear 项目锁或公开回执，失效时需要准备新运行。当前配套实现与文件范围见[环境文件绑定说明](../../testing/hitch-environment-files.zh-CN.md)。

新建 Hitch profile 显式保存 `maxConcurrent: 4`，与 Hitch 默认值一致；没有该字段的既有 profile 保留并发 1。创建时用 `--max-concurrent N` 请求更高的任务并发，实际接纳仍受 daemon 资源容量约束。接纳结果前会核对实际执行并发与冻结配置一致。并发属于冻结的 provider 身份，修改后须新建运行，不能复用旧身份下的评测证据。

`--preparation-timeout-ms` 同时控制 artifact 准备/复核、环境绑定及提交准入（其中也会校验 Python 运行时）。`--setup-timeout-ms` 设置 Harbor 的 Agent setup 覆盖值（`agent.override_setup_timeout_sec`），默认 1800000 毫秒。任务环境的构建/启动期限独立使用编译后任务的 `task.config.environment.build_timeout_sec`，未声明时使用 Harbor 默认值；增加 Agent setup 不会延长环境启动期限。Gear 保留任务声明的原生期限，未声明的默认值在冻结任务合同中仍为未知。任务 `timeoutMs` 与 Agent `setupTimeoutMs` 之和须符合 Hitch 的 24 小时限制，完整 24 小时任务应显式设置 Agent setup 为 0。其余时间配置使用正整数毫秒，准备期限须在 Node 定时器范围内。等待整组评测时为每个任务保留 setup 与执行预算，兼容实际 daemon 容量低于请求并发的情况。取消与响应丢失后的恢复保留原评估身份。

Gear 同时要求 `evaluation_artifact_pins: "1"`：每次提交携带当前任务平台的产物 ID、目录摘要和入口摘要。Hitch 在产物准备后和 Harbor 执行前强制核对，恢复与重试保留原 pins；回执仍须匹配。协议和验证范围见[执行前产物约束](../../testing/hitch-artifact-pins.zh-CN.md)。

这些检查尚不等于固定完整运行环境：任意环境变量引用文件、动态加载的范围外资源、系统共享库及执行中的并发主机修改没有完整证明。运行期间须保持依赖环境不变。详见[验收核对](../../refactor-acceptance.zh-CN.md)。

用 `gear profile create NAME --kind hitch|codex --model MODEL` 创建原生 profile；Hitch 另传 `--adapter dsh|pi`。
不传创建参数时打开终端向导。命令默认固定测试过的 harness 版本并解析本地镜像摘要，模型由用户明确指定。
外部 process 配置用 `gear profile create NAME --from FILE.json` 导入；已有名称拒绝覆盖。
`gear profile list` 列出配置；`gear profile use NAME --role target|meta` 更新当前项目，
加 `--default` 设置以后 `init` 的默认选择。`init` 也接受 `--target-profile`、`--meta-profile`。
选择 profile 会检查角色和 Target adapter，不修改已有 run 的冻结配置。

Meta 与 Target 分别认证。Codex Meta 使用[随包 operation runner](../../codex-meta-runner.zh-CN.md)，
原生 `kind: "codex"` 配置由 Gear 解析到当前安装包，避免手写 runner 路径。
主机需要 HTTP 上游代理时，在 Codex profile 的 `passEnv` 中显式加入 `HTTP_PROXY`、`HTTPS_PROXY` 和可选的 `NO_PROXY`（CLI：`--pass-env HTTP_PROXY,HTTPS_PROXY,NO_PROXY`）。配置只保存变量名；可信 worker 通过这些值连接上游，Codex 只收到沙箱代理端点，不会收到上游代理凭据。`allowedDomains` 仍限制目标域名，`NO_PROXY` 也不能绕过该限制。默认不继承代理变量；使用 API key 时，须在同一列表中保留相应 key 的变量名。

Codex 在清理前持久化已校验的 `receipt.json`，因此回执可能先于执行锁释放出现；私有 `cleanup-started.json` / `cleanup.json` 单独记录清理，`fallback-required` 表示有步骤失败或超时，不表示超时动作已完成。凭据、trajectory gateway、sandbox reset 和根目录分别限 500/500/1500/1000 ms，状态文件写入各限 250 ms；清理开始后的 4500 ms watchdog 兜底退出。只有本次独立 worker 可以终止经验证的自身进程组，回收 CONNECT 两端和桥接子进程；直接调用库函数不会终止宿主进程组。

只有守护进程的专用确认管道证明模型组已终止后才写回执。guard 被杀或缺少确认时保持 `unknown`，不会重发；私有临时根目录保留，凭据和根目录标为 `unconfirmed`，其中可能仍有临时认证文件，需保留原 journal 调查。取消仍须在既有 5 秒等待内同时确认回执和锁释放，超时不能当作停止证明。runner asset、guard 和清理代码均绑定到实现身份，旧冻结运行不会自动改用新实现恢复。
`doctor` 检查本地登录文件或环境变量存在性；不验证远端模型授权、不执行 benchmark。
自定义 process 的认证返回 `provider_managed`，需按其文档检查。
Python `Project` 提供 `profiles()`、`create_profile()`、`use_profile()`、`doctor()` 及 async 对应入口。
受管理环境位于 `GEAR_HOME`（默认 `~/.local/share/gear`），`GEAR_PYTHON` 显式覆盖 worker。

## 独立 assertion

任务总分与独立 verifier 断言分开记录。下面的来源字段必须由 provider 实际输出；未观测到时显示 missing，不根据任务得分猜测断言结果。

```yaml
assertions:
  - id: tool_sequence
    revision: '1'
    source:
      path: originalResult.assertions.tool_sequence
      extractor: assertion-status-v1
assertion_protection:
  - task_id: sum-01
    partition: seed
    assertion_id: tool_sequence
    rule: must_pass
```

`assertion-status-v1` 读取 `passed`、`failed` 或 `excluded`；`boolean-v1` 读取实际布尔值，数值 0/1 不作为布尔值。合同摘要由配置解析自动生成，修改 revision 或来源会改变身份。

`must_pass` 要求每次重复的候选断言都通过，`excluded` 也不能满足该规则。`no_new_violation` 禁止基线未失败的断言在候选中变为 failed；基线已经 failed 时，该规则本身不强制修复。两条规则都需要基线和候选的独立证据，missing/invalid/unsupported 均使保护不完整。每个 task/assertion 只能声明一条规则，held-out 规则仅供最终 gate 使用。

报告的 `scores.*.<partition>.assertions` 保留每个任务、重复槽位的全部已声明断言，包括未设置保护的断言；`assertion_protection` 给出逐槽位保护判定。独立断言可通过原材料只读投影补齐；已有 passed/failed/excluded 结果不可重写，也不会因断言失败而重跑有效执行。

## 准备预算与 Linux 隔离

通过 Gear 进程的 `GEAR_BENCHMARK_LIMITS_JSON` 覆盖已知准备预算。Python 导入/编译、TypeScript 计划校验和冻结数据集摘要共用默认值：`maxFiles: 200000`、`maxDirectories: 100000`、`maxUniqueBytes: 67108864`、`maxMaterializedBytes: 4294967296`、`authorTimeoutMs: 300000`、`maxOutputBytes: 134217728`。例如 `GEAR_BENCHMARK_LIMITS_JSON='{"maxFiles":300000,"authorTimeoutMs":600000}'` 适用于任意受支持的数据集。值必须为正安全整数，超时须在 Node 定时器范围内。提高预算不会跳过内容或路径校验。超时/取消会等待作者工具子进程退出，POSIX 下同时终止其进程组。

Linux 默认使用 `seccomp`。若主机 AppArmor 禁止 helper 创建嵌套 namespace，可在 `gear.yaml` 显式设置 `sandbox: {linux_isolation: bubblewrap-only}`；该选项作用于 Python 算法和原生 Codex Meta，并随运行配置冻结。兼容模式保留文件系统、PID 与网络 namespace 隔离，但不通过 seccomp 过滤 Unix socket 创建；宿主私有控制 socket 必须位于读取允许范围之外。`gear doctor` 探测所选模式，不会自动降级，也没有关闭隔离的选项。参见[平台隔离验证](../../plugin-installation-and-usage.md)。

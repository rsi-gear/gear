# 项目执行 provider 合同

`src/ports/operations.ts` 定义执行端口；可信 process adapter 使用单次 JSON 输入/输出，版本为 1。算法决策由 Python 生成，provider 只执行、观察、计量或取消已持久化的 operation。请求中的 operation ID、generation、partition、slots 和冻结配置不能在恢复时换成新值。

应用层组合 Target 与 Meta 时，整体 `identity` 封存两者，恢复必须匹配；单独的
`evaluationIdentity` 封存全部 Target 执行条件（实现、模型、采样、计量、重试及 profile），
用于候选 manifest 和跨 run baseline 对照。不得为了复用而忽略影响执行的设置。
未提供单独身份时使用整体 identity，保守地拒绝无法证明条件一致的复用。
process wire 的 adapter 根据 describe、实现、准入能力和配置计算身份，
composition 使用 Target adapter 的完整身份，排除单独 Meta adapter 的变化。

可选 `timeouts` 是当前已连接配置的操作者元数据：分别描述 Target/Meta 的
期限数值与作用范围，并声明是否使用 Harbor 任务设置。计划在 admission 时封存，
不向算法或 Meta 反馈。`provider-call` 只是调用等待期限；不能把超时推断为已取消
远端工作。缺失元数据保持未报告，原生任务省略的字段不猜测默认值。

`inspect` 的结果：

| state | 含义与后续动作 |
| --- | --- |
| `complete` | 返回原始 receipt，由 core 验证身份、证据范围和物理用量后结算 |
| `not_submitted` | 确认尚无已提交工作，可以使用同一预约提交 |
| `resumable` | 部分工作完成，provider 确认使用原 ID 可以安全补齐；仅在 `idempotentSubmission: true` 时允许重入 submit |
| `running` | 工作仍在运行；不能通过新提交替代观察 |
| `unknown` | 缺少确定的执行结果；保持恢复状态和预算预留 |

观察不能启动新任务或模型。Hitch 为每个 repetition 先持久化 start 意图并登记稳定 eval ID，再用同一 control file 提交。丢失回包时重放不含 submission 的登记命令，只查明原 ID 是否已经提交。部分重复完成时，inspect 返回 `resumable`；随后 submit 跳过已存在的作业，只提交尚缺的重复。

取消使用同一 key/subject 的 pause 意图，其 sequence 高于 start。即使尚未准备任务目录，pause 也会先阻止迟到的 start。取消不能为了找回 eval ID 而调用 submit。所有重复都要尝试暂停；已提交作业还必须达到终态并且 active leases 为空。无法确认或超时会保留 `needs_recovery`，重试取消而不重置预算。

process provider 的 cancel 响应必须明确返回 `{ "cancelled": true }`，表示工作已停止或被持久化记录阻止启动，不能只表示收到请求。缺少确认、false 或错误类型均不视为成功。Codex worker 启动后，取消必须等待 receipt 和执行锁释放；worker 丢失且没有 receipt 时保持未确认状态。

报告分别显示已结算执行次数、未完成预留和未知用量。取消确认不伪造缺失的评测结果，也不把未知费用计为零。Hitch 有序控制 helper 的实际源码进入 provider 身份；恢复新执行仍要求身份匹配。取消沿用原请求、provider identity 与控制协议，不因新环境无法准备而阻止发送终止意图。

`OperationProvider.prepareAdmission()` 是可选的新运行准入步骤，在保存取消快照及创建 journal 之前调用；preview、doctor 和 resume 不调用它。process adapter 可通过 describe 的 `admission: true` 声明该需求，此时接收 `prepare_admission`（request 为 null、实现身份沿用握手），必须返回 `{ "prepared": true }`。该步骤只初始化控制记录，不执行模型或评测；不支持该声明的 process adapter 没有额外调用。

Codex 在 `providers/codex/operations.json` 登记所有 operation，先记录 admission，再创建作业与派生 worker；模型启动意图也先写入此表。缺失/损坏登记表，或已登记作业缺失 `job.json` 时，inspect 保持 `unknown`、submit/cancel 拒绝确认。整个目录丢失也不会在恢复中重建成新的命名空间。只有登记表证明从未提交的 pre-start fence 可以立即确认取消；其他情况必须等待原 receipt 与执行锁释放。不能通过删除 `started.json` 绕过此要求。

`OperationProvider.cancellation` 是只供控制层保存的私有 JSON 连接快照，准入以 `0600` 文件发布并将摘要写入 `RunSpec.cancellationIdentity`。`ProjectBindings.cancellation(snapshot)` 只返回 `OperationCancellation`，不具备 submit/inspect/prepare 能力；内置 Hitch、process 和复合 provider 均实现此路径。自定义 TypeScript bindings 需要提供同样的快照与重建方法，才能支持独立恢复取消；缺失端口或快照不会假报成功。process 的取消恢复保留原 configuration/context/实现 identity，不重新 describe；Hitch 不重新观察或构建运行环境。快照不进入报告、Meta 或导出，环境变量值不写入其中。

`ProjectApplication.cancel` 只持久化取消意图，`completeCancellation` 在运行锁内确认停止。命令层按前台/后台调用两步，持久化意图后同时中断本地恢复连接。`resume` 检查取消意图先于 benchmark、Target、算法和 provider 启动。未提交操作无需外部停止；已提交操作全部尝试取消，任一未确认则保留 `needs_recovery`。详见[取消恢复验证](../testing/cancellation.zh-CN.md)。

已安装支持有序控制 v2 的 Hitch 时，可执行 `GEAR_TEST_HITCH=/absolute/path/to/hitch npm run test:hitch:control`。该探针在独立临时 root 管理自有前台 daemon，验证重复登记的稳定 ID、独立取消连接的 pause 阻止迟到 start，以及零 eval 作业；结束后确认 daemon 停止并清理临时目录。不提交模型评测，不能代替 Target 容器或模型闭环验收。


Gear 生成的 text/json/files/python 任务使用独立 verifier；只转移 `/app` 产物，评分源码与 expected 在独立构建上下文，评分侧使用静态 `no-network`。候选的后台进程或临时文件不会随产物转移进入 verifier。原生 Harbor 任务保留原 isolation 模式；不能把 shared 任务视作具备独立容器防篡改保证。

可使用与当前 Hitch 匹配的 Harbor 0.21 Python 执行以下无模型探针，路径和镜像需替换为实际安装值：

```sh
/path/to/harbor-python scripts/check-harbor-verifier.py \
  --hitch-integrations /path/to/hitch/integrations/harbor \
  --image registry/python@sha256:实际镜像摘要 \
  --output /tmp/gear-verifier-isolation-new
```

输出目录必须尚不存在。探针保留配置、候选/评分日志和 report.json，分别验证正例 1、反例 0、不同容器 hostname、候选临时文件隔离和无外部路由；最后回收自己创建的容器及镜像并确认清理。它使用合成候选，不会调用模型，也不替代 DSH/Pi headless 模型验收。

## Meta 限额合同

provider handshake 必须明确提供布尔 `generationBudget`。只有能在实际调用前限制同一 operation 的全部请求、输入/输出 token、内部重试和总结时才能声明 true；执行身份同时封存能力声明。复合 provider 使用 Meta 的该能力，Target 的相应能力不参与判断。

受限 `submit` 请求携带 core 生成的 `generationLimits: {model_requests?, tokens?}`。不得从 `operation.payload`、prompt 或用户策略里读取替代上限。限制与请求 ID 同时持久化，幂等重入必须继续使用同一 allowance，不得重新获得一份额度。provider 返回完整 operation 的累计 usage，不是最后一次调用的 usage；缺失值必须为 null/省略，不能伪造为零。

receipt 的 request/token 计数必须是非负安全整数。若提供 input/output/cached 明细，输入包含缓存一次，total 必须等于 input + output。无法确认消费时，core 保留预约上界；超额或矛盾计量留下独立 violation receipt 并停止新的提交。该能力不承诺美元硬上限，也不覆盖 Target 或 benchmark scorer 的成本。

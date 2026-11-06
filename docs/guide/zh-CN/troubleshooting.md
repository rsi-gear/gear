# 问题排查

先保存 run ID 并执行 `gear report RUN_ID --json`。不要通过改 journal、删除锁或替换封存文件绕过恢复校验。

| 现象 | 处理 |
| --- | --- |
| `python-not-configured` | 运行 `gear setup --python python3.12`，或配置明确的 `GEAR_PYTHON` |
| `profile-unavailable` | 核对项目引用和 profile 目录；模型认证单独完成 |
| `unknown-config-field` | 使用当前项目 schema，运行 `gear config explain` |
| `budget-baseline-unaffordable` | 在新 run 中增加物理评测预算或缩小任务范围 |
| `admission-conflict` | 原请求 ID 的类型或参数不同；重试用原参数，新实验用新 ID |
| `state-busy` | 等待持锁运行结束；不要删除活跃服务的 socket 或锁 |
| `needs_recovery` / 未知 provider 结果 | 排查 provider，再 `gear resume RUN_ID`；保持原 operation ID |
| `evaluation_repairs.blocked` | 检查次数或预算耗尽原因；修复环境后以新配置创建 run，不能通过 resume 增加原额度 |
| `frozen-repair-policy-missing` | 该 run 未封存当前版本需要的修补规则；保留旧证据并新建实验，不修改原 journal |
| `evidence_projections.blocked` | 检查 provider/指标不支持、禁用或次数耗尽的原因；不可用指标保持明确缺失，不通过重跑补分 |
| `hitch-projection-source-changed` | provider 原字段被改写；保留已封存 receipt 并排查来源，不替换原始观测 |
| `changes.status: unavailable` | Target 资源或配置未通过封存校验；评分/用量仍可读，导出需要完整且可验证的原资源 |
| `algorithm-message-too-large` | 查看请求总量、上限及 view、evidence、completed、state、algorithm 的字节计数；相同超限输入重试不会成功 |
| `algorithm-handshake-mismatch` | 核对 runtime 与冻结 worker 的协议/身份；64 MiB runtime 会明确拒绝旧 4 MiB worker |
| 身份失配 | 保留证据；恢复正确依赖，或以新身份创建新实验 |
| 评分或环境失败 | 先修复 scorer/执行环境；不能算作模型有效零分 |

`doctor` 分开显示依赖、provider 能力、镜像和本地认证来源。`not_configured` 表示 profile 引用的凭据未准备，`provider_managed` 需按自定义 provider 检查，`model_access: not_checked` 表示尚未验证远端授权；即使允许 smoke test，也需实际执行单题评测。实际模型、GPU 和容器扩展的验证状态见[实施记录](../../refactor-progress.zh-CN.md)。

Python 算法协议每条请求和响应上限为 64 MiB（67,108,864 字节），包含 UTF-8 JSON envelope 和末尾换行。两端握手必须声明完全相同的上限。Gear 保留全部 verifier 观测、raw metrics、completed 结果和算法 state；单条 verifier 的 16 KiB 限制不能约束累计总量，任意 raw metrics、completed.data 或 state 仍可能超限。大消息的 JSON 序列化、校验和解析还需要额外内存，并受决策超时约束。

新 run 将当前 Python 协议源码冻结进 implementation identity；已有 run 恢复时继续使用原冻结源码和记录的身份。仅安装本次容量改动不能恢复冻结于 4 MiB 的 run。应保留其证据，使用兼容 runtime、新建 run，或另外制定并审查尊重不可变身份的迁移方案。runtime 不会替换冻结源码或改写 journal 来通过握手。

# A1 双语言搜索组合接口审计

结论：本切片可以提交。它提供作者层 propose / evaluate / select 的实现；真实宿主、五文件项目及 CLI 另行验收。

TS 和 Python 现在都能组合任务抽样、基线评估、多候选编辑、并行评估、选择与 checkpoint。propose 允许不带反馈的从零生成，也支持当前父代的完整评估反馈；候选与失败保持原 proposal ordinal。业务失败可收集，协议错误不可降级成候选失败。evaluate 从签名 TaskSelection 的起始 cursor 读取同一批任务，按冻结的 task × repeat 顺序提交 rollout，保留每个终态 producer 的内核 operation ID，再交给可信 measurement provider 汇总。select 只比较完整且 comparisonKey 相同的结果，使用冻结的指标方向与十进制定点精度；严格改进、稳定同分顺序与现有比较语义一致。缺失/无效结果不视作零分。

最小示例使用普通 SearchConfig、SearchRoundRecord 和 ctx.data.searchTasks，整体类型检查无需 as。共享 schema 增加有限 minimum/maximum；两语言拒绝不安全整数、倒置上下界及非有限数。完整 DTO/实际 worker 的测试覆盖可选反馈、负值半量子边界、任务顺序和错误恢复。

独立复审先发现三个 P1，修复后关闭：Python 的递归只读 DTO 可以传入自定义 workflow/parallel；公共上下文及 tasks 属性不可重新绑定，分支不会通过共享 context 污染其他分支；SDK 构造/用法错误保留为 fatal，即使作者捕获异常也不能回复 fallback frontier。正常作者局部数组仍可修改，已提交的业务失败仍可捕获。

验证：实施者报告冻结副本直接 tsc 构建、全仓类型检查、8 个 TS 文件 92 项及 Python author 32 项通过。独立 reviewer 在新副本运行 3 个 TS 集成文件 7 项、Python evaluate 1 项及两语言最小反例，未发现新的 P1。主审随后在同一副本独立运行 6 个 TS 文件 31 项和 Python author 32 项，全部通过，并逐字节核对本切片的 25 个源码/测试文件与 live 树一致。实际 Python worker 的本地回环通信在提升权限后执行。验证包含受控 provider 和真实语言 worker，不等同于真实 Hitch/模型运行。

已知限制：固定检查失败的物理报告尚未通过失败 outcome 形成 checkReportRef，不能制造 evidenceRef 充数。自定义 role.output 的静态类型/运行 schema 同源声明仍需 A3 完成。外部作者 SDK 的当前性能尚未按冻结 A0 协议复测，Python 旧测试中的性能门仍未通过。

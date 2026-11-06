# 无人值守迭代：软件验证与实机交接

日期：2026-10-15。本轮按用户要求实现代码并执行受控软件验证；真实 Docker 任务与外部 GPU 服务器由后续验收者验证。本报告不将此前单轮 GPU 诊断视为新自动循环的验收，也不改变 `pending-gpu` 运行时门禁。

## 交付范围

- Gear 冻结多轮策略、proposal、期限和部署权限，持久化轮次 admission、暂停/恢复、接受/拒绝与停止意图。
- 原生部署复用节点 CAS/SSH、Supervisor 4.3.0 和 GNU timeout；固定评测 GPU、模型快照、环境与实例身份。没有新增推理引擎、模型路由器或常驻部署 daemon。
- Hitch 复用已有无效槽位修复，显式记录新物理实例与旧实例的关系，保留有效零分结果和累计费用。私有凭据可被预先启动的 daemon 读取。
- 完整 native checkpoint、原始 deadline 与覆盖全实验的学习率计划受校验；不会因恢复而重置 optimizer 或延长总期限。

配置与操作见[无人值守迭代指南](../training/unattended-iteration.zh-CN.md)和[受管原生部署指南](../training/managed-native.zh-CN.md)。

## 本机验证结果

| 检查 | 结果 |
| --- | --- |
| Gear 完整 TypeScript 回归，真实构建入口、4 workers（恢复修复后重跑） | 75 个测试文件通过，2 个跳过；678 项通过，4 项跳过 |
| 部署恢复、协调器和连接定向回归（恢复修复后重跑） | 4 个文件，50/50 通过；新增测试先确认旧实现失败 |
| Gear 完整 Python unittest | 400 项，396 通过，4 项按原有条件跳过 |
| 原生部署 Python 测试（包含在完整回归中） | 15/15；真实 Supervisor、GNU timeout、HTTP 与受控子进程 |
| Gear typecheck、lint、format、contracts、boundaries | 通过 |
| Python Ruff check/format、mypy | 通过；139 个格式检查文件，38 个 mypy 源文件 |
| npm 发布清单及外部安装公共 API | 通过；包含新接口、部署入口、配置模板和操作指南 |
| 干净 npm 包与 Python wheel 完整项目流程 | 通过；包含部署 CLI help、既有离线项目流程及 OS 沙箱 |
| Hitch 全量覆盖率运行 | 929 项，912 通过，17 项显式平台/Docker 跳过；0 失败 |
| Hitch 最后暂停竞态修正后直接相关回归 | 53/53 |
| Hitch 覆盖率 | lines 89.73%、branches 77.85%、functions 89.96% |
| Hitch typecheck/build、架构、语法、双语文档及安装包 smoke | 通过 |

测试环境使用 Node 26.5.1、Python 3.12.13、Supervisor 4.3.0；macOS 上使用从官方源码构建的 GNU coreutils 9.7 timeout。Linux CI 安装锁定的 deployment extra，并使用系统 GNU timeout。关键部署测试缺依赖会失败，不会静默跳过。

Gear 主要重跑入口：

```sh
npm test -- --maxWorkers=4
PYTHONPATH=python python -m unittest discover -s python/tests -v
node scripts/check-public-api-package.mjs
node scripts/check-project-package.mjs
```

macOS 的部署测试需要通过 `GEAR_TEST_TIMEOUT` 指定 GNU timeout。完整安装流程需要支持的 Python、网络与本机进程/沙箱权限；不依赖新租用的 GPU。

## 已验证的恢复边界

本次复查修复两个崩溃窗口：服务已就绪但评测尚未登记时死亡，`prepare()` 会在确认死亡并等待消费者结束后回收，以原始期限和次数上限重建；远端服务释放和本地 SSH 隧道清理分别持久化，重启会继续清理当前及历史实例。旧版 `released` 记录缺少连接清理确认时也会补清理。清理未确认前，不允许新实例启动或实验移交所有权。

定向测试还覆盖回收后查询旧 binding 不重开隧道、回收中再次恢复、关闭隧道后回复丢失、打开与关闭的竞争，以及未知死亡状态不触发重建。连接测试使用真实本地 TCP/Unix socket 和受控 SSH 命令，验证旧端口可被新实例复用、旧实例延迟清理不会关闭新连接；不等同于真实远端 SSH 或 GPU 验收。

受控训练器/评测器经过生产协调器与 CLI 函数入口完成两轮接受、拒绝后切换声明输入、无新输入停止，以及轮次 admission/决策提交丢失回复后的恢复。测试同时覆盖持久暂停、预算耗尽、到期后的训练取消、清理不确定时保留 `pausing`、实例回收后所有权交接和旧命令隔离。

真实 Supervisor 测试覆盖启动回执丢失后的同实例观察、进程崩溃、离线硬期限、两个消费者独立释放、精确自属进程组停止、逃逸子进程身份保留、外来进程不被终止、磁盘/CAS/环境漂移、旧认证和旧 wire model 拒绝访问替换实例。它使用 CPU 受控服务，不执行 SGLang 权重加载。

Hitch 测试通过实际 CLI、已启动 daemon、model-call 进程和认证 HTTP 服务执行 A 的有效零分槽位与失败槽位，再只在 B 修复失败槽位。原始 request/plan 与零分记录不变，请求数从 2 增至 3；新的私有凭据在 daemon 启动后登记。Gear 另验证了 B 已完成但回包丢失且实例死亡时，先读取 canonical evidence，不创建 C 或重放模型请求。Hitch 的受控 executor seam 替代 Harbor，不能据此声称 Docker 实测通过。

真实锁定 Megatron scheduler 类的 CPU 参数组检查及源码摘要见[调度器记录](unattended-scheduler-controlled-2026-10-15.json)。完整 native 状态的受控恢复检查不等同于真实 optimizer 更新或跨 GPU 进程恢复。

## 尚待实机验收

按操作指南分别验证三种拓扑，优先使用用户本机 Docker 与外部 GPU 服务器。需要真实模型的非零学习信号、完整 optimizer/scheduler/RNG/cursor 连续性、至少两轮无人介入、实际 Harbor 工具往返、故障注入和全部自属 GPU 进程退出证据。真实候选未达门槛时保留拒绝结果，不修改评分制造接受。

当前只交付 Supervisor 原生后端、单服务 TP 和静态分卡；不提供动态 GPU 调度或独立远端 Harbor worker 的跨实例修复。普通推理 GPU 用量缺乏可靠分摊时保持未知，不宣称训练预算已覆盖全链路 GPU 成本。
